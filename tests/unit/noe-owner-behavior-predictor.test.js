import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { createExpectationLedger } from '../../src/cognition/NoeExpectationLedger.js';
import {
  createOwnerBehaviorPredictor,
  createOwnerInteractionWatcher,
  extractOwnerSubjects,
} from '../../src/cognition/NoeOwnerBehaviorPredictor.js';

const T0 = 1_780_000_000_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-owner-pred-'));
  initSqlite(join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

// 可推进的注入时钟（确定性，不依赖真实时间）
function makeClock(start = T0) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; return t; };
  now.set = (v) => { t = v; return t; };
  return now;
}

describe('extractOwnerSubjects 确定性主题/交办抽取（零 LLM）', () => {
  it('抽中文内容 bigram，滤掉功能字/停用词', () => {
    const r = extractOwnerSubjects('帮我看下卡牌战斗内核的觉醒系统', { maxTopics: 5 });
    expect(r.delegation).toBe(true);
    expect(r.topics).toContain('卡牌'); // 内容 bigram
    expect(r.topics).not.toContain('帮我'); // 停用词
    expect(r.topics).not.toContain('我看'); // 含功能字「我」
  });

  it('ascii 词整词入主题', () => {
    const r = extractOwnerSubjects('godot 移植先放放', { maxTopics: 3 });
    expect(r.topics).toContain('godot');
  });

  it('非交办句 delegation=false；maxTopics 限流；首个内容 bigram', () => {
    const r = extractOwnerSubjects('息刻这个项目的进度怎么样', { maxTopics: 1 });
    expect(r.delegation).toBe(false);
    expect(r.topics.length).toBe(1);
    expect(r.topics[0]).toBe('息刻');
  });

  it('显式 isDelegation 覆盖正则判断', () => {
    expect(extractOwnerSubjects('随便聊聊', { isDelegation: true }).delegation).toBe(true);
    expect(extractOwnerSubjects('帮我去做这件事', { isDelegation: false }).delegation).toBe(false);
  });

  it('空文本 → 空结果', () => {
    expect(extractOwnerSubjects('')).toEqual({ topics: [], delegation: false });
  });
});

describe('createOwnerBehaviorPredictor 立预测', () => {
  it('owner 提到项目 → 立 topic 预测（claim 内嵌稳定 token，source=owner_pred）', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const pred = createOwnerBehaviorPredictor({ ledger, now });
    const r = pred.observeOwnerInteraction({ text: '息刻的语音引导还要再打磨', isDelegation: false });
    expect(r.predicted).toBeGreaterThanOrEqual(1);
    expect(r.resolved).toBe(0);
    const opens = ledger.open({ limit: 10 });
    const topicEp = opens.find((o) => o.claim.includes('[owner-pred:topic:息刻]'));
    expect(topicEp).toBeTruthy();
    expect(topicEp.source).toBe('owner_pred');
    expect(topicEp.p).toBe(0.55);
    expect(topicEp.due_at).toBe(T0 + 2 * DAY);
  });

  it('owner 交办 → 额外立 followup 预测（强先验 + 短到期窗）', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const pred = createOwnerBehaviorPredictor({ ledger, now });
    const r = pred.observeOwnerInteraction({ text: '帮我去修一下登录崩溃' });
    // followup + topic（登录、崩溃 至少一个 topic）
    expect(r.predicted).toBeGreaterThanOrEqual(2);
    const opens = pred.openOwnerPredictions();
    const followup = opens.find((o) => o.claim.includes('[owner-pred:followup]'));
    expect(followup).toBeTruthy();
    expect(followup.p).toBe(0.75);
    expect(followup.due_at).toBe(T0 + 12 * HOUR);
  });

  it('同主题不重复入账（ledger 相似度去重兜底）', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const pred = createOwnerBehaviorPredictor({ ledger, now });
    pred.predictFromOwnerText('息刻怎么样了');
    now.advance(60_000);
    pred.predictFromOwnerText('息刻还要继续做');
    const opens = pred.openOwnerPredictions().filter((o) => o.claim.includes('topic:息刻'));
    expect(opens.length).toBe(1);
  });
});

