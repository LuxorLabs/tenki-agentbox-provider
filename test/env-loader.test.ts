import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('LUXORAI_* env precedence', () => {
  const KEYS = [
    'LUXORAI_AUTH_TOKEN',
    'LUXORAI_API_KEY',
    'LUXORAI_API_TOKEN',
    'TENKI_AUTH_TOKEN',
    'TENKI_API_KEY',
    'TENKI_API_TOKEN',
    'LUXORAI_BASE_URL',
    'TENKI_BASE_URL',
    'AGENTBOX_LUXORAI_TIMEOUT_MS',
    'AGENTBOX_TENKI_TIMEOUT_MS',
  ];
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

  beforeEach(() => {
    vi.resetModules();
    for (const k of KEYS) delete process.env[k];
    process.env.HOME = '/nonexistent-tenki-test-home';
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    vi.resetModules();
  });

  it('prefers any LUXORAI_* token over every TENKI_* token', async () => {
    process.env.TENKI_AUTH_TOKEN = 'tk_legacy';
    process.env.LUXORAI_API_TOKEN = 'lx_new';
    const { ensureTenkiEnvLoaded, readTenkiAuthToken } = await import('../src/env-loader.js');
    ensureTenkiEnvLoaded();
    expect(readTenkiAuthToken()).toBe('lx_new');
    process.env.LUXORAI_AUTH_TOKEN = 'lx_primary';
    expect(readTenkiAuthToken()).toBe('lx_primary');
  });

  it('reads the SDK API_KEY names, after AUTH_TOKEN and before API_TOKEN', async () => {
    process.env.TENKI_API_TOKEN = 'tk_alias';
    const { readTenkiAuthToken } = await import('../src/env-loader.js');
    process.env.TENKI_API_KEY = 'tk_key';
    expect(readTenkiAuthToken()).toBe('tk_key');
    process.env.TENKI_AUTH_TOKEN = 'tk_auth';
    expect(readTenkiAuthToken()).toBe('tk_auth');
    process.env.LUXORAI_API_TOKEN = 'lx_alias';
    process.env.LUXORAI_API_KEY = 'lx_key';
    expect(readTenkiAuthToken()).toBe('lx_key');
  });

  it('loads LUXORAI_API_KEY from ~/.agentbox/secrets.env', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tenki-env-'));
    try {
      process.env.HOME = home;
      mkdirSync(join(home, '.agentbox'));
      writeFileSync(join(home, '.agentbox', 'secrets.env'), 'LUXORAI_API_KEY=lx_file\n');
      const { ensureTenkiEnvLoaded, readTenkiAuthToken } = await import('../src/env-loader.js');
      ensureTenkiEnvLoaded();
      expect(readTenkiAuthToken()).toBe('lx_file');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to TENKI_* when no LUXORAI_* value is set', async () => {
    process.env.TENKI_BASE_URL = 'https://api.tenki.test';
    const { readTenkiEnv, readTenkiAuthToken } = await import('../src/env-loader.js');
    expect(readTenkiEnv('BASE_URL')).toBe('https://api.tenki.test');
    expect(readTenkiAuthToken()).toBeUndefined();
    process.env.LUXORAI_BASE_URL = 'https://api.luxor.test';
    expect(readTenkiEnv('BASE_URL')).toBe('https://api.luxor.test');
  });

  it('reads AGENTBOX_LUXORAI_* before AGENTBOX_TENKI_*', async () => {
    process.env.AGENTBOX_TENKI_TIMEOUT_MS = '1000';
    const { readAgentboxEnv } = await import('../src/env-loader.js');
    expect(readAgentboxEnv('TIMEOUT_MS')).toBe('1000');
    process.env.AGENTBOX_LUXORAI_TIMEOUT_MS = '2000';
    expect(readAgentboxEnv('TIMEOUT_MS')).toBe('2000');
  });

  it('drops a stale LUXORAI_* token when new credentials are saved', async () => {
    const home = mkdtempSync(join(tmpdir(), 'tenki-env-'));
    try {
      process.env.HOME = home;
      mkdirSync(join(home, '.agentbox'));
      writeFileSync(
        join(home, '.agentbox', 'secrets.env'),
        'LUXORAI_AUTH_TOKEN=lx_old\nLUXORAI_API_KEY=lx_old_key\n',
      );
      const { ensureTenkiEnvLoaded, readTenkiAuthToken } = await import('../src/env-loader.js');
      const { setTenkiCredentials } = await import('../src/credentials.js');
      ensureTenkiEnvLoaded();
      expect(readTenkiAuthToken()).toBe('lx_old');
      expect(setTenkiCredentials({ token: 'tk_new' }).ok).toBe(true);
      expect(readTenkiAuthToken()).toBe('tk_new');
      expect(readFileSync(join(home, '.agentbox', 'secrets.env'), 'utf8')).not.toContain('lx_old');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
