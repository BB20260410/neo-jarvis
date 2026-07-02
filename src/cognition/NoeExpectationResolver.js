// @ts-check
// NoeExpectationResolver — 期望到期自动判证（落地设计文档《AI自我意识实现方案》§7.5 P4 预留的
// "LLM 自动判证留给工作区阶段"）。
//
// 问题：期望账本 resolve() 此前只有两条出路——owner 在内心透视页人工裁决（现实中不会每天看）、
//   到期 7 天后 sweep 作废（outcome=NULL 不计分）→ 校准回路"有账无结"，Brier 长期为空，
//   "想完能校准"的反馈链断在最后一步（2026-06-11 实查：全库无 resolve 自动调用方）。
// 设计：心跳独立作业每跳取 due() 前 N 条，喂本地脑（深思/反刍白名单，绝不付费档）+ 创建之后的
//   行为/对话证据；模型只在证据明确时下 APPLIED/FAILED 结论 → ledger.resolve(id, 1|0) 进 Brier；
//   UNKNOWN 留账（人工裁决仍可覆盖，7 天 sweep 兜底）。空证据不进模型，错判比不判伤害大——宁缺勿错判。
// env：NOE_EXPECTATION_AUTORESOLVE=1 启用（默认 OFF，行为零变化）；
//      NOE_EXPECTATION_RESOLVE_MS 作业间隔（默认 1h，下限 10min）。

import { normalizeNoeAutoModel } from '../model/NoeLocalModelPolicy.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { DEGRADED_KEY as RECALL_DEGRADED_KEY } from './NoeExpectationSemanticRecall.js';

const RESOLVER_SYSTEM = [
  '你在替本地 AI「Noe」核对一条到期的自我预测是否应验。规则：',
  '- 只依据下面给出的证据下结论；证据不足、含糊、或只能靠推测时，必须回 UNKNOWN。',
  '- APPLIED = 证据明确显示预测应验。',
  '- FAILED = 证据明确显示预测落空（注意：仅"没检索到证据"不算落空，回 UNKNOWN）。',
  '- 如果安全判证提示给出 APPLIED/FAILED，但你仍回 UNKNOWN，必须用 reasonCode 说明原因，例如 claim_mismatch、conflicting_signals、insufficient_direct_evidence。',
  '- 裁决会进校准账本（Brier 分），错判比不判伤害大——拿不准一律 UNKNOWN。',
  '优先只回一行 JSON：{"verdict":"APPLIED|FAILED|UNKNOWN","reasonCode":"direct_success|direct_failure|claim_mismatch|conflicting_signals|insufficient_direct_evidence|observation_only|candidate_only|format_error","hintAgreement":"agree|override|not_applicable"}。',
  '兼容旧格式时才只回一个词：APPLIED / FAILED / UNKNOWN。',
].join('\n');
const STRUCTURED_PREFLIGHT_MAX_TOKENS = 4096;
const DECISIVE_REASK_SYSTEM = [
  '你在做 Noe 期望判证的二次复核。第一轮裁判回 UNKNOWN，但安全元数据已经给出高置信直接 action-result 语义链。',
  '这不是要求你盲从提示；你仍然只能依据证据。',
  '如果证据确实包含与预测语义直连的终态 action/result，且无冲突，必须给 APPLIED 或 FAILED。',
  '如果仍然不能采用提示，必须选择 claim_mismatch 或 conflicting_signals；不要在已有直接 action-result 语义链时继续用 insufficient_direct_evidence。',
  '只回一行 JSON：{"verdict":"APPLIED|FAILED|UNKNOWN","reasonCode":"direct_success|direct_failure|claim_mismatch|conflicting_signals|format_error","hintAgreement":"agree|override"}。',
].join('\n');

const ZH_VERDICTS = new Map([
  ['已应验', 1],
  ['应验', 1],
  ['已完成', 1],
  ['完成', 1],
  ['达成', 1],
  ['已达成', 1],
  ['实现', 1],
  ['已实现', 1],
  ['成立', 1],
  ['未应验', 0],
  ['不应验', 0],
  ['落空', 0],
  ['失败', 0],
  ['未完成', 0],
  ['没有完成', 0],
  ['未达成', 0],
  ['不成立', 0],
  ['未知', null],
  ['无法判断', null],
  ['证据不足', null],
  ['不确定', null],
]);

function safeVerdictTag(value, fallback = '') {
  const safe = String(value || '')
    .slice(0, 80)
    .replace(/[^A-Za-z0-9_.:-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return safe || fallback;
}

function verdictToOutcome(value) {
  const verdict = String(value || '').trim().toUpperCase();
  if (verdict === 'APPLIED') return { verdict, outcome: 1 };
  if (verdict === 'FAILED') return { verdict, outcome: 0 };
  if (verdict === 'UNKNOWN') return { verdict, outcome: null };
  return null;
}

function parseJsonVerdictDetail(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const normalized = verdictToOutcome(parsed.verdict);
  if (!normalized) return null;
  const prefix = normalized.verdict.toLowerCase();
  return {
    outcome: /** @type {1|0|null} */ (normalized.outcome),
    parser: `json_${prefix}`,
    verdictReasonCode: safeVerdictTag(parsed.reasonCode || parsed.reason_code || parsed.code, 'unspecified'),
    hintAgreement: safeVerdictTag(parsed.hintAgreement || parsed.hint_agreement, 'unspecified'),
  };
}

/**
 * Parse verdict plus parser reason without exposing model reply text.
 * Chinese verdicts are accepted only when the whole short reply is a verdict
 * token after removing punctuation and common labels.
 * @param {string} reply
 * @returns {{outcome: 1|0|null, parser: string, verdictReasonCode?: string, hintAgreement?: string}}
 */
export function parseVerdictDetail(reply) {
  const raw = String(reply || '');
  const jsonVerdict = parseJsonVerdictDetail(raw);
  if (jsonVerdict) return jsonVerdict;
  const hits = raw.toUpperCase().match(/APPLIED|FAILED|UNKNOWN/g);
  if (hits?.length) {
    const last = hits[hits.length - 1];
    if (last === 'APPLIED') return { outcome: 1, parser: 'en_applied' };
    if (last === 'FAILED') return { outcome: 0, parser: 'en_failed' };
    return { outcome: null, parser: 'en_unknown' };
  }
  const compact = raw
    .trim()
    .replace(/[ \t\r\n"'`{}[\](),，。.!！?？:：;；]/g, '')
    .replace(/^(裁决|结论|最终|答案|结果|VERDICT)/i, '');
  if (ZH_VERDICTS.has(compact)) {
    const outcome = /** @type {1|0|null} */ (ZH_VERDICTS.get(compact));
    if (outcome === 1) return { outcome, parser: 'zh_applied' };
    if (outcome === 0) return { outcome, parser: 'zh_failed' };
    return { outcome, parser: 'zh_unknown' };
  }
  return { outcome: null, parser: raw.trim() ? 'unparsed' : 'empty' };
}

/**
 * 从模型回复解析裁决：取最后一个出现的关键词（容忍思维链/废话前缀），无关键词视为 UNKNOWN。
 * @param {string} reply
 * @returns {1|0|null}
 */
export function parseVerdict(reply) {
  return parseVerdictDetail(reply).outcome;
}

/**
 * 文本切 2 字滑窗（bigram）集合：中文没有空格分词，按标点切只会得到难以命中的长块，
 * bigram 命中计数才能把「三天内能列出至少 5 个原始念头」对上「列出了原始念头清单」。
 * @param {string} s
 * @returns {Set<string>}
 */
function bigrams(s) {
  const out = new Set();
  for (const seg of String(s || '').replace(/[^\p{Script=Han}A-Za-z0-9]+/gu, ' ').split(/\s+/)) {
    if (seg.length < 2) continue;
    for (let i = 0; i < seg.length - 1; i += 1) out.add(seg.slice(i, i + 2));
  }
  return out;
}

const SAFE_CLAIM_NEEDLE_PREFIX = 'safe:';
const SAFE_CLAIM_NEEDLES = [
  {
    id: 'owner',
    claim: /(?:主人|用户|owner|operator|操作者)/iu,
    text: /(?:主人|用户|owner|operator|操作者)/iu,
  },
  {
    id: 'owner_visible',
    claim: /(?:可见|看到|owner[-_\s]?visible|visible)/iu,
    text: /(?:可见|看到|owner[-_\s]?visible|visible)/iu,
  },
  {
    id: 'delivery',
    claim: /(?:交付|送达|delivery|deliver|delivered|confirmed[-_\s]?delivery|p6ConfirmedDelivery)/iu,
    text: /(?:交付|送达|delivery|deliver|delivered|confirmed[-_\s]?delivery|p6ConfirmedDelivery)/iu,
  },
  {
    id: 'evidence',
    claim: /(?:证据|证明|proof|evidence|artifact)/iu,
    text: /(?:证据|证明|proof|evidence|artifact)/iu,
  },
  {
    id: 'reportback',
    claim: /(?:回报|汇报|报告|report[-_\s]?back|reportback|receipt|taskReceipt)/iu,
    text: /(?:回报|汇报|报告|report[-_\s]?back|reportback|receipt|taskReceipt)/iu,
  },
  {
    id: 'task',
    claim: /(?:任务|task|mission)/iu,
    text: /(?:任务|task|mission)/iu,
  },
  {
    id: 'checkpoint',
    claim: /(?:检查点|步骤|checkpoint|goal[-_\s]?step|step)/iu,
    text: /(?:检查点|步骤|checkpoint|goal[-_\s]?step|step)/iu,
  },
  {
    id: 'expectation',
    claim: /(?:期望|预测|expectation|claim|settlement|judgement|judgment)/iu,
    text: /(?:期望|预测|expectation|claim|settlement|judgement|judgment)/iu,
  },
  {
    id: 'social',
    claim: /(?:社交|微信|企业微信|飞书|qq|wechat|wecom|feishu|social)/iu,
    text: /(?:社交|微信|企业微信|飞书|qq|wechat|wecom|feishu|social)/iu,
  },
  {
    id: 'callback',
    claim: /(?:回调|webhook|callback)/iu,
    text: /(?:回调|webhook|callback)/iu,
  },
  {
    id: 'world',
    claim: /(?:地球|世界|态势|world|globe|radar)/iu,
    text: /(?:地球|世界|态势|world|globe|radar)/iu,
  },
  {
    id: 'readiness',
    claim: /(?:就绪|ready|readiness|health)/iu,
    text: /(?:就绪|ready|readiness|health)/iu,
  },
];

function safeClaimNeedleId(needle) {
  const raw = String(needle || '');
  return raw.startsWith(SAFE_CLAIM_NEEDLE_PREFIX) ? raw.slice(SAFE_CLAIM_NEEDLE_PREFIX.length) : '';
}

function splitClaimNeedles(needles = []) {
  const base = [];
  const safe = [];
  for (const needle of Array.isArray(needles) ? needles : []) {
    const id = safeClaimNeedleId(needle);
    if (id) safe.push(id);
    else base.push(String(needle || ''));
  }
  return { base, safe };
}

function claimBaseNeedleCount(needles = []) {
  return splitClaimNeedles(needles).base.length;
}

export function buildClaimLinkNeedles(s) {
  const out = bigrams(s);
  const raw = String(s || '');
  for (const item of SAFE_CLAIM_NEEDLES) {
    if (item.claim.test(raw)) out.add(`${SAFE_CLAIM_NEEDLE_PREFIX}${item.id}`);
  }
  return out;
}

function summarizeDetachedResult(value, { compact = false } = {}) {
  if (!value) return null;
  const result = value.result && typeof value.result === 'object' ? value.result : {};
  const judged = Array.isArray(result.judged)
    ? result.judged.map((j) => ({
      id: j?.id,
      outcome: j?.outcome ?? null,
      reason: String(j?.reason || 'unknown').slice(0, 80),
      ...(j?.evidenceStats && typeof j.evidenceStats === 'object'
        ? { evidenceStats: sanitizeEvidenceStats(j.evidenceStats) }
        : {}),
      ...(j?.evidenceSummary && typeof j.evidenceSummary === 'object'
        ? { evidenceSummary: compact ? compactEvidenceSummary(j.evidenceSummary) : sanitizeEvidenceSummary(j.evidenceSummary) }
        : {}),
      ...(!compact && j?.evidenceCandidateSummary && typeof j.evidenceCandidateSummary === 'object'
        ? { evidenceCandidateSummary: sanitizeEvidenceCandidateSummary(j.evidenceCandidateSummary) }
        : {}),
      ...(j?.evidenceClaimAlignment && typeof j.evidenceClaimAlignment === 'object'
        ? { evidenceClaimAlignment: compact ? compactEvidenceClaimAlignment(j.evidenceClaimAlignment) : sanitizeEvidenceClaimAlignment(j.evidenceClaimAlignment) }
        : {}),
      ...(j?.evidenceDecisionHint && typeof j.evidenceDecisionHint === 'object'
        ? { evidenceDecisionHint: compact ? compactEvidenceDecisionHint(j.evidenceDecisionHint) : sanitizeEvidenceDecisionHint(j.evidenceDecisionHint) }
        : {}),
      ...(j?.replyStats && typeof j.replyStats === 'object'
        ? { replyStats: sanitizeReplyStats(j.replyStats) }
        : {}),
      ...(j?.verdictParser ? { verdictParser: String(j.verdictParser).slice(0, 40) } : {}),
      ...(j?.verdictReasonCode ? { verdictReasonCode: safeVerdictTag(j.verdictReasonCode, 'unknown') } : {}),
      ...(j?.hintAgreement ? { hintAgreement: safeVerdictTag(j.hintAgreement, 'unknown') } : {}),
      ...(summarizeDecisiveReask(j?.decisiveReask, { compact })
        ? { decisiveReask: summarizeDecisiveReask(j.decisiveReask, { compact }) }
        : {}),
      ...(j?.finishReason ? { finishReason: String(j.finishReason).slice(0, 80) } : {}),
    }))
    : [];
  return {
    ok: Boolean(value.ok),
    at: Number(value.at) || null,
    checked: Number(result.checked) || 0,
    resolved: Number(result.resolved) || 0,
    judged,
    ...(result.reason ? { reason: String(result.reason).slice(0, 80) } : {}),
    ...(result.cooldownOnly === true ? { cooldownOnly: true } : {}),
    ...(Number.isFinite(Number(result.cooldownCount)) ? { cooldownCount: Number(result.cooldownCount) } : {}),
    ...(Number.isFinite(Number(result.nextReadyAt)) ? { nextReadyAt: Number(result.nextReadyAt) } : {}),
    ...(value.error ? { error: redactSensitiveText(String(value.error)).slice(0, 160) } : {}),
  };
}

function sanitizeEvidenceStats(value) {
  const chars = Math.max(0, Math.min(1800, Math.round(Number(value?.chars) || 0)));
  const lines = Math.max(0, Math.min(100, Math.round(Number(value?.lines) || 0)));
  return { chars, lines };
}

function evidenceStats(text) {
  const body = String(text || '');
  if (!body.trim()) return { chars: 0, lines: 0 };
  const lines = body.split(/\n+/).filter((line) => line.trim()).length;
  return sanitizeEvidenceStats({ chars: body.length, lines });
}

function sanitizeReplyStats(value) {
  const chars = Math.max(0, Math.min(4096, Math.round(Number(value?.chars) || 0)));
  const lines = Math.max(0, Math.min(100, Math.round(Number(value?.lines) || 0)));
  return { chars, lines };
}

function replyStats(text) {
  const body = String(text || '');
  if (!body.trim()) return { chars: 0, lines: 0 };
  const lines = body.split(/\n+/).filter((line) => line.trim()).length;
  return sanitizeReplyStats({ chars: body.length, lines });
}

function compactCountEntries(map, keyName) {
  return [...map.entries()]
    .map(([key, count]) => ({ [keyName]: key, count }))
    .sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])))
    .slice(0, 8);
}

