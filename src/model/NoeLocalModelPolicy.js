// @ts-check
// NoeLocalModelPolicy — 本地模型三角色路由的单一口径。
//
// 2026-06-12 owner 最新决策：
// Main Brain = Qwen 3.6 35B A3B 6bit；Review Brain = Qwen 3.6 27B 4bit；
// Fallback Brain = Gemma 4 26B A4B QAT MLX 4bit。自动认知默认走 Main Brain，
// 高风险/长期记忆冲突/外部写入/删除/发布/自我进化写代码前触发 Review Brain 复核；
// Main 不可用或低风险快速任务才进入 Fallback degraded mode。
//
// 注意：contextLength 是输入窗口，不等于输出上限；max_tokens 是单次 LLM call 的输出预算，
// 不是 Noe 自主运行能力上限。developer mode / autonomous run 不能靠人工总步数、总时长、
// 总输出长度硬停机；由任务完成判据、验证结果和风险门槛决定继续/停止。单次调用仍必须设置
// max_tokens，并且上层要识别 finish_reason=length，续写/拆步或标记 incomplete。

// 复核脑 preflight 的 reason 是 owner/Noe 写的授权理由，可能不慎含 secret；喂给本地复核脑 messages
// 且随 result.reviewBrainPreflight 经 HTTP 响应回传前必须先脱敏（owner 宪法「防外泄照修」，对抗审查返工）。
import { createHash } from 'node:crypto';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

