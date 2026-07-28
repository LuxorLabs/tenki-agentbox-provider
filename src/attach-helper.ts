/**
 * Standalone PTY bridge spawned by the provider's `buildAttach` as
 * `node attach-helper.cjs` — Tenki exposes no SSH transport for exec/file ops,
 * so an interactive attach bridges the host terminal to an in-box shell over
 * `session.ssh()`.
 *
 * It runs as its own process, NOT as a module of the plugin: it owns the host
 * TTY's raw mode for the duration of the session, which is why it can't just be
 * a function call inside the CLI. Built as a CJS bundle because it is invoked as
 * `node <path>`, where no package-level `"type": "module"` hint reaches a
 * standalone file.
 */

function main(): never {
  process.stderr.write('tenki attach: not implemented yet\n');
  process.exit(1);
}

main();
