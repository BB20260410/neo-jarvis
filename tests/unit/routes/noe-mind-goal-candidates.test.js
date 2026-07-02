// @ts-nocheck
import { describe, it, expect, afterEach } from 'vitest';
import { registerNoeMindRoutes } from '../../../src/server/routes/noeMind.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const m of ['get', 'post']) app[m] = (path, ...h) => routes.push({ method: m, path, handlers: h });
  return { app, routes };
}
function makeRes() {
  return { statusCode: 200, payload: undefined, status(c) { this.statusCode = c; return this; }, json(b) { this.payload = b; return this; } };
}
const call = (routes, method, path, req = {}) => {
  const r = routes.find((x) => x.method === method && x.path === path);
  const res = makeRes();
  r.handlers[r.handlers.length - 1]({ body: {}, query: {}, ...req }, res);
  return res;
};

// goalSystem 桩：add 空/同名拒（返回 null），与真实语义一致。
function makeGoalSystem() {
  const titles = new Set();
  const added = [];
  return {
    added,
    add(g) {
      const t = String(g.title || '');
      if (!t || titles.has(t)) return null;
      titles.add(t);
      const id = `goal-${added.length + 1}`;
      added.push({ ...g, id });
      return id;
    },
    arbitrate() {}, list() { return []; }, stats() { return {}; }, get() { return null; }, setStatus() { return true; },
  };
}

// 候选池 store 桩（Map）。
function makeCandStore() {
  const m = new Map();
  return {
    _m: m,
    insert: (c) => m.set(c.id, { ...c }),
    update: (id, patch) => m.set(id, { ...(m.get(id) || {}), ...patch }),
    get: (id) => m.get(id) || null,
    list: (f = {}) => [...m.values()].filter((c) => !f.decision || c.decision === f.decision),
  };
}

