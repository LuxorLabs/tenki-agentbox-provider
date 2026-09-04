/**
 * Tenki `CloudBackend` — maps the provider-neutral cloud primitives onto the
 * `@tenkicloud/sandbox` SDK (VMs + pause/resume snapshots).
 * Composed into a full `Provider` by the provider SDK's `createCloudProvider`.
 *
 * Platform shape this backend is built around:
 *   - Boxes boot from a snapshot id: the base snapshot baked by `agentbox
 *     prepare --provider tenki`, or a checkpoint snapshot (`req.snapshot`),
 *     which wins. `backend.provision` gates on `ensureTenkiBaseImage()` (mirrors
 *     the e2b/hetzner/vercel pattern: `prepare` sidesteps the gate so a cold
 *     install can bootstrap).
 *   - The SDK's high-level `Session` carries both the control-plane handle and
 *     a per-session data plane (`run`, `readFile`/`writeFile`/`fs.*`). We
 *     resolve a fresh `Session` per op via `client.get(sessionId)` — the CLI is
 *     a short-lived process per command, matching e2b's `Sandbox.connect`.
 *   - `CloudHandle.sandboxId` IS the Tenki session id.
 *   - Comms are ConnectRPC + a websocket data plane (no SSH for exec/files);
 *     interactive attach uses `session.ssh()`, wired by `buildTenkiAttach`.
 *   - Preview URLs come from `session.exposePort(port)` — public HTTPS, no
 *     header token (same shape as e2b/vercel).
 *   - `session.pause()` / `session.resume()` give free pause/resume;
 *     `createSnapshotAndWait` is the reusable, id-addressed checkpoint
 *     primitive (the provider overrides `checkpoint` in index.ts to store the
 *     snapshot id, matching vercel/e2b).
 */

