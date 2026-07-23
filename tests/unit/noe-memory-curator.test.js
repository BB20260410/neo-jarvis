import { describe, expect, it } from 'vitest';
import { classifyMemory, planMemoryGc } from '../../src/memory/NoeMemoryCurator.js';

const NOW = 1_700_000_000_000;       // 固定 now（ms）
const DAY = 86400000;
const old = NOW - 200 * DAY;          // 久远（超 90 天 stale 阈值）
const recent = NOW - 1 * DAY;         // 最近

describe('classifyMemory', () => {
  it('salience>=5 身份级永不 GC（即使已过期）', () => {
    expect(classifyMemory({ id: 'a', salience: 5, expired: true }, { now: NOW })).toBe('protected');
  });
  it('pinned 永不 GC，兼容 true/1/"1"/snake_case', () => {
    expect(classifyMemory({ id: 'a', salience: 1, pinned: true }, { now: NOW })).toBe('protected');
    expect(classifyMemory({ id: 'a', salience: 1, pinned: 1 }, { now: NOW })).toBe('protected');
    expect(classifyMemory({ id: 'a', salience: 1, pinned: '1' }, { now: NOW })).toBe('protected');
    expect(classifyMemory({ id: 'a', salience: 1, is_pinned: 1 }, { now: NOW })).toBe('protected');
  });
  it('expired 兼容 1 / expiresAt 过期 → expired', () => {
    expect(classifyMemory({ id: 'a', salience: 2, expired: 1 }, { now: NOW })).toBe('expired');
    expect(classifyMemory({ id: 'a', salience: 2, expiresAt: NOW - 1000 }, { now: NOW })).toBe('expired');
  });
  it('expiresAt 为布尔等非法值不被当时间戳（防 Number(true)→1ms 误判 expired）', () => {
    expect(classifyMemory({ id: 'a', salience: 3, expiresAt: true, updatedAt: recent, hitCount: 1, confidence: 0.9 }, { now: NOW })).toBe('keep');
  });
  it('未到期的 expiresAt 不算 expired', () => {
    expect(classifyMemory({ id: 'a', salience: 3, expiresAt: NOW + 1000, updatedAt: recent, hitCount: 1, confidence: 0.9 }, { now: NOW })).toBe('keep');
  });
  it('久未更新+低显著+零命中 → stale', () => {
    expect(classifyMemory({ id: 'a', salience: 1, updatedAt: old, hitCount: 0, confidence: 0.9 }, { now: NOW })).toBe('stale');
  });
  it('stale 边界 >= staleMs（恰好 90 天整也算，与 expired 的 <= 对齐）', () => {
    expect(classifyMemory({ id: 'a', salience: 1, updatedAt: NOW - 90 * DAY, hitCount: 0, confidence: 0.9 }, { now: NOW })).toBe('stale');
  });
  it('久未更新但高命中 → 救回 keep', () => {
    expect(classifyMemory({ id: 'a', salience: 1, updatedAt: old, hitCount: 5, confidence: 0.9 }, { now: NOW })).toBe('keep');
  });
  it('maxHitCount 放宽则低命中也算 stale', () => {
    expect(classifyMemory({ id: 'a', salience: 1, updatedAt: old, hitCount: 2, confidence: 0.9 }, { now: NOW, maxHitCount: 3 })).toBe('stale');
  });
  it('久未更新但 salience=3 高于低显著线 → keep', () => {
    expect(classifyMemory({ id: 'a', salience: 3, updatedAt: old, hitCount: 0, confidence: 0.9 }, { now: NOW })).toBe('keep');
  });
  it('低置信+零命中+低显著 → low_confidence', () => {
    expect(classifyMemory({ id: 'a', salience: 1, updatedAt: recent, hitCount: 0, confidence: 0.1 }, { now: NOW })).toBe('low_confidence');
  });
  it('confidence 缺失(undefined/null) 不进 low_confidence（不把缺失等同显式 0）', () => {
    expect(classifyMemory({ id: 'a', salience: 1, updatedAt: recent, hitCount: 0 }, { now: NOW })).toBe('keep');
    expect(classifyMemory({ id: 'a', salience: 1, updatedAt: recent, hitCount: 0, confidence: null }, { now: NOW })).toBe('keep');
  });
  it('低置信但命中过 → keep', () => {
    expect(classifyMemory({ id: 'a', salience: 1, updatedAt: recent, hitCount: 2, confidence: 0.1 }, { now: NOW })).toBe('keep');
  });
  it('已 hidden（含 1）→ keep（不重复处理）', () => {
    expect(classifyMemory({ id: 'a', salience: 1, hidden: true, expired: true }, { now: NOW })).toBe('keep');
    expect(classifyMemory({ id: 'a', salience: 1, hidden: 1, expired: true }, { now: NOW })).toBe('keep');
  });
  it('健康记忆 → keep', () => {
    expect(classifyMemory({ id: 'a', salience: 3, updatedAt: recent, hitCount: 3, confidence: 0.8 }, { now: NOW })).toBe('keep');
  });
  it('兼容 snake_case 原始 row', () => {
    expect(classifyMemory({ id: 'a', salience: 1, updated_at: old, hit_count: 0, confidence: 0.9 }, { now: NOW })).toBe('stale');
  });
});

