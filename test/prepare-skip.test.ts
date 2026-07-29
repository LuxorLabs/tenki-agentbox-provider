/**
 * `prepare`'s skip-fast path.
 *
 * The recorded base pin lives on the HOST but the snapshot lives in a Tenki
 * WORKSPACE, so the two drift apart in normal use: the snapshot gets deleted, or
 * the token starts pointing at a different workspace. Skipping on the strength of
 * the local record alone defers the failure to `create`, which reports it as an
 * opaque platform error rather than "re-bake your base" — so the skip must
 * confirm the snapshot still exists.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

interface Recorded {
  createCalls: number;
  getSnapshotCalls: string[];
  wrote: { base?: { snapshotId: string } }[];
  closed: number;
}

const BASE = {
  snapshotId: 'snap-recorded-1',
  snapshotName: 'agentbox-base-old',
  createdAt: '2026-07-01T00:00:00.000Z',
};

/** Drive prepareTenki against a faked control plane. No network, no VM. */
async function runPrepare(args: {
  snapshotExists: boolean;
  force?: boolean;
  base?: typeof BASE;
}): Promise<{ result: { snapshotName?: string }; rec: Recorded }> {
  vi.resetModules();
  const rec: Recorded = { createCalls: 0, getSnapshotCalls: [], wrote: [], closed: 0 };

  const fakeClient = {
    getSnapshot: (id: string) => {
      rec.getSnapshotCalls.push(id);
      if (!args.snapshotExists) return Promise.reject(new Error('snapshot not found'));
      return Promise.resolve({ id, state: 'READY' });
    },
    create: () => {
      rec.createCalls += 1;
      return Promise.resolve({ id: 'builder-session', state: 'RUNNING' });
    },
    createSnapshotAndWait: () => Promise.resolve({ id: 'snap-freshly-baked' }),
    get: () =>
      Promise.resolve({
        close: () => {
          rec.closed += 1;
          return Promise.resolve();
        },
      }),
  };

  vi.doMock('../src/credentials.js', () => ({ ensureTenkiCredentials: () => Promise.resolve() }));
  vi.doMock('../src/sdk.js', () => ({
    resolveAuthToken: () => 'tk_test',
    getTenkiClient: () => fakeClient,
  }));
  vi.doMock('../src/prepared-state.js', () => ({
    readPreparedState: () => ({ schema: 2, base: args.base ?? BASE }),
    writePreparedState: (s: { base?: { snapshotId: string } }) => rec.wrote.push(s),
    preparedStatePath: () => '/tmp/tenki-prepared-test.json',
  }));
  vi.doMock('../src/backend.js', () => ({
    DEFAULT_MAX_DURATION_MS: 2_700_000,
    tenkiBackend: {
      uploadFile: () => Promise.resolve(),
      exec: () => Promise.resolve({ exitCode: 0, stdout: '', stderr: '' }),
    },
  }));
  // Host assets don't exist in the test env; the CLI-staged runtime dir is only
  // present when running under the real CLI.
  vi.doMock('@madarco/agentbox-provider-sdk', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@madarco/agentbox-provider-sdk')>();
    const noStage = () =>
      Promise.resolve({ tarballPath: null, warnings: [], cleanup: () => Promise.resolve() });
    return {
      ...actual,
      resolveSharedRuntimeAsset: (name: string) => `/tmp/fake-asset-${name}`,
      // The real helpers rsync the developer's actual ~/.claude, ~/.codex and
      // ~/.config/opencode. A unit test must not read the host's home (nor be at
      // the mercy of one unreadable file there), so stage nothing.
      stageClaudeStaticForUpload: noStage,
      stageCodexStaticForUpload: noStage,
      stageOpencodeStaticForUpload: noStage,
    };
  });

  const { prepareTenki } = await import('../src/prepare.js');
  const result = await prepareTenki({ force: args.force });
  return { result, rec };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('../src/credentials.js');
  vi.doUnmock('../src/sdk.js');
  vi.doUnmock('../src/prepared-state.js');
  vi.doUnmock('../src/backend.js');
  vi.doUnmock('@madarco/agentbox-provider-sdk');
});

describe('prepareTenki skip-fast', () => {
  it('skips the bake when the recorded snapshot still exists', async () => {
    const { result, rec } = await runPrepare({ snapshotExists: true });
    expect(rec.getSnapshotCalls).toEqual([BASE.snapshotId]);
    expect(rec.createCalls).toBe(0); // no builder booted
    expect(rec.wrote).toHaveLength(0); // pin left alone
    expect(result.snapshotName).toBe(BASE.snapshotId);
  });

  it('re-bakes when the recorded snapshot is gone', async () => {
    // The regression this guards: without the existence check the stale pin was
    // returned as good, and `create` then failed on a snapshot that isn't there.
    const { result, rec } = await runPrepare({ snapshotExists: false });
    expect(rec.getSnapshotCalls).toEqual([BASE.snapshotId]);
    expect(rec.createCalls).toBe(1); // builder booted
    expect(result.snapshotName).toBe('snap-freshly-baked');
    expect(rec.wrote.at(-1)?.base?.snapshotId).toBe('snap-freshly-baked');
  });

  it('re-bakes on --force without even checking', async () => {
    const { result, rec } = await runPrepare({ snapshotExists: true, force: true });
    expect(rec.getSnapshotCalls).toEqual([]);
    expect(rec.createCalls).toBe(1);
    expect(result.snapshotName).toBe('snap-freshly-baked');
  });

  it('always tears the builder down', async () => {
    // A leaked builder is billable and serves no purpose after the snapshot.
    const { rec } = await runPrepare({ snapshotExists: false });
    expect(rec.closed).toBe(1);
  });
});