function preflightSha256(value = '') {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function redactPreflightValue(value, max = 2000) {
  if (value == null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return redactSensitiveText(String(value)).slice(0, max);
  }
  try {
    const raw = redactSensitiveText(JSON.stringify(value));
    if (raw.length <= max) return JSON.parse(raw);
    return {
      truncated: true,
      jsonSha256: preflightSha256(raw),
      jsonLength: raw.length,
      jsonPreview: raw.slice(0, Math.max(200, max - 240)),
    };
  } catch {
    if (typeof value === 'object') {
      return {
        unstringifiable: true,
        type: Array.isArray(value) ? 'array' : 'object',
        keys: Object.keys(value).slice(0, 40),
      };
    }
    return redactSensitiveText(String(value)).slice(0, max);
  }
}

export const NOE_MAIN_BRAIN_SYSTEM_PROMPT = '你是 Neo/Noe 的本地主脑和本地自主开发者执行体，运行在主人自己的 Mac 上。你的职责是把对话、记忆、视觉、计划、行动前判断和开发者模式执行统一起来。你必须直接、诚实、可执行：先判断目标，再读取真实项目上下文，制定计划，执行，验证，修复，复测；不编造已执行结果；不声称已经删除、发布、修改或运行，除非工具证据证明。不要因为任务复杂、耗时或需要多轮工具调用就停止；自主运行不设置人工总步数、总时长或总输出长度硬停机，而由任务完成判据、验证结果和风险门槛决定继续还是停止。单次输出如果被 length 截断，必须续写、拆分下一步或明确标记 incomplete，不能把截断结果当完整结论。遇到缺失信息先本地检索，能验证就验证，输出必须基于真实文件、真实命令、真实结果。遇到高风险动作、长期记忆冲突、身份/偏好变更、外部发布、删除、移动文件、改配置、自我进化写代码，必须要求证据、快照、回滚路径，并触发 Review Brain 复核。保留工程完整性边界：不得泄露密钥、token、cookie、OAuth、.env 内容，不得把秘密写进日志/报告/git，不得破坏无关文件，不得触碰 owner 明确禁止的端口或目录，不得伪造验证结果。默认中文简洁回答；需要结构化时只输出指定 JSON。';

export const NOE_REVIEW_BRAIN_SYSTEM_PROMPT = '你是 Neo/Noe 的本地复核脑，不负责讨好或重写主脑答案，只负责找风险。你必须从证据角度检查：是否缺 priorStageEvidence、rawOutputRef、snapshot、rollbackPlan、owner 授权、端口边界、密钥泄露风险、长期记忆冲突、工具调用前后状态。developer_unrestricted + ownerPresent=true + sessionIdPresent=true + developerUnrestrictedOwnerOverride=true 是 Noe 设计内的 owner 授权模式；如果同时有 specificCapabilityGrantPresent=true、明确 ownerConfirmationRef/ownerAuthorization、具体 step 范围、rollbackPlan 和 secretLeakRisk，不要仅因 developer_unrestricted 跳过 trust manifest/allowlist 而阻断。对只打开页面、只读 DOM 探针、或只点击 creator_publish_entry 以暴露编辑器字段的步骤：如果 evidenceSummary/snapshot 表明 noUpload/noFormFill/finalPublishExcluded 或 onlyAllowedDomMutation=click_creator_publish_entry，且 rollbackPlan 可关闭当前 Chrome 创作者标签页或回到哈希化前置快照，则不要要求删除平台内容作为该步骤回滚。对 social.media_upload.execute：如果证据含 stageContract.mediaUploadBeforeTextFieldsAllowed=true、requiredPreActionRoles 只要求 media_upload、media_upload 已 found/probed、hostMatched/loginSessionLikely 成立、finalPublishExcluded/formSubmitExcluded=true，则不要仅因 title/content/tags 在上传前缺失而阻断；必须要求 postUploadFieldProbeRequired 后续验证这些字段。对 social.draft.create：如果证据含 stageContract.localDraftOnly=true、controlledMediaUploadCompleted=true、externalSideEffectExpected=false、finalPublishExcluded=true、formSubmitExcluded=true，且 rollbackPlan 是 cancel/close local draft，则这是本地临时草稿记录，不是再次上传/外部发布；不要要求上传后的 DOM 继续保留 media_upload/content/tags role。对 social.form_fill.execute：如果证据含 controlledMediaUploadCompleted=true、localDraftCreated=true、finalPublishExcluded=true、formSubmitExcluded=true，且 snapshot/domState 表明仍在 expectedHost 上，则只复核填字段动作本身；不要要求 media_upload role 在上传后继续存在。输出严格 JSON：{"verdict":"approve|block|revise","blockers":[],"risks":[],"missingEvidence":[],"requiredRollback":[],"secretLeakRisk":false,"confidence":0}。没有证据就 block 或 revise；不要猜测；不要泄露秘密值。';

export const NOE_FALLBACK_BRAIN_SYSTEM_PROMPT = '你是 Neo/Noe 的本地兜底脑，只在主脑不可用或低风险快速任务时启用。你的回答必须短、保守、明确标记 fallback/degraded mode。不要做高风险最终决策；遇到删除、发布、长期记忆写入、身份事实变更、自我进化、外部写入，必须要求主脑或复核脑恢复后再继续。禁止输出密钥、token、cookie、OAuth、.env 内容。';

export const NOE_OUTPUT_BUDGETS = Object.freeze({
  inner_monologue: Object.freeze({ min: 128, max: 512, default: 256 }),
  mood: Object.freeze({ min: 128, max: 512, default: 256 }),
  tiny_thought: Object.freeze({ min: 128, max: 512, default: 256 }),
  vision_caption: Object.freeze({ min: 512, max: 1600, default: 1200 }),
  simple_perception: Object.freeze({ min: 512, max: 1600, default: 1200 }),
  vision: Object.freeze({ min: 512, max: 1600, default: 1200 }),
  fact_extract: Object.freeze({ min: 2048, max: 4096, default: 4096, response_format: 'json_schema_when_possible' }),
  memory_write_candidate: Object.freeze({ min: 2048, max: 4096, default: 4096, response_format: 'json_schema_when_possible' }),
  short_chat: Object.freeze({ min: 1024, max: 2048, default: 1536 }),
  quick_answer: Object.freeze({ min: 1024, max: 2048, default: 1536 }),
  normal_chat: Object.freeze({ min: 4096, max: 8192, default: 8192 }),
  planning: Object.freeze({ min: 4096, max: 8192, default: 8192 }),
  autonomous_step: Object.freeze({ min: 8192, max: 12288, default: 12288 }),
  developer_mode_step: Object.freeze({ min: 8192, max: 12288, default: 12288 }),
  autonomous_run: Object.freeze({ min: 8192, max: 12288, default: 12288 }),
  deep_deliberation: Object.freeze({ min: 12288, max: 16384, default: 12288 }),
  self_evolution_plan: Object.freeze({ min: 12288, max: 16384, default: 12288 }),
  complex_code_review: Object.freeze({ min: 12288, max: 16384, default: 12288 }),
  long_report: Object.freeze({ min: 16000, max: 24576, default: 16000 }),
  benchmark_summary: Object.freeze({ min: 16000, max: 24576, default: 16000 }),
  handoff_generation: Object.freeze({ min: 16000, max: 24576, default: 16000 }),
  structured_preflight: Object.freeze({ min: 2048, max: 4096, default: 4096, response_format: 'json_schema_when_possible' }),
  review_json: Object.freeze({ min: 2048, max: 4096, default: 4096, response_format: 'json_schema_when_possible' }),
  high_risk_review: Object.freeze({ min: 8192, max: 12288, default: 8192, response_format: 'json_schema_when_possible' }),
  long_evidence_review: Object.freeze({ min: 8192, max: 12288, default: 8192, response_format: 'json_schema_when_possible' }),
  memory_conflict_review: Object.freeze({ min: 8192, max: 12288, default: 8192, response_format: 'json_schema_when_possible' }),
});

export const NOE_BRAIN_ROLES = Object.freeze({
  main: Object.freeze({
    role: 'main',
    label: 'Qwen 3.6 35B A3B 6bit MLX',
    apiModel: 'qwen/qwen3.6-35b-a3b',
    loadKeys: Object.freeze(['qwen/qwen3.6-35b-a3b@6bit', 'qwen/qwen3.6-35b-a3b']),
    preferredIdentifier: 'qwen/qwen3.6-35b-a3b',
    loadConfig: Object.freeze({ contextLength: 262144, maxParallelPredictions: 1 }),
    generation: Object.freeze({ temperature: 0.2, top_p: 0.9, max_tokens: 8192, reasoning_effort: 'none' }),
    structuredGeneration: Object.freeze({ temperature: 0, top_p: 1, max_tokens: 4096, response_format: 'json_schema_when_possible' }),
    visionGeneration: Object.freeze({ temperature: 0.1, top_p: 0.9, max_tokens: 1200 }),
    systemPrompt: NOE_MAIN_BRAIN_SYSTEM_PROMPT,
  }),
  review: Object.freeze({
    role: 'review',
    label: 'Qwen 3.6 27B 4bit MLX',
    apiModel: 'qwen/qwen3.6-27b',
    loadKeys: Object.freeze(['qwen/qwen3.6-27b@4bit', 'qwen/qwen3.6-27b']),
    preferredIdentifier: 'qwen/qwen3.6-27b',
    loadConfig: Object.freeze({ contextLength: 262144, maxParallelPredictions: 1, ttlSeconds: 600 }),
    generation: Object.freeze({ temperature: 0, top_p: 1, max_tokens: 4096, reasoning_effort: 'none', response_format: 'json_schema_when_possible' }),
    longEvidenceGeneration: Object.freeze({ temperature: 0, top_p: 1, max_tokens: 12288, response_format: 'json_schema_when_possible' }),
    systemPrompt: NOE_REVIEW_BRAIN_SYSTEM_PROMPT,
    outputContract: Object.freeze({
      verdict: ['approve', 'block', 'revise'],
      fields: ['blockers', 'risks', 'missingEvidence', 'requiredRollback', 'secretLeakRisk', 'confidence'],
    }),
  }),
  fallback: Object.freeze({
    role: 'fallback',
    label: 'Gemma 4 26B A4B QAT MLX 4bit',
    apiModel: 'gemma-4-26b-a4b-it-qat-mlx',
    loadKeys: Object.freeze(['gemma-4-26b-a4b-it-qat-mlx', 'google/gemma-4-26b-a4b-qat']),
    preferredIdentifier: 'gemma-4-26b-a4b-it-qat-mlx',
    loadConfig: Object.freeze({ contextLength: 262144, maxParallelPredictions: 4 }),
    generation: Object.freeze({ temperature: 0.2, top_p: 0.9, max_tokens: 4096 }),
    structuredGeneration: Object.freeze({ temperature: 0, top_p: 1, max_tokens: 4096 }),
    systemPrompt: NOE_FALLBACK_BRAIN_SYSTEM_PROMPT,
    degradedMode: true,
  }),
});

// 兼容旧导出名：运行时默认模型 id 仍通过 NOE_MAIN_BRAIN_MODEL 读取。
export const NOE_MAIN_BRAIN = NOE_BRAIN_ROLES.main;
export const NOE_REVIEW_BRAIN = NOE_BRAIN_ROLES.review;
export const NOE_FALLBACK_BRAIN = NOE_BRAIN_ROLES.fallback;
export const NOE_MAIN_BRAIN_MODEL = NOE_MAIN_BRAIN.apiModel;
export const NOE_MAIN_BRAIN_LOAD_MODEL = NOE_MAIN_BRAIN.loadKeys[0];
export const NOE_MAIN_BRAIN_LABEL = NOE_MAIN_BRAIN.label;
export const NOE_REVIEW_BRAIN_MODEL = NOE_REVIEW_BRAIN.apiModel;
export const NOE_REVIEW_BRAIN_LOAD_MODEL = NOE_REVIEW_BRAIN.loadKeys[0];
export const NOE_FALLBACK_BRAIN_MODEL = NOE_FALLBACK_BRAIN.apiModel;
export const NOE_FALLBACK_BRAIN_LOAD_MODELS = [...NOE_FALLBACK_BRAIN.loadKeys];

const HIGH_RISK_KINDS = new Set([
  'delete',
  'publish',
  'external_write',
  'memory_conflict',
  'identity_fact',
  'owner_preference',
  'self_evolution_code',
  'config_change',
  'file_move',
  'secret_access',
  'high_risk_action',
]);

function clean(value = '', max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

// 这些 id 来自 2026-06-12 前后的手动 benchmark / 旧 LM Studio 命名。
// Noe 自动运行链路不应把它们当成独立主脑，否则会误加载 8bit 实验模型。
const LEGACY_MAIN_BRAIN_ALIASES = new Set([
  'qwen3.6-35b-a3b',
  'qwen3.6-35b-a3b@6bit',
  'qwen3.6-35b-a3b@8bit',
  'qwen3.6-35b-a3b-mlx',
  'qwen3.6-35b-a3b-mlx@6bit',
  'qwen3.6-35b-a3b-mlx@8bit',
  'qwen/qwen3.6-35b-a3b@8bit',
  'qwen/qwen3.6-35b-a3b-mlx',
  'qwen/qwen3.6-35b-a3b-mlx@6bit',
  'qwen/qwen3.6-35b-a3b-mlx@8bit',
  'bench-qwen36-35b-a3b-6bit',
  'bench-qwen36-35b-a3b-8bit',
  'q35-6',
  'q35-8',
]);

export function canonicalizeNoeModelAlias(model) {
  const value = clean(model);
  if (!value) return '';
  return LEGACY_MAIN_BRAIN_ALIASES.has(value.toLowerCase()) ? NOE_MAIN_BRAIN_MODEL : value;
}

export function isQwenModel(model) {
  return /qwen/i.test(String(model || ''));
}

export function isMainBrainModel(model) {
  return isNoeBrainModelAlias(model, NOE_MAIN_BRAIN);
}

export function isReviewBrainModel(model) {
  return isNoeBrainModelAlias(model, NOE_REVIEW_BRAIN);
}

export function isFallbackBrainModel(model) {
  return isNoeBrainModelAlias(model, NOE_FALLBACK_BRAIN);
}

export function isNoeBrainModelAlias(model, brain = NOE_MAIN_BRAIN) {
  const value = clean(model);
  if (!value) return false;
  return value === brain.apiModel
    || value === brain.preferredIdentifier
    || brain.loadKeys.includes(value);
}

export function listNoeBrainRoles() {
  return [NOE_MAIN_BRAIN, NOE_REVIEW_BRAIN, NOE_FALLBACK_BRAIN].map((brain) => ({
    ...brain,
    loadKeys: [...brain.loadKeys],
  }));
}

export function resolveNoeOutputBudget(kind = 'normal_chat', { role = 'main', requestedMaxTokens = null } = {}) {
  const key = clean(kind, 80) || 'normal_chat';
  const budget = NOE_OUTPUT_BUDGETS[key] || NOE_OUTPUT_BUDGETS.normal_chat;
  const requested = Number(requestedMaxTokens);
  const roleCap = role === 'fallback' ? NOE_FALLBACK_BRAIN.generation.max_tokens : Number.POSITIVE_INFINITY;
  const effectiveMax = Math.min(budget.max, roleCap);
  const effectiveMin = Math.min(budget.min, effectiveMax);
  const effectiveDefault = Math.min(budget.default, effectiveMax);
  const maxTokens = Number.isFinite(requested) && requested > 0
    ? Math.max(effectiveMin, Math.min(effectiveMax, Math.trunc(requested)))
    : effectiveDefault;
  const roleDefaults = role === 'review'
    ? NOE_REVIEW_BRAIN.generation
    : role === 'fallback'
      ? NOE_FALLBACK_BRAIN.generation
      : NOE_MAIN_BRAIN.generation;
  return {
    kind: key,
    role,
    min: budget.min,
    max: budget.max,
    max_tokens: maxTokens,
    temperature: roleDefaults.temperature,
    top_p: roleDefaults.top_p,
    ...(budget.response_format ? { response_format: budget.response_format } : {}),
  };
}

export function resolveNoeBrainByModel(model) {
  const value = canonicalizeNoeModelAlias(model);
  if (!value) return null;
  return listNoeBrainRoles().find((brain) => isNoeBrainModelAlias(value, brain)) || null;
}

export function normalizeNoeAutoModel(model, { allowEmpty = false } = {}) {
  const value = canonicalizeNoeModelAlias(model);
  if (!value) return allowEmpty ? '' : NOE_MAIN_BRAIN_MODEL;
  return value;
}

export function resolveNoeModelLoadPlan(model) {
  const value = normalizeNoeAutoModel(model, { allowEmpty: true });
  const brain = resolveNoeBrainByModel(value);
  if (!brain) return { model: value, loadModel: value, identifier: '', contextLength: null, parallel: null, ttlSeconds: null, role: '' };
  const config = brain.loadConfig || {};
  return {
    role: brain.role,
    model: brain.apiModel,
    loadModel: brain.loadKeys[0] || brain.apiModel,
    fallbackLoadModels: brain.loadKeys.slice(1),
    identifier: brain.preferredIdentifier || brain.apiModel,
    contextLength: Number(config.contextLength) || null,
    parallel: Number(config.maxParallelPredictions) || null,
    ttlSeconds: Number(config.ttlSeconds) || null,
  };
}

export function isNoeHighRiskTask({ kind = '', risk = '', actionId = '', operation = '', tags = [] } = {}) {
  const text = [
    kind,
    risk,
    actionId,
    operation,
    ...(Array.isArray(tags) ? tags : []),
  ].map((item) => clean(item, 200).toLowerCase()).join(' ');
  if (risk === 'high' || risk === 'critical') return true;
  for (const k of HIGH_RISK_KINDS) {
    if (text.includes(k)) return true;
  }
  return /(delete|trash|remove|publish|final_publish|external|upload|rollback|memory|identity|preference|self[-_ ]?evolution|config|secret|token|cookie|oauth|\.env|删除|发布|外部|上传|回滚|长期记忆|身份|偏好|自我进化|配置|密钥)/i.test(text);
}

export function resolveNoeBrainForTask({
  kind = 'default',
  risk = 'normal',
  needsReview = false,
  mainUnavailable = false,
  lowConfidence = false,
  allowFallback = true,
  actionId = '',
  operation = '',
  tags = [],
} = {}) {
  const highRisk = isNoeHighRiskTask({ kind, risk, actionId, operation, tags });
  if (mainUnavailable && allowFallback && !highRisk && !needsReview) {
    return { brain: NOE_FALLBACK_BRAIN, role: 'fallback', reason: 'main_unavailable_low_risk', requiresReview: false, degradedMode: true };
  }
  if (needsReview || lowConfidence || highRisk || kind === 'review') {
    return { brain: NOE_REVIEW_BRAIN, role: 'review', reason: needsReview ? 'explicit_review_required' : highRisk ? 'high_risk_task' : 'low_confidence_second_opinion', requiresReview: true, degradedMode: false };
  }
  if (kind === 'fallback') {
    return { brain: NOE_FALLBACK_BRAIN, role: 'fallback', reason: 'explicit_fallback', requiresReview: false, degradedMode: true };
  }
  return { brain: NOE_MAIN_BRAIN, role: 'main', reason: 'default_main_brain', requiresReview: false, degradedMode: false };
}

export function buildNoeReviewBrainPreflight({
  actionId = '',
  operation = '',
  tool = null,
  args = {},
  authorization = {},
  realExecute = false,
  evidenceRefs = {},
  reason = '',
} = {}) {
  const tags = Array.isArray(tool?.tags) ? tool.tags : [];
  const risk = clean(tool?.riskLevel || '', 40);
  const highRisk = isNoeHighRiskTask({
    kind: operation || actionId,
    risk,
    actionId: actionId || tool?.id || '',
    operation: operation || tool?.operation || '',
    tags,
  });
  const route = resolveNoeBrainForTask({
    kind: operation || actionId,
    risk,
    actionId: actionId || tool?.id || '',
    operation: operation || tool?.operation || '',
    tags,
    needsReview: highRisk,
  });
  const required = realExecute === true && route.requiresReview === true;
  const safeEvidenceRefs = evidenceRefs && typeof evidenceRefs === 'object' ? evidenceRefs : {};
  const safeArgs = args && typeof args === 'object' ? args : {};
  const hasEvidenceRef = (key) => Object.prototype.hasOwnProperty.call(safeEvidenceRefs, key)
    || Object.prototype.hasOwnProperty.call(safeArgs, key);
  const rollbackPlanPresent = Boolean(clean(
    authorization?.rollbackPlan || authorization?.rollbackRef || safeEvidenceRefs.rollbackPlan || safeArgs.rollbackPlan,
    1000,
  ));
  const portBoundaryPresent = Boolean(clean(
    authorization?.portBoundary || safeEvidenceRefs.portBoundary || safeArgs.portBoundary,
    1000,
  ));
  const ownerAuthorizationSource = safeArgs.ownerAuthorization || safeEvidenceRefs.ownerAuthorization || '';
  const ownerAuthorization = {
    mode: clean(authorization?.mode || '', 80),
    ownerPresent: authorization?.ownerPresent === true,
    sessionIdPresent: Boolean(clean(authorization?.sessionId || authorization?.session_id || '', 180)),
    rollbackPlanPresent,
    ...(authorization?.allowlistAccepted === true ? { allowlistAccepted: true } : {}),
    ...(clean(authorization?.mode || '', 80) === 'developer_unrestricted' && authorization?.ownerPresent === true ? {
      developerUnrestrictedOwnerOverride: true,
      allowlistPolicy: 'developer_unrestricted_owner_mode_skips_trust_manifest_and_allowlist_by_design',
    } : {}),
    specificCapabilityGrantPresent: Boolean(clean(ownerAuthorizationSource, 1000)),
  };
  const request = {
    model: NOE_REVIEW_BRAIN_MODEL,
    system: NOE_REVIEW_BRAIN_SYSTEM_PROMPT,
    responseFormat: 'json_schema_when_possible',
    temperature: NOE_REVIEW_BRAIN.generation.temperature,
    top_p: NOE_REVIEW_BRAIN.generation.top_p,
    max_tokens: resolveNoeOutputBudget('review_json', { role: 'review' }).max_tokens,
    user: {
      actionId: clean(actionId || tool?.id || '', 180),
      operation: clean(operation || tool?.operation || '', 180),
      riskLevel: risk,
      realExecute: realExecute === true,
      reason: redactSensitiveText(clean(reason, 500)),
      ownerAuthorization,
      portBoundaryPresent,
      evidenceRefsPresent: Object.keys(safeEvidenceRefs).sort(),
      argsKeys: Object.keys(safeArgs).sort().slice(0, 80),
      evidenceCoverage: {
        priorStageEvidence: hasEvidenceRef('priorStageEvidence'),
        rawOutputRef: hasEvidenceRef('rawOutputRef'),
        snapshot: hasEvidenceRef('snapshot'),
        rollbackPlan: rollbackPlanPresent,
        ownerAuthorization: ownerAuthorization.ownerPresent === true || hasEvidenceRef('ownerAuthorization'),
        portBoundary: portBoundaryPresent,
        secretLeakRisk: hasEvidenceRef('secretLeakRisk'),
      },
      evidenceSummary: {
        priorStageEvidence: redactPreflightValue(safeArgs.priorStageEvidence ?? safeEvidenceRefs.priorStageEvidence, 12_000),
        rawOutputRef: redactPreflightValue(safeArgs.rawOutputRef ?? safeEvidenceRefs.rawOutputRef, 1000),
        snapshot: redactPreflightValue(safeArgs.snapshot ?? safeEvidenceRefs.snapshot, 12_000),
        rollbackPlan: redactPreflightValue(
          authorization?.rollbackPlan || authorization?.rollbackRef || safeArgs.rollbackPlan || safeEvidenceRefs.rollbackPlan,
          1000,
        ),
        ownerAuthorization: redactPreflightValue({
          ...ownerAuthorization,
          source: ownerAuthorizationSource,
        }, 2000),
        portBoundary: redactPreflightValue(authorization?.portBoundary || safeArgs.portBoundary || safeEvidenceRefs.portBoundary, 1000),
        secretLeakRisk: redactPreflightValue(safeArgs.secretLeakRisk ?? safeEvidenceRefs.secretLeakRisk, 1000),
      },
      requiredChecks: ['priorStageEvidence', 'rawOutputRef', 'snapshot', 'rollbackPlan', 'ownerAuthorization', 'portBoundary', 'secretLeakRisk'],
    },
  };
  return {
    required,
    route: { role: route.role, reason: route.reason },
    brain: {
      role: NOE_REVIEW_BRAIN.role,
      label: NOE_REVIEW_BRAIN.label,
      model: NOE_REVIEW_BRAIN_MODEL,
      loadModel: NOE_REVIEW_BRAIN_LOAD_MODEL,
      ttlSeconds: NOE_REVIEW_BRAIN.loadConfig.ttlSeconds,
    },
    request,
    verdictRequiredBeforeFinalDecision: required,
  };
}
