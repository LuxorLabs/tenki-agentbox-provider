/**
 * Preview-share selection.
 *
 * Tenki mints two kinds of share for a port and they are mutually exclusive: the
 * API rejects `slug` + `ttlMs` together, so a share either carries our stable
 * slug and never expires, or it carries a server-assigned URL and an
 * `expiresAt`. The three preview methods each want a specific kind, and the
 * regression these tests pin down is what happens when the OTHER kind is holding
 * the port:
 *
 *   - `signedPreviewUrl` must not answer a request for an expiring URL with the
 *     permanent public one (the caller believes the exposure lapses; it doesn't).
 *   - `previewUrl` must not answer with an expiring share (it dies under the
 *     scaffold's cache).
 *   - `refreshPreviewUrl` must not promote an expiring share into a permanent
 *     public one — a refresh may re-mint, but never widen exposure.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { findExpiringShare, findPermanentShare } from '../src/backend.js';

const PORT = 8080;
const SESSION = 'sess_AbC123XyZ789';

const permanent = { port: PORT, previewUrl: 'https://permanent.example', slug: 'ab-x-8080' };
const expiringIn = (ms: number) => ({
  port: PORT,
  previewUrl: 'https://expiring.example',
  expiresAt: new Date(Date.now() + ms),
});

describe('findPermanentShare', () => {
  it('finds the share with no expiry', () => {
    expect(findPermanentShare([permanent], PORT)).toBe(permanent);
  });

  it('ignores an expiring share', () => {
    expect(findPermanentShare([expiringIn(600_000)], PORT)).toBeUndefined();
  });

  it('ignores another port', () => {
    expect(findPermanentShare([{ ...permanent, port: 3000 }], PORT)).toBeUndefined();
  });

  it('picks the permanent one even when an expiring share is listed first', () => {
    expect(findPermanentShare([expiringIn(600_000), permanent], PORT)).toBe(permanent);
  });
});

describe('findExpiringShare', () => {
  const now = Date.now();

  it('accepts an expiring share with more life than requested', () => {
    const share = expiringIn(600_000);
    expect(findExpiringShare([share], PORT, 60_000, now)).toBe(share);
  });

  it('rejects one that expires sooner than requested', () => {
    expect(findExpiringShare([expiringIn(30_000)], PORT, 60_000, now)).toBeUndefined();
  });

  it('rejects one that has already expired', () => {
    expect(findExpiringShare([expiringIn(-1_000)], PORT, 1_000, now)).toBeUndefined();
  });

  it('never returns the permanent share, however long the window', () => {
    expect(findExpiringShare([permanent], PORT, 60_000, now)).toBeUndefined();
  });
});

interface Recorded {
  unexposed: number[];
  exposed: { port: number; opts?: { slug?: string; ttlMs?: number } }[];
}

/** Drive one backend method against a fake session holding `shares`. */
async function withShares(
  shares: unknown[],
): Promise<{ backend: typeof import('../src/backend.js').tenkiBackend; rec: Recorded }> {
  vi.resetModules();
  const rec: Recorded = { unexposed: [], exposed: [] };
  const session = {
    id: SESSION,
    state: 'RUNNING',
    listExposedPorts: () => Promise.resolve(shares),
    unexposePort: (port: number) => {
      rec.unexposed.push(port);
      return Promise.resolve();
    },
    exposePort: (port: number, opts?: { slug?: string; ttlMs?: number }) => {
      rec.exposed.push({ port, ...(opts ? { opts } : {}) });
      return Promise.resolve({ port, previewUrl: `https://minted-${String(rec.exposed.length)}` });
    },
  };
  vi.doMock('../src/sdk.js', () => ({
    resolveAuthToken: () => 'tk_test',
    getTenkiClient: () => ({ get: () => Promise.resolve(session) }),
  }));
  const { tenkiBackend } = await import('../src/backend.js');
  return { backend: tenkiBackend, rec };
}

afterEach(() => {
  vi.doUnmock('../src/sdk.js');
  vi.resetModules();
});

