/**
 * Tests for the managed-secrets writer. It touches the real `~/.agentbox`, so
 * every case runs against a temp HOME rather than the developer's own file.
 */

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let home: string;
let prevHome: string | undefined;
let writeManagedSecrets: typeof import('../src/secrets.js').writeManagedSecrets;
let secretsEnvPath: typeof import('../src/secrets.js').secretsEnvPath;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tenki-secrets-'));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  delete process.env.TENKI_AUTH_TOKEN;
  // Imported after HOME is redirected: os.homedir() reads the env at call time,
  // but importing inside the hook keeps module state fresh per test too.
  const mod = await import('../src/secrets.js');
  writeManagedSecrets = mod.writeManagedSecrets;
  secretsEnvPath = mod.secretsEnvPath;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  delete process.env.TENKI_AUTH_TOKEN;
  rmSync(home, { recursive: true, force: true });
});

describe('writeManagedSecrets', () => {
  it('creates the file and the parent directory', () => {
    writeManagedSecrets(['TENKI_AUTH_TOKEN'], { TENKI_AUTH_TOKEN: 'tk_new' });
    expect(existsSync(secretsEnvPath())).toBe(true);
    expect(readFileSync(secretsEnvPath(), 'utf8')).toBe('TENKI_AUTH_TOKEN=tk_new\n');
  });

  it('writes at mode 0600 so the token is not world-readable', () => {
    writeManagedSecrets(['TENKI_AUTH_TOKEN'], { TENKI_AUTH_TOKEN: 'tk_new' });
    expect(statSync(secretsEnvPath()).mode & 0o777).toBe(0o600);
  });

  it('replaces a previous value instead of accumulating duplicates', () => {
    writeManagedSecrets(['TENKI_AUTH_TOKEN'], { TENKI_AUTH_TOKEN: 'tk_old' });
    writeManagedSecrets(['TENKI_AUTH_TOKEN'], { TENKI_AUTH_TOKEN: 'tk_new' });
    const body = readFileSync(secretsEnvPath(), 'utf8');
    expect(body).toBe('TENKI_AUTH_TOKEN=tk_new\n');
    expect(body.match(/TENKI_AUTH_TOKEN/g)).toHaveLength(1);
  });

  it('leaves other providers keys untouched, including `export`-prefixed ones', () => {
    mkdirSync(join(home, '.agentbox'), { recursive: true });
    writeFileSync(
      secretsEnvPath(),
      ['# creds', 'E2B_API_KEY=e2b_keep', 'export TENKI_AUTH_TOKEN=tk_old', ''].join('\n'),
      { mode: 0o600 },
    );

    writeManagedSecrets(['TENKI_AUTH_TOKEN'], { TENKI_AUTH_TOKEN: 'tk_new' });

    const body = readFileSync(secretsEnvPath(), 'utf8');
    expect(body).toContain('# creds');
    expect(body).toContain('E2B_API_KEY=e2b_keep');
    expect(body).toContain('TENKI_AUTH_TOKEN=tk_new');
    // The `export `-prefixed old value must be stripped, not left shadowing.
    expect(body).not.toContain('tk_old');
  });

  it('updates process.env so the running process sees the new token', () => {
    writeManagedSecrets(['TENKI_AUTH_TOKEN'], { TENKI_AUTH_TOKEN: 'tk_new' });
    expect(process.env.TENKI_AUTH_TOKEN).toBe('tk_new');
  });

  it('treats an unreadable existing file as empty rather than failing the write', () => {
    mkdirSync(join(home, '.agentbox'), { recursive: true });
    writeFileSync(secretsEnvPath(), 'E2B_API_KEY=e2b_keep\n', { mode: 0o600 });
    chmodSync(secretsEnvPath(), 0o000);

    // Root can read a 0000 file, so this case can't be forced there; the
    // behavior under test only manifests for an unprivileged user.
    if (process.getuid?.() === 0) return;

    expect(() =>
      writeManagedSecrets(['TENKI_AUTH_TOKEN'], { TENKI_AUTH_TOKEN: 'tk_new' }),
    ).not.toThrow();
    expect(readFileSync(secretsEnvPath(), 'utf8')).toBe('TENKI_AUTH_TOKEN=tk_new\n');
  });
});
