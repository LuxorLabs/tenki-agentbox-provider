/**
 * Publish smoke test for @tenkicloud/agentbox-provider.
 *
 * A local build can't catch a broken *published artifact* — a file missing from
 * `files`, or an export that never made it into dist/. This packs the package
 * exactly as `npm publish` would, installs the tarball into a throwaway dir,
 * imports it from there, and asserts the AgentBox plugin contract holds:
 *
 *   - dist/index.js + dist/index.d.ts shipped
 *   - dist/attach-helper.cjs shipped (buildAttach spawns it as `node <path>`)
 *   - a `providerModule` export whose `provider.name` is exactly `tenki`
 *     (the CLI matches on provider.name and refuses a mismatch)
 *   - the required ProviderModule members are present and callable-shaped
 *   - package.json declares `agentbox.providerApiVersion` in the range the
 *     installed SDK's SDK_API_VERSION supports
 *
 * Run: `npm run validate:package`. Exits non-zero, naming what failed.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_NAME = '@tenkicloud/agentbox-provider';
const PKG_DIR = resolve(fileURLToPath(import.meta.url), '..', '..');
const PROVIDER_NAME = 'tenki';

/** Files that must exist inside the installed package. */
const REQUIRED_FILES = ['dist/index.js', 'dist/index.d.ts', 'dist/attach-helper.cjs'];

/** ProviderModule members AgentBox drives generically. `provider` + `doctorChecks` are mandatory. */
const REQUIRED_MODULE_MEMBERS = ['provider', 'doctorChecks'];
const EXPECTED_FUNCTIONS = ['doctorChecks', 'ensureCredentials', 'readCredStatus'];

/** Provider capabilities this plugin promises. */
const REQUIRED_PROVIDER_MEMBERS = ['create', 'prepare', 'buildAttach', 'checkpoint'];

function run(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

const tmp = mkdtempSync(join(tmpdir(), 'agentbox-tenki-validate-'));
const failures = [];

try {
  console.log(`[validate] building ${PKG_NAME}`);
  run('npm', ['run', 'build'], PKG_DIR);

  console.log('[validate] npm pack -> tarball');
  const packed = run('npm', ['pack', '--pack-destination', tmp, '--json'], PKG_DIR);
  const tgzName = JSON.parse(packed)[0].filename;
  const tgz = join(tmp, tgzName);
  if (!existsSync(tgz)) throw new Error(`packed tarball not found at ${tgz}`);
  console.log(`[validate] packed ${tgzName}`);

  // A throwaway consumer that installs ONLY the tarball, so we exercise the
  // package's declared runtime deps and shipped files — nothing local leaks in.
  const consumer = join(tmp, 'consumer');
  mkdirSync(consumer, { recursive: true });
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify({ name: 'tenki-validate-consumer', private: true, version: '1.0.0' }, null, 2),
  );
  console.log('[validate] installing the tarball in isolation');
  run('npm', ['install', '--no-audit', '--no-fund', tgz], consumer);

  const installed = join(consumer, 'node_modules', PKG_NAME);
  for (const rel of REQUIRED_FILES) {
    if (!existsSync(join(installed, rel))) {
      failures.push(`missing from the published tarball: ${rel}`);
    }
  }

  // providerApiVersion must be in the installed SDK's supported range. The SDK
  // is the authority here: a plugin declaring a version the CLI doesn't accept
  // is refused at `agentbox plugin add`, which is a confusing failure to debug.
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  const declared = manifest.agentbox?.providerApiVersion;
  const sdkEntry = join(
    consumer,
    'node_modules',
    '@madarco',
    'agentbox-provider-sdk',
    'dist',
    'index.js',
  );
  if (!existsSync(sdkEntry)) {
    failures.push('the provider SDK did not install — check the `dependencies` entry');
  } else {
    const sdk = await import(pathToFileURL(sdkEntry).href);
    if (declared !== sdk.SDK_API_VERSION) {
      failures.push(
        `agentbox.providerApiVersion is ${String(declared)} but the installed SDK is v${String(sdk.SDK_API_VERSION)} — they must match`,
      );
    }
  }

  if (failures.length === 0) {
    console.log('[validate] importing the installed package + checking the plugin contract');
    const mod = await import(pathToFileURL(join(installed, 'dist', 'index.js')).href);
    const pm = mod.providerModule;

    if (!pm) {
      failures.push('no `providerModule` export — AgentBox cannot load this plugin');
    } else {
      for (const member of REQUIRED_MODULE_MEMBERS) {
        if (pm[member] === undefined) failures.push(`providerModule.${member} is missing`);
      }
      for (const fn of EXPECTED_FUNCTIONS) {
        if (pm[fn] !== undefined && typeof pm[fn] !== 'function') {
          failures.push(`providerModule.${fn} is not a function`);
        }
      }
      // The CLI resolves a plugin by matching provider.name against the
      // requested `--provider`, and never falls back — a wrong name here means
      // `--provider tenki` silently fails to resolve.
      if (pm.provider?.name !== PROVIDER_NAME) {
        failures.push(
          `provider.name is ${JSON.stringify(pm.provider?.name)}, expected ${JSON.stringify(PROVIDER_NAME)}`,
        );
      }
      for (const member of REQUIRED_PROVIDER_MEMBERS) {
        if (pm.provider?.[member] === undefined) failures.push(`provider.${member} is missing`);
      }
    }
  }
} catch (err) {
  failures.push(err instanceof Error ? err.message : String(err));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('[validate] FAIL');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`[validate] OK — ${PKG_NAME} publishes a loadable "${PROVIDER_NAME}" provider`);
