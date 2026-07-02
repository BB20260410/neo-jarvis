import { describe, it, expect } from 'vitest';
import {
  decideThinkingControl,
  resolveBudgetForcing,
  runBudgetForcedThinking,
  approxTokenCount,
  BUDGET_FORCING_DEPTHS,
  DEFAULT_CONTINUE_INJECT,
  DEFAULT_FINALIZE_INJECT,
} from '../../src/cognition/NoeBudgetForcing.js';

describe('decideThinkingControl —— s1 budget forcing 决策核心', () => {
  it('任务规格①：未达 minBudget 且模型想停 → continue，注入诱导词抑制结束', () => {
    const r = decideThinkingControl({ tokensUsed: 100, minBudget: 256, maxBudget: 8192, wantsStop: true });
    expect(r.action).toBe('continue');
    expect(r.inject).toBe(DEFAULT_CONTINUE_INJECT); // 默认「等等，」（s1 的 "Wait" 中文等价）
    expect(r.reason).toBe('below_min_budget');
  });

  it('任务规格②：超 maxBudget → finalize，注入收束词逼收尾', () => {
    const r = decideThinkingControl({ tokensUsed: 9000, minBudget: 256, maxBudget: 8192, wantsStop: false });
    expect(r.action).toBe('finalize');
    expect(r.inject).toBe(DEFAULT_FINALIZE_INJECT); // 默认「综上，」
    expect(r.reason).toBe('max_budget_reached');
    expect(r.remainingBudget).toBe(0);
  });

  it('上限优先：即使模型还想继续想，超过 maxBudget 也强制收尾（防本地小模型无限打转）', () => {
    const r = decideThinkingControl({ tokensUsed: 8192, minBudget: 256, maxBudget: 8192, wantsStop: false });
    expect(r.action).toBe('finalize');
  });

  it('模型想停且已达 minBudget → stop（顺其自然，不强行逼想）', () => {
    const r = decideThinkingControl({ tokensUsed: 300, minBudget: 256, maxBudget: 8192, wantsStop: true });
    expect(r.action).toBe('stop');
    expect(r.inject).toBe('');
    expect(r.reason).toBe('wants_stop_min_met');
  });

  it('shallow 档：达 minBudget 即可提前截断省 token（minBudget 设 0 时第一次想停就放行）', () => {
    const r = decideThinkingControl({ tokensUsed: 10, minBudget: 0, maxBudget: 8192, wantsStop: true });
    expect(r.action).toBe('stop');
    expect(r.reason).toBe('wants_stop_min_met');
  });

  it('模型不想停且在预算内 → continue 但不注入额外词（不干预自然推理）', () => {
    const r = decideThinkingControl({ tokensUsed: 500, minBudget: 256, maxBudget: 8192, wantsStop: false });
    expect(r.action).toBe('continue');
    expect(r.inject).toBe('');
    expect(r.reason).toBe('within_budget');
  });

  it('防失控 a：忽略次数用尽（ignoresLeft<=0）即使没到 minBudget 也尊重模型的停', () => {
    const r = decideThinkingControl({
      tokensUsed: 100, minBudget: 256, maxBudget: 8192, wantsStop: true,
      ignoresUsed: 3, maxIgnores: 3,
    });
    expect(r.action).toBe('stop');
    expect(r.reason).toBe('ignore_budget_exhausted');
    expect(r.ignoresLeft).toBe(0);
  });

  it('防失控 b：注入后这一轮零新增 token = 原地打转 → 停（借鉴报告§577⑤ 监控 Wait 是否真在前进）', () => {
    const r = decideThinkingControl({
      tokensUsed: 100, minBudget: 256, maxBudget: 8192, wantsStop: true,
      ignoresUsed: 1, maxIgnores: 3, lastDeltaTokens: 0,
    });
    expect(r.action).toBe('stop');
    expect(r.reason).toBe('no_progress_after_inject');
  });

  it('还有忽略额度且仍在前进时，继续逼想（与防失控不冲突）', () => {
    const r = decideThinkingControl({
      tokensUsed: 100, minBudget: 256, maxBudget: 8192, wantsStop: true,
      ignoresUsed: 1, maxIgnores: 3, lastDeltaTokens: 40,
    });
    expect(r.action).toBe('continue');
    expect(r.ignoresLeft).toBe(2);
  });

  it('maxBudget<=0 视为不设上限：remainingBudget=Infinity，永不因上限收尾', () => {
    const r = decideThinkingControl({ tokensUsed: 999999, minBudget: 256, maxBudget: 0, wantsStop: false });
    expect(r.action).toBe('continue');
    expect(r.remainingBudget).toBe(Number.POSITIVE_INFINITY);
  });

  it('可自定义注入词（中英文均可）', () => {
    const r = decideThinkingControl({
      tokensUsed: 10, minBudget: 256, maxBudget: 8192, wantsStop: true,
      continueInject: 'Wait\n',
    });
    expect(r.inject).toBe('Wait\n');
  });

  it('边界/脏输入容错：负数、NaN、缺省都不抛，按 0 处理', () => {
    const r = decideThinkingControl({ tokensUsed: -5, minBudget: NaN, maxBudget: undefined, wantsStop: true });
    expect(['continue', 'stop', 'finalize']).toContain(r.action);
    // minBudget→0、tokensUsed→0、无上限：想停且已达 min(0) → stop
    expect(r.action).toBe('stop');
  });
});

