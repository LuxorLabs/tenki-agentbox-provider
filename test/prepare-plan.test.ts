/**
 * The install plan `prepare` runs inside the builder sandbox. Pure functions, so
 * the whole recipe is assertable offline — a mistake here otherwise only shows up
 * minutes into a live bake, after paying for a VM.
 */

import { describe, expect, it } from 'vitest';
import { buildInstallPlan, PREPARE_ASSETS, stagedAssetPath } from '../src/prepare.js';
import { SHARED_RUNTIME_ASSETS } from '@madarco/agentbox-provider-sdk';

const plan = buildInstallPlan();
const script = plan.map((s) => s.command).join('\n');
const stepNames = plan.map((s) => s.name);

describe('PREPARE_ASSETS', () => {
  it('only names assets the CLI actually stages', () => {
    // resolveSharedRuntimeAsset throws at runtime for anything not in the CLI's
    // shared runtime dir, and that happens after a builder VM is already booted.
    const known = new Set<string>(SHARED_RUNTIME_ASSETS);
    for (const asset of PREPARE_ASSETS) {
      expect(known, `${asset.shared} is not a shared runtime asset`).toContain(asset.shared);
    }
  });

  it('ships agentbox-ctl and the relay shims', () => {
    const dests = PREPARE_ASSETS.map((a) => a.dest);
    expect(dests).toContain('/usr/local/bin/agentbox-ctl');
    // The shims shadow the real binaries on PATH — that indirection is why a box
    // needs no credentials of its own. `ntn`/`linear` were per-connector shims;
    // upstream replaced them with one generic host-tool shim that is symlinked
    // per granted tool at box start, so there is no fixed path to assert.
    for (const shim of ['gh', 'git']) {
      expect(dests).toContain(`/usr/local/bin/${shim}`);
    }
    expect(dests).toContain('/usr/local/bin/agentbox-tool-shim');
  });

  it('marks executables 0755 and configs 0644', () => {
    for (const asset of PREPARE_ASSETS) {
      const expected = asset.dest.startsWith('/usr/local/bin/') ? '0755' : '0644';
      expect(asset.mode, asset.dest).toBe(expected);
    }
  });

  it('stages every asset under /tmp with a distinct path', () => {
    const staged = PREPARE_ASSETS.map((a) => stagedAssetPath(a.shared));
    for (const path of staged) expect(path.startsWith('/tmp/')).toBe(true);
    expect(new Set(staged).size).toBe(staged.length);
  });
});

