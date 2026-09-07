/**
 * `agentbox prepare --provider tenki` — bake the AgentBox base image, then pin it
 * as a snapshot so per-box `create` boots ready in seconds.
 *
 * ## Shape: builder sandbox, not the template API
 *
 * Boot a throwaway session from Tenki's plain `sandbox` base, push the runtime in
 * over the data plane, run the install with `session.run`, snapshot it, and
 * record the snapshot id. This is the same shape the built-in Vercel and E2B
 * providers use, and it sidesteps every constraint the template API imposes:
 *
 *   - **Real file upload.** A template build context is Git-only, so a template
 *     cannot receive host files at all — it would have to reinstall the runtime
 *     from npm and hope the published version matches the CLI. Over the data
 *     plane we ship the *running CLI's own* `ctl.cjs` and shims via the provider
 *     SDK's `resolveSharedRuntimeAsset`, which is the intended version-locking
 *     mechanism.
 *   - **Bash.** Template steps run under `sh -lc` (dash), where `pipefail` is a
 *     fatal bashism. `session.run(['bash', '-c', …])` — what the backend already
 *     uses for every exec — gives us bash 5.2.
 *   - **Per-step error attribution.** Each install step is its own exec with a
 *     name, so a failure says which step broke instead of failing somewhere
 *     inside one opaque script.
 *   - **No template-API restrictions**: no required `setup_script`, no
 *     single-default-run-step projection, no Git-context rule.
 *
 * Boxes then boot with `create({ snapshotId })` — the same path the
 * checkpoint-restore flow already exercises.
 */

import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readCliStamp,
  resolveSharedRuntimeAsset,
  stageAllAgentStatic,
  UserFacingError,
  type CloudHandle,
  type Provider,
  type StageResult,
  type AgentStaticStage,
} from '@madarco/agentbox-provider-sdk';
import { tenkiBackend } from './backend.js';
import { ensureTenkiCredentials } from './credentials.js';
import { getTenkiClient, resolveAuthToken } from './sdk.js';
import { preparedStatePath, readPreparedState, writePreparedState } from './prepared-state.js';

/** Resources the builder session runs with. Disk is the constraint — npm installs are chunky. */
const BUILDER_CPU = 2;
const BUILDER_MEMORY_MB = 4096;
const BUILDER_DISK_GB = 20;
/** Builder lifetime. Generous: apt plus three npm installs on a cold VM. */
const BUILDER_MAX_DURATION_MS = 45 * 60_000;
const BUILDER_READY_TIMEOUT_MS = 240_000;

/**
 * The unprivileged user Tenki's `sandbox` base runs as — its data plane, `run`
 * and `ssh()` all land here. We keep it rather than renaming it to AgentBox's
 * usual `vscode`: renaming the account the platform's own guest agent runs under
 * is a good way to break the session. `/home/vscode` is symlinked to it instead.
 */
const BOX_USER = 'tenki';
const BOX_HOME = `/home/${BOX_USER}`;

/** Directory layout every AgentBox box is expected to have. */
const BOX_DIRS = [
  '/workspace',
  '/run/agentbox',
  '/var/log/agentbox',
  '/var/lib/agentbox',
  '/etc/agentbox',
  '/etc/claude-code',
  '/usr/local/share/agentbox',
];

/** Paths chowned to the box user once everything is installed. */
const OWNED_PATHS = [
  BOX_HOME,
  '/workspace',
  '/run/agentbox',
  '/var/log/agentbox',
  '/var/lib/agentbox',
];

/**
 * A provider-neutral runtime asset, taken from the *running CLI* and pushed in
 * over the data plane.
 */
export interface PrepareAsset {
  /** Basename in the CLI's `runtime/_shared/`. */
  shared: string;
  /** Absolute destination inside the box. */
  dest: string;
  /** Octal mode applied on install. */
  mode: string;
}

/**
 * `shared` names must exist in the SDK's `SHARED_RUNTIME_ASSETS`; never vendor
 * copies of these — resolving them from the CLI is what keeps the baked
 * `agentbox-ctl` version-locked to the host driving the box.
 *
 * The `gh` / `git` / `ntn` / `linear` entries are deliberately *shims*: they land
 * in `/usr/local/bin`, which precedes `/usr/bin` on PATH, so an agent running
 * `git push` reaches the host relay (which holds the credentials) rather than the
 * real binary. That indirection is why a box needs no credentials of its own.
 */
