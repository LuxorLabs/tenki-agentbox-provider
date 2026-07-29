import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseEnvFile } from '../src/env-loader.js';

describe('parseEnvFile', () => {
  it('handles bare KEY=value', () => {
    expect(parseEnvFile('TENKI_AUTH_TOKEN=tk_abc')).toEqual({ TENKI_AUTH_TOKEN: 'tk_abc' });
  });

  it('handles double-quoted, single-quoted, and `export`-prefixed forms', () => {
    const body = ['TENKI_AUTH_TOKEN="quoted"', "TENKI_BASE_URL='single'", 'export FOO=bar'].join(
      '\n',
    );
    expect(parseEnvFile(body)).toEqual({
      TENKI_AUTH_TOKEN: 'quoted',
      TENKI_BASE_URL: 'single',
      FOO: 'bar',
    });
  });

  it('skips blank lines and comments', () => {
    const body = ['', '# header', 'TENKI_AUTH_TOKEN=tk_abc', '#trailing', ''].join('\n');
    expect(parseEnvFile(body)).toEqual({ TENKI_AUTH_TOKEN: 'tk_abc' });
  });

  it('ignores malformed lines (no = sign)', () => {
    expect(parseEnvFile('no_equals_here\nTENKI_AUTH_TOKEN=tk_abc')).toEqual({
      TENKI_AUTH_TOKEN: 'tk_abc',
    });
  });

  it('preserves = signs inside values', () => {
    expect(parseEnvFile('TENKI_AUTH_TOKEN=ab=cd=ef')).toEqual({ TENKI_AUTH_TOKEN: 'ab=cd=ef' });
  });
});

describe('ensureTenkiEnvLoaded token alias', () => {
  const saved = { auth: process.env.TENKI_AUTH_TOKEN, api: process.env.TENKI_API_TOKEN };

  beforeEach(() => {
    vi.resetModules();
    delete process.env.TENKI_AUTH_TOKEN;
    delete process.env.TENKI_API_TOKEN;
    // Point HOME at a directory with no secrets.env so the loader can only see
    // what these tests put in process.env.
    process.env.HOME = '/nonexistent-tenki-test-home';
  });

  afterEach(() => {
    if (saved.auth === undefined) delete process.env.TENKI_AUTH_TOKEN;
    else process.env.TENKI_AUTH_TOKEN = saved.auth;
    if (saved.api === undefined) delete process.env.TENKI_API_TOKEN;
    else process.env.TENKI_API_TOKEN = saved.api;
    vi.resetModules();
  });

  it('promotes TENKI_API_TOKEN to TENKI_AUTH_TOKEN', async () => {
    process.env.TENKI_API_TOKEN = 'tk_alias';
    const { ensureTenkiEnvLoaded } = await import('../src/env-loader.js');
    ensureTenkiEnvLoaded();
    expect(process.env.TENKI_AUTH_TOKEN).toBe('tk_alias');
  });

  it('never lets the alias override an explicit TENKI_AUTH_TOKEN', async () => {
    process.env.TENKI_AUTH_TOKEN = 'tk_primary';
    process.env.TENKI_API_TOKEN = 'tk_alias';
    const { ensureTenkiEnvLoaded } = await import('../src/env-loader.js');
    ensureTenkiEnvLoaded();
    expect(process.env.TENKI_AUTH_TOKEN).toBe('tk_primary');
  });

  it('leaves the token unset when neither name is present', async () => {
    const { ensureTenkiEnvLoaded } = await import('../src/env-loader.js');
    ensureTenkiEnvLoaded();
    expect(process.env.TENKI_AUTH_TOKEN).toBeUndefined();
  });
});
