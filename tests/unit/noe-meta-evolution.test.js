import { describe, it, expect } from 'vitest';
import { createMetaEvolution } from '../../src/loop/NoeMetaEvolution.js';

// P5 元进化（自调进化策略）：Neo 基于 P0/P4 数据反思自己的进化「策略」，产出策略建议。
//   关键硬约束：advisory-only —— P5 只产「给 owner 的文字建议」，绝不自动改任何 flag/配置/安全机制。
//   安全机制（NoePolicyFileGuard / P3 双绿门 / standing grant）永远在 Neo 控制之外：P5 模块接口里根本没有
//   任何 mutate flag/gate/config 的能力（物理隔离），只有 read（outcomeStats/flagSnapshot）+ writeAdvisory（写建议）。
//   flag NOE_META_EVOLUTION 默认 OFF。纯 DI + fail-open。

const mkStats = (total, docOnly, neutral, logicChanged, logicAttempted = logicChanged) => ({ total, docOnly, neutral, logicChanged, logicAttempted });

const withFlag = (fn) => {
  const old = process.env.NOE_META_EVOLUTION;
  process.env.NOE_META_EVOLUTION = '1';
  try { return fn(); } finally {
    if (old === undefined) delete process.env.NOE_META_EVOLUTION; else process.env.NOE_META_EVOLUTION = old;
  }
};

function mkDeps(stats, flags, opts = {}) {
  const advisories = [];
  return {
    advisories,
    deps: {
      outcomeStats: opts.statsThrows ? () => { throw new Error('x'); } : () => stats,
      flagSnapshot: () => flags,
      writeAdvisory: opts.writeThrows ? () => { throw new Error('x'); } : (a) => { advisories.push(a); return { ok: true }; },
      minSample: opts.minSample || 3,
    },
  };
}

