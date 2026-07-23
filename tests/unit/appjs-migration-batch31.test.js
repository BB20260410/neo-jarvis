// @ts-check
// 第三波手术 第31批 结构级防回归：server.js 主矿——claude-runner 子系统出仓
// （diff 格式化 / 思维镜机制 helpers / pushMessage/broadcastSession / 权限评估拦截 /
//   killChildAndUnbusy / sendMessageToClaude 401 行单函数）迁出
// src/server/services/claude-runner.js + claude-runner-support.js（<500 行硬规则拆两文件）。
// 工厂注入：sessions/claudeBin/debouncedSave/approvalStore/permissionGovernance/activityLog/
// getWatcherDispatcher（watcherDispatcher 是 server.js 的 let，经 getter 注入，S23 先例）。
// 行为冒烟不烧配额：claudeBin 指向假可执行脚本（吐 stream-json），走通 spawn→流解析→exit 全链路。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createClaudeRunner } from '../../src/server/services/claude-runner.js';
import { createClaudeRunnerSupport, formatEditDiff, naiveDiff } from '../../src/server/services/claude-runner-support.js';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const SERVER_FILE = 'server.js';
const RUNNER_FILE = 'src/server/services/claude-runner.js';
const SUPPORT_FILE = 'src/server/services/claude-runner-support.js';

function makeFakeWs(sink) {
  return { readyState: 1, send: (s) => sink.push(JSON.parse(s)) };
}
function makeSupport(overrides = {}) {
  return createClaudeRunnerSupport({
    approvalStore: {},
    permissionGovernance: { evaluatePermission: () => ({ decision: 'allow' }) },
    debouncedSave: () => {},
    ...overrides,
  });
}

