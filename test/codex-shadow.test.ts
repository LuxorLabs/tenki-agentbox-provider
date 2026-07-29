/**
 * The sanitized codex shadow HOME.
 *
 * `stageCodexStaticForUpload` runs `rsync -aL`, and `-a` implies `-D` (recreate
 * specials). Codex leaves a live Unix socket at `~/.codex/ipc/ipc.sock` whenever
 * it has run, which rsync can't recreate — it exits 23 and the staging throws,
 * taking the whole bake down. The shadow drops anything that isn't a directory or
 * regular file, so the socket isn't there to trip over.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shadowCodexHome } from '../src/prepare.js';

let home: string;
let socket: Server | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'codex-shadow-test-'));
});

afterEach(() => {
  socket?.close();
  socket = undefined;
  rmSync(home, { recursive: true, force: true });
});

/** A ~/.codex with the exact shape that breaks rsync. */
async function makeCodexHome(): Promise<void> {
  const codex = join(home, '.codex');
  mkdirSync(join(codex, 'ipc'), { recursive: true });
  mkdirSync(join(codex, 'nested', 'deeper'), { recursive: true });
  writeFileSync(join(codex, 'config.toml'), 'model = "gpt-5"\n');
  writeFileSync(join(codex, 'auth.json'), '{"token":"SECRET"}\n');
  writeFileSync(join(codex, 'nested', 'deeper', 'notes.md'), '# notes\n');
  // The live socket, created the way codex creates it.
  await new Promise<void>((resolve) => {
    socket = createServer();
    socket.listen(join(codex, 'ipc', 'ipc.sock'), () => resolve());
  });
}

describe('shadowCodexHome', () => {
  it('returns null when there is no ~/.codex to shadow', () => {
    expect(shadowCodexHome(home)).toBeNull();
  });

  it('drops the socket that makes rsync exit 23', async () => {
    await makeCodexHome();
    // Guard the premise: if this isn't a socket the test proves nothing.
    expect(lstatSync(join(home, '.codex', 'ipc', 'ipc.sock')).isSocket()).toBe(true);

    const shadow = shadowCodexHome(home);
    expect(shadow).not.toBeNull();
    try {
      expect(existsSync(join(shadow!.home, '.codex', 'ipc', 'ipc.sock'))).toBe(false);
      // The containing directory is still mirrored — only the special is skipped.
      expect(existsSync(join(shadow!.home, '.codex', 'ipc'))).toBe(true);
    } finally {
      shadow!.cleanup();
    }
  });

  it('never copies the credential file into the temp tree', async () => {
    await makeCodexHome();
    const shadow = shadowCodexHome(home);
    try {
      expect(existsSync(join(shadow!.home, '.codex', 'auth.json'))).toBe(false);
    } finally {
      shadow!.cleanup();
    }
  });

  it('exposes regular files as symlinks so no user data is duplicated', async () => {
    await makeCodexHome();
    const shadow = shadowCodexHome(home);
    try {
      const shadowed = join(shadow!.home, '.codex', 'config.toml');
      expect(lstatSync(shadowed).isSymbolicLink()).toBe(true);
      // rsync -L reads through it, so content must resolve to the original.
      expect(readFileSync(shadowed, 'utf8')).toContain('gpt-5');
    } finally {
      shadow!.cleanup();
    }
  });

  it('mirrors nested directories', async () => {
    await makeCodexHome();
    const shadow = shadowCodexHome(home);
    try {
      expect(existsSync(join(shadow!.home, '.codex', 'nested', 'deeper', 'notes.md'))).toBe(true);
    } finally {
      shadow!.cleanup();
    }
  });

  it('cleans up after itself', async () => {
    await makeCodexHome();
    const shadow = shadowCodexHome(home);
    const root = shadow!.home;
    shadow!.cleanup();
    expect(existsSync(root)).toBe(false);
  });
});
