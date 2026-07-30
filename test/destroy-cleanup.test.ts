/**
 * `destroy` must take the per-box attach key material with it. The keypair is
 * created lazily on first attach and lives under ~/.agentbox/boxes/<id>/ssh/, so
 * without this every box ever created leaves a private key on the host — a slow
 * leak nothing else cleans up, and one only visible by listing that directory.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const roots: string[] = [];

/** Drive backend.destroy with the key dir redirected into a temp HOME. */
async function runDestroy(opts: { sessionGone?: boolean }): Promise<{
  keyDir: string;
  closed: number;
}> {
  vi.resetModules();
  const home = mkdtempSync(join(tmpdir(), 'tenki-destroy-'));
  roots.push(home);
  const keyDir = join(home, 'boxes', 'sess-1', 'ssh');
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(join(keyDir, 'id_ed25519'), 'PRIVATE');

  let closed = 0;
  vi.doMock('../src/build-attach.js', () => ({ sshKeyDir: () => keyDir }));
  vi.doMock('../src/sdk.js', () => ({
    getTenkiClient: () => ({
      get: () => {
        if (opts.sessionGone) {
          const err = new Error('session not found');
          err.name = 'SessionNotFoundError'; // what the SDK raises for a gone session
          return Promise.reject(err);
        }
        return Promise.resolve({
          close: () => {
            closed += 1;
            return Promise.resolve();
          },
        });
      },
    }),
  }));

  const { tenkiBackend } = await import('../src/backend.js');
  await tenkiBackend.destroy({ sandboxId: 'sess-1' });
  return { keyDir, closed };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../src/build-attach.js');
  vi.doUnmock('../src/sdk.js');
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

describe('tenkiBackend.destroy', () => {
  it('removes the per-box ssh key material', async () => {
    const { keyDir, closed } = await runDestroy({});
    expect(closed).toBe(1);
    expect(existsSync(keyDir)).toBe(false);
  });

  it('still removes the keys when the session is already gone', async () => {
    // destroy is idempotent, and a second call is exactly when a stale key dir
    // would otherwise be left forever.
    const { keyDir } = await runDestroy({ sessionGone: true });
    expect(existsSync(keyDir)).toBe(false);
  });
});
