/**
 * The Tenki sandbox provider. A thin `CloudBackend` over the
 * `@tenkicloud/sandbox` SDK, composed via the provider SDK's
 * `createCloudProvider` for everything provider-agnostic (workspace seeding,
 * ctl launch, state, relay polling).
 *
 * Three capabilities are overridden on top of the cloud scaffold:
 *   - `prepare`     — bake the AgentBox base snapshot in the Tenki workspace
 *                     (`agentbox prepare --provider tenki`).
 *   - `buildAttach` — host-PTY ↔ `session.ssh()` bridge (no host SSH binary).
 *   - `checkpoint`  — store the Tenki snapshot id in the manifest so restore
 *     boots from it (`createSnapshotAndWait` returns an id-addressed reusable
 *     snapshot, same shape as vercel/e2b).
 *
 * `launchDockerd: false` — Tenki runs Firecracker microVMs; nested-container
 * (DinD) support inside a Tenki VM is not yet verified, so we take the
 * conservative default (matching vercel) and don't auto-start dockerd, which
 * would otherwise log a spurious failure on every create/resume. Flip to true
 * once DinD is confirmed and baked into the base image.
 */

import {
  createCloudProvider,
  currentCloudBaseFingerprint,
  listCloudCheckpoints,
  readCliStamp,
  removeCloudCheckpointDir,
  resolveCloudCheckpoint,
  SDK_API_VERSION,
  writeCloudCheckpointManifest,
  type BoxRecord,
  type CreateBoxRequest,
  type CreatedBox,
  type Provider,
  type ProviderCheckpoint,
  type ProviderModule,
} from '@madarco/agentbox-provider-sdk';
import { DEFAULT_MAX_DURATION_MS, tenkiBackend } from './backend.js';
import { getTenkiClient } from './sdk.js';
import { withTenkiRetry } from './retry.js';
import { prepareTenkiProvider } from './prepare.js';
import { buildTenkiAttach } from './build-attach.js';
import { currentTenkiBaseFingerprintLive } from './prepared-state.js';
import { ensureTenkiCredentials, setTenkiCredentials } from './credentials.js';
import { doctorChecks, readCredStatusSummary } from './provider-module.js';

/** The AgentBox provider name. `agentbox create --provider tenki` matches on this exactly. */
export const PROVIDER_NAME = 'tenki';

const BACKEND_NAME = PROVIDER_NAME;

const cloudProvider = createCloudProvider(tenkiBackend, {
  defaultResources: { cpu: 2, memory: 4, disk: 8 },
  launchDockerd: false,
});

