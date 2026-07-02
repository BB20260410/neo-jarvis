// CE12 单元测试阶段补测（Claude 成员独立稿）：
// ActStore 是 FR-P0-4 Act Pipeline 的持久层，此前只被 ActPipeline 间接覆盖，
// 缺少对默认值 / 字段截断 / 非法状态 fail-fast / list 过滤与上限裁剪 /
// current 排序 / cancel 终态保护 / summary 聚合等核心逻辑与边界的直测。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { ActStore } from '../../src/loop/ActStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-act-store-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('ActStore（FR-P0-4 持久层）', () => {
  it('create 使用安全默认值并生成 act- 前缀 id', () => {
    const store = new ActStore({ projectId: 'noe-store' });
    const act = store.create({});
    expect(act.id).toMatch(/^act-/);
    expect(act).toMatchObject({
      projectId: 'noe-store',
      title: 'Noe act',
      action: 'noe.act.review',
      riskLevel: 'low',
      status: 'queued',
      budgetState: 'pending',
      permissionState: 'pending',
      costEstimateUsd: 0,
    });
    expect(act.payload).toEqual({});
  });

  it('create 对超长 title 截断到 240 字符（边界）', () => {
    const store = new ActStore({ projectId: 'noe-store' });
    const act = store.create({ title: 'x'.repeat(300) });
    expect(act.title.length).toBe(240);
  });

  it('create 负数 costEstimateUsd 被夹到 0（边界）', () => {
    const store = new ActStore({ projectId: 'noe-store' });
    const act = store.create({ costEstimateUsd: -10 });
    expect(act.costEstimateUsd).toBe(0);
  });

  it('非法 status 抛错（normalizeStatus fail-fast）', () => {
    const store = new ActStore({ projectId: 'noe-store' });
    expect(() => store.create({ status: 'bogus' })).toThrow(/invalid act status/);
  });

  it('get 对不存在或空 id 返回 null（失败分支）', () => {
    const store = new ActStore({ projectId: 'noe-store' });
    expect(store.get('missing')).toBe(null);
    expect(store.get('')).toBe(null);
    expect(store.get(null)).toBe(null);
  });

  it('update 合并 payload，对不存在 id 返回 null', () => {
    const store = new ActStore({ projectId: 'noe-store' });
    const act = store.create({ payload: { a: 1 } });
    const updated = store.update(act.id, { status: 'planning', payload: { b: 2 } });
    expect(updated.status).toBe('planning');
    expect(updated.payload).toMatchObject({ a: 1, b: 2 });
    expect(store.update('missing', { status: 'planning' })).toBe(null);
  });

  it('list 支持 status 过滤与 limit 上限裁剪（边界）', () => {
    const store = new ActStore({ projectId: 'noe-store' });
    store.create({ status: 'queued' });
    store.create({ status: 'completed' });
    store.create({ status: 'completed' });
    expect(store.list({ projectId: 'noe-store' })).toHaveLength(3);
    expect(store.list({ projectId: 'noe-store', status: 'completed' })).toHaveLength(2);
    expect(store.list({ projectId: 'noe-store', limit: 1 })).toHaveLength(1);
    // limit 远超 100 被裁剪，但现有 3 条仍能全部返回
    expect(store.list({ projectId: 'noe-store', limit: 9999 })).toHaveLength(3);
  });

  it('current 返回最近创建并更新的 act（排序）', () => {
    const store = new ActStore({ projectId: 'noe-store' });
    store.create({ title: 'A' });
    const b = store.create({ title: 'B' });
    store.update(b.id, { status: 'planning' });
    expect(store.current({ projectId: 'noe-store' }).id).toBe(b.id);
  });

  it('cancel 活动 act → cancelled；终态不被覆盖；缺失 id → null', () => {
    const store = new ActStore({ projectId: 'noe-store' });
    const active = store.create({ status: 'queued' });
    expect(store.cancel(active.id).status).toBe('cancelled');

    const done = store.create({ status: 'completed' });
    expect(store.cancel(done.id).status).toBe('completed');

    const blocked = store.create({ status: 'blocked_safety' });
    expect(store.cancel(blocked.id).status).toBe('blocked_safety');

    expect(store.cancel('missing')).toBe(null);
  });

  it('summary 汇总各状态计数并聚合 pending', () => {
    const store = new ActStore({ projectId: 'noe-store' });
    store.create({ status: 'queued' });
    store.create({ status: 'awaiting_approval' });
    store.create({ status: 'completed' });
    const s = store.summary({ projectId: 'noe-store' });
    expect(s.byStatus.queued).toBe(1);
    expect(s.byStatus.awaiting_approval).toBe(1);
    expect(s.byStatus.completed).toBe(1);
    // pending = queued + awaiting_approval（completed 不计入）
    expect(s.pending).toBe(2);
    expect(s.current).not.toBe(null);
  });

  it('list/summary 按 projectId 隔离（回归点：不跨项目串数据）', () => {
    const a = new ActStore({ projectId: 'proj-a' });
    const b = new ActStore({ projectId: 'proj-b' });
    a.create({ status: 'queued' });
    b.create({ status: 'queued' });
    b.create({ status: 'completed' });
    expect(a.list({ projectId: 'proj-a' })).toHaveLength(1);
    expect(b.list({ projectId: 'proj-b' })).toHaveLength(2);
    expect(a.summary({ projectId: 'proj-a' }).byStatus.completed).toBeUndefined();
  });
});
