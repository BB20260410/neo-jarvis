// @ts-check
// NoeDeviceIdentity — 第三阶段·跨设备同一个「它」的设备身份 building block。
//
// 跨设备要「同一个它」不混淆:每台机器需稳定身份;可携带状态包盖来源设备戳(哪台机器、几时导的),
//   加载时读得出来源——多设备间冲突可判、来源可追溯。这是网络 sync 之前的必需基元(sync 靠 deviceId 做冲突解决)。
//   纯函数:hostname/platform 注入(不硬抓 os,可测);deviceId 用 sha256 稳定哈希(同机器同 id)。

import { createHash } from 'node:crypto';

/**
 * 据 hostname+platform 产稳定 deviceId(同机器同 id,不同机器不同 id)。
 * @param {{hostname?:string, platform?:string}} [env]
 * @returns {{ deviceId: string, label: string }}
 */
export function resolveDeviceIdentity({ hostname = '', platform = '' } = {}) {
  const host = String(hostname || 'unknown-host');
  const plat = String(platform || 'unknown-os');
  const deviceId = `dev-${createHash('sha256').update(`${host}::${plat}`).digest('hex').slice(0, 16)}`;
  return { deviceId, label: `${host} (${plat})` };
}

/**
 * 给可携带状态包盖来源设备戳(不改原内容,只加 originDevice)。
 * @param {object} bundle
 * @param {{hostname?:string, platform?:string}} env
 * @param {string} [exportedAt]
 */
export function tagBundleWithDevice(bundle, env, exportedAt = '') {
  const base = (bundle && typeof bundle === 'object') ? bundle : {};
  const id = resolveDeviceIdentity(env || {});
  return { ...base, originDevice: { deviceId: id.deviceId, label: id.label, exportedAt: String(exportedAt || '') } };
}

/**
 * 加载时读出「这包来自哪台机器」。旧包无戳 → 未知来源(不崩)。
 * @param {any} bundle
 * @returns {string}
 */
export function describeBundleOrigin(bundle) {
  const od = bundle && typeof bundle === 'object' ? bundle.originDevice : null;
  if (!od || !od.label) return '未知来源设备';
  return `来自: ${od.label}${od.exportedAt ? `（导出于 ${od.exportedAt}）` : ''}`;
}
