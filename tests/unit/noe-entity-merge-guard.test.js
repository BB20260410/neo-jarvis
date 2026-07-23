import { describe, it, expect } from 'vitest';
import { extractEntityIdentifiers, shouldBlockEntityMerge } from '../../src/memory/NoeEntityMergeGuard.js';

describe('extractEntityIdentifiers', () => {
  it('抽版本/编号后缀/带单位数字/裸显著数字', () => {
    expect([...extractEntityIdentifiers('用 v1.2 修复')]).toContain('v1.2');
    expect([...extractEntityIdentifiers('文件 task-10')]).toContain('task-10');
    expect([...extractEntityIdentifiers('频率 440Hz 疗愈')]).toContain('440hz');
    expect([...extractEntityIdentifiers('延迟 300 ms')]).toContain('300ms');
    expect([...extractEntityIdentifiers('有 128 个候选')]).toContain('128');
  });
  it('无数字 → 空集', () => {
    expect(extractEntityIdentifiers('一段普通的描述文本').size).toBe(0);
  });
});

describe('shouldBlockEntityMerge（P3-3 防误合）', () => {
  it('编号不同 → 禁合（/x-1 vs /x-10）', () => {
    const r = shouldBlockEntityMerge('路径 x-1 的说明', '路径 x-10 的说明');
    expect(r.block).toBe(true);
    expect(r.reason).toBe('distinct_numbered_or_versioned_entity');
  });
  it('频率不同 → 禁合（440Hz vs 880Hz）', () => {
    expect(shouldBlockEntityMerge('疗愈频率 440Hz', '疗愈频率 880Hz').block).toBe(true);
  });
  it('版本不同 → 禁合（v1.2 vs v1.3）', () => {
    expect(shouldBlockEntityMerge('升级到 v1.2', '升级到 v1.3').block).toBe(true);
  });
  it('计数不同 → 禁合（3 个 vs 5 个，避免不同事实被合）', () => {
    expect(shouldBlockEntityMerge('完成了 15 个任务', '完成了 27 个任务').block).toBe(true);
  });
  it('两侧都无数字 → 不拦（交给相似度）', () => {
    expect(shouldBlockEntityMerge('owner 偏好简洁回答', 'owner 喜欢简短回复').block).toBe(false);
  });
  it('标识完全一致 → 不拦（同实体可合）', () => {
    const r = shouldBlockEntityMerge('v2.0 发布说明，含 100 项', 'v2.0 的发布说明 100 项');
    expect(r.block).toBe(false);
    expect(r.reason).toBe('identifiers_match');
  });
  it('一侧有编号一侧无 → 保守禁合（对称差非空）', () => {
    expect(shouldBlockEntityMerge('任务 task-7 进行中', '某个任务进行中').block).toBe(true);
  });
});
