import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { createAffectEngine, AFFECT_BASELINE, affectLabel, EPISODE_APPRAISAL } from '../../src/cognition/NoeAffectEngine.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-affect-'));
  initSqlite(join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_780_000_000_000;

function makeEngine(extra = {}) {
  let t = T0;
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const engine = createAffectEngine({ now: clock.now, ...extra });
  return { engine, clock };
}

describe('NoeAffectEngine 情感连续性', () => {
  it('初始即基线；正向评估抬升 v/a，且不越界（clamp）', () => {
    const { engine } = makeEngine();
    const s0 = engine.snapshot();
    expect(s0.v).toBeCloseTo(AFFECT_BASELINE.v, 5);
    engine.appraise({ goalCongruence: 1, novelty: 1, socialWarmth: 1, agency: 1 });
    const s1 = engine.snapshot();
    expect(s1.v).toBeGreaterThan(s0.v);
    expect(s1.a).toBeGreaterThan(s0.a);
    expect(s1.d).toBeGreaterThan(s0.d);
    for (let i = 0; i < 50; i++) engine.appraise({ goalCongruence: 1, socialWarmth: 1 });
    const s2 = engine.snapshot();
    expect(s2.v).toBeLessThanOrEqual(1);
    expect(s2.a).toBeLessThanOrEqual(1);
  });

  it('双时标衰减：情绪 90min 时标向心境回落，心境向基线慢回', () => {
    const { engine, clock } = makeEngine();
    engine.appraise({ goalCongruence: 1, novelty: 1, socialWarmth: 1 }); // 冲高
    const peak = engine.snapshot();
    clock.advance(90 * 60_000); // 一个 τe
    const after1 = engine.snapshot();
    // 情绪应明显回落（向心境收敛 ~63%）
    expect(peak.v - after1.v).toBeGreaterThan((peak.v - peak.mood.v) * 0.5);
    clock.advance(24 * 3600_000); // 一天后
    const after2 = engine.snapshot();
    expect(Math.abs(after2.v - after2.mood.v)).toBeLessThan(0.02); // 情绪几乎贴住心境
    expect(after2.mood.v).toBeGreaterThan(AFFECT_BASELINE.v); // 心境仍带余温（τm=7天，未清零）
  });

  it('重启水合：新引擎从最后快照接续并按停机时长回落——心情没清零', () => {
    const { engine, clock } = makeEngine();
    engine.appraise({ goalCongruence: 1, socialWarmth: 1, novelty: 0.8 });
    const beforeRestart = engine.snapshot();
    expect(beforeRestart.v).toBeGreaterThan(AFFECT_BASELINE.v + 0.2);

    // "重启"：同一库新建引擎，时钟前进 3 小时（停机）
    clock.advance(3 * 3600_000);
    const engine2 = createAffectEngine({ now: clock.now });
    const after = engine2.snapshot();
    expect(after.v).toBeLessThan(beforeRestart.v);            // 回落了
    expect(after.mood.v).toBeGreaterThan(AFFECT_BASELINE.v);  // 但心境余温还在（没清零）
  });

  it('tick 消化时间线新情景：interaction 暖、inner_monologue 零增量（防反刍自激）', () => {
    let t = T0;
    const episodes = [
      { id: 1, ts: T0 + 1000, type: 'interaction', summary: '和主人聊了天' },
      { id: 2, ts: T0 + 2000, type: 'inner_monologue', summary: '我在想……' },
    ];
    const timeline = { recent: ({ sinceTs = 0 }) => episodes.filter((e) => e.ts >= sinceTs) };
    const engine = createAffectEngine({ now: () => t, timeline });
    const before = engine.snapshot();
    t += 60_000;
    const r1 = engine.tick();
    expect(r1.consumed).toBe(1); // 只有 interaction 进评估，念头不算
    expect(engine.snapshot().v).toBeGreaterThan(before.v);

    // 水位线推进：再 tick 不重复消化
    t += 60_000;
    const r2 = engine.tick();
    expect(r2.consumed).toBe(0);
  });

  it('tick 消化负向情景：setback 让 v 跌破基线（真实失败→真沮丧，治"只升不降必撞顶"）', () => {
    let t = T0;
    const episodes = [
      { id: 1, ts: T0 + 1000, type: 'setback', summary: '我为目标动了手→被安全门拦下' },
    ];
    const timeline = { recent: ({ sinceTs = 0 }) => episodes.filter((e) => e.ts >= sinceTs) };
    const engine = createAffectEngine({ now: () => t, timeline });
    const before = engine.snapshot();
    expect(before.v).toBeCloseTo(AFFECT_BASELINE.v, 5);
    t += 60_000;
    const r = engine.tick();
    expect(r.consumed).toBe(1);                          // setback 真进了评估（不像 inner_monologue 被跳过）
    expect(engine.snapshot().v).toBeLessThan(before.v);  // v 真的跌了——现实能把心情拉下来
  });

  it('tick 消化 correction：主人纠正让 v 跌（gc -0.3），区别于纯 setback 还带 socialWarmth 温度', () => {
    let t = T0;
    const episodes = [
      { id: 1, ts: T0 + 1000, type: 'correction', summary: '主人说我判错了' },
    ];
    const timeline = { recent: ({ sinceTs = 0 }) => episodes.filter((e) => e.ts >= sinceTs) };
    const engine = createAffectEngine({ now: () => t, timeline });
    const before = engine.snapshot();
    t += 60_000;
    const r = engine.tick();
    expect(r.consumed).toBe(1);                          // correction 进了评估（删 EPISODE_APPRAISAL.correction 则 consumed=0，此测试转红）
    expect(engine.snapshot().v).toBeLessThan(before.v);  // 净 dv=0.30*(-0.3)+0.20*0.2=-0.05，v 跌
  });

  it('连续真实失败把 v 压到 0.3 以下（阶段0出口指标：让现实能扇 Noe 一巴掌，对治 94% 顶格）', () => {
    const { engine } = makeEngine();
    for (let i = 0; i < 4; i++) engine.appraise({ goalCongruence: -0.5 }, { cause: 'act_failed' });
    expect(engine.snapshot().v).toBeLessThan(0.3);       // 1 次即破 0.3（dv=-0.15，0.15→0），4 次是留足余量
    expect(engine.snapshot().v).toBeLessThan(0);         // 2 次即进负值；4 次稳到约 -0.45
  });

  it('P4 step0：agency 真传 → dominance 离开基线（治"掌控维恒 0.1 假情绪"）', () => {
    // 用同一引擎前后 delta 断言（避免多引擎共享同库 hydrate 交叉污染）：
    // 高 agency（成功掌控）→ d 升；不传 agency（中性 0.5）→ d 不动；低 agency（失控）→ d 跌。
    const { engine } = makeEngine();
    const d0 = engine.snapshot().d;
    expect(d0).toBeCloseTo(AFFECT_BASELINE.d, 5);

    engine.appraise({ agency: 0.9 }, { cause: 'success', ts: T0 }); // dd=0.20*(0.9-0.5)=+0.08
    const dUp = engine.snapshot().d;
    expect(dUp).toBeGreaterThan(d0);                                 // 成功真推高掌控

    engine.appraise({ goalCongruence: 0.5 }, { cause: 'no_agency', ts: T0 }); // 缺省 agency=0.5 → dd=0
    expect(engine.snapshot().d).toBeCloseTo(dUp, 5);                 // 不传 agency 时 d 不动（旧行为=假情绪根因）

    engine.appraise({ agency: 0.1 }, { cause: 'failure', ts: T0 }); // dd=0.20*(0.1-0.5)=-0.08
    expect(engine.snapshot().d).toBeLessThan(dUp);                   // 失控真拉低掌控
  });

  it('P4 step0：EPISODE_APPRAISAL 成败类带 agency → tick 消化后 dominance 真随处境动（前后 delta）', () => {
    // milestone（成功，agency 0.85）→ d 升；setback（失败，agency 0.15）→ d 跌。各用独立引擎 + 前后 delta。
    let t = T0;
    const mileTl = { recent: ({ sinceTs = 0 }) => [{ id: 1, ts: T0 + 1000, type: 'milestone', summary: '我把一件事做成了' }].filter((e) => e.ts >= sinceTs) };
    const engUp = createAffectEngine({ now: () => t, timeline: mileTl });
    const beforeUp = engUp.snapshot().d;
    t += 60_000;
    engUp.tick();
    expect(engUp.snapshot().d).toBeGreaterThan(beforeUp); // 成功推高掌控

    // setback 用单独 helper 引擎：直接喂 EPISODE_APPRAISAL.setback（=tick 单条 setback 的等价评估），前后 delta 自洽。
    const { engine: engDown, clock } = makeEngine();
    const beforeDown = engDown.snapshot().d;
    engDown.appraise(EPISODE_APPRAISAL.setback, { cause: 'episode:setback', ts: clock.now() });
    expect(engDown.snapshot().d).toBeLessThan(beforeDown); // 失败拉低掌控（失控感）
  });

  it('P6-F 信号契约：内心独白不入 VAD，RuminationGuard 不能消费过滤后的 VAD', () => {
    const { engine } = makeEngine();
    expect(engine.isInnerEmotionNeutralized()).toBe(true);
    expect(engine.getSignalContract()).toMatchObject({
      innerEmotionNeutralized: true,
      affectConsumesInnerMonologue: false,
      ruminationGuardShouldReadVad: false,
      ruminationGuardSignalSource: 'raw_timeline',
    });

    const vadForGuard = engine.getVadForConsumers({ consumer: 'rumination_guard' });
    expect(vadForGuard.allowed).toBe(false);
    expect(vadForGuard.includesInnerMonologue).toBe(false);

    const vadForPrompt = engine.getVadForConsumers({ consumer: 'inner_prompt' });
    expect(vadForPrompt.allowed).toBe(true);
    expect(vadForPrompt.includesInnerMonologue).toBe(false);
  });

  it('感受词元：一行中文 + 含心情词；标签映射符合象限', () => {
    const { engine } = makeEngine();
    const line = engine.renderFeelingTokens();
    expect(line).toContain('心情');
    expect(line).toContain('愉悦');
    expect(affectLabel({ v: 0.5, a: 0.8 })).toBe('振奋');
    expect(affectLabel({ v: 0.5, a: 0.2 })).toBe('安暖');
    expect(affectLabel({ v: -0.5, a: 0.8 })).toBe('烦躁');
    expect(affectLabel({ v: -0.5, a: 0.2 })).toBe('低落');
    expect(affectLabel({ v: 0, a: 0.3 })).toBe('平静');
  });

  it('history 返回快照曲线（透视页数据源）', () => {
    const { engine } = makeEngine();
    engine.appraise({ socialWarmth: 1 }, { cause: 'hug' });
    engine.tick();
    const rows = engine.history({ limit: 10 });
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.some((r) => r.cause === 'hug')).toBe(true);
  });

  it('timeline 缺失/抛错 → tick 仍完成衰减与快照（fail-open）', () => {
    const broken = { recent: () => { throw new Error('炸'); } };
    let t = T0;
    const engine = createAffectEngine({ now: () => t, timeline: broken });
    t += 60_000;
    const r = engine.tick();
    expect(r.ok).toBe(true);
    expect(r.consumed).toBe(0);
  });
});
