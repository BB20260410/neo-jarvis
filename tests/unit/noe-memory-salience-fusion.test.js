// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { salienceBoostFactor } from '../../src/memory/NoeFusionRanker.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

// NOE_MEMORY_SALIENCE_FUSION 接线测试（修审查缺陷：身份级 salience=5 记忆在 RRF 融合排序不靠前）。
//
// 用注入式 stub semanticIndex 精确控制【向量路】命中（仿 noe-memory-recall-fused-fisher 的 stub 模式），
// 配合真 SQLite + 真 salience 落库，做确定性断言（不触网、不依赖真实时钟、不开 DYNAMIC_DECAY 故时间激活恒等 1）。
//
// 三类覆盖：
//   ① ON 正向：同相关度（两路名次一致）下，高 salience 相关记忆排序提升到低 salience 之前；
//   ② ON 边界【codex 硬约束】：身份级 salience=5 但与 query 不相关（仅单路命中、名次靠后）时，
//      不该排到「双路都命中且靠前」的相关结果之前 —— 证明 salience 只软加权、不压过相关性；
//   ③ OFF 零回归：不开关时排序与纯 RRF 逐字一致。

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-salience-fusion-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

// 向量路 stub：按给定 [{refId, score}] 顺序返回（控制向量名次）；不带 searchVectors（不触发 Fisher 路）。
function makeVecStub(hits) {
  return {
    provider: 'stub',
    calls: { search: 0 },
    async search() {
      this.calls.search += 1;
      return hits;
    },
  };
}

describe('salienceBoostFactor（1.0-1.4 温和软加成，单一真源）', () => {
  it('映射边界：缺省/<=0 → 1.0，5 → 1.4，3 → 1.24，越界 clamp', () => {
    expect(salienceBoostFactor(0)).toBeCloseTo(1.0);
    expect(salienceBoostFactor(undefined)).toBeCloseTo(1.0);
    expect(salienceBoostFactor(NaN)).toBeCloseTo(1.0);
    expect(salienceBoostFactor(3)).toBeCloseTo(1.24);
    expect(salienceBoostFactor(5)).toBeCloseTo(1.4);
    expect(salienceBoostFactor(99)).toBeCloseTo(1.4); // clamp 到 5
    expect(salienceBoostFactor(-5)).toBeCloseTo(1.0); // clamp 到 0
  });
});

