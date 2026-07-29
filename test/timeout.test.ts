/**
 * The session-lifetime injection in `provider.create`.
 *
 * AgentBox only derives `providerOptions.timeoutMs` for its built-in providers,
 * so a plugin's create request arrives without one. The provider fills it in
 * before delegating to the cloud scaffold — which matters because the scaffold
 * records the value it was GIVEN as `cloud.sessionTimeoutMs`, and the host
 * keepalive loop reads that record to decide when to renew the session.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MAX_DURATION_MS } from '../src/backend.js';

/** Capture what the provider hands the scaffold, without provisioning anything. */
async function capturedTimeout(
  req: Record<string, unknown>,
  env?: string,
): Promise<number | undefined> {
  vi.resetModules();
  let seen: Record<string, unknown> | undefined;
  vi.doMock('@madarco/agentbox-provider-sdk', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@madarco/agentbox-provider-sdk')>();
    return {
      ...actual,
      createCloudProvider: () => ({
        name: 'tenki',
        create: (r: Record<string, unknown>) => {
          seen = r;
          return Promise.resolve({});
        },
      }),
    };
  });

  if (env === undefined) delete process.env.AGENTBOX_TENKI_TIMEOUT_MS;
  else process.env.AGENTBOX_TENKI_TIMEOUT_MS = env;

  const { tenkiProvider } = await import('../src/index.js');
  await tenkiProvider.create(req as never);

  const opts = seen?.['providerOptions'] as Record<string, unknown> | undefined;
  return opts?.['timeoutMs'] as number | undefined;
}

beforeEach(() => {
  delete process.env.AGENTBOX_TENKI_TIMEOUT_MS;
});

afterEach(() => {
  delete process.env.AGENTBOX_TENKI_TIMEOUT_MS;
  vi.doUnmock('@madarco/agentbox-provider-sdk');
  vi.resetModules();
});

describe('provider.create session lifetime', () => {
  it('defaults when neither the request nor the environment sets one', async () => {
    expect(await capturedTimeout({ name: 'box' })).toBe(DEFAULT_MAX_DURATION_MS);
  });

  it('uses AGENTBOX_TENKI_TIMEOUT_MS when set', async () => {
    expect(await capturedTimeout({ name: 'box' }, '900000')).toBe(900_000);
  });

  it('prefers an explicit request value over the environment', async () => {
    const got = await capturedTimeout(
      { name: 'box', providerOptions: { timeoutMs: 123_000 } },
      '900000',
    );
    expect(got).toBe(123_000);
  });

  it('ignores a non-numeric or non-positive environment value', async () => {
    expect(await capturedTimeout({ name: 'box' }, 'not-a-number')).toBe(DEFAULT_MAX_DURATION_MS);
    expect(await capturedTimeout({ name: 'box' }, '0')).toBe(DEFAULT_MAX_DURATION_MS);
    expect(await capturedTimeout({ name: 'box' }, '-5')).toBe(DEFAULT_MAX_DURATION_MS);
  });

  it('preserves the rest of providerOptions', async () => {
    vi.resetModules();
    let seen: Record<string, unknown> | undefined;
    vi.doMock('@madarco/agentbox-provider-sdk', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@madarco/agentbox-provider-sdk')>();
      return {
        ...actual,
        createCloudProvider: () => ({
          name: 'tenki',
          create: (r: Record<string, unknown>) => {
            seen = r;
            return Promise.resolve({});
          },
        }),
      };
    });
    const { tenkiProvider } = await import('../src/index.js');
    await tenkiProvider.create({ name: 'box', providerOptions: { size: '4-8' } } as never);
    expect(seen?.['providerOptions']).toEqual({ size: '4-8', timeoutMs: DEFAULT_MAX_DURATION_MS });
  });
});
