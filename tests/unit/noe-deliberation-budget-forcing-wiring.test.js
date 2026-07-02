import { describe, it, expect } from 'vitest';
import { createDeliberation } from '../../src/cognition/NoeDeliberation.js';

// 验证 NoeDeliberation 的 budgetForcedThink 注入钩子：
//  - 不注入（OFF 默认）→ 走原 adapter.chat 单次路径（零回归）；
//  - 注入（ON）→ 用 budgetForcedThink 的产出，且不再走原单次 chatOnce。

function stubAdapter(reply) {
  const calls = [];
  return { adapter: { chat: async (messages, opts) => { calls.push({ messages, opts }); return { reply }; } }, calls };
}

describe('NoeDeliberation × budgetForcedThink 注入钩子', () => {
  it('OFF（未注入 budgetForcedThink）→ 走原 adapter.chat，零回归', async () => {
    const { adapter, calls } = stubAdapter('【立论】A\n【挑战】B\n【修订】C\n预测：明天会下雨（概率 0.6）');
    const deliberate = createDeliberation({ getAdapter: () => adapter });
    const r = await deliberate({ topic: '今天要不要出门' });
    expect(r.deliberated).toBe(true);
    expect(r.prediction).toEqual({ claim: '明天会下雨', p: 0.6 });
    expect(calls.length).toBe(1); // 原单次 chat
  });

  it('ON（注入 budgetForcedThink）→ 用强制思考产出，且不调用原单次 chatOnce（开了真生效）', async () => {
    const { adapter, calls } = stubAdapter('不应被用到');
    let bfCalled = 0;
    const budgetForcedThink = async ({ messages }) => {
      bfCalled += 1;
      // 校验深思把 system + user 焦点传进来了
      expect(messages.some((m) => m.role === 'system')).toBe(true);
      expect(JSON.stringify(messages)).toContain('要不要发提醒');
      return { reply: '【立论】BF判断\n【挑战】反例\n【修订】终判\n预测：三天内主人会反馈（概率 0.7）', budgetForcing: { rounds: 2, ignoresUsed: 1 } };
    };
    const deliberate = createDeliberation({ getAdapter: () => adapter, budgetForcedThink });
    const r = await deliberate({ topic: '要不要发提醒' });
    expect(bfCalled).toBe(1);
    expect(r.deliberated).toBe(true);
    expect(r.text).toContain('BF判断'); // 用的是强制思考产出
    expect(r.prediction).toEqual({ claim: '三天内主人会反馈', p: 0.7 });
    expect(calls.length).toBe(0); // 关键：没有再走原单次 adapter.chat
  });

  it('ON 但 budgetForcedThink 抛错 → fail-open 回退原单次 chatOnce（深思不因强制思考挂掉）', async () => {
    const { adapter, calls } = stubAdapter('【立论】回退后的判断\n【挑战】x\n【修订】y\n预测：无');
    const budgetForcedThink = async () => { throw new Error('bf boom'); };
    const deliberate = createDeliberation({ getAdapter: () => adapter, budgetForcedThink });
    const r = await deliberate({ topic: '随便想想' });
    expect(r.deliberated).toBe(true);
    expect(r.text).toContain('回退后的判断');
    expect(calls.length).toBe(1); // 回退到原单次 chat
  });

  it('ON 但 budgetForcedThink 返回 incomplete（length 截断）→ 与原 chat incomplete 同样处理', async () => {
    const { adapter } = stubAdapter('x');
    const budgetForcedThink = async () => ({ reply: '', incomplete: true, finishReason: 'length' });
    const deliberate = createDeliberation({ getAdapter: () => adapter, budgetForcedThink });
    const r = await deliberate({ topic: '想个长的' });
    // 强制思考定稿被截断 → 回退普通 chat（仍出结果），不当完整结论
    expect(r.deliberated).toBe(true);
  });
});
