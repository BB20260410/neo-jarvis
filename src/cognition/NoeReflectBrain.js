// @ts-check
// NoeReflectBrain — 深思脑（System2）选型解析（设计文档《AI自我意识实现方案》§9 P9 阶段）。
//
// 问题：自主认知作业（夜间反思/审议/自我质询/规划）原默认路由含付费档（BrainRouter deep=claude，
//   反思模型默认 ollama 9B 偏弱）——要么烧配额不能 24h 跑，要么深度不够。
// 设计：所有"自主认知"消费方统一从这里取 {adapterId, model}，铁律是**白名单只含本地 adapter**
//   （lmstudio/ollama），配置指向别处一律警告并回退 lmstudio——自主思考永不烧付费配额，
//   这是"24 小时连续在想"的经济前提。
// env：NOE_REFLECT_TIER=1 启用（默认 OFF：各作业保持自己现有默认，行为零变化）；
//      NOE_REFLECT_BRAIN 本地 adapter（默认 lmstudio）；
//      NOE_REFLECT_MODEL 模型 id（默认 qwen/qwen3.6-35b-a3b；主脑 Qwen 35B A3B 6bit）。

import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel } from '../model/NoeLocalModelPolicy.js';

/** 自主认知允许的本地 adapter 白名单（绝不含 claude/codex/minimax/gemini 等付费档）。 */
export const LOCAL_REFLECT_ADAPTERS = Object.freeze(['lmstudio', 'ollama']);

/** 深思脑默认模型：主脑 Qwen 35B A3B 6bit；NOE_REFLECT_MODEL 可显式覆盖。 */
export const DEFAULT_REFLECT_MODEL = NOE_MAIN_BRAIN_MODEL;

/**
 * 解析深思脑配置。纯函数（env/log 注入可测），不持状态。
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {{warn?: (msg: string) => void}} [opts.log]
 * @returns {{enabled: boolean, adapterId: string|null, model: string|null}}
 */
export function resolveReflectBrain({ env = process.env, log = console } = {}) {
  if (env.NOE_REFLECT_TIER !== '1') return { enabled: false, adapterId: null, model: null };
  let adapterId = String(env.NOE_REFLECT_BRAIN || 'lmstudio').trim() || 'lmstudio';
  if (!LOCAL_REFLECT_ADAPTERS.includes(adapterId)) {
    try {
      log?.warn?.(`[noe-reflect] NOE_REFLECT_BRAIN=${adapterId} 不在本地白名单(${LOCAL_REFLECT_ADAPTERS.join('/')})，已回退 lmstudio——自主认知绝不路由到付费 adapter`);
    } catch { /* 日志失败不影响解析 */ }
    adapterId = 'lmstudio';
  }
  const rawModel = String(env.NOE_REFLECT_MODEL ?? DEFAULT_REFLECT_MODEL).trim();
  const model = normalizeNoeAutoModel(rawModel);
  return { enabled: true, adapterId, model };
}

// ───────────────────────── 重决策 tier（C 分层：主脑可接 cloud） ─────────────────────────
//
// owner 2026-06-22 决策「主脑分层接入 cloud」：高频轻认知（inner 每 5s / reflect）继续走本地白名单
//   （免费/快/离线/不抢配额——24h 连续在想的经济前提，resolveReflectBrain 不变）；**重决策**（深思审议 /
//   主动对外 proactive）可走 cloud（claude/codex）换质量。红线4「花钱」已于 2026-06-21 移除，解锁不违规。
// 安全：分量动作 flag 默认 OFF（NOE_REFLECT_HEAVY_TIER!=1）→ 回退本地 main，零回归；owner env 点火启用。

/** 重决策 tier 允许的 adapter：本地基础上放开 cloud。高频轻 tick 仍只走 LOCAL_REFLECT_ADAPTERS。 */
export const HEAVY_REFLECT_ADAPTERS = Object.freeze(['lmstudio', 'ollama', 'claude', 'codex', 'minimax']);

/**
 * 解析【重决策 tier】脑（分层）。纯函数（env/log 注入可测）。
 *   NOE_REFLECT_HEAVY_TIER=1 启用；NOE_REFLECT_HEAVY_BRAIN 选 adapter（默认 lmstudio，可 claude/codex）；
 *   NOE_REFLECT_HEAVY_MODEL 模型（cloud 用其默认 id，本地用 main 35B）。默认 OFF → 本地 main（零回归）。
 * @param {object} [opts]
 * @param {Record<string, string|undefined>} [opts.env]
 * @param {{warn?: (msg: string) => void}} [opts.log]
 * @returns {{enabled: boolean, tier: 'heavy', adapterId: string, model: string}}
 */
export function resolveHeavyReflectBrain({ env = process.env, log = console } = {}) {
  const localModel = normalizeNoeAutoModel(DEFAULT_REFLECT_MODEL);
  if (env.NOE_REFLECT_HEAVY_TIER !== '1') return { enabled: false, tier: 'heavy', adapterId: 'lmstudio', model: localModel };
  let adapterId = String(env.NOE_REFLECT_HEAVY_BRAIN || 'lmstudio').trim() || 'lmstudio';
  if (!HEAVY_REFLECT_ADAPTERS.includes(adapterId)) {
    try { log?.warn?.(`[noe-reflect] NOE_REFLECT_HEAVY_BRAIN=${adapterId} 不在重决策白名单(${HEAVY_REFLECT_ADAPTERS.join('/')})，已回退 lmstudio`); } catch { /* 日志失败不影响解析 */ }
    adapterId = 'lmstudio';
  }
  const rawModel = String(env.NOE_REFLECT_HEAVY_MODEL ?? DEFAULT_REFLECT_MODEL).trim();
  return { enabled: true, tier: 'heavy', adapterId, model: normalizeNoeAutoModel(rawModel) };
}
