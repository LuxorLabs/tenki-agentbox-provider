/**
 * Contract tests for the exported `providerModule` — the things AgentBox relies
 * on when it loads a plugin. Written against the module surface rather than any
 * backend behavior, so they hold regardless of how the backend evolves.
 */

import { describe, expect, it } from 'vitest';
import { PROVIDER_NAME, providerModule, SDK_API_VERSION } from '../src/index.js';
import manifest from '../package.json' with { type: 'json' };

describe('providerModule', () => {
  it('is named tenki', () => {
    // The CLI matches a plugin's provider.name against `--provider` and never
    // falls back to "the first module in the package", so a mismatch here means
    // `--provider tenki` fails to resolve at all.
    expect(PROVIDER_NAME).toBe('tenki');
    expect(providerModule.provider.name).toBe('tenki');
    expect(providerModule.backend?.name).toBe('tenki');
  });

  it('declares an API version matching the SDK it is built against', () => {
    // `agentbox plugin add` refuses a package whose declared version isn't in
    // the CLI's supported set; drift between these two is the cause.
    expect(manifest.agentbox.providerApiVersion).toBe(SDK_API_VERSION);
  });

  it('supplies the full lifecycle via createCloudProvider', () => {
    // We implement only the thin backend; every method below comes from the
    // SDK's cloud scaffold, so this asserts the wrapping actually happened
    // rather than that we hand-wrote a lifecycle.
    for (const method of ['create', 'inspect', 'exec', 'start', 'stop', 'destroy'] as const) {
      expect(providerModule.provider[method], `provider.${method}`).toBeTypeOf('function');
    }
  });

  it('exposes doctor checks and credential status', () => {
    expect(providerModule.doctorChecks).toBeTypeOf('function');
    expect(providerModule.readCredStatus).toBeTypeOf('function');
  });

  it('reports doctor checks in the shape the CLI renders', async () => {
    const checks = await providerModule.doctorChecks();
    expect(checks.length).toBeGreaterThan(0);
    for (const check of checks) {
      expect(check.label).toBeTypeOf('string');
      expect(['ok', 'warn', 'fail', 'info']).toContain(check.status);
    }
  });
});
