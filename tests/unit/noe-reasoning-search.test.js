// @ts-check
// NoeReasoningSearch 单测：确定性 mock generate/evaluate，验证 beam 选路 / greedy / 剪枝 / 上限 / fail-open / env 门控。
// 不触网、不读真模型、不读真时钟——generate/evaluate 全部注入纯函数，makeId 注入确定性自增。

import { describe, it, expect } from 'vitest';
import {
  createReasoningSearch,
  readReasoningSearchEnv,
  DEFAULT_SEARCH_PARAMS,
  estimateTopicComplexity,
} from '../../src/cognition/NoeReasoningSearch.js';

/** 造一个确定性 id 生成器（每次新建搜索器都从 0 开始，断言可重现）。 */
function makeSeqId() {
  let i = 0;
  return () => `n${i++}`;
}

describe('createReasoningSearch —— 构造期校验', () => {
  it('缺 generate 抛 TypeError', () => {
    // @ts-expect-error 故意缺参
    expect(() => createReasoningSearch({ evaluate: () => 0 })).toThrow(TypeError);
  });
  it('缺 evaluate 抛 TypeError', () => {
    // @ts-expect-error 故意缺参
    expect(() => createReasoningSearch({ generate: () => [] })).toThrow(TypeError);
  });
});

describe('beam 选路 —— 借鉴 ToT bfs.solve 的发散→打分→剪枝', () => {
  it('两层 beam：每层按分数保留最优 width 条，最终选出全局最高分路径', async () => {
    // 设计一个有「贪心陷阱」的搜索空间：
    //   根 "S"。
    //   第一层候选：A(score 5), B(score 4), C(score 1)。width=2 → 保留 A,B（剪掉 C）。
    //   第二层：A 的孩子 A1(3)、A2(2)；B 的孩子 B1(9)、B2(1)。
    //   全局最高 = B1(9)，但 B 在第一层不是最高分（A 才是）。
    //   beam 宽度 2 同时保住了 A 和 B，所以第二层能找到 B1=9。
    const childMap = {
      S: [{ content: 'A' }, { content: 'B' }, { content: 'C' }],
      A: [{ content: 'A1' }, { content: 'A2' }],
      B: [{ content: 'B1' }, { content: 'B2' }],
    };
    const scoreMap = { S: 0, A: 5, B: 4, C: 1, A1: 3, A2: 2, B1: 9, B2: 1 };

    const generate = (node) => childMap[node.content] || [];
    const evaluate = (node) => scoreMap[node.content] ?? 0;

    const rs = createReasoningSearch({ generate, evaluate, makeId: makeSeqId() });
    const r = await rs.search({ root: 'S', width: 2, depth: 2, strategy: 'beam' });

    expect(r.best.content).toBe('B1');
    expect(r.bestScore).toBe(9);
    expect(r.bestPath).toEqual(['B', 'B1']); // 决策路径：根→B→B1
    expect(r.stats.strategy).toBe('beam');
    expect(r.stats.width).toBe(2);
    expect(r.stats.depth).toBe(2);
  });

  it('窄 beam 会丢掉贪心陷阱外的更优解：width=1 时第一层只留 A，找不到 B1=9', async () => {
    const childMap = {
      S: [{ content: 'A' }, { content: 'B' }],
      A: [{ content: 'A1' }],
      B: [{ content: 'B1' }],
    };
    const scoreMap = { S: 0, A: 5, B: 4, A1: 3, B1: 9 };
    const rs = createReasoningSearch({
      generate: (n) => childMap[n.content] || [],
      evaluate: (n) => scoreMap[n.content] ?? 0,
      makeId: makeSeqId(),
    });
    // width=1（等价 greedy）：第一层只留 A（5>4），第二层只剩 A1=3，错过 B1=9
    const r = await rs.search({ root: 'S', width: 1, depth: 2, strategy: 'beam' });
    expect(r.best.content).toBe('A1');
    expect(r.bestScore).toBe(3);
  });
});

