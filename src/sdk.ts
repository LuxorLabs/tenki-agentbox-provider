/**
 * Thin wrapper around the `@tenkicloud/sandbox` SDK. Resolves the auth token
 * once and re-exports the SDK surface the rest of the package uses from a
 * single place (so tests can mock `./sdk.js` instead of the package).
 *
 * Tenki authenticates with a single workspace auth token (`tk_…`). The SDK
 * reads `TENKI_AUTH_TOKEN` from `process.env`, but we still expose
 * `resolveAuthToken()` so callers can fail loud with an actionable error
 * before the SDK throws a generic "missing auth token" deep inside an op, and
 * `getTenkiClient()` so the optional `TENKI_BASE_URL` / `TENKI_GATEWAY_ADDRESS`
 * overrides (self-hosted / staging control planes) are wired consistently.
 */

import { TenkiSandbox } from '@tenkicloud/sandbox';
import type { ClientOptions } from '@tenkicloud/sandbox';
import { UserFacingError } from '@madarco/agentbox-provider-sdk';
import { ensureTenkiEnvLoaded } from './env-loader.js';

export { TenkiSandbox };
// The template API is deliberately unused: `prepare` bakes its base from a
// builder sandbox instead (see the header of ./prepare.ts for why). The
// `Template*` types below are re-exported for completeness of this seam; no
// `TemplateSpec` value export, so nothing suggests a builder that isn't wired up.
export type {
  Session,
  ClientOptions,
  CreateOptions,
  ExposedPort,
  FileInfo,
  Identity,
  RegistryPublishResult,
  ResolvedRegistryRef,
  Snapshot,
  SnapshotState,
  SessionState,
  Template,
  TemplateBuild,
  TemplateBuildEvent,
  TemplateImage,
} from '@tenkicloud/sandbox';
export {
  SandboxError,
  MissingAuthTokenError,
  SessionNotFoundError,
  SessionTerminatedError,
  SessionExpiredError,
  SnapshotNotFoundError,
  SnapshotFailedError,
  UnauthorizedError,
  PermissionDeniedError,
  QuotaExceededError,
  CapacityUnavailableError,
  RateLimitedError,
  InvalidStateError,
  FileNotFoundError,
} from '@tenkicloud/sandbox';

/**
 * Return the configured Tenki auth token. Throws an actionable error when
 * nothing is configured. Idempotent — env-loader caches itself after the
 * first call.
 */
export function resolveAuthToken(): string {
  ensureTenkiEnvLoaded();
  const t = process.env.TENKI_AUTH_TOKEN;
  if (!t) {
    // UserFacingError (not a plain Error): AgentBox prints these as a clean
    // message, where anything else also dumps a stack trace at the user.
    throw new UserFacingError(
      'Tenki credentials not configured.\n' +
        'Set TENKI_AUTH_TOKEN (your auth token from https://tenki.cloud) in the environment ' +
        'or in ~/.agentbox/secrets.env. Running `agentbox create --provider tenki` on a ' +
        'terminal also prompts for it.',
    );
  }
  return t;
}

/** True when an auth token is configured. Used by the credential gate. */
export function hasUsableCredentials(): boolean {
  ensureTenkiEnvLoaded();
  return Boolean(process.env.TENKI_AUTH_TOKEN);
}

/**
 * Construct a `TenkiSandbox` client wired to the configured credentials and
 * any control-plane overrides. Each call returns a fresh client — the CLI is a
 * short-lived process per command, so we don't bother caching one.
 */
export function getTenkiClient(): TenkiSandbox {
  const opts: ClientOptions = { authToken: resolveAuthToken() };
  const baseUrl = process.env.TENKI_BASE_URL;
  if (baseUrl) opts.baseUrl = baseUrl;
  const gatewayAddress = process.env.TENKI_GATEWAY_ADDRESS;
  if (gatewayAddress) opts.gatewayAddress = gatewayAddress;
  return new TenkiSandbox(opts);
}
