# Contributing

Thanks for looking at this. Bug reports and pull requests are welcome.

For anything security-related, please follow [SECURITY.md](./SECURITY.md) instead of opening a public
issue.

## Getting set up

The package itself runs on Node.js 20 or newer (`engines`), but the dev toolchain needs a recent
patch line — eslint 10 requires Node `^20.19` / `^22.13` / `>=24`. CI runs on 22.

```bash
npm install
npm run build
npm test
```

## The gates

CI runs all of these, so run them before opening a pull request:

```bash
npm run check:changelog
npm run lint
npm run format:check
npm run typecheck
npm run build
npm test
npm run validate:package
```

`check:changelog` asserts that whatever version `package.json` declares has a section in
`CHANGELOG.md`. You only need to touch it when you bump the version — but when you do, the entry is
not optional, because that bump is what ships a release.

`validate:package` is the one that catches problems a workspace build can't: it packs the tarball
exactly as `npm publish` would, installs it into a throwaway directory, imports it from there, and
asserts the AgentBox plugin contract still holds. A file missing from the `files` allowlist, or an
export that never made it into `dist/`, fails here and nowhere else.

## Tests

Tests are **pure** — no network, no live Tenki SDK, no reads of your real home directory. `vitest`,
with the SDK seam (`src/sdk.ts`) mocked where a test needs a control plane.

This matters most for `test/prepare-plan.test.ts`. `buildInstallPlan()` is a pure function precisely
so the whole install recipe can be asserted offline: a mistake in it otherwise only surfaces several
minutes into a live, billable bake. Keep that property — if you change the plan, assert the change.

## Conventions

- **TypeScript strict, ESM.** `verbatimModuleSyntax` is on, so type-only imports must say
  `import type`.
- **Prettier and ESLint** decide formatting and lint. Run `npm run format`; don't hand-format.
- **No emojis** in code, comments, or program output.
- **Comments explain _why_.** Names carry the _what_. If something non-obvious cost you debugging
  time, leave a note — several of the invariants in `src/prepare.ts` and `src/backend.ts` are there
  for exactly that reason, and removing them tends to reintroduce the bug.
- Keep `provider.name` as `tenki`. The AgentBox CLI resolves `--provider tenki` by matching that
  string exactly and never falls back.
- `agentbox.providerApiVersion` in `package.json` must equal the installed SDK's `SDK_API_VERSION`.
  `validate:package` asserts it, because a mismatch is refused at `agentbox plugin add` with a
  confusing error.

## Testing against a real Tenki workspace

Unit tests cover the logic; the lifecycle needs a real workspace. You need a Tenki auth token in
`TENKI_AUTH_TOKEN` (or `~/.agentbox/secrets.env`) and the published AgentBox CLI, 0.27.1 or newer:

```bash
npm i -g @madarco/agentbox
npm run build && agentbox plugin add .    # register this working copy
agentbox prepare --provider tenki
agentbox create --provider tenki -n smoke
```

Two things to know before you do:

- **It costs money and takes time.** `prepare` runs roughly 8–12 minutes and boots a 20 GB builder
  VM; `create` takes about 3 minutes. Run them in the background and tail
  `~/.agentbox/logs/latest.log` rather than blocking on them.
- **Audit for leaks after any failure.** A failed `prepare` can leave a paused builder named
  `agentbox-prepare` behind, and it is billable until its deadline. `agentbox prune` does **not**
  cover plugin providers, so check the Tenki dashboard (or list sessions and snapshots through the
  SDK) and clean up by hand.

## Pull requests

Keep the diff focused, explain the _why_ in the description, and include a test for anything
behavioural. If you found the bug against a live workspace, say so — it tells a reviewer the failure
mode was real rather than theoretical.