function safeEvidenceTag(value, max = 96) {
  return redactSensitiveText(String(value || ''))
    .replace(/\s+/g, ' ')
    .replace(/[^\p{Letter}\p{Number}_.:=\-[\] ]+/gu, '_')
    .slice(0, max)
    .trim();
}

function sanitizeSummaryCountEntries(items, keyName) {
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const value = safeEvidenceTag(item?.[keyName], 96);
      const count = Math.max(0, Math.min(999, Math.round(Number(item?.count) || 0)));
      return value && count > 0 ? { [keyName]: value, count } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.count - a.count || String(a[keyName]).localeCompare(String(b[keyName])))
    .slice(0, 8);
}

function evidenceSummaryHasAction(kinds = []) {
  return kinds.some((item) => /act|action|execut|checkpoint|goal/i.test(String(item.kind || '')));
}

function evidenceSummaryHasObservation(kinds = []) {
  return kinds.some((item) => /episode|thought|reflection|observation|self_talk|memory/i.test(String(item.kind || '')));
}

function evidenceSummaryHasResultSignal(signals = []) {
  return signals.some((item) => /^(status|outcome|result|reason|error|ok|completed|failed|episodeType|streamType|guard\.action|guard\.state|grounding\.score_bucket)=/i.test(String(item.signal || '')));
}

function sanitizeEvidenceSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const scanned = Math.max(0, Math.min(10_000, Math.round(Number(value.scanned) || 0)));
  const matched = Math.max(0, Math.min(100, Math.round(Number(value.matched) || 0)));
  const kinds = sanitizeSummaryCountEntries(value.kinds, 'kind');
  const signals = sanitizeSummaryCountEntries(value.signals, 'signal');
  return {
    scanned,
    matched,
    kinds,
    signals,
    hasActionEvent: value.hasActionEvent === true || evidenceSummaryHasAction(kinds),
    hasObservationEvent: value.hasObservationEvent === true || evidenceSummaryHasObservation(kinds),
    hasResultSignal: value.hasResultSignal === true || evidenceSummaryHasResultSignal(signals),
  };
}

function compactEvidenceSummary(value) {
  const summary = sanitizeEvidenceSummary(value);
  if (!summary) return null;
  return {
    scanned: summary.scanned,
    matched: summary.matched,
    kinds: summary.kinds.slice(0, 3),
    signals: summary.signals
      .filter((item) => /^(status|outcome|result|ok|completed|failed|error)=/i.test(String(item.signal || '')))
      .slice(0, 4),
    hasActionEvent: summary.hasActionEvent,
    hasObservationEvent: summary.hasObservationEvent,
    hasResultSignal: summary.hasResultSignal,
  };
}

function sanitizeCandidateLinkStats(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    method: safeEvidenceTag(value.method || 'claim_bigram_overlap_v2_semantic_fields', 64) || 'claim_bigram_overlap_v2_semantic_fields',
    claimGrams: Math.max(0, Math.min(1_000, Math.round(Number(value.claimGrams) || 0))),
    scoredCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.scoredCandidates) || 0))),
    linkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.linkedCandidates) || 0))),
    weakCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.weakCandidates) || 0))),
    unlinkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.unlinkedCandidates) || 0))),
    maxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.maxHits) || 0))),
    maxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.maxCoverage) || 0) * 1000) / 1000)),
    semanticLinkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticLinkedCandidates) || 0))),
    semanticWeakCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticWeakCandidates) || 0))),
    semanticUnlinkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticUnlinkedCandidates) || 0))),
    semanticMaxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.semanticMaxHits) || 0))),
    semanticMaxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.semanticMaxCoverage) || 0) * 1000) / 1000)),
    semanticTraceLinkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceLinkedCandidates) || 0))),
    semanticTraceWeakCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceWeakCandidates) || 0))),
    semanticTraceUnlinkedCandidates: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceUnlinkedCandidates) || 0))),
    semanticTraceMaxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.semanticTraceMaxHits) || 0))),
    semanticTraceMaxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.semanticTraceMaxCoverage) || 0) * 1000) / 1000)),
  };
}

function sanitizeEvidenceCandidateSummary(value) {
  if (!value || typeof value !== 'object') return null;
  const nearest = value.nearestDeltaMs && typeof value.nearestDeltaMs === 'object' ? value.nearestDeltaMs : {};
  const kinds = sanitizeSummaryCountEntries(value.kinds, 'kind');
  const signals = sanitizeSummaryCountEntries(value.signals, 'signal');
  const kindCandidateCount = kinds.reduce((sum, item) => sum + Math.max(0, Number(item.count) || 0), 0);
  const candidates = Math.max(Math.round(Number(value.candidates) || 0), kindCandidateCount);
  const linkStats = sanitizeCandidateLinkStats(value.linkStats);
  return {
    scanned: Math.max(0, Math.min(10_000, Math.round(Number(value.scanned) || 0))),
    candidates: Math.max(0, Math.min(10_000, candidates)),
    windowMs: Math.max(0, Math.min(86_400_000, Math.round(Number(value.windowMs) || 0))),
    kinds,
    signals,
    ...(linkStats ? { linkStats } : {}),
    nearestDeltaMs: {
      min: Number.isFinite(Number(nearest.min)) ? Math.max(0, Math.round(Number(nearest.min))) : null,
      max: Number.isFinite(Number(nearest.max)) ? Math.max(0, Math.round(Number(nearest.max))) : null,
      avg: Number.isFinite(Number(nearest.avg)) ? Math.max(0, Math.round(Number(nearest.avg))) : null,
    },
  };
}

function sanitizeEvidenceClaimAlignment(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {
    method: safeEvidenceTag(value.method || 'claim_bigram_overlap_v2_semantic_fields', 64) || 'claim_bigram_overlap_v2_semantic_fields',
    claimGrams: Math.max(0, Math.min(1_000, Math.round(Number(value.claimGrams) || 0))),
    matchedEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.matchedEvents) || 0))),
    actionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.actionEvents) || 0))),
    observationEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.observationEvents) || 0))),
    resultEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.resultEvents) || 0))),
    resultActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.resultActionEvents) || 0))),
    linkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.linkedActionEvents) || 0))),
    weakActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.weakActionEvents) || 0))),
    unlinkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.unlinkedActionEvents) || 0))),
    maxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.maxHits) || 0))),
    maxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.maxCoverage) || 0) * 1000) / 1000)),
    actionMaxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.actionMaxHits) || 0))),
    actionMaxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.actionMaxCoverage) || 0) * 1000) / 1000)),
    semanticActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticActionEvents) || 0))),
    semanticResultActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticResultActionEvents) || 0))),
    semanticLinkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticLinkedActionEvents) || 0))),
    semanticWeakActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticWeakActionEvents) || 0))),
    semanticUnlinkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticUnlinkedActionEvents) || 0))),
    semanticActionMaxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.semanticActionMaxHits) || 0))),
    semanticActionMaxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.semanticActionMaxCoverage) || 0) * 1000) / 1000)),
    semanticTraceEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceEvents) || 0))),
    semanticTraceActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceActionEvents) || 0))),
    semanticTraceResultActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceResultActionEvents) || 0))),
    semanticTraceLinkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceLinkedActionEvents) || 0))),
    semanticTraceWeakActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceWeakActionEvents) || 0))),
    semanticTraceUnlinkedActionEvents: Math.max(0, Math.min(10_000, Math.round(Number(value.semanticTraceUnlinkedActionEvents) || 0))),
    semanticTraceMaxHits: Math.max(0, Math.min(1_000, Math.round(Number(value.semanticTraceMaxHits) || 0))),
    semanticTraceMaxCoverage: Math.max(0, Math.min(1, Math.round((Number(value.semanticTraceMaxCoverage) || 0) * 1000) / 1000)),
  };
  // R2+R3 可观测：embed 字段仅在确有 embed 召回时输出，避免 OFF 路径 evidence 文本无谓增长（防 judgeOne slice(1800) 把时间线尾部截掉）
  const embedRecalled = Math.max(0, Math.min(10_000, Math.round(Number(value.embedRecalledActionEvents) || 0)));
  if (embedRecalled > 0) {
    out.embedRecalledActionEvents = embedRecalled;
    out.embedActionMaxCoverage = Math.max(0, Math.min(1, Math.round((Number(value.embedActionMaxCoverage) || 0) * 1000) / 1000));
  }
  return out;
}

function compactEvidenceClaimAlignment(value) {
  const alignment = sanitizeEvidenceClaimAlignment(value);
  if (!alignment) return null;
  return {
    method: alignment.method,
    claimGrams: alignment.claimGrams,
    matchedEvents: alignment.matchedEvents,
    actionEvents: alignment.actionEvents,
    resultActionEvents: alignment.resultActionEvents,
    actionMaxCoverage: alignment.actionMaxCoverage,
    semanticActionEvents: alignment.semanticActionEvents,
    semanticResultActionEvents: alignment.semanticResultActionEvents,
    semanticLinkedActionEvents: alignment.semanticLinkedActionEvents,
    semanticActionMaxCoverage: alignment.semanticActionMaxCoverage,
    semanticTraceActionEvents: alignment.semanticTraceActionEvents,
    semanticTraceResultActionEvents: alignment.semanticTraceResultActionEvents,
    semanticTraceLinkedActionEvents: alignment.semanticTraceLinkedActionEvents,
    semanticTraceMaxCoverage: alignment.semanticTraceMaxCoverage,
    ...(alignment.embedRecalledActionEvents > 0 ? { embedRecalledActionEvents: alignment.embedRecalledActionEvents, embedActionMaxCoverage: alignment.embedActionMaxCoverage } : {}),
  };
}

