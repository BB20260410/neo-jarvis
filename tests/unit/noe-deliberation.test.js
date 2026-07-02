import { describe, it, expect } from 'vitest';
import { createDeliberation, parsePrediction, parseShare } from '../../src/cognition/NoeDeliberation.js';

const T0 = 1_780_000_000_000;

describe('parsePrediction / parseShare 解析', () => {
  it('解析「预测：…（概率 0.x）」', () => {
    const p = parsePrediction('【修订】……\n预测：主人明晚会继续调战斗系统（概率 0.8）');
    expect(p.claim).toBe('主人明晚会继续调战斗系统');
    expect(p.p).toBe(0.8);
  });
  it('概率非法/缺概率 → null', () => {
    expect(parsePrediction('预测：会下雨')).toBe(null);
    expect(parsePrediction('预测：会下雨（概率 1.5）')).toBe(null);
  });
  it('解析「想说：…」；没有则 null', () => {
    expect(parseShare('……\n想说：新版本已经稳定运行三小时了')).toBe('新版本已经稳定运行三小时了');
    expect(parseShare('【修订】没什么值得说的')).toBe(null);
  });
});

describe('NoeDeliberation 自我质询', () => {
  function setup(reply) {
    const recorded = [];
    const ledgerAdds = [];
    const timeline = { record: (e) => { recorded.push(e); return recorded.length; } };
    const ledger = { add: (e) => { ledgerAdds.push(e); return ledgerAdds.length; } };
    const adapter = { chat: async (messages) => ({ reply, _messages: messages }) };
    const deliberate = createDeliberation({ getAdapter: () => adapter, timeline, ledger, now: () => T0 });
    return { deliberate, recorded, ledgerAdds };
  }

  it('完整回路：审议留痕（meta.streamType=deliberation, salience 4）+ 预测入账 + 想说返回', async () => {
    const reply = '【立论】值得提醒。\n【挑战】也许主人已经知道了。\n【修订】还是值得提一句。\n预测：今晚主人会重启面板（概率 0.7）\n想说：新心跳已经平稳跑了一天';
    const { deliberate, recorded, ledgerAdds } = setup(reply);
    const r = await deliberate({ topic: '到点的牵挂：提醒主人重启面板' });
    expect(r.deliberated).toBe(true);
    expect(r.prediction.p).toBe(0.7);
    expect(r.share).toBe('新心跳已经平稳跑了一天');
    expect(recorded[0].meta.streamType).toBe('deliberation');
    expect(recorded[0].salience).toBe(4);
    expect(recorded[0].summary).toContain('（深思）');
    expect(ledgerAdds[0].claim).toBe('今晚主人会重启面板');
    expect(ledgerAdds[0].source).toBe('reflection');
  });

  it('NOE_VERIFIABLE_REWARD=1：深思输出带可验证质量分 rewardScore（NoeVerifiableReward 接入生效）', async () => {
    const prev = process.env.NOE_VERIFIABLE_REWARD;
    process.env.NOE_VERIFIABLE_REWARD = '1';
    try {
      const adapter = { chat: async () => ({ reply: '【立论】首先分析。\n【挑战】其次质疑。\n【修订】最后定论。' }) };
      const deliberate = createDeliberation({ getAdapter: () => adapter, now: () => T0 });
      const r = await deliberate({ topic: '测试质量评分' });
      expect(r.deliberated).toBe(true);
      expect(typeof r.rewardScore).toBe('number'); // OFF 时该字段不存在，ON 时为质量分
    } finally {
      if (prev === undefined) delete process.env.NOE_VERIFIABLE_REWARD;
      else process.env.NOE_VERIFIABLE_REWARD = prev;
    }
  });

  it('NOE_REASONING_SEARCH=beam + reward：深思多候选择优（选 reasoningSteps 最高的）', async () => {
    const prevRS = process.env.NOE_REASONING_SEARCH;
    const prevVR = process.env.NOE_VERIFIABLE_REWARD;
    process.env.NOE_REASONING_SEARCH = 'beam';
    process.env.NOE_VERIFIABLE_REWARD = '1';
    try {
      // generate 3 温度各出一候选；第 2 个分步过渡词最多（reasoningSteps 高）→ 应被 beam 选中
      let i = 0;
      const replies = [
        '随便一个简单结论，没分步。',
        '【立论】首先，分析问题。\n【挑战】其次，质疑假设。\n【修订】最后，得出定论。\n预测：明天继续（概率 0.6）',
        '嗯，再想想。',
      ];
      const adapter = { chat: async () => ({ reply: replies[Math.min(i++, replies.length - 1)] }) };
      const deliberate = createDeliberation({ getAdapter: () => adapter, now: () => T0 });
      const r = await deliberate({ topic: '到底该不该重构这个核心模块，需要权衡利弊' }); // 含难题词→判复杂→触发 search
      expect(r.deliberated).toBe(true);
      expect(r.text).toContain('立论'); // beam 用 verifiableReward 选了分步最优候选
      expect(i).toBeGreaterThanOrEqual(3); // 真发散了多候选（多次 chat）
    } finally {
      if (prevRS === undefined) delete process.env.NOE_REASONING_SEARCH; else process.env.NOE_REASONING_SEARCH = prevRS;
      if (prevVR === undefined) delete process.env.NOE_VERIFIABLE_REWARD; else process.env.NOE_VERIFIABLE_REWARD = prevVR;
    }
  });

  it('NOE_REASONING_SEARCH=beam：简单 topic 不触发多候选（难题细分省算力）', async () => {
    const prevRS = process.env.NOE_REASONING_SEARCH;
    const prevVR = process.env.NOE_VERIFIABLE_REWARD;
    process.env.NOE_REASONING_SEARCH = 'beam';
    process.env.NOE_VERIFIABLE_REWARD = '1';
    try {
      let i = 0;
      const adapter = { chat: async () => { i++; return { reply: '【立论】嗯。\n【修订】就这样。' }; } };
      const deliberate = createDeliberation({ getAdapter: () => adapter, now: () => T0 });
      const r = await deliberate({ topic: '随便想想' }); // 短+无难题词→判简单→单次
      expect(r.deliberated).toBe(true);
      expect(i).toBe(1); // 简单题只 1 次 chat（未发散，省算力）
    } finally {
      if (prevRS === undefined) delete process.env.NOE_REASONING_SEARCH; else process.env.NOE_REASONING_SEARCH = prevRS;
      if (prevVR === undefined) delete process.env.NOE_VERIFIABLE_REWARD; else process.env.NOE_VERIFIABLE_REWARD = prevVR;
    }
  });

  it('无预测/无想说：照常留痕，二者为 null', async () => {
    const { deliberate, recorded, ledgerAdds } = setup('【立论】嗯。\n【挑战】未必。\n【修订】再看看。');
    const r = await deliberate({ topic: '内在驱力：好奇在涨' });
    expect(r.deliberated).toBe(true);
    expect(r.prediction).toBe(null);
    expect(r.share).toBe(null);
    expect(recorded.length).toBe(1);
    expect(ledgerAdds.length).toBe(0);
  });

  it('无 topic / 无大脑 / 大脑抛错：fail-open 带 reason', async () => {
    const { deliberate } = setup('x');
    expect((await deliberate({})).reason).toBe('no_topic');
    const noBrain = createDeliberation({ getAdapter: () => null });
    expect((await noBrain({ topic: 'x' })).reason).toBe('no_brain');
    const bad = createDeliberation({ getAdapter: () => ({ chat: async () => { throw new Error('炸'); } }) });
    expect((await bad({ topic: 'x' })).reason).toBe('brain_error');
  });

  it('think 标签被清洗；超长截断', async () => {
    const { deliberate, recorded } = setup(`<think>内心盘算</think>【立论】${'长'.repeat(2000)}`);
    const r = await deliberate({ topic: 'x' });
    expect(r.text).not.toContain('<think>');
    expect(r.text.length).toBeLessThanOrEqual(1200);
    expect(recorded[0].detail.length).toBeLessThanOrEqual(1200);
  });
});
