import { describe, expect, it } from 'vitest';
import { budgetPreflight, contextSufficiencyPreflight, permissionPreflight } from '../../src/loop/ActPipelinePreflight.js';

// ActPipelinePreflight 是 ActPipeline 私有方法的外提（2026-06-11 500 行门拆分），
// 行为级回归由 noe-act-pipeline*.test.js 三套件经 process() 覆盖；
// 本文件直接函数级测三个导出入口的分支，mock 最小 pipeline 对象。

function basePipeline(overrides = {}) {
  return {
    projectId: 'noe',
    budget: null,
    permission: null,
    approvalStore: null,
    execPolicy: null,
    policyAudit: null,
    logger: { warn() {} },
    selfEvolutionRoot: '/tmp',
    contextSufficiency: () => ({ ok: true, sufficient: true }),
    ...overrides,
  };
}

function makeAct(overrides = {}) {
  return { id: 'act-1', title: '测试act', action: 'noe.focus.review', riskLevel: 'low', payload: {}, ...overrides };
}

describe('budgetPreflight', () => {
  it('无 budget 注入时直接放行', () => {
    const r = budgetPreflight(basePipeline(), makeAct());
    expect(r).toEqual({ ok: true, warnings: [], blocked: [] });
  });

  it('budget 返回 blocked 时拦截并拼出 metric 错误', () => {
    const pipeline = basePipeline({ budget: { preflight: () => ({ ok: false, blocked: [{ metric: 'usd_day' }], warnings: [] }) } });
    const r = budgetPreflight(pipeline, makeAct());
    expect(r.ok).toBe(false);
    expect(r.error).toContain('usd_day');
  });

  it('budget 抛 BUDGET_LIMIT_EXCEEDED 时按预算拦截处理', () => {
    const err = Object.assign(new Error('超预算'), { code: 'BUDGET_LIMIT_EXCEEDED', blocked: [{ metric: 'usd' }] });
    const pipeline = basePipeline({ budget: { preflight: () => { throw err; } } });
    const r = budgetPreflight(pipeline, makeAct());
    expect(r.ok).toBe(false);
    expect(r.error).toBe('超预算');
    expect(r.blocked).toEqual([{ metric: 'usd' }]);
  });

  it('warnings 透传且不拦截', () => {
    const pipeline = basePipeline({ budget: { preflight: () => ({ ok: true, warnings: ['接近上限'], blocked: [] }) } });
    const r = budgetPreflight(pipeline, makeAct());
    expect(r.ok).toBe(true);
    expect(r.warnings).toEqual(['接近上限']);
  });
});

