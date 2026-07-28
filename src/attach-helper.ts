/**
 * Standalone PTY bridge spawned by the provider's `buildAttach` as
 * `node attach-helper.cjs` — Tenki exposes no SSH transport for exec/file ops,
 * so an interactive attach bridges the host terminal to an in-box shell over
 * `session.ssh()`.
 *
 * SCAFFOLD. Built as a CJS bundle so the real helper's entry point and the
 * packaging (`dist/attach-helper.cjs`, asserted by `npm run validate:package`)
 * are settled before the implementation is ported.
 *
 * It runs as its own process, NOT as a module of the plugin: it owns the host
 * TTY's raw mode for the duration of the session, which is why it can't just be
 * a function call inside the CLI.
 */

function main(): never {
  process.stderr.write(
    'tenki attach: not implemented yet (scaffold build) — install a released ' +
      '@luxorlabs/agentbox-provider-tenki to attach to a box\n',
  );
  process.exit(1);
}

main();
