import { describe, expect, it } from 'vitest';
import { decideMemoryConflict } from '../../src/memory/NoeMemoryConflictPolicy.js';

const NOW = 1_780_000_000_000;

describe('NoeMemoryConflictPolicy', () => {
  it('偏好更替：美式 -> 现在改喝拿铁，判 supersede 并给 validTo', () => {
    const r = decideMemoryConflict({
      oldFact: { text: '用户喜欢喝美式咖啡', sourceType: 'owner', confidence: 0.9, salience: 4 },
      newFact: { text: '用户现在改喝拿铁', sourceType: 'owner', confidence: 0.95, salience: 4 },
      now: NOW,
    });
    expect(r).toMatchObject({ action: 'supersede', reason: 'explicit_update', slot: 'drink_preference', validTo: NOW });
  });

  it('地点更替：住成都 -> 搬到上海，判 supersede', () => {
    const r = decideMemoryConflict({
      oldFact: { text: '用户住在成都', sourceType: 'owner', confidence: 0.9 },
      newFact: { text: '用户已经搬到上海', sourceType: 'owner', confidence: 0.9 },
      now: NOW,
    });
    expect(r.action).toBe('supersede');
    expect(r.slot).toBe('location');
  });

  it('同义/近重复事实合并，不制造冲突', () => {
    const r = decideMemoryConflict({
      oldFact: { text: '用户喜欢喝美式咖啡', sourceType: 'owner' },
      newFact: { text: '用户喜欢喝美式咖啡。', sourceType: 'owner' },
      now: NOW,
    });
    expect(r.action).toBe('merge');
  });

  it('owner 明确高盐事实不会被低置信模型推测覆盖', () => {
    const r = decideMemoryConflict({
      oldFact: { text: '用户住在成都', sourceType: 'owner', confidence: 0.95, salience: 5 },
      newFact: { text: '也许用户住在上海', sourceType: 'reflection', confidence: 0.45, salience: 2 },
      now: NOW,
    });
    expect(r.action).toBe('ignore');
    expect(r.reason).toBe('uncertain_low_confidence');
  });

  it('受保护事实遇到较弱来源高置信冲突时需要人工复核', () => {
    const r = decideMemoryConflict({
      oldFact: { text: '用户住在成都', sourceType: 'owner', confidence: 0.95, salience: 5 },
      newFact: { text: '用户搬到上海', sourceType: 'reflection', confidence: 0.9, salience: 3 },
      now: NOW,
    });
    expect(r).toMatchObject({ action: 'needs_review', reason: 'protected_fact_conflict', slot: 'location' });
  });

  it('不同事实槽位保留两条', () => {
    const r = decideMemoryConflict({
      oldFact: { text: '用户喜欢喝美式咖啡', sourceType: 'owner' },
      newFact: { text: '用户住在成都', sourceType: 'owner' },
      now: NOW,
    });
    expect(r.action).toBe('keep_both');
  });

  it('受保护事实的近重复(只改关键值)不被弱源直接合并覆盖', () => {
    const r = decideMemoryConflict({
      oldFact: { text: '用户生日是1990年1月1日', sourceType: 'owner', confidence: 0.95, salience: 5 },
      newFact: { text: '用户生日是1990年1月2日', sourceType: 'reflection', confidence: 0.9, salience: 3 },
      now: NOW,
    });
    expect(r.action).not.toBe('merge');   // 修复前: near_duplicate 直接 merge，弱源覆盖 owner 生日
    expect(r).toMatchObject({ action: 'needs_review', reason: 'protected_fact_conflict' });
  });

  it('含城市名但非地点事实(喜欢北京烤鸭)不被误判为地点冲突', () => {
    const r = decideMemoryConflict({
      oldFact: { text: '用户喜欢北京烤鸭', sourceType: 'owner' },
      newFact: { text: '用户住在上海', sourceType: 'owner' },
      now: NOW,
    });
    expect(r.action).toBe('keep_both');   // 修复前: 都含城市名→都判 location→same_slot supersede
  });

  it('含"叫"但非身份事实(爱吃叫花鸡)不被误判为身份冲突', () => {
    const r = decideMemoryConflict({
      oldFact: { text: '用户爱吃叫花鸡', sourceType: 'owner' },
      newFact: { text: '用户叫做李雷', sourceType: 'owner' },
      now: NOW,
    });
    expect(r.action).toBe('keep_both');   // 修复前: 都含"叫"→都判 identity→same_slot supersede
  });

  it('收紧 factSlot 后仍识别真地点/身份事实(不漏判，修返工前引入的假阴性)', () => {
    const r1 = decideMemoryConflict({
      oldFact: { text: '用户住成都', sourceType: 'owner', confidence: 0.9 },
      newFact: { text: '用户搬到上海', sourceType: 'owner', confidence: 0.9 },
      now: NOW,
    });
    expect(r1).toMatchObject({ action: 'supersede', slot: 'location' });   // 住成都/搬到上海 仍识别地点更替

    const r2 = decideMemoryConflict({
      oldFact: { text: '用户在南京工作', sourceType: 'owner', confidence: 0.9 },
      newFact: { text: '用户在武汉定居', sourceType: 'owner', confidence: 0.9 },
      now: NOW,
    });
    expect(r2).toMatchObject({ action: 'supersede', slot: 'location' });   // 非白名单城市靠"在X工作/定居"识别

    const r3 = decideMemoryConflict({
      oldFact: { text: '用户叫李雷', sourceType: 'owner', confidence: 0.9 },
      newFact: { text: '用户叫张三', sourceType: 'owner', confidence: 0.9 },
      now: NOW,
    });
    expect(r3).toMatchObject({ action: 'supersede', slot: 'identity' });   // "用户叫X" 仍识别为身份
  });
});
