// @ts-check
// noePortableStateSync — 第三阶段·跨设备 sync HTTP 端点(软件侧最后一块)。
//
// 把 createPortableStateSyncService 挂到 owner-token 保护的路由:POST 对端设备的状态包 → 调和 → 落本地 → 回合并态。
// 和所有 panel 路由同规格:requireOwnerToken + 仅 127.0.0.1(不改绑定地址、不碰网络底层)。owner 决定另一台设备
//   怎么触达 localhost(SSH 隧道 / tailscale / 反代——部署选择)。未装配 syncService(flag OFF)→ 不注册端点(零暴露)。

import { requireOwnerToken } from '../auth/owner-token.js';

const MAX_BODY = 2_000_000; // 状态包脱敏限量,2MB 足够;超则拒(防大 body)

/**
 * @param {import('express').Express} app
 * @param {object} deps
 * @param {{ sync: (remote:any) => {ok:boolean, merged?:object, errors?:string[], error?:string} }} [deps.syncService]
 * @param {(res:any, e:any) => any} [deps.sendError]
 */
export function registerNoePortableStateSyncRoutes(app, { syncService, sendError } = {}) {
  if (!syncService || typeof syncService.sync !== 'function') return; // flag OFF / 未装配 → 零暴露
  app.post('/api/noe/portable-state/sync', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const remote = body.bundle || body;
      if (JSON.stringify(remote || '').length > MAX_BODY) return res.status(413).json({ ok: false, error: 'bundle too large' });
      const r = syncService.sync(remote);
      if (!r.ok) return res.status(400).json({ ok: false, error: r.error || (r.errors || []).join('; ') || 'sync failed' });
      return res.json({ ok: true, merged: r.merged });
    } catch (e) {
      return typeof sendError === 'function' ? sendError(res, e) : res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
