import { describe, it, expect, vi } from 'vitest';
import { distillSkillFromGoal, createNoeSkillDistiller } from '../../src/cognition/NoeSkillDistiller.js';

const multiStepGoal = {
  id: 'goal-42',
  title: '修复 NoeMissionStore 前缀越界并加回归测试',
  plan: [
    { step: '定位 NoeMissionStore.js 的 startsWith 判据', kind: 'act', status: 'done' },
    { step: '改成 file===root||startsWith(root+sep)', kind: 'act', status: 'done' },
    { step: '加回归测试并跑 vitest', kind: 'act', status: 'done' },
    { step: '总结根因', kind: 'think', status: 'done' },
  ],
};

describe('distillSkillFromGoal', () => {
  it('多步 goal → 技能卡（name/description/body 含步骤模板+触发关键词）', () => {
    const card = distillSkillFromGoal(multiStepGoal, { now: () => 1 });
    expect(card).toBeTruthy();
    expect(card.name).toBe('noe-learned-goal-42');
    expect(card.displayName).toBe(multiStepGoal.title);
    expect(card.description).toContain('Neo 蒸馏技能');
    expect(card.body).toContain('## 步骤模板');
    expect(card.body).toContain('NoeMissionStore'); // 关键词进了触发条件/步骤
    expect(card.body).toContain('1. [act]');
    expect(card.extra.source).toBe('goal_distillation');
    expect(card.extra.goalId).toBe('goal-42');
    expect(card.enabled).toBe(false); // 红队修复：默认停用，需显式启用才注入 prompt
  });
  it('实质动作步数 < 2（纯 think / 单步）→ 不蒸馏（null）', () => {
    expect(distillSkillFromGoal({ id: 'g', title: '想清楚第一步', plan: [{ step: '想', kind: 'think' }] })).toBeNull();
    expect(distillSkillFromGoal({ id: 'g', title: 'x', plan: [{ step: '只做一件事', kind: 'act' }] })).toBeNull();
  });
  it('空标题 → null', () => {
    expect(distillSkillFromGoal({ id: 'g', title: '', plan: [] })).toBeNull();
  });
  it('name 由 goalId 派生且 safeName 合规（非法字符归一）', () => {
    const card = distillSkillFromGoal({ ...multiStepGoal, id: 'Goal/4 2:x' }, { now: () => 1 });
    expect(card.name).toMatch(/^noe-learned-[a-z0-9_.-]+$/);
  });
});