describe('planMemoryGc', () => {
  const entries = [
    { id: 'protected', salience: 5 },
    { id: 'exp', salience: 2, expired: true },
    { id: 'stale', salience: 1, updatedAt: old, hitCount: 0, confidence: 0.9 },
    { id: 'lowconf', salience: 1, updatedAt: recent, hitCount: 0, confidence: 0.1 },
    { id: 'keep', salience: 3, updatedAt: recent, hitCount: 4, confidence: 0.8 },
  ];

  it('分桶 + gcCandidates 合并 expired/stale/low_confidence', () => {
    const r = planMemoryGc(entries, { now: NOW });
    expect(r.buckets.protected).toEqual(['protected']);
    expect(r.buckets.expired).toEqual(['exp']);
    expect(r.buckets.stale).toEqual(['stale']);
    expect(r.buckets.low_confidence).toEqual(['lowconf']);
    expect(r.buckets.keep).toEqual(['keep']);
    expect(r.gcCandidates).toEqual(['exp', 'stale', 'lowconf']);
  });

  it('counts 与 buckets 命名统一 snake_case，protected 不入候选', () => {
    const r = planMemoryGc(entries, { now: NOW });
    expect(r.counts).toMatchObject({ total: 5, classified: 5, protected: 1, expired: 1, stale: 1, low_confidence: 1, keep: 1, gc_candidates: 3, skipped: 0 });
    expect(r.gcCandidates).not.toContain('protected');
  });

  it('gcCandidates 去重（脏数据重复 id 不重复出现，防调用方重复 hide）', () => {
    const dup = [{ id: 'x', salience: 1, expired: true }, { id: 'x', salience: 1, expired: true }];
    expect(planMemoryGc(dup, { now: NOW }).gcCandidates).toEqual(['x']);
  });

  it('无效 id（null/空对象/空串）跳过并计入 skipped，total=输入数不误导', () => {
    const r = planMemoryGc([null, { body: '无 id' }, { id: '', salience: 1 }, { id: 'ok', salience: 5 }], { now: NOW });
    expect(r.counts.total).toBe(4);
    expect(r.counts.skipped).toBe(3);
    expect(r.counts.classified).toBe(1);
  });

  it('空 / 非法输入容错', () => {
    expect(planMemoryGc([], { now: NOW }).gcCandidates).toEqual([]);
    expect(planMemoryGc(null, { now: NOW }).gcCandidates).toEqual([]);
  });

  it('now 非法（NaN）时入口兜为有效时刻，不崩不全 keep', () => {
    const r = planMemoryGc([{ id: 'exp', salience: 1, expiresAt: 1000 }], { now: NaN });
    expect(r.buckets.expired).toEqual(['exp']); // expiresAt=1000(1970) 早于真实 now → expired
  });
});