describe('previewUrl', () => {
  it('reuses an existing permanent share without touching the port', async () => {
    const { backend, rec } = await withShares([permanent]);
    const got = await backend.previewUrl({ sandboxId: SESSION }, PORT);
    expect(got.url).toBe(permanent.previewUrl);
    expect(rec.exposed).toEqual([]);
    expect(rec.unexposed).toEqual([]);
  });

  it('does not hand back an expiring share — clears the port and mints a stable one', async () => {
    const { backend, rec } = await withShares([expiringIn(600_000)]);
    const got = await backend.previewUrl({ sandboxId: SESSION }, PORT);
    expect(got.url).toBe('https://minted-1');
    expect(rec.unexposed).toEqual([PORT]);
    expect(rec.exposed[0]?.opts?.slug).toBe('ab-abc123xyz789-8080');
    expect(rec.exposed[0]?.opts?.ttlMs).toBeUndefined();
  });

  it('mints without unexposing when the port is free', async () => {
    const { backend, rec } = await withShares([]);
    await backend.previewUrl({ sandboxId: SESSION }, PORT);
    expect(rec.unexposed).toEqual([]);
    expect(rec.exposed).toHaveLength(1);
  });
});

describe('signedPreviewUrl', () => {
  it('reuses an expiring share that covers the requested window', async () => {
    const share = expiringIn(600_000);
    const { backend, rec } = await withShares([share]);
    const got = await backend.signedPreviewUrl?.({ sandboxId: SESSION }, PORT, 60);
    expect(got?.url).toBe(share.previewUrl);
    expect(rec.exposed).toEqual([]);
  });

  it('never returns the permanent public URL for a signed request', async () => {
    // The regression: any share for the port was reused, so a 60-second request
    // was answered with a URL that never expires.
    const { backend, rec } = await withShares([permanent]);
    const got = await backend.signedPreviewUrl?.({ sandboxId: SESSION }, PORT, 60);
    expect(got?.url).not.toBe(permanent.previewUrl);
    expect(got?.url).toBe('https://minted-1');
    expect(rec.unexposed).toEqual([PORT]);
    expect(rec.exposed[0]?.opts?.ttlMs).toBe(60_000);
    expect(rec.exposed[0]?.opts?.slug).toBeUndefined();
  });

  it('re-mints when the existing share expires sooner than requested', async () => {
    const { backend, rec } = await withShares([expiringIn(30_000)]);
    await backend.signedPreviewUrl?.({ sandboxId: SESSION }, PORT, 600);
    expect(rec.unexposed).toEqual([PORT]);
    expect(rec.exposed[0]?.opts?.ttlMs).toBe(600_000);
  });

  it('clamps a non-positive expiry to at least a second', async () => {
    const { backend, rec } = await withShares([]);
    await backend.signedPreviewUrl?.({ sandboxId: SESSION }, PORT, 0);
    expect(rec.exposed[0]?.opts?.ttlMs).toBe(1_000);
  });
});

describe('refreshPreviewUrl', () => {
  it('re-mints a permanent share with the stable slug', async () => {
    const { backend, rec } = await withShares([permanent]);
    await backend.refreshPreviewUrl?.({ sandboxId: SESSION }, PORT);
    expect(rec.unexposed).toEqual([PORT]);
    expect(rec.exposed[0]?.opts?.slug).toBe('ab-abc123xyz789-8080');
    expect(rec.exposed[0]?.opts?.ttlMs).toBeUndefined();
  });

  it('keeps an expiring share expiring instead of promoting it to permanent', async () => {
    // The regression: refresh always re-exposed with the stable slug, turning a
    // short-lived private share into a permanent public URL.
    const { backend, rec } = await withShares([expiringIn(600_000)]);
    await backend.refreshPreviewUrl?.({ sandboxId: SESSION }, PORT);
    expect(rec.exposed[0]?.opts?.slug).toBeUndefined();
    expect(rec.exposed[0]?.opts?.ttlMs).toBeGreaterThanOrEqual(60_000);
  });

  it('floors the replacement window for a share that was already expiring out', async () => {
    const { backend, rec } = await withShares([expiringIn(-5_000)]);
    await backend.refreshPreviewUrl?.({ sandboxId: SESSION }, PORT);
    expect(rec.exposed[0]?.opts?.ttlMs).toBe(60_000);
  });

  it('mints a permanent share when the port held nothing', async () => {
    const { backend, rec } = await withShares([]);
    await backend.refreshPreviewUrl?.({ sandboxId: SESSION }, PORT);
    expect(rec.exposed[0]?.opts?.slug).toBe('ab-abc123xyz789-8080');
  });
});
