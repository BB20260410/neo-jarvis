import { describe, it, expect } from 'vitest';
import { createBudgetForcedThink, THINK_OPEN } from '../../src/cognition/NoeBudgetForcedDeliberation.js';
import { resolveBudgetForcing } from '../../src/cognition/NoeBudgetForcing.js';

// 一个最小 fake 续写能力：按脚本逐轮返回 {text, hitStop}；记录每轮 prompt。
function fakeCompletion(script) {
  let i = 0;
  const prompts = [];
  return {
    currentMode: () => 'raw_completions',
    setMode() {},
    probe: async () => 'raw_completions',
    complete: async ({ prompt }) => {
      prompts.push(prompt);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return { text: step.text, finishReason: step.hitStop ? 'stop' : 'length', hitStop: !!step.hitStop, tokensOut: 0, via: 'raw_completions' };
    },
    _prompts: prompts,
  };
}

// fake 脑：记录最后一次 chat 的 messages，返回固定 reply。
function fakeAdapter() {
  const chatCalls = [];
  return {
    model: 'q',
    baseUrl: 'http://x/v1',
    apiKey: 'k',
    chat: async (messages, opts) => { chatCalls.push({ messages, opts }); return { reply: '【立论】终判', tokensIn: 1, tokensOut: 2 }; },
    _chatCalls: chatCalls,
  };
}

describe('createBudgetForcedThink —— 接入桥（OFF 返回 null / ON 真跑强制思考）', () => {
  it('OFF（config.enabled=false）→ 返回 null（调用方不接线 = 零回归）', () => {
    const config = resolveBudgetForcing({ env: {} });
    const think = createBudgetForcedThink({ adapter: fakeAdapter(), config, completion: fakeCompletion([]) });
    expect(think).toBe(null);
  });

  it('ON 端到端：达 min 前模型想停 → 注入续推词逼续写一轮，再让脑定稿（证明开了真生效）', async () => {
    const config = resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1', NOE_BUDGET_FORCING_MIN_TOKENS: '200', NOE_BUDGET_FORCING_MAX_TOKENS: '8192', NOE_BUDGET_FORCING_DEPTH: 'normal' } });
    const cap = fakeCompletion([
      { text: 'x'.repeat(40), hitStop: true },   // 第1轮 10token 就想停（命中 </think>），但未达 min=200
      { text: 'y'.repeat(800), hitStop: true },  // 注入「等等，」后续写 200token → 达 min，放行
    ]);
    const adapter = fakeAdapter();
    const think = createBudgetForcedThink({ adapter, config, completion: cap });
    expect(typeof think).toBe('function');
    const messages = [{ role: 'system', content: 'SYS' }, { role: 'user', content: '焦点：要不要发提醒' }];
    const r = await think({ messages });

    // 1) 返回 reply 与脑产出一致（同形于 adapter.chat）
    expect(r.reply).toBe('【立论】终判');
    // 2) 强制思考诊断 meta：确实跑了 budget forcing，且用掉 1 次 ignore（被逼想了一轮）
    expect(r.budgetForcing).toBeTruthy();
    expect(r.budgetForcing.ignoresUsed).toBe(1);
    expect(r.budgetForcing.rounds).toBe(2);
    expect(r.budgetForcing.stopReason).toBe('wants_stop_min_met');
    // 3) 第二轮 prompt 必须把上一轮思考 + 续推词「等等，」拼回去（s1 续写本质，开了真生效的硬证据）
    expect(cap._prompts[1]).toContain('等等，');
    expect(cap._prompts[1]).toContain('x'.repeat(40));
    expect(cap._prompts[0].startsWith === undefined || cap._prompts[0].includes(THINK_OPEN.trim())).toBe(true);
    // 4) 定稿调用：把强制出来的思考作为已想内容喂回脑
    const lastChat = adapter._chatCalls[adapter._chatCalls.length - 1];
    expect(JSON.stringify(lastChat.messages)).toContain('我已完成思考');
  });

  it('深思模型用 config.model 覆盖（高风险走指定本地模型）', async () => {
    const config = resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1', NOE_BUDGET_FORCING_MODEL: 'q35-6', NOE_BUDGET_FORCING_MIN_TOKENS: '1' } });
    const cap = fakeCompletion([{ text: 'done', hitStop: true }]);
    const adapter = fakeAdapter();
    const think = createBudgetForcedThink({ adapter, config, completion: cap });
    const r = await think({ messages: [{ role: 'user', content: 'hi' }] });
    // 定稿 chat 用归一化后的 model
    const lastChat = adapter._chatCalls[adapter._chatCalls.length - 1];
    expect(lastChat.opts.model).toBe('qwen/qwen3.6-35b-a3b'); // q35-6 → 主脑
    expect(r.budgetForcing.depth).toBe('normal');
  });

  it('fail-open：思考阶段崩（complete 抛）→ 回退普通 adapter.chat，仍返回 reply', async () => {
    const config = resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1', NOE_BUDGET_FORCING_MIN_TOKENS: '1' } });
    const cap = { currentMode: () => 'raw_completions', complete: async () => { throw new Error('lmstudio down'); }, probe: async () => 'raw_completions', setMode() {} };
    const adapter = fakeAdapter();
    const think = createBudgetForcedThink({ adapter, config, completion: cap, log: { warn() {} } });
    const r = await think({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.reply).toBe('【立论】终判'); // 回退普通 chat 仍出结果
    expect(r.budgetForcing).toBeUndefined(); // 没跑成强制思考
  });

  it('思考零产出 → 回退普通 chat（不喂空思考降质）', async () => {
    const config = resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1', NOE_BUDGET_FORCING_MIN_TOKENS: '1' } });
    const cap = fakeCompletion([{ text: '', hitStop: true }]);
    const adapter = fakeAdapter();
    const think = createBudgetForcedThink({ adapter, config, completion: cap });
    const r = await think({ messages: [{ role: 'user', content: 'hi' }] });
    expect(r.reply).toBe('【立论】终判');
    expect(r.budgetForcing).toBeUndefined();
  });

  it('adapter 无 baseUrl 且未注入续写能力 → 返回 null（无法续写就别接线，回退普通深思）', () => {
    const config = resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1' } });
    const adapter = { model: 'q', chat: async () => ({ reply: 'x' }) }; // 无 baseUrl
    const think = createBudgetForcedThink({ adapter, config, log: { warn() {} } });
    expect(think).toBe(null);
  });
});
