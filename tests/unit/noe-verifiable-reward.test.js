// @ts-check
import { describe, it, expect } from 'vitest';
import {
  formatReward,
  lenReward,
  reasoningStepsReward,
  repetitionPenalty,
  createVerifiableReward,
  DEFAULT_REWARD_WEIGHTS,
} from '../../src/cognition/NoeVerifiableReward.js';

describe('formatReward — <think>/<answer> 结构校验（借鉴 open-r1 format_reward）', () => {
  it('严格结构闭合 → 1', () => {
    expect(formatReward('<think>推一下</think><answer>42</answer>')).toBe(1);
    // 标签间空白允许（open-r1 \s*）
    expect(formatReward('<think>a</think>\n  <answer>b</answer>')).toBe(1);
    // 跨行内容（[\s\S] 等价 DOTALL）
    expect(formatReward('<think>line1\nline2</think><answer>x\ny</answer>')).toBe(1);
  });

  it('缺标签 / 顺序错 / 未闭合 → 0', () => {
    expect(formatReward('<answer>42</answer>')).toBe(0);
    expect(formatReward('<think>只想没答</think>')).toBe(0);
    expect(formatReward('<answer>先答</answer><think>后想</think>')).toBe(0);
    expect(formatReward('<think>没闭合<answer>x</answer>')).toBe(0);
  });

  it('strict=true（默认）下结构外有杂质 → 0；strict=false 只要包含即可 → 1', () => {
    const dirty = '前言<think>a</think><answer>b</answer>后记';
    expect(formatReward(dirty)).toBe(0);
    expect(formatReward(dirty, { strict: false })).toBe(1);
  });

  it('自定义标签名 + 大小写不敏感', () => {
    expect(formatReward('<reason>r</reason><final>f</final>', { thinkTag: 'reason', answerTag: 'final' })).toBe(1);
    expect(formatReward('<THINK>a</THINK><ANSWER>b</ANSWER>')).toBe(1);
  });

  it('边界：空串 / null / 非字符串 → 0（fail-safe 不抛）', () => {
    expect(formatReward('')).toBe(0);
    expect(formatReward('   ')).toBe(0);
    // @ts-expect-error 故意传非法
    expect(formatReward(null)).toBe(0);
    // @ts-expect-error 故意传非法
    expect(formatReward(123)).toBe(0);
  });
});

describe('lenReward — 同组长度归一（借鉴 open-r1 len_reward / Kimi-1.5）', () => {
  it('对的答案：越短奖励越高、越长越低，范围 [-0.5, 0.5]', () => {
    const r = lenReward([
      { text: 'aa', correct: true },      // 最短
      { text: 'aaaaaaaaaa', correct: true }, // 最长
    ]);
    expect(r[0]).toBeCloseTo(0.5, 6);  // 最短对 → +0.5
    expect(r[1]).toBeCloseTo(-0.5, 6); // 最长对 → -0.5
    expect(r[0]).toBeGreaterThan(r[1]);
  });

  it('错的答案封顶 0：绝不因为短而奖励错答（min(0, λ)）', () => {
    const r = lenReward([
      { text: 'aa', correct: false },        // 最短但错
      { text: 'aaaaaaaaaa', correct: true }, // 最长但对
    ]);
    expect(r[0]).toBe(0);              // 短的错答：λ=+0.5 → min(0,0.5)=0
    expect(r[1]).toBeCloseTo(-0.5, 6); // 长的对答仍按 λ 扣
  });

  it('全组等长 → 全 0（无可区分信号，open-r1 同款保护）', () => {
    const r = lenReward([
      { text: 'abc', correct: true },
      { text: 'xyz', correct: false },
    ]);
    expect(r).toEqual([0, 0]);
  });

  it('中间长度线性插值', () => {
    const r = lenReward([
      { text: 'a', correct: true },     // len 1 (min)
      { text: 'aaa', correct: true },   // len 3 (mid)
      { text: 'aaaaa', correct: true }, // len 5 (max)
    ]);
    expect(r[0]).toBeCloseTo(0.5, 6);
    expect(r[1]).toBeCloseTo(0.0, 6);  // 0.5 - (3-1)/(5-1) = 0
    expect(r[2]).toBeCloseTo(-0.5, 6);
  });

  it('可注入计长函数（如 token 数）', () => {
    const wordCount = (t) => t.split(/\s+/).filter(Boolean).length;
    const r = lenReward(
      [
        { text: 'one', correct: true },                 // 1 词 (min)
        { text: 'one two three four five', correct: true }, // 5 词 (max)
      ],
      { measure: wordCount },
    );
    expect(r[0]).toBeCloseTo(0.5, 6);
    expect(r[1]).toBeCloseTo(-0.5, 6);
  });

  it('边界：空数组 / 非数组 → []', () => {
    expect(lenReward([])).toEqual([]);
    // @ts-expect-error 故意传非法
    expect(lenReward(null)).toEqual([]);
  });
});

