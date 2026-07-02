import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EpisodicTimeline, relativeTime, EPISODE_KIND } from '../../src/memory/EpisodicTimeline.js';
import { initSqlite, close, listEvents } from '../../src/storage/SqliteStore.js';

// 忠实模拟 SqliteStore 的具名字段 vs ...payload 拆分语义，核心逻辑用它（快/纯/可控）。
function makeFake() {
  const rows = [];
  let id = 0;
  const append = ({ kind, ts, tag, sessionId, roomId, entityType, ...payload }) => {
    rows.push({ id: ++id, ts, kind, tag, room_id: roomId, session_id: sessionId, entity_type: entityType, payload });
    return id;
  };
  const list = ({ kind, sinceTs, limit = 200, order = 'DESC' }) => {
    let out = rows.filter((r) => (!kind || r.kind === kind) && (sinceTs == null || r.ts >= sinceTs));
    out = out.sort((a, b) => (order === 'ASC' ? a.ts - b.ts : b.ts - a.ts)).slice(0, limit);
    return out.map((r) => ({ ...r, roomId: r.room_id, sessionId: r.session_id, entityType: r.entity_type }));
  };
  const count = ({ kind }) => rows.filter((r) => !kind || r.kind === kind).length;
  return { append, list, count, rows };
}

const T0 = 1_780_000_000_000;

