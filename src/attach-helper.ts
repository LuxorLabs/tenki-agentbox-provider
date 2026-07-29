/**
 * Standalone helper spawned by `buildTenkiAttach`. Two modes, no interactive
 * shell handling of its own:
 *
 *   --proxy      An `ssh` ProxyCommand. Bridges this process's stdin/stdout to
 *                the session's SSH transport (`session.ssh()`), so the host's
 *                real `ssh` client speaks the SSH protocol end to end and owns
 *                the PTY, auth, and window-resize handling.
 *
 *   --detached   Pre-start. Runs AGENTBOX_TENKI_INNER_CMD once over the
 *                non-interactive data plane and exits. In detached mode the
 *                inner command only CREATES the tmux session, so there is
 *                nothing to attach to and opening a channel would hang the
 *                host's `runDetached` await forever.
 *
 * Why the proxy mode is byte-shuffling and nothing more: `SSHConnection` wraps a
 * WebSocket carrying the RAW SSH wire protocol. It is a transport, not a shell —
 * an earlier version of this helper wrote shell commands into it and got back
 * only the gateway's version banner.
 *
 * Argv: `node attach-helper.cjs (--proxy|--detached) --session-id <id>`
 * Env:
 *   TENKI_AUTH_TOKEN            Tenki credentials (threaded in by build-attach).
 *   AGENTBOX_TENKI_INNER_CMD    Inner bash command (--detached only).
 *   TENKI_BASE_URL,
 *   TENKI_GATEWAY_ADDRESS       Optional control-plane overrides.
 */

import { TenkiSandbox } from '@tenkicloud/sandbox';
import { ensureTenkiEnvLoaded } from './env-loader.js';

interface ParsedArgs {
  sessionId: string;
  mode: 'proxy' | 'detached';
}

function parseArgs(argv: string[]): ParsedArgs {
  let sessionId: string | undefined;
  let mode: 'proxy' | 'detached' | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session-id') {
      sessionId = argv[i + 1];
      i++;
    } else if (a === '--proxy') {
      mode = 'proxy';
    } else if (a === '--detached') {
      mode = 'detached';
    }
  }
  if (!sessionId) {
    process.stderr.write('attach-helper: --session-id is required\n');
    process.exit(2);
  }
  if (!mode) {
    process.stderr.write('attach-helper: one of --proxy or --detached is required\n');
    process.exit(2);
  }
  return { sessionId, mode };
}

function buildClient(): TenkiSandbox {
  const authToken = process.env.TENKI_AUTH_TOKEN;
  if (!authToken) {
    process.stderr.write('attach-helper: TENKI_AUTH_TOKEN env is required\n');
    process.exit(2);
  }
  const opts: ConstructorParameters<typeof TenkiSandbox>[0] = { authToken };
  if (process.env.TENKI_BASE_URL) opts.baseUrl = process.env.TENKI_BASE_URL;
  if (process.env.TENKI_GATEWAY_ADDRESS) opts.gatewayAddress = process.env.TENKI_GATEWAY_ADDRESS;
  return new TenkiSandbox(opts);
}

async function main(): Promise<void> {
  const { sessionId, mode } = parseArgs(process.argv.slice(2));
  ensureTenkiEnvLoaded();

  const client = buildClient();
  let session;
  try {
    session = await client.get(sessionId);
  } catch (err) {
    process.stderr.write(
      `attach-helper: could not resolve session ${sessionId}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Defensive: an attach right after resume should already be RUNNING, but wake
  // a paused box rather than failing the connection.
  if (session.state !== 'RUNNING') {
    try {
      await session.resume();
      await session.waitReady(60_000);
    } catch {
      // fall through — the op below surfaces a clear transport error
    }
  }

  if (mode === 'detached') {
    const inner = process.env.AGENTBOX_TENKI_INNER_CMD;
    if (!inner) {
      process.stderr.write('attach-helper: AGENTBOX_TENKI_INNER_CMD env is required\n');
      process.exit(2);
    }
    try {
      const r = await session.run(['bash', '-c', inner], { cwd: '/workspace' });
      process.exit(r.exitCode ?? 0);
    } catch (err) {
      process.stderr.write(
        `attach-helper: detached pre-start failed: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    }
  }

  // --proxy: pure transport. stdin -> gateway, gateway -> stdout. `ssh` on the
  // other side of these pipes does the handshake and runs the remote command.
  let conn;
  try {
    conn = await session.ssh();
  } catch (err) {
    process.stderr.write(
      `attach-helper: could not open the SSH transport: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  process.stdin.on('data', (chunk: Buffer) => {
    conn.write(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)).catch(() => {
      // transport gone; the read loop below exits and we follow it out
    });
  });
  // ssh closing its end of the pipe means the session is over.
  process.stdin.on('end', () => {
    try {
      conn.close();
    } catch {
      // already closed
    }
  });

  let exitCode = 0;
  try {
    for (;;) {
      const data = await conn.read();
      if (data === null) break; // transport closed
      process.stdout.write(data);
    }
  } catch (err) {
    process.stderr.write(
      `attach-helper: SSH transport read failed: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    exitCode = 1;
  } finally {
    try {
      conn.close();
    } catch {
      // ignore
    }
  }
  process.exit(exitCode);
}

main().catch((err) => {
  process.stderr.write(
    `attach-helper: unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
