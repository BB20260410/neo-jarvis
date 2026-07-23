// @ts-check
// NoeModelHealthProbe — P2 觉醒看板「本地模型存活」只读探针。
//
// 为什么：觉醒看板要一眼看清「三脑就位没 / embedding 走的真后端」。原 council.discoverLocalModelProviders
//   已 ping ollama(/api/tags)+lmstudio(/v1/models)，但不判三脑角色、不暴露 embedding 实际后端。本探针薄层叠加。
//
// 纪律：纯只读——只复用既有 GET ping，绝不 load/unload/chat-completion（不烧配额、不改 LM Studio 装载态）；
//   注入式（discover + brainRoles + dimHealth getter + now 全注入，可确定性单测）；全程 fail-open（任何子项
//   抛错 → 该项标未就位，不阻断其余）。不设显式超时（遵守 owner「跑模型不设超时」，依赖底层 ping 自身行为）。

import { NOE_BRAIN_ROLES } from '../../model/NoeLocalModelPolicy.js';

/** 去掉 @quant/版本尾巴做基名比对（'qwen/...@6bit' → 'qwen/...'）。 */
function baseId(s) {
  return String(s || '').toLowerCase().split('@')[0].trim();
}

/**
 * 某脑角色的 apiModel/loadKeys 是否命中任一已加载本地模型 id。
 * @param {{role:string,label:string,apiModel:string,loadKeys?:string[]}} role
 * @param {string[]} loadedIds 已加载（且 council 判为可用 chat）的本地模型 id
 */
function matchBrain(role, loadedIds) {
  const keys = [role.apiModel, ...(Array.isArray(role.loadKeys) ? role.loadKeys : [])]
    .map(baseId).filter(Boolean);
  const ids = loadedIds.map(baseId).filter(Boolean);
  const loaded = ids.some((id) => keys.some((k) => id === k));
  return { role: role.role, label: role.label, apiModel: role.apiModel, loaded };
}

/**
 * @param {object} opts
 * @param {() => Promise<{providers?:any[], models?:any[]}>} opts.discover  注入 discoverLocalModelProviders
 * @param {Record<string,any>} [opts.brainRoles]  默认 NOE_BRAIN_ROLES（main/review/fallback）
 * @param {(() => any)|null} [opts.dimHealth]  返回 embedding 后端/维度健康（NoeMemoryStatus / VectorIndex 派生），可空
 * @param {() => number} [opts.now]
 */
export function createModelHealthProbe({
  discover,
  brainRoles = NOE_BRAIN_ROLES,
  dimHealth = null,
  now = Date.now,
} = {}) {
  if (typeof discover !== 'function') throw new Error('createModelHealthProbe: discover(注入式) required');

  async function probe() {
    let providers = [];
    let models = [];
    try {
      const d = await discover();
      providers = Array.isArray(d?.providers) ? d.providers : [];
      models = Array.isArray(d?.models) ? d.models : [];
    } catch { /* fail-open：双后端皆未连 */ }

    const lmstudio = providers.find((p) => p?.id === 'lmstudio') || null;
    const ollama = providers.find((p) => p?.id === 'ollama') || null;
    const lmModels = models.filter((m) => m?.provider === 'lmstudio');
    const ollamaModels = models.filter((m) => m?.provider === 'ollama');
    const loadedIds = models.map((m) => String(m?.id || '')).filter(Boolean);

    const brains = {
      main: matchBrain(brainRoles.main, loadedIds),
      review: matchBrain(brainRoles.review, loadedIds),
      fallback: matchBrain(brainRoles.fallback, loadedIds),
    };
    // 三脑就位度：复核脑(review)是高风险动作的把关，单列出来供看板高亮缺位。
    const brainsReady = [brains.main, brains.review, brains.fallback].filter((b) => b.loaded).length;

    let embedding = { provider: 'unknown', dimension: null, degraded: null, orphanEventCount: 0 };
    if (typeof dimHealth === 'function') {
      try {
        const h = dimHealth() || {};
        embedding = {
          provider: String(h.provider || 'unknown'),
          dimension: Number.isFinite(h.dimension) ? h.dimension : null,
          // 命中 hash-fallback 维度孤儿 = 语义召回退化（P0 维度黑洞），看板要红
          degraded: typeof h.degraded === 'boolean' ? h.degraded
            : (typeof h.queryDimOrphaned === 'boolean' ? h.queryDimOrphaned : null),
          orphanEventCount: Math.max(0, Math.round(Number(h.orphanEventCount) || 0)),
        };
      } catch { /* fail-open */ }
    }

    return {
      ok: true,
      ts: now(),
      ollama: {
        available: Boolean(ollama?.available),
        status: ollama?.status || '未连接',
        modelCount: ollamaModels.length,
      },
      lmstudio: {
        available: Boolean(lmstudio?.available),
        status: lmstudio?.status || '未连接',
        modelCount: lmModels.length,
      },
      brains,
      brainsReady, // 0..3
      embedding,
    };
  }

  return { probe };
}
