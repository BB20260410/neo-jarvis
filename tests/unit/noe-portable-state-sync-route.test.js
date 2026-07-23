import { describe, it, expect, vi } from 'vitest';
import { registerNoePortableStateSyncRoutes } from '../../src/server/routes/noePortableStateSync.js';

// 第三阶段·跨设备 sync HTTP 端点:把 sync 服务挂到 owner-token 保护的 localhost 路由(和所有 panel 路由同规格)。
// 未装配 syncService(flag OFF)→ 不注册端点(零暴露);装配则 POST 收对端包→调和→回合并态。

function fakeApp() {
  const routes = {};
  return { post: (path, ...handlers) => { routes[path] = handlers[handlers.length - 1]; }, routes };
}
function fakeRes() {
  return { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } };
}

describe('registerNoePortableStateSyncRoutes', () => {
  it('无 syncService(flag OFF) → 不注册端点(零暴露)', () => {
    const app = fakeApp();
    registerNoePortableStateSyncRoutes(app, {});
    expect(app.routes['/api/noe/portable-state/sync']).toBeUndefined();
  });

  it('装配后 POST 对端包 → 调和 → 回合并态', async () => {
    const app = fakeApp();
    const syncService = { sync: vi.fn(() => ({ ok: true, merged: { schemaVersion: 'noe-portable-state-v1', salientMemories: [] } })) };
    registerNoePortableStateSyncRoutes(app, { syncService });
    const handler = app.routes['/api/noe/portable-state/sync'];
    expect(handler).toBeTypeOf('function');
    const res = fakeRes();
    await handler({ body: { bundle: { schemaVersion: 'noe-portable-state-v1' } } }, res);
    expect(res.body.ok).toBe(true);
    expect(res.body.merged.schemaVersion).toBe('noe-portable-state-v1');
    expect(syncService.sync).toHaveBeenCalled();
  });

  it('调和失败(脏包) → 400 不崩', async () => {
    const app = fakeApp();
    const syncService = { sync: vi.fn(() => ({ ok: false, errors: ['bad'] })) };
    registerNoePortableStateSyncRoutes(app, { syncService });
    const res = fakeRes();
    await app.routes['/api/noe/portable-state/sync']({ body: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body.ok).toBe(false);
  });
});