function countSummaryMatches(items, keyName, re) {
  if (!Array.isArray(items)) return 0;
  return items.reduce((sum, item) => {
    const label = String(item?.[keyName] || '');
    const count = Math.max(0, Math.round(Number(item?.count) || 0));
    return re.test(label) ? sum + count : sum;
  }, 0);
}

function sanitizeDecisionProfile(value) {
  const profile = value && typeof value === 'object' ? value : {};
  const out = {};
  const countKeys = [
    'matched',
    'actionKinds',
    'observationKinds',
    'actionResultSignals',
    'observationSignals',
    'successSignals',
    'failureSignals',
    'runningSignals',
    'linkedCandidates',
    'weakCandidates',
    'claimGrams',
    'actionEvents',
    'resultActionEvents',
    'linkedActionEvents',
    'semanticActionEvents',
    'semanticResultActionEvents',
    'semanticLinkedActionEvents',
    'semanticTraceActionEvents',
    'semanticTraceResultActionEvents',
    'semanticTraceLinkedActionEvents',
  ];
  const coverageKeys = [
    'actionMaxCoverage',
    'semanticActionMaxCoverage',
    'semanticTraceMaxCoverage',
  ];
  for (const key of countKeys) {
    out[key] = Math.max(0, Math.min(10_000, Math.round(Number(profile[key]) || 0)));
  }
  for (const key of coverageKeys) {
    out[key] = Math.max(0, Math.min(1, Math.round((Number(profile[key]) || 0) * 1000) / 1000));
  }
  return out;
}

function sanitizeEvidenceDecisionHint(value) {
  if (!value || typeof value !== 'object') return null;
  const label = safeEvidenceTag(value.label || 'unknown_hint', 80) || 'unknown_hint';
  const confidence = safeEvidenceTag(value.confidence || 'none', 24) || 'none';
  const suggestedVerdict = safeEvidenceTag(value.suggestedVerdict || 'UNKNOWN', 16) || 'UNKNOWN';
  const caution = safeEvidenceTag(value.caution || 'strict_evidence_only', 96) || 'strict_evidence_only';
  return {
    label,
    confidence,
    suggestedVerdict: ['APPLIED', 'FAILED', 'UNKNOWN'].includes(suggestedVerdict) ? suggestedVerdict : 'UNKNOWN',
    caution,
    profile: sanitizeDecisionProfile(value.profile),
  };
}

function compactEvidenceDecisionHint(value) {
  const safe = sanitizeEvidenceDecisionHint(value);
  if (!safe) return null;
  return {
    label: safe.label,
    suggestedVerdict: safe.suggestedVerdict,
  };
}

// 失败结果信号正则。BASE = 现行严格集（保守默认）。LOOSE = BASE 超集，额外认「跑了但没成功」的
// 终态负面词（cancelled/aborted/denied/killed/expired/unsuccessful + cancelled/aborted/timeout=true）；
// 刻意不含 not_found/notfound（那是「没检索到证据」≠落空，与判证宪法一致）。LOOSE 仅由
// NOE_EXPECT_LOOSEN_FAIL=1 经 buildEvidenceDecisionHint 的 failureSignalRe 注入；OFF 时永远用 BASE，
// 判证 profile 逐字不变。注意：放宽只让「FAILED 信号提示」更易出现——是否真落账成 0 仍需模型确认 + claim
// 语义直连（caution/RESOLVER_SYSTEM 未改），绝不伪造结算。
const FAILURE_SIGNAL_RE = /^(?:status|outcome|result)=(?:failed|failure|error|blocked|rejected|timeout)$|^(?:failed|error)=true$|^ok=false$/i;
const FAILURE_SIGNAL_RE_LOOSE = /^(?:status|outcome|result)=(?:failed|failure|error|blocked|rejected|timeout|cancelled|canceled|aborted|denied|killed|expired|unsuccessful)$|^(?:failed|error|cancelled|canceled|aborted|timeout)=true$|^ok=false$/i;

// P1-C 整改（双代理验收 F1+F2）：surprise 来源分桶——据预测 source + loosen 检测推导 origin，供验收门 b 区分非噪声。
export const SURPRISE_ORIGIN_ENUM = Object.freeze(['loosen_fail', 'owner_prediction', 'owner_manual', 'owner_correction', 'reflection_miss', 'action_failure', 'expectation_miss', 'world_model_conflict']);
export function deriveSurpriseOrigin(source, { loosenOnly = false } = {}) {
  if (loosenOnly) return 'loosen_fail'; // F1：仅因 NOE_EXPECT_LOOSEN_FAIL 放宽失败正则才认的落空 = 门 b 要剔除的噪声
  const s = String(source || '').toLowerCase();
  if (/owner|followup/.test(s)) return 'owner_prediction';
  if (/reflect/.test(s)) return 'reflection_miss';
  if (/(?:^|[._:\s-])(?:act|action|goal|task|execut|step|checkpoint)(?=$|[._:\s-])/.test(s)) return 'action_failure'; // 复核 DERIVE-REGEX：分隔符词界防 transaction/interaction/steps 子串误命中
  return 'expectation_miss'; // F2：thought/self-obs 等非 action 预测不再被误标 action_failure
}
// P1-C 整改 F3 + 阶段1 P1：验收门 b 判据——owner_*/action_failure/world_model_conflict 是「非噪声」epistemic surprise；
//   loosen_fail/reflection_miss/expectation_miss 不计。world_model_conflict=读到内容与认知矛盾(信息层源，最纯 epistemic)。
export function isNonNoiseSurpriseOrigin(origin) {
  return /^owner_|^action_failure$|^world_model_conflict$/.test(String(origin || ''));
}
// loosen-only 失败：evidence 含 loose 专属失败词(cancelled/aborted/…)但不含 base 失败词(failed/error/…)→ 该落空仅靠放宽正则才认成
export function isLoosenOnlyFailure(evidenceText, loosenFail) {
  if (!loosenFail || !evidenceText) return false;
  const hasBase = /\b(?:failed|failure|error|blocked|rejected|timeout)\b|\bok=false\b|\b(?:failed|error)=true\b/i.test(evidenceText); // 复核 F1-HASBASE：补 BASE 结构化信号(ok=false/failed=true/error=true)，仅含结构化真失败不被误判 loosen-only 噪声
  const hasLooseOnly = /\b(?:cancelled|canceled|aborted|denied|killed|expired|unsuccessful)\b/i.test(evidenceText);
  return hasLooseOnly && !hasBase;
}

function buildEvidenceDecisionHint(evidenceSummary, evidenceCandidateSummary, evidenceClaimAlignment, failureSignalRe = FAILURE_SIGNAL_RE) {
  if (!evidenceSummary) return null;
  const kinds = Array.isArray(evidenceSummary.kinds) ? evidenceSummary.kinds : [];
  const signals = Array.isArray(evidenceSummary.signals) ? evidenceSummary.signals : [];
  const linkStats = evidenceCandidateSummary?.linkStats || {};
  const alignment = sanitizeEvidenceClaimAlignment(evidenceClaimAlignment);
  const profile = {
    matched: Math.max(0, Math.round(Number(evidenceSummary.matched) || 0)),
    actionKinds: countSummaryMatches(kinds, 'kind', /act|action|execut|checkpoint|goal/i),
    observationKinds: countSummaryMatches(kinds, 'kind', /episode|thought|reflection|observation|self_talk|memory/i),
    actionResultSignals: countSummaryMatches(signals, 'signal', /^(status|outcome|result|ok|completed|failed|error)=/i),
    observationSignals: countSummaryMatches(signals, 'signal', /^(episodeType|streamType|guard\.action|guard\.state|grounding\.score_bucket)=/i),
    successSignals: countSummaryMatches(signals, 'signal', /^(?:status|outcome|result)=(?:succeeded|success|completed|done|passed|applied)$|^(?:ok|completed)=true$/i),
    failureSignals: countSummaryMatches(signals, 'signal', failureSignalRe),
    runningSignals: countSummaryMatches(signals, 'signal', /^(?:status|outcome|result)=(?:running|started|pending|in_progress|queued)$/i),
    linkedCandidates: Math.max(0, Math.round(Number(linkStats.linkedCandidates) || 0)),
    weakCandidates: Math.max(0, Math.round(Number(linkStats.weakCandidates) || 0)),
    ...(alignment ? {
      claimGrams: alignment.claimGrams,
      actionEvents: alignment.actionEvents,
      resultActionEvents: alignment.resultActionEvents,
      linkedActionEvents: alignment.linkedActionEvents,
      actionMaxCoverage: alignment.actionMaxCoverage,
      semanticActionEvents: alignment.semanticActionEvents,
      semanticResultActionEvents: alignment.semanticResultActionEvents,
      semanticLinkedActionEvents: alignment.semanticLinkedActionEvents,
      semanticActionMaxCoverage: alignment.semanticActionMaxCoverage,
      semanticTraceActionEvents: alignment.semanticTraceActionEvents,
      semanticTraceResultActionEvents: alignment.semanticTraceResultActionEvents,
      semanticTraceLinkedActionEvents: alignment.semanticTraceLinkedActionEvents,
      semanticTraceMaxCoverage: alignment.semanticTraceMaxCoverage,
    } : {}),
  };
  const hint = (label, confidence, suggestedVerdict, caution) => sanitizeEvidenceDecisionHint({
    label,
    confidence,
    suggestedVerdict,
    caution,
    profile,
  });
  if (profile.matched <= 0) return hint('no_matched_evidence', 'none', 'UNKNOWN', 'improve_matching_before_judgement');
  if (!evidenceSummary.hasResultSignal) return hint('no_result_signal', 'none', 'UNKNOWN', 'need_status_or_result_signal');
  if (profile.successSignals > 0 && profile.failureSignals > 0) {
    return hint('mixed_action_result_signal', 'medium', 'UNKNOWN', 'resolve_conflicting_result_signals_first');
  }
  if (profile.successSignals > 0) {
    const directSemanticLink = profile.resultActionEvents > 0
      && (profile.semanticLinkedActionEvents > 0 || profile.semanticTraceLinkedActionEvents > 0);
    return hint(
      'action_success_signal',
      directSemanticLink || profile.matched >= 2 ? 'high' : 'medium',
      'APPLIED',
      directSemanticLink ? 'direct_action_semantic_link_present_strict_conflict_check' : 'only_if_claim_matches_direct_action_evidence',
    );
  }
  if (profile.failureSignals > 0) {
    const directSemanticLink = profile.resultActionEvents > 0
      && (profile.semanticLinkedActionEvents > 0 || profile.semanticTraceLinkedActionEvents > 0);
    return hint(
      'action_failure_signal',
      directSemanticLink || profile.matched >= 2 ? 'high' : 'medium',
      'FAILED',
      directSemanticLink ? 'direct_action_semantic_link_present_strict_conflict_check' : 'only_if_claim_matches_direct_action_evidence',
    );
  }
  if (profile.runningSignals > 0 && profile.actionResultSignals > 0) {
    return hint('action_running_only', 'low', 'UNKNOWN', 'wait_for_terminal_result');
  }
  if (!evidenceSummary.hasActionEvent && profile.linkedCandidates > 0) {
    return hint('candidate_result_linked_hint', 'low', 'UNKNOWN', 'candidate_requires_promotion_audit');
  }
  if (!evidenceSummary.hasActionEvent && profile.observationSignals > 0) {
    return hint('observation_only_result_signal', 'low', 'UNKNOWN', 'need_direct_action_or_external_result');
  }
  if (profile.actionResultSignals > 0) {
    return hint('ambiguous_action_result_signal', 'medium', 'UNKNOWN', 'refine_safe_result_metadata');
  }
  return hint('ambiguous_result_signal', 'low', 'UNKNOWN', 'strict_unknown_until_decisive');
}