import { createReadStream, createWriteStream, rmSync } from 'node:fs';
import { basename, posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type {
  CloudBackend,
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
} from '@madarco/agentbox-provider-sdk';
import type { ExposedPort, Session, SessionState } from './sdk.js';
import { getTenkiClient } from './sdk.js';
import { withTenkiRetry } from './retry.js';
import { ensureTenkiBaseImage, readPreparedState } from './prepared-state.js';
import { sshKeyDir } from './build-attach.js';

/** In-box port the cloud WebProxy binds + that we expose as the box's "web" port.
 *  8080 matches the non-privileged convention vercel/e2b use for VMs (the
 *  in-box ctl is told the same value via AGENTBOX_WEB_PROXY_PORT). */
const TENKI_WEB_PORT = 8080;

/**
 * Per-box session timeout the SDK enforces at create (`maxDurationMs`). The
 * host keepalive loop pushes it forward while the agent is active via
 * `renewTimeout` (additive `session.extend`). 45 min default mirrors e2b/vercel.
 */
export const DEFAULT_MAX_DURATION_MS = 45 * 60_000;

/** Wait budget for create/resume (`createAndWait` boots + waits for the data plane). */
const PROVISION_TIMEOUT_MS = 300_000;

const decoder = new TextDecoder();

/** Map the SDK's SessionState onto our 4-value CloudState. */
export function mapState(s: SessionState | undefined): CloudState {
  switch (s) {
    case 'RUNNING':
    case 'CREATING':
    case 'RESUMING':
      return 'running';
    case 'PAUSED':
    case 'PAUSING':
    // USER_SHUTDOWN is a stopped-but-not-terminated VM (0.4.0+). The API groups
    // it with PAUSED as an existing, non-active state, so treat it as paused so
    // an op that needs the box live resumes it rather than agentbox concluding
    // the box is gone and recreating it.
    case 'USER_SHUTDOWN':
      return 'paused';
    default:
      // TERMINATING / TERMINATED / UNSPECIFIED / undefined
      return 'missing';
  }
}

/** True when the error means "session doesn't exist / is gone". */
function isGone(err: unknown): boolean {
  const name = err instanceof Error ? err.name : '';
  return (
    name === 'SessionNotFoundError' ||
    name === 'SessionTerminatedError' ||
    name === 'SessionExpiredError'
  );
}

/** Strip control chars defensively so a name with embedded newlines can't break log parsing. */
export function safeName(name: string): string {
  return name.replace(/[\u0000-\u001f]/g, '').slice(0, 200);
}

/**
 * Stable, DNS-safe preview slug for (session, port) so re-exposing the same
 * port is idempotent and the URL doesn't churn across calls.
 */
export function previewSlug(sandboxId: string, port: number): string {
  const id =
    sandboxId
      .replace(/[^a-z0-9]/gi, '')
      .slice(-12)
      .toLowerCase() || 'box';
  return `ab-${id}-${String(port)}`;
}

/**
 * Minimum lifetime handed to a re-minted expiring share, so a refresh can't
 * return a URL that is already about to die.
 */
const REFRESH_MIN_TTL_MS = 60_000;

// --- preview share kinds ---------------------------------------------------
//
// The two kinds this backend mints are mutually exclusive per share, because the
// API rejects `slug` + `ttlMs` together (`expires_at is not supported when slug
// is set`). So a share either carries our stable slug and never expires, or it
// carries a server-assigned URL and an `expiresAt`. `expiresAt` is the
// discriminator.
//
// Selecting by KIND rather than by port alone is the whole point: a port can
// hold either kind, and reusing whatever was found first meant
// `signedPreviewUrl` could hand back the permanent public URL (never expiring,
// despite the caller asking for an expiry) and `previewUrl` could hand back one
// that dies minutes later.

/** The non-expiring, stable-slug share for `port`, if one is exposed. */
export function findPermanentShare(
  shares: readonly ExposedPort[],
  port: number,
): ExposedPort | undefined {
  return shares.find((p) => p.port === port && p.expiresAt === undefined);
}

/**
 * An expiring share for `port` with at least `minRemainingMs` of life left. A
 * shorter-lived one is rejected rather than reused, so a signed URL is never
 * quietly weaker than the caller asked for.
 */
export function findExpiringShare(
  shares: readonly ExposedPort[],
  port: number,
  minRemainingMs: number,
  nowMs: number,
): ExposedPort | undefined {
  return shares.find(
    (p) =>
      p.port === port &&
      p.expiresAt !== undefined &&
      p.expiresAt.getTime() - nowMs >= minRemainingMs,
  );
}

async function resolveSession(handle: CloudHandle): Promise<Session> {
  return getTenkiClient().get(handle.sandboxId);
}

/**
 * The owner scope a session is created under.
 *
 * A workspace auth token infers its own scope, so this is normally empty and
 * `create` carries no owner fields at all. `AGENTBOX_TENKI_WORKSPACE_ID` (the
 * name `prepare` already honors) pins it explicitly, which is what trusted
 * service credentials — valid for more than one workspace — need.
 *
 * Historically this also resolved a `project_id`, which `create` once required
 * and which cost a `whoAmI` round-trip to discover. Tenki removed that
 * requirement (the proto field is deprecated and `CreateOptions` no longer
 * accepts it), so the lookup is gone with it.
 */
function resolveOwnerScope(): { workspaceId?: string } {
  const envWorkspace = process.env.AGENTBOX_TENKI_WORKSPACE_ID?.trim();
  return envWorkspace ? { workspaceId: envWorkspace } : {};
}

/**
 * Resume a paused session before an op that needs the box live (exec, file
 * transfer). Matches e2b's connect-auto-resumes semantics: a caller asking to
 * run a command on the box wants it awake. No-op when already running.
 */
async function ensureLive(session: Session): Promise<void> {
  if (
    session.state === 'PAUSED' ||
    session.state === 'PAUSING' ||
    session.state === 'USER_SHUTDOWN'
  ) {
    await session.resume();
    await session.waitReady(PROVISION_TIMEOUT_MS);
  }
}

// --- workdir bridge for file transfer -------------------------------------
//
// Tenki's guest-agent file RPC (`writeFileStream`/`readFileStream`) is jailed
// to the session's configured workdir — an absolute path outside it (the cloud
// scaffold stages workspace/credential tarballs under `/tmp`) is rejected with
// `path outside workdir`. `exec` is NOT jailed, so we bridge: write/read through
// the RPC at a workdir-relative staging path (which it accepts), then move the
// bytes to/from the caller's absolute target with a shell `mv`/`cp`. Paths that
// already live under the workdir skip the bridge and stream directly.

/** Single-quote a string for safe interpolation into a `bash -c` script. */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

let stageSeq = 0;
/** A collision-free, workdir-relative staging filename (dotfile, so it stays out of the way). */
function stageName(kind: string): string {
  stageSeq += 1;
  return `.agentbox-${kind}-${String(process.pid)}-${String(stageSeq)}.tmp`;
}

// The guest workdir is fixed for a session's life; resolve it once per session
// (a cheap `pwd`, whose cwd defaults to the workdir) and cache it.
const workdirCache = new Map<string, string>();
async function resolveGuestWorkdir(session: Session): Promise<string> {
  const cached = workdirCache.get(session.id);
  if (cached !== undefined) return cached;
  const r = await session.run(['bash', '-c', 'pwd']);
  const wd = decoder.decode(r.stdout).trim() || '/';
  workdirCache.set(session.id, wd);
  return wd;
}

/**
 * True when a file RPC target is inside the guest workdir (so it can stream
 * directly instead of via the exec bridge). Relative paths always resolve under
 * the workdir; absolute paths must equal it or sit beneath it (a `/` boundary
 * check so `/workspace` doesn't match `/workspace-evil`).
 */
export function isUnderWorkdir(path: string, workdir: string): boolean {
  if (!posix.isAbsolute(path)) return true;
  const p = posix.normalize(path);
  const d = posix.normalize(workdir);
  return p === d || p.startsWith(d.endsWith('/') ? d : `${d}/`);
}

/** Move a workdir-relative staged file to an absolute target via exec (unjailed). */
async function moveStagedTo(session: Session, relStage: string, remotePath: string): Promise<void> {
  const script = [
    'set -eu',
    "if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi",
    `src="$(pwd)/${relStage}"`,
    `$SUDO mkdir -p ${shq(posix.dirname(remotePath))}`,
    `$SUDO mv -f "$src" ${shq(remotePath)}`,
  ].join('\n');
  const r = await session.run(['bash', '-c', script]);
  if (r.exitCode !== 0) {
    try {
      await session.run(['bash', '-c', `rm -f ${shq(relStage)}`]);
    } catch {
      // best-effort cleanup of the orphaned stage
    }
    throw new Error(
      `tenki uploadFile: staging move to ${remotePath} failed (exit ${String(r.exitCode)}): ${decoder.decode(r.stderr).trim()}`,
    );
  }
}

/** Copy an absolute source into a workdir-relative staged file via exec (unjailed). */
async function copyIntoStage(
  session: Session,
  remotePath: string,
  relStage: string,
): Promise<void> {
  const script = [
    'set -eu',
    "if command -v sudo >/dev/null 2>&1; then SUDO='sudo -n'; else SUDO=''; fi",
    `dst="$(pwd)/${relStage}"`,
    `$SUDO cp -f ${shq(remotePath)} "$dst"`,
    // The RPC reads as the guest user; ensure it owns the staged copy.
    `$SUDO chown "$(id -u):$(id -g)" "$dst" 2>/dev/null || true`,
  ].join('\n');
  const r = await session.run(['bash', '-c', script]);
  if (r.exitCode !== 0) {
    throw new Error(
      `tenki downloadFile: staging copy from ${remotePath} failed (exit ${String(r.exitCode)}): ${decoder.decode(r.stderr).trim()}`,
    );
  }
}

/**
 * Parse a `cpu-memory` or `cpu-memory-disk` GB size spec (e.g. `4-8` or
 * `4-8-20`) into create-time resources. Returns undefined on malformed input
 * (2 or 3 positive-integer slots). `memory`/`disk` are GB. Tenki applies these
 * at create (`createAndWait`), so `--size` / `box.size` actually changes the
 * box's resources (unlike e2b, whose size is baked at prepare time).
 */
export function parseTenkiSize(
  spec: string | undefined,
): { cpu: number; memoryGb: number; diskGb?: number } | undefined {
  if (!spec) return undefined;
  const parts = spec.trim().split('-');
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n <= 0)) return undefined;
  return { cpu: nums[0]!, memoryGb: nums[1]!, diskGb: nums[2] };
}