describe('createOwnerBehaviorPredictor 结算进 Brier（owner 真实后续行为）', () => {
  it('topic 应验：后续 owner 又提到同主题 → resolve(1) → 进 Brier', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const pred = createOwnerBehaviorPredictor({ ledger, now });
    // 第一轮：立 topic 预测（isDelegation=false 只立 topic，便于断言 Brier）
    const p1 = pred.observeOwnerInteraction({ text: '卡牌战斗内核的觉醒系统先放放', isDelegation: false });
    expect(p1.predicted).toBeGreaterThanOrEqual(1);
    expect(ledger.brier().n).toBe(0); // 还没结算
    // 隔一会儿，owner 真的又提到「卡牌战斗内核」
    now.advance(3 * HOUR);
    const r = pred.observeOwnerInteraction({ text: '回来继续搞卡牌战斗内核吧', isDelegation: false });
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    const b = ledger.brier();
    expect(b.n).toBe(r.resolved); // 应验条数全进 Brier
    // 全部 topic 预测 p=0.55 应验 → 每条 brier=(0.55-1)^2=0.2025 → 均值四舍五入 0.202
    expect(b.brier).toBe(0.202);
  });

  it('followup 应验：交办后 owner 来要实测/回报 → resolve(1)', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const pred = createOwnerBehaviorPredictor({ ledger, now });
    pred.observeOwnerInteraction({ text: '帮我把性能 audit 跑一遍', isDelegation: true });
    now.advance(2 * HOUR);
    const r = pred.observeOwnerInteraction({ text: '刚才那个实测结果呢' });
    const followupResolved = pred.openOwnerPredictions().every((o) => !o.claim.includes('[owner-pred:followup]'));
    expect(followupResolved).toBe(true);
    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect(ledger.brier().n).toBeGreaterThanOrEqual(1);
  });

  it('followup 明确落空：owner 取消/不用测试 → resolve(0) 并触发 surprise 学习', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const harvestCalls = [];
    const pred = createOwnerBehaviorPredictor({
      ledger,
      now,
      goalSystem: { harvestSurprise: (arg) => { harvestCalls.push(arg); return 'surprise-goal-1'; } },
    });
    pred.observeOwnerInteraction({ text: '帮我把性能 audit 跑一遍', isDelegation: true });
    const followup = pred.openOwnerPredictions().find((o) => o.claim.includes('[owner-pred:followup]'));
    expect(followup).toBeTruthy();

    now.advance(2 * HOUR);
    const r = pred.observeOwnerInteraction({ text: '不用测试了，先取消这个任务' });

    expect(r.resolved).toBeGreaterThanOrEqual(1);
    expect(pred.openOwnerPredictions().every((o) => !o.claim.includes('[owner-pred:followup]'))).toBe(true);
    expect(ledger.brier()).toMatchObject({ n: 1, brier: 0.563 });
    expect(harvestCalls).toEqual([{ claim: followup.claim, surprise: 2, origin: 'owner_prediction' }]); // P1-C：owner followup 落空 = owner 真实负反馈
  });

  it('P1[0]（修三方审查 minor）：过老 followup(超 followupDueMs*2)遇无关 fail 词不被误结算落空(由 sweep 兜底)', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const harvestCalls = [];
    const pred = createOwnerBehaviorPredictor({ ledger, now, goalSystem: { harvestSurprise: (a) => { harvestCalls.push(a); return 'g1'; } } });
    pred.observeOwnerInteraction({ text: '帮我把性能 audit 跑一遍', isDelegation: true });
    expect(pred.openOwnerPredictions().some((o) => o.claim.includes('[owner-pred:followup]'))).toBe(true);
    // 过 25h(> followupDueMs 12h*2=24h)后说无关的 fail 话(指别的事)
    now.advance(25 * HOUR);
    pred.observeOwnerInteraction({ text: '算了，取消那个会议吧' });
    // 过老 followup 不被无关 fail 词结算落空，仍开放(等 sweep 过期兜底)；不误立假 surprise
    expect(pred.openOwnerPredictions().some((o) => o.claim.includes('[owner-pred:followup]'))).toBe(true);
    expect(harvestCalls).toHaveLength(0);
  });

  it('followup 失败信号优先：不用测试不被“测试”关键词误判为应验', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const pred = createOwnerBehaviorPredictor({ ledger, now });
    pred.observeOwnerInteraction({ text: '帮我把性能 audit 跑一遍', isDelegation: true });
    now.advance(HOUR);

    pred.observeOwnerInteraction({ text: '不用测试了，取消' });

    const history = ledger.history({ limit: 10 });
    const resolvedFollowup = history.find((row) => row.claim.includes('[owner-pred:followup]') && row.resolved_at);
    expect(resolvedFollowup).toBeTruthy();
    expect(resolvedFollowup.outcome).toBe(0);
  });

  it('先结算再预测：本轮新立的预测不会被本轮自己命中（无自我应验）', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const pred = createOwnerBehaviorPredictor({ ledger, now });
    // 同一句里复现主题——核心不变式：本轮新立的预测绝不被本轮自己结算（resolve 先于 predict）。
    const r = pred.observeOwnerInteraction({ text: '息刻啊，息刻这个项目继续' });
    expect(r.resolved).toBe(0);            // 本轮立的预测没被本轮结算（无自我应验）
    expect(r.predicted).toBeGreaterThanOrEqual(1);
    expect(ledger.brier().n).toBe(0);     // 没有任何结算落账
  });

  it('不相关后续不结算：owner 换了话题 → 旧 topic 预测留账（不强判 0）', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const pred = createOwnerBehaviorPredictor({ ledger, now });
    pred.observeOwnerInteraction({ text: '息刻先这样' });
    now.advance(HOUR);
    const r = pred.observeOwnerInteraction({ text: '今天天气不错' });
    expect(r.resolved).toBe(0);
    expect(ledger.brier().n).toBe(0); // 没强判落空
    expect(pred.openOwnerPredictions().some((o) => o.claim.includes('topic:息刻'))).toBe(true);
  });
});

