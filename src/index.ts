/**
 * @luxorlabs/agentbox-provider-tenki — the Tenki provider plugin for AgentBox.
 *
 * A thin `CloudBackend` over the `@tenkicloud/sandbox` SDK, wrapped by the
 * provider SDK's `createCloudProvider` — which supplies the whole
 * provider-agnostic lifecycle (workspace seeding, ctl launch, relay wiring,
 * preview URLs, cp) — and surfaced to AgentBox as a single `providerModule`.
 */

import {
  createCloudProvider,
  SDK_API_VERSION,
  type CheckResult,
  type CloudBackend,
  type CloudHandle,
  type PrepareResult,
  type Provider,
  type ProviderModule,
} from '@madarco/agentbox-provider-sdk';

/** The AgentBox provider name. `agentbox create --provider tenki` matches on this exactly. */
export const PROVIDER_NAME = 'tenki';

const NOT_IMPLEMENTED = 'the tenki provider is not implemented yet';

const tenkiBackend: CloudBackend = {
  name: PROVIDER_NAME,
  async provision() {
    throw new Error(NOT_IMPLEMENTED);
  },
  async get(): Promise<CloudHandle | null> {
    return null;
  },
  async start() {},
  async stop() {},
  async pause() {},
  async resume() {},
  async destroy() {},
  async state() {
    return 'missing';
  },
  async exec() {
    return { exitCode: 1, stdout: '', stderr: NOT_IMPLEMENTED };
  },
  async uploadFile() {},
  async downloadFile() {},
  async listFiles() {
    return [];
  },
  async previewUrl(_handle, port) {
    return { url: `https://tenki.invalid:${String(port)}` };
  },
};

/**
 * Tenki sizing: 2 vCPU / 4 GB / 8 GB disk, matching the resources the base
 * template is built with so a per-box create doesn't fight the template.
 */
const cloudProvider = createCloudProvider(tenkiBackend, {
  defaultResources: { cpu: 2, memory: 4, disk: 8 },
});

/**
 * Tenki boots a session from a registry image ref or a snapshot id — it does not
 * pull an arbitrary external OCI ref at create time. So the provider overrides
 * `prepare` to get the AgentBox runtime image published into the user's own
 * Tenki workspace, and records the resolved ref locally.
 *
 * `buildAttach` and `checkpoint` are deliberately NOT overridden here: the SDK's
 * cloud scaffold supplies both.
 */
const tenkiProvider: Provider = {
  ...cloudProvider,
  prepare(): Promise<PrepareResult> {
    return Promise.reject(new Error(NOT_IMPLEMENTED));
  },
};

async function doctorChecks(): Promise<CheckResult[]> {
  return [
    { label: 'sdk', status: 'ok', detail: `built on provider-sdk v${String(SDK_API_VERSION)}` },
    { label: 'backend', status: 'warn', detail: NOT_IMPLEMENTED },
  ];
}

/** The uniform surface AgentBox's provider loader resolves this package through. */
export const providerModule: ProviderModule = {
  provider: tenkiProvider,
  backend: tenkiBackend,
  readCredStatus: () => ({ configured: false, label: 'none' }),
  doctorChecks,
};

export { SDK_API_VERSION };