describe('server.js 拆分第31批（claude-runner 出仓）— 结构', () => {
  const serverSrc = read(SERVER_FILE);
  const runnerSrc = read(RUNNER_FILE);
  const supportSrc = read(SUPPORT_FILE);

  it('两个新模块均 <500 行（工程硬规则）+ @ts-check 头 + 注入式工厂', () => {
    expect(runnerSrc.split('\n').length, `${RUNNER_FILE} 行数超标`).toBeLessThan(500);
    expect(supportSrc.split('\n').length, `${SUPPORT_FILE} 行数超标`).toBeLessThan(500);
    expect(runnerSrc.startsWith('// @ts-check')).toBe(true);
    expect(supportSrc.startsWith('// @ts-check')).toBe(true);
    expect(runnerSrc).toContain('export function createClaudeRunner({');
    expect(supportSrc).toContain('export function createClaudeRunnerSupport({ approvalStore, permissionGovernance, debouncedSave })');
  });

  it('server.js：实现全部出仓，不再内联（函数体 / 实例 new 均不残留）', () => {
    for (const gone of [
      'function sendMessageToClaude',
      'function broadcastSession',
      'function pushMessage',
      'function killChildAndUnbusy',
      'function evaluateClaudeToolPermission',
      'function blockClaudeToolUseByPermission',
      'function naiveDiff',
      'function ensureGuard',
      'function recordDanger',
      'function ensureCostTracker',
      'new DangerousPatternDetector',
      'new TerminalApprovalGate',
      'MESSAGES_CAP',
      'STDOUT_BUF_MAX',
    ]) {
      expect(serverSrc, `server.js 残留 ${gone}`).not.toContain(gone);
    }
  });

  it('server.js：工厂 import + 解构接线（sendMessageToClaude/broadcastSession/sharedDetector/terminalApprovalGate）', () => {
    expect(serverSrc).toContain("import { createClaudeRunner } from './src/server/services/claude-runner.js';");
    expect(serverSrc).toContain('} = createClaudeRunner({');
    expect(serverSrc).toContain('claudeBin: CLAUDE_BIN,');
    // watcherDispatcher let 经 getter 注入：S23 既有 2 处 + 本批工厂 1 处 ≥ 3
    expect(serverSrc.match(/getWatcherDispatcher: \(\) => watcherDispatcher,/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('server.js：既有使用点全保留（sessions 路由注入 / hooks / dispatcher / WS 终端审批门）', () => {
    expect(serverSrc).toContain('sendMessageToClaude,');
    expect(serverSrc).toContain('registerHooksRoutes(app, { sessions, broadcastSession, safeSlice });');
    expect(serverSrc).toContain('broadcastFn: (session, msg) => broadcastSession(session, msg),');
    expect(serverSrc).toContain('dangerDetector: sharedDetector,');
    expect(serverSrc).toContain('terminalApprovalGate.processInput');
  });

  it('server.js：随迁 import 已精简（spawn/LoopGuard/Detector/FocusChain/StateMachine/CostTracker/审批门/上下文包/运行时默认）', () => {
    expect(serverSrc).toContain("import { spawnSync as _spawnSyncForBin } from 'child_process';");
    expect(serverSrc).not.toContain('import { spawn,');
    for (const gone of [
      "from './src/safety/LoopGuard.js'",
      "from './src/safety/DangerousPatternDetector.js'",
      "from './src/planner/FocusChain.js'",
      "from './src/state/AgentStateMachine.js'",
      "from './src/cost/CostTracker.js'",
      "from './src/approval/CommandApprovalGate.js'",
      "from './src/context/ProjectContextBundle.js'",
      "from './src/room/ClaudeRuntimeDefaults.js'",
    ]) {
      expect(serverSrc, `server.js import 残留 ${gone}`).not.toContain(gone);
    }
  });

  it('行为契约关键字留在模块（原文迁移零改动的抽查指纹）', () => {
    for (const kept of [
      "'--dangerously-skip-permissions',",
      "'--include-partial-messages',",
      "args.push('--resume', session.claudeSessionId);",
      'const STDOUT_BUF_MAX = 50 * 1024 * 1024;',
      "if (session.archived) return { ok: false, error: 'archived', message: '会话已归档' };",
      'applyClaudeOpus48RuntimeDefaults(args, session.model);',
      'const watcherDispatcher = getWatcherDispatcher();',
    ]) {
      expect(runnerSrc, `runner 丢失 ${kept}`).toContain(kept);
    }
    expect(supportSrc).toContain('const MESSAGES_CAP = 200;');
    expect(supportSrc).toContain(', 2000);'); // SIGKILL 看门狗 2s
    expect(supportSrc).toContain("msg.type === 'message' || msg.type === 'partial_delta'");
  });
});

describe('server.js 拆分第31批 — 支撑层行为冒烟（纯 fake，零配额）', () => {
  it('pushMessage：超 200 条 cap + starredIndices 偏移映射 + 广播 messages_capped', () => {
    const sent = [];
    const { pushMessage } = makeSupport();
    const session = {
      messages: Array.from({ length: 200 }, (_, i) => ({ i })),
      starredIndices: [0, 5, 199],
      clients: new Set([makeFakeWs(sent)]),
    };
    pushMessage(session, { i: 200 });
    expect(session.messages.length).toBe(200);
    expect(session.messages[0]).toEqual({ i: 1 });
    expect(session.starredIndices).toEqual([4, 198]); // 0 越界丢弃，5→4，199→198
    expect(sent.some(m => m.type === 'messages_capped' && m.removed === 1)).toBe(true);
  });

  it('broadcastSession：_dropOutput 丢内容类（message/partial_*）保状态类（busy）', () => {
    const sent = [];
    const { broadcastSession } = makeSupport();
    const session = { _dropOutput: true, clients: new Set([makeFakeWs(sent)]) };
    broadcastSession(session, { type: 'message', message: { content: 'x' } });
    broadcastSession(session, { type: 'partial_delta', textDelta: 'y' });
    broadcastSession(session, { type: 'busy', busy: false });
    expect(sent.map(m => m.type)).toEqual(['busy']);
  });

  it('killChildAndUnbusy：SIGTERM + busy 复位广播 + 2s SIGKILL 看门狗', () => {
    vi.useFakeTimers();
    try {
      const sent = [];
      const { killChildAndUnbusy } = makeSupport();
      const signals = [];
      const child = { killed: false, kill: (sig) => signals.push(sig) };
      const session = { busy: true, clients: new Set([makeFakeWs(sent)]) };
      killChildAndUnbusy(session, child);
      expect(signals).toEqual(['SIGTERM']);
      expect(session.busy).toBe(false);
      expect(sent.some(m => m.type === 'busy' && m.busy === false)).toBe(true);
      vi.advanceTimersByTime(2100);
      expect(signals).toEqual(['SIGTERM', 'SIGKILL']); // child.killed 仍 false → 看门狗补刀
    } finally {
      vi.useRealTimers();
    }
  });

  it('blockClaudeToolUseByPermission：kill + dangerHistory + permission_blocked 广播 + busy 复位', () => {
    const sent = [];
    let saves = 0;
    const { blockClaudeToolUseByPermission } = makeSupport({ debouncedSave: () => { saves++; } });
    const signals = [];
    const session = { id: 's', busy: true, messages: [], clients: new Set([makeFakeWs(sent)]) };
    const child = { kill: (sig) => signals.push(sig) };
    const permission = { decision: 'deny', risk: 'high', action: 'shell.exec', reason: '禁区', id: 'p1', target: {} };
    blockClaudeToolUseByPermission(session, child, { name: 'Bash' }, permission);
    expect(signals).toEqual(['SIGTERM']);
    expect(session.dangerHistory?.length).toBe(1);
    expect(sent.some(m => m.type === 'permission_blocked')).toBe(true);
    expect(sent.some(m => m.type === 'danger_blocked')).toBe(true);
    expect(session.messages[0].content).toContain('权限治理已暂停工具执行');
    expect(saves).toBe(1);
    expect(session.busy).toBe(false);
  });

  it('diff 格式化纯函数原样可用', () => {
    expect(naiveDiff('a', 'b')).toBe('- a\n+ b');
    expect(formatEditDiff({ file_path: 'x.js', old_string: 'a', new_string: 'b' })).toContain('```diff');
  });
});

describe('server.js 拆分第31批 — sendMessageToClaude 全链路冒烟（假 claude bin，零配额）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'noe-batch31-'));
  afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不阻断 */ } });

  // 假 claude：读完 stdin 后按 stream-json 协议吐 system/assistant/result 三行，退出码 0
  const fakeBin = join(dir, 'fake-claude.mjs');
  writeFileSync(fakeBin, [
    '#!/usr/bin/env node',
    "let buf = '';",
    "process.stdin.on('data', (d) => { buf += d; });",
    "process.stdin.on('end', () => {",
    "  console.log(JSON.stringify({ type: 'system', session_id: 'fake-sid-31' }));",
    "  console.log(JSON.stringify({ type: 'assistant', message: { model: 'claude-fake', content: [{ type: 'text', text: '回声OK' }] } }));",
    "  console.log(JSON.stringify({ type: 'result', usage: { input_tokens: 3, output_tokens: 2 } }));",
    '});',
    '',
  ].join('\n'), { mode: 0o755 });

  function makeRunner(extra = {}) {
    const sessions = new Map();
    const sent = [];
    let saves = 0;
    const runner = createClaudeRunner({
      sessions,
      claudeBin: fakeBin,
      debouncedSave: () => { saves++; },
      approvalStore: {},
      permissionGovernance: { evaluatePermission: () => ({ decision: 'allow' }) },
      activityLog: { recordSafe: () => {} },
      getWatcherDispatcher: () => null,
      ...extra,
    });
    return { sessions, sent, runner, getSaves: () => saves };
  }

  it('archived / busy 前置卫兵：不 spawn 直接返回错误', () => {
    const { runner } = makeRunner();
    expect(runner.sendMessageToClaude({ archived: true }, 'x')).toEqual({ ok: false, error: 'archived', message: '会话已归档' });
    const busyRet = runner.sendMessageToClaude({ archived: false, busy: true }, 'x');
    expect(busyRet.ok).toBe(false);
    expect(busyRet.error).toBe('busy');
  });

  it('真 spawn 假 bin 走通全链路：busy 翻转 / claudeSessionId 捕获 / 消息入列广播 / cost_update / exit 复位', async () => {
    const { sessions, sent, runner, getSaves } = makeRunner();
    const session = {
      id: 's31', cwd: dir, archived: false, busy: false,
      messages: [], clients: new Set([makeFakeWs(sent)]),
      // projectContextPrimed 置 true 跳过上下文包注入，聚焦 runner 链路本身
      projectContextPrimed: true, handoffPrimed: true,
    };
    sessions.set('s31', session);
    const ret = runner.sendMessageToClaude(session, '你好');
    expect(ret).toEqual({ ok: true });
    expect(session.busy).toBe(true);
    expect(session.pid).toBeGreaterThan(0);
    expect(sent.some(m => m.type === 'busy' && m.busy === true)).toBe(true);
    // user 消息立即入列 + 广播 + 持久化去抖
    expect(session.messages[0]).toMatchObject({ role: 'user', content: '你好' });
    expect(getSaves()).toBeGreaterThanOrEqual(1);

    await vi.waitFor(() => { expect(session.busy).toBe(false); }, { timeout: 8000, interval: 50 });

    expect(session.claudeSessionId).toBe('fake-sid-31');
    expect(session.model).toBe('claude-fake');
    const assistant = session.messages.find(m => m.role === 'assistant');
    expect(assistant?.content).toBe('回声OK');
    expect(sent.some(m => m.type === 'message' && m.message?.role === 'assistant')).toBe(true);
    expect(sent.some(m => m.type === 'cost_update')).toBe(true);
    const lastBusy = sent.filter(m => m.type === 'busy').pop();
    expect(lastBusy).toMatchObject({ busy: false, exitCode: 0 });
    expect(session.child).toBe(null);
  });

  it('LoopGuard 前置卫兵：同文本连发触发 loop_guard_break，不 spawn', () => {
    const { sent, runner } = makeRunner();
    const session = {
      id: 'sg', cwd: dir, archived: false, busy: false,
      messages: [], clients: new Set([makeFakeWs(sent)]),
      projectContextPrimed: true, handoffPrimed: true,
      // 直接预置 guard 假体：recordInstruction 返回 break 理由
      guard: { recordInstruction: () => ({ rule: 'identical_instruction', detail: '测试' }) },
    };
    const ret = runner.sendMessageToClaude(session, '同一句');
    expect(ret.ok).toBe(false);
    expect(ret.error).toBe('loop_guard_break');
    expect(session.loopGuardHistory?.length).toBe(1);
    expect(sent.some(m => m.type === 'loop_guard_break')).toBe(true);
    expect(session.busy).toBeFalsy();
  });
});
