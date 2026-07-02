// @ts-check
// self-evolution post_review 的 reviewer 模型集（env-gated，轻量无重依赖，供 gate/cycle 校验 + 完成适配器共享同一口径）。
//
// 背景：cloud consensus reviewer（claude=Claude Code CLI agentic 返回 prose 非 JSON / m3·xiaomi 走外网在 launchd 环境
//   network 不可达）在本机自改链上**全部不可用**——self-evolution cycle 永远拿不到可解析的复核裁决、卡 post_review。
//   实测唯一可靠的模型路径是**本地 LM Studio**（implementer 已用它真出 clean patch：reasoning_effort='none'+json_schema）。
//   故 self-evolution 的 post_review 改用**本地 clean-JSON reviewer**：review-tier 与兜底两个**不同**本地模型（与 implementer
//   的 main 35b 不同→保留复核独立性），各出 {decision,...} 裁决，沿用既有 quorum/gate。
//
// 安全/零回归：**默认空**（NOE_SELF_EVOLUTION_REVIEW_MODELS 未设）→ 返回 null → 所有调用方回退 cloud consensus reviewers
//   （requiredReviewerModels），行为与改造前逐字一致。只有显式设了 env（本机 plist 设 'local-qwen,local-gemma'）才启用
//   本地 reviewer。本改动**只影响 self-evolution 的 post_review 复核口径，不动通用 consensus**。

// 本地 reviewer id → LM Studio 模型映射（可 env 覆盖具体模型；默认 review-tier 27b + gemma，皆 ≠ implementer 的 35b）。
export const NOE_SELF_EVOLUTION_LOCAL_REVIEWER_MODELS = Object.freeze({
  'local-qwen': process.env.NOE_SELF_EVOLUTION_REVIEW_MODEL_A || 'qwen/qwen3.6-27b',
  'local-gemma': process.env.NOE_SELF_EVOLUTION_REVIEW_MODEL_B || 'gemma-4-31b-it-qat',
});

/**
 * self-evolution post_review 的必需 reviewer id 列表。
 * @returns {string[]|null} 设了 env → id 数组；未设 → null（调用方回退 cloud requiredReviewerModels，零回归）。
 */
export function noeSelfEvolutionReviewerIds() {
  const raw = String(process.env.NOE_SELF_EVOLUTION_REVIEW_MODELS || '').trim();
  if (!raw) return null;
  const ids = raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return ids.length ? [...new Set(ids)] : null;
}

/** 某 reviewer id 对应的 LM Studio 本地模型；非本地 reviewer 返回 null。 */
export function noeSelfEvolutionLocalReviewerModel(id) {
  const key = String(id || '').trim().toLowerCase();
  return NOE_SELF_EVOLUTION_LOCAL_REVIEWER_MODELS[key] || null;
}

/** 是否启用了本地 reviewer（env 设了非空集）。 */
export function noeSelfEvolutionLocalReviewersEnabled() {
  return Array.isArray(noeSelfEvolutionReviewerIds());
}
