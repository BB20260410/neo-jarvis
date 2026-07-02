// @ts-check
// ③ 能力自举触发器（自发）——让 Neo「根据需要」自主发起能力获取（纳入自驱 loop）。
// observe(需求信号) → searchCapability → 安全评估 → standing grant 检查 → 提议 noe.capability.install。
// 触发器只「发起提议」，不「直接安装」：安装仍走 ActPipeline gate + executor 多重门
// （env NOE_CAPABILITY_ACQUISITION + standing grant(capability:acquire) + 源白名单 + 隔离安装 + 验证 + 回滚）。
// 防滥：cooldown（默认 30min）+ 同需求去重。全注入式；不设硬超时（跑网络纪律）。env 门控在 server 装配侧。

import { createNoeCapabilityAcquisition } from './NoeCapabilityAcquisition.js';

const DEFAULT_COOLDOWN_MS = 30 * 60_000;
const NEED_RE = /缺(个|少)?(工具|能力|库|包|插件|mcp)|装个|没有.*(工具|库|包)|需要.*(工具|库|包|能力|mcp|插件)|need (a |an )?(tool|library|package|capability|mcp)/i;

function cleanStr(v) { return String(v || '').trim(); }
function asMs(now) { const v = typeof now === 'function' ? now() : now; return Number(v) || 0; }

// 识别文本是否表达「缺某能力」的需求（对话/失败信号辅助；调用方也可显式传 need）。
export function classifyCapabilityNeed(text = '') {
  const t = cleanStr(text);
  if (!t) return { isNeed: false, reason: 'empty' };
  if (NEED_RE.test(t)) return { isNeed: true, reason: 'pattern_match' };
  return { isNeed: false, reason: 'no_match' };
}

export function createNoeCapabilityTrigger(deps = {}) {
  const {
    webSearch = null,
    propose = null,
    evaluateGrant = null,
    now = () => Date.now(),
    cooldownMs = DEFAULT_COOLDOWN_MS,
    capabilityAcquisition = null,
  } = deps;
  const acquisition = capabilityAcquisition || createNoeCapabilityAcquisition({ webSearch });
  let lastObserveAt = 0;
  const proposedNeeds = new Set();

  // 察觉需求 → 搜 → 评估 → grant → 提议安装。need 可显式传（从 goal/失败 act），或从 text 信号识别。
  async function observe({ text = '', need = '', kind = 'any' } = {}) {
    const explicit = cleanStr(need);
    if (!explicit) {
      const signal = classifyCapabilityNeed(text);
      if (!signal.isNeed) return { ok: false, reason: 'not_capability_need' };
    }
    const q = (explicit || cleanStr(text)).slice(0, 200);
    const t = asMs(now);
    if (t - lastObserveAt < cooldownMs) return { ok: false, reason: 'cooldown' };
    if (proposedNeeds.has(q)) return { ok: false, reason: 'already_proposed' };

    const searched = await acquisition.searchCapability({ need: q, kind });
    if (!searched.ok || !searched.candidates.length) return { ok: false, reason: 'no_candidate' };
    const picked = searched.candidates
      .map((c) => ({ c, a: acquisition.assessCandidate(c) }))
      .find((x) => x.a.safe);
    if (!picked) return { ok: false, reason: 'no_safe_candidate' };

    // standing grant 是自动安装的主门：未授权只搜不提议（owner 没开 capability:acquire 就不自发装）
    const grant = typeof evaluateGrant === 'function' ? evaluateGrant({ scope: 'capability:acquire' }) : { authorized: false };
    if (!grant || grant.authorized !== true) return { ok: false, reason: 'no_standing_grant', candidate: picked.c };

    const plan = acquisition.planAcquisition(picked.c);
    if (!plan.ok) return { ok: false, reason: 'plan_failed', errors: plan.errors };

    lastObserveAt = t;
    proposedNeeds.add(q);
    if (typeof propose !== 'function') return { ok: true, proposed: false, reason: 'propose_unavailable', capability: plan.capability };
    const actResult = await propose({
      action: 'noe.capability.install',
      title: `获取能力: ${plan.capability.name}`,
      payload: { capability: plan.capability, source: 'capability_trigger', need: q },
      proposedBy: 'noe-capability-trigger',
    });
    return { ok: true, proposed: true, capability: plan.capability, need: q, actResult };
  }

  return { observe, classifyCapabilityNeed };
}