describe('permissionPreflight', () => {
  it('低风险动作无 permission 注入时默认 allow', () => {
    const r = permissionPreflight(basePipeline(), makeAct());
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('dry-run act allowed');
  });

  it('破坏性动作无 execPolicy 时落 blocked_safety（CE12 原行为）', () => {
    const r = permissionPreflight(basePipeline(), makeAct({ action: 'file.delete', riskLevel: 'critical' }));
    expect(r.blockedSafety).toBe(true);
    expect(r.reason).toContain('blocked in CE12');
  });

  it('破坏性动作经 execPolicy allow 放行并写 policy 审计', () => {
    const audits = [];
    const pipeline = basePipeline({
      execPolicy: { evaluate: () => ({ decision: 'allow', capability: 'fs.delete', reason: '信任档放行' }) },
      policyAudit: { recordSafe: (entry) => audits.push(entry) },
    });
    const r = permissionPreflight(pipeline, makeAct({ action: 'file.delete', riskLevel: 'critical' }));
    expect(r.decision).toBe('allow');
    expect(r.viaPolicy).toBe(true);
    expect(r.capability).toBe('fs.delete');
    expect(audits).toHaveLength(1);
    expect(audits[0].event).toBe('noe.act.policy');
  });

  it('破坏性动作经 execPolicy deny 直接拒绝', () => {
    const pipeline = basePipeline({ execPolicy: { evaluate: () => ({ decision: 'deny', reason: '永远拒绝清单' }) } });
    const r = permissionPreflight(pipeline, makeAct({ action: 'shell.exec', riskLevel: 'critical' }));
    expect(r.blockedSafety).toBe(true);
    expect(r.viaPolicy).toBe(true);
    expect(r.reason).toBe('永远拒绝清单');
  });

  it('破坏性动作经 execPolicy ask 走审批创建', () => {
    const created = [];
    const pipeline = basePipeline({
      execPolicy: { evaluate: () => ({ decision: 'ask', reason: '需要确认' }) },
      approvalStore: { createApproval: (req) => { created.push(req); return { id: 'ap-1', status: 'pending' }; } },
    });
    const r = permissionPreflight(pipeline, makeAct({ action: 'network.upload', riskLevel: 'critical' }));
    expect(r.requiresApproval).toBe(true);
    expect(r.approval?.id).toBe('ap-1');
    expect(created).toHaveLength(1);
  });

  it('高风险非破坏动作需要 owner 审批', () => {
    const pipeline = basePipeline({ approvalStore: { createApproval: () => ({ id: 'ap-2', status: 'pending' }) } });
    const r = permissionPreflight(pipeline, makeAct({ action: 'noe.note.write', riskLevel: 'high' }));
    expect(r.requiresApproval).toBe(true);
    expect(r.decision).toBe('ask');
    expect(r.approval?.id).toBe('ap-2');
  });

  it('高风险动作带已批准 approvalId 且 action 匹配时放行', () => {
    const pipeline = basePipeline({
      approvalStore: { getApproval: () => ({ id: 'ap-3', status: 'approved', payload: { action: 'noe.note.write' } }) },
    });
    const r = permissionPreflight(pipeline, makeAct({ action: 'noe.note.write', riskLevel: 'high' }), { approvalId: 'ap-3' });
    expect(r.decision).toBe('allow');
    expect(r.reason).toContain('ap-3');
  });

  it('approval 的 action 与 act 不匹配时拒绝', () => {
    const pipeline = basePipeline({
      approvalStore: { getApproval: () => ({ id: 'ap-4', status: 'approved', payload: { action: 'other.action' } }) },
    });
    const r = permissionPreflight(pipeline, makeAct({ action: 'noe.note.write', riskLevel: 'high' }), { approvalId: 'ap-4' });
    expect(r.blockedSafety).toBe(true);
    expect(r.reason).toContain('mismatch');
  });

  it('低风险动作 permission 引擎 deny 时拦截', () => {
    const pipeline = basePipeline({ permission: { evaluatePermission: () => ({ decision: 'deny', reason: '策略拒绝' }) } });
    const r = permissionPreflight(pipeline, makeAct());
    expect(r.blockedSafety).toBe(true);
    expect(r.reason).toBe('策略拒绝');
  });

  it('低风险动作 permission 引擎 ask 时转审批', () => {
    const pipeline = basePipeline({ permission: { evaluatePermission: () => ({ decision: 'ask', approval: { id: 'ap-5' } }) } });
    const r = permissionPreflight(pipeline, makeAct());
    expect(r.requiresApproval).toBe(true);
    expect(r.approval?.id).toBe('ap-5');
  });
});

describe('contextSufficiencyPreflight', () => {
  it('无 requiredContext 时跳过（返回 null）', () => {
    expect(contextSufficiencyPreflight(basePipeline(), makeAct())).toBe(null);
    expect(contextSufficiencyPreflight(basePipeline(), makeAct(), { contextSufficiency: {} })).toBe(null);
  });

  it('config.result 预置结果时原样采用', () => {
    const r = contextSufficiencyPreflight(basePipeline(), makeAct(), {
      contextSufficiency: { requiredContext: ['memory'], result: { ok: true, sufficient: true, source: '预置' } },
    });
    expect(r).toEqual({ ok: true, sufficient: true, source: '预置' });
  });

  it('带 requiredContext 时调用注入的充分性评估器并透传关键参数', () => {
    const calls = [];
    const pipeline = basePipeline({ contextSufficiency: (args) => { calls.push(args); return { ok: true, sufficient: true }; } });
    const r = contextSufficiencyPreflight(pipeline, makeAct({ riskLevel: 'medium' }), {
      goal: '整理记忆',
      requiredContext: ['memory', 'focus'],
    });
    expect(r).toEqual({ ok: true, sufficient: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].goal).toBe('整理记忆');
    expect(calls[0].requiredContext).toEqual(['memory', 'focus']);
    expect(calls[0].riskLevel).toBe('medium');
    expect(calls[0].maxRounds).toBe(2);
  });
});
