// NoeLocalAgentProbe — 探测本机可委托的 AI agent CLI（claude / codex / minimax / ollama）。
//
// 让 Noe 知道「本机当前能把任务委托给谁」，而非硬编码假设某个 CLI 一定在。
// 与现有 *SpawnAdapter 一脉相承：spawn 不解析 shell alias，需 `which` resolve 绝对路径
// （见 ClaudeSpawnAdapter.js Z-05 fix）。
//
// 纯聚合逻辑 + 注入探测器（detect 注入 → 单测不依赖真实 CLI）；默认探测器用 spawnSync。
// 探测只读、不启动 agent、不烧配额；接 adapters 注册 / 委托路由的 live 路径见波次6。

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

/** 本机候选 AI agent（id 对齐现有 *SpawnAdapter）。 */
export const DEFAULT_AGENT_CANDIDATES = [
  { id: 'claude', command: 'claude', versionArgs: ['--version'], kind: 'coding' },
  { id: 'codex', command: 'codex', versionArgs: ['--version'], kind: 'coding' },
  { id: 'minimax', command: 'minimax', versionArgs: ['--version'], kind: 'multimodal' },
  { id: 'ollama', command: 'ollama', versionArgs: ['--version'], kind: 'local-llm' },
];

/**
 * 解析 --version 输出取版本行。纯逻辑可单测。
 * 优先第一个非 warning/error 行（claude/codex/minimax 正常输出）；
 * 全是 warning 时（如 ollama daemon 未起会把告警打到 stderr）退而抠出版本号子串。
 */
export function parseVersionOutput(stdout = '', stderr = '') {
  const lines = (String(stdout) + '\n' + String(stderr)).split('\n').map((s) => s.trim()).filter(Boolean);
  const clean = lines.find((l) => !/^(warning|error)/i.test(l));
  if (clean) return clean.slice(0, 120);
  const m = lines.join(' ').match(/\d+\.\d+(?:\.\d+)?/);
  return (m ? m[0] : (lines[0] || '')).slice(0, 120);
}

/**
 * 默认探测器：which resolve 绝对路径 + 取版本。有副作用（spawnSync），仅作 detect 注入用，
 * 聚合逻辑层不直接调用——故 probeLocalAgents 可纯逻辑单测。
 */
export function makeCliDetector({ env = process.env, timeoutMs = 3000 } = {}) {
  return function detect(command, versionArgs = ['--version']) {
    let path = '';
    try {
      const w = spawnSync('which', [command], { encoding: 'utf-8', env, timeout: timeoutMs });
      path = String(w.stdout || '').trim().split('\n')[0] || '';
    } catch { path = ''; }
    if (!path || !existsSync(path)) return { found: false, path: '', version: '' };
    let version = '';
    try {
      const v = spawnSync(path, versionArgs, { encoding: 'utf-8', env, timeout: timeoutMs });
      version = parseVersionOutput(v.stdout, v.stderr);
    } catch { version = ''; }
    return { found: true, path, version };
  };
}

/**
 * 探测候选 agent，聚合可用清单。纯逻辑（探测注入）。
 * @param {Array} [candidates] 候选清单（默认 DEFAULT_AGENT_CANDIDATES）
 * @param {object} opts
 * @param {(command:string, versionArgs:string[])=>{found:boolean,path:string,version:string}} opts.detect 注入探测器
 * @returns {{agents:Array<{id,command,kind,available,path,version}>, available:string[], counts:{total:number,available:number}}}
 */
export function probeLocalAgents(candidates = DEFAULT_AGENT_CANDIDATES, { detect } = {}) {
  if (typeof detect !== 'function') throw new TypeError('probeLocalAgents 需注入 detect 探测器');
  const list = Array.isArray(candidates) ? candidates : [];
  const agents = list.filter((c) => c && c.id).map((c) => {
    const r = detect(c.command, c.versionArgs || ['--version']) || {};
    return {
      id: c.id,
      command: c.command,
      kind: c.kind || 'unknown',
      available: !!r.found,
      path: r.path || '',
      version: r.version || '',
    };
  });
  const available = agents.filter((a) => a.available).map((a) => a.id);
  return { agents, available, counts: { total: agents.length, available: available.length } };
}
