// @ts-check
// #16 子改动1：skill 蒸馏主题去重纯函数单测。
// 多模型审 P1 修复：蒸馏卡默认 enabled:false（NoeSkillDistiller 红队防注入），仍占技能库分母——去重锚不依赖 enabled。
// P2-3 修复：用 extra.source==='goal_distillation' 识别蒸馏卡（list 返回），name 前缀作兜底；不误伤手工卡。
import { describe, expect, it } from 'vitest';
import { shouldSkipDistillByTopic } from '../../src/cognition/NoeSkillDedup.js';

const DAY = 86400_000;
const nowMs = 1000 * DAY;
const now = () => nowMs;
// 蒸馏卡默认 enabled:false + source:'goal_distillation'（对齐 NoeSkillDistiller 真实产物）。
function card(displayName, { name = 'noe-learned-x', enabled = false, daysAgo = 1, source = 'goal_distillation' } = {}) {
  return { name, displayName, enabled, source, updatedAt: new Date(nowMs - daysAgo * DAY).toISOString() };
}

describe('shouldSkipDistillByTopic', () => {
  it('P1：近30天同主题蒸馏卡(默认 disabled) → skip（disabled 卡也占分母，仍是去重锚）', () => {
    const r = shouldSkipDistillByTopic('修复 NoeMissionRunner 前缀越界', [card('修复 NoeMissionRunner 前缀越界并做回归测试')], { now });
    expect(r.skip).toBe(true);
    expect(r.score).toBeGreaterThanOrEqual(0.85);
  });
  it('P2-3：source=goal_distillation 识别（即便 name 无 noe-learned- 前缀，如导入卡）→ skip', () => {
    expect(shouldSkipDistillByTopic('修复前缀越界并做回归测试', [card('修复前缀越界并做回归测试', { name: 'imported-card', source: 'goal_distillation' })], { now }).skip).toBe(true);
  });
  it('name 前缀兜底：source 缺失但 name=noe-learned-（同进程未刷新 source）→ 仍识别为蒸馏卡 skip', () => {
    expect(shouldSkipDistillByTopic('修复前缀越界并做回归测试', [card('修复前缀越界并做回归测试', { source: undefined })], { now }).skip).toBe(true);
  });
  it('不同主题 → 不 skip（正常蒸馏新技能）', () => {
    expect(shouldSkipDistillByTopic('优化数据库连接池配置参数', [card('修复登录页崩溃问题处理')], { now }).skip).toBe(false);
  });
  it('反向：非蒸馏卡(source 非 goal_distillation + name 无前缀，如手工卡) → 不 skip（不误伤人工卡）', () => {
    expect(shouldSkipDistillByTopic('修复前缀越界并做回归测试', [card('修复前缀越界并做回归测试', { name: 'manual-card', source: 'manual' })], { now }).skip).toBe(false);
  });
  it('P2边界(重审)：显式非蒸馏 source(manual) + name 带 noe-learned- 前缀 → 不 skip（source 严格优先于前缀，不误判手工卡）', () => {
    expect(shouldSkipDistillByTopic('修复前缀越界并做回归测试', [card('修复前缀越界并做回归测试', { name: 'noe-learned-manual', source: 'manual' })], { now }).skip).toBe(false);
  });
  it('反向：同主题蒸馏卡但超30天 → 不 skip（旧卡不算活去重锚）', () => {
    expect(shouldSkipDistillByTopic('修复前缀越界并做回归测试', [card('修复前缀越界并做回归测试', { daysAgo: 40 })], { now }).skip).toBe(false);
  });
  it('反向：空 / 空 title → 不 skip', () => {
    expect(shouldSkipDistillByTopic('修复前缀越界并做回归测试', [], { now }).skip).toBe(false);
    expect(shouldSkipDistillByTopic('', [card('修复前缀越界并做回归测试')], { now }).skip).toBe(false);
  });
  it('边界：title 过短(<minChars) → 不 skip（防短词高 dice 误判）', () => {
    expect(shouldSkipDistillByTopic('改', [card('改')], { now }).skip).toBe(false);
  });
  it('多卡：命中近30天同主题蒸馏卡中任一即 skip，返回最佳匹配', () => {
    const r = shouldSkipDistillByTopic('优化并发调度算法实现', [
      card('修复登录崩溃问题处理', { name: 'noe-learned-a' }),
      card('优化并发调度算法实现细节', { name: 'noe-learned-b' }),
    ], { now });
    expect(r.skip).toBe(true);
    expect(r.matchedCard.name).toBe('noe-learned-b');
  });
});
