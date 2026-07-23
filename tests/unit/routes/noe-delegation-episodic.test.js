import { describe, expect, it } from 'vitest';
import { registerNoeDelegationRoutes } from '../../../src/server/routes/noeDelegation.js';

// 内在世界（记录覆盖扩展）：派活 confirm 成立(201) → 自传体时间线 type:'milestone' salience 4。
// 三断言纪律：注入时形状正确 / 未注入零调用零影响 / record 抛错 fail-open 不破坏 201 返回。
// 全部注入 fake（roomStore/adapterPool/timeline），绝不连真库。

function makeApp() {
  const routes = [];
  const app = { post(path, ...handlers) { routes.push({ method: 'post', path, handlers }); } };
  return { app, routes };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function route(routes, path) {
  return routes.find((r) => r.method === 'post' && r.path === path).handlers[1];
}

function makeRoomStore() {
  const rooms = new Map();
  const calls = { create: 0 };
  return {
    calls,
    get: (id) => rooms.get(id),
    create(input) {
      calls.create += 1;
      const room = { id: `room-${calls.create}`, status: 'idle', ...input };
      rooms.set(room.id, room);
      return room;
    },
    update(id, patch) {
      const room = { ...rooms.get(id), ...patch };
      rooms.set(id, room);
      return room;
    },
  };
}

function makeFakeTimeline({ throwOnRecord = false } = {}) {
  const calls = [];
  return {
    calls,
    record(episode) {
      if (throwOnRecord) throw new Error('timeline down');
      calls.push(episode);
      return calls.length;
    },
  };
}

function register({ timeline } = {}) {
  const roomStore = makeRoomStore();
  const { app, routes } = makeApp();
  registerNoeDelegationRoutes(app, {
    roomStore,
    getRoomAdapterPool: () => new Map([['codex', { displayName: 'Codex' }]]),
    ...(timeline !== undefined ? { episodicTimeline: timeline } : {}),
  });
  return { roomStore, routes };
}

describe('delegation confirm × EpisodicTimeline（内在世界·记录覆盖扩展）', () => {
  it('注入 timeline：confirm 成立记一条 milestone salience 4，summary 取 plan 标题截 40', () => {
    const timeline = makeFakeTimeline();
    const { routes } = register({ timeline });

    const res = makeRes();
    route(routes, '/api/noe/delegate/confirm')({ body: { text: '让 Codex 帮我写单测', confirm: true } }, res);

    expect(res.statusCode).toBe(201);
    expect(timeline.calls).toHaveLength(1);
    expect(timeline.calls[0].type).toBe('milestone');
    expect(timeline.calls[0].salience).toBe(4);
    // detectTaskIntent 会清洗"让 Codex 帮我"指派前缀，plan.title='写单测'
    expect(timeline.calls[0].summary).toBe('主人派活给我：写单测');
    expect(timeline.calls[0].summary.length).toBeLessThanOrEqual('主人派活给我：'.length + 40);
  });

  it('confirm 未确认(409)不记录；plan 路由也不记录（只记真成立的派活）', () => {
    const timeline = makeFakeTimeline();
    const { routes, roomStore } = register({ timeline });

    const res409 = makeRes();
    route(routes, '/api/noe/delegate/confirm')({ body: { text: '让 Codex 帮我写单测' } }, res409);
    expect(res409.statusCode).toBe(409);

    const resPlan = makeRes();
    route(routes, '/api/noe/delegate/plan')({ body: { text: '让 Codex 帮我修 bug' } }, resPlan);

    expect(timeline.calls).toHaveLength(0);
    expect(roomStore.calls.create).toBe(0);
  });

  it('未注入 timeline：零调用，201 返回结构与既有完全一致', () => {
    const bystander = makeFakeTimeline();   // 造了但不注入，断言零调用
    const { routes } = register();

    const res = makeRes();
    route(routes, '/api/noe/delegate/confirm')({ body: { text: '让 Codex 帮我写单测', confirm: true } }, res);

    expect(bystander.calls).toHaveLength(0);
    expect(res.statusCode).toBe(201);
    expect(res.payload).toMatchObject({ ok: true, intent: 'delegate_task', started: false, queued: false });
    expect(res.payload.room).toMatchObject({ status: 'idle', mode: 'chat' });
  });

  it('record 抛错：fail-open，201 返回不破坏', () => {
    const { routes } = register({ timeline: makeFakeTimeline({ throwOnRecord: true }) });

    const res = makeRes();
    route(routes, '/api/noe/delegate/confirm')({ body: { text: '让 Codex 帮我写单测', confirm: true } }, res);

    expect(res.statusCode).toBe(201);
    expect(res.payload).toMatchObject({ ok: true, intent: 'delegate_task' });
    expect(res.payload.room).toBeTruthy();
  });
});