describe('reasoningStepsReward — 分步计数归一（借鉴 open-r1 reasoning_steps_reward）', () => {
  it('英文列表项 / Step N / 序数词都计数，min(1, count/3)', () => {
    expect(reasoningStepsReward('- a\n- b\n- c')).toBeCloseTo(1, 6); // 3 项 → 满分
    expect(reasoningStepsReward('- a\n- b')).toBeCloseTo(2 / 3, 6);  // 2 项
    expect(reasoningStepsReward('Step 1 do\nStep 2 do\nStep 3 do')).toBeCloseTo(1, 6);
    expect(reasoningStepsReward('First, x. Second, y. Finally, z.')).toBeCloseTo(1, 6);
  });

  it('超过 target 封顶 1（不靠堆步骤刷分）', () => {
    expect(reasoningStepsReward('- a\n- b\n- c\n- d\n- e')).toBe(1);
  });

  it('中文分步：第N步 + 过渡词', () => {
    expect(reasoningStepsReward('第一步分析；第二步推导；第三步作答')).toBeCloseTo(1, 6);
    expect(reasoningStepsReward('首先，看条件。然后，列式。最后，求解。')).toBeCloseTo(1, 6);
  });

  it('无任何分步标记 → 0', () => {
    expect(reasoningStepsReward('这是一段没有分步的连续叙述。')).toBe(0);
  });

  it('自定义 stepsTarget', () => {
    expect(reasoningStepsReward('- a\n- b', { stepsTarget: 2 })).toBeCloseTo(1, 6);
    expect(reasoningStepsReward('- a', { stepsTarget: 2 })).toBeCloseTo(0.5, 6);
  });

  it('边界：空 / null → 0', () => {
    expect(reasoningStepsReward('')).toBe(0);
    // @ts-expect-error 故意传非法
    expect(reasoningStepsReward(null)).toBe(0);
  });
});

describe('repetitionPenalty — n-gram 复读惩罚（借鉴 open-r1 get_repetition_penalty_reward）', () => {
  it('完全不重复 → 0', () => {
    expect(repetitionPenalty('the quick brown fox jumps over', { ngramSize: 2 })).toBe(0);
  });

  it('机械复读 → 趋近 maxPenalty', () => {
    // "a a a a a" 的 2-gram 全是 (a,a)：unique=1, total=4 → scaling=0.75 → 0.75*-1
    const p = repetitionPenalty('a a a a a', { ngramSize: 2, maxPenalty: -1 });
    expect(p).toBeCloseTo(-0.75, 6);
    expect(p).toBeLessThan(0);
  });

  it('penalty 必 ≤0，且不低于 maxPenalty（范围 [maxPenalty,0]）', () => {
    const p = repetitionPenalty('x x x x x x x x', { ngramSize: 2, maxPenalty: -0.5 });
    expect(p).toBeLessThanOrEqual(0);
    expect(p).toBeGreaterThanOrEqual(-0.5);
  });

  it('部分重复：scaling = 1 - unique/total', () => {
    // tokens: a b a b a  → 2-gram: (a,b)(b,a)(a,b)(b,a) total=4 unique=2 → scaling=0.5
    const p = repetitionPenalty('a b a b a', { ngramSize: 2, maxPenalty: -1 });
    expect(p).toBeCloseTo(-0.5, 6);
  });

  it('token 数不足一个 n-gram → 0（open-r1 同款保护）', () => {
    expect(repetitionPenalty('a b', { ngramSize: 3 })).toBe(0);
    expect(repetitionPenalty('only', { ngramSize: 2 })).toBe(0);
  });

  it('maxPenalty 传正数被夹到无惩罚（守 ≤0 契约）', () => {
    expect(repetitionPenalty('a a a a', { ngramSize: 2, maxPenalty: 5 })).toBe(0);
  });

  it('中文逐字分词：重复短语被惩罚', () => {
    // "好好好好" CJK 逐字 → 4 token → bigram (好,好)×3：total=3, unique=1（同一个 (好好)）。
    // 按 open-r1 公式 scaling = 1 - unique/total = 1 - 1/3 = 2/3 → penalty = 2/3 * -1 = -2/3。
    // （注：scaling 度量的是"重复占比"，不是 unique 数；4 字只产生 3 个 bigram，
    //  其中 1 个唯一、2 个是重复出现，故 scaling=2/3 而非 1——要 scaling→1 需序列无限长。）
    expect(repetitionPenalty('好好好好', { ngramSize: 2, maxPenalty: -1 })).toBeCloseTo(-2 / 3, 6);
    expect(repetitionPenalty('今天天气很好心情不错', { ngramSize: 2 })).toBe(0); // 无重复 bigram
  });

  it('可注入自定义分词器；分词器抛错 → 0（fail-safe）', () => {
    const charTok = (t) => [...t];
    expect(repetitionPenalty('xx', { ngramSize: 1, maxPenalty: -1, tokenize: charTok })).toBeCloseTo(-0.5, 6);
    const boom = () => { throw new Error('炸'); };
    expect(repetitionPenalty('whatever text here', { tokenize: boom })).toBe(0);
  });

  it('边界：空 / null → 0', () => {
    expect(repetitionPenalty('')).toBe(0);
    // @ts-expect-error 故意传非法
    expect(repetitionPenalty(null)).toBe(0);
  });
});

