/**
 * Doctor probes + normalized credential status, assembled into `providerModule`
 * in `index.ts`. AgentBox dispatches to these generically (see the provider
 * SDK's `ProviderModule`), so `agentbox doctor` renders a `tenki:` group with the
 * same shape as the built-in providers.
 *
 * These checks are also the provider's ONLY credential-status surface. A plugin
 * cannot register a top-level command, so there is no `agentbox tenki login
 * --status` to run — the masked token and its source are reported here instead.
 */

import {
  errSummary,
  type CheckResult,
  type CredStatusSummary,
} from '@madarco/agentbox-provider-sdk';
import { maskKey, readTenkiCredStatus, secretsPath } from './credentials.js';
import { readPreparedState } from './prepared-state.js';

export function readCredStatusSummary(): CredStatusSummary {
  const cred = readTenkiCredStatus();
  return { configured: cred.auth !== 'none', label: cred.auth };
}

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const cred = readTenkiCredStatus();
    const credRes: CheckResult =
      cred.auth === 'none'
        ? {
            label: 'credentials',
            status: 'warn',
            detail: 'not configured',
            // No `tenki login` command exists for a plugin provider: point at
            // the two places the token is actually read from. An interactive
            // `create` also prompts for it.
            hint: `set TENKI_AUTH_TOKEN in the environment or in ${secretsPath()}`,
          }
        : {
            label: 'credentials',
            status: 'ok',
            detail: `${cred.token ? maskKey(cred.token) : 'token'} (${cred.source})`,
          };

    const prepared = readPreparedState();
    const baseRes: CheckResult = prepared.base?.snapshotId
      ? {
          label: 'base image',
          status: 'ok',
          // Snapshot ids are long opaque UUIDs; show a short prefix plus the CLI
          // version that baked it, which is what actually tells you if it's stale.
          detail: `${prepared.base.snapshotId.slice(0, 18)}… (${prepared.base.cliVersion ?? '—'})`,
        }
      : {
          label: 'base image',
          status: 'warn',
          detail: 'not prepared',
          hint: '`agentbox prepare --provider tenki`',
        };
    return [credRes, baseRes];
  } catch (err) {
    return [{ label: 'credentials', status: 'warn', detail: errSummary(err) }];
  }
}
