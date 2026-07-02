// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createOwnerCorrectionBridge } from '../../src/cognition/NoeOwnerCorrectionBridge.js';

function makeGoalSystem() { const calls = []; return { calls, harvestSurprise: (a) => { calls.push(a); return 'cg-1'; } }; }

describe('createOwnerCorrectionBridge（阶段1 P1：owner 否定事实判断=最强 epistemic 源）', () => {
  beforeEach(() => { process.env.NOE_OWNER_CORRECTION = '1'; });
  afterEach(() => { delete process.env.NOE_OWNER_CORRECTION; });

  it('flag OFF → null（零行为）', () => {
    const b = createOwnerCorrectionBridge({ goalSystem: makeGoalSystem() });
    delete process.env.NOE_OWNER_CORRECTION;
    expect(b.onOwnerInteraction({ text: '不对，其实是 X' })).toBeNull();
  });

  it('owner 纠正(不对/其实是) → harvestSurprise(owner_correction，最高 surprise=3)', () => {
    const gs = makeGoalSystem();
    const b = createOwnerCorrectionBridge({ goalSystem: gs });
    const r = b.onOwnerInteraction({ text: '不对，这个 API 其实是 POST 不是 GET' });
    expect(gs.calls[0]).toMatchObject({ origin: 'owner_correction', surprise: 3 });
    expect(r.curiosityGoalId).toBe('cg-1');
  });

  it('普通对话(无纠正信号) → null', () => {
    const gs = makeGoalSystem();
    const b = createOwnerCorrectionBridge({ goalSystem: gs });
    expect(b.onOwnerInteraction({ text: '帮我查一下今天的天气' })).toBeNull();
    expect(gs.calls).toHaveLength(0);
  });

  it('OC-FALSEPOS-5（修三方审查 serious）：含明确否定+「不是X而是Y」的真纠正不被「不是很」缓和词误杀', () => {
    const gs = makeGoalSystem();
    const b = createOwnerCorrectionBridge({ goalSystem: gs });
    const r = b.onOwnerInteraction({ text: '不对，不是很安全而是有风险' });
    expect(r?.corrected).toBe(true); // 明确否定+纠正结构，不被缓和量词「不是很」丢弃
    expect(gs.calls[0]).toMatchObject({ origin: 'owner_correction', surprise: 3 });
  });

  it('OC-FALSEPOS-4（修三方审查 minor）：「你错怪我了」是反向语义(Neo 错怪 owner)非世界事实纠正→不产 surprise', () => {
    const gs = makeGoalSystem();
    const b = createOwnerCorrectionBridge({ goalSystem: gs });
    expect(b.onOwnerInteraction({ text: '你错怪我了，我没说过那句话' })).toBeNull();
    expect(gs.calls).toHaveLength(0);
  });

  it('疑问/反问语气(不对吗) → null（非断言纠正，防误判）', () => {
    const gs = makeGoalSystem();
    const b = createOwnerCorrectionBridge({ goalSystem: gs });
    expect(b.onOwnerInteraction({ text: '这样做不对吗？' })).toBeNull();
    expect(gs.calls).toHaveLength(0);
  });

  it('去重：同纠正短窗只产一次', () => {
    const gs = makeGoalSystem();
    let t = 1000;
    const b = createOwnerCorrectionBridge({ goalSystem: gs, now: () => t });
    b.onOwnerInteraction({ text: '不对，搞错了，是另一个值' });
    expect(b.onOwnerInteraction({ text: '不对，搞错了，是另一个值' })).toMatchObject({ skipped: 'deduped' });
    expect(gs.calls).toHaveLength(1);
  });

  it('限速：每小时上限', () => {
    const gs = makeGoalSystem();
    let t = 1000;
    const b = createOwnerCorrectionBridge({ goalSystem: gs, now: () => t, maxPerHour: 2 });
    b.onOwnerInteraction({ text: '不对，第一个地方搞错了' }); t += 100;
    b.onOwnerInteraction({ text: '不对，第二个地方也错了' }); t += 100;
    expect(b.onOwnerInteraction({ text: '不对，第三个地方还是错的' })).toMatchObject({ skipped: 'rate_limited' });
    expect(gs.calls).toHaveLength(2);
  });

  // OC-POLLUTION-1（Claude 第三轮致命）：watcher 喂的 summary 含 Neo 回复，Neo 回复里的纠正词不能刷 surprise。
  it('污染防护：summary「主人说X，我答Y」剥离 Neo 回复，Neo 回复里的纠正词不产 surprise', () => {
    const gs = makeGoalSystem();
    const b = createOwnerCorrectionBridge({ goalSystem: gs });
    expect(b.onOwnerInteraction({ text: '主人说“今天天气怎么样”，我答“其实是16号了不对应该是17号”' })).toBeNull();
    expect(gs.calls).toHaveLength(0);
  });

  it('污染防护：summary 里 owner 段真纠正仍识别', () => {
    const gs = makeGoalSystem();
    const b = createOwnerCorrectionBridge({ goalSystem: gs });
    const r = b.onOwnerInteraction({ text: '主人说“不对，这个其实是 POST”，我答“好的我改”' });
    expect(r?.corrected).toBe(true);
  });

  // OC-FALSEPOS-2（Claude 第三轮）：陈述/缓和/owner 自陈不算纠正 Neo。
  it.each([
    ['应该是 5 点开会'],
    ['其实不是很急'],
    ['我记错了日期'],
    ['实际上不是你的问题'],
    // OC-FALSEPOS-3（修三方审查 serious）：owner 主动陈述事实(含「其实是/实际上是」连续子串)不算否定 Neo，
    //   修复前会刷假 owner_correction surprise=3，修复后这三句不命中 CORRECTION_RE → null。
    ['答案其实是 42'],
    ['这个实际上是下周三'],
    ['那家店实际上是周一关门'],
  ])('误判防护：「%s」不算 owner 纠正', (text) => {
    const gs = makeGoalSystem();
    const b = createOwnerCorrectionBridge({ goalSystem: gs });
    expect(b.onOwnerInteraction({ text })).toBeNull();
    expect(gs.calls).toHaveLength(0);
  });
});
