import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { ActStore } from '../../src/loop/ActStore.js';
import { ActPipeline } from '../../src/loop/ActPipeline.js';
import { ApprovalStore } from '../../src/approval/ApprovalStore.js';
import { createExecPolicyStore } from '../../src/permissions/ExecPolicyStore.js';
import { createPolicyAuditLog } from '../../src/audit/PolicyAuditLog.js';

let tmp;
beforeEach(() => { close(); tmp = mkdtempSync(join(tmpdir(), 'noe-act-policy-')); initSqlite(join(tmp, 'panel.db')); });
afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

function makePipeline(overrides = {}) {
  const store = new ActStore({ projectId: 'noe-test' });
  const approvalStore = new ApprovalStore({ audit: { recordSafe() {} } });
  const pipeline = new ActPipeline({
    projectId: 'noe-test',
    store,
    approvalStore,
    budget: { preflight: () => ({ ok: true, warnings: [], blocked: [] }) },
    permission: { evaluatePermission: () => ({ decision: 'allow', reason: 'test allow' }) },
    audit: { recordSafe() {} },
    broadcast: () => {},
    logger: null,
    ...overrides,
  });
  return { pipeline, store, approvalStore };
}

describe('ActPipeline × ExecPolicyStore — 解枷锁但向后兼容', () => {
  it('无 execPolicy（默认）：shell.exec 仍 blocked_safety（存量行为不变）', async () => {
    const { pipeline } = makePipeline();
    const r = await pipeline.propose({ action: 'shell.exec', payload: { command: 'node', args: ['-v'] } });
    expect(r.ok).toBe(false);
    expect(r.act.status).toBe('blocked_safety');
  });

  it('default 档（defer）：shell.exec 仍 blocked_safety', async () => {
    const { pipeline } = makePipeline({ execPolicy: createExecPolicyStore({ trustLevel: 'default' }) });
    const r = await pipeline.propose({ action: 'shell.exec', payload: { command: 'node', args: ['-v'] } });
    expect(r.act.status).toBe('blocked_safety');
  });

  it('developer 档 + 注册 executor：shell.exec 真实执行到 completed（解 L1+L2）', async () => {
    const ran = [];
    const { pipeline } = makePipeline({
      execPolicy: createExecPolicyStore({ trustLevel: 'developer' }),
      executors: { 'shell.exec': async ({ act }) => { ran.push(act.action); return { exitCode: 0, stdout: 'v22' }; } },
    });
    const r = await pipeline.propose({ action: 'shell.exec', payload: { command: 'node', args: ['-v'] } });
    expect(r.ok).toBe(true);
    expect(r.act.status).toBe('completed');
    expect(r.act.payload?.dryRunOnly).toBe(false); // 真执行，非 dry-run
    expect(ran).toEqual(['shell.exec']);
  });

  it('developer 档 + 注册 executor：noe.note.write 这类本地写入可真实执行，不再停在审批', async () => {
    const ran = [];
    const { pipeline } = makePipeline({
      execPolicy: createExecPolicyStore({ trustLevel: 'developer' }),
      executors: { 'noe.note.write': async ({ act }) => { ran.push(act.action); return { path: 'output/noe-autonomy/learning.md', append: true }; } },
    });
    const r = await pipeline.propose({ action: 'noe.note.write', payload: { path: 'output/noe-autonomy/learning.md', content: '学习笔记' } });
    expect(r.ok).toBe(true);
    expect(r.act.status).toBe('completed');
    expect(r.act.payload?.dryRunOnly).toBe(false);
    expect(ran).toEqual(['noe.note.write']);
  });

  it('developer 档 + 注册 executor：browser.dom 动作可真实执行，供目标系统操控浏览器', async () => {
    const ran = [];
    const { pipeline } = makePipeline({
      execPolicy: createExecPolicyStore({ trustLevel: 'developer' }),
      executors: { 'browser.click': async ({ act }) => { ran.push(act.action); return { ok: true, actions: [{ clicked: true }] }; } },
    });
    const r = await pipeline.propose({ action: 'browser.click', riskLevel: 'high', payload: { selector: '#next' } });
    expect(r.ok).toBe(true);
    expect(r.act.status).toBe('completed');
    expect(r.act.payload?.dryRunOnly).toBe(false);
    expect(ran).toEqual(['browser.click']);
  });

  it('developer 档 + 注册 executor：AppleScript/JXA 桌面自动化可真实执行', async () => {
    const ran = [];
    const { pipeline } = makePipeline({
      execPolicy: createExecPolicyStore({ trustLevel: 'developer' }),
      executors: { 'macos.applescript.run': async ({ act }) => { ran.push(act.action); return { exitCode: 0, stdout: 'Google Chrome' }; } },
    });
    const r = await pipeline.propose({
      action: 'macos.applescript.run',
      riskLevel: 'high',
      payload: { script: 'tell application "System Events" to get name of first process whose frontmost is true' },
    });
    expect(r.ok).toBe(true);
    expect(r.act.status).toBe('completed');
    expect(r.act.payload?.dryRunOnly).toBe(false);
    expect(ran).toEqual(['macos.applescript.run']);
  });

  it('developer/unrestricted 档：network.upload 不再被 policy deny，可真实执行', async () => {
    const ran = [];
    const { pipeline } = makePipeline({
      execPolicy: createExecPolicyStore({ trustLevel: 'unrestricted' }),
      executors: { 'network.upload': async ({ act }) => { ran.push(act.action); return { ok: true, uploaded: true }; } },
    });
    const r = await pipeline.propose({ action: 'network.upload', payload: { url: 'https://x.com' } });
    expect(r.ok).toBe(true);
    expect(r.act.status).toBe('completed');
    expect(r.act.payload?.dryRunOnly).toBe(false);
    expect(ran).toEqual(['network.upload']);
  });

  it('developer 档：network.external_post 不再 awaiting_approval，可真实执行', async () => {
    const ran = [];
    const { pipeline } = makePipeline({
      execPolicy: createExecPolicyStore({ trustLevel: 'developer' }),
      executors: { 'network.external_post': async ({ act }) => { ran.push(act.action); return { ok: true, posted: true }; } },
    });
    const r = await pipeline.propose({ action: 'network.external_post', payload: { url: 'https://api.x.com' } });
    expect(r.ok).toBe(true);
    expect(r.act.status).toBe('completed');
    expect(r.act.payload?.dryRunOnly).toBe(false);
    expect(ran).toEqual(['network.external_post']);
  });

  it('改 Noe 自身安全栈文件：unrestricted 也被策略文件守卫阻断', async () => {
    const ran = [];
    const { pipeline } = makePipeline({
      execPolicy: createExecPolicyStore({ trustLevel: 'unrestricted' }),
      executors: { 'file.move.bulk': async ({ act }) => { ran.push(act.action); return { moved: 1 }; } },
    });
    const r = await pipeline.propose({ action: 'file.move.bulk', payload: { path: 'src/permissions/PermissionGovernance.js' } });
    expect(r.ok).toBe(false);
    expect(r.act.status).toBe('blocked_safety');
    expect(r.act.failureReason).toBe('noe_policy_file_mutation_denied');
    expect(r.act.payload?.permission?.target?.execPolicy?.reason).toBe('noe_policy_file_mutation_denied');
    expect(ran).toEqual([]);
  });

  it('/yolo 会话有界放行：开启后 shell.exec 执行，未开启的 session 仍 blocked', async () => {
    const execPolicy = createExecPolicyStore({ trustLevel: 'default' });
    const { pipeline } = makePipeline({
      execPolicy,
      executors: { 'shell.exec': async () => ({ exitCode: 0 }) },
    });
    // 未开 yolo
    const before = await pipeline.propose({ action: 'shell.exec', payload: { command: 'ls', sessionId: 's1' } });
    expect(before.act.status).toBe('blocked_safety');
    // 开 yolo 后
    execPolicy.startYolo({ sessionId: 's1', ttlMs: 60_000 });
    const after = await pipeline.propose({ action: 'shell.exec', payload: { command: 'ls', args: [], sessionId: 's1' } });
    expect(after.act.status).toBe('completed');
  });

  it('policyAudit 记录每次策略决策', async () => {
    const lines = [];
    const policyAudit = createPolicyAuditLog({ writer: (l) => lines.push(l), now: () => 42 });
    const { pipeline } = makePipeline({
      execPolicy: createExecPolicyStore({ trustLevel: 'developer' }),
      policyAudit,
      executors: { 'shell.exec': async () => ({ exitCode: 0 }) },
    });
    await pipeline.propose({ action: 'shell.exec', payload: { command: 'node' } });
    expect(lines.length).toBeGreaterThan(0);
    const rec = JSON.parse(lines[0]);
    expect(rec.action).toBe('shell.exec');
    expect(rec.decision).toBe('allow');
    expect(rec.trustLevel).toBe('developer');
  });
});
