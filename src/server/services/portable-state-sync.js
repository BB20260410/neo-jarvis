// @ts-check
// portable-state-sync — 第三阶段·跨设备网络 sync 软件核心。
//
// 两台设备通过此服务交换+调和状态:sync(remote) 导本地态 → mergePortableStates 调和 → 落本地(applyMerged)
//   → 回合并态(对端也据此收敛)。DI(exportLocal/applyMerged),全程 fail-open——脏包拒收、导出失败返错不崩。
// 传输层(谁调此服务、走什么网络)由路由/owner 决定;本服务只管协议逻辑(收对端→调和→落地→回合并)。

import { mergePortableStates } from '../../context/NoePortableState.js';

/**
 * @param {object} deps
 * @param {() => object} deps.exportLocal 导出本机当前可携带状态包
 * @param {(bundle:object) => void} deps.applyMerged 把合并态落回本机
 */
export function createPortableStateSyncService({ exportLocal, applyMerged } = {}) {
  return {
    /**
     * 收对端状态包,与本地调和,落本地,返回合并态(供对端也收敛)。
     * @param {any} remoteBundle
     * @returns {{ ok:boolean, merged?:object, errors?:string[], error?:string }}
     */
    sync(remoteBundle) {
      let local;
      try {
        local = typeof exportLocal === 'function' ? exportLocal() : null;
      } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
      const m = mergePortableStates(local, remoteBundle);
      if (!m.ok) return { ok: false, errors: m.errors };
      try {
        if (typeof applyMerged === 'function') applyMerged(m.bundle);
      } catch { /* 落地失败不阻断返回合并态(对端仍可收敛);本机下次 sync 再试 */ }
      return { ok: true, merged: m.bundle };
    },
  };
}