describe('NoeMetaEvolution', () => {
  it('flag OFF → skipped:flag_off', () => {
    const { deps } = mkDeps(mkStats(10, 5, 2, 3), { logicEnabled: false });
    expect(createMetaEvolution(deps).runOnce().skipped).toBe('flag_off');
  });

  it('样本不足(total<minSample) → insufficient_sample', () => withFlag(() => {
    const { deps } = mkDeps(mkStats(2, 1, 1, 0), { logicEnabled: false }, { minSample: 3 });
    expect(createMetaEvolution(deps).runOnce().reason).toBe('insufficient_sample');
  }));

  it('全浅层 + logic 未开 → warn 建议「开启 NOE_EVOLUTION_LOGIC」(给 owner)', () => withFlag(() => {
    const h = mkDeps(mkStats(5, 4, 1, 0), { logicEnabled: false });
    const r = createMetaEvolution(h.deps).runOnce();
    expect(r.ok).toBe(true);
    expect(h.advisories.length).toBe(1);
    expect(h.advisories[0].severity).toBe('warn');
    expect(h.advisories[0].recommendation).toContain('NOE_EVOLUTION_LOGIC');
  }));

  it('全浅层 + logic 已开 → 建议检查信号源(不再重复建议开 flag)', () => withFlag(() => {
    const h = mkDeps(mkStats(5, 4, 1, 0), { logicEnabled: true });
    const r = createMetaEvolution(h.deps).runOnce();
    expect(r.ok).toBe(true);
    expect(h.advisories[0].recommendation).not.toContain('开启 NOE_EVOLUTION_LOGIC');
    expect(h.advisories[0].recommendation).toMatch(/信号源|供给|high_complexity/);
  }));

  it('有真保留的 logic_changed → info 建议「进化健康」', () => withFlag(() => {
    const h = mkDeps(mkStats(10, 3, 2, 5), { logicEnabled: true });
    const r = createMetaEvolution(h.deps).runOnce();
    expect(r.ok).toBe(true);
    expect(h.advisories[0].severity).toBe('info');
  }));

  it('全 test_only(自主补测试) → healthy,认可加能力产出(非"待观察空转")', () => withFlag(() => {
    const h = mkDeps({ total: 5, docOnly: 0, neutral: 0, logicChanged: 0, logicAttempted: 0, testOnly: 5 }, { logicEnabled: true });
    const r = createMetaEvolution(h.deps).runOnce();
    expect(r.ok).toBe(true);
    expect(h.advisories[0].tags).toContain('healthy');
    expect(h.advisories[0].severity).toBe('info');
    expect(h.advisories[0].body).toContain('补测试'); // 认可补测试,不落入"进化产出待观察"
  }));

  it('改逻辑全失败(logicAttempted>0 但 logicChanged=0) → warn,不误判"健康"也不误判"浅层"(根因修复核心)', () => withFlag(() => {
    const h = mkDeps(mkStats(5, 1, 0, 0, 4), { logicEnabled: true }); // 4 次尝试改逻辑全回滚,0 保留
    const r = createMetaEvolution(h.deps).runOnce();
    expect(r.ok).toBe(true);
    expect(h.advisories[0].severity).toBe('warn');
    expect(h.advisories[0].title).not.toContain('健康');
    expect(h.advisories[0].recommendation).toMatch(/失败|回滚|能力|难度|粒度/);
  }));

  it('硬隔离：advisory 是纯文字建议（无可执行 action/exec 字段，P5 物理无 mutate 能力）', () => withFlag(() => {
    const h = mkDeps(mkStats(5, 5, 0, 0), { logicEnabled: false });
    createMetaEvolution(h.deps).runOnce();
    const a = h.advisories[0];
    // advisory 只有描述性字段 + recommendation 文字，绝无自动执行的 action/exec/apply/setFlag 字段
    expect(typeof a.recommendation).toBe('string');
    expect(a.action).toBeUndefined();
    expect(a.exec).toBeUndefined();
    expect(a.apply).toBeUndefined();
    expect(a.setFlag).toBeUndefined();
    // 模块依赖签名里也不存在任何 mutate 能力（只接受 outcomeStats/flagSnapshot/writeAdvisory）
    expect(Object.keys(h.deps).sort()).toEqual(['flagSnapshot', 'minSample', 'outcomeStats', 'writeAdvisory']);
  }));

  it('writeAdvisory 抛错 → fail-open（不崩，标记 write_failed）', () => withFlag(() => {
    const { deps } = mkDeps(mkStats(5, 5, 0, 0), { logicEnabled: false }, { writeThrows: true });
    const r = createMetaEvolution(deps).runOnce();
    expect(r.ok).toBe(true);
    expect(r.written).toBe(false);
  }));

  it('outcomeStats 抛错 → stats_failed 不崩', () => withFlag(() => {
    const { deps } = mkDeps(null, { logicEnabled: false }, { statsThrows: true });
    expect(createMetaEvolution(deps).runOnce().reason).toBe('stats_failed');
  }));
});

describe('G6: 高回滚率报警（即使有真保留也不盲目判健康）', () => {
  const mkStats2 = (o) => ({ total: 0, docOnly: 0, neutral: 0, logicChanged: 0, logicAttempted: 0, testOnly: 0, rolledBack: 0, ...o });

  it('有真保留但总回滚率>60% → warn「回滚率过高」', () => withFlag(() => {
    const { deps, advisories } = mkDeps(mkStats2({ total: 100, logicChanged: 20, logicAttempted: 80, testOnly: 5, rolledBack: 75, neutral: 10 }), { logicEnabled: true });
    createMetaEvolution(deps).runOnce();
    expect(advisories).toHaveLength(1);
    expect(advisories[0].title).toContain('回滚率');
    expect(advisories[0].severity).toBe('warn');
    expect(advisories[0].tags).toContain('high_rollback');
  }));

  it('真保留 + 低回滚率(<60%) → 仍判健康(零回归)', () => withFlag(() => {
    const { deps, advisories } = mkDeps(mkStats2({ total: 100, logicChanged: 55, logicAttempted: 60, testOnly: 10, rolledBack: 35, neutral: 5 }), { logicEnabled: true });
    createMetaEvolution(deps).runOnce();
    expect(advisories[0].title).toContain('健康');
  }));

  it('rolledBack 缺失(旧数据源) → 回退现状不误报(向后兼容)', () => withFlag(() => {
    const { deps, advisories } = mkDeps({ total: 10, docOnly: 0, neutral: 0, logicChanged: 5, logicAttempted: 5, testOnly: 0 }, { logicEnabled: true });
    createMetaEvolution(deps).runOnce();
    expect(advisories[0].title).toContain('健康');
  }));
});