export const PREPARE_ASSETS: readonly PrepareAsset[] = [
  { shared: 'ctl.cjs', dest: '/usr/local/bin/agentbox-ctl', mode: '0755' },
  { shared: 'agentbox-vnc-start', dest: '/usr/local/bin/agentbox-vnc-start', mode: '0755' },
  { shared: 'agentbox-dockerd-start', dest: '/usr/local/bin/agentbox-dockerd-start', mode: '0755' },
  {
    shared: 'agentbox-portless-trust',
    dest: '/usr/local/bin/agentbox-portless-trust',
    mode: '0755',
  },
  {
    shared: 'agentbox-checkpoint-cleanup',
    dest: '/usr/local/bin/agentbox-checkpoint-cleanup',
    mode: '0755',
  },
  { shared: 'agentbox-open', dest: '/usr/local/bin/agentbox-open', mode: '0755' },
  { shared: 'gh-shim', dest: '/usr/local/bin/gh', mode: '0755' },
  { shared: 'git-shim', dest: '/usr/local/bin/git', mode: '0755' },
  // The notion/linear connectors were deleted upstream and replaced by one
  // generic host-tool shim, symlinked per granted tool when the box starts.
  { shared: 'agentbox-tool-shim', dest: '/usr/local/bin/agentbox-tool-shim', mode: '0755' },
  {
    shared: 'claude-managed-settings.json',
    dest: '/etc/claude-code/managed-settings.json',
    mode: '0644',
  },
  {
    shared: 'agentbox-codex-hooks.json',
    dest: '/usr/local/share/agentbox/codex-hooks.json',
    mode: '0644',
  },
  {
    shared: 'agentbox-setup-skill.md',
    dest: '/usr/local/share/agentbox/setup-guide.md',
    mode: '0644',
  },
  {
    shared: 'opencode-agentbox-plugin.js',
    dest: '/usr/local/share/agentbox/opencode-agentbox-plugin.js',
    mode: '0644',
  },
];

/** Staging path an asset is uploaded to before being installed into place. */
export function stagedAssetPath(shared: string): string {
  return `/tmp/agentbox-stage-${shared}`;
}

/** Coding agents installed globally from npm. */
const AGENT_PACKAGES = ['@anthropic-ai/claude-code', '@openai/codex', 'opencode-ai'];

/**
 * Login-shell environment. `box.env` is written per-box at create time, so this
 * only carries what is constant for the image.
 */
const PROFILE_SH = `# Auto-loaded by login shells; box.env is written at create time.
if [ -r /etc/agentbox/box.env ]; then
  set -a
  . /etc/agentbox/box.env
  set +a
fi
case ":$PATH:" in
  *:${BOX_HOME}/.local/bin:*) : ;;
  *) PATH=${BOX_HOME}/.local/bin:$PATH ;;
esac
export PATH
export COLORTERM=\${COLORTERM:-truecolor}
export DISABLE_AUTOUPDATER=\${DISABLE_AUTOUPDATER:-1}
export BROWSER=\${BROWSER:-/usr/local/bin/agentbox-open}
`;

/** One install step, run as its own exec so a failure names the step. */
export interface PrepareStep {
  name: string;
  command: string;
  /** Run as root (`privileged`). Unset means the box user. */
  root?: boolean;
  /** Per-step attempt timeout; the backend default (5 min) is too short for npm. */
  timeoutMs?: number;
}

/**
 * The install plan, as discrete steps. Pure, so the whole recipe is assertable
 * offline — a mistake here otherwise only surfaces minutes into a live bake.
 *
 * `bash -c` is guaranteed (the backend's exec always uses it), so `pipefail` and
 * heredocs are safe here, unlike in a template build step.
 */
