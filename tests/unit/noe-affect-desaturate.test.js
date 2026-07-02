import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { createAffectEngine } from '../../src/cognition/NoeAffectEngine.js';

// rank6 去饱和：env NOE_AFFECT_DESATURATE 门控。OFF=原行为（持续正向种子把 VAD 焊死天花板，复现 bug）；
// ON=朝边界增量随剩余空间衰减，VAD 渐近边界但永不焊死；反向（回落/负向）不受影响。

const FIXED_TS = 1_000_000;

function pump(engine, n, seed) {
  for (let i = 0; i < n; i += 1) engine.appraise(seed, { ts: FIXED_TS });
}

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noe-affect-desat-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('NoeAffectEngine 去饱和（rank6）', () => {
  it('OFF（默认）：连续强正向 appraise 把 v 焊死到天花板 1（复现 bug）', () => {
    const e = createAffectEngine({ desaturate: false, now: () => FIXED_TS });
    pump(e, 50, { goalCongruence: 1, socialWarmth: 1 });
    expect(e.snapshot().v).toBe(1);
    expect(e.snapshot().a).toBe(1);
  });

  it('ON：连续强正向 appraise → v 明显正向但渐近、永不焊死天花板', () => {
    const e = createAffectEngine({ desaturate: true, now: () => FIXED_TS });
    pump(e, 50, { goalCongruence: 1, socialWarmth: 1 });
    const { v, a } = e.snapshot();
    expect(v).toBeGreaterThan(0.4); // 仍明显愉悦
    expect(v).toBeLessThan(1);      // 但没焊死（有信息量）
    expect(a).toBeLessThan(1);
  });

  it('ON：负向/回落方向不受去饱和削弱（仍能把高 v 拉下来）', () => {
    const e = createAffectEngine({ desaturate: true, now: () => FIXED_TS });
    pump(e, 10, { goalCongruence: 1, socialWarmth: 1 });
    const high = e.snapshot().v;
    e.appraise({ goalCongruence: -1, socialWarmth: -1 }, { ts: FIXED_TS });
    expect(e.snapshot().v).toBeLessThan(high);
  });

  it('ON：单次正向增量在中段与原行为接近（不破坏正常情感反应）', () => {
    const off = createAffectEngine({ desaturate: false, now: () => FIXED_TS });
    const on = createAffectEngine({ desaturate: true, now: () => FIXED_TS });
    const seed = { goalCongruence: 0.5 };
    off.appraise(seed, { ts: FIXED_TS });
    on.appraise(seed, { ts: FIXED_TS });
    // 基线附近（远离边界）去饱和缩放接近 1×，两者 v 差异很小
    expect(Math.abs(on.snapshot().v - off.snapshot().v)).toBeLessThan(0.12);
  });

  it('ON：重启水合到旧饱和状态时自动恢复到非饱和区间并持久化新 tick', () => {
    const db = getDb();
    db.prepare('INSERT INTO noe_affect(ts, v, a, d, mood_v, mood_a, mood_d, cause) VALUES (?,?,?,?,?,?,?,?)')
      .run(FIXED_TS - 1000, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 'legacy_saturated');

    const e = createAffectEngine({ desaturate: true, now: () => FIXED_TS });
    const hydrated = e.snapshot();
    expect(hydrated.v).toBeLessThan(0.95);
    expect(hydrated.a).toBeLessThan(0.95);
    expect(hydrated.d).toBeLessThan(0.95);
    expect(hydrated.mood.a).toBeLessThanOrEqual(0.82);

    e.tick({ ts: FIXED_TS });
    const latest = db.prepare('SELECT v, a, d, mood_a, cause FROM noe_affect ORDER BY id DESC LIMIT 1').get();
    expect(latest.cause).toBe('tick');
    expect(latest.v).toBeLessThan(0.95);
    expect(latest.a).toBeLessThan(0.95);
    expect(latest.d).toBeLessThan(0.95);
    expect(latest.mood_a).toBeLessThanOrEqual(0.82);
  });

  it('ON：恢复带内遇到强高唤醒事件也不会重新持久化为饱和快照', () => {
    const db = getDb();
    db.prepare('INSERT INTO noe_affect(ts, v, a, d, mood_v, mood_a, mood_d, cause) VALUES (?,?,?,?,?,?,?,?)')
      .run(FIXED_TS - 1000, 0.99, 0.99, 0.1, 0.99, 0.99, 0.1, 'legacy_saturated');

    const e = createAffectEngine({ desaturate: true, now: () => FIXED_TS });
    e.appraise({ goalCongruence: 1, novelty: 1, socialWarmth: 1, agency: 1 }, {
      ts: FIXED_TS,
      cause: 'strong_after_recovery',
    });

    const latest = db.prepare('SELECT v, a, d, mood_a, cause FROM noe_affect ORDER BY id DESC LIMIT 1').get();
    expect(latest.cause).toBe('strong_after_recovery');
    expect(latest.v).toBeLessThan(0.95);
    expect(latest.a).toBeLessThan(0.95);
    expect(latest.d).toBeLessThan(0.95);
    expect(latest.mood_a).toBeLessThanOrEqual(0.82);
  });

  it('ON：连续多次水合重启仍保持恢复上限', () => {
    const db = getDb();
    db.prepare('INSERT INTO noe_affect(ts, v, a, d, mood_v, mood_a, mood_d, cause) VALUES (?,?,?,?,?,?,?,?)')
      .run(FIXED_TS - 1000, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 'legacy_saturated');

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const ts = FIXED_TS + cycle * 1000;
      const e = createAffectEngine({ desaturate: true, now: () => ts });
      const hydrated = e.snapshot();
      expect(hydrated.v).toBeLessThan(0.95);
      expect(hydrated.a).toBeLessThan(0.95);
      expect(hydrated.d).toBeLessThan(0.95);
      e.appraise({ goalCongruence: 1, novelty: 1, socialWarmth: 1 }, {
        ts,
        cause: `cycle_${cycle}`,
      });
      const latest = db.prepare('SELECT v, a, d, mood_a, cause FROM noe_affect ORDER BY id DESC LIMIT 1').get();
      expect(latest.cause).toBe(`cycle_${cycle}`);
      expect(latest.v).toBeLessThan(0.95);
      expect(latest.a).toBeLessThan(0.95);
      expect(latest.d).toBeLessThan(0.95);
      expect(latest.mood_a).toBeLessThanOrEqual(0.82);
    }
  });
});

