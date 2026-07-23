import { describe, it, expect } from 'vitest';
import {
  CAPABILITY_BATTERY,
  scorePatchAgainstTask,
  summarizeBatteryRun,
} from '../../src/loop/NoeCapabilityBattery.js';

// 阶段一B 能力题库:held-out 自改任务 + 打分器,量「通过率随难度/随时间」。
// 打分 = 补丁可 apply(from 精确命中或 write_file) 且 to 含预期标记。纯函数可测;runner 用真实 implementer 离线跑。

const CONTENT = 'export function add(a, b) {\n  return a + b;\n}\n';

describe('scorePatchAgainstTask', () => {
  it('replace + from精确命中 + to含预期标记 → pass', () => {
    const task = { id: 't1', tier: 'easy', expectMarker: '@param' };
    const plan = { operations: [{ op: 'replace', from: 'export function add(a, b) {', to: '/**\n * @param {number} a\n */\nexport function add(a, b) {' }] };
    const r = scorePatchAgainstTask(task, plan, CONTENT);
    expect(r.applicable).toBe(true);
    expect(r.markerOk).toBe(true);
    expect(r.pass).toBe(true);
  });

  it('from 编造(文件里不存在) → 不可 apply → fail', () => {
    const task = { id: 't2', tier: 'hard', expectMarker: '@param' };
    const plan = { operations: [{ op: 'replace', from: 'function multiply(x, y) {', to: '/** @param */function multiply(x, y) {' }] };
    const r = scorePatchAgainstTask(task, plan, CONTENT);
    expect(r.applicable).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('可 apply 但 to 缺预期标记 → 只对了一半 → fail', () => {
    const task = { id: 't3', tier: 'easy', expectMarker: '@param' };
    const plan = { operations: [{ op: 'replace', from: 'export function add(a, b) {', to: '// 注释\nexport function add(a, b) {' }] };
    const r = scorePatchAgainstTask(task, plan, CONTENT);
    expect(r.applicable).toBe(true);
    expect(r.markerOk).toBe(false);
    expect(r.pass).toBe(false);
  });

  it('write_file 新建 + content 含标记 → pass(无需 from 命中)', () => {
    const task = { id: 't4', tier: 'test', expectMarker: 'describe(' };
    const plan = { operations: [{ op: 'write_file', path: 'x.test.js', content: "describe('x', () => {})" }] };
    const r = scorePatchAgainstTask(task, plan, CONTENT);
    expect(r.pass).toBe(true);
  });

  it('空 operations / 无 plan → fail(不崩)', () => {
    const task = { id: 't5', expectMarker: 'x' };
    expect(scorePatchAgainstTask(task, { operations: [] }, CONTENT).pass).toBe(false);
    expect(scorePatchAgainstTask(task, null, CONTENT).pass).toBe(false);
  });
});

describe('summarizeBatteryRun', () => {
  it('聚合通过率 + 按 tier 分档(暴露"能做简单不能做难")', () => {
    const s = summarizeBatteryRun([
      { id: 'a', tier: 'easy', pass: true },
      { id: 'b', tier: 'easy', pass: true },
      { id: 'c', tier: 'hard', pass: false },
      { id: 'd', tier: 'hard', pass: false },
    ]);
    expect(s.total).toBe(4);
    expect(s.passed).toBe(2);
    expect(s.passRate).toBeCloseTo(0.5);
    expect(s.byTier.easy.passRate).toBe(1);
    expect(s.byTier.hard.passRate).toBe(0);
  });
});

describe('CAPABILITY_BATTERY', () => {
  it('题库有多档难度、每题带 fixture+objective+预期标记', () => {
    expect(CAPABILITY_BATTERY.length).toBeGreaterThanOrEqual(5);
    const tiers = new Set(CAPABILITY_BATTERY.map((t) => t.tier));
    expect(tiers.size).toBeGreaterThanOrEqual(2); // 至少 2 档难度
    for (const t of CAPABILITY_BATTERY) {
      expect(t.id && t.objective && t.content && t.expectMarker).toBeTruthy();
    }
  });
});

describe('题库纳入 fuzzy(量真实生产能力:模型精度 strict vs 落地率 with-fuzzy)', () => {
  const CONTENT2 = 'export function add(a, b) {\n  return a + b;\n}\n';
  // 模拟本地模型产的 from 有微差(多空格),strict 不命中但 fuzzy 会命中
  const fuzzyMatch = (content, from) => {
    // 简化:去掉多余空格后能对上就算 matched(仿 findFuzzyMatch 行级相似)
    const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
    return norm(content).includes(norm(from)) ? { matched: true, similarity: 0.95 } : { matched: false };
  };

  it('strict 不命中(格式微差)但 fuzzy 命中 → applicable(via fuzzy),strictApplicable=false', () => {
    const task = { id: 'f1', tier: 'easy', expectMarker: '@param' };
    const plan = { operations: [{ op: 'replace', from: 'export  function  add(a, b) {', to: '/** @param */export function add(a, b) {' }] };
    const strict = scorePatchAgainstTask(task, plan, CONTENT2);
    expect(strict.applicable).toBe(false); // strict:格式微差不命中
    const withFuzzy = scorePatchAgainstTask(task, plan, CONTENT2, { fuzzyMatch });
    expect(withFuzzy.applicable).toBe(true);   // 生产落地率:fuzzy 救
    expect(withFuzzy.viaFuzzy).toBe(true);
    expect(withFuzzy.strictApplicable).toBe(false);
    expect(withFuzzy.pass).toBe(true);
  });

  it('summarizeBatteryRun 分别汇总 strict 通过率 vs 含fuzzy通过率', () => {
    const s = summarizeBatteryRun([
      { id: 'a', tier: 'easy', pass: true, strictApplicable: true },
      { id: 'b', tier: 'easy', pass: true, strictApplicable: false, viaFuzzy: true },
    ]);
    expect(s.passRate).toBeCloseTo(1);        // 含fuzzy落地率
    expect(s.strictPassRate).toBeCloseTo(0.5); // 模型精度(不靠fuzzy)
  });
});