export function buildInstallPlan(): PrepareStep[] {
  const quoted = (paths: readonly string[]): string => paths.map((p) => `"${p}"`).join(' ');

  return [
    {
      name: 'apt-packages',
      root: true,
      timeoutMs: 600_000,
      // tmux: the one hard dependency the base image lacks, and every
      // interactive attach runs inside a tmux session.
      //
      // docker.io: in-box Docker. Verified working on a Tenki VM — cgroup2,
      // native overlay2 (not the slow vfs fallback), and the shared
      // `agentbox-dockerd-start` launcher brings the daemon up. Containers do
      // not need nested virtualization, so the absence of /dev/kvm is irrelevant.
      command: [
        'set -euo pipefail',
        'export DEBIAN_FRONTEND=noninteractive',
        'apt-get update -qq',
        'apt-get install -y --no-install-recommends tmux docker.io',
        // The agent runs unprivileged. Login shells (attach, tmux) reach the
        // daemon through this group; Tenki's guest agent starts its exec
        // processes without supplementary groups, so those rely instead on the
        // socket mode the dockerd launcher sets. Both paths are covered.
        `usermod -aG docker ${BOX_USER}`,
      ].join('\n'),
    },
    {
      name: 'box-dirs',
      root: true,
      command: `set -euo pipefail\nmkdir -p ${quoted(BOX_DIRS)}\nchmod 755 /workspace`,
    },
    {
      name: 'vscode-user',
      root: true,
      // AgentBox's credential seed (as inlined in the published provider SDK)
      // extracts with an in-shell `sudo -u vscode`, so the box needs a real
      // `vscode` account or the seed dies with "sudo: unknown user vscode" and
      // every box starts logged out. We add it as an ALIAS of the box user
      // (same uid/gid, same home, `-o` to permit the duplicate uid) rather than
      // a separate account: files then land owned by the user the agents
      // actually run as, and Tenki's own guest agent keeps its identity.
      //
      // The CLI has since switched to `backend.exec(…, { user })` with no
      // in-shell sudo; this step stays harmless once the SDK catches up.
      command: [
        'set -euo pipefail',
        'if ! id vscode >/dev/null 2>&1; then',
        `  useradd -o -u "$(id -u ${BOX_USER})" -g "$(id -g ${BOX_USER})" -d ${BOX_HOME} -s /bin/bash vscode`,
        'fi',
        'id vscode >/dev/null',
      ].join('\n'),
    },
    {
      name: 'vscode-home-link',
      root: true,
      // agentbox-ctl hardcodes /home/vscode/... credential paths and the profile
      // shim puts /home/vscode/.local/bin on PATH. A symlink satisfies both
      // without renaming the platform's own user.
      command: `set -euo pipefail\nln -sfn ${BOX_HOME} /home/vscode`,
    },
    {
      name: 'runtime-assets',
      root: true,
      command: [
        'set -euo pipefail',
        ...PREPARE_ASSETS.map(
          ({ shared, dest, mode }) =>
            `install -D -m ${mode} "${stagedAssetPath(shared)}" "${dest}"`,
        ),
        // `xdg-open` is what agents and browsers actually invoke; route it to the
        // relay-backed opener so a link opens on the *host*, not in the box.
        'ln -sf /usr/local/bin/agentbox-open /usr/local/bin/xdg-open',
        `rm -f ${quoted(PREPARE_ASSETS.map((a) => stagedAssetPath(a.shared)))}`,
      ].join('\n'),
    },
    {
      name: 'agent-dirs',
      // Runs as the box user so its own home comes out correctly owned.
      //
      // The credential PIVOT is the point of this step. AgentBox's cloud scaffold
      // seeds per-agent credentials at CREATE time — for a backend with no volume
      // primitive (us, like vercel/e2b/hetzner) it uploads them straight into
      // `~/.agentbox-creds/<agent>/`. Those symlinks are what make the agents
      // actually read them; without the layout baked here, the seed lands in a
      // directory nothing consults and every box starts logged out.
      command: [
        'set -euo pipefail',
        `mkdir -p ${BOX_HOME}/.claude/skills/agentbox-setup ${BOX_HOME}/.codex \
  ${BOX_HOME}/.local/share/opencode ${BOX_HOME}/.agentbox-creds/claude \
  ${BOX_HOME}/.agentbox-creds/codex ${BOX_HOME}/.agentbox-creds/opencode`,
        `ln -sf ${BOX_HOME}/.agentbox-creds/claude/.credentials.json ${BOX_HOME}/.claude/.credentials.json`,
        `ln -sf ${BOX_HOME}/.agentbox-creds/codex/auth.json ${BOX_HOME}/.codex/auth.json`,
        `ln -sf ${BOX_HOME}/.agentbox-creds/opencode/auth.json ${BOX_HOME}/.local/share/opencode/auth.json`,
        `ln -sf ${BOX_HOME}/.claude/_claude.json ${BOX_HOME}/.claude.json`,
        // The in-box first-run wizard the setup prompt refers to.
        `cp /usr/local/share/agentbox/setup-guide.md ${BOX_HOME}/.claude/skills/agentbox-setup/SKILL.md`,
      ].join('\n'),
    },
    {
      name: 'coding-agents',
      // npm's global prefix is writable by the box user in Tenki's base image, so
      // this needs no elevation — and installing as the box user keeps the
      // resulting file ownership right.
      timeoutMs: 1_800_000,
      command: `set -euo pipefail\nnpm install -g ${AGENT_PACKAGES.join(' ')}`,
    },
    {
      name: 'login-shell-env',
      root: true,
      command: [
        'set -euo pipefail',
        "cat > /etc/profile.d/agentbox.sh <<'AGENTBOX_PROFILE'",
        PROFILE_SH.trimEnd(),
        'AGENTBOX_PROFILE',
        'chmod 0644 /etc/profile.d/agentbox.sh',
      ].join('\n'),
    },
    {
      name: 'ownership',
      root: true,
      // Last: the steps above wrote as root, and the box runs unprivileged.
      command: `set -euo pipefail\nchown -R ${BOX_USER}:${BOX_USER} ${quoted(OWNED_PATHS)}`,
    },
    {
      name: 'verify',
      // Fail the bake here rather than pinning a snapshot that cannot supervise a
      // box. `agentbox-ctl` is the one that really matters.
      command: [
        'set -euo pipefail',
        'command -v tmux >/dev/null',
        'command -v agentbox-ctl >/dev/null',
        // In-box docker: the binaries plus the box user's group membership, so a
        // login shell in the box reaches the daemon without sudo.
        'command -v docker >/dev/null',
        'command -v dockerd >/dev/null',
        `id -nG ${BOX_USER} | tr ' ' '\\n' | grep -qx docker`,
        'test -x /usr/local/bin/agentbox-ctl',
        'test -f /etc/claude-code/managed-settings.json',
        'for a in claude codex opencode; do command -v "$a" >/dev/null || { echo "agent $a missing" >&2; exit 1; }; done',
        // The credential pivot must be symlinks pointing into ~/.agentbox-creds,
        // or the create-time credential seed lands where nothing reads it. A
        // dangling link is expected and fine here: the target file only appears
        // when a box is created.
        `for l in "${BOX_HOME}/.claude/.credentials.json" "${BOX_HOME}/.codex/auth.json" \
  "${BOX_HOME}/.local/share/opencode/auth.json" "${BOX_HOME}/.claude.json"; do \
  test -L "$l" || { echo "credential pivot missing: $l" >&2; exit 1; }; done`,
        `test -d "${BOX_HOME}/.agentbox-creds/claude"`,
        // The credential seed runs `sudo -u vscode`; without this the seed fails
        // silently-ish at create and boxes start unauthenticated.
        'id vscode >/dev/null',
        `test "$(id -u vscode)" = "$(id -u ${BOX_USER})"`,
        `test -f "${BOX_HOME}/.claude/skills/agentbox-setup/SKILL.md"`,
      ].join('\n'),
    },
  ];
}