describe('NoeAffectEngine 情感健康自检 affectHealth（rank6 饱和告警）', () => {
  it('焊死天花板(OFF) → saturated=true，标出维度 + 建议开去饱和', () => {
    const e = createAffectEngine({ desaturate: false, now: () => FIXED_TS });
    pump(e, 50, { goalCongruence: 1, socialWarmth: 1 });
    const h = e.affectHealth();
    expect(h.saturated).toBe(true);
    expect(h.saturatedDimensions).toContain('valence');
    expect(h.saturatedDimensions).toContain('arousal');
    expect(h.desaturateEnabled).toBe(false);
    expect(h.note).toContain('去饱和');
  });

  it('去饱和 ON → 标记 desaturateEnabled=true，note 不再建议开', () => {
    const e = createAffectEngine({ desaturate: true, now: () => FIXED_TS });
    pump(e, 50, { goalCongruence: 1, socialWarmth: 1 });
    const h = e.affectHealth();
    expect(h.desaturateEnabled).toBe(true);
    expect(h.note).not.toContain('建议开');
  });

  it('健康分化（少量评估）→ saturated=false + 健康文案', () => {
    const e = createAffectEngine({ desaturate: false, now: () => FIXED_TS });
    e.appraise({ goalCongruence: 0.3 }, { ts: FIXED_TS });
    const h = e.affectHealth();
    expect(h.saturated).toBe(false);
    expect(h.note).toBe('情感分化健康');
  });
});
