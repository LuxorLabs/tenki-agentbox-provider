/**
 * `buildTenkiAttach` — the Tenki provider's override of `Provider.buildAttach`.
 *
 * ## Why this shells out to real OpenSSH
 *
 * `session.ssh()` is NOT a shell channel: `SSHConnection` is a thin wrapper over
 * a WebSocket carrying the **raw SSH wire protocol**, exposing only
 * `read()/write()/close()`. Writing shell commands into it just gets you the
 * gateway's version banner (`SSH-2.0-Tenki-edge-gateway`) — reaching a shell
 * means performing the SSH handshake: key exchange, publickey auth, channel
 * open, PTY request. The data plane is no help either: `session.run` has no
 * tty/pty option, so there is no interactive path through it.
 *
 * So we let the host's `ssh` do the protocol and use our helper purely as the
 * transport:
 *
 *   ssh -o ProxyCommand='node attach-helper.cjs --proxy --session-id <id>' \
 *       -i <key> -o CertificateFile=<key>-cert.pub -t <user>@<id> <inner cmd>
 *
 * Auth is an ephemeral ed25519 key plus a short-lived OpenSSH certificate from
 * `issueSandboxSSHCert` — which the SDK documents for exactly this
 * (`<key>-cert.pub` / `-o CertificateFile=`).
 *
 * Beyond correctness this gets window-size propagation for free: OpenSSH
 * forwards SIGWINCH, so tmux tracks terminal resizes. The previous
 * bridge-the-bytes-ourselves design could not, since `SSHConnection` has no
 * resize op.
 *
 * Detached pre-start keeps its own path (see `--detached` in the helper): it only
 * needs to CREATE the tmux session, which is a plain non-interactive exec.
 */

import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  hostTermForCloud,
  renderInnerCommand,
  UserFacingError,
  type AttachKind,
  type AttachSpec,
  type BoxRecord,
  type BuildAttachOptions,
} from '@madarco/agentbox-provider-sdk';
import { getTenkiClient, resolveAuthToken } from './sdk.js';

const execFileAsync = promisify(execFile);

const SELF = dirname(fileURLToPath(import.meta.url));

/**
 * Login user inside the box. Tenki's `sandbox` base runs as `tenki`, and the
 * certificate's principals are issued for the session — override only if a
 * custom base image uses a different account.
 */
const SSH_USER = process.env.AGENTBOX_TENKI_SSH_USER?.trim() || 'tenki';

/** Certificate lifetime. Short by design: a new one is minted per attach. */
const CERT_TTL_MS = 60 * 60_000;

/**
 * Resolve the absolute path to `attach-helper.cjs`. Both entries are built into
 * this package's own `dist/`, so the helper is always a sibling of the module
 * calling it — a plugin ships its own runtime assets rather than having them
 * staged into the CLI's `runtime/` tree. The `..` candidate covers running from
 * `src/` under a TS loader during development.
 */