function formatEvidenceDecisionHint(hint) {
  const safe = sanitizeEvidenceDecisionHint(hint);
  if (!safe) return '';
  const p = safe.profile || {};
  const hasDirectActionLink = Number(p.resultActionEvents || 0) > 0
    && (Number(p.semanticLinkedActionEvents || 0) > 0 || Number(p.semanticTraceLinkedActionEvents || 0) > 0);
  const alignmentLine = hasDirectActionLink
    ? `直接行动对齐计数：actionEvents=${p.actionEvents}, resultActionEvents=${p.resultActionEvents}, semanticLinkedActionEvents=${p.semanticLinkedActionEvents}, semanticTraceLinkedActionEvents=${p.semanticTraceLinkedActionEvents}, semanticActionMaxCoverage=${p.semanticActionMaxCoverage}, semanticTraceMaxCoverage=${p.semanticTraceMaxCoverage}`
    : '';
  return [
    `安全判证提示：${JSON.stringify(safe)}`,
    ...(alignmentLine ? [alignmentLine] : []),
    '提示使用规则：提示只来自脱敏元数据，不替代裁决；只有预测文本与直接 action 证据语义一致且无冲突时才采用 suggestedVerdict；observation/candidate-only 仍回 UNKNOWN。',
    ...(alignmentLine ? ['直接行动对齐计数表示已有终态 action/result 与预测语义相连；不要仅因覆盖率偏低或观察噪声裁成 claim_mismatch，若仍缺少直接对应或存在冲突则保持 UNKNOWN。'] : []),
  ].join('\n');
}

function shouldRunDecisiveReask(verdict, hint) {
  if (verdict?.outcome === 1 || verdict?.outcome === 0) return false;
  const safe = sanitizeEvidenceDecisionHint(hint);
  if (!safe) return false;
  const p = safe.profile || {};
  const label = safe.label;
  const suggested = safe.suggestedVerdict;
  const directActionResultLink = Number(p.resultActionEvents || 0) > 0
    && (Number(p.semanticLinkedActionEvents || 0) > 0 || Number(p.semanticTraceLinkedActionEvents || 0) > 0);
  if (!directActionResultLink || safe.confidence !== 'high') return false;
  if (label === 'action_success_signal' && suggested === 'APPLIED') {
    return Number(p.successSignals || 0) > 0 && Number(p.failureSignals || 0) === 0;
  }
  if (label === 'action_failure_signal' && suggested === 'FAILED') {
    return Number(p.failureSignals || 0) > 0 && Number(p.successSignals || 0) === 0;
  }
  return false;
}

function sanitizeDecisiveReask(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    attempted: value.attempted === true,
    firstParser: safeVerdictTag(value.firstParser, 'unknown'),
    firstReasonCode: safeVerdictTag(value.firstReasonCode, 'unspecified'),
    firstHintAgreement: safeVerdictTag(value.firstHintAgreement, 'unspecified'),
    secondParser: safeVerdictTag(value.secondParser, 'unknown'),
    secondReasonCode: safeVerdictTag(value.secondReasonCode, 'unspecified'),
    secondHintAgreement: safeVerdictTag(value.secondHintAgreement, 'unspecified'),
    outcome: value.outcome === 1 ? 1 : value.outcome === 0 ? 0 : null,
  };
}

function compactDecisiveReask(value) {
  const safe = sanitizeDecisiveReask(value);
  if (!safe) return null;
  return {
    attempted: safe.attempted,
    outcome: safe.outcome,
    secondReasonCode: safe.secondReasonCode,
    secondHintAgreement: safe.secondHintAgreement,
  };
}

function summarizeDecisiveReask(value, { compact = false } = {}) {
  if (!value) return null;
  if (!compact) return sanitizeDecisiveReask(value);
  const short = compactDecisiveReask(value);
  return short?.outcome === 1 || short?.outcome === 0 ? short : null;
}

function formatDecisiveReaskPrompt({ exp, evidenceText, hint, verdict }) {
  const safeClaim = redactSensitiveText(exp.claim).slice(0, 300);
  const safeHint = sanitizeEvidenceDecisionHint(hint);
  const first = {
    parser: safeVerdictTag(verdict?.parser, 'unknown'),
    reasonCode: safeVerdictTag(verdict?.verdictReasonCode, 'unspecified'),
    hintAgreement: safeVerdictTag(verdict?.hintAgreement, 'unspecified'),
  };
  return [
    `预测（创建于 ${new Date(Number(exp.created_at)).toLocaleString('zh-CN')}，截止 ${new Date(Number(exp.due_at)).toLocaleString('zh-CN')}，当时主观概率 ${exp.p}）：`,
    safeClaim,
    '',
    '第一轮裁判元数据（不含原始回复）：',
    JSON.stringify(first),
    '',
    '安全判证提示（脱敏元数据）：',
    JSON.stringify(safeHint),
    '',
    '同一批行为/对话证据：',
    evidenceText || '（没有检索到相关证据）',
    '',
    '二次裁决（只回一行 JSON）：',
  ].join('\n');
}

function payloadText(payload) {
  if (typeof payload === 'string') return payload;
  try { return JSON.stringify(payload || {}); } catch { return String(payload || ''); }
}

const SEMANTIC_PAYLOAD_KEY_RE = /^(?:claim|title|name|summary|description|text|content|message|body|detail|details|note|notes|task|goal|action|intent|plan|checkpoint|expectation|commitment|output|stdoutSummary|stderrSummary)$/i;
const SENSITIVE_PAYLOAD_KEY_RE = /(?:api[_-]?key|token|secret|password|passwd|cookie|authorization|oauth)/i;

function payloadSemanticText(payload) {
  if (typeof payload === 'string') return payload;
  const parts = [];
  const visit = (value, semanticParent = false, key = '') => {
    if (value == null) return;
    if (SENSITIVE_PAYLOAD_KEY_RE.test(String(key || ''))) return;
    if (String(key || '').toLowerCase() === 'fingerprint') return;
    if (typeof value === 'string' || typeof value === 'number') {
      if (semanticParent) parts.push(String(value));
      return;
    }
    if (typeof value === 'boolean') return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, semanticParent, key);
      return;
    }
    if (typeof value !== 'object') return;
    for (const [childKey, childValue] of Object.entries(value)) {
      const nextSemantic = semanticParent || SEMANTIC_PAYLOAD_KEY_RE.test(childKey);
      visit(childValue, nextSemantic, childKey);
    }
  };
  visit(payload);
  return parts.join(' ');
}

function semanticTraceText(payload) {
  const parts = [];
  const visitTrace = (trace, depth = 0) => {
    if (typeof trace === 'string' || typeof trace === 'number') {
      parts.push(String(trace));
      return;
    }
    if (!trace || typeof trace !== 'object' || depth > 6 || parts.length >= 48) return;
    if (Array.isArray(trace)) {
      for (const item of trace.slice(0, 40)) visitTrace(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(trace).slice(0, 80)) {
      if (key === 'fingerprint' || SENSITIVE_PAYLOAD_KEY_RE.test(String(key || ''))) continue;
      visitTrace(value, depth + 1);
    }
  };
  const visit = (value, key = '', depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 8 || parts.length >= 48) return;
    if (SENSITIVE_PAYLOAD_KEY_RE.test(String(key || ''))) return;
    if (key === 'semanticTrace') {
      visitTrace(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 40)) visit(item, key, depth + 1);
      return;
    }
    for (const [childKey, childValue] of Object.entries(value).slice(0, 80)) {
      if (childKey === 'fingerprint' || SENSITIVE_PAYLOAD_KEY_RE.test(String(childKey || ''))) continue;
      if (childKey === 'semanticTrace') visitTrace(childValue);
      else visit(childValue, childKey, depth + 1);
    }
  };
  visit(payload);
  return parts.join(' ');
}

export function summarizePayloadSignals(payload) {
  if (!payload || typeof payload !== 'object') return [];
  const signals = [];
  const pushScalar = (key, value) => {
    if (value == null || typeof value === 'object') return;
    signals.push(redactSensitiveText(`${key}=${String(value)}`).replace(/\s+/g, ' ').slice(0, 80));
  };
  for (const key of ['status', 'outcome', 'result', 'reason', 'error']) {
    pushScalar(key, payload[key]);
  }
  if (typeof payload.ok === 'boolean') signals.push(redactSensitiveText(`ok=${payload.ok}`));
  if (typeof payload.completed === 'boolean') signals.push(redactSensitiveText(`completed=${payload.completed}`));
  if (typeof payload.failed === 'boolean') signals.push(redactSensitiveText(`failed=${payload.failed}`));
  pushScalar('episodeType', payload.episodeType);
  pushScalar('streamType', payload.meta?.streamType);
  pushScalar('guard.action', payload.meta?.guard?.action);
  pushScalar('guard.state', payload.meta?.guard?.state);
  const groundingScore = Number(payload.meta?.grounding?.score);
  if (Number.isFinite(groundingScore)) {
    const bucket = groundingScore >= 0.75 ? 'high' : groundingScore >= 0.45 ? 'medium' : 'low';
    signals.push(`grounding.score_bucket=${bucket}`);
  }
  return signals.slice(0, 8);
}

export function buildEvidenceSummary({ rows, matched, kindCounts, signalCounts }) {
  const kinds = compactCountEntries(kindCounts, 'kind');
  const signals = compactCountEntries(signalCounts, 'signal');
  const hasActionEvent = evidenceSummaryHasAction(kinds);
  const hasObservationEvent = evidenceSummaryHasObservation(kinds);
  const hasResultSignal = evidenceSummaryHasResultSignal(signals);
  return sanitizeEvidenceSummary({
    scanned: rows.length,
    matched: matched.length,
    kinds,
    signals,
    hasActionEvent,
    hasObservationEvent,
    hasResultSignal,
  });
}

function parseEvidenceSummary(text) {
  const line = String(text || '').split(/\n/).find((item) => item.startsWith('证据元数据：'));
  if (!line) return null;
  try { return sanitizeEvidenceSummary(JSON.parse(line.slice('证据元数据：'.length))); } catch { return null; }
}

function parseEvidenceCandidateSummary(text) {
  const line = String(text || '').split(/\n/).find((item) => item.startsWith('候选结果元数据：'));
  if (!line) return null;
  try { return sanitizeEvidenceCandidateSummary(JSON.parse(line.slice('候选结果元数据：'.length))); } catch { return null; }
}

function parseEvidenceClaimAlignment(text) {
  const line = String(text || '').split(/\n/).find((item) => item.startsWith('证据对齐元数据：'));
  if (!line) return null;
  try { return sanitizeEvidenceClaimAlignment(JSON.parse(line.slice('证据对齐元数据：'.length))); } catch { return null; }
}

function resultSignalsForCandidate(payload) {
  return summarizePayloadSignals(payload)
    .filter((signal) => /^(status|outcome|result|reason|error|ok|completed|failed)=/i.test(String(signal || '')));
}

function isActionLikeKind(kind) {
  return /act|action|execut|checkpoint|goal|activity/i.test(String(kind || ''));
}

function isObservationLikeKind(kind) {
  return /episode|thought|reflection|observation|self_talk|memory/i.test(String(kind || ''));
}

function countBaseNeedleHits(text, needles = []) {
  let hits = 0;
  for (const needle of needles) if (String(text || '').includes(needle)) hits += 1;
  return hits;
}

function countSafeNeedleHits(text, safeIds = []) {
  let hits = 0;
  const raw = String(text || '');
  for (const id of safeIds) {
    const item = SAFE_CLAIM_NEEDLES.find((entry) => entry.id === id);
    if (item?.text.test(raw)) hits += 1;
  }
  return hits;
}

function roundCoverage(hits, total) {
  return total > 0 ? Math.round((hits / total) * 1000) / 1000 : 0;
}

function scoreClaimNeedleText(text, needles = []) {
  const { base, safe } = splitClaimNeedles(needles);
  const baseHits = countBaseNeedleHits(text, base);
  const baseCoverage = roundCoverage(baseHits, base.length);
  const safeHits = countSafeNeedleHits(text, safe);
  const safeCoverage = roundCoverage(safeHits, safe.length);
  const safeEligible = safe.length >= 2 && safeHits >= 2;
  if (safeEligible && safeCoverage > baseCoverage) {
    return { hits: safeHits, coverage: safeCoverage, needleCount: safe.length };
  }
  return { hits: baseHits, coverage: baseCoverage, needleCount: base.length };
}

function linkLabelForHits(hits, claimGrams, minHits) {
  const linkedThreshold = claimGrams <= 2 ? Math.max(1, minHits) : Math.max(2, minHits);
  return hits >= linkedThreshold ? 'linked' : hits > 0 ? 'weak' : 'unlinked';
}

export function scoreCandidateClaimLink(payload, grams = [], minHits = 1) {
  const claimGrams = claimBaseNeedleCount(grams);
  const { safe } = splitClaimNeedles(grams);
  if (!claimGrams && !safe.length) return { label: 'unlinked', hits: 0, coverage: 0 };
  const payloadScore = scoreClaimNeedleText(payloadText(payload), grams);
  const semanticScore = scoreClaimNeedleText(payloadSemanticText(payload), grams);
  const traceScore = scoreClaimNeedleText(semanticTraceText(payload), grams);
  return {
    label: linkLabelForHits(payloadScore.hits, payloadScore.needleCount, minHits),
    hits: payloadScore.hits,
    coverage: payloadScore.coverage,
    semanticLabel: linkLabelForHits(semanticScore.hits, semanticScore.needleCount, minHits),
    semanticHits: semanticScore.hits,
    semanticCoverage: semanticScore.coverage,
    semanticTraceLabel: linkLabelForHits(traceScore.hits, traceScore.needleCount, minHits),
    semanticTraceHits: traceScore.hits,
    semanticTraceCoverage: traceScore.coverage,
  };
}