describe('greedy 策略 —— 退化为 width=1 的 beam', () => {
  it('strategy=greedy 时无论传多大 width 都强制 width=1', async () => {
    const childMap = {
      S: [{ content: 'A' }, { content: 'B' }],
      A: [{ content: 'A1' }],
      B: [{ content: 'B1' }],
    };
    const scoreMap = { S: 0, A: 5, B: 4, A1: 3, B1: 9 };
    const rs = createReasoningSearch({
      generate: (n) => childMap[n.content] || [],
      evaluate: (n) => scoreMap[n.content] ?? 0,
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 8, depth: 2, strategy: 'greedy' });
    expect(r.stats.strategy).toBe('greedy');
    expect(r.stats.width).toBe(1);          // 被强制成 1
    expect(r.best.content).toBe('A1');      // 贪心只跟 A，错过 B1
  });
});

describe('剪枝可观测 —— 被剪掉的分支不挂到 tree.children', () => {
  it('第一层 width=2 剪掉 C：根的 children 只挂 A、B', async () => {
    const childMap = { S: [{ content: 'A' }, { content: 'B' }, { content: 'C' }] };
    const scoreMap = { S: 0, A: 5, B: 4, C: 1 };
    const rs = createReasoningSearch({
      generate: (n) => childMap[n.content] || [],
      evaluate: (n) => scoreMap[n.content] ?? 0,
      makeId: makeSeqId(),
    });
    // depth=1 只发散一层；root.children 应含全部被「评估过」的子（含被剪的 C，挂在生成它的父下）
    const r = await rs.search({ root: 'S', width: 2, depth: 1, strategy: 'beam' });
    // 全部 3 个子都被评估并挂在根下（children 记录的是「展开过的」，剪枝只影响 frontier）
    const childContents = r.tree.children.map((c) => c.content).sort();
    expect(childContents).toEqual(['A', 'B', 'C']);
    // 但 frontier（存活 beam）只保留最优 2 条
    expect(r.frontier.map((n) => n.content).sort()).toEqual(['A', 'B']);
    expect(r.best.content).toBe('A'); // 这一层最高分
  });
});

describe('防爆上限 —— width/depth/maxChildren 被夹到上限内', () => {
  it('width 超 maxWidth → 夹到 maxWidth', async () => {
    const rs = createReasoningSearch({
      generate: () => [],
      evaluate: () => 0,
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 999, depth: 1, params: { maxWidth: 4 } });
    expect(r.stats.width).toBe(4);
  });

  it('depth 超 maxDepth → 夹到 maxDepth', async () => {
    const rs = createReasoningSearch({
      generate: () => [],
      evaluate: () => 0,
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 2, depth: 999, params: { maxDepth: 3 } });
    expect(r.stats.depth).toBe(3);
  });

  it('单节点 generate 爆量 → 被 maxChildren 截断', async () => {
    // generate 返回 100 个候选，maxChildren=3 → 只评估前 3 个
    const many = Array.from({ length: 100 }, (_, i) => ({ content: `x${i}` }));
    let evalCount = 0;
    const rs = createReasoningSearch({
      generate: (n) => (n.depth === 0 ? many : []),
      evaluate: () => { evalCount++; return 1; },
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 8, depth: 1, params: { maxChildren: 3 } });
    expect(r.tree.children.length).toBe(3);
    // evaluate 次数 = 1(根) + 3(被截断后的子) = 4
    expect(evalCount).toBe(4);
    expect(r.stats.evaluations).toBe(4);
  });

  it('负 width/depth → 夹到下限（width≥1, depth≥0）', async () => {
    const rs = createReasoningSearch({ generate: () => [{ content: 'A' }], evaluate: () => 1, makeId: makeSeqId() });
    const r = await rs.search({ root: 'S', width: -5, depth: -3, strategy: 'beam' });
    expect(r.stats.width).toBe(1);
    expect(r.stats.depth).toBe(0);     // depth 夹到 0 → 不发散，best=root
    expect(r.best.content).toBe('S');
  });
});