export function resolveAttachHelperPath(): string {
  const candidates = [
    resolve(SELF, 'attach-helper.cjs'),
    resolve(SELF, '..', 'dist', 'attach-helper.cjs'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return candidates[0]!;
}

/** Per-box key material. Mirrors hetzner's layout; the private key never leaves the host. */
export function sshKeyDir(sandboxId: string): string {
  return resolve(homedir(), '.agentbox', 'boxes', sandboxId, 'ssh');
}

/**
 * Ensure an ed25519 keypair exists for this box, returning its path and public
 * key. The keypair is reused across attaches (cheap, and its only authority is a
 * certificate that expires); the certificate is re-minted every time.
 */
async function ensureKeypair(sandboxId: string): Promise<{ keyPath: string; publicKey: string }> {
  const dir = sshKeyDir(sandboxId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = join(dir, 'id_ed25519');
  if (!existsSync(keyPath)) {
    try {
      await execFileAsync('ssh-keygen', [
        '-t',
        'ed25519',
        '-N',
        '',
        '-C',
        `agentbox-tenki-${sandboxId}`,
        '-q',
        '-f',
        keyPath,
      ]);
    } catch (err) {
      throw new UserFacingError(
        'tenki attach: could not generate an SSH key — `ssh-keygen` is required ' +
          '(it ships with OpenSSH, alongside the `ssh` client this attach also needs).\n' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
    chmodSync(keyPath, 0o600);
  }
  return { keyPath, publicKey: readFileSync(`${keyPath}.pub`, 'utf8').trim() };
}

/** Mint a fresh certificate for the keypair and write it where ssh will find it. */
async function issueCert(sandboxId: string, keyPath: string, publicKey: string): Promise<string> {
  const cert = await getTenkiClient().issueSandboxSSHCert(sandboxId, publicKey, {
    ttlMs: CERT_TTL_MS,
  });
  const certPath = `${keyPath}-cert.pub`;
  writeFileSync(certPath, cert.sshCert.trim() + '\n', { mode: 0o600 });
  return certPath;
}

/**
 * Quote a path for the ProxyCommand string. `ssh` hands that value to `/bin/sh`,
 * so a path with spaces would otherwise split into separate words.
 */
function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

export async function buildTenkiAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const sandboxId = box.cloud?.sandboxId;
  if (!sandboxId) {
    throw new Error(`tenki box ${box.name} has no sandboxId — record is malformed`);
  }

  const helper = resolveAttachHelperPath();
  if (!existsSync(helper)) {
    throw new Error(
      `tenki attach helper not found at ${helper} — the installed ` +
        '@tenkicloud/agentbox-provider-tenki is missing dist/attach-helper.cjs; reinstall the package.',
    );
  }

  const authToken = resolveAuthToken();
  const inner = renderInnerCommand(kind, opts);
  const hostTerm = hostTermForCloud();

  const env: Record<string, string> = {
    // The ProxyCommand child opens the gateway WebSocket, so it needs the token.
    TENKI_AUTH_TOKEN: authToken,
    AGENTBOX_HOST_TERM: hostTerm,
    // `ssh -t` propagates the local TERM to the remote PTY.
    TERM: hostTerm,
  };
  if (process.env.TENKI_BASE_URL) env.TENKI_BASE_URL = process.env.TENKI_BASE_URL;
  if (process.env.TENKI_GATEWAY_ADDRESS)
    env.TENKI_GATEWAY_ADDRESS = process.env.TENKI_GATEWAY_ADDRESS;

  // Detached pre-start: only CREATE the tmux session (renderInnerCommand with
  // `detached:true` emits no trailing `exec tmux attach`). That is a plain
  // non-interactive exec, so it skips SSH entirely — and must, since opening an
  // interactive session here would idle forever and hang the host's
  // `runDetached` await.
  if (opts?.detached) {
    return {
      argv: [process.execPath, helper, '--detached', '--session-id', sandboxId],
      env: { ...env, AGENTBOX_TENKI_INNER_CMD: inner },
    };
  }

  const { keyPath, publicKey } = await ensureKeypair(sandboxId);
  const certPath = await issueCert(sandboxId, keyPath, publicKey);

  const proxyCommand = `${shq(process.execPath)} ${shq(helper)} --proxy --session-id ${shq(sandboxId)}`;

  const argv = [
    'ssh',
    '-o',
    `ProxyCommand=${proxyCommand}`,
    // Only ever offer the key we just minted a cert for; without this ssh may
    // walk the user's agent/default identities first and exhaust auth attempts.
    '-o',
    'IdentitiesOnly=yes',
    '-i',
    keyPath,
    '-o',
    `CertificateFile=${certPath}`,
    // The gateway terminates the connection, and the "host" is a session id
    // rather than a stable endpoint — so there is no host key worth pinning, and
    // recording one would just churn the user's known_hosts.
    '-o',
    'StrictHostKeyChecking=no',
    '-o',
    'UserKnownHostsFile=/dev/null',
    // Suppresses the "Permanently added … to the list of known hosts" banner
    // that would otherwise print over the agent's first screen.
    '-o',
    'LogLevel=ERROR',
    // Force a PTY: the remote command is `tmux attach`, which needs one.
    '-t',
    `${SSH_USER}@${sandboxId}`,
    inner,
  ];

  return { argv, env };
}
