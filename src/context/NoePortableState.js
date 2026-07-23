// @ts-check
// NoePortableState — 第三阶段·跨设备同一个「它」的地基:Neo 的可携带状态包。
//
// 「同一个它」跨设备 = 同一份可携带状态(身份 + 此刻自我状态 + 连续记忆 narrative + 关键记忆)。
// 这是跨设备的必需第一块:transport/sync 是后续基础设施,但同步的前提是能把「我是谁、我们一路走来、我此刻的状态」
//   脱敏、版本化、限量地序列化成一个可搬运的包。绝不带 secret/凭据跨设备(导出脱敏 + 加载再验,纵深两道)。纯函数。

import { redactSensitiveText, textContainsSecretLike } from '../runtime/NoeContextScrubber.js';

export const NOE_PORTABLE_STATE_SCHEMA_VERSION = 'noe-portable-state-v1';

function scrub(value, max = 4000) {
  if (value == null) return '';
  try { return redactSensitiveText(String(value)).slice(0, max); } catch { return ''; }
}

function scrubObject(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    out[k] = (typeof v === 'string') ? scrub(v, 500) : v;
  }
  return out;
}

/**
 * 打包 Neo 的可携带状态(脱敏、限量、版本化)。
 * @param {object} [parts]
 * @param {object} [parts.identity] 身份(name/role/disposition 等稳定层)
 * @param {string} [parts.selfState] 此刻自我状态(buildSelfStateBlock)
 * @param {string} [parts.continuity] 连续记忆 narrative
 * @param {Array<{title?:string,salience?:number}>} [parts.salientMemories] 高显著关键记忆
 * @param {string} [parts.at] 时间戳
 * @param {number} [parts.maxMemories] 关键记忆上限(默认 40)
 */
export function buildPortableStateBundle({ identity = {}, selfState = '', continuity = '', salientMemories = [], at = '', maxMemories = 40 } = {}) {
  const mems = (Array.isArray(salientMemories) ? salientMemories : [])
    .slice(0, Math.max(0, maxMemories))
    .map((m) => ({ title: scrub(m && m.title, 300), salience: Number(m && m.salience) || 0 }))
    .filter((m) => m.title);
  return {
    schemaVersion: NOE_PORTABLE_STATE_SCHEMA_VERSION,
    at: String(at || ''),
    identity: scrubObject(identity),
    selfState: scrub(selfState, 2000),
    continuity: scrub(continuity, 4000),
    salientMemories: mems,
  };
}

/**
 * 校验一个可携带状态包能不能安全加载(另一台设备加载前的纵深第二道:防脏包/防 secret 混入)。
 * @param {any} bundle
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePortableStateBundle(bundle) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return { ok: false, errors: ['not_an_object'] };
  if (bundle.schemaVersion !== NOE_PORTABLE_STATE_SCHEMA_VERSION) errors.push('bad_or_missing_schema_version');
  // 纵深:整包序列化后不得含 secret-like(导出已脱敏,加载再验一次,防被篡改/手工塞入凭据)。
  try { if (textContainsSecretLike(JSON.stringify(bundle))) errors.push('contains_secret_like'); } catch { /* 校验失败按无 secret 处理但不放行 schema 错 */ }
  return { ok: errors.length === 0, errors };
}

/**
 * 导入侧:把可携带状态包加载进目标设备(=「同一个它」跨设备的闭环)。先校验(拒脏包污染目标),再经注入的
 *   writer 写回叙事 + 关键记忆。DI(writeMemory/writeNarrative),单条失败 fail-open(不因一条崩整个加载)。
 * @param {any} bundle
 * @param {object} [deps]
 * @param {(m:{title:string,salience:number,scope?:string,tags?:string[]})=>void} [deps.writeMemory]
 * @param {(narrative:string)=>void} [deps.writeNarrative]
 * @returns {{ ok:boolean, errors?:string[], applied?:{memories:number, narrative:boolean} }}
 */
export function applyPortableStateBundle(bundle, { writeMemory = null, writeNarrative = null } = {}) {
  const check = validatePortableStateBundle(bundle);
  if (!check.ok) return { ok: false, errors: check.errors }; // 校验不过绝不写(防脏包污染目标设备)

  let memories = 0;
  let narrative = false;
  if (typeof writeNarrative === 'function' && bundle.continuity) {
    try { writeNarrative(String(bundle.continuity)); narrative = true; } catch { /* fail-open */ }
  }
  if (typeof writeMemory === 'function' && Array.isArray(bundle.salientMemories)) {
    for (const m of bundle.salientMemories) {
      if (!m || !m.title) continue;
      try { writeMemory({ title: String(m.title), salience: Number(m.salience) || 4, scope: 'portable-import', tags: ['portable-import'] }); memories += 1; } catch { /* 单条失败继续 */ }
    }
  }
  return { ok: true, applied: { memories, narrative } };
}

/**
 * 跨设备状态调和:合并两份可携带状态包(网络 sync 的核心冲突解决)。关键记忆按 title 并集去重(salience 冲突取较高),
 *   叙事取 at 较新的一方。先各自校验(拒脏包污染)。这是「同一个它」跨多设备保持一致的收敛逻辑;transport 层拿两端 bundle 调它。
 * @param {any} local 本机状态包
 * @param {any} remote 远端(另一设备)状态包
 * @returns {{ ok:boolean, errors?:string[], bundle?:object }}
 */
export function mergePortableStates(local, remote) {
  const lc = validatePortableStateBundle(local);
  const rc = validatePortableStateBundle(remote);
  if (!lc.ok || !rc.ok) return { ok: false, errors: [...(lc.errors || []).map((e) => `local:${e}`), ...(rc.errors || []).map((e) => `remote:${e}`)] };
  // 关键记忆并集去重(title 为键,salience 取较高)。
  const byTitle = new Map();
  for (const m of [...(local.salientMemories || []), ...(remote.salientMemories || [])]) {
    if (!m || !m.title) continue;
    const prev = byTitle.get(m.title);
    if (!prev || (Number(m.salience) || 0) > (Number(prev.salience) || 0)) byTitle.set(m.title, { title: String(m.title), salience: Number(m.salience) || 0 });
  }
  // 叙事/身份取 at 较新一方(newer 为准);identity 合并(远端覆盖同键,较新)。
  const localAt = Date.parse(local.at || '') || 0;
  const remoteAt = Date.parse(remote.at || '') || 0;
  const newer = remoteAt >= localAt ? remote : local;
  const older = remoteAt >= localAt ? local : remote;
  return {
    ok: true,
    bundle: {
      schemaVersion: NOE_PORTABLE_STATE_SCHEMA_VERSION,
      at: newer.at || older.at || '',
      identity: { ...(older.identity || {}), ...(newer.identity || {}) },
      selfState: newer.selfState || older.selfState || '',
      continuity: newer.continuity || older.continuity || '',
      salientMemories: Array.from(byTitle.values()),
    },
  };
}