describe('relativeTime', () => {
  it('各时间档表达正确（连续感来源）', () => {
    const now = T0;
    expect(relativeTime(now - 30_000, now)).toBe('刚刚');
    expect(relativeTime(now - 2 * 60_000, now)).toBe('2 分钟前');
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3 小时前');
    expect(relativeTime(now - 24 * 3_600_000, now)).toBe('昨天');
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe('3 天前');
    expect(relativeTime(now - 10 * 86_400_000, now)).toBe('1 周前');
    expect(relativeTime(now - 40 * 86_400_000, now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('未来/0 差值归一为"刚刚"', () => {
    expect(relativeTime(T0 + 5000, T0)).toBe('刚刚');
    expect(relativeTime(T0, T0)).toBe('刚刚');
  });
});

describe('EpisodicTimeline（fake store 核心逻辑）', () => {
  function make(extra = {}) {
    const fake = makeFake();
    const tl = new EpisodicTimeline({ append: fake.append, list: fake.list, count: fake.count, now: () => T0, ...extra });
    return { tl, fake };
  }

  it('record：写入情景，类型白名单兜底、summary 必填、salience clamp', () => {
    const { tl, fake } = make();
    tl.record({ type: 'interaction', summary: '聊了 AI 意识', salience: 7 });
    tl.record({ type: '乱填的', summary: '类型非法回退 interaction' });   // 非法 → interaction
    tl.record({ type: 'milestone', summary: '修好媒体 bug', salience: 99 });  // clamp 到 10
    tl.record({ type: 'setback', summary: '任务搞砸了' });   // 负向情景须原样保留，不能被回退成 interaction（否则失败反而变暖、v 上升）
    tl.record({ type: 'correction', summary: '主人纠正了我' });   // correction 同为负向情景，同须原样保留
    expect(fake.rows).toHaveLength(5);
    expect(fake.rows[0].payload.salience).toBe(7);
    expect(fake.rows[1].payload.episodeType).toBe('interaction');
    expect(fake.rows[2].payload.salience).toBe(10);
    expect(fake.rows[3].payload.episodeType).toBe('setback');   // 关键：setback 已进白名单，端到端不被改写
    expect(fake.rows[4].payload.episodeType).toBe('correction');   // correction 同样不被回退
    expect(fake.rows[0].kind).toBe(EPISODE_KIND);
    expect(() => tl.record({ summary: '  ' })).toThrow(/summary required/);
  });

  it('record：selfState 快照透传，非对象置 null', () => {
    const { tl, fake } = make();
    tl.record({ summary: 'a', selfState: { mood: '专注', focus: '改代码' } });
    tl.record({ summary: 'b', selfState: 'not-an-object' });
    expect(fake.rows[0].payload.selfState).toEqual({ mood: '专注', focus: '改代码' });
    expect(fake.rows[1].payload.selfState).toBeNull();
  });

  it('recent：时序倒序，types 过滤，summary 空被滤', () => {
    const { tl } = make();
    tl.record({ type: 'interaction', summary: '一', ts: T0 - 3000 });
    tl.record({ type: 'dream', summary: '二', ts: T0 - 2000 });
    tl.record({ type: 'interaction', summary: '三', ts: T0 - 1000 });
    const all = tl.recent();
    expect(all.map((e) => e.summary)).toEqual(['三', '二', '一']);   // 最近在前
    const onlyChat = tl.recent({ types: ['interaction'] });
    expect(onlyChat.map((e) => e.summary)).toEqual(['三', '一']);
  });

  it('recent：sinceTs 只取窗口内', () => {
    const { tl } = make();
    tl.record({ summary: '旧', ts: T0 - 100_000 });
    tl.record({ summary: '新', ts: T0 - 1000 });
    expect(tl.recent({ sinceTs: T0 - 10_000 }).map((e) => e.summary)).toEqual(['新']);
  });

  it('narrative：编织自传体叙事，相对时间，含包裹标签', () => {
    const { tl } = make();
    tl.record({ summary: '聊了 AI 能不能有意识', ts: T0 - 60_000 });
    tl.record({ summary: '修好媒体生成落盘 bug', ts: T0 - 2 * 3_600_000 });
    const text = tl.narrative();
    expect(text).toContain('<noe-recent-timeline>');
    expect(text).toContain('1 分钟前：聊了 AI 能不能有意识');
    expect(text).toContain('2 小时前：修好媒体生成落盘 bug');
    expect(text).toContain('</noe-recent-timeline>');
  });

  it('narrative：空时间线返回空串；minSalience 过滤琐碎', () => {
    const { tl } = make();
    expect(tl.narrative()).toBe('');
    tl.record({ summary: '琐碎', salience: 1, ts: T0 - 1000 });
    tl.record({ summary: '重要', salience: 8, ts: T0 - 2000 });
    const text = tl.narrative({ minSalience: 5 });
    expect(text).toContain('重要');
    expect(text).not.toContain('琐碎');
  });

  it('narrative：maxChars 截断不超限', () => {
    const { tl } = make();
    for (let i = 0; i < 30; i += 1) tl.record({ summary: `情景${i}`.repeat(10), ts: T0 - i * 1000 });
    const text = tl.narrative({ maxChars: 200 });
    expect(text.length).toBeLessThan(400);   // 标签头尾 + 截断后的行
  });
});

describe('EpisodicTimeline（真 SQLite 端到端，验证字段映射）', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-epi-')); initSqlite(join(dir, 'test.db')); });
  afterEach(() => { close(); rmSync(dir, { recursive: true, force: true }); });

  it('record→真 events 表→recent/narrative 读回一致', () => {
    const tl = new EpisodicTimeline({ now: () => T0 });   // 默认 appendEvent/listEvents 走 tmp db
    tl.record({ type: 'milestone', summary: '给 Noe 接上连续记忆脊椎', selfState: { mood: '认真' }, salience: 9, ts: T0 - 5000 });
    tl.record({ type: 'interaction', summary: 'owner 问 AI 能否有自主意识', salience: 6, ts: T0 - 1000 });

    // 真 events 表里确实有两条 noe_episode
    expect(listEvents({ kind: EPISODE_KIND }).length).toBe(2);
    expect(tl.total()).toBe(2);

    const recent = tl.recent();
    expect(recent.map((e) => e.summary)).toEqual(['owner 问 AI 能否有自主意识', '给 Noe 接上连续记忆脊椎']);
    expect(recent[1].selfState).toEqual({ mood: '认真' });   // selfState 经 JSON 往返不丢
    expect(recent[1].salience).toBe(9);

    const text = tl.narrative();
    expect(text).toContain('给 Noe 接上连续记忆脊椎');
    expect(text).toContain('owner 问 AI 能否有自主意识');
  });
});
