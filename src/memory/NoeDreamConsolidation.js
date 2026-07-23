// NoeDreamConsolidation — 把梦境整合计划落地到 MemoryCore 的集成层。
//
// 分工:NoeMemoryConsolidator(纯规划器,产计划)+ 本文件(把计划应用到真实 MemoryCore)。
//   merge→MemoryCore.merge(软删可恢复) / downgrade→MemoryCore.downgrade / promotion→setSalience↑。
// 不耦合任何 LLM/adapter:llmConsolidate 钩子由调用方注入(M3 实现见 NoeDreamM3Hook.js)。可单测(用 fake memoryCore)。
import { planConsolidation, createConsolidationLoop } from './NoeMemoryConsolidator.js';

/** 把整合计划落地到 MemoryCore。返回各动作计数。每个动作独立 try/catch,单条失败不阻断整批。 */
export function applyConsolidationPlan(memoryCore, plan, { projectId } = {}) {
  const out = { merged: 0, downgraded: 0, promoted: 0, skippedProtected: 0, errors: 0 };
  if (!memoryCore || !plan) return out;
  // 防御纵深:即便 plan 被污染(规划器层正常不会产出),落地层也绝不动身份级(salience>=5)记忆。
  const isIdentity = (id) => {
    try { const c = memoryCore.get?.(id, { includeHidden: true }); return Boolean(c) && (c.salience || 3) >= 5; } catch { return false; }
  };
  for (const m of plan.merges || []) {
    if (isIdentity(m.keepId) || (m.dropIds || []).some(isIdentity)) { out.skippedProtected += 1; continue; }
    try {
      memoryCore.merge?.({ targetId: m.keepId, sourceIds: m.dropIds, projectId, reason: m.reason || 'dream_merge' });
      if (Number.isFinite(m.mergedSalience)) memoryCore.setSalience?.(m.keepId, m.mergedSalience);
      out.merged += 1;
    } catch { out.errors += 1; }
  }
  for (const d of plan.downgrades || []) {
    if (isIdentity(d.id)) { out.skippedProtected += 1; continue; }
    try { if (memoryCore.downgrade?.(d.id, d.toSalience)) out.downgraded += 1; } catch { out.errors += 1; }
  }
  for (const p of plan.promotions || []) {
    try {
      const cur = memoryCore.get?.(p.id, { includeHidden: true });
      if (cur) { memoryCore.setSalience?.(p.id, Math.min(5, (cur.salience || 3) + 1)); out.promoted += 1; }
    } catch { out.errors += 1; }
  }
  return out;
}

/** 从 MemoryCore 取一批候选记忆,归一成规划器认得的形状。整合不算访问 → bumpHits:false。
 * 审计 §3.3 P0-7：冷热混合采样——只取 hit_count DESC（热）会漏掉命中 0 的陈旧记忆，而这些正是
 * 最该被 downgrade 的；取一半热（去重合并）+ 一半冷（updated_at ASC，降级 stale_cold），合并去重。 */
export function loadConsolidationCandidates(memoryCore, { projectId, limit = 50 } = {}) {
  if (!memoryCore?.recall) return [];
  const hotLimit = Math.max(1, Math.ceil(limit / 2));
  const hot = memoryCore.recall({ projectId, q: '', limit: hotLimit, bumpHits: false, includeExpired: true }) || [];
  const cold = memoryCore.recall({ projectId, q: '', limit, bumpHits: false, includeExpired: true, order: 'cold' }) || [];
  const seen = new Set();
  const items = [];
  for (const m of [...hot, ...cold]) {
    if (items.length >= limit) break;
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    items.push(m);
  }
  return items.map((m) => ({
    id: m.id,
    content: m.body,
    title: m.title,
    salience: m.salience,
    confidence: m.confidence,
    hitCount: m.hitCount,
    lastHitAt: m.lastHitAt,
    updatedAt: m.updatedAt,
    expiresAt: m.expiresAt,
    scope: m.scope,
    hidden: m.hidden,
  }));
}

/**
 * 建一个绑定 MemoryCore 的「梦境/睡眠整合」循环。**默认 enabled=false**(开后台周期整合需 owner 授权)。
 * 身份/人物 scope 默认硬保护;llmConsolidate 注入则启用语义去重(M3),否则纯确定性规则。
 */
export function createMemoryDreamLoop(memoryCore, {
  projectId, enabled = false, llmConsolidate = null, intervalMs, firstDelayMs,
  protectedScopes = ['identity', 'person'], candidateLimit = 50, log,
} = {}) {
  return createConsolidationLoop({
    loadCandidates: () => loadConsolidationCandidates(memoryCore, { projectId, limit: candidateLimit }),
    applyPlan: (plan) => applyConsolidationPlan(memoryCore, plan, { projectId }),
    planFn: planConsolidation,
    planOpts: { protectedScopes, llmConsolidate },
    enabled, intervalMs, firstDelayMs, log,
  });
}
