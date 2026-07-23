import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, appendEvent, listEvents, pruneEvents } from '../../src/storage/SqliteStore.js';
import { EPISODE_KIND } from '../../src/memory/EpisodicTimeline.js';

// 强健补遗 A 测试：events 表保留期清理（表此前只进不出）。
// 慢燃记忆数据损坏回归（2026-06-13）：自传体情景(kind='noe_episode')绝不能随普通 events 180 天硬删——
// 升华抢救默认 OFF，到期硬删=无声丢失连续记忆脊椎。情景单独受更长保留期(默认 3650 天)保护，仍留清理天花板。

let tmp;
const NOW = 1_700_000_000_000;
const DAY = 86400000;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-prune-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('pruneEvents', () => {
  it('删保留期外的行，期内的不动', () => {
    appendEvent({ kind: 'old_event', ts: NOW - 200 * DAY });
    appendEvent({ kind: 'recent_event', ts: NOW - 10 * DAY });
    const removed = pruneEvents({ retentionDays: 180, now: NOW });
    expect(removed).toBe(1);
    const left = listEvents({});
    expect(left.some((e) => e.kind === 'recent_event')).toBe(true);
    expect(left.some((e) => e.kind === 'old_event')).toBe(false);
  });

  it('保留期下限守卫：<7 天直接拒绝（防误传小值清空审计）', () => {
    expect(() => pruneEvents({ retentionDays: 0, now: NOW })).toThrow(/>= 7/);
    expect(() => pruneEvents({ retentionDays: NaN, now: NOW })).toThrow(/>= 7/);
  });

  it('空表/无过期行返回 0', () => {
    expect(pruneEvents({ retentionDays: 180, now: NOW })).toBe(0);
  });

  // ===== 慢燃记忆数据损坏回归（这组在修复前会失败、修复后通过）=====

  it('自传体情景(noe_episode)200 天前不被普通 180 天 prune 误删（连续记忆脊椎不能无声丢失）', () => {
    // 修复前：pruneEvents 无差别 DELETE，此情景会被删，断言 episodeSurvives 失败。
    appendEvent({ kind: EPISODE_KIND, ts: NOW - 200 * DAY, tag: 'interaction', entityType: EPISODE_KIND });
    const removed = pruneEvents({ retentionDays: 180, now: NOW });
    expect(removed).toBe(0);
    const left = listEvents({ kind: EPISODE_KIND });
    expect(left.some((e) => e.ts === NOW - 200 * DAY)).toBe(true);
  });

  it('情景受豁免、普通事件照常清理：同一轮里只删普通过期行，留下情景', () => {
    appendEvent({ kind: EPISODE_KIND, ts: NOW - 200 * DAY, tag: 'interaction', entityType: EPISODE_KIND });
    appendEvent({ kind: 'metrics', ts: NOW - 200 * DAY });   // 普通审计：过期应删
    appendEvent({ kind: 'metrics', ts: NOW - 10 * DAY });    // 普通审计：期内应留
    const removed = pruneEvents({ retentionDays: 180, now: NOW });
    expect(removed).toBe(1);   // 只删那条 200 天前的 metrics
    const left = listEvents({});
    expect(left.some((e) => e.kind === EPISODE_KIND)).toBe(true);
    expect(left.some((e) => e.kind === 'metrics' && e.ts === NOW - 200 * DAY)).toBe(false);
    expect(left.some((e) => e.kind === 'metrics' && e.ts === NOW - 10 * DAY)).toBe(true);
  });

  it('情景仍有清理天花板：超 episodeRetentionDays(默认 3650 天)的久远情景会被清，避免自传表无界增长', () => {
    appendEvent({ kind: EPISODE_KIND, ts: NOW - 4000 * DAY, tag: 'interaction', entityType: EPISODE_KIND });   // 超 10 年
    appendEvent({ kind: EPISODE_KIND, ts: NOW - 200 * DAY, tag: 'interaction', entityType: EPISODE_KIND });    // 10 年内
    const removed = pruneEvents({ retentionDays: 180, now: NOW });
    expect(removed).toBe(1);   // 只删超 10 年那条
    const left = listEvents({ kind: EPISODE_KIND });
    expect(left.some((e) => e.ts === NOW - 200 * DAY)).toBe(true);
    expect(left.some((e) => e.ts === NOW - 4000 * DAY)).toBe(false);
  });

  it('守卫：episodeRetentionDays < retentionDays 直接拒绝（防把自传记忆配得比普通事件更快删）', () => {
    expect(() => pruneEvents({ retentionDays: 180, episodeRetentionDays: 90, now: NOW })).toThrow(/episodeRetentionDays/);
  });
});
