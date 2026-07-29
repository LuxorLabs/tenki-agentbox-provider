/**
 * Atomic writer for the managed keys this provider owns in
 * `~/.agentbox/secrets.env` — the same store AgentBox's built-in cloud providers
 * use, so a Tenki token sits alongside the rest and `agentbox doctor` finds it.
 *
 * The provider SDK does not re-export AgentBox's internal secrets writer, so
 * this is a local implementation of the same contract: strip any prior values
 * for the keys we manage, append the new ones, and write through a temp file +
 * rename at mode 0600 so a concurrent reader never sees a half-written file and
 * the token is never briefly world-readable.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type { CredStatusSummary } from '@madarco/agentbox-provider-sdk';

/**
 * Outcome of a non-interactive credential write. `status` reflects the store
 * *after* the attempt, so a caller can report `configured` without a second read.
 * Mirrors the shape AgentBox's `providerModule.setCredentials` returns.
 */
export interface CredSetResult {
  ok: boolean;
  /** One-line failure reason when `ok` is false (e.g. a rejected token). */
  error?: string;
  status: CredStatusSummary;
}

/** Canonical path of the AgentBox-managed secrets file. */
export function secretsEnvPath(): string {
  return resolve(homedir(), '.agentbox', 'secrets.env');
}

/**
 * Replace `managedKeys` in the secrets file with `record`, leaving every other
 * line untouched. Also updates `process.env` in place so the current process
 * sees the new values without a reload.
 */
export function writeManagedSecrets(
  managedKeys: readonly string[],
  record: Record<string, string>,
): void {
  for (const k of managedKeys) delete process.env[k];
  for (const [k, v] of Object.entries(record)) process.env[k] = v;

  const path = secretsEnvPath();
  mkdirSync(dirname(path), { recursive: true });

  let existing = '';
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf8');
    } catch {
      // An unreadable file is treated as empty rather than fatal: failing here
      // would leave the user unable to save credentials at all.
      existing = '';
    }
  }

  const kept = existing
    .split(/\r?\n/)
    .filter((line) => {
      const stripped = line.startsWith('export ') ? line.slice('export '.length) : line;
      const eq = stripped.indexOf('=');
      if (eq <= 0) return true;
      return !managedKeys.includes(stripped.slice(0, eq).trim());
    })
    .join('\n')
    .replace(/\s+$/u, '');

  const lines = Object.entries(record).map(([k, v]) => `${k}=${v}`);
  const body = (kept ? `${kept}\n` : '') + lines.join('\n') + '\n';

  const tmp = `${path}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best-effort: the writeFileSync mode already covers most filesystems.
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Already attempted on the temp file.
  }
}