export interface PrepareTenkiOptions {
  name?: string;
  hostWorkspace?: string;
  /** Rebake even when a base snapshot is already recorded. */
  force?: boolean;
  /** Tenki base-image id the builder boots from (default: the workspace default). */
  baseImage?: string;
  /** Tenki workspace to build in (defaults to the token's own scope). */
  workspaceId?: string;
  cpuCount?: number;
  memoryMB?: number;
  diskSizeGB?: number;
  onLog?: (line: string) => void;
}

export interface PrepareTenkiResult {
  /** The Tenki snapshot id recorded as the base. */
  snapshotName?: string;
}

/**
 * Build a throwaway HOME containing a *shadow* of `~/.codex`: real directories,
 * but every regular file replaced by a symlink to the original.
 *
 * Why: `stageCodexStaticForUpload` runs `rsync -aL` over `~/.codex`, and `-a`
 * implies `-D` (recreate devices and specials). Codex leaves a live Unix socket
 * at `~/.codex/ipc/ipc.sock` whenever it has run, which rsync cannot recreate —
 * it exits 23 ("partial transfer due to error") and the whole staging throws. The
 * upstream exclude list doesn't filter specials, so the built-in vercel and e2b
 * providers fail their entire `prepare` on such a host.
 *
 * The shadow skips anything that isn't a directory or regular file, so the socket
 * simply isn't there to trip over. Symlinks (rather than copies) mean no user data
 * is duplicated on disk — `rsync -L` reads through them to the originals. We also
 * omit `auth.json`: the helper excludes it from the tarball anyway, and this way
 * the token never lands in a temp directory at all.
 *
 * Returns null when there is no `~/.codex` to shadow — the caller then stages
 * normally and the helper reports "nothing to stage".
 */