describe('退化场景', () => {
  it('depth=0 → 不发散，直接返回打过分的根，bestPath 为空', async () => {
    const rs = createReasoningSearch({ generate: () => [{ content: 'A' }], evaluate: () => 7, makeId: makeSeqId() });
    const r = await rs.search({ root: 'S', width: 3, depth: 0 });
    expect(r.best.content).toBe('S');
    expect(r.bestScore).toBe(7);       // 根也被评分
    expect(r.bestPath).toEqual([]);
    expect(r.stats.generations).toBe(0);
    expect(r.stats.evaluations).toBe(1); // 只评了根
  });

  it('某层 generate 全空 → 提前停（不空转剩余深度），返回上一层最优', async () => {
    // 第一层产出 A、B；第二层两者都不再产出 → 在 d=1 提前 break
    const childMap = { S: [{ content: 'A' }, { content: 'B' }] };
    const scoreMap = { S: 0, A: 5, B: 8 };
    let genCalls = 0;
    const rs = createReasoningSearch({
      generate: (n) => { genCalls++; return childMap[n.content] || []; },
      evaluate: (n) => scoreMap[n.content] ?? 0,
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 2, depth: 5, strategy: 'beam' });
    expect(r.best.content).toBe('B'); // 第一层最优
    expect(r.bestScore).toBe(8);
    // generate 调用：根 1 次（产 A、B）+ 第二层对 A、B 各 1 次（都空）= 3 次；之后提前停，不再调
    expect(genCalls).toBe(3);
  });
});

describe('fail-open —— 坏 generate / 坏 evaluate 不炸整次搜索', () => {
  it('某节点 generate 抛错 → 该节点视为无子，其他分支照走', async () => {
    const rs = createReasoningSearch({
      generate: (n) => {
        if (n.content === 'BAD') throw new Error('boom');
        if (n.content === 'S') return [{ content: 'BAD' }, { content: 'GOOD' }];
        if (n.content === 'GOOD') return [{ content: 'GOOD1' }];
        return [];
      },
      evaluate: (n) => ({ S: 0, BAD: 5, GOOD: 4, GOOD1: 9 })[n.content] ?? 0,
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 2, depth: 2, strategy: 'beam' });
    // BAD 被保留进 beam（分 5），但它 generate 抛错 → 无子；GOOD 仍能产出 GOOD1=9
    expect(r.best.content).toBe('GOOD1');
    expect(r.bestScore).toBe(9);
  });

  it('evaluate 抛错或返回 NaN/非数 → 记 0 分（不污染排序）', async () => {
    const rs = createReasoningSearch({
      generate: (n) => (n.content === 'S' ? [{ content: 'X' }, { content: 'Y' }] : []),
      evaluate: (n) => {
        if (n.content === 'X') throw new Error('bad score');
        if (n.content === 'Y') return 3;
        return 0;
      },
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 2, depth: 1, strategy: 'beam' });
    expect(r.best.content).toBe('Y'); // X 评分抛错记 0，Y=3 胜出
    expect(r.bestScore).toBe(3);
  });

  it('evaluate 返回字符串/undefined → 折成 0', async () => {
    const rs = createReasoningSearch({
      generate: (n) => (n.content === 'S' ? [{ content: 'X' }] : []),
      // @ts-expect-error 故意返回非数字测 fail-open
      evaluate: () => 'not-a-number',
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 1, depth: 1 });
    expect(r.bestScore).toBe(0);
  });
});

describe('注入式 —— generate/evaluate 可异步（呼应 LLM/await 在外）', () => {
  it('async generate + async evaluate 正常被 await', async () => {
    const rs = createReasoningSearch({
      generate: async (n) => (n.content === 'S' ? [{ content: 'A' }, { content: 'B' }] : []),
      evaluate: async (n) => ({ S: 0, A: 2, B: 6 })[n.content] ?? 0,
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 2, depth: 1, strategy: 'beam' });
    expect(r.best.content).toBe('B');
    expect(r.bestScore).toBe(6);
  });

  it('generate 返回纯字符串数组（非对象）也能规整', async () => {
    const rs = createReasoningSearch({
      generate: (n) => (n.content === 'S' ? ['思路甲', '思路乙'] : []),
      evaluate: (n) => (n.content === '思路乙' ? 10 : 1),
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 2, depth: 1, strategy: 'beam' });
    expect(r.best.content).toBe('思路乙');
    expect(r.bestPath).toEqual(['思路乙']);
  });

  it('generate 返回里夹空串/空对象 → 被过滤，不产生空节点', async () => {
    const rs = createReasoningSearch({
      generate: (n) => (n.content === 'S' ? ['', { content: '' }, { content: 'A' }, null] : []),
      evaluate: () => 1,
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 4, depth: 1 });
    expect(r.tree.children.map((c) => c.content)).toEqual(['A']);
  });
});

