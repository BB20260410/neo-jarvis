import { describe, it, expect } from 'vitest';
import { classifyPreferenceConfidence, createNoePreferenceCollector } from '../../src/cognition/NoePreferenceCollector.js';

function makeCollector(opts = {}) {
  const written = [];
  const collector = createNoePreferenceCollector({
    appendLine: (file, obj) => written.push({ file, obj }),
    now: () => 1700000000000,
    ...opts,
  });
  return { collector, written };
}

const PAIR = { prompt: '如何修复前缀越界 bug', chosen: '用 file===root||startsWith(root+sep)', rejected: '只用 startsWith(root)' };

describe('classifyPreferenceConfidence', () => {
  it('owner/规则高 → high；自动裁决 → low', () => {
    expect(classifyPreferenceConfidence('owner_correction')).toBe('high');
    expect(classifyPreferenceConfidence('owner_confirmation')).toBe('high');
    expect(classifyPreferenceConfidence('rule_high')).toBe('high');
    expect(classifyPreferenceConfidence('adversarial_verdict')).toBe('low');
    expect(classifyPreferenceConfidence('runtime_verify')).toBe('low');
    expect(classifyPreferenceConfidence('')).toBe('low');
  });
});

describe('createNoePreferenceCollector.record — 质量门', () => {
  it('缺字段 → incomplete_pair', () => {
    const { collector, written } = makeCollector();
    expect(collector.record({ prompt: 'x', chosen: '', rejected: 'y' })).toMatchObject({ ok: false, reason: 'incomplete_pair' });
    expect(written.length).toBe(0);
  });
  it('chosen===rejected → 拒', () => {
    const { collector } = makeCollector();
    expect(collector.record({ prompt: 'aaaa', chosen: 'same value', rejected: 'same value' })).toMatchObject({ ok: false, reason: 'chosen_equals_rejected' });
  });
  it('过短 → too_short', () => {
    const { collector } = makeCollector({ minLen: 5 });
    expect(collector.record({ prompt: 'abcde', chosen: 'ok', rejected: 'no' }).reason).toMatch(/too_short/);
  });
  it('过长 → too_long（拒，不静默截断）', () => {
    const { collector } = makeCollector({ maxLen: 20 });
    expect(collector.record({ prompt: 'p'.repeat(50), chosen: 'c', rejected: 'r' }).reason).toBe('too_long:prompt');
  });
  it('重复 → duplicate（只写一次）', () => {
    const { collector, written } = makeCollector();
    expect(collector.record({ ...PAIR, source: 'owner_correction' }).ok).toBe(true);
    expect(collector.record({ ...PAIR, source: 'owner_correction' })).toMatchObject({ ok: false, reason: 'duplicate' });
    expect(written.length).toBe(1);
  });
});

describe('createNoePreferenceCollector.record — 置信度分桶（低置信隔离区）', () => {
  it('高置信来源 → train.jsonl', () => {
    const { collector, written } = makeCollector();
    const r = collector.record({ ...PAIR, source: 'owner_correction' });
    expect(r).toMatchObject({ ok: true, bucket: 'train', confidence: 'high' });
    expect(written[0].file).toMatch(/train\.jsonl$/);
  });
  it('自动裁决（低置信）→ quarantine.jsonl（不入训练集）', () => {
    const { collector, written } = makeCollector();
    const r = collector.record({ ...PAIR, source: 'adversarial_verdict' });
    expect(r).toMatchObject({ ok: true, bucket: 'quarantine', confidence: 'low' });
    expect(written[0].file).toMatch(/quarantine\.jsonl$/);
  });
  it('secret 经脱敏后才入样本', () => {
    const { collector, written } = makeCollector();
    collector.record({ prompt: '配置 token=sk-ABCDEFGH12345678 怎么改', chosen: '放进环境变量读取', rejected: '硬编码在源码里', source: 'owner_correction' });
    const blob = JSON.stringify(written[0].obj);
    expect(blob).not.toContain('sk-ABCDEFGH12345678');
  });
  it('单源占比门：高置信单源样本超限 → 降级隔离（防 mode collapse）', () => {
    const { collector } = makeCollector({ minTotalForRatio: 5, maxSingleSourceRatio: 0.6 });
    let downgraded = 0;
    for (let i = 0; i < 40; i += 1) {
      const r = collector.record({ prompt: `q${i} 一个足够长的问题`, chosen: `chosen-${i}-value`, rejected: `rejected-${i}-value`, source: 'owner_correction' });
      if (r.downgraded) downgraded += 1;
    }
    const s = collector.stats();
    expect(downgraded).toBeGreaterThan(0); // 单源占比超 0.6 后开始降级
    expect(s.trainTotal).toBeLessThan(40); // 部分被降级到隔离区
    expect(s.quarantineTotal).toBeGreaterThan(0);
  });
});
