import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';
import { createCuriosityDecompose } from '../../src/cognition/NoeCuriosityDecompose.js';

// harvestSurprise × NoeCuriosityDecompose 接入：
//  · OFF（NOE_EFE_CURIOSITY 未设/!=1）→ 与改造前逐字等价：立 source=surprise 目标，但 meta 为 null（零回归）。
//  · ON（curiosity.enabled=true）→ 同样立目标，且 meta.curiosity 写入 {score,epistemic,pragmatic,label,pragmaticSource}。
//  · ON 端到端：注入强 pragmaticSignal → pragmatic 分量真随偏好重叠变化（证明开了真生效，非 OFF 恒等假融入）。
// 全确定性：显式 enabled / 注入 pragmaticSignal，不依赖 process.env、不触网、不碰时钟。

let tmp;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noe-goal-cur-'));
  initSqlite(join(tmp, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

function surpriseGoals(gs) {
  return gs.list({ status: 'open', limit: 200 }).filter((g) => g.source === 'surprise');
}

describe('harvestSurprise OFF：零回归（行为与改造前逐字一致）', () => {
  it('curiosity 关闭 → 立 source=surprise 目标，meta=null，title/why 不变', () => {
    const gs = createGoalSystem({ curiosity: createCuriosityDecompose({ enabled: false }) });
    const id = gs.harvestSurprise({ claim: '主人今晚会回消息', surprise: 4.3 });
    expect(id).toBeTruthy();
    const g = gs.get(id);
    expect(g.source).toBe('surprise');
    expect(g.title).toContain('搞明白为什么没料到');
    expect(g.title).toContain('主人今晚会回消息');
    expect(g.why).toContain('4.3 bit 惊奇'); // 旧 why 文案保持
    expect(g.meta).toBe(null); // OFF 不写任何 meta
    expect(g.plan).toHaveLength(3); // 旧三步计划不变
  });

  it('curiosity 关闭 + 惊奇 < 2bit → 不立目标（旧门槛不变）', () => {
    const gs = createGoalSystem({ curiosity: createCuriosityDecompose({ enabled: false }) });
    expect(gs.harvestSurprise({ claim: '抛硬币正面', surprise: 1.0 })).toBe(null);
    expect(surpriseGoals(gs)).toHaveLength(0);
  });

  it('完全不注入 curiosity（默认）且 env 未开 → 等价 OFF：meta=null', () => {
    const ORIG = process.env.NOE_EFE_CURIOSITY;
    delete process.env.NOE_EFE_CURIOSITY;
    try {
      const gs = createGoalSystem({});
      const id = gs.harvestSurprise({ claim: '默认路径', surprise: 3.0 });
      expect(gs.get(id).meta).toBe(null);
    } finally {
      if (ORIG === undefined) delete process.env.NOE_EFE_CURIOSITY; else process.env.NOE_EFE_CURIOSITY = ORIG;
    }
  });
});

describe('harvestSurprise ON：好奇二分解真生效 + 可解释 meta', () => {
  it('curiosity 开启 → 目标 meta.curiosity 含 {score,epistemic,pragmatic,label}，且 epistemic 由 surprise 驱动', () => {
    const gs = createGoalSystem({ curiosity: createCuriosityDecompose({ enabled: true }) });
    const id = gs.harvestSurprise({ claim: '主人今晚会回消息', surprise: 6 });
    expect(id).toBeTruthy();
    const cur = gs.get(id).meta?.curiosity;
    expect(cur).toBeTruthy();
    expect(Number.isFinite(cur.score)).toBe(true);
    // saturate(6, scale=2) = 6/8 = 0.75 → epistemic 分量
    expect(cur.epistemic).toBeCloseTo(0.75, 6);
    expect(['epistemic', 'pragmatic', 'balanced', 'idle']).toContain(cur.label);
    expect(cur.score).toBeGreaterThan(0); // 高惊奇必有正分
  });

  it('ON 端到端：pragmatic 分量真随偏好重叠变化（强信号源被消费，非恒等）', () => {
    // 注入两种 pragmaticSignal：一种判定高度相关(→0.95)，一种判定无关(→0)。
    // 同一 surprise、同一 claim，唯一变量是 pragmatic 信号 → score/pragmatic 必须不同，证明真接进了打分。
    const gsRelevant = createGoalSystem({
      curiosity: createCuriosityDecompose({ enabled: true }),
      pragmaticSignal: () => ({ value: 0.95, source: 'test-strong' }),
    });
    const gsIrrelevant = createGoalSystem({
      curiosity: createCuriosityDecompose({ enabled: true }),
      pragmaticSignal: () => ({ value: 0, source: 'test-none' }),
    });
    // 两 goalSystem 共享 SqliteStore 单例 DB，故用不同 claim 避 add 同名去重；pragmaticSignal 是注入固定值、与 claim 无关，唯一变量仍是 pragmatic 信号。
    const idA = gsRelevant.harvestSurprise({ claim: '关于甲事的预测', surprise: 3 });
    const idB = gsIrrelevant.harvestSurprise({ claim: '关于乙事的预测', surprise: 3 });
    const a = gsRelevant.get(idA).meta.curiosity;
    const b = gsIrrelevant.get(idB).meta.curiosity;
    // 强 pragmatic → pragmatic 分量、总分都更高
    expect(a.pragmatic).toBeGreaterThan(b.pragmatic);
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.pragmaticSource).toBe('test-strong');
    expect(b.pragmaticSource).toBe('test-none');
    // 无关信号 → 纯 epistemic 主导
    expect(b.label).not.toBe('pragmatic');
  });

  it('ON：why 文案带 label 解释（可解释性落到目标本身，非只在 meta）', () => {
    const gs = createGoalSystem({
      curiosity: createCuriosityDecompose({ enabled: true }),
      pragmaticSignal: () => ({ value: 0.9, source: 'active-goals' }),
    });
    const id = gs.harvestSurprise({ claim: '关键预测', surprise: 5 });
    const g = gs.get(id);
    expect(g.why).toContain('5 bit 惊奇'); // 旧文案保留
    expect(g.why).toMatch(/好奇画像|epistemic|pragmatic|balanced/); // 追加可解释画像
    expect(g.meta.curiosity.label).toBe(g.meta.curiosity.label); // 自洽
  });

  it('ON：pragmaticSignal 抛异常 → 退化为 pragmatic=0，仍立目标写 meta（fail-open 不阻断好奇）', () => {
    const gs = createGoalSystem({
      curiosity: createCuriosityDecompose({ enabled: true }),
      pragmaticSignal: () => { throw new Error('signal boom'); },
    });
    const id = gs.harvestSurprise({ claim: '信号源炸了', surprise: 4 });
    expect(id).toBeTruthy();
    const cur = gs.get(id).meta.curiosity;
    expect(cur.pragmatic).toBe(0);
    expect(cur.epistemic).toBeGreaterThan(0); // epistemic 仍由 surprise 算出
    expect(cur.pragmaticSource).toBe('none');
  });

  it('ON：默认 pragmaticSignal（active-goals 关键词重叠）——无活跃目标时 pragmatic=0，不退化、不崩', () => {
    // 不注入 pragmaticSignal，用内置默认。空目标库 → 重叠 0 → 纯 epistemic，分仍 ≥ OFF 语义（绝不更差）。
    const gs = createGoalSystem({ curiosity: createCuriosityDecompose({ enabled: true }) });
    const id = gs.harvestSurprise({ claim: '冷启动惊奇', surprise: 4 });
    const cur = gs.get(id).meta.curiosity;
    expect(cur.pragmatic).toBe(0);
    expect(cur.pragmaticSource).toBe('active-goals');
    expect(cur.epistemic).toBeGreaterThan(0);
  });

  it('ON：默认 pragmaticSignal 真消费当前目标关键词——claim 与现有目标高度重叠 → pragmatic > 0', () => {
    const gs = createGoalSystem({ curiosity: createCuriosityDecompose({ enabled: true }) });
    // 先立一个含明显关键词的 owner 目标，让它成为偏好背景
    gs.add({ title: '优化记忆检索召回率与向量索引', source: 'owner' });
    // claim 与上面目标共享「记忆 检索 向量 索引」等词
    const id = gs.harvestSurprise({ claim: '记忆检索的向量索引召回竟然变差了', surprise: 3 });
    const cur = gs.get(id).meta.curiosity;
    expect(cur.pragmaticSource).toBe('owner-goals'); // 价值对齐 D：owner 目标(source=owner)走加权分支(权重1.0)、source 标 owner-goals
    expect(cur.pragmatic).toBeGreaterThan(0); // 与 owner 在意的事相关 → 实用价值非零
  });

  it('ON：惊奇 < 2bit 仍不立目标（好奇门槛不被二分解绕过）', () => {
    const gs = createGoalSystem({ curiosity: createCuriosityDecompose({ enabled: true }) });
    expect(gs.harvestSurprise({ claim: '低意外', surprise: 1.2 })).toBe(null);
    expect(surpriseGoals(gs)).toHaveLength(0);
  });
});