describe('MemoryCore.recallFused × NOE_MEMORY_SALIENCE_FUSION', () => {
  it('ON 正向：同相关度下，高 salience 相关记忆排序提升到低 salience 之前', async () => {
    // hi / lo 两条同主题（FTS 都命中 query），向量路名次也并列同前后；唯一差异是 salience。
    // 向量路 stub 让两者向量名次 [hi, lo]（与 FTS 一致），纯 RRF 下二者基分接近、salience 不参与时
    // 顺序由 RRF 平手 + 稳定排序定；开 salience 后 hi(=5,×1.4) 必排到 lo(=1,×1.0) 之前。
    const stub = makeVecStub([{ refId: 'hi', score: 0.9 }, { refId: 'lo', score: 0.89 }]);
    const core = new MemoryCore({ logger: null, semanticIndex: stub, salienceFusion: { enabled: true } });
    core.write({ id: 'lo', body: '量子计算入门资料整理与公式推导', salience: 1 });
    core.write({ id: 'hi', body: '量子计算入门资料整理与公式推导', salience: 5 });
    const ids = (await core.recallFused({ q: '量子计算入门资料整理与公式推导', bumpHits: false })).map((m) => m.id);
    expect(ids).toContain('hi');
    expect(ids).toContain('lo');
    expect(ids.indexOf('hi')).toBeLessThan(ids.indexOf('lo')); // 高 salience 相关记忆提升
  });

  it('ON 边界【codex 硬约束】：不相关的身份级 salience=5 记忆不压过双路命中的相关结果', async () => {
    // rel：与 query 高度相关 —— FTS 命中 + 向量路 rank0（双路靠前）。salience 默认 3。
    // ident：身份级 salience=5 但内容与 query 完全无关 —— FTS 不命中，仅向量路命中且名次靠后(rank1)。
    // 纯 RRF：rel≈1/61+1/61=0.0328，ident≈1/62=0.0161。开 salience 后 ident×1.4=0.0226 仍 < rel×1.24=0.0407。
    // 断言 rel 仍排在 ident 之前 —— 证明 salience 只软加权，绝不让不相关高 salience 压过明显更相关结果。
    const stub = makeVecStub([{ refId: 'rel', score: 0.95 }, { refId: 'ident', score: 0.5 }]);
    const core = new MemoryCore({ logger: null, semanticIndex: stub, salienceFusion: { enabled: true } });
    core.write({ id: 'rel', body: '深海热液喷口生态系统考察报告与样本分析', salience: 3 });
    core.write({ id: 'ident', body: '我的名字叫主人这是身份核心记忆务必牢记', salience: 5 });
    const ids = (await core.recallFused({ q: '深海热液喷口生态系统考察报告与样本分析', bumpHits: false })).map((m) => m.id);
    expect(ids[0]).toBe('rel'); // 相关结果稳居第一
    expect(ids.indexOf('rel')).toBeLessThan(ids.indexOf('ident')); // 不相关高 salience 不反超
  });

  it('ON 边界续：身份级 salience=5 若【确实相关】（双路命中），允许其凭软加成靠前（区别于上一用例的不相关）', async () => {
    // 与上一用例对照组：ident 这次内容与 query 相关（FTS+向量都命中靠前），证明软加权在「相关」时才发力，
    // 不是无条件抬 salience，也不是无条件压制 —— 边界两侧都对。
    const stub = makeVecStub([{ refId: 'ident', score: 0.95 }, { refId: 'plain', score: 0.9 }]);
    const core = new MemoryCore({ logger: null, semanticIndex: stub, salienceFusion: { enabled: true } });
    core.write({ id: 'plain', body: '极地冰川消融监测数据年度汇总表', salience: 2 });
    core.write({ id: 'ident', body: '极地冰川消融监测数据年度汇总表', salience: 5 });
    const ids = (await core.recallFused({ q: '极地冰川消融监测数据年度汇总表', bumpHits: false })).map((m) => m.id);
    expect(ids.indexOf('ident')).toBeLessThan(ids.indexOf('plain'));
  });

  it('OFF（默认不开关）：salience 不参与排序，结果与纯 RRF 逐字一致（零回归）', async () => {
    // 同一组数据：仅 salience 不同。OFF 时高 salience 的 hi 不应因 salience 被提升 —— 顺序与「关掉 salience 的同核心」一致。
    const seed = (core) => {
      core.write({ id: 'lo', body: '量子计算入门资料整理与公式推导', salience: 1 });
      core.write({ id: 'hi', body: '量子计算入门资料整理与公式推导', salience: 5 });
    };
    const offCore = new MemoryCore({ logger: null, semanticIndex: makeVecStub([{ refId: 'lo', score: 0.9 }, { refId: 'hi', score: 0.89 }]) }); // 默认 OFF
    seed(offCore);
    const offIds = (await offCore.recallFused({ q: '量子计算入门资料整理与公式推导', bumpHits: false })).map((m) => m.id);
    // 纯 RRF 下向量路把 lo 放前面（hi salience 高但 OFF 不参与）→ lo 不应被 hi 反超
    expect(offIds.indexOf('lo')).toBeLessThan(offIds.indexOf('hi'));
  });

  it('OFF：salienceFusion 关 → 与不带 salience 逻辑的基准排序完全相同（同一向量名次驱动）', async () => {
    // 直接对照：OFF core vs 一个「永远不开 salience」的 core，喂相同 stub 名次与相同数据，ids 必须完全相等。
    const mkStub = () => makeVecStub([{ refId: 'b', score: 0.9 }, { refId: 'a', score: 0.8 }]);
    const seed = (core) => {
      core.write({ id: 'a', body: 'alpha 记忆甲 内容互不相同 zzz', salience: 5 }); // a 高 salience
      core.write({ id: 'b', body: 'beta 记忆乙 内容互不相同 yyy', salience: 1 });
    };
    const c1 = new MemoryCore({ logger: null, semanticIndex: mkStub() }); // OFF
    seed(c1);
    const ids1 = (await c1.recallFused({ q: '无关查询触发向量路 qqq', bumpHits: false })).map((m) => m.id);
    // 向量名次 [b, a]，FTS 都不命中 query → 纯 RRF 顺序 [b, a]；a 虽 salience=5 但 OFF 不被提升
    expect(ids1).toEqual(['b', 'a']);
  });

  it('env NOE_MEMORY_SALIENCE_FUSION=1 与注入 enabled 等价', async () => {
    const prev = process.env.NOE_MEMORY_SALIENCE_FUSION;
    process.env.NOE_MEMORY_SALIENCE_FUSION = '1';
    try {
      const stub = makeVecStub([{ refId: 'lo', score: 0.9 }, { refId: 'hi', score: 0.89 }]);
      const core = new MemoryCore({ logger: null, semanticIndex: stub }); // 不注入 enabled，靠 env
      core.write({ id: 'lo', body: '量子计算入门资料整理与公式推导', salience: 1 });
      core.write({ id: 'hi', body: '量子计算入门资料整理与公式推导', salience: 5 });
      const ids = (await core.recallFused({ q: '量子计算入门资料整理与公式推导', bumpHits: false })).map((m) => m.id);
      expect(ids.indexOf('hi')).toBeLessThan(ids.indexOf('lo')); // env 开启同样生效
    } finally {
      if (prev === undefined) delete process.env.NOE_MEMORY_SALIENCE_FUSION;
      else process.env.NOE_MEMORY_SALIENCE_FUSION = prev;
    }
  });

  it('semanticIndex 未注入时 recallFused 与 recall 一致（salience 开关不影响纯 FTS 单路路径）', async () => {
    const prev = process.env.NOE_MEMORY_SALIENCE_FUSION;
    process.env.NOE_MEMORY_SALIENCE_FUSION = '1';
    try {
      const plain = new MemoryCore({ logger: null }); // 无 semanticIndex → recallFused 短路回 recall
      plain.write({ id: 'a', body: '今天去了紫禁城参观故宫博物院', salience: 5 });
      plain.write({ id: 'b', body: '紫禁城角楼的雪景照片', salience: 1 });
      const fused = (await plain.recallFused({ q: '紫禁城', bumpHits: false })).map((m) => m.id);
      const direct = plain.recall({ q: '紫禁城', bumpHits: false }).map((m) => m.id);
      expect(fused).toEqual(direct); // 无向量路时 salience 融合无从介入，与 recall 逐字一致
    } finally {
      if (prev === undefined) delete process.env.NOE_MEMORY_SALIENCE_FUSION;
      else process.env.NOE_MEMORY_SALIENCE_FUSION = prev;
    }
  });
});