describe('非法策略回退', () => {
  it('strategy 给未知值 → 回退默认 beam', async () => {
    const rs = createReasoningSearch({
      generate: (n) => (n.content === 'S' ? [{ content: 'A' }, { content: 'B' }] : []),
      evaluate: (n) => ({ A: 3, B: 1 })[n.content] ?? 0,
      makeId: makeSeqId(),
    });
    // @ts-expect-error 故意传非法策略
    const r = await rs.search({ root: 'S', width: 2, depth: 1, strategy: 'mcts-not-impl' });
    expect(r.stats.strategy).toBe(DEFAULT_SEARCH_PARAMS.strategy); // 'beam'
    expect(r.stats.width).toBe(2); // 没被 greedy 压成 1
  });
});

describe('readReasoningSearchEnv —— env 门控默认 OFF', () => {
  it('缺省 → 关闭', () => {
    expect(readReasoningSearchEnv({})).toEqual({ enabled: false, strategy: 'off' });
  });
  it("'off' / '0' / 空串 → 关闭", () => {
    expect(readReasoningSearchEnv({ NOE_REASONING_SEARCH: 'off' }).enabled).toBe(false);
    expect(readReasoningSearchEnv({ NOE_REASONING_SEARCH: '0' }).enabled).toBe(false);
    expect(readReasoningSearchEnv({ NOE_REASONING_SEARCH: '' }).enabled).toBe(false);
  });
  it("'beam' → 开启且策略 beam", () => {
    expect(readReasoningSearchEnv({ NOE_REASONING_SEARCH: 'beam' })).toEqual({ enabled: true, strategy: 'beam' });
  });
  it("'greedy' → 开启且策略 greedy", () => {
    expect(readReasoningSearchEnv({ NOE_REASONING_SEARCH: 'greedy' })).toEqual({ enabled: true, strategy: 'greedy' });
  });
  it("通用真值 'on'/'true'/'1' → 开启用默认 beam", () => {
    expect(readReasoningSearchEnv({ NOE_REASONING_SEARCH: 'on' })).toEqual({ enabled: true, strategy: 'beam' });
    expect(readReasoningSearchEnv({ NOE_REASONING_SEARCH: 'TRUE' })).toEqual({ enabled: true, strategy: 'beam' });
    expect(readReasoningSearchEnv({ NOE_REASONING_SEARCH: '1' })).toEqual({ enabled: true, strategy: 'beam' });
  });
  it('大小写/空格不敏感', () => {
    expect(readReasoningSearchEnv({ NOE_REASONING_SEARCH: '  Beam  ' }).strategy).toBe('beam');
  });
});

describe('stats 成本可观测', () => {
  it('generations/evaluations/nodes 计数准确', async () => {
    // 根 S → A,B（2 子）；A → A1（1 子）；B → B1,B2（2 子）。depth=2,width=8（不剪）
    const childMap = {
      S: [{ content: 'A' }, { content: 'B' }],
      A: [{ content: 'A1' }],
      B: [{ content: 'B1' }, { content: 'B2' }],
    };
    const rs = createReasoningSearch({
      generate: (n) => childMap[n.content] || [],
      evaluate: () => 1,
      makeId: makeSeqId(),
    });
    const r = await rs.search({ root: 'S', width: 8, depth: 2, strategy: 'beam' });
    // generate 调用：S(1) + 第二层 A,B(2) = 3
    expect(r.stats.generations).toBe(3);
    // evaluate 调用：根(1) + A,B(2) + A1,B1,B2(3) = 6；nodes 同 = 6
    expect(r.stats.evaluations).toBe(6);
    expect(r.stats.nodes).toBe(6);
  });
});

describe('estimateTopicComplexity（难题细分启发：避免简单深思也 N×chat）', () => {
  it('含难题词 → 复杂（触发多候选搜索）', () => {
    expect(estimateTopicComplexity('到底该不该重构').complex).toBe(true);
    expect(estimateTopicComplexity('如何权衡利弊').complex).toBe(true);
  });
  it('简单短 topic → 不复杂（走单次）', () => {
    expect(estimateTopicComplexity('随便想想').complex).toBe(false);
    expect(estimateTopicComplexity('').complex).toBe(false);
  });
  it('长 topic（≥24字）或富 context → 复杂', () => {
    expect(estimateTopicComplexity('这是一个不含任何难题关键词但是足够长的内心念头描述文本片段').complex).toBe(true);
    expect(estimateTopicComplexity('短题', 'x'.repeat(100)).complex).toBe(true);
  });
});