describe('createNoeSkillDistiller.observe', () => {
  it('goalDone=false → 不蒸馏', () => {
    const skillUpsert = vi.fn(() => ({ name: 'x' }));
    const d = createNoeSkillDistiller({ skillUpsert });
    expect(d.observe(multiStepGoal, { goalDone: false })).toMatchObject({ created: false, reason: 'goal_not_done' });
    expect(skillUpsert).not.toHaveBeenCalled();
  });
  it('goalDone=true + 多步 → upsert 技能卡，返回 created+skillName', () => {
    const skillUpsert = vi.fn((card) => ({ name: card.name }));
    const d = createNoeSkillDistiller({ skillUpsert });
    const r = d.observe(multiStepGoal, { goalDone: true });
    expect(r).toMatchObject({ ok: true, created: true, skillName: 'noe-learned-goal-42' });
    expect(skillUpsert).toHaveBeenCalledTimes(1);
    expect(skillUpsert.mock.calls[0][0].extra.source).toBe('goal_distillation');
  });
  it('不可蒸馏（单步）→ 不 upsert', () => {
    const skillUpsert = vi.fn();
    const d = createNoeSkillDistiller({ skillUpsert });
    expect(d.observe({ id: 'g', title: 'x', plan: [{ step: 'one', kind: 'act' }] }, { goalDone: true })).toMatchObject({ created: false, reason: 'not_distillable' });
    expect(skillUpsert).not.toHaveBeenCalled();
  });
  it('skillUpsert 未注入 → skill_upsert_unavailable', () => {
    const d = createNoeSkillDistiller({});
    expect(d.observe(multiStepGoal, { goalDone: true })).toMatchObject({ ok: false, reason: 'skill_upsert_unavailable' });
  });
  it('skillUpsert 抛错（如内容扫描拒写）→ distill_failed，不崩', () => {
    const skillUpsert = vi.fn(() => { throw new Error('skill 内容含危险模式被拒'); });
    const d = createNoeSkillDistiller({ skillUpsert });
    expect(d.observe(multiStepGoal, { goalDone: true })).toMatchObject({ ok: false, reason: 'distill_failed' });
  });

  // 红队修复：同 goal 多次 done 回报 → 只蒸馏一次（不重写盘/不计数虚高）。
  it('同 goalId 重复 observe → 第二次 already_distilled，upsert 只调一次', () => {
    const skillUpsert = vi.fn((card) => ({ name: card.name }));
    const d = createNoeSkillDistiller({ skillUpsert });
    expect(d.observe(multiStepGoal, { goalDone: true }).created).toBe(true);
    expect(d.observe(multiStepGoal, { goalDone: true })).toMatchObject({ created: false, reason: 'already_distilled' });
    expect(d.observe(multiStepGoal, { goalDone: true })).toMatchObject({ created: false, reason: 'already_distilled' });
    expect(skillUpsert).toHaveBeenCalledTimes(1);
  });

  it('upsert 失败后同 goal 可重试（失败不记入已蒸馏）', () => {
    let n = 0;
    const skillUpsert = vi.fn(() => { n += 1; if (n === 1) throw new Error('transient'); return { name: 'noe-learned-goal-42' }; });
    const d = createNoeSkillDistiller({ skillUpsert });
    expect(d.observe(multiStepGoal, { goalDone: true }).ok).toBe(false); // 第一次失败
    expect(d.observe(multiStepGoal, { goalDone: true }).created).toBe(true); // 重试成功
    expect(skillUpsert).toHaveBeenCalledTimes(2);
  });

  // #16 子改动1：主题去重前移（flag NOE_SKILL_DEDUP_PREGATE + listSkills 注入）——不同 goalId 同主题不重复蒸馏。
  it('dedupPregate ON + listSkills 有近30天同主题 alive 蒸馏卡 → 跳过蒸馏(already_distilled_topic)，不 upsert', () => {
    const skillUpsert = vi.fn((card) => ({ name: card.name }));
    const listSkills = () => [{ name: 'noe-learned-old', displayName: '修复 NoeMissionStore 前缀越界并做回归测试', enabled: true, updatedAt: new Date(Date.now() - 86400_000).toISOString() }];
    const d = createNoeSkillDistiller({ skillUpsert, dedupPregate: true, listSkills });
    const r = d.observe(multiStepGoal, { goalDone: true });
    expect(r).toMatchObject({ created: false, reason: 'already_distilled_topic' });
    expect(skillUpsert).not.toHaveBeenCalled();
  });
  it('反向：dedupPregate OFF（默认）+ 同主题卡 → 正常蒸馏（零回归）', () => {
    const skillUpsert = vi.fn((card) => ({ name: card.name }));
    const listSkills = () => [{ name: 'noe-learned-old', displayName: '修复 NoeMissionStore 前缀越界并做回归测试', enabled: true, updatedAt: new Date(Date.now()).toISOString() }];
    const d = createNoeSkillDistiller({ skillUpsert, listSkills }); // dedupPregate 未传=OFF
    expect(d.observe(multiStepGoal, { goalDone: true }).created).toBe(true);
    expect(skillUpsert).toHaveBeenCalledTimes(1);
  });
  it('反向：dedupPregate ON + 不同主题卡 → 正常蒸馏（不误杀新技能）', () => {
    const skillUpsert = vi.fn((card) => ({ name: card.name }));
    const listSkills = () => [{ name: 'noe-learned-other', displayName: '优化数据库连接池配置参数', enabled: true, updatedAt: new Date(Date.now()).toISOString() }];
    const d = createNoeSkillDistiller({ skillUpsert, dedupPregate: true, listSkills });
    expect(d.observe(multiStepGoal, { goalDone: true }).created).toBe(true);
  });
  it('反向：dedupPregate ON 但 listSkills 未注入 → 正常蒸馏（fail-open 不卡）', () => {
    const skillUpsert = vi.fn((card) => ({ name: card.name }));
    const d = createNoeSkillDistiller({ skillUpsert, dedupPregate: true });
    expect(d.observe(multiStepGoal, { goalDone: true }).created).toBe(true);
  });
});