function traceRouteRank(link = {}, item = {}) {
  if (link.semanticTraceLabel === 'linked') return 4;
  if (link.semanticTraceLabel === 'weak') return 3;
  if (Number(link.semanticTraceHits || 0) > 0) return 2;
  if (link.semanticLabel === 'linked') return 1;
  // P1-A/RV-1（第 2 轮验收）：embedding 软证据排在词面 semanticLabel linked(=1) 之下、unlinked(=0) 之上——
  // 绝不让纯语义召回(可能因果无关)挤掉词面直连的强证据；被词面占满 maxLines 时由 select 的 R4 保底拉回。
  // （早期误设 1.5 让 embed 排在词面 linked 之上，端到端会把强 result-action 挤出时间线——RV-1 实证根因）
  // OFF 路径无 embedMatched item，此分支死代码、零回归。
  if (item.embedMatched) return 0.5;
  return 0;
}

function sortEvidenceMatches(a, b) {
  const ar = traceRouteRank(a.link, a);
  const br = traceRouteRank(b.link, b);
  return br - ar
    || Number(b.embedSimilarity || 0) - Number(a.embedSimilarity || 0) // P1-A：同为 embed 召回时按相似度降序（非 embed 恒 0，不改旧序）
    || Number(b.link?.semanticTraceHits || 0) - Number(a.link?.semanticTraceHits || 0)
    || Number(b.link?.semanticHits || 0) - Number(a.link?.semanticHits || 0)
    || Number(b.link?.hits || 0) - Number(a.link?.hits || 0)
    || Number(a.ev?.ts || 0) - Number(b.ev?.ts || 0);
}

export function selectClaimLinkedEvidenceMatches(matched = [], maxLines = 8) {
  if (!Array.isArray(matched) || !matched.length) return [];
  const enriched = matched
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      ...item,
      link: item.link || scoreCandidateClaimLink(item.ev?.payload, [], 1),
      actionLike: isActionLikeKind(item.ev?.kind),
    }));
  const traceActionMatches = enriched.filter((item) => item.actionLike && Number(item.link?.semanticTraceHits || 0) > 0);
  const linkedTraceActions = traceActionMatches.filter((item) => item.link?.semanticTraceLabel === 'linked');
  const linkedSemanticActions = enriched.filter((item) => item.actionLike && item.link?.semanticLabel === 'linked');
  const weakTraceActions = traceActionMatches.filter((item) => item.link?.semanticTraceLabel === 'weak');
  let route = [];
  if (linkedTraceActions.length) {
    route = linkedTraceActions;
  } else if (weakTraceActions.length && linkedSemanticActions.length) {
    route = linkedSemanticActions;
  } else if (weakTraceActions.length) {
    route = weakTraceActions;
  }
  const pool = route.length ? route : enriched;
  const ranked = pool
    .sort(sortEvidenceMatches)
    .slice(0, maxLines);
  if (!route.length && maxLines > 1 && !ranked.some((item) => item.actionLike && resultSignalsForCandidate(item.ev?.payload).length)) {
    const selected = new Set(ranked);
    const bestLinkedResultAction = enriched
      .filter((item) => !selected.has(item)
        && item.actionLike
        && resultSignalsForCandidate(item.ev?.payload).length
        && (item.link?.label === 'linked' || item.link?.semanticLabel === 'linked' || item.link?.semanticTraceLabel === 'linked'))
      .sort(sortEvidenceMatches)[0];
    if (bestLinkedResultAction) {
      if (ranked.length >= maxLines) ranked[ranked.length - 1] = bestLinkedResultAction;
      else ranked.push(bestLinkedResultAction);
    }
  }
  // R4：embed 召回是词面盲区的唯一补充，若被词面 route 预过滤或 maxLines 挤出，保底塞回相似度最高的 1 条
  // （仅在确有 embed 召回事件时触发——非 embed 场景此块跳过，select 对词面路径逐字零回归）
  if (maxLines > 1 && enriched.some((item) => item.embedMatched) && !ranked.some((item) => item.embedMatched)) {
    const topEmbed = enriched.filter((item) => item.embedMatched).sort((a, b) => Number(b.embedSimilarity || 0) - Number(a.embedSimilarity || 0))[0];
    if (topEmbed) {
      if (ranked.length >= maxLines) {
        // RV-1（第 2 轮验收）：优先替换非 result-action 噪声，绝不用 embed 软证据挤掉词面直连的强 result-action
        // （bestLinkedResultAction 块可能刚把强 result-action 拉进末位，盲替末位会把它挤出）；全是强证据则 embed 这次不进
        const noiseIdx = ranked.findIndex((it) => !(it?.actionLike && resultSignalsForCandidate(it.ev?.payload).length > 0));
        if (noiseIdx >= 0) ranked[noiseIdx] = topEmbed;
      } else ranked.push(topEmbed);
    }
  }
  return ranked
    .sort((a, b) => Number(a.ev?.ts || 0) - Number(b.ev?.ts || 0));
}

export function buildEvidenceClaimAlignment({ matched = [], grams = [], minHits = 1 } = {}) {
  const out = {
    method: 'claim_bigram_overlap_v2_semantic_fields',
    claimGrams: claimBaseNeedleCount(grams),
    matchedEvents: 0,
    actionEvents: 0,
    observationEvents: 0,
    resultEvents: 0,
    resultActionEvents: 0,
    linkedActionEvents: 0,
    weakActionEvents: 0,
    unlinkedActionEvents: 0,
    maxHits: 0,
    maxCoverage: 0,
    actionMaxHits: 0,
    actionMaxCoverage: 0,
    semanticActionEvents: 0,
    semanticResultActionEvents: 0,
    semanticLinkedActionEvents: 0,
    semanticWeakActionEvents: 0,
    semanticUnlinkedActionEvents: 0,
    semanticActionMaxHits: 0,
    semanticActionMaxCoverage: 0,
    semanticTraceEvents: 0,
    semanticTraceActionEvents: 0,
    semanticTraceResultActionEvents: 0,
    semanticTraceLinkedActionEvents: 0,
    semanticTraceWeakActionEvents: 0,
    semanticTraceUnlinkedActionEvents: 0,
    semanticTraceMaxHits: 0,
    semanticTraceMaxCoverage: 0,
    // R2+R3 整改：embedding 召回事件独立计数/覆盖度，绝不并入词面 semantic*、不喂 decisive reask 高置信门
    embedRecalledActionEvents: 0,
    embedActionMaxCoverage: 0,
  };
  if (!Array.isArray(matched) || !matched.length || !Array.isArray(grams) || !grams.length) {
    return sanitizeEvidenceClaimAlignment(out);
  }
  for (const item of matched) {
    const ev = item?.ev || {};
    const kind = String(ev?.kind || 'event');
    const actionLike = isActionLikeKind(kind);
    const observationLike = isObservationLikeKind(kind);
    const resultSignals = resultSignalsForCandidate(ev?.payload);
    const link = scoreCandidateClaimLink(ev?.payload, grams, minHits);
    // P1-A：embedding 召回事件的相似度。R2+R3 整改后只进独立 embed* 字段（可观测），绝不并入词面 semantic*——
    // 词面 semanticLinked 是 decisive reask 高置信门，让「语义相似(可能因果无关)」点亮它会放大误判（红队 R2/R3 实证）。非 embed item 恒 0。
    const embedSim = item.embedMatched ? Number(item.embedSimilarity || 0) : 0;
    out.matchedEvents += 1;
    if (item.embedMatched && embedSim > 0) {
      out.embedRecalledActionEvents += 1;
      out.embedActionMaxCoverage = Math.max(out.embedActionMaxCoverage, embedSim);
    }
    if (actionLike) out.actionEvents += 1;
    if (observationLike) out.observationEvents += 1;
    if (resultSignals.length) out.resultEvents += 1;
    if (actionLike && resultSignals.length) out.resultActionEvents += 1;
    if (actionLike) {
      if (link.label === 'linked') out.linkedActionEvents += 1;
      else if (link.label === 'weak') out.weakActionEvents += 1;
      else out.unlinkedActionEvents += 1;
      if (link.semanticHits > 0) out.semanticActionEvents += 1;
      if (resultSignals.length && link.semanticHits > 0) out.semanticResultActionEvents += 1;
      if (link.semanticLabel === 'linked') out.semanticLinkedActionEvents += 1;
      else if (link.semanticLabel === 'weak') out.semanticWeakActionEvents += 1;
      else out.semanticUnlinkedActionEvents += 1;
      if (link.semanticTraceHits > 0) out.semanticTraceActionEvents += 1;
      if (resultSignals.length && link.semanticTraceHits > 0) out.semanticTraceResultActionEvents += 1;
      if (link.semanticTraceLabel === 'linked') out.semanticTraceLinkedActionEvents += 1;
      else if (link.semanticTraceLabel === 'weak') out.semanticTraceWeakActionEvents += 1;
      else out.semanticTraceUnlinkedActionEvents += 1;
      out.actionMaxHits = Math.max(out.actionMaxHits, link.hits);
      out.actionMaxCoverage = Math.max(out.actionMaxCoverage, link.coverage);
      out.semanticActionMaxHits = Math.max(out.semanticActionMaxHits, link.semanticHits);
      out.semanticActionMaxCoverage = Math.max(out.semanticActionMaxCoverage, link.semanticCoverage);
      out.semanticTraceMaxHits = Math.max(out.semanticTraceMaxHits, link.semanticTraceHits);
      out.semanticTraceMaxCoverage = Math.max(out.semanticTraceMaxCoverage, link.semanticTraceCoverage);
    }
    if (link.semanticTraceHits > 0) out.semanticTraceEvents += 1;
    out.maxHits = Math.max(out.maxHits, link.hits);
    out.maxCoverage = Math.max(out.maxCoverage, link.coverage);
  }
  return sanitizeEvidenceClaimAlignment(out);
}