/** Session lifetime override, in ms. Falsy/invalid values fall through to the default. */
function envTimeoutMs(): number | undefined {
  const raw = process.env.AGENTBOX_TENKI_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Resolve the session lifetime and thread it through `providerOptions` before
 * delegating to the scaffold.
 *
 * AgentBox derives `providerOptions.timeoutMs` from a per-provider config key
 * (`box.<provider>TimeoutMs`) that only exists for the built-in providers, so a
 * plugin's create request always arrives without one. Injecting it here — rather
 * than defaulting inside the backend — matters because the scaffold records the
 * value it was GIVEN as `cloud.sessionTimeoutMs`, and the host keepalive loop
 * reads that record to decide when to call `renewTimeout`. Defaulting only in
 * the backend would boot a 45-minute VM while the record claimed no known
 * lifetime, leaving the keepalive to guess.
 */
function createTenkiBox(req: CreateBoxRequest): Promise<CreatedBox> {
  const requested = req.providerOptions?.['timeoutMs'];
  const timeoutMs =
    typeof requested === 'number' && requested > 0
      ? requested
      : (envTimeoutMs() ?? DEFAULT_MAX_DURATION_MS);
  return cloudProvider.create({
    ...req,
    providerOptions: { ...req.providerOptions, timeoutMs },
  });
}

/**
 * Capture a reusable, id-addressed Tenki snapshot from a running session.
 * `createSnapshotAndWait` blocks until the snapshot reaches READY and returns
 * its opaque id, usable later with `createAndWait({ snapshotId })`.
 */
async function createTenkiSnapshot(sessionId: string, name: string): Promise<string> {
  return withTenkiRetry(
    { method: 'createSnapshot', retryOnAmbiguous: false, attemptTimeoutMs: 900_000, backoffMs: [] },
    async () => {
      const snap = await getTenkiClient().createSnapshotAndWait(sessionId, { name });
      return snap.id;
    },
  );
}

/** Delete a snapshot by id. Idempotent — a missing snapshot is success. */
async function deleteTenkiSnapshot(snapshotId: string): Promise<void> {
  await withTenkiRetry({ method: 'deleteSnapshot', retryOnAmbiguous: true }, async () => {
    try {
      await getTenkiClient().deleteSnapshot(snapshotId);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const msg = err instanceof Error ? err.message : String(err);
      if (name === 'SnapshotNotFoundError' || /not.?found|404/i.test(msg)) return; // idempotent
      throw err;
    }
  });
}

/**
 * Build a safe, unique Tenki snapshot label. Snapshots are id-addressed so the
 * name is only a human label, but we stamp a per-create timestamp so the UI
 * shows distinct entries rather than reusing one name.
 */
function snapshotLabel(boxName: string, checkpointName: string): string {
  const sanitize = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  return `agentbox-${sanitize(boxName)}-${sanitize(checkpointName)}-${sanitize(ts)}`;
}

/**
 * Tenki-specific checkpoint capability. We capture the SDK-returned opaque
 * snapshot id and store THAT in the manifest's `snapshotName` field — the cloud
 * create flow passes `manifest.snapshotName` straight to `provision({ snapshot })`,
 * and the Tenki backend boots from it as `createAndWait({ snapshotId })`. (Same
 * id-addressed shape as vercel/e2b.)
 */
const tenkiCheckpoint: ProviderCheckpoint = {
  async create(box: BoxRecord, name: string) {
    if (!box.projectRoot) {
      throw new Error(
        'cloud checkpoint requires the box to have a project root (run `agentbox checkpoint` from inside the project)',
      );
    }
    if (!box.cloud?.sandboxId) {
      throw new Error(`tenki box ${box.name} has no sandboxId — record is malformed`);
    }
    const label = snapshotLabel(box.name, name);
    const snapshotId = await createTenkiSnapshot(box.cloud.sandboxId, label);
    const info = await writeCloudCheckpointManifest(box.projectRoot, BACKEND_NAME, name, {
      snapshotName: snapshotId,
      sourceBoxId: box.id,
      sourceBoxName: box.name,
      baseProvider: BACKEND_NAME,
      baseFingerprint: currentCloudBaseFingerprint(BACKEND_NAME),
      cliVersion: readCliStamp().cliVersion,
    });
    return { ref: info.name };
  },
  async list(projectRoot: string) {
    const entries = await listCloudCheckpoints(projectRoot, BACKEND_NAME);
    return entries.map((e) => ({ ref: e.name, createdAt: e.manifest.createdAt }));
  },
  async remove(projectRoot: string, ref: string) {
    const entry = await resolveCloudCheckpoint(projectRoot, BACKEND_NAME, ref);
    if (!entry) return;
    // Delete the remote snapshot FIRST and only drop the local manifest once it
    // is gone. A missing snapshot is already swallowed as success by
    // deleteTenkiSnapshot (idempotent), and withTenkiRetry has exhausted its
    // transient retries by the time this throws — so a throw is a real,
    // persistent failure. Preserve the manifest and surface it rather than
    // orphaning a billable, quota-limited snapshot the user can no longer
    // reference to retry the delete.
    await deleteTenkiSnapshot(entry.manifest.snapshotName);
    await removeCloudCheckpointDir(projectRoot, BACKEND_NAME, ref);
  },
};

export const tenkiProvider: Provider = {
  ...cloudProvider,
  create: createTenkiBox,
  prepare: prepareTenkiProvider,
  buildAttach: buildTenkiAttach,
  checkpoint: tenkiCheckpoint,
  baseFingerprint: () => currentTenkiBaseFingerprintLive(),
};

/** Uniform surface the CLI provider loader resolves this package through. */
export const providerModule: ProviderModule = {
  provider: tenkiProvider,
  backend: tenkiBackend,
  ensureCredentials: ensureTenkiCredentials,
  readCredStatus: readCredStatusSummary,
  setCredentials: (fields) => Promise.resolve(setTenkiCredentials(fields)),
  currentBaseFingerprintLive: () => currentTenkiBaseFingerprintLive(),
  doctorChecks,
};

export { tenkiBackend };
export { ensureTenkiEnvLoaded, reloadTenkiEnv } from './env-loader.js';
export {
  ensureTenkiCredentials,
  setTenkiCredentials,
  readTenkiCredStatus,
  secretsPath,
  maskKey,
  type EnsureTenkiCredentialsOptions,
  type TenkiCredStatus,
} from './credentials.js';
export {
  prepareTenki,
  prepareTenkiProvider,
  buildInstallPlan,
  shadowCodexHome,
  stagedAssetPath,
  PREPARE_ASSETS,
  type PrepareAsset,
  type PrepareStep,
  type PrepareTenkiOptions,
  type PrepareTenkiResult,
} from './prepare.js';
export {
  currentTenkiBaseFingerprintLive,
  ensureTenkiBaseImage,
  preparedStatePath,
  readPreparedState,
  writePreparedState,
  updatePreparedState,
  type PreparedTenkiState,
  type PreparedTenkiBase,
} from './prepared-state.js';
export { buildTenkiAttach } from './build-attach.js';
// Surfaced so a consumer (and the package-validation script) can assert which
// provider-contract major this build targets without reaching into the SDK.
export { SDK_API_VERSION };