describe('fail-open 与边界', () => {
  it('ledger 缺失 → 全 no-op，不抛错', () => {
    const pred = createOwnerBehaviorPredictor({ ledger: null });
    expect(pred.observeOwnerInteraction({ text: '帮我做点事' })).toEqual({
      resolved: 0, predicted: 0, resolvedIds: [], predictedIds: [],
    });
    expect(pred.openOwnerPredictions()).toEqual([]);
  });

  it('ledger 调用抛错 → 静默退回，不阻断', () => {
    const boom = {
      add: () => { throw new Error('add boom'); },
      open: () => { throw new Error('open boom'); },
      resolve: () => { throw new Error('resolve boom'); },
    };
    const pred = createOwnerBehaviorPredictor({ ledger: boom });
    const r = pred.observeOwnerInteraction({ text: '帮我去修一下登录崩溃' });
    expect(r).toEqual({ resolved: 0, predicted: 0, resolvedIds: [], predictedIds: [] });
  });

  it('空文本交互 → 不立预测不结算', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const pred = createOwnerBehaviorPredictor({ ledger, now });
    expect(pred.observeOwnerInteraction({ text: '   ' })).toEqual({
      resolved: 0, predicted: 0, resolvedIds: [], predictedIds: [],
    });
    expect(ledger.open({ limit: 10 }).length).toBe(0);
  });

  it('只动 owner_pred 账目：不结算别的 source 的预测', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const pred = createOwnerBehaviorPredictor({ ledger, now });
    // 注入一条非 owner_pred 预测，文本里也含「息刻」
    ledger.add({ claim: '反刍念头：息刻这周会上线', p: 0.6, dueAt: now() + DAY, source: 'reflection' });
    now.advance(HOUR);
    const r = pred.observeOwnerInteraction({ text: '息刻进度' });
    expect(r.resolved).toBe(0); // 没碰 reflection 那条
    expect(pred.openOwnerPredictions().length).toBeGreaterThanOrEqual(1); // 只看 owner_pred
    expect(ledger.open({ limit: 10 }).some((o) => o.source === 'reflection' && !o.resolved_at)).toBe(true);
  });
});

// 假时间线：recent({types:['interaction']}) 返回注入的经历（DESC，最近在前，与 EpisodicTimeline 一致）。
function makeTimeline(episodes = []) {
  return {
    recent: ({ types } = {}) => {
      const wanted = Array.isArray(types) && types.length ? new Set(types) : null;
      return episodes
        .filter((e) => !wanted || wanted.has(e.type))
        .slice()
        .sort((a, b) => b.ts - a.ts);
    },
  };
}
function makeKv() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => { m.set(k, v); }, _map: m };
}