export function shadowCodexHome(hostHome: string): { home: string; cleanup: () => void } | null {
  const source = join(hostHome, '.codex');
  try {
    if (!lstatSync(source).isDirectory()) return null;
  } catch {
    return null;
  }

  const root = mkdtempSync(join(tmpdir(), 'agentbox-tenki-codex-shadow-'));
  const mirror = (from: string, to: string, depth: number): void => {
    // Depth cap purely as a loop guard: a symlinked directory cycle would
    // otherwise recurse forever.
    if (depth > 12) return;
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      // Never let the credential file into the temp tree.
      if (entry.name === 'auth.json') continue;
      const src = join(from, entry.name);
      const dest = join(to, entry.name);
      let stat;
      try {
        // statSync FOLLOWS symlinks, which is what we want: a symlinked config
        // directory gets recursed into (so a socket nested under it is still
        // dropped), a symlinked file gets shadowed, and a dangling link throws
        // here and is skipped.
        stat = statSync(src);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        mirror(src, dest, depth + 1);
      } else if (stat.isFile()) {
        try {
          symlinkSync(src, dest);
        } catch {
          // A name collision or unsupported target is not worth failing over.
        }
      }
      // Sockets, FIFOs and devices are deliberately dropped — see above.
    }
  };

  try {
    mirror(source, join(root, '.codex'), 0);
  } catch {
    rmSync(root, { recursive: true, force: true });
    return null;
  }
  return { home: root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Bake the host's STATIC agent config into the snapshot — settings, MCP servers,
 * plugin registries, history, and `/workspace` pre-trust — so a box starts with
 * the user's own setup instead of a blank one. This is what the built-in vercel
 * and e2b providers do at bake time, via the same three SDK helpers.
 *
 * Note what these deliberately do NOT carry: `stageClaudeStaticForUpload`
 * excludes `.credentials.json` and the opencode variant excludes `auth.json`.
 * Credentials are seeded per-box at CREATE time by the cloud scaffold (into the
 * `~/.agentbox-creds/<agent>/` layout the `agent-dirs` step bakes), which keeps
 * auth tokens out of a snapshot that may be shared or long-lived.
 *
 * Best-effort by design: a user with no host agent config, or one whose tarball
 * fails to extract, should still get a working base image.
 */
async function bakeAgentStaticConfig(
  handle: CloudHandle,
  hostWorkspace: string | undefined,
  progress: (s: string) => void,
): Promise<void> {
  progress('staging host agent static config');
  const stagings: { kind: string; tar: StageResult; dest: string }[] = [];

  try {
    // One call per bake, not one per hardcoded agent. `stageAllAgentStatic`
    // walks the host's agent registry, so an agent added after this provider
    // shipped (pi, or anything from `agentbox agent add`) is baked in too --
    // where naming three agents silently produced a snapshot missing it. It
    // also owns the per-agent quirks that used to live here: claude's host-path
    // hook filtering and codex's config.toml sanitizing, which is why the local
    // shadow-HOME dance is gone.
    //
    // Still best-effort: these shell out to rsync over the user's real home, so
    // one unreadable dotfile makes rsync exit 23 and throw. That must not take
    // the whole base image down.
    let stages: AgentStaticStage[] = [];
    try {
      stages = await stageAllAgentStatic(hostWorkspace ? { hostWorkspace } : {});
    } catch (err) {
      const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
      progress(`WARNING: could not stage host agent config (${detail}) -- continuing without it`);
    }

    for (const st of stages) {
      for (const w of st.staged.warnings) progress(w);
      // `extractDir` comes from the agent's own registry row, so the
      // producer -> box-path mapping is no longer duplicated here.
      if (st.staged.tarballPath) {
        stagings.push({ kind: st.kind, tar: st.staged, dest: st.extractDir });
      } else {
        await st.staged.cleanup();
      }
    }

    if (stagings.length === 0) {
      progress('no host agent config to bake (boxes will start unconfigured)');
      return;
    }

    for (const st of stagings) {
      const remote = `/tmp/agentbox-${st.kind}-static.tar.gz`;
      progress(`baking ${st.kind} static config`);
      try {
        await tenkiBackend.uploadFile(handle, st.tar.tarballPath as string, remote);
        // Extract as the box user (no `root`) so files end up owned by it.
        // --no-same-owner/-permissions because the tarball carries host uids.
        const extract = [
          'set -euo pipefail',
          `mkdir -p "${st.dest}"`,
          `tar -xzf "${remote}" -C "${st.dest}" --no-same-permissions --no-same-owner -m`,
          `rm -f "${remote}"`,
        ].join('\n');
        const r = await tenkiBackend.exec(handle, extract, { attemptTimeoutMs: 300_000 });
        if (r.exitCode !== 0) {
          progress(
            `WARNING: ${st.kind} static config did not extract (exit ${String(r.exitCode)}) — continuing`,
          );
        }
      } catch (err) {
        // Same reasoning as staging: a usable base image without one agent's
        // settings beats no base image at all.
        progress(
          `WARNING: ${st.kind} static config failed to bake (${err instanceof Error ? err.message.split('\n')[0] : String(err)}) — continuing`,
        );
      }
    }
  } finally {
    for (const st of stagings) await st.tar.cleanup();
  }
}

/**
 * True when the snapshot id still resolves in the workspace the current token
 * points at. A lookup failure of any kind counts as "gone": re-baking is safe
 * and self-correcting, whereas trusting a dead pin breaks the next `create`.
 */
async function snapshotExists(snapshotId: string): Promise<boolean> {
  try {
    const snap = await getTenkiClient().getSnapshot(snapshotId);
    return snap.state === undefined || snap.state === 'READY';
  } catch {
    return false;
  }
}

/** Timestamped label for the base snapshot. Ids are what we boot from; this is for humans. */
function snapshotLabel(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  return `agentbox-base-${stamp}`.toLowerCase();
}

export async function prepareTenki(opts: PrepareTenkiOptions = {}): Promise<PrepareTenkiResult> {
  await ensureTenkiCredentials();
  resolveAuthToken(); // fail loud before any RPC if creds are missing
  const client = getTenkiClient();
  const log = opts.onLog ?? ((): void => {});
  const progress = (s: string): void => log(`prepare-tenki: ${s}`);

  const existing = readPreparedState();
  if (!opts.force && existing.base) {
    // Confirm the recorded snapshot still EXISTS before skipping. The pin lives
    // on the host but snapshots live in a Tenki workspace, so it goes stale two
    // ways: the snapshot is deleted, or the token now points at a different
    // workspace. Skipping blindly would defer the failure to `create`, which
    // surfaces it as an opaque platform error instead of "re-bake your base".
    if (await snapshotExists(existing.base.snapshotId)) {
      progress(
        `base snapshot ${existing.base.snapshotId} already prepared; skipping (pass --force to rebake)`,
      );
      return { snapshotName: existing.base.snapshotId };
    }
    progress(
      `recorded base snapshot ${existing.base.snapshotId} no longer exists in this workspace; re-baking`,
    );
  }

  // Resolve every host asset BEFORE booting a VM: `resolveSharedRuntimeAsset`
  // throws when the CLI has not stamped its runtime dir, and paying for a builder
  // only to fail on the first upload would be waste.
  const assets = PREPARE_ASSETS.map((asset) => ({
    ...asset,
    localPath: resolveSharedRuntimeAsset(asset.shared),
  }));

  const baseImage = opts.baseImage ?? process.env.AGENTBOX_TENKI_BASE_IMAGE;
  const workspaceId = opts.workspaceId ?? process.env.AGENTBOX_TENKI_WORKSPACE_ID;

  progress('booting builder sandbox');
  const builder = await client.create({
    name: 'agentbox-prepare',
    ...(baseImage ? { image: baseImage } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    cpuCores: opts.cpuCount ?? BUILDER_CPU,
    memoryMb: opts.memoryMB ?? BUILDER_MEMORY_MB,
    diskSizeGb: opts.diskSizeGB ?? BUILDER_DISK_GB,
    maxDurationMs: BUILDER_MAX_DURATION_MS,
    allowOutbound: true,
    // The builder serves no traffic; it only needs egress for apt and npm.
    allowInbound: false,
    waitReady: true,
    waitTimeoutMs: BUILDER_READY_TIMEOUT_MS,
    // Marker so `list`/prune can tell an in-flight bake from a real box.
    metadata: { agentbox: 'true', 'agentbox.role': 'prepare' },
  });
  const handle: CloudHandle = { sandboxId: builder.id };
  progress(`builder ${builder.id} ready`);

  try {
    progress(`uploading ${String(assets.length)} runtime assets`);
    for (const asset of assets) {
      await tenkiBackend.uploadFile(handle, asset.localPath, stagedAssetPath(asset.shared));
    }

    const plan = buildInstallPlan();
    for (const [index, step] of plan.entries()) {
      progress(`[${String(index + 1)}/${String(plan.length)}] ${step.name}`);
      const result = await tenkiBackend.exec(handle, step.command, {
        ...(step.root ? { user: 'root' as const } : {}),
        ...(step.timeoutMs ? { attemptTimeoutMs: step.timeoutMs } : {}),
      });
      if (result.exitCode !== 0) {
        // Surface the step name and the tail of stderr: the whole point of
        // discrete steps is knowing which one broke.
        const detail = (result.stderr || result.stdout || '')
          .trim()
          .split('\n')
          .slice(-12)
          .join('\n');
        throw new UserFacingError(
          `tenki prepare: step '${step.name}' failed (exit ${String(result.exitCode)})` +
            (detail ? `:\n${detail}` : ''),
        );
      }
    }

    await bakeAgentStaticConfig(handle, opts.hostWorkspace, progress);

    progress('snapshotting the builder (this takes a minute)');
    const label = snapshotLabel();
    const snapshot = await client.createSnapshotAndWait(builder.id, { name: label });

    const cliStamp = readCliStamp();
    writePreparedState({
      schema: 2,
      base: {
        snapshotId: snapshot.id,
        snapshotName: label,
        cliVersion: cliStamp.cliVersion,
        cliCommit: cliStamp.cliCommit,
        createdAt: new Date().toISOString(),
      },
    });
    progress(`wrote ${preparedStatePath()}`);
    progress(`prepare complete — base snapshot ${snapshot.id}`);
    return { snapshotName: snapshot.id };
  } finally {
    // Always tear the builder down: it is billable and serves no purpose once
    // snapshotted. A cleanup failure must not mask a build error, but it does
    // need to be visible, or a leaked VM runs until its deadline.
    try {
      const session = await client.get(builder.id);
      await session.close();
      progress(`builder ${builder.id} destroyed`);
    } catch (err) {
      progress(
        `WARNING: could not destroy builder ${builder.id} — terminate it manually: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}

/** Provider-level binding used by the CLI's `prepare` command. */
export const prepareTenkiProvider: NonNullable<Provider['prepare']> = (req) =>
  prepareTenki({
    name: req.name,
    hostWorkspace: req.hostWorkspace ?? process.cwd(),
    force: req.force,
    // `--size` sizes the BOX at create time (the backend applies cpu/memory/disk
    // per session), so it deliberately does not size the builder here.
    onLog: req.onLog,
  });
