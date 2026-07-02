import { describe, it, expect } from 'vitest';
import { createNoeCapabilityTrigger, classifyCapabilityNeed } from '../../src/capabilities/NoeCapabilityTrigger.js';

function mockAcq({ candidates = [{ type: 'npm', name: 'turndown', source: 'npmjs.com' }] } = {}) {
  return {
    searchCapability: async () => ({ ok: candidates.length > 0, candidates }),
    assessCandidate: (c) => ({ safe: c.source === 'npmjs.com' }),
    planAcquisition: (c) => ({ ok: true, capability: { name: c.name, type: c.type } }),
  };
}

function make(over = {}) {
  const proposeCalls = [];
  const trigger = createNoeCapabilityTrigger({
    capabilityAcquisition: mockAcq(over.acq || {}),
    propose: over.propose === null ? null : async (i) => { proposeCalls.push(i); return { ok: true }; },
    evaluateGrant: () => ({ authorized: over.authorized !== false }),
    now: () => over.now || 10_000_000,
    cooldownMs: over.cooldownMs,
  });
  return { trigger, proposeCalls };
}

describe('classifyCapabilityNeed', () => {
  it('命中缺能力信号', () => {
    expect(classifyCapabilityNeed('我缺个工具来解析 pdf').isNeed).toBe(true);
    expect(classifyCapabilityNeed('need a library for markdown').isNeed).toBe(true);
  });
  it('普通文本不命中', () => {
    expect(classifyCapabilityNeed('今天天气真好').isNeed).toBe(false);
    expect(classifyCapabilityNeed('').isNeed).toBe(false);
  });
});

describe('createNoeCapabilityTrigger.observe', () => {
  it('显式 need + 安全候选 + grant → 提议 noe.capability.install', async () => {
    const { trigger, proposeCalls } = make();
    const r = await trigger.observe({ need: 'pdf 转 markdown' });
    expect(r.ok).toBe(true);
    expect(r.proposed).toBe(true);
    expect(proposeCalls[0].action).toBe('noe.capability.install');
    expect(proposeCalls[0].payload.capability.name).toBe('turndown');
    expect(proposeCalls[0].proposedBy).toBe('noe-capability-trigger');
  });

  it('非需求文本 → not_capability_need', async () => {
    const { trigger } = make();
    expect(await trigger.observe({ text: '今天吃啥' })).toMatchObject({ ok: false, reason: 'not_capability_need' });
  });

  it('无 standing grant → no_standing_grant（主门：不自发装）', async () => {
    const { trigger, proposeCalls } = make({ authorized: false });
    expect(await trigger.observe({ need: 'x' })).toMatchObject({ ok: false, reason: 'no_standing_grant' });
    expect(proposeCalls).toHaveLength(0);
  });

  it('无安全候选 → no_safe_candidate（不可信源被拒）', async () => {
    const { trigger } = make({ acq: { candidates: [{ type: 'npm', name: 'x', source: 'evil.com' }] } });
    expect(await trigger.observe({ need: 'x' })).toMatchObject({ ok: false, reason: 'no_safe_candidate' });
  });

  it('无候选 → no_candidate', async () => {
    const { trigger } = make({ acq: { candidates: [] } });
    expect(await trigger.observe({ need: 'x' })).toMatchObject({ ok: false, reason: 'no_candidate' });
  });

  it('cooldown：同窗口第二次需求被拦', async () => {
    const { trigger, proposeCalls } = make();
    expect((await trigger.observe({ need: 'aaa' })).ok).toBe(true);
    expect((await trigger.observe({ need: 'bbb' })).reason).toBe('cooldown');
    expect(proposeCalls).toHaveLength(1);
  });

  it('去重：同需求不重复提议（cooldownMs=0 时）', async () => {
    const { trigger, proposeCalls } = make({ cooldownMs: 0 });
    expect((await trigger.observe({ need: 'same-need' })).ok).toBe(true);
    expect((await trigger.observe({ need: 'same-need' })).reason).toBe('already_proposed');
    expect(proposeCalls).toHaveLength(1);
  });

  it('propose 缺失 → propose_unavailable（已选好 capability）', async () => {
    const { trigger } = make({ propose: null });
    expect(await trigger.observe({ need: 'x' })).toMatchObject({ ok: true, proposed: false, reason: 'propose_unavailable' });
  });
});