describe('createOwnerInteractionWatcher 心跳驱动（读 interaction 经历喂 predictor）', () => {
  it('读新经历喂 predictor，水位线前移，重跑不重喂', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const predictor = createOwnerBehaviorPredictor({ ledger, now });
    const timeline = makeTimeline([
      { type: 'interaction', ts: T0 + 1000, summary: '息刻的睡眠模块还要打磨' },
      { type: 'interaction', ts: T0 + 2000, summary: '回头继续搞息刻吧' }, // 复现息刻 → 应结算第一条
    ]);
    const kv = makeKv();
    const w = createOwnerInteractionWatcher({ timeline, predictor, kv });
    const r1 = w.tick();
    expect(r1.observed).toBe(2);
    expect(r1.predicted).toBeGreaterThanOrEqual(1);
    expect(r1.resolved).toBeGreaterThanOrEqual(1); // 第二条复现息刻结算了第一条
    expect(w.readWatermark()).toBe(T0 + 2000);
    // 无新经历 → 第二跳零观察
    const r2 = w.tick();
    expect(r2.observed).toBe(0);
    expect(r2.scanned).toBe(0);
  });

  it('跳过 Noe 自己写的留痕（防自说自话），但交办自留痕仍当 owner 信号', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const predictor = createOwnerBehaviorPredictor({ ledger, now });
    const timeline = makeTimeline([
      { type: 'interaction', ts: T0 + 1000, summary: '主人发出显式记忆动作，动作桥已处理。' }, // 自留痕 → skip
      { type: 'interaction', ts: T0 + 2000, summary: '主人交办我去办：把性能 audit 跑一遍，我接下了' }, // 交办自留痕 → 当 owner 信号
    ]);
    const kv = makeKv();
    const w = createOwnerInteractionWatcher({ timeline, predictor, kv });
    const r = w.tick();
    expect(r.skipped).toBe(1);  // 第一条被跳过
    expect(r.observed).toBe(1); // 只有交办那条算观察
    // 交办那条应立 followup 预测
    expect(predictor.openOwnerPredictions().some((o) => o.claim.includes('[owner-pred:followup]'))).toBe(true);
  });

  it('delegationHint 命中 → 该经历按交办处理（立 followup）', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const predictor = createOwnerBehaviorPredictor({ ledger, now });
    const timeline = makeTimeline([
      { type: 'interaction', ts: T0 + 1000, summary: '帮我把登录页重写一下' },
    ]);
    const w = createOwnerInteractionWatcher({ timeline, predictor, kv: makeKv() });
    w.tick();
    expect(predictor.openOwnerPredictions().some((o) => o.claim.includes('[owner-pred:followup]'))).toBe(true);
  });

  it('maxPerTick 限流：一跳最多喂 N 条，水位线只前移到已处理的最大 ts', () => {
    const now = makeClock();
    const ledger = createExpectationLedger({ now });
    const predictor = createOwnerBehaviorPredictor({ ledger, now });
    const eps = [];
    for (let i = 1; i <= 5; i += 1) eps.push({ type: 'interaction', ts: T0 + i * 1000, summary: `话题${i}号项目继续` });
    const kv = makeKv();
    const w = createOwnerInteractionWatcher({ timeline: makeTimeline(eps), predictor, kv, maxPerTick: 2 });
    const r = w.tick();
    expect(r.observed).toBe(2);
    expect(w.readWatermark()).toBe(T0 + 2000); // 只前移到第 2 条
  });

  it('fail-open：timeline/predictor 缺失 → disabled，不抛错', () => {
    expect(createOwnerInteractionWatcher({ timeline: null, predictor: {}, kv: makeKv() }).tick().reason).toBe('disabled');
    expect(createOwnerInteractionWatcher({ timeline: makeTimeline([]), predictor: null, kv: makeKv() }).tick().reason).toBe('disabled');
  });

  it('timeline.recent 抛错 → 静默零观察，不抛错', () => {
    const predictor = createOwnerBehaviorPredictor({ ledger: createExpectationLedger({}) });
    const boomTimeline = { recent: () => { throw new Error('timeline boom'); } };
    const w = createOwnerInteractionWatcher({ timeline: boomTimeline, predictor, kv: makeKv() });
    expect(() => w.tick()).not.toThrow();
    expect(w.tick().observed).toBe(0);
  });
});
