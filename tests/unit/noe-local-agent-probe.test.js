import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AGENT_CANDIDATES,
  probeLocalAgents,
  parseVersionOutput,
} from '../../src/autopilot/NoeLocalAgentProbe.js';

describe('probeLocalAgents', () => {
  it('聚合探测结果，available 只含 found 的', () => {
    const detect = (cmd) => cmd === 'claude'
      ? { found: true, path: '/usr/bin/claude', version: 'claude 1.2.3' }
      : { found: false, path: '', version: '' };
    const r = probeLocalAgents([
      { id: 'claude', command: 'claude', kind: 'coding' },
      { id: 'codex', command: 'codex', kind: 'coding' },
    ], { detect });
    expect(r.available).toEqual(['claude']);
    expect(r.counts).toEqual({ total: 2, available: 1 });
    expect(r.agents[0]).toMatchObject({ id: 'claude', available: true, path: '/usr/bin/claude', version: 'claude 1.2.3' });
    expect(r.agents[1]).toMatchObject({ id: 'codex', available: false, path: '', version: '' });
  });

  it('全部可用', () => {
    const detect = () => ({ found: true, path: '/x', version: 'v1' });
    const r = probeLocalAgents(DEFAULT_AGENT_CANDIDATES, { detect });
    expect(r.counts.total).toBe(4);
    expect(r.counts.available).toBe(4);
    expect(r.available).toEqual(['claude', 'codex', 'minimax', 'ollama']);
  });

  it('全部不可用', () => {
    const r = probeLocalAgents(DEFAULT_AGENT_CANDIDATES, { detect: () => ({ found: false }) });
    expect(r.available).toEqual([]);
    expect(r.counts.available).toBe(0);
  });

  it('detect 透传 command + versionArgs', () => {
    const seen = [];
    const detect = (cmd, args) => { seen.push([cmd, args]); return { found: false }; };
    probeLocalAgents([{ id: 'ollama', command: 'ollama', versionArgs: ['-v'] }], { detect });
    expect(seen).toEqual([['ollama', ['-v']]]);
  });

  it('缺 versionArgs 时默认 --version', () => {
    let got = null;
    probeLocalAgents([{ id: 'codex', command: 'codex' }], { detect: (_c, a) => { got = a; return { found: false }; } });
    expect(got).toEqual(['--version']);
  });

  it('过滤无 id 的候选', () => {
    const r = probeLocalAgents([{ command: 'x' }, { id: 'codex', command: 'codex' }, null], { detect: () => ({ found: false }) });
    expect(r.counts.total).toBe(1);
  });

  it('未注入 detect 抛错', () => {
    expect(() => probeLocalAgents()).toThrow(/detect/);
  });

  it('DEFAULT_AGENT_CANDIDATES 覆盖 claude/codex/minimax/ollama', () => {
    expect(DEFAULT_AGENT_CANDIDATES.map((c) => c.id)).toEqual(['claude', 'codex', 'minimax', 'ollama']);
  });
});

describe('parseVersionOutput', () => {
  it('正常单行原样（保留标签）', () => {
    expect(parseVersionOutput('2.1.169 (Claude Code)\n')).toBe('2.1.169 (Claude Code)');
    expect(parseVersionOutput('codex-cli 0.137.0')).toBe('codex-cli 0.137.0');
  });
  it('跳过 warning 行取干净行（stdout 优先于 stderr）', () => {
    expect(parseVersionOutput('ollama version is 0.5.1', 'Warning: could not connect')).toBe('ollama version is 0.5.1');
  });
  it('全是 warning 时抠出版本号子串', () => {
    expect(parseVersionOutput('', 'Warning: could not connect, version is 0.5.1')).toBe('0.5.1');
  });
  it('全 warning 且无版本号时退回首行', () => {
    expect(parseVersionOutput('', 'Warning: could not connect to a running Ollama instance')).toBe('Warning: could not connect to a running Ollama instance');
  });
  it('空输出 → 空串', () => {
    expect(parseVersionOutput('', '')).toBe('');
  });
});