function buildNearbyResultCandidates({ rows = [], matched = [], grams = [], minHits = 1, windowMs = 15 * 60_000, maxCandidates = 8 } = {}) {
  const matchedEvents = new Set(matched.map((item) => item.ev).filter(Boolean));
  const matchedTimes = matched
    .map((item) => Number(item.ev?.ts))
    .filter(Number.isFinite);
  if (!matchedTimes.length) return null;
  const candidates = [];
  const kindCounts = new Map();
  const signalCounts = new Map();
  const deltas = [];
  const linkCounts = {
    linked: 0,
    weak: 0,
    unlinked: 0,
    maxHits: 0,
    maxCoverage: 0,
    semanticLinked: 0,
    semanticWeak: 0,
    semanticUnlinked: 0,
    semanticMaxHits: 0,
    semanticMaxCoverage: 0,
    semanticTraceLinked: 0,
    semanticTraceWeak: 0,
    semanticTraceUnlinked: 0,
    semanticTraceMaxHits: 0,
    semanticTraceMaxCoverage: 0,
  };
  for (const ev of rows) {
    if (matchedEvents.has(ev)) continue;
    const ts = Number(ev?.ts);
    if (!Number.isFinite(ts)) continue;
    const delta = Math.min(...matchedTimes.map((m) => Math.abs(ts - m)));
    if (delta > windowMs) continue;
    const kind = String(ev?.kind || 'event').slice(0, 60);
    const signals = resultSignalsForCandidate(ev?.payload);
    const actionLike = /act|action|execut|checkpoint|goal|activity/i.test(kind);
    if (!actionLike && !signals.length) continue;
    const link = scoreCandidateClaimLink(ev?.payload, grams, minHits);
    candidates.push({ ev, kind, signals, delta, link });
    deltas.push(delta);
    kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
    for (const signal of signals) signalCounts.set(signal, (signalCounts.get(signal) || 0) + 1);
    if (link.label === 'linked') linkCounts.linked += 1;
    else if (link.label === 'weak') linkCounts.weak += 1;
    else linkCounts.unlinked += 1;
    if (link.semanticLabel === 'linked') linkCounts.semanticLinked += 1;
    else if (link.semanticLabel === 'weak') linkCounts.semanticWeak += 1;
    else linkCounts.semanticUnlinked += 1;
    if (link.semanticTraceLabel === 'linked') linkCounts.semanticTraceLinked += 1;
    else if (link.semanticTraceLabel === 'weak') linkCounts.semanticTraceWeak += 1;
    else linkCounts.semanticTraceUnlinked += 1;
    linkCounts.maxHits = Math.max(linkCounts.maxHits, link.hits);
    linkCounts.maxCoverage = Math.max(linkCounts.maxCoverage, link.coverage);
    linkCounts.semanticMaxHits = Math.max(linkCounts.semanticMaxHits, link.semanticHits);
    linkCounts.semanticMaxCoverage = Math.max(linkCounts.semanticMaxCoverage, link.semanticCoverage);
    linkCounts.semanticTraceMaxHits = Math.max(linkCounts.semanticTraceMaxHits, link.semanticTraceHits);
    linkCounts.semanticTraceMaxCoverage = Math.max(linkCounts.semanticTraceMaxCoverage, link.semanticTraceCoverage);
  }
  if (!candidates.length) return null;
  const avg = Math.round(deltas.reduce((sum, n) => sum + n, 0) / deltas.length);
  const summary = sanitizeEvidenceCandidateSummary({
    scanned: rows.length,
    candidates: candidates.length,
    windowMs,
    kinds: compactCountEntries(kindCounts, 'kind'),
    signals: compactCountEntries(signalCounts, 'signal'),
    linkStats: {
      method: 'claim_bigram_overlap_v2_semantic_fields',
      claimGrams: claimBaseNeedleCount(grams),
      scoredCandidates: candidates.length,
      linkedCandidates: linkCounts.linked,
      weakCandidates: linkCounts.weak,
      unlinkedCandidates: linkCounts.unlinked,
      maxHits: linkCounts.maxHits,
      maxCoverage: linkCounts.maxCoverage,
      semanticLinkedCandidates: linkCounts.semanticLinked,
      semanticWeakCandidates: linkCounts.semanticWeak,
      semanticUnlinkedCandidates: linkCounts.semanticUnlinked,
      semanticMaxHits: linkCounts.semanticMaxHits,
      semanticMaxCoverage: linkCounts.semanticMaxCoverage,
      semanticTraceLinkedCandidates: linkCounts.semanticTraceLinked,
      semanticTraceWeakCandidates: linkCounts.semanticTraceWeak,
      semanticTraceUnlinkedCandidates: linkCounts.semanticTraceUnlinked,
      semanticTraceMaxHits: linkCounts.semanticTraceMaxHits,
      semanticTraceMaxCoverage: linkCounts.semanticTraceMaxCoverage,
    },
    nearestDeltaMs: { min: Math.min(...deltas), max: Math.max(...deltas), avg },
  });
  return {
    summary,
    items: candidates
      .sort((a, b) => a.delta - b.delta || Number(a.ev?.ts || 0) - Number(b.ev?.ts || 0))
      .slice(0, maxCandidates),
  };
}

/**
 * 证据上下文准备：取期望创建之后的事件，按 claim 的 bigram 词面命中粗筛成 matched，
 * 词面 hits=0 的归入 unmatched（留给 P1-A embedding 语义召回）。零 LLM。
 */
function prepareEvidenceContext(exp, { listEventsFn, scanLimit = 200, listActionEvidence = null } = {}) {
  const grams = [...buildClaimLinkNeedles(exp?.claim)];
  const claimGrams = claimBaseNeedleCount(grams);
  if (!claimGrams && !splitClaimNeedles(grams).safe.length) return null;
  const minHits = claimGrams >= 6 ? 2 : 1; // 短 claim 放宽到 1 个命中
  const sinceTs = Number(exp.created_at) || 0;
  const rows = [
    ...(listEventsFn({ sinceTs, limit: scanLimit, order: 'ASC' }) || []),
    ...(typeof listActionEvidence === 'function'
      ? (listActionEvidence({ sinceTs, limit: Math.max(20, Math.min(200, scanLimit)), order: 'ASC' }) || [])
      : []),
  ]
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => Number(a.ts || 0) - Number(b.ts || 0));
  const matched = [];
  const unmatched = [];
  for (const ev of rows) {
    const text = payloadText(ev?.payload);
    const link = scoreCandidateClaimLink(ev?.payload, grams, minHits);
    const hits = Math.max(
      Number(link.hits || 0),
      Number(link.semanticHits || 0),
      Number(link.semanticTraceHits || 0),
    );
    if (hits < minHits) { unmatched.push({ ev, text, link }); continue; }
    matched.push({ ev, text, hits, link });
  }
  return { grams, minHits, rows, matched, unmatched };
}

/**
 * 把 matched（可含 P1-A 的 embedMatched 事件）渲染成判证脑可读的结构化证据文本。
 * OFF/ON 共用：OFF 的 matched 仅词面命中、ON 追加 embedding 语义召回事件（行为差异只在 matched 内容）。
 */
function renderEvidenceText({ rows, matched, grams, minHits, maxLines = 8, embedDegraded = false }) {
  if (!matched.length) return '';
  const rankedMatched = selectClaimLinkedEvidenceMatches(matched, maxLines);
  // P1-A 防误判（修审查 serious）：embed 软证据只进时间线供判证脑自读，绝不驱动 hint 的方向性统计——
  //   signalCounts/kindCounts/summary.matched 只统计词面 matched(lexical)，杜绝"语义相似但因果无关"的
  //   embed 事件用 success/failure 信号或 matched>=2 计数把 suggestedVerdict/confidence 抬成高置信(击穿验收承诺)。
  //   OFF 路径(recall=null)无 embedMatched 项 → lexicalMatched===rankedMatched，逐字零回归。
  const lexicalMatched = rankedMatched.filter((item) => !item.embedMatched);
  const embedMatchedCount = rankedMatched.length - lexicalMatched.length;
  const kindCounts = new Map();
  const signalCounts = new Map();
  for (const item of lexicalMatched) {
    const kind = String(item.ev?.kind || 'event').slice(0, 60);
    kindCounts.set(kind, (kindCounts.get(kind) || 0) + 1);
    for (const signal of summarizePayloadSignals(item.ev?.payload)) {
      signalCounts.set(signal, (signalCounts.get(signal) || 0) + 1);
    }
  }
  const kinds = compactCountEntries(kindCounts, 'kind').map((item) => `${item.kind}:${item.count}`).join(', ');
  const signals = compactCountEntries(signalCounts, 'signal').map((item) => `${item.signal}:${item.count}`).join(', ');
  const summary = buildEvidenceSummary({ rows, matched: lexicalMatched, kindCounts, signalCounts });
  const claimAlignment = buildEvidenceClaimAlignment({ matched: rankedMatched, grams, minHits });
  const candidateResult = summary.hasActionEvent ? null : buildNearbyResultCandidates({ rows, matched: rankedMatched, grams, minHits });
  const lines = [
    `证据摘要：scanned=${rows.length}, matched=${lexicalMatched.length}${embedMatchedCount > 0 ? `(+embed软证据${embedMatchedCount}条,仅供时间线自读不计入判证统计)` : ''}, kinds=${kinds || 'none'}, signals=${signals || 'none'}${embedDegraded ? ', embedDegraded=true(语义召回降级:ollama抖动或超候选上限,本次embed证据可能不全)' : ''}`,
    `证据元数据：${JSON.stringify(summary)}`,
    `证据对齐摘要：matchedEvents=${claimAlignment.matchedEvents}, actionEvents=${claimAlignment.actionEvents}, resultActionEvents=${claimAlignment.resultActionEvents}, actionMaxHits=${claimAlignment.actionMaxHits}, actionMaxCoverage=${claimAlignment.actionMaxCoverage}, semanticActionMaxHits=${claimAlignment.semanticActionMaxHits}, semanticActionMaxCoverage=${claimAlignment.semanticActionMaxCoverage}, semanticTraceActionEvents=${claimAlignment.semanticTraceActionEvents}, semanticTraceMaxHits=${claimAlignment.semanticTraceMaxHits}, semanticTraceMaxCoverage=${claimAlignment.semanticTraceMaxCoverage}${claimAlignment.embedRecalledActionEvents > 0 ? `, embedRecalledActionEvents=${claimAlignment.embedRecalledActionEvents}, embedActionMaxCoverage=${claimAlignment.embedActionMaxCoverage}` : ''}`,
    `证据对齐元数据：${JSON.stringify(claimAlignment)}`,
    ...(candidateResult?.summary ? [
      `候选结果摘要：candidates=${candidateResult.summary.candidates}, kinds=${candidateResult.summary.kinds.map((item) => `${item.kind}:${item.count}`).join(', ') || 'none'}, signals=${candidateResult.summary.signals.map((item) => `${item.signal}:${item.count}`).join(', ') || 'none'}`,
      `候选结果元数据：${JSON.stringify(candidateResult.summary)}`,
      '候选结果说明：这些事件因时间邻近和安全语义计数而被列为候选；不能单独替代直接命中预测文本的现实证据。',
    ] : []),
    '相关时间线（仅期望创建之后，已脱敏）：',
  ];
  for (const item of rankedMatched) {
    const ts = Number(item.ev?.ts);
    const at = Number.isFinite(ts) ? new Date(ts).toISOString() : 'unknown-time';
    const kind = String(item.ev?.kind || 'event').slice(0, 60);
    const signal = summarizePayloadSignals(item.ev?.payload).join(', ');
    const snippet = redactSensitiveText(item.text).replace(/\s+/g, ' ').slice(0, 180);
    // P1-A：embedding 召回事件标注 embedSim，让判证脑知道这是「词面未命中但语义相关」的证据。
    const embedTag = item.embedMatched ? ` embedSim=${Number(item.embedSimilarity || 0).toFixed(3)}` : '';
    lines.push(`- ${at} [${kind}] hits=${item.hits}${embedTag}${signal ? ` ${signal}` : ''} :: ${snippet}`);
  }
  if (candidateResult?.items?.length) {
    lines.push('邻近候选结果（仅安全元数据，未直接命中预测文本）：');
    for (const item of candidateResult.items) {
      const ts = Number(item.ev?.ts);
      const at = Number.isFinite(ts) ? new Date(ts).toISOString() : 'unknown-time';
      const signal = item.signals.join(', ');
      const link = item.link ? ` link=${item.link.label} linkHits=${item.link.hits} linkCoverage=${item.link.coverage}` : '';
      lines.push(`- ${at} [${item.kind}] deltaMs=${Math.round(item.delta)}${link}${signal ? ` ${signal}` : ''}`);
    }
  }
  return lines.join('\n');
}

/**
 * 证据构造工厂：从事件流取期望创建之后的记录，按 claim 的 bigram 命中数粗筛（零 LLM），
 * 输出结构化摘要 + 时间线，减少判证脑在松散 JSON 片段里猜状态。
 * 双形态（P1-A）：
 *  - recall=null（默认 OFF）：返回**同步**闭包，逐字走 bigram 词面路径，53 resolver 测试基线零回归。
 *  - recall 非空（NOE_JUDGE_EMBEDDING=1 注入）：返回**async**闭包，对词面 hits=0 的有意义事件做 embedding
 *    语义召回（修 R1 根因：词面不重合的语义相关证据原被 `hits<minHits` 踢出）。judgeOne 已 await。
 * @param {(q: object) => Array<object>} listEventsFn  SqliteStore.listEvents 同签名（注入可测）
 * @returns {(exp: {claim: string, created_at: number}) => (string|Promise<string>)}
 */
