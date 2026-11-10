/**
 * Tenki env auto-loader. The `@tenkicloud/sandbox` SDK reads `TENKI_AUTH_TOKEN`
 * from `process.env` (and we honor optional `TENKI_API_URL` /
 * `TENKI_SANDBOX_GATEWAY_URL` overrides for non-default / self-hosted control
 * planes). We seed those from `~/.agentbox/secrets.env` — the store AgentBox's
 * built-in cloud providers use — so the SDK Just Works after a one-time setup.
 *
 * Lookup order (first wins; process.env is never overwritten):
 *   1. `process.env` (already set in the shell).
 *   2. `~/.agentbox/secrets.env` — written by the credential prompt.
 *
 * `TENKI_API_KEY` (the name the SDK also reads) and `TENKI_API_TOKEN` are
 * accepted as aliases for `TENKI_AUTH_TOKEN`. Every key
 * also has a `LUXORAI_*` equivalent that wins over all `TENKI_*` keys; read them
 * through `readTenkiEnv` rather than `process.env`.
 *
 * Project-level `.env` / `.env.local` are intentionally NOT consulted: those
 * files belong to the app code being developed. Put host credentials in
 * `~/.agentbox/secrets.env` (or the shell env).
 *
 * Only TENKI- and LUXORAI-prefixed keys are imported; the rest of the file is left alone.
 * Idempotent and side-effect-free after the first call.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

const ENV_SUFFIXES = [
  'AUTH_TOKEN',
  'API_KEY',
  'API_TOKEN',
  'API_ENDPOINT',
  'API_URL',
  'BASE_URL',
  'SANDBOX_GATEWAY_URL',
  'GATEWAY_ADDRESS',
] as const;
const TENKI_KEYS = [
  ...ENV_SUFFIXES.map((s) => `LUXORAI_${s}`),
  ...ENV_SUFFIXES.map((s) => `TENKI_${s}`),
];

/** Every `LUXORAI_<suffix>` is tried (in order) before any legacy `TENKI_<suffix>`. */
export function readTenkiEnv(...suffixes: string[]): string | undefined {
  for (const prefix of ['LUXORAI_', 'TENKI_']) {
    for (const suffix of suffixes) {
      const value = process.env[`${prefix}${suffix}`];
      if (value) return value;
    }
  }
  return undefined;
}

/** `AGENTBOX_LUXORAI_<suffix>`, falling back to the legacy `AGENTBOX_TENKI_<suffix>`. */
export function readAgentboxEnv(suffix: string): string | undefined {
  return (
    process.env[`AGENTBOX_LUXORAI_${suffix}`]?.trim() ||
    process.env[`AGENTBOX_TENKI_${suffix}`]?.trim() ||
    undefined
  );
}

/** The configured auth token: `LUXORAI_{AUTH_TOKEN,API_KEY,API_TOKEN}` > `TENKI_{AUTH_TOKEN,API_KEY,API_TOKEN}`. */
export function readTenkiAuthToken(): string | undefined {
  return readTenkiEnv('AUTH_TOKEN', 'API_KEY', 'API_TOKEN');
}

/** Control-plane URL: the SDK's `*_API_ENDPOINT` / `*_API_URL`, then the legacy `*_BASE_URL`. */
export function readTenkiBaseUrl(): string | undefined {
  return readTenkiEnv('API_ENDPOINT', 'API_URL', 'BASE_URL');
}

/** SSH gateway: the SDK's `*_SANDBOX_GATEWAY_URL`, then the legacy `*_GATEWAY_ADDRESS`. */
export function readTenkiGatewayAddress(): string | undefined {
  return readTenkiEnv('SANDBOX_GATEWAY_URL', 'GATEWAY_ADDRESS');
}

let loaded = false;

export function ensureTenkiEnvLoaded(): void {
  if (loaded) return;
  loaded = true;
  importTenkiFromFile(resolve(homedir(), '.agentbox', 'secrets.env'), TENKI_KEYS);
  // `TENKI_AUTH_TOKEN` is the name the Tenki SDK reads and the one we write.
  // `TENKI_API_TOKEN` is accepted as an alias because it's the more common
  // spelling to reach for; normalize it once here so nothing downstream has to
  // know about two names.
  if (!process.env.TENKI_AUTH_TOKEN && process.env.TENKI_API_TOKEN) {
    process.env.TENKI_AUTH_TOKEN = process.env.TENKI_API_TOKEN;
  }
}

/**
 * Force a re-read of `~/.agentbox/secrets.env`. Used by the interactive
 * credential flow after it persists the token, so the same process can pick it
 * up without a restart.
 */
export function reloadTenkiEnv(): void {
  loaded = false;
  ensureTenkiEnvLoaded();
}

function importTenkiFromFile(path: string, keys: readonly string[]): void {
  if (!existsSync(path)) return;
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnvFile(body);
  for (const key of keys) {
    if (process.env[key] !== undefined) continue;
    const value = parsed[key];
    if (typeof value === 'string') {
      process.env[key] = value;
    }
  }
}

/**
 * Minimal `.env` parser: handles `KEY=value`, `KEY="value"`, `KEY='value'`,
 * `export KEY=value`, blank lines, and `#` comments. No variable interpolation
 * — predictable over feature-complete (matches the daytona / vercel / e2b
 * loaders).
 */
export function parseEnvFile(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
    const eq = stripped.indexOf('=');
    if (eq <= 0) continue;
    const key = stripped.slice(0, eq).trim();
    let value = stripped.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