describe('buildInstallPlan', () => {
  it('names every step, uniquely', () => {
    // The name is what a failure is reported against, so a blank or duplicated
    // one defeats the point of discrete steps.
    for (const name of stepNames) expect(name.length).toBeGreaterThan(0);
    expect(new Set(stepNames).size).toBe(stepNames.length);
  });

  it('runs every step under `set -e` so a failed line fails the step', () => {
    for (const step of plan) {
      expect(step.command, step.name).toMatch(/^set -euo pipefail$/m);
    }
  });

  it('installs each uploaded asset to its destination', () => {
    for (const asset of PREPARE_ASSETS) {
      expect(script).toContain(`"${stagedAssetPath(asset.shared)}" "${asset.dest}"`);
    }
  });

  it('elevates exactly the steps that write outside the box user home', () => {
    const byName = new Map(plan.map((s) => [s.name, s]));
    for (const name of ['apt-packages', 'box-dirs', 'runtime-assets', 'ownership']) {
      expect(byName.get(name)?.root, name).toBe(true);
    }
    // npm's global prefix is writable by the box user, and installing as that
    // user keeps the resulting file ownership right.
    expect(byName.get('coding-agents')?.root).toBeUndefined();
  });

  it('gives the slow steps a timeout above the backend default', () => {
    const byName = new Map(plan.map((s) => [s.name, s]));
    // The backend's exec default is 5 min; apt and three npm installs exceed it.
    expect(byName.get('coding-agents')?.timeoutMs ?? 0).toBeGreaterThan(300_000);
    expect(byName.get('apt-packages')?.timeoutMs ?? 0).toBeGreaterThan(300_000);
  });

  it('installs tmux, absent from the base image and required by attach', () => {
    expect(script).toContain('tmux');
  });

  it('installs docker and lets the box user reach the daemon', () => {
    // In-box docker is verified working on Tenki, and the provider enables
    // dockerd. The agent runs unprivileged, so group membership — not the socket
    // mode — is what makes `docker` usable without sudo.
    const byName = new Map(plan.map((s) => [s.name, s]));
    const apt = byName.get('apt-packages')!.command;
    expect(apt).toContain('docker.io');
    expect(apt).toContain('usermod -aG docker tenki');
    const verify = plan.at(-1)!.command;
    expect(verify).toContain('command -v dockerd');
    expect(verify).toContain('grep -qx docker');
  });

  it('installs the three coding agents', () => {
    for (const pkg of ['@anthropic-ai/claude-code', '@openai/codex', 'opencode-ai']) {
      expect(script).toContain(pkg);
    }
  });

  it('symlinks /home/vscode without renaming the platform user', () => {
    // agentbox-ctl hardcodes /home/vscode/... credential paths, but Tenki's base
    // runs as `tenki` and its guest agent runs as that user.
    expect(script).toContain('/home/vscode');
    expect(script).toContain('/home/tenki');
    // Renaming, moving or deleting the platform account would break Tenki's own
    // guest agent. Adding a supplementary group (`usermod -aG docker`) is fine,
    // so this guards the destructive forms specifically.
    expect(script).not.toMatch(/usermod\s+-l\b|usermod\s[^\n]*\s-m\b|groupmod\s+-n\b|userdel/);
  });

  it('creates /workspace, which the base image lacks', () => {
    expect(script).toContain('/workspace');
  });

  it('creates a vscode alias user, which the credential seed requires', () => {
    // The provider SDK's inlined credential seed extracts with an in-shell
    // `sudo -u vscode`. Without a real `vscode` account the seed fails with
    // "sudo: unknown user vscode" and every box starts logged out — the failure
    // is only visible in the create log, so guard it here.
    const byName = new Map(plan.map((s) => [s.name, s]));
    const step = byName.get('vscode-user');
    expect(step, 'vscode-user step').toBeDefined();
    expect(step!.root).toBe(true); // useradd needs it
    expect(step!.command).toContain('useradd');
    // An ALIAS of the box user (-o permits the duplicate uid), so seeded files
    // are owned by the user the agents actually run as.
    expect(step!.command).toContain('-o -u');
    expect(step!.command).toContain('/home/tenki');
    // Must exist before anything tries to sudo to it.
    expect(stepNames.indexOf('vscode-user')).toBeLessThan(stepNames.indexOf('verify'));
  });

  it('bakes the credential pivot the create-time seed depends on', () => {
    // AgentBox's cloud scaffold uploads per-agent credentials into
    // ~/.agentbox-creds/<agent>/ at create time. These symlinks are what make the
    // agents read them — without the layout, credentials land somewhere nothing
    // consults and every box starts logged out, with no error to explain why.
    const byName = new Map(plan.map((s) => [s.name, s]));
    const step = byName.get('agent-dirs');
    expect(step, 'agent-dirs step').toBeDefined();
    const cmd = step!.command;
    for (const agent of ['claude', 'codex', 'opencode']) {
      expect(cmd).toContain(`/home/tenki/.agentbox-creds/${agent}`);
    }
    expect(cmd).toContain('/home/tenki/.claude/.credentials.json');
    expect(cmd).toContain('/home/tenki/.codex/auth.json');
    expect(cmd).toContain('/home/tenki/.local/share/opencode/auth.json');
    // `~/.claude.json` -> `~/.claude/_claude.json`: the static-config tarball
    // ships the host's claude.json as _claude.json inside .claude/.
    expect(cmd).toContain('/home/tenki/.claude.json');
  });

  it('runs the pivot as the box user, after the runtime is installed', () => {
    const byName = new Map(plan.map((s) => [s.name, s]));
    // Unprivileged: it only writes inside the box user's own home, and running as
    // root would leave root-owned dotfiles the agents can't write.
    expect(byName.get('agent-dirs')?.root).toBeUndefined();
    // It copies the setup guide, which the runtime-assets step installs.
    expect(stepNames.indexOf('agent-dirs')).toBeGreaterThan(stepNames.indexOf('runtime-assets'));
  });

  it('seeds the in-box setup skill', () => {
    const cmd = plan.find((s) => s.name === 'agent-dirs')!.command;
    expect(cmd).toContain('/usr/local/share/agentbox/setup-guide.md');
    expect(cmd).toContain('skills/agentbox-setup/SKILL.md');
  });

  it('chowns last, after everything has been installed', () => {
    // Steps run as root, so ownership has to come last or root-owned files are
    // left behind in the box user's home.
    expect(stepNames.indexOf('ownership')).toBeGreaterThan(stepNames.indexOf('coding-agents'));
    expect(stepNames.indexOf('ownership')).toBeGreaterThan(stepNames.indexOf('runtime-assets'));
  });

  it('verifies the runtime after installing it, as the final step', () => {
    // Better to fail the bake than to pin a snapshot that can't supervise a box.
    expect(stepNames.at(-1)).toBe('verify');
    const verify = plan.at(-1)!.command;
    expect(verify).toContain('agentbox-ctl');
    expect(verify).toContain('tmux');
  });

  it('cleans the staged uploads out of the snapshot', () => {
    // Whatever is left on disk when the snapshot is taken ships in every box.
    expect(script).toContain(`rm -f "${stagedAssetPath(PREPARE_ASSETS[0]!.shared)}"`);
  });
});
