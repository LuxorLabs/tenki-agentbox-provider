import { defineConfig } from 'tsup';

/**
 * Two entries:
 *   - `src/index.ts` (ESM) — the plugin surface AgentBox loads via `import()`
 *     of the entry recorded by `agentbox plugin add`. Must export `providerModule`.
 *   - `src/attach-helper.ts` (CJS bundle) — a standalone Node process spawned by
 *     `buildTenkiAttach` to bridge the host PTY to an in-box SSH channel
 *     (`session.ssh()`). CJS because it is invoked as `node <path>`, where no
 *     package-level `"type": "module"` hint reaches a standalone file; bundling
 *     lets us ship exactly one file.
 *
 * Runtime deps stay external — they are declared in `dependencies`, so npm
 * installs them alongside the plugin and the host's module graph resolves them.
 * `@tenkicloud/sandbox` in particular pulls in ConnectRPC + protobuf + `ws`,
 * which we do not want inlined.
 *
 * NEITHER entry cleans: tsup runs an array config's entries concurrently, so a
 * `clean: true` here can wipe dist/ *after* the other entry has written its
 * output — a coin-flip that drops attach-helper.cjs from the build. The `build`
 * script clears dist/ once, up front, instead.
 */
const EXTERNAL = ['@madarco/agentbox-provider-sdk', '@clack/prompts', '@tenkicloud/sandbox'];

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    target: 'node20',
    clean: false,
    dts: true,
    sourcemap: true,
    external: EXTERNAL,
  },
  {
    entry: { 'attach-helper': 'src/attach-helper.ts' },
    format: ['cjs'],
    target: 'node20',
    clean: false,
    // No d.ts for a standalone spawned helper.
    dts: false,
    sourcemap: true,
    external: EXTERNAL,
  },
]);