describe('owner-seed 候选池接入（P2 切片A，flag NOE_CANDIDATE_POOL）', () => {
  const ENV = process.env.NOE_CANDIDATE_POOL;
  afterEach(() => {
    if (ENV === undefined) delete process.env.NOE_CANDIDATE_POOL;
    else process.env.NOE_CANDIDATE_POOL = ENV;
  });

  it('flag OFF（默认）：零回归——owner-seed 直接 directive 升格，无 candidate 字段', () => {
    delete process.env.NOE_CANDIDATE_POOL;
    const gs = makeGoalSystem();
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { goalSystem: gs, goalCandidateStore: makeCandStore(), now: () => 1000 });
    const r = call(routes, 'post', '/api/noe/mind/goals', { body: { title: '直接目标' } });
    expect(r.payload).toMatchObject({ ok: true });
    expect(r.payload.candidate).toBeUndefined();
    expect(gs.added.length).toBe(1);
    expect(gs.added[0].title).toBe('直接目标');
  });

  it('flag ON + owner（权重 1.0）：进池打分 → accepted → 升格目标 + candidate id', () => {
    process.env.NOE_CANDIDATE_POOL = '1';
    const gs = makeGoalSystem();
    const store = makeCandStore();
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { goalSystem: gs, goalCandidateStore: store, now: () => 1000 });
    const r = call(routes, 'post', '/api/noe/mind/goals', { body: { title: 'owner 的任务', source: 'owner' } });
    expect(r.payload).toMatchObject({ ok: true, decision: 'accepted' });
    expect(r.payload.id).toBeTruthy();
    expect(r.payload.candidate).toBeTruthy();
    expect(gs.added.length).toBe(1);
    expect(store.get(r.payload.candidate).decision).toBe('accepted');
  });

  it('flag ON + self_evolution（0.9×0.6=0.54≥0.45）：仍 accepted', () => {
    process.env.NOE_CANDIDATE_POOL = '1';
    const gs = makeGoalSystem();
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { goalSystem: gs, goalCandidateStore: makeCandStore(), now: () => 1000 });
    const r = call(routes, 'post', '/api/noe/mind/goals', { body: { title: '自进化目标', source: 'self_evolution' } });
    expect(r.payload).toMatchObject({ ok: true, decision: 'accepted' });
  });

  it('反向 probe：flag ON + 空 title → goalSystem 拒（null）→ 400', () => {
    process.env.NOE_CANDIDATE_POOL = '1';
    const gs = makeGoalSystem();
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { goalSystem: gs, goalCandidateStore: makeCandStore(), now: () => 1000 });
    const r = call(routes, 'post', '/api/noe/mind/goals', { body: { title: '' } });
    expect(r.statusCode).toBe(400);
    expect(r.payload.ok).toBe(false);
  });

  it('反向 probe：flag ON + 重复同 title → 第二次 goalSystem 拒 → 400（同名语义保持）', () => {
    process.env.NOE_CANDIDATE_POOL = '1';
    const gs = makeGoalSystem();
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { goalSystem: gs, goalCandidateStore: makeCandStore(), now: () => 1000 });
    call(routes, 'post', '/api/noe/mind/goals', { body: { title: '同一个' } });
    const r2 = call(routes, 'post', '/api/noe/mind/goals', { body: { title: '同一个' } });
    expect(r2.statusCode).toBe(400);
    expect(gs.added.length).toBe(1);
  });

  it('GET goal-candidates：flag OFF → enabled:false 空列表', () => {
    delete process.env.NOE_CANDIDATE_POOL;
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { goalSystem: makeGoalSystem(), goalCandidateStore: makeCandStore() });
    const r = call(routes, 'get', '/api/noe/mind/goal-candidates');
    expect(r.payload).toMatchObject({ ok: true, enabled: false, candidates: [] });
  });

  it('GET goal-candidates：flag ON → 返回候选列表（含 decision 过滤）', () => {
    process.env.NOE_CANDIDATE_POOL = '1';
    const gs = makeGoalSystem();
    const store = makeCandStore();
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { goalSystem: gs, goalCandidateStore: store, now: () => 1000 });
    call(routes, 'post', '/api/noe/mind/goals', { body: { title: 'A' } });
    const r = call(routes, 'get', '/api/noe/mind/goal-candidates');
    expect(r.payload.enabled).toBe(true);
    expect(r.payload.candidates.length).toBe(1);
    expect(call(routes, 'get', '/api/noe/mind/goal-candidates', { query: { decision: 'accepted' } }).payload.candidates.length).toBe(1);
    expect(call(routes, 'get', '/api/noe/mind/goal-candidates', { query: { decision: 'pending' } }).payload.candidates.length).toBe(0);
  });

  it('反向 probe：flag ON + store.insert 抛错 → 走 catch 不假成功（500，不静默吞）', () => {
    process.env.NOE_CANDIDATE_POOL = '1';
    const badStore = { insert: () => { throw new Error('db boom'); }, update() {}, get: () => null, list: () => [] };
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { goalSystem: makeGoalSystem(), goalCandidateStore: badStore, now: () => 1000 });
    const r = call(routes, 'post', '/api/noe/mind/goals', { body: { title: 'X' } });
    expect(r.statusCode).toBe(500);
    expect(r.payload.ok).toBe(false);
  });

  it('反向 probe：flag ON + 空 title → 候选回滚 rejected（不残留 accepted+goal_id=null 孤儿，三方审核坐实）', () => {
    process.env.NOE_CANDIDATE_POOL = '1';
    const gs = makeGoalSystem();
    const store = makeCandStore();
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { goalSystem: gs, goalCandidateStore: store, now: () => 1000 });
    const r = call(routes, 'post', '/api/noe/mind/goals', { body: { title: '' } });
    expect(r.statusCode).toBe(400);
    const cands = store.list();
    expect(cands.length).toBe(1);
    expect(cands[0].decision).toBe('rejected'); // 不能是 accepted
    expect(cands[0].goal_id == null).toBe(true);
    expect(cands[0].reject_reason).toContain('升格失败');
  });

  it('flag ON + owner baseScore 字符串 "0.4"（规整 1.0×0.4=0.4<0.45）→ rejected（证明字符串被解析，非降级默认 0.6）', () => {
    process.env.NOE_CANDIDATE_POOL = '1';
    const gs = makeGoalSystem();
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { goalSystem: gs, goalCandidateStore: makeCandStore(), now: () => 1000 });
    const r = call(routes, 'post', '/api/noe/mind/goals', { body: { title: '低分目标', source: 'owner', baseScore: '0.4' } });
    expect(r.payload).toMatchObject({ ok: true, decision: 'rejected' }); // 若未解析字符串会退默认 0.6→accepted，此断言失败
  });
});