describe('createVerifiableReward — 组合自评（env 门控默认 OFF）', () => {
  const goodOutput = '<think>第一步分析；第二步推导；第三步作答</think><answer>结论清晰</answer>';

  it('默认权重对外可见且为预期值', () => {
    expect(DEFAULT_REWARD_WEIGHTS).toEqual({ format: 1.0, reasoningSteps: 1.0, repetition: 1.0 });
  });

  it('env 未开 → enabled=false，score()=null（行为零变化，fail-open 给调用方跳过）', () => {
    const rw = createVerifiableReward({ env: {} });
    expect(rw.enabled).toBe(false);
    const out = rw.score(goodOutput);
    expect(out).toEqual({ enabled: false, score: null, parts: null });
  });

  it('NOE_VERIFIABLE_REWARD=1 → 启用并给出客观分（结构+分步加分、重复扣分）', () => {
    const rw = createVerifiableReward({ env: { NOE_VERIFIABLE_REWARD: '1' } });
    expect(rw.enabled).toBe(true);
    const out = rw.score(goodOutput);
    expect(out.enabled).toBe(true);
    expect(out.parts.format).toBe(1);
    expect(out.parts.reasoningSteps).toBeCloseTo(1, 6);
    expect(out.parts.repetition).toBeLessThanOrEqual(0);
    // 加权和 = 1*1 + 1*1 + 1*(≤0) ≈ 2（该样本无 n-gram 重复 → repetition=0）
    expect(out.score).toBeCloseTo(2, 6);
  });

  it('显式 enabled 优先于 env', () => {
    const off = createVerifiableReward({ env: { NOE_VERIFIABLE_REWARD: '1' }, enabled: false });
    expect(off.enabled).toBe(false);
    expect(off.score(goodOutput).score).toBe(null);
    const on = createVerifiableReward({ env: {}, enabled: true });
    expect(on.enabled).toBe(true);
    expect(on.score(goodOutput).score).not.toBe(null);
  });

  it('结构差的输出客观分明显更低（区分能力）', () => {
    const rw = createVerifiableReward({ enabled: true });
    const good = rw.score(goodOutput).score;
    const bad = rw.score('随便糊一句没结构没分步').score;
    expect(good).toBeGreaterThan(bad);
  });

  it('自定义权重生效：调大 repetition 权重 → 复读样本扣更狠', () => {
    const text = '<think>a a a a a a a a</think><answer>x</answer>';
    const light = createVerifiableReward({ enabled: true, weights: { repetition: 1 } }).score(text).score;
    const heavy = createVerifiableReward({ enabled: true, weights: { repetition: 5 } }).score(text).score;
    expect(heavy).toBeLessThan(light); // repetition 项为负，权重越大总分越低
  });

  it('确定性：同输入多次调用结果完全一致（无随机/时钟依赖）', () => {
    const rw = createVerifiableReward({ enabled: true });
    const a = rw.score(goodOutput);
    const b = rw.score(goodOutput);
    expect(a).toEqual(b);
  });
});