export function buildEventsEvidence(listEventsFn, { maxLines = 8, scanLimit = 200, listActionEvidence = null, recall = null } = {}) {
  const ctx = { listEventsFn, scanLimit, listActionEvidence };
  if (typeof recall !== 'function') {
    // OFF：同步闭包，逐字 bigram 词面路径（零回归）
    return (exp) => {
      try {
        const p = prepareEvidenceContext(exp, ctx);
        if (!p) return '';
        return renderEvidenceText({ rows: p.rows, matched: p.matched, grams: p.grams, minHits: p.minHits, maxLines });
      } catch { return ''; }
    };
  }
  // ON：async 闭包，词面 matched + embedding 语义召回 hits=0 事件
  return async (exp) => {
    try {
      const p = prepareEvidenceContext(exp, ctx);
      if (!p) return '';
      const matched = p.matched;
      // 只对「有意义」的 hits=0 事件做 embedding（action-like 或带结果信号），省调用且避噪声；recall 内部另有 maxEmbedEvents cap
      // R1+R6：喂 embed 的事件文本/claim 先脱敏（embed 经 ollama 跨 HTTP 边界，对齐本仓其它 sink 脱敏约定）+ 限长 500（对齐其它 embed 站点，防超长失真/拖垮 judge）
      const embedCand = p.unmatched
        .filter((r) => isActionLikeKind(r.ev?.kind) || resultSignalsForCandidate(r.ev?.payload).length)
        .map((r) => ({ ev: r.ev, text: redactSensitiveText(String(r.text || '')).slice(0, 500) }));
      let embedDegraded = false;
      if (embedCand.length) {
        // P1-C（修审查 minor）：recall 单独 try/catch——recall 真进程级异常(非内部已接住的降级)时，
        //   不丢已算好的词面 matched(p.matched)，降级标 embedDegraded 继续走词面路径渲染（对齐 R7「降级不丢证据」哲学，
        //   避免 ollama 崩把本可用的词面证据也吞成空证据→judge 错失 Brier 信号）。
        try {
          const recallMap = await recall(redactSensitiveText(String(exp?.claim || '')).slice(0, 500), embedCand);
          if (recallMap && typeof recallMap.get === 'function') {
            for (const r of p.unmatched) {
              const hit = recallMap.get(r.ev);
              if (hit && Number.isFinite(hit.similarity)) {
                matched.push({ ev: r.ev, text: r.text, hits: 0, link: r.link, embedSimilarity: hit.similarity, embedMatched: true });
              }
            }
            // R7：recall 降级（ollama 抖动退 fallback / 超 maxEmbedEvents cap）透传，让 judge 区分「语义路径已降级」vs「真无证据」
            if (recallMap.get(RECALL_DEGRADED_KEY)?.degraded) embedDegraded = true;
          }
        } catch {
          embedDegraded = true;
        }
      }
      return renderEvidenceText({ rows: p.rows, matched, grams: p.grams, minHits: p.minHits, maxLines, embedDegraded });
    } catch { return ''; }
  };
}