export const tenkiBackend: CloudBackend = {
  name: 'tenki',

  webProxyPort: TENKI_WEB_PORT,

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    const log = req.onLog ?? (() => {});
    // Both paths boot from a snapshot id: a checkpoint (req.snapshot) wins,
    // otherwise the base snapshot baked by `prepare`. The gate throws an
    // actionable "run `agentbox prepare`" error when no base is recorded
    // (prepare itself sidesteps the gate by never calling provision).
    if (req.snapshot === undefined) ensureTenkiBaseImage();
    const snapshotId = req.snapshot ?? readPreparedState().base?.snapshotId;
    if (!snapshotId) {
      throw new Error(
        'tenki provision: no base snapshot available — `agentbox prepare --provider tenki` must run first',
      );
    }

    // `--size` / `box.size` (a `cpu-memory[-disk]` GB spec, e.g. `4-8`)
    // overrides the create-time resources when valid; Tenki applies them at
    // create, so the box actually gets the requested size. Invalid specs fall
    // back to the resolved defaults with a log.
    let cpuCores = req.resources?.cpu ?? 2;
    let memoryMb = (req.resources?.memory ?? 4) * 1024;
    let diskSizeGb = req.resources?.disk ?? 8;
    if (req.size && req.size.trim().length > 0) {
      const parsed = parseTenkiSize(req.size);
      if (parsed) {
        cpuCores = parsed.cpu;
        memoryMb = parsed.memoryGb * 1024;
        if (parsed.diskGb !== undefined) diskSizeGb = parsed.diskGb;
      } else {
        (req.onLog ?? (() => {}))(
          `tenki: ignoring invalid size '${req.size}' (expected 'cpu-memory' or 'cpu-memory-disk' GB, e.g. '4-8')`,
        );
      }
    }
    const maxDurationMs = req.timeoutMs ?? DEFAULT_MAX_DURATION_MS;
    const client = getTenkiClient();

    // Empty for a workspace token (it infers its own scope); set only when
    // AGENTBOX_TENKI_WORKSPACE_ID pins it.
    const { workspaceId } = resolveOwnerScope();

    // Split create from wait so a slow/stuck boot can't orphan a billable VM.
    // `createAndWait` throws WITHOUT surfacing the session id on a readiness
    // timeout, so a box that was provisioned but never became ready would leak
    // (its id lost). Instead: `create({ waitReady: false })` returns the id as
    // soon as the session record exists, then we wait separately — and if the
    // wait times out or fails, we still hold the id and terminate the box.
    //
    // No-retry on the create RPC: it is billable and non-idempotent, and the
    // SDK exposes no idempotency key, so a retry could double-provision.
    const session = await withTenkiRetry(
      { method: 'provision', retryOnAmbiguous: false, attemptTimeoutMs: 120_000, backoffMs: [] },
      () =>
        client.create({
          name: safeName(req.name),
          snapshotId,
          ...(workspaceId ? { workspaceId } : {}),
          env: req.env,
          cpuCores,
          memoryMb,
          diskSizeGb,
          // Inbound is required for preview URLs (exposePort); outbound for the
          // agents' network. Tenki has no domain-allowlist primitive, so
          // req.networkPolicy 'deny-all' maps to allowOutbound:false, else allow.
          allowInbound: true,
          allowOutbound: req.networkPolicy !== 'deny-all',
          maxDurationMs,
          // Marker so list()/prune can filter to agentbox-managed sessions.
          metadata: { agentbox: 'true', 'agentbox.name': safeName(req.name) },
          tags: ['agentbox'],
          // Return as soon as the session exists; we own the wait below so a
          // readiness timeout can't lose the id.
          waitReady: false,
        }),
    );
    try {
      await session.waitReady(PROVISION_TIMEOUT_MS);
    } catch (err) {
      // The VM exists but never came ready (timeout / terminal boot failure).
      // Terminate it so it doesn't linger billable, then surface the error.
      await session.close().catch(() => undefined);
      throw err;
    }
    log(`tenki: created session ${session.id} (${req.snapshot ? 'snapshot' : 'image'})`);
    return { sandboxId: session.id };
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    return withTenkiRetry({ method: 'get', retryOnAmbiguous: true }, async () => {
      try {
        await getTenkiClient().get(sandboxId);
        return { sandboxId };
      } catch (err) {
        if (isGone(err)) return null;
        throw err;
      }
    });
  },

  async list(): Promise<CloudSandboxSummary[]> {
    return withTenkiRetry({ method: 'list', retryOnAmbiguous: true }, async () => {
      const sessions = await getTenkiClient().list();
      const out: CloudSandboxSummary[] = [];
      for (const s of sessions) {
        if (s.metadata?.['agentbox'] !== 'true') continue;
        const summary: CloudSandboxSummary = { sandboxId: s.id, state: mapState(s.state) };
        const friendly = s.metadata?.['agentbox.name'] ?? s.name;
        if (friendly) summary.name = friendly;
        out.push(summary);
      }
      return out;
    });
  },

  async start(h: CloudHandle): Promise<void> {
    await withTenkiRetry(
      { method: 'start', retryOnAmbiguous: true, attemptTimeoutMs: PROVISION_TIMEOUT_MS },
      async () => {
        const session = await resolveSession(h);
        await ensureLive(session);
      },
    );
  },

  // No separate "stop VM, keep record" in the high-level SDK — pause IS the
  // cold-storage state (it captures a pause snapshot). stop ≡ pause.
  async stop(h: CloudHandle): Promise<void> {
    await this.pause(h);
  },

  async pause(h: CloudHandle): Promise<void> {
    await withTenkiRetry(
      { method: 'pause', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        const session = await resolveSession(h);
        // Already cold (paused or shut down) — nothing to pause.
        if (
          session.state === 'PAUSED' ||
          session.state === 'PAUSING' ||
          session.state === 'USER_SHUTDOWN'
        )
          return;
        await session.pause();
      },
    );
  },

  async resume(h: CloudHandle): Promise<void> {
    await this.start(h);
  },

  async destroy(h: CloudHandle): Promise<void> {
    await withTenkiRetry(
      { method: 'destroy', retryOnAmbiguous: true, attemptTimeoutMs: 120_000 },
      async () => {
        try {
          const session = await resolveSession(h);
          await session.close();
        } catch (err) {
          if (isGone(err)) return; // idempotent
          throw err;
        }
      },
    );
    // The attach keypair outlives the session it authenticates, so without this
    // every box ever created leaves a private key behind on the host. Losing the
    // key is harmless once the sandbox is gone, so failures here are ignored.
    try {
      rmSync(sshKeyDir(h.sandboxId), { recursive: true, force: true });
    } catch {
      // best effort
    }
  },

  async state(h: CloudHandle): Promise<CloudState> {
    return withTenkiRetry({ method: 'state', retryOnAmbiguous: true }, async () => {
      try {
        const session = await resolveSession(h);
        return mapState(session.state);
      } catch (err) {
        if (isGone(err)) return 'missing';
        throw err;
      }
    });
  },

  // The host keepalive loop calls this while the agent is active. `extend` is
  // ADDITIVE (extends by N ms), and the SDK doesn't expose the remaining time
  // readably, so we extend by `target - current` (the host owns the deadline
  // bookkeeping, same as vercel). The host only calls when target > current.
  async renewTimeout(
    h: CloudHandle,
    targetDeadlineEpochMs: number,
    currentDeadlineEpochMs: number,
  ): Promise<void> {
    const deltaMs = Math.max(0, targetDeadlineEpochMs - currentDeadlineEpochMs);
    if (deltaMs === 0) return;
    await withTenkiRetry({ method: 'renewTimeout', retryOnAmbiguous: true }, async () => {
      const session = await resolveSession(h);
      await session.extend(deltaMs);
    });
  },

  async exec(h: CloudHandle, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    const timeoutMs = opts?.attemptTimeoutMs ?? 300_000;
    return withTenkiRetry(
      {
        method: 'exec',
        retryOnAmbiguous: opts?.noRetry ? false : true,
        attemptTimeoutMs: timeoutMs,
        backoffMs: opts?.noRetry ? [] : undefined,
      },
      async () => {
        const session = await resolveSession(h);
        await ensureLive(session);
        // The scaffold hands us a ready-to-run shell command string (either a
        // shell-quoted argv or a `bash -c '<script>'`). Run it through bash so
        // pipefail/heredocs/etc. behave uniformly. Tenki's `run` has no
        // per-exec user field — only `privileged`; map user==='root' to it and
        // otherwise rely on the base image's default user.
        const r = await session.run(['bash', '-c', cmd], {
          ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
          ...(opts?.env !== undefined ? { env: opts.env } : {}),
          ...(opts?.user === 'root' ? { privileged: true } : {}),
        });
        return {
          exitCode: r.exitCode,
          stdout: decoder.decode(r.stdout),
          stderr: decoder.decode(r.stderr),
        };
      },
    );
  },

  async uploadFile(h: CloudHandle, localPath: string, remotePath: string): Promise<void> {
    await withTenkiRetry(
      { method: 'uploadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      async () => {
        const session = await resolveSession(h);
        await ensureLive(session);
        // Stream the file so a large workspace tarball (tens of MB) never has to
        // sit fully in memory. The guest-agent file RPC is jailed to the workdir;
        // targets outside it stage under the workdir then move into place (see
        // the workdir-bridge helpers). writeFileStream and run share the data
        // plane uid, so no post-write chown is needed.
        const workdir = await resolveGuestWorkdir(session);
        const web = () =>
          Readable.toWeb(createReadStream(localPath)) as unknown as ReadableStream<Uint8Array>;
        if (isUnderWorkdir(remotePath, workdir)) {
          await session.writeFileStream(remotePath, web(), { mode: 0o644 });
          return;
        }
        const stage = stageName('upload');
        await session.writeFileStream(stage, web(), { mode: 0o644 });
        await moveStagedTo(session, stage, remotePath);
      },
    );
  },

  async downloadFile(h: CloudHandle, remotePath: string, localPath: string): Promise<void> {
    await withTenkiRetry(
      { method: 'downloadFile', retryOnAmbiguous: true, attemptTimeoutMs: 300_000 },
      async () => {
        const session = await resolveSession(h);
        await ensureLive(session);
        const workdir = await resolveGuestWorkdir(session);
        const sink = (web: WebReadableStream<Uint8Array>) =>
          pipeline(Readable.fromWeb(web), createWriteStream(localPath));
        if (isUnderWorkdir(remotePath, workdir)) {
          const web = (await session.readFileStream(
            remotePath,
          )) as unknown as WebReadableStream<Uint8Array>;
          await sink(web);
          return;
        }
        // Outside the workdir: copy into a staged file via exec, read that back
        // through the RPC, then drop the stage.
        const stage = stageName('download');
        await copyIntoStage(session, remotePath, stage);
        try {
          const web = (await session.readFileStream(
            stage,
          )) as unknown as WebReadableStream<Uint8Array>;
          await sink(web);
        } finally {
          await session.remove(stage).catch(() => undefined);
        }
      },
    );
  },

  async listFiles(h: CloudHandle, remoteDir: string): Promise<CloudFileEntry[]> {
    return withTenkiRetry({ method: 'listFiles', retryOnAmbiguous: true }, async () => {
      const session = await resolveSession(h);
      await ensureLive(session);
      const entries = await session.list(remoteDir);
      return entries.map((e) => ({ name: basename(e.path), isDir: e.isDir }));
    });
  },

  async previewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return withTenkiRetry({ method: 'previewUrl', retryOnAmbiguous: true }, async () => {
      const session = await resolveSession(h);
      // Reuse only a PERMANENT share (idempotent across the box's lifetime).
      // Handing back an expiring one would give the caller — and the scaffold's
      // cache — a URL that dies on its own.
      const shares = await session.listExposedPorts();
      const existing = findPermanentShare(shares, port);
      if (existing) return { url: existing.previewUrl };
      // The port is held by the other kind. Clear it first: unexpose-then-expose
      // is the sequence `refreshPreviewUrl` already relies on, whereas exposing
      // a port that is already exposed is not a behaviour we can count on.
      if (shares.some((p) => p.port === port)) {
        await session.unexposePort(port).catch(() => undefined);
      }
      const exposed = await session.exposePort(port, { slug: previewSlug(h.sandboxId, port) });
      return { url: exposed.previewUrl };
    });
  },

  // Tenki preview URLs are public + browser-usable; expiry maps to ttlMs.
  // NOTE: the API rejects `slug` + `ttlMs` together (`expires_at is not
  // supported when slug is set`), so an expiring share can't carry our stable
  // slug — we mint a server-assigned URL instead. Re-exposing therefore churns
  // the URL, which is inherent to an expiring (signed) share.
  async signedPreviewUrl(
    h: CloudHandle,
    port: number,
    expiresInSeconds: number,
  ): Promise<CloudPreviewUrl> {
    return withTenkiRetry({ method: 'signedPreviewUrl', retryOnAmbiguous: true }, async () => {
      const session = await resolveSession(h);
      const ttlMs = Math.max(1, expiresInSeconds) * 1000;
      const shares = await session.listExposedPorts();
      // Reuse only an EXPIRING share that still covers the requested window.
      // Reusing any share for the port meant a request for a 60-second URL could
      // be answered with the permanent public one, which never expires — the
      // caller believes the exposure lapses and it does not.
      const existing = findExpiringShare(shares, port, ttlMs, Date.now());
      if (existing) return { url: existing.previewUrl };
      if (shares.some((p) => p.port === port)) {
        await session.unexposePort(port).catch(() => undefined);
      }
      const exposed = await session.exposePort(port, { ttlMs });
      return { url: exposed.previewUrl };
    });
  },

  // Re-mint a share when the cached URL stops responding (host poller).
  async refreshPreviewUrl(h: CloudHandle, port: number): Promise<CloudPreviewUrl> {
    return withTenkiRetry({ method: 'refreshPreviewUrl', retryOnAmbiguous: true }, async () => {
      const session = await resolveSession(h);
      // Re-mint the SAME KIND that was there. Unconditionally re-exposing with
      // the stable slug silently promoted an expiring share into a permanent
      // public one: a refresh must never widen exposure beyond what the share it
      // replaces already had.
      const prior = (await session.listExposedPorts()).find((p) => p.port === port);
      const priorRemainingMs =
        prior?.expiresAt === undefined ? undefined : prior.expiresAt.getTime() - Date.now();
      try {
        await session.unexposePort(port);
      } catch {
        // best-effort: the share may already be gone
      }
      if (priorRemainingMs !== undefined) {
        // Floor the replacement's lifetime: the prior share may have been at the
        // very end of its window (or already past it) when the refresh fired.
        const exposed = await session.exposePort(port, {
          ttlMs: Math.max(REFRESH_MIN_TTL_MS, priorRemainingMs),
        });
        return { url: exposed.previewUrl };
      }
      const exposed = await session.exposePort(port, { slug: previewSlug(h.sandboxId, port) });
      return { url: exposed.previewUrl };
    });
  },

  /**
   * Probe whether a snapshot id is still bootable. Returns false on any lookup
   * failure (treated by the cloud-provider as "gone" so it falls back to a
   * from-base boot rather than erroring the user).
   */
  async snapshotExists(snapshotName: string): Promise<boolean> {
    return withTenkiRetry({ method: 'snapshotExists', retryOnAmbiguous: true }, async () => {
      try {
        const snap = await getTenkiClient().getSnapshot(snapshotName);
        return snap.state === 'READY';
      } catch {
        return false;
      }
    });
  },
};
