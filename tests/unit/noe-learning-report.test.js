// @ts-check
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { buildLearningReport } from '../../src/cognition/NoeLearningReport.js';

// 学习照妖镜聚合：注入 :memory: db（只建用到的两表），验证三问聚合 + 勤奋空转/健康判定。
function seed() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE noe_goals(title TEXT, source TEXT, status TEXT, created_at INTEGER);
    CREATE TABLE noe_memory(title TEXT, source_type TEXT, hit_count INTEGER, created_at INTEGER);
  `);
  return db;
}

describe('buildLearningReport — 学习照妖镜', () => {
  it('① 在搜什么：多样性 + 重复度 + 最常学（非 self_learning 不计）', () => {
    const db = seed();
    const ins = db.prepare('INSERT INTO noe_goals(title,source,status,created_at) VALUES(?,?,?,?)');
    for (let i = 0; i < 6; i++) ins.run('自主学习：主题A', 'self_learning', 'done', 1000 + i);
    for (let i = 0; i < 3; i++) ins.run('自主学习：主题B', 'self_learning', 'done', 2000 + i);
    ins.run('自主学习：主题C', 'self_learning', 'active', 3000);
    ins.run('别的目标', 'self', 'done', 9999); // 非 self_learning 不计入
    const r = buildLearningReport(db);
    expect(r.searching.totalLearnings).toBe(10);
    expect(r.searching.distinctTopics).toBe(3);
    expect(r.searching.repeatRatio).toBeCloseTo(0.7, 5); // 1 - 3/10
    expect(r.searching.topRepeated[0]).toEqual({ topic: '主题A', times: 6 });
  });

  it('②③ 学到啥/有用吗 + 勤奋空转判定（主题打转 + 回流断）', () => {
    const db = seed();
    const ig = db.prepare('INSERT INTO noe_goals(title,source,status,created_at) VALUES(?,?,?,?)');
    for (let t = 0; t < 4; t++) for (let i = 0; i < 5; i++) ig.run(`自主学习：T${t}`, 'self_learning', 'done', t * 100 + i); // 4 主题 20 次=5×
    const im = db.prepare('INSERT INTO noe_memory(title,source_type,hit_count,created_at) VALUES(?,?,?,?)');
    for (let i = 0; i < 10; i++) im.run(`卡${i}`, 'skill_distill', i < 2 ? 5 : 0, 1000 + i); // 10 张 2 张被用
    im.run('别的记忆', 'voice', 99, 5000); // 非学习卡不计
    const r = buildLearningReport(db);
    expect(r.learned.totalCards).toBe(10);
    expect(r.learned.byType[0]).toMatchObject({ type: 'skill_distill', count: 10, used: 2, maxHit: 5 });
    expect(r.usefulness.usedRatio).toBeCloseTo(0.2, 5);
    expect(r.usefulness.deadCards).toBe(8);
    expect(r.verdict.level).toBe('spinning');
    expect(r.verdict.flags.length).toBe(2); // 打转 + 回流断
  });

  it('多样学习 + 高回流 → 健康（无 flag）', () => {
    const db = seed();
    const ig = db.prepare('INSERT INTO noe_goals(title,source,status,created_at) VALUES(?,?,?,?)');
    for (let t = 0; t < 5; t++) ig.run(`自主学习：主题${t}`, 'self_learning', 'done', t); // 5 主题各 1 次
    const im = db.prepare('INSERT INTO noe_memory(title,source_type,hit_count,created_at) VALUES(?,?,?,?)');
    for (let i = 0; i < 10; i++) im.run(`卡${i}`, 'skill_distill', i < 5 ? 3 : 0, i); // 5/10 被用
    const r = buildLearningReport(db);
    expect(r.verdict.level).toBe('healthy');
    expect(r.verdict.flags.length).toBe(0);
  });

  it('空库不崩（0 学习）', () => {
    const r = buildLearningReport(seed());
    expect(r.searching.totalLearnings).toBe(0);
    expect(r.learned.totalCards).toBe(0);
    expect(r.usefulness.usedRatio).toBe(0);
    expect(r.verdict.level).toBe('healthy');
  });
});