describe('resolveBudgetForcing —— env 门控（默认 OFF，镜像 NoeReflectBrain）', () => {
  it('默认 OFF：未开 NOE_BUDGET_FORCING 时 enabled=false（深思保持现状，零行为变化）', () => {
    const r = resolveBudgetForcing({ env: {} });
    expect(r.enabled).toBe(false);
    expect(r.model).toBe(null);
  });

  it('开启后默认 normal 档 = numIgnore 1，预算 256/8192', () => {
    const r = resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1' } });
    expect(r.enabled).toBe(true);
    expect(r.depth).toBe('normal');
    expect(r.numIgnore).toBe(1);
    expect(r.minBudget).toBe(256);
    expect(r.maxBudget).toBe(8192);
  });

  it('深度档映射 verbatim 自报告§577：shallow/normal/deep = 0/1/3', () => {
    expect(BUDGET_FORCING_DEPTHS).toEqual({ shallow: 0, normal: 1, deep: 3 });
    expect(resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1', NOE_BUDGET_FORCING_DEPTH: 'shallow' } }).numIgnore).toBe(0);
    expect(resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1', NOE_BUDGET_FORCING_DEPTH: 'deep' } }).numIgnore).toBe(3);
  });

  it('非法 depth 警告并回退 normal', () => {
    const warns = [];
    const r = resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1', NOE_BUDGET_FORCING_DEPTH: 'ultra' }, log: { warn: (m) => warns.push(m) } });
    expect(r.depth).toBe('normal');
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('回退 normal');
  });

  it('env 可覆盖预算；防呆 max<min 抬到 min 并警告', () => {
    const warns = [];
    const r = resolveBudgetForcing({
      env: { NOE_BUDGET_FORCING: '1', NOE_BUDGET_FORCING_MIN_TOKENS: '1000', NOE_BUDGET_FORCING_MAX_TOKENS: '500' },
      log: { warn: (m) => warns.push(m) },
    });
    expect(r.minBudget).toBe(1000);
    expect(r.maxBudget).toBe(1000);
    expect(warns.some((w) => w.includes('抬到 min'))).toBe(true);
  });

  it('模型 id 经 NoeLocalModelPolicy 归一化（legacy 别名→主脑）', () => {
    const r = resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1', NOE_BUDGET_FORCING_MODEL: 'q35-6' } });
    expect(r.model).toBe('qwen/qwen3.6-35b-a3b'); // q35-6 是 legacy 别名
  });

  it('可覆盖注入词', () => {
    const r = resolveBudgetForcing({ env: { NOE_BUDGET_FORCING: '1', NOE_BUDGET_FORCING_CONTINUE: 'Wait\n', NOE_BUDGET_FORCING_FINALIZE: 'Therefore, ' } });
    expect(r.continueInject).toBe('Wait\n');
    expect(r.finalizeInject).toBe('Therefore, ');
  });
});

describe('approxTokenCount —— 无依赖 token 估算', () => {
  it('空串 0；纯 ASCII 约 4 字符 1 token；CJK 约 1 字 1 token', () => {
    expect(approxTokenCount('')).toBe(0);
    expect(approxTokenCount('abcd')).toBe(1);
    expect(approxTokenCount('你好世界')).toBe(4);
  });
  it('混合中英确定性可复算', () => {
    // 4 个汉字 + "ok"(2 ascii→ceil(2/4)=1) = 5
    expect(approxTokenCount('深思熟虑ok')).toBe(5);
  });
});

describe('runBudgetForcedThinking —— 注入式编排循环（确定性 mock，不发网络）', () => {
  // 构造一个确定性「假模型」：按脚本逐轮返回 {text, wantsStop}
  function scriptedGenerate(script) {
    let i = 0;
    const calls = [];
    const fn = async (ctx) => {
      calls.push(ctx);
      const step = script[Math.min(i, script.length - 1)];
      i += 1;
      return typeof step === 'function' ? step(ctx) : step;
    };
    fn.calls = calls;
    return fn;
  }

  it('normal 档：模型第一轮就想停但没到 minBudget → 注入「等等，」逼想一轮，第二轮放行', async () => {
    const gen = scriptedGenerate([
      { text: 'x'.repeat(40), wantsStop: true }, // 第1轮 10 token，想停，但 minBudget=200 未达
      { text: 'y'.repeat(800), wantsStop: true }, // 注入后第2轮再产出 200 token，已达 min → stop
    ]);
    const r = await runBudgetForcedThinking({
      generate: gen, basePrompt: 'PROMPT<think>',
      minBudget: 200, maxBudget: 8192, numIgnore: 1,
    });
    expect(r.rounds).toBe(2);
    expect(r.ignoresUsed).toBe(1);
    expect(r.stopReason).toBe('wants_stop_min_met');
    // 第二轮 prompt 必须把上一轮思考 + 诱导词拼回去（s1 续写本质）
    expect(gen.calls[1].prompt).toContain(DEFAULT_CONTINUE_INJECT);
    expect(gen.calls[1].prompt).toContain('x'.repeat(40));
  });

  it('deep 档忽略额度用尽即止：模型每轮都想停且每轮零进展也不会死循环', async () => {
    const gen = scriptedGenerate([{ text: '', wantsStop: true }]); // 恒返空+想停
    const r = await runBudgetForcedThinking({
      generate: gen, basePrompt: 'P', minBudget: 9999, maxBudget: 8192, numIgnore: 3,
    });
    // 第一轮想停未达 min → 注入继续；第二轮注入后零进展 → no_progress_after_inject 停
    expect(r.stopReason).toBe('no_progress_after_inject');
    expect(r.rounds).toBeLessThanOrEqual(2);
  });

  it('超 maxBudget 强制收尾：思考尾部追加收束词，finalized=true', async () => {
    const gen = scriptedGenerate([{ text: 'z'.repeat(40000), wantsStop: false }]); // 一轮就爆上限
    const r = await runBudgetForcedThinking({
      generate: gen, basePrompt: '', minBudget: 200, maxBudget: 8192, numIgnore: 3,
    });
    expect(r.finalized).toBe(true);
    expect(r.stopReason).toBe('max_budget_reached');
    expect(r.thinking.endsWith(DEFAULT_FINALIZE_INJECT)).toBe(true);
  });

  it('fail-open：generate 抛错不冒泡，用已生成思考收场', async () => {
    let n = 0;
    const gen = async () => {
      n += 1;
      if (n === 1) return { text: 'abcd', wantsStop: false };
      throw new Error('lmstudio down');
    };
    const r = await runBudgetForcedThinking({
      generate: gen, basePrompt: '', minBudget: 9999, maxBudget: 99999, numIgnore: 3,
    });
    expect(r.stopReason).toBe('generate_error');
    expect(r.thinking).toBe('abcd'); // 第一轮的产出保留
    expect(r.steps.some((s) => s.error)).toBe(true);
  });

  it('maxRounds 硬上限兜底：generate 永不想停也不爆预算时不会无限跑', async () => {
    const gen = scriptedGenerate([{ text: 'aa', wantsStop: false }]); // 每轮 1 token，永不停
    const r = await runBudgetForcedThinking({
      generate: gen, basePrompt: '', minBudget: 1, maxBudget: 1_000_000, numIgnore: 0, maxRounds: 5,
    });
    expect(r.rounds).toBe(5);
    expect(r.stopReason).toBe('max_rounds');
  });

  it('注入式 estimateTokens 可替换（用更准的估算器）', async () => {
    const gen = scriptedGenerate([{ text: 'whatever', wantsStop: true }]);
    const r = await runBudgetForcedThinking({
      generate: gen, basePrompt: '', minBudget: 5, maxBudget: 100, numIgnore: 1,
      estimateTokens: () => 10, // 每轮恒计 10 token → 一轮即达 min(5) → 想停放行
    });
    expect(r.tokensUsed).toBe(10);
    expect(r.stopReason).toBe('wants_stop_min_met');
  });

  it('generate 非函数立即抛 TypeError（接线错误早暴露）', async () => {
    await expect(runBudgetForcedThinking({ generate: null, minBudget: 1, maxBudget: 2 }))
      .rejects.toThrow(TypeError);
  });
});