export function createExpectationResolver({
  ledger = null,             // NoeExpectationLedger（必须，缺了 tick 直接空转）
  getAdapter = null,         // (id) => {chat}（与深思同源：roomAdapterPool）
  adapterId = 'lmstudio',    // 本地白名单脑（由装配方经 NoeReflectBrain 解析后传入）
  model = '',                // 空串 = 用 adapter 当前加载的默认模型
  evidence = null,           // (exp) => Promise<string>|string：期望创建之后的行为/对话证据文本
  maxPerTick = 3,            // 每跳最多判几条（LLM 调用限流；其余下一跳接着判）
  unresolvedCooldownMs = 3600_000, // UNKNOWN/证据不足项临时让路，避免最早 due 永久饥饿后续项
  goalSystem = null,         // rank4 好奇回路：注入则预测落空(outcome=0)且惊奇≥阈值时自动 harvestSurprise 立研究目标
  // 放宽失败信号识别（仅扩 FAILED-信号提示的覆盖面，不改判证规则、不自动落账）。默认 OFF：用 BASE 正则，
  // 判证 profile 与改造前逐字一致。ON 经 NOE_EXPECT_LOOSEN_FAIL=1 触发，让真实落空（result=cancelled 等
  // 终态负面词）能被模型看见并据实判成 0；绝不伪造结算。显式注入优先（测试传 boolean，不读 env）。
  loosenFail = process.env.NOE_EXPECT_LOOSEN_FAIL === '1',
  // 决定性二次复核：第一轮 UNKNOWN 但安全元数据给出高置信直接 action-result 语义链时，二次复核据实强制裁决。
  // 分量动作（改 judge 核心），默认 OFF（对齐 loosenFail 纪律），经 NOE_EXPECT_DECISIVE_REASK=1 开启；显式注入优先（测试传 boolean）。
  decisiveReask = process.env.NOE_EXPECT_DECISIVE_REASK === '1',
  // 步骤5（多模型安全方案）：承诺类(owner_pred)预测到期反复判不出 + 逾期够久 → 决定性判 FAILED，
  //   补"owner 行为预测落空从不被负反馈校准（只会被 7 天 sweep 抹成 NULL 不计分）"的洞。
  //   四重护栏：source 白名单 + verifiable=1 + judge_attempts≥阈值 + 逾期≥宽限；严格排除 reflection/thought，
  //   绝不靠单次 no_evidence 定生死。最高风险分量动作，默认 OFF，owner 在场点火（NOE_EXPECT_DECISIVE_FAIL=1）。
  decisiveFail = process.env.NOE_EXPECT_DECISIVE_FAIL === '1',
  // 白名单 source：决定性判 FAILED 只对这些 source 生效（叠加 verifiable=1 门）。三方审查后 owner_pred 两条均改判 verifiable=0
  //   （followup 赌 owner 言语行为、沉默 under-determined；topic 弱信号），故当前生产【无任何项满足 verifiable=1 门】→
  //   步骤5 机制就绪但实际不触发，等真承诺源（commitment→ledger 桥接 / Neo 自立的可交付任务预测标 verifiable=1）落地再生效。
  //   保留 owner_pred 占位，与 verifiable=1 门构成双保险（白名单 + 可检验性都过才判）。
  decisiveFailSources = ['owner_pred'],
  decisiveFailMinAttempts = 3,
  decisiveFailGraceMs = 24 * 3600_000,
  projectId = 'noe',
  now = Date.now,
} = {}) {
  model = normalizeNoeAutoModel(model, { allowEmpty: true });
  // 步骤5 护栏常量（注入优先，带硬下限防误配成"单次判证就定生死"）
  const decisiveFailSourceSet = new Set((Array.isArray(decisiveFailSources) ? decisiveFailSources : []).map((s) => String(s)));
  const DECISIVE_FAIL_MIN_ATTEMPTS = Math.max(2, Number(decisiveFailMinAttempts) || 3); // 硬下限 2：绝不允许靠单次判证判 FAILED
  const DECISIVE_FAIL_GRACE_MS = Math.max(3600_000, Number(decisiveFailGraceMs) || 24 * 3600_000); // 硬下限 1h
  const GENUINE_UNDECIDED_RE = /^(?:no_evidence|llm_unknown|llm_unparsed)$/; // 只对"真判不出"累加；系统故障(no_brain/brain_error/evidence_error/brain_incomplete)不算 Neo 判过
  let inFlight = null;
  let lastDetachedResult = null;
  const unresolvedCooldown = new Map();
  // P1-F（修审查 minor）：UNKNOWN 项 set 后若该 exp 永不被 resolve(1/0)，永不 delete → Map 单调增长。
  //   set 时清理已过期(until<=t，冷却结束=逻辑上等同 ready)项 + 容量上限按插入序删最旧兜底（删活跃项只是让它提前判证，无害）。
  const COOLDOWN_MAX = 2048;
  function pruneCooldown(t) {
    if (unresolvedCooldown.size < COOLDOWN_MAX) return;
    for (const [id, until] of unresolvedCooldown) {
      if (!(Number(until) > t)) unresolvedCooldown.delete(id);
    }
    while (unresolvedCooldown.size >= COOLDOWN_MAX) {
      const oldest = unresolvedCooldown.keys().next().value;
      if (oldest === undefined) break;
      unresolvedCooldown.delete(oldest);
    }
  }

  function selectDueForFairness(due, t, limit) {
    const ready = [];
    const cooled = [];
    for (const exp of due) {
      const id = Number(exp?.id);
      const until = Number.isFinite(id) ? Number(unresolvedCooldown.get(id) || 0) : 0;
      if (until > t) cooled.push(exp);
      else ready.push(exp);
    }
    if (ready.length) {
      return {
        selected: ready.slice(0, limit),
        cooldownCount: cooled.length,
        cooldownOnly: false,
      };
    }
    const nextReadyAt = cooled
      .map((exp) => Number(unresolvedCooldown.get(Number(exp?.id)) || 0))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0] || null;
    return {
      selected: [],
      cooldownCount: cooled.length,
      cooldownOnly: cooled.length > 0,
      nextReadyAt,
    };
  }

  function rememberJudgement(exp, outcome, t) {
    const id = Number(exp?.id);
    if (!Number.isFinite(id)) return;
    if (outcome === 1 || outcome === 0) {
      unresolvedCooldown.delete(id);
      return;
    }
    const cooldown = Math.max(0, Number(unresolvedCooldownMs) || 0);
    if (cooldown > 0) {
      pruneCooldown(t);
      unresolvedCooldown.set(id, t + cooldown);
    }
  }

  /**
   * 步骤5（多模型安全方案）：承诺类(owner_pred)到期反复判不出 → 决定性判 FAILED。
   * 四重护栏全过才转 FAILED：① source 白名单（严格排除 reflection/thought）② verifiable=1
   *   ③ judge_attempts≥阈值（跨多跳累加，绝不靠单次 no_evidence 定生死）④ 逾期≥宽限（给足应验机会）。
   * 只在 judgeOne「真判不出」(no_evidence/llm_unknown/llm_unparsed) 时累加 attempts；系统故障不算判过。
   * @param {object} exp 到期项（due() 的 SELECT * 已带 source/verifiable/judge_attempts/due_at）
   * @param {{outcome:1|0|null, reason:string}} v judgeOne 结果（outcome 必为 null 才进此函数）
   * @returns {{v: object, resolvedDelta: number}|null} 转 FAILED 返回新 v + resolved 增量；否则 null
   */
  function maybeDecisiveFail(exp, v, t) {
    if (!ledger?.resolve) return null;
    // 只对"真判不出"累加判证次数（系统故障 no_brain/brain_error/evidence_error/brain_incomplete 不算 Neo 认真判过）
    if (!GENUINE_UNDECIDED_RE.test(String(v?.reason || ''))) return null;
    let attempts = (Number(exp.judge_attempts) || 0) + 1;
    if (typeof ledger.bumpAttempts === 'function') {
      const bumped = ledger.bumpAttempts(exp.id, t);
      if (Number.isFinite(bumped)) attempts = Number(bumped);
    }
    // 四重护栏（全真才转 FAILED；任一不满足 → 留账，等下次 tick 或 7 天 sweep 兜底作废成 NULL）
    const overdueMs = t - (Number(exp.due_at) || 0);
    const pass = decisiveFailSourceSet.has(String(exp.source))
      && Number(exp.verifiable) === 1
      && attempts >= DECISIVE_FAIL_MIN_ATTEMPTS
      && overdueMs >= DECISIVE_FAIL_GRACE_MS;
    if (!pass) return null;
    try {
      // 走默认 auto（决定性判 FAILED = 系统自评，无 owner 旁证，归 auto 校准分层正确）；
      //   审计标记靠 judged.reason='decisive_fail_overdue'（进 heartbeat 可观测），不污染 resolved_by 的 owner/auto 二分语义。
      const resolvedRow = ledger.resolve(exp.id, 0, t);
      if (!resolvedRow) return null;
      // 接好奇回路：owner_pred 落空 origin=owner_prediction，过 Goodhart 门（有外部锚的真负反馈）触发学习
      if (goalSystem && typeof goalSystem.harvestSurprise === 'function') {
        try { goalSystem.harvestSurprise({ claim: exp.claim, surprise: resolvedRow.surprise, origin: deriveSurpriseOrigin(exp.source) }); }
        catch { /* 好奇立项失败不阻断判证 */ }
      }
      return { v: { ...v, outcome: 0, reason: 'decisive_fail_overdue' }, resolvedDelta: 1 };
    } catch { return null; }
  }

  /**
   * 判证一条到期期望。只在证据明确时给 1/0，其余 null（留账）。
   * @param {{id: number, claim: string, p: number, created_at: number, due_at: number}} exp
   * @returns {Promise<{outcome: 1|0|null, reason: string}>}
   */
  async function judgeOne(exp) {
    const adapter = getAdapter?.(adapterId);
    if (!adapter?.chat) return { outcome: null, reason: 'no_brain' };
    let ev = '';
    try { ev = String((await evidence?.(exp)) || ''); } catch { return { outcome: null, reason: 'evidence_error' }; }
    const fullEvidence = redactSensitiveText(ev);
    const evStats = evidenceStats(fullEvidence.slice(0, 1800));
    const evSummary = parseEvidenceSummary(fullEvidence);
    const evCandidateSummary = parseEvidenceCandidateSummary(fullEvidence);
    const evClaimAlignment = parseEvidenceClaimAlignment(fullEvidence);
    const evDecisionHint = buildEvidenceDecisionHint(evSummary, evCandidateSummary, evClaimAlignment, loosenFail ? FAILURE_SIGNAL_RE_LOOSE : FAILURE_SIGNAL_RE);
    ev = fullEvidence.slice(0, 1800);
    if (!fullEvidence.trim()) return { outcome: null, reason: 'no_evidence', evidenceStats: evStats };
    let reply = '';
    try {
      const safeClaim = redactSensitiveText(exp.claim).slice(0, 300);
      const hintText = formatEvidenceDecisionHint(evDecisionHint);
      const r = await adapter.chat(
        [
          { role: 'system', content: RESOLVER_SYSTEM },
          {
            role: 'user',
            content: `预测（创建于 ${new Date(Number(exp.created_at)).toLocaleString('zh-CN')}，截止 ${new Date(Number(exp.due_at)).toLocaleString('zh-CN')}，当时主观概率 ${exp.p}）：\n${safeClaim}\n\n创建之后检索到的行为/对话证据：\n${ev || '（没有检索到相关证据）'}\n\n${hintText ? `${hintText}\n\n` : ''}裁决（优先只回一行 JSON，不要解释）：`,
          },
        ],
        // 不设超时（跑模型纪律）；判证走本地白名单模型，绝不付费档
        { budgetContext: { projectId, taskId: 'noe-expectation-resolve' }, temperature: 0, top_p: 1, maxTokens: STRUCTURED_PREFLIGHT_MAX_TOKENS, ...(model ? { model } : {}) },
      );
      if (r?.incomplete) {
        const partial = String(r?.reply || '');
        return {
          outcome: null,
          reason: 'brain_incomplete',
          finishReason: r.finishReason || 'length',
          evidenceStats: evStats,
          ...(evSummary ? { evidenceSummary: evSummary } : {}),
          ...(evCandidateSummary ? { evidenceCandidateSummary: evCandidateSummary } : {}),
          ...(evClaimAlignment ? { evidenceClaimAlignment: evClaimAlignment } : {}),
          ...(evDecisionHint ? { evidenceDecisionHint: evDecisionHint } : {}),
          ...(partial ? { replyStats: replyStats(partial) } : {}),
        };
      }
      reply = String(r?.reply || '');
    } catch {
      return {
        outcome: null,
        reason: 'brain_error',
        evidenceStats: evStats,
        ...(evSummary ? { evidenceSummary: evSummary } : {}),
        ...(evCandidateSummary ? { evidenceCandidateSummary: evCandidateSummary } : {}),
        ...(evClaimAlignment ? { evidenceClaimAlignment: evClaimAlignment } : {}),
        ...(evDecisionHint ? { evidenceDecisionHint: evDecisionHint } : {}),
      };
    }
    let verdict = parseVerdictDetail(reply);
    let decisiveReaskResult = null;
    if (decisiveReask && shouldRunDecisiveReask(verdict, evDecisionHint)) {
      try {
        const r2 = await adapter.chat(
          [
            { role: 'system', content: DECISIVE_REASK_SYSTEM },
            { role: 'user', content: formatDecisiveReaskPrompt({ exp, evidenceText: ev, hint: evDecisionHint, verdict }) },
          ],
          { budgetContext: { projectId, taskId: 'noe-expectation-decisive-reask' }, temperature: 0, top_p: 1, maxTokens: STRUCTURED_PREFLIGHT_MAX_TOKENS, ...(model ? { model } : {}) },
        );
        const verdict2 = r2?.incomplete
          ? { outcome: null, parser: 'incomplete', verdictReasonCode: r2.finishReason || 'length', hintAgreement: 'not_applicable' }
          : parseVerdictDetail(String(r2?.reply || ''));
        decisiveReaskResult = sanitizeDecisiveReask({
          attempted: true,
          firstParser: verdict.parser,
          firstReasonCode: verdict.verdictReasonCode,
          firstHintAgreement: verdict.hintAgreement,
          secondParser: verdict2.parser,
          secondReasonCode: verdict2.verdictReasonCode,
          secondHintAgreement: verdict2.hintAgreement,
          outcome: verdict2.outcome,
        });
        if (verdict2.outcome === 1 || verdict2.outcome === 0) verdict = verdict2;
      } catch {
        decisiveReaskResult = sanitizeDecisiveReask({
          attempted: true,
          firstParser: verdict.parser,
          firstReasonCode: verdict.verdictReasonCode,
          firstHintAgreement: verdict.hintAgreement,
          secondParser: 'brain_error',
          secondReasonCode: 'brain_error',
          secondHintAgreement: 'not_applicable',
          outcome: null,
        });
      }
    }
    const outcome = verdict.outcome;
    const reason = outcome === null
      ? (/^(?:en|zh|json)_unknown$/.test(verdict.parser) ? 'llm_unknown' : 'llm_unparsed')
      : outcome === 1 ? 'llm_applied' : 'llm_failed';
    // P1-C 整改 F1：outcome=0 时透出本次落空是否仅靠 loosen 放宽正则才认（供 deriveSurpriseOrigin 标 loosen_fail 噪声桶）
    // P1[3]（修三方审查 minor，P1-A 延伸）：loosen 噪声判定只扫词面证据——剥离 embed 软证据行(含 embedSim= 标记)，
    //   防"语义相似但因果无关"的 embed 召回事件携带的失败词扰动 loosen_fail/action_failure origin 分桶。
    const lexicalEvidence = fullEvidence.split('\n').filter((line) => !line.includes(' embedSim=')).join('\n');
    const loosenOnly = outcome === 0 && isLoosenOnlyFailure(lexicalEvidence, loosenFail);
    return {
      outcome,
      reason,
      ...(loosenOnly ? { loosenOnly: true } : {}),
      evidenceStats: evStats,
      ...(evSummary ? { evidenceSummary: evSummary } : {}),
      ...(evCandidateSummary ? { evidenceCandidateSummary: evCandidateSummary } : {}),
      ...(evClaimAlignment ? { evidenceClaimAlignment: evClaimAlignment } : {}),
      ...(evDecisionHint ? { evidenceDecisionHint: evDecisionHint } : {}),
      replyStats: replyStats(reply),
      verdictParser: verdict.parser,
      ...(verdict.verdictReasonCode ? { verdictReasonCode: verdict.verdictReasonCode } : {}),
      ...(verdict.hintAgreement ? { hintAgreement: verdict.hintAgreement } : {}),
      ...(decisiveReaskResult ? { decisiveReask: decisiveReaskResult } : {}),
    };
  }

  /**
   * 心跳入口：取到期期望，逐条判证，明确者落账进 Brier。
   * @returns {Promise<{checked: number, resolved: number, judged?: Array<{id: number, outcome: 1|0|null, reason: string}>}>}
   */
  async function tick(t = now()) {
    if (!ledger?.due || !ledger?.resolve) return { checked: 0, resolved: 0 };
    let due = [];
    try { due = ledger.due(t) || []; } catch { due = []; }
    if (!due.length) return { checked: 0, resolved: 0 };
    const limit = Math.max(1, Number(maxPerTick) || 1);
    const selection = selectDueForFairness(due, t, limit);
    if (!selection.selected.length) {
      return {
        checked: 0,
        resolved: 0,
        judged: [],
        reason: selection.cooldownOnly ? 'cooldown' : 'no_ready_due',
        cooldownOnly: selection.cooldownOnly,
        cooldownCount: selection.cooldownCount,
        ...(selection.nextReadyAt ? { nextReadyAt: selection.nextReadyAt } : {}),
      };
    }
    const judged = [];
    let resolved = 0;
    for (const exp of selection.selected) {
      let v = await judgeOne(exp);
      if (v.outcome === 1 || v.outcome === 0) {
        try {
          const resolvedRow = ledger.resolve(exp.id, v.outcome, t);
          if (resolvedRow) {
            resolved += 1;
            // rank4 好奇回路：预测落空(outcome=0)且惊奇≥阈值 → 自动立「搞明白为什么没料到」研究目标。
            // 「被现实硬纠正后主动学习」的发动机；此前自动判证路径从不接 harvestSurprise（source=surprise 恒为 0）。
            if (v.outcome === 0 && goalSystem && typeof goalSystem.harvestSurprise === 'function') {
              try { goalSystem.harvestSurprise({ claim: exp.claim, surprise: resolvedRow.surprise, origin: deriveSurpriseOrigin(exp.source, { loosenOnly: v.loosenOnly }) }); } // P1-C 整改 F1+F2：据 source 推导 origin + loosen_fail 噪声分桶
              catch { /* 好奇立项失败不阻断判证 */ }
            }
          }
        } catch { /* 单条失败不阻断本跳 */ }
      } else if (decisiveFail) {
        // 步骤5：承诺类(owner_pred)到期反复判不出 → 四重护栏决定性判 FAILED（绝不碰 reflection/thought，绝不靠单次定生死）
        try {
          const dr = maybeDecisiveFail(exp, v, t);
          if (dr) { v = dr.v; resolved += dr.resolvedDelta; }
        } catch { /* 决定性判 FAILED 失败不阻断本跳 */ }
      }
      rememberJudgement(exp, v.outcome, t);
      judged.push({
        id: exp.id,
        outcome: v.outcome,
        reason: v.reason,
        ...(v.evidenceStats ? { evidenceStats: sanitizeEvidenceStats(v.evidenceStats) } : {}),
        ...(v.evidenceSummary ? { evidenceSummary: sanitizeEvidenceSummary(v.evidenceSummary) } : {}),
        ...(v.evidenceCandidateSummary ? { evidenceCandidateSummary: sanitizeEvidenceCandidateSummary(v.evidenceCandidateSummary) } : {}),
        ...(v.evidenceClaimAlignment ? { evidenceClaimAlignment: sanitizeEvidenceClaimAlignment(v.evidenceClaimAlignment) } : {}),
        ...(v.evidenceDecisionHint ? { evidenceDecisionHint: sanitizeEvidenceDecisionHint(v.evidenceDecisionHint) } : {}),
        ...(v.replyStats ? { replyStats: sanitizeReplyStats(v.replyStats) } : {}),
        ...(v.verdictParser ? { verdictParser: v.verdictParser } : {}),
        ...(v.verdictReasonCode ? { verdictReasonCode: safeVerdictTag(v.verdictReasonCode, 'unknown') } : {}),
        ...(v.hintAgreement ? { hintAgreement: safeVerdictTag(v.hintAgreement, 'unknown') } : {}),
        ...(v.decisiveReask ? { decisiveReask: sanitizeDecisiveReask(v.decisiveReask) } : {}),
        ...(v.finishReason ? { finishReason: v.finishReason } : {}),
      });
    }
    return {
      checked: judged.length,
      resolved,
      judged,
      ...(selection.cooldownCount ? { cooldownSkipped: selection.cooldownCount } : {}),
    };
  }

  /**
   * 非阻塞心跳入口：owner 手动踩拍和主心跳不应被慢模型判证拖住。
   * 后台判证仍会在完成时落账；未完成期间后续 tick 只留 in_flight 痕迹，不叠加模型调用。
   * @param {number} [t]
   * @param {{onResult?: (previousResult: object|null) => void}} [options]
   * @returns {{checked: number, resolved: number, judged: Array<object>, detached: true, reason: string, ageMs?: number}}
   */
  function tickDetached(t = now(), options = {}) {
    const onResult = typeof options?.onResult === 'function' ? options.onResult : null;
    const notify = () => {
      if (!onResult) return;
      try { onResult(summarizeDetachedResult(lastDetachedResult, { compact: true })); } catch { /* callback must not affect resolver */ }
    };
    if (!ledger?.due || !ledger?.resolve) return { checked: 0, resolved: 0, judged: [], detached: true, reason: 'disabled' };
    let due = [];
    try { due = ledger.due(t) || []; } catch { due = []; }
    const previousResult = summarizeDetachedResult(lastDetachedResult);
    if (!due.length) return { checked: 0, resolved: 0, judged: [], detached: true, reason: 'no_due', ...(previousResult ? { previousResult } : {}) };
    if (inFlight?.run) {
      return { checked: 0, resolved: 0, judged: [], detached: true, reason: 'in_flight', ageMs: Math.max(0, now() - inFlight.startedAt), ...(previousResult ? { previousResult } : {}) };
    }
    const startedAt = now();
    const run = Promise.resolve()
      .then(() => tick(t))
      .then(
        (result) => { lastDetachedResult = { ok: true, at: now(), result }; notify(); return result; },
        (e) => {
          lastDetachedResult = { ok: false, at: now(), error: e?.message || String(e) };
          notify();
          return null;
        },
      )
      .finally(() => { if (inFlight?.run === run) inFlight = null; });
    inFlight = { startedAt, run };
    return { checked: 0, resolved: 0, judged: [], detached: true, reason: 'started_background', ...(previousResult ? { previousResult } : {}) };
  }

  async function waitForIdle() {
    const run = inFlight?.run;
    if (run) await run.catch(() => null);
    return { inFlight: Boolean(inFlight?.run), lastDetachedResult };
  }

  return { tick, tickDetached, waitForIdle, judgeOne };
}
