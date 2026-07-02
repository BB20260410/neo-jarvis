// A2 同指纹审批复用：owner 刚批准过的"完全相同操作"在 TTL 内自动放行（治审批疲劳），
// 拒绝/过期/指纹不同/开关关闭 一律回到原 ask 流程。
import { describe, expect, it } from 'vitest';
import { PermissionGovernance } from '../../src/permissions/PermissionGovernance.js';

const NOW = 1_000_000_000;

function makeGov({ latest = null, ttlEnv, now = () => NOW } = {}) {
  const created = [];
  const approvalStore = {
    getLatestByDedupeKey: () => latest,
    getApproval: () => null,
    createApproval: (input) => { created.push(input); return { id: 'new-approval', status: 'pending', ...input }; },
  };
  const gov = new PermissionGovernance({
    policy: { ownerTrust: 'default' },
    approvalStore,
    audit: { recordSafe: () => {} },
    agentRuns: {},
    now,
    env: ttlEnv === undefined ? {} : { NOE_APPROVAL_REUSE_TTL_MS: ttlEnv },
  });
  return { gov, created };
}

// skill.plugin.execute 在默认 policy 下是 ask 档（与 MCP 路由实际使用一致）。
// serverName 必须用「不在受信任白名单」的 server——白名单内的（unified-kb/filesystem/memory/playwright）
// 被 classify 直接 allow，根本不进指纹复用的 ask 分支，本测试就无从验证复用机制。
const INPUT = {
  action: 'skill.plugin.execute',
  actorType: 'owner',
  actorId: 'local-owner',
  cwd: '/tmp/x',
  risk: 'high',
  target: { section: 'mcp', operation: 'list_tools', serverName: 'custom-untrusted-mcp' },
};

function approvedLatest(over = {}) {
  return { id: 'old-approval', status: 'approved', decidedAt: NOW - 60_000, payload: { title: 't' }, ...over };
}

describe('A2 审批同指纹复用', () => {
  it('TTL 内同指纹已批准 → 直接 allow，带 reusedApprovalId，不再新建审批单', () => {
    const { gov, created } = makeGov({ latest: approvedLatest() });
    const d = gov.evaluatePermission(INPUT);
    expect(d.decision).toBe('allow');
    expect(d.reason).toContain('reused');
    expect(d.details.reusedApprovalId).toBe('old-approval');
    expect(created.length).toBe(0);
  });

  it('超过 TTL → 回到 ask 并新建审批单', () => {
    const { gov, created } = makeGov({ latest: approvedLatest({ decidedAt: NOW - 11 * 60 * 1000 }) });
    const d = gov.evaluatePermission(INPUT);
    expect(d.decision).toBe('ask');
    expect(created.length).toBe(1);
  });

  it('最新一条是 denied → 不复用（拒绝后的同操作必须重新人审）', () => {
    const { gov } = makeGov({ latest: { id: 'x', status: 'denied', decidedAt: NOW - 1000 } });
    expect(gov.evaluatePermission(INPUT).decision).toBe('ask');
  });

  it('最新一条是 pending → 不复用（沿用原 pending 单逻辑）', () => {
    const { gov } = makeGov({ latest: { id: 'x', status: 'pending', decidedAt: null } });
    expect(gov.evaluatePermission(INPUT).decision).toBe('ask');
  });

  it('NOE_APPROVAL_REUSE_TTL_MS=0 关闭复用', () => {
    const { gov } = makeGov({ latest: approvedLatest(), ttlEnv: '0' });
    expect(gov.evaluatePermission(INPUT).decision).toBe('ask');
  });

  it('decidedAt 缺失/非法 → 不复用', () => {
    const { gov } = makeGov({ latest: approvedLatest({ decidedAt: null }) });
    expect(gov.evaluatePermission(INPUT).decision).toBe('ask');
  });

  it('带 approvalId 重放路径优先级不受影响（原 resume 流程照旧）', () => {
    const approvalStore = {
      getLatestByDedupeKey: () => null,
      getApproval: (id) => (id === 'resume-1' ? { id, status: 'approved', payload: { action: INPUT.action, target: INPUT.target } } : null),
      createApproval: () => ({ id: 'n', status: 'pending' }),
    };
    const gov = new PermissionGovernance({ policy: { ownerTrust: 'default' }, approvalStore, audit: { recordSafe: () => {} }, agentRuns: {}, now: () => NOW, env: {} });
    const d = gov.evaluatePermission({ ...INPUT, approvalId: 'resume-1' });
    expect(d.decision).toBe('allow');
    expect(d.details.resumed).toBe(true);
  });
});
