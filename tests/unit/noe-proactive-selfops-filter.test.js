// @ts-check
// #16 子改动2：proactive innerBrief 选「刚完成可回报」goal 的纯函数单测——
//   过滤 system_repair/self_learning（Neo 内部自动循环完成，不当陪伴素材自我表扬），保留 owner/真陪伴源。
import { describe, expect, it } from 'vitest';
import { selectFreshReportableGoal } from '../../src/loop/NoeProactiveSelfopsFilter.js';

const nowMs = 1000 * 86400_000;
const now = () => nowMs;
const g = (id, source, { ageMs = 3600_000 } = {}) => ({ id, source, title: `goal ${id}`, updated_at: nowMs - ageMs });

describe('selectFreshReportableGoal', () => {
  it('owner 完成目标 → 选中（主人交办该回报）', () => {
    expect(selectFreshReportableGoal([g('a', 'owner')], { now })?.id).toBe('a');
  });
  it('filterSelfops ON：self_learning / system_repair / self_evolution 完成 → 跳过（不自我表扬刷量；self_evolution 多模型审 P2-1）', () => {
    expect(selectFreshReportableGoal([g('a', 'self_learning')], { now, filterSelfops: true })).toBeNull();
    expect(selectFreshReportableGoal([g('a', 'system_repair')], { now, filterSelfops: true })).toBeNull();
    expect(selectFreshReportableGoal([g('a', 'self_evolution')], { now, filterSelfops: true })).toBeNull();
  });
  it('filterSelfops ON：selfops 混 owner → 跳过 selfops 选 owner', () => {
    expect(selectFreshReportableGoal([g('a', 'self_learning'), g('b', 'owner')], { now, filterSelfops: true })?.id).toBe('b');
  });
  it('反向 filterSelfops OFF（默认）：self_learning 仍选中（逐字零回归）', () => {
    expect(selectFreshReportableGoal([g('a', 'self_learning')], { now })?.id).toBe('a');
  });
  it('已报告过(lastReportedId) → 跳过', () => {
    expect(selectFreshReportableGoal([g('a', 'owner')], { now, lastReportedId: 'a' })).toBeNull();
  });
  it('超 24h → 跳过', () => {
    expect(selectFreshReportableGoal([g('a', 'owner', { ageMs: 25 * 3600_000 })], { now })).toBeNull();
  });
  it('空 / null → null', () => {
    expect(selectFreshReportableGoal([], { now })).toBeNull();
    expect(selectFreshReportableGoal(null, { now })).toBeNull();
  });
  it('filterSelfops ON：非 selfops 自生源(surprise) 仍选中（只滤 selfops，不误伤真陪伴/探索）', () => {
    expect(selectFreshReportableGoal([g('a', 'surprise')], { now, filterSelfops: true })?.id).toBe('a');
  });
  it('多模型审P1-2：前 N 个全 selfops + 后面 owner → 跳过 selfops 选 owner（不被前面 selfops 占满漏掉，配合 noe.js limit:50）', () => {
    const goals = [g('a', 'system_repair'), g('b', 'self_learning'), g('c', 'system_repair'), g('d', 'self_evolution'), g('e', 'system_repair'), g('f', 'owner')];
    expect(selectFreshReportableGoal(goals, { now, filterSelfops: true })?.id).toBe('f');
  });
});
