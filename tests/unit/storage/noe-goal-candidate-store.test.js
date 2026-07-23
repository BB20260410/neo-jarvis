// @ts-nocheck
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { NoeGoalCandidateStore } from '../../../src/storage/NoeGoalCandidateStore.js';

// 独立 in-memory 库 + 手动建表（与 SqliteStore migration v16 一致），注入连接——不碰全局单例。
function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE noe_goal_candidates (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      source TEXT NOT NULL DEFAULT 'unknown',
      title TEXT NOT NULL DEFAULT '',
      why TEXT NOT NULL DEFAULT '',
      base_score REAL,
      score REAL NOT NULL DEFAULT 0,
      decision TEXT NOT NULL DEFAULT 'pending',
      reject_reason TEXT NOT NULL DEFAULT '',
      risk_tier TEXT NOT NULL DEFAULT '',
      risk_json TEXT,
      goal_id TEXT,
      overridden_by_owner INTEGER NOT NULL DEFAULT 0
    );
  `);
  return db;
}

describe('NoeGoalCandidateStore（候选池持久化 P2 切片A）', () => {
  let db; let store;
  beforeEach(() => {
    db = makeDb();
    store = new NoeGoalCandidateStore({ db });
  });

  it('insert + get 往返：camelCase↔snake 映射正确', () => {
    store.insert({ id: 'c1', created_at: 100, source: 'owner', title: '研究X', why: '主人交办', baseScore: 0.6, score: 0.6, decision: 'pending' });
    const got = store.get('c1');
    expect(got).toMatchObject({ id: 'c1', source: 'owner', title: '研究X', why: '主人交办', baseScore: 0.6, score: 0.6, decision: 'pending', created_at: 100 });
    expect(got.decided_at).toBe(null);
    expect(got.goal_id).toBe(null);
    expect(got.overridden_by_owner).toBe(false);
  });

  it('baseScore undefined → 存 null → 读回 undefined（不是 0，区分"没自报"）', () => {
    store.insert({ id: 'c2', created_at: 1, source: 'drive', title: 't' });
    expect(store.get('c2').baseScore).toBeUndefined();
  });

  it('update 局部列：decision/score/decided_at/goal_id', () => {
    store.insert({ id: 'c3', created_at: 1, source: 'owner', title: 't', decision: 'pending' });
    store.update('c3', { decision: 'accepted', score: 0.6, decided_at: 222, goal_id: 'goal-1' });
    expect(store.get('c3')).toMatchObject({ decision: 'accepted', score: 0.6, decided_at: 222, goal_id: 'goal-1' });
  });

  it('update risk 对象 → risk_json → get 还原', () => {
    store.insert({ id: 'c4', created_at: 1, source: 'self_evolution', title: 't' });
    store.update('c4', { risk_tier: 'yellow', risk: { tier: 'yellow', dims: { blast: 'green' }, reasons: ['缺 rollback'] } });
    const got = store.get('c4');
    expect(got.risk_tier).toBe('yellow');
    expect(got.risk).toEqual({ tier: 'yellow', dims: { blast: 'green' }, reasons: ['缺 rollback'] });
  });

  it('反向 probe：update 非白名单 key 静默丢弃（不报错、不写脏列）', () => {
    store.insert({ id: 'c5', created_at: 1, source: 'owner', title: 't' });
    expect(() => store.update('c5', { id: 'HACK', evil_col: 1, decision: 'rejected' })).not.toThrow();
    const got = store.get('c5');
    expect(got.id).toBe('c5'); // id 未被改
    expect(got.decision).toBe('rejected'); // 白名单列正常写
  });

  it('反向 probe：update 空 patch 不发空 SQL、不报错', () => {
    store.insert({ id: 'c6', created_at: 1, source: 'owner', title: 't' });
    expect(() => store.update('c6', {})).not.toThrow();
    expect(store.get('c6').decision).toBe('pending');
  });

  it('overridden_by_owner boolean → 0/1 往返', () => {
    store.insert({ id: 'c7', created_at: 1, source: 'drive', title: 't' });
    store.update('c7', { overridden_by_owner: true, decision: 'accepted' });
    expect(store.get('c7').overridden_by_owner).toBe(true);
  });

  it('list：decision 过滤 + created_at 倒序', () => {
    store.insert({ id: 'a', created_at: 10, source: 'owner', title: 'a', decision: 'accepted' });
    store.insert({ id: 'b', created_at: 30, source: 'owner', title: 'b', decision: 'pending' });
    store.insert({ id: 'c', created_at: 20, source: 'owner', title: 'c', decision: 'accepted' });
    const accepted = store.list({ decision: 'accepted' });
    expect(accepted.map((x) => x.id)).toEqual(['c', 'a']); // 20 > 10 倒序
    expect(store.list().map((x) => x.id)).toEqual(['b', 'c', 'a']); // 30 > 20 > 10
  });

  it('反向 probe：get 不存在 → null', () => {
    expect(store.get('nope')).toBe(null);
  });

  it('反向 probe：INSERT OR REPLACE 同 id 覆盖（重复 submit 幂等不报错）', () => {
    store.insert({ id: 'dup', created_at: 1, source: 'owner', title: '旧' });
    store.insert({ id: 'dup', created_at: 2, source: 'owner', title: '新' });
    expect(store.get('dup').title).toBe('新');
    expect(store.list().length).toBe(1);
  });

  it('list limit 上限夹到 500（防爆查询）', () => {
    store.insert({ id: 'x', created_at: 1, source: 'owner', title: 't' });
    expect(() => store.list({ limit: 99999 })).not.toThrow();
    expect(() => store.list({ limit: -5 })).not.toThrow();
  });

  it('反向 probe：update 继承键（constructor/toString）被丢弃，不崩不写脏列（codex 审核坐实）', () => {
    store.insert({ id: 'cp', created_at: 1, source: 'owner', title: 't' });
    expect(() => store.update('cp', { constructor: 'X', toString: 'Y', decision: 'accepted' })).not.toThrow();
    expect(store.get('cp').decision).toBe('accepted');
  });

  it('baseScore 字符串数字容错（insert "0.9" → 0.9，非降级 null）', () => {
    store.insert({ id: 'bs', created_at: 1, source: 'owner', title: 't', baseScore: '0.9' });
    expect(store.get('bs').baseScore).toBe(0.9);
  });
});
