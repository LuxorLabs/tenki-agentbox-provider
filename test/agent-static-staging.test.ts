/**
 * Per-agent isolation of host agent static staging.
 *
 * `stageAllAgentStatic` stages every agent under one `Promise.all`, so one
 * unreadable file in one agent's config rejects the whole call. The bake must
 * still carry every other agent's config.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentStaticStage } from '@madarco/agentbox-provider-sdk';

interface Call {
  agents?: readonly string[];
}

function stage(kind: string, cleaned: string[]): AgentStaticStage {
  return {
    kind,
    extractDir: `/home/vscode/.${kind}`,
    staged: {
      tarballPath: `/tmp/${kind}.tar.gz`,
      warnings: [],
      cleanup: () => {
        cleaned.push(kind);
        return Promise.resolve();
      },
    },
  };
}

async function load(failing: { all: boolean; agents: string[] }) {
  vi.resetModules();
  const calls: Call[] = [];
  const cleaned: string[] = [];
  vi.doMock('@madarco/agentbox-provider-sdk', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@madarco/agentbox-provider-sdk')>();
    return {
      ...actual,
      stageAllAgentStatic: (opts: Call = {}) => {
        calls.push(opts);
        if (!opts.agents) {
          if (failing.all) return Promise.reject(new Error('rsync exited 23\nmore detail'));
          return Promise.resolve([stage('claude', cleaned), stage('agents', cleaned)]);
        }
        const id = opts.agents[0]!;
        if (failing.agents.includes(id)) return Promise.reject(new Error(`${id} unreadable`));
        return Promise.resolve([stage(id, cleaned), stage('agents', cleaned)]);
      },
    };
  });
  const { stageHostAgentStatic } = await import('../src/prepare.js');
  return { stageHostAgentStatic, calls, cleaned };
}

afterEach(() => {
  vi.resetModules();
  vi.doUnmock('@madarco/agentbox-provider-sdk');
});

describe('stageHostAgentStatic', () => {
  it('stages every agent in one call when nothing fails', async () => {
    const { stageHostAgentStatic, calls } = await load({ all: false, agents: [] });
    const stages = await stageHostAgentStatic(undefined, ['claude', 'codex'], () => {});
    expect(calls).toHaveLength(1);
    expect(stages.map((s) => s.kind)).toEqual(['claude', 'agents']);
  });

  it('skips only the failing agent when the combined call rejects', async () => {
    const { stageHostAgentStatic, calls } = await load({ all: true, agents: ['codex'] });
    const log: string[] = [];
    const stages = await stageHostAgentStatic('/work', ['claude', 'codex', 'opencode'], (l) =>
      log.push(l),
    );
    expect(stages.map((s) => s.kind)).toEqual(['claude', 'agents', 'opencode']);
    expect(calls.slice(1)).toEqual([
      { hostWorkspace: '/work', agents: ['claude'] },
      { hostWorkspace: '/work', agents: ['codex'] },
      { hostWorkspace: '/work', agents: ['opencode'] },
    ]);
    expect(log).toEqual([
      'WARNING: could not stage host agent config (rsync exited 23) — retrying one agent at a time',
      'WARNING: could not stage codex config (codex unreadable) — continuing without it',
    ]);
  });

  it('keeps one copy of the shared ~/.agents stage and cleans up the rest', async () => {
    const { stageHostAgentStatic, cleaned } = await load({ all: true, agents: [] });
    const stages = await stageHostAgentStatic(undefined, ['claude', 'codex', 'opencode'], () => {});
    expect(stages.filter((s) => s.kind === 'agents')).toHaveLength(1);
    expect(cleaned).toEqual(['agents', 'agents']);
  });

  it('continues without config when the agent ids are unknown', async () => {
    const { stageHostAgentStatic, calls } = await load({ all: true, agents: [] });
    const log: string[] = [];
    const stages = await stageHostAgentStatic(undefined, [], (l) => log.push(l));
    expect(stages).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(log).toEqual([
      'WARNING: could not stage host agent config (rsync exited 23) — continuing without it',
    ]);
  });
});
