import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { createExpectationLedger, extractExpectations } from '../../src/cognition/NoeExpectationLedger.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-exp-'));
  initSqlite(join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_780_000_000_000;

describe('extractExpectations 确定性预测抽取（零 LLM）', () => {
  it('时间词+情态词 → 预测；情态词定 p；时间词定 due', () => {
    const out = extractExpectations('明天主人应该会继续做卡牌游戏。', { now: T0 });
    expect(out.length).toBe(1);
    expect(out[0].p).toBe(0.75);
    expect(out[0].dueAt).toBe(T0 + 36 * 3600_000);
    const weak = extractExpectations('下周大概要下雨了。', { now: T0 });
    expect(weak[0].p).toBe(0.6);
  });

  it('分钟/小时级时间词 → 短期 dueAt，支持数字、中文数字和模糊短时词', () => {
    expect(extractExpectations('10 分钟后应该会出现新的意识流。', { now: T0 })[0].dueAt).toBe(T0 + 10 * 60_000);
    expect(extractExpectations('十五分钟后主人应该会看到结果。', { now: T0 })[0].dueAt).toBe(T0 + 15 * 60_000);
    expect(extractExpectations('半小时内应该会完成这次验证。', { now: T0 })[0].dueAt).toBe(T0 + 30 * 60_000);
    expect(extractExpectations('2 小时内应该会跑完验证。', { now: T0 })[0].dueAt).toBe(T0 + 2 * 3600_000);
    expect(extractExpectations('72 小时内应该会完成迁移。', { now: T0 })[0].dueAt).toBe(T0 + 72 * 3600_000);
    expect(extractExpectations('3 天内应该会完成迁移。', { now: T0 })[0].dueAt).toBe(T0 + 3 * 86400_000);
    expect(extractExpectations('48 小时内我能写出至少 3 个逻辑链草图。', { now: T0 })[0].dueAt).toBe(T0 + 48 * 3600_000);
    expect(extractExpectations('我将在 10 分钟内完成第一次纸笔记录。', { now: T0 })[0].dueAt).toBe(T0 + 10 * 60_000);
    expect(extractExpectations('我马上应该会恢复反刍。', { now: T0 })[0].dueAt).toBe(T0 + 5 * 60_000);
    expect(extractExpectations('等会儿大概会有新结果。', { now: T0 })[0].dueAt).toBe(T0 + 15 * 60_000);
    expect(extractExpectations('通过进行 5 分钟步行应该能打破状态。', { now: T0 }).length).toBe(0);
  });

  it('疑问句/缺时间词/缺情态词/超长 都不算预测（宁缺勿滥）', () => {
    expect(extractExpectations('明天主人会继续吗？', { now: T0 }).length).toBe(0);
    expect(extractExpectations('主人应该多休息。', { now: T0 }).length).toBe(0);
    expect(extractExpectations('明天见。', { now: T0 }).length).toBe(0);
    expect(extractExpectations(`明天${'很长'.repeat(60)}会发生。`, { now: T0 }).length).toBe(0);
  });

  it('每段文本最多 2 条', () => {
    const t = '明天会下雨。今晚应该会早睡。下周可能会上线。';
    expect(extractExpectations(t, { now: T0 }).length).toBe(2);
  });
});

describe('NoeExpectationLedger 期望账本', () => {
  it('入账 + 相似未结算项去重 + p 钳制', () => {
    let t = T0;
    const led = createExpectationLedger({ now: () => t });
    const id1 = led.add({ claim: '明天主人会继续做种誓项目', p: 1.5 });
    expect(id1).toBeGreaterThan(0);
    expect(led.open()[0].p).toBe(0.99); // 钳制到 0.99（防 -log2(0)）
    const dup = led.add({ claim: '明天主人会继续做种誓项目呢' });
    expect(dup).toBe(null); // 过似不重复入账
    expect(led.open().length).toBe(1);
  });

  it('resolve 应验/落空：surprise = -log2(p_实际)，高自信落空惊奇大', () => {
    let t = T0;
    const led = createExpectationLedger({ now: () => t });
    const hi = led.add({ claim: '明天肯定会发布新版本', p: 0.9, dueAt: T0 + 1000 });
    const lo = led.add({ claim: '下周可能去爬山走走', p: 0.6, dueAt: T0 + 1000 });
    t += 2000;
    const rHit = led.resolve(lo, 1, t);
    const rMiss = led.resolve(hi, 0, t);
    expect(rHit.surprise).toBeCloseTo(-Math.log2(0.6), 3);
    expect(rMiss.surprise).toBeCloseTo(-Math.log2(0.1), 3); // 0.9 自信落空 → 惊奇 ~3.32 bit
    expect(rMiss.surprise).toBeGreaterThan(rHit.surprise);
    expect(led.resolve(hi, 1, t)).toBe(null); // 已结算不能重复结算
  });

  it('判不了（outcome=null）：出账但不计分', () => {
    const led = createExpectationLedger({ now: () => T0 });
    const id = led.add({ claim: '今晚会有灵感冒出来', p: 0.7, dueAt: T0 + 1 });
    led.resolve(id, null, T0 + 10);
    expect(led.open().length).toBe(0);
    expect(led.brier().n).toBe(0);
  });

  it('sweep：逾期 7 天没人裁决自动 unresolvable 出账', () => {
    let t = T0;
    const led = createExpectationLedger({ now: () => t });
    led.add({ claim: '明天会下雨吧大概', p: 0.6, dueAt: T0 + 1000 });
    expect(led.sweep(T0 + 2 * 86400_000)).toBe(0); // 才过 2 天：留着等裁决
    expect(led.sweep(T0 + 9 * 86400_000)).toBe(1); // 过 9 天：出账
    expect(led.open().length).toBe(0);
    expect(led.brier().n).toBe(0); // 不计分
  });

  it('P2-F2：resolve 记 resolved_by + calibration 按 holdout 分层（防自评当客观校准）', () => {
    let t = T0;
    const led = createExpectationLedger({ now: () => t });
    const a = led.add({ claim: '预测一会有结果A', p: 0.6, dueAt: T0 + 100 });
    const b = led.add({ claim: '预测一会有结果B', p: 0.7, dueAt: T0 + 100 });
    t += 200;
    expect(led.resolve(a, 1, t).resolved_by).toBe('auto'); // 默认=本地脑自评
    expect(led.resolve(b, 1, t, 'owner').resolved_by).toBe('owner'); // owner holdout 旁证
    const cal = led.calibration();
    expect(cal.n).toBe(2);
    expect(cal.provenance.ownerHoldoutN).toBe(1);
    expect(cal.provenance.autoSelfN).toBe(1);
    expect(cal.provenance.selfEvaluated).toBe(false); // 有 owner holdout
    expect(cal.provenance.ownerBrier).not.toBeNull();
  });

  it('P2[1]（修三方审查 minor）：单票漏洞——owner holdout 占比 <20% 仍标 selfEvaluated=true 保留警示(防 Goodhart)', () => {
    const led = createExpectationLedger({ now: () => T0 });
    // 1 条 owner 裁决 + 5 条 auto 自评（owner 占比 1/6≈0.17 < 0.2），头条 Brier 仍自评主导
    const claims = ['股市明天会涨', '今晚会下雨', '会议将取消', '项目能按时完成', '客户会满意', '测试将通过'];
    const ids = claims.map((c) => led.add({ claim: c, p: 0.8, dueAt: T0 + 1 }));
    led.resolve(ids[0], 1, T0 + 10, 'owner');
    for (let i = 1; i < ids.length; i++) led.resolve(ids[i], 1, T0 + 10, 'auto');
    const cal = led.calibration();
    expect(cal.provenance.ownerHoldoutN).toBe(1);
    expect(cal.provenance.autoSelfN).toBe(5);
    expect(cal.provenance.selfEvaluated).toBe(true); // 占比 <20%，单票不关警示
  });

  it('P2-F2：全自评 → selfEvaluated=true（看板须警示非客观校准）', () => {
    let t = T0;
    const led = createExpectationLedger({ now: () => t });
    const id = led.add({ claim: '全自评的预测', p: 0.8, dueAt: T0 + 100 });
    t += 200;
    led.resolve(id, 1, t); // 默认 auto
    const cal = led.calibration();
    expect(cal.provenance.selfEvaluated).toBe(true);
    expect(cal.provenance.ownerHoldoutN).toBe(0);
  });

  it('CAL-10：source=step_prediction 的伪预测不污染 brier/calibration（固化口径防回归）', () => {
    const led = createExpectationLedger({ now: () => T0 });
    const real = led.add({ claim: '真实预测会发生某事', p: 0.8, dueAt: T0 + 1 });
    const fake = led.add({ claim: '完成步骤：部署某服务', p: 0.8, dueAt: T0 + 1, source: 'step_prediction' });
    led.resolve(real, 1, T0 + 10);
    led.resolve(fake, 0, T0 + 10); // 伪预测落空，但 step_prediction 不该进 Brier（bridge 旁路登记的非真预测）
    expect(led.brier().n).toBe(1); // 只算真预测，step_prediction 被排除
    expect(led.calibration().n).toBe(1); // calibration 同口径，防未来改 SQL 漏掉过滤
  });

  it('P2-C（修三方审查 minor）：旧/隔离库无 source 列时 brier/calibration 仍出数，不因 source!= 过滤 SQL 抛错静默清零成 n:0', () => {
    const db = new Database(':memory:');
    // 模拟旧/隔离库 schema：无 source 列、无 resolved_by 列
    db.exec('CREATE TABLE noe_expectations (id INTEGER PRIMARY KEY, p REAL, outcome INTEGER, surprise REAL, resolved_at INTEGER, created_at INTEGER)');
    const ins = db.prepare('INSERT INTO noe_expectations (p,outcome,resolved_at,created_at) VALUES (?,?,?,?)');
    ins.run(0.9, 1, T0, T0); // (0.9-1)^2=0.01
    ins.run(0.2, 0, T0, T0); // (0.2-0)^2=0.04
    const led = createExpectationLedger({ db });
    const b = led.brier({ sinceTs: 0 });
    expect(b.n).toBe(2); // 缺 source 列退化不过滤仍出 Brier（修复前 source!='step_prediction' SQL 会抛错被吞成 n:0）
    expect(b.brier).toBeCloseTo((0.01 + 0.04) / 2, 3);
    const cal = led.calibration({ sinceTs: 0 });
    expect(cal.n).toBe(2); // calibration 同样不清零
    expect(cal.provenance.selfEvaluated).toBe(true); // 无 resolved_by 列 → 全自评分层
    db.close();
  });

  it('brier + calibrationNote：命中率与分数符合手算', () => {
    let t = T0;
    const led = createExpectationLedger({ now: () => t });
    const a = led.add({ claim: '明天肯定继续写代码', p: 0.9, dueAt: T0 + 1 });
    const b = led.add({ claim: '下周可能会去公园逛', p: 0.6, dueAt: T0 + 1 });
    led.resolve(a, 1, T0 + 10); // (0.9-1)² = 0.01
    led.resolve(b, 0, T0 + 10); // (0.6-0)² = 0.36
    const br = led.brier();
    expect(br.n).toBe(2);
    expect(br.brier).toBeCloseTo((0.01 + 0.36) / 2, 3);
    expect(br.confidentN).toBe(1);
    expect(br.confidentHit).toBe(1);
    const note = led.calibrationNote();
    expect(note).toContain('2 个判断');
    expect(note).toContain('Brier');
  });

  it('harvestFromText：从念头文本一条龙抽取入账', () => {
    const led = createExpectationLedger({ now: () => T0 });
    const n = led.harvestFromText('我在想，明天主人应该会接着调那个战斗系统。', { source: 'thought' });
    expect(n).toBe(1);
    const row = led.open()[0];
    expect(row.source).toBe('thought');
    expect(row.claim).toContain('战斗系统');
  });

  it('空账本：brier n=0、calibrationNote 空串、history 空数组', () => {
    const led = createExpectationLedger({ now: () => T0 });
    expect(led.brier().n).toBe(0);
    expect(led.calibrationNote()).toBe('');
    expect(led.history()).toEqual([]);
  });

  it('repairDueAtFromClaim：只把旧账本中过晚的短期 dueAt 往前修', () => {
    const led = createExpectationLedger({ now: () => T0 });
    const short = led.add({ claim: '10 分钟内应该会出现新的意识流', p: 0.7, dueAt: T0 + 3 * 86400_000 });
    const alreadySooner = led.add({ claim: '3 天内应该会完成迁移', p: 0.7, dueAt: T0 + 2 * 86400_000 });
    const dry = led.repairDueAtFromClaim();
    expect(dry).toMatchObject({ ok: true, dryRun: true, repaired: 1 });
    expect(dry.updates[0]).toMatchObject({ id: short, oldDueAt: T0 + 3 * 86400_000, newDueAt: T0 + 10 * 60_000 });
    expect(led.open().find((row) => row.id === short).due_at).toBe(T0 + 3 * 86400_000);
    const applied = led.repairDueAtFromClaim({ dryRun: false });
    expect(applied.repaired).toBe(1);
    expect(led.open().find((row) => row.id === short).due_at).toBe(T0 + 10 * 60_000);
    expect(led.open().find((row) => row.id === alreadySooner).due_at).toBe(T0 + 2 * 86400_000);
  });
});
