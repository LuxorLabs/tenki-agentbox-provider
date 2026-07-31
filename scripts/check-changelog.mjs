/**
 * Gate: the version in `package.json` must have an entry in `CHANGELOG.md`.
 *
 * `package.json` is the single source of truth for both the npm version and the
 * git tag, so a bump is the act that ships a release — and a release with no
 * changelog entry is one nobody can read afterwards. Rather than diffing against
 * a base ref (which needs full history, breaks on force-pushes, and false-fires
 * on reverts), this asserts a standing invariant: whatever version is declared
 * right now is documented right now. Bump to 0.2.0 without adding a `## 0.2.0`
 * heading and this fails; touch neither and it stays green.
 *
 * Run: `npm run check:changelog`. Exits non-zero, naming what to add.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const CHANGELOG = resolve(ROOT, 'CHANGELOG.md');

function fail(message, hint) {
  console.error('[changelog] FAIL');
  console.error(`  - ${message}`);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
}

const { version } = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8'));
if (typeof version !== 'string' || version.length === 0) {
  fail('package.json has no `version`');
}

if (!existsSync(CHANGELOG)) {
  fail(`no CHANGELOG.md at ${CHANGELOG}`);
}
const changelog = readFileSync(CHANGELOG, 'utf8');

// Anchored to a level-2 heading so a passing mention in prose doesn't satisfy
// the check. Accepts the common spellings: `## 0.1.0`, `## v0.1.0`, `## [0.1.0]`
// (Keep a Changelog's link form), each optionally followed by a date.
const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const heading = new RegExp(String.raw`^##\s+\[?v?${escaped}\]?(\s|$)`, 'm');

if (!heading.test(changelog)) {
  fail(
    `package.json is at ${version} but CHANGELOG.md has no entry for it`,
    `Add a section to CHANGELOG.md before releasing:\n\n  ## ${version} — <YYYY-MM-DD>\n\n  ### Added\n\n  - ...\n`,
  );
}

console.log(`[changelog] OK — ${version} is documented in CHANGELOG.md`);
