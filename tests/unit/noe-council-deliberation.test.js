// @ts-check
import { describe, it, expect } from 'vitest';
import { createCouncilDeliberation, COUNCIL_PERSONAS } from '../../src/cognition/NoeCouncilDeliberation.js';

// P3 多视角议会深思：3 persona(立论者/唱反调者/现实主义者)独立采样 → 批判聚合收敛。
//   全 fake adapter,不烧模型。验证:多视角发散+聚合+parse 复用+timeline 留痕+ledger 入账+契约一致+fail-open。

function fakeAdapter(replies) {
  const calls = [];
  let i = 0;
  return {
    calls,
    chat: async (messages, opts) => {
      calls.push({ system: messages[0].content, taskId: opts?.budgetContext?.taskId, temp: opts?.temperature });
      const r = replies[Math.min(i, replies.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return typeof r === 'object' ? r : { reply: r };
    },
  };
}
function fakeLedger() { const added = []; return { added, add: (x) => added.push(x), calibrationNote: () => '' }; }
function fakeTimeline() { const recorded = []; return { recorded, record: (e) => { recorded.push(e); return 42; } }; }

describe('NoeCouncilDeliberation — 多视角议会深思', () => {
  it('3 persona 独立采样 + 批判聚合 → 终判 parse 出预测/想说,入账+留痕,契约一致', async () => {
    const adapter = fakeAdapter([
      '我认为该立刻提交代码,测试早就该跑了',          // proponent
      '但测试还没真跑过,可能有隐藏 bug,别急',         // skeptic
      'owner 在等结果,但质量优先,先验证更稳妥',        // pragmatist
      '【修订】先跑全量测试再提交,我可能低估了回归风险\n预测：今晚会跑通全量测试（概率 0.7）\n想说：我在认真权衡这件事',  // 聚合
    ]);
    const ledger = fakeLedger();
    const timeline = fakeTimeline();
    const deliberate = createCouncilDeliberation({ getAdapter: () => adapter, timeline, ledger });
    const r = await deliberate({ topic: '要不要现在提交代码', context: '改了召回逻辑' });

    expect(r.deliberated).toBe(true);
    expect(adapter.calls.length).toBe(4);                       // 3 persona 发散 + 1 聚合
    expect(adapter.calls[0].taskId).toBe('noe-council-deliberation');
    expect(adapter.calls[3].taskId).toBe('noe-council-aggregate'); // 第4次是聚合
    expect(adapter.calls[0].temp).toBe(0.5);                    // proponent 低温
    expect(adapter.calls[1].temp).toBe(0.6);                    // skeptic 温和(异质靠 focus 不靠高温;M3 实证 0.9 致 35b 截断)
    expect(adapter.calls[3].temp).toBe(0.4);                    // 聚合收敛低温
    expect(r.voiceCount).toBe(3);
    // 契约一致(与 createDeliberation 同字段)
    expect(r).toHaveProperty('text'); expect(r).toHaveProperty('prediction');
    expect(r).toHaveProperty('share'); expect(r).toHaveProperty('goal'); expect(r).toHaveProperty('eventId');
    expect(r.prediction.claim).toContain('跑通全量测试');
    expect(r.prediction.p).toBe(0.7);
    expect(r.share).toBe('我在认真权衡这件事');
    // 入账(prediction → ledger,source=reflection)
    expect(ledger.added.length).toBe(1);
    expect(ledger.added[0].source).toBe('reflection');
    expect(ledger.added[0].p).toBe(0.7);
    // 留痕(council 专属 streamType + personas)
    expect(timeline.recorded[0].meta.streamType).toBe('council_deliberation');
    expect(timeline.recorded[0].meta.personas).toEqual(['proponent', 'skeptic', 'pragmatist']);
    expect(timeline.recorded[0].detail).toContain('内心三方'); // 三方观点存进 detail
  });

  it('无 topic / 无 brain → 不深思', async () => {
    const adapter = fakeAdapter(['x']);
    const d1 = createCouncilDeliberation({ getAdapter: () => adapter });
    expect((await d1.deliberate?.({ topic: '' }) ?? await d1({ topic: '' })).deliberated).toBe(false);
    const d2 = createCouncilDeliberation({ getAdapter: () => null });
    expect((await d2({ topic: '某焦点' })).reason).toBe('no_brain');
  });

  it('persona 全失败(incomplete) → no_voices,不产终判', async () => {
    const adapter = fakeAdapter([{ incomplete: true }, { incomplete: true }, { incomplete: true }, { incomplete: true }]);
    const r = await createCouncilDeliberation({ getAdapter: () => adapter })({ topic: '某焦点' });
    expect(r.deliberated).toBe(false);
    expect(r.reason).toBe('no_voices');
  });

  it('聚合失败 → fail-open 回退到某个 persona 文本(不崩)', async () => {
    const adapter = fakeAdapter([
      '立论:该做', '反调:风险高', '现实:看代价',
      new Error('aggregator boom'),  // 聚合 throw
    ]);
    const r = await createCouncilDeliberation({ getAdapter: () => adapter })({ topic: '某焦点' });
    expect(r.deliberated).toBe(true);                  // 回退成功不崩
    expect(['立论:该做', '反调:风险高', '现实:看代价']).toContain(r.text); // 回退到某 persona
    expect(r.voiceCount).toBe(3);
  });

  it('单 persona 失败其余照常(fail-open 不阻断)', async () => {
    const adapter = fakeAdapter([
      new Error('proponent boom'),  // 立论者挂
      '反调:测试没跑', '现实:owner在等',
      '【修订】先跑测试\n预测：无',  // 聚合(只看到2方)
    ]);
    const r = await createCouncilDeliberation({ getAdapter: () => adapter })({ topic: '某焦点' });
    expect(r.deliberated).toBe(true);
    expect(r.voiceCount).toBe(2);  // 立论者失败,剩 2 voice
  });

  it('COUNCIL_PERSONAS 是 3 个异质角色', () => {
    expect(COUNCIL_PERSONAS.map((p) => p.key)).toEqual(['proponent', 'skeptic', 'pragmatist']);
    expect(new Set(COUNCIL_PERSONAS.map((p) => p.temp)).size).toBeGreaterThan(1); // 温度异质
  });
});
