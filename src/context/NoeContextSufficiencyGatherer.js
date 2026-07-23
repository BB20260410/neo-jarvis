import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_CONTEXT_SUFFICIENCY_SCHEMA_VERSION = 1;

const BLOCKED_SOURCE_PATTERNS = [
  /\.env(?:\.|$)/i,
  /id_rsa|id_ed25519/i, // 解 L3：移除 ssh/known_hosts host 元数据（可读，用于本地感知注入），仅保留私钥文件名（内容敏感）
  /keychain|cookie|token|secret|api[_-]?key/i,
  /Library\/Keychains/i,
];

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function clampRounds(value, fallback = 1) {
  const n = Math.max(1, Math.floor(Number(value) || fallback));
  return Math.min(n, 3);
}

function normalizeSource(source = {}) {
  const text = clean(source.text || source.content || source.summary || '', 4000);
  const ref = clean(source.ref || source.path || source.id || '', 1000);
  const kind = clean(source.kind || source.type || 'context', 120) || 'context';
  return {
    kind,
    ref,
    text,
    available: source.available !== false && Boolean(text || ref),
    sensitive: source.sensitive === true || BLOCKED_SOURCE_PATTERNS.some((pattern) => pattern.test(`${kind}\n${ref}\n${text}`)),
  };
}

function normalizeRequired(item = {}) {
  const text = typeof item === 'string' ? item : (item.id || item.kind || item.description || item.query);
  return {
    id: clean(text, 160),
    description: clean(typeof item === 'string' ? item : (item.description || item.query || text), 500),
    critical: item.critical !== false,
    keywords: Array.isArray(item.keywords) ? item.keywords.map((keyword) => clean(keyword, 120).toLowerCase()).filter(Boolean) : [],
  };
}

function sourceMatchesRequirement(source, requirement) {
  if (requirement.keywords.length) {
    // keywords 是调用方显式指定的判据，扫全文（含 text）合理
    const haystack = `${source.kind}\n${source.ref}\n${source.text}`.toLowerCase();
    return requirement.keywords.some((keyword) => haystack.includes(keyword));
  }
  // 审计 §3.3 P1⑤：无 keywords 时只在 kind/ref（结构化短字段）匹配 id，不再扫整个 text——
  // 否则短 id（如 "user"）会被任意 source 的正文 includes 命中，使充分性检查形同虚设。
  if (!requirement.id) return false;
  const refHaystack = `${source.kind}\n${source.ref}`.toLowerCase();
  return refHaystack.includes(requirement.id.toLowerCase());
}

function bundleSources(contextBundle = {}) {
  const sources = [];
  for (const source of contextBundle.sources || []) sources.push(normalizeSource(source));
  for (const message of contextBundle.messages || []) sources.push(normalizeSource({ kind: `message:${message.role || 'unknown'}`, text: message.content || '' }));
  if (contextBundle.systemPromptAddition) sources.push(normalizeSource({ kind: 'systemPromptAddition', text: contextBundle.systemPromptAddition }));
  return sources;
}

export function evaluateNoeContextSufficiency({
  goal = '',
  contextBundle = {},
  requiredContext = [],
  allowedSources = [],
  maxRounds = 1,
  roundsUsed = 0,
  gatheredEvidenceRefs = [],
  riskLevel = 'low',
  action = '',
} = {}) {
  const normalizedGoal = clean(goal, 2000);
  const roundBudget = clampRounds(maxRounds, riskLevel === 'low' ? 1 : 2);
  const used = Math.min(Math.max(0, Number(roundsUsed) || 0), roundBudget);
  const sources = bundleSources(contextBundle);
  for (const source of allowedSources || []) sources.push(normalizeSource(source));
  const blockedSources = sources.filter((source) => source.sensitive);
  const safeSources = sources.filter((source) => !source.sensitive && source.available);
  const required = (Array.isArray(requiredContext) ? requiredContext : [requiredContext]).map(normalizeRequired).filter((item) => item.id || item.description);
  const missingContext = [];
  for (const requirement of required) {
    if (!safeSources.some((source) => sourceMatchesRequirement(source, requirement))) missingContext.push(requirement);
  }
  const blockers = [];
  if (!normalizedGoal) blockers.push('goal_required');
  if (blockedSources.length) blockers.push(...blockedSources.map((source) => `blocked_sensitive_source:${source.kind}:${source.ref || 'inline'}`));
  if (missingContext.some((item) => item.critical)) blockers.push('critical_context_missing');
  if (used >= roundBudget && missingContext.length) blockers.push('context_gather_round_budget_exhausted');
  const gatherRequests = missingContext.map((item) => ({
    id: item.id,
    query: item.description || item.id,
    allowedOnly: true,
    critical: item.critical,
  }));
  const sufficient = blockers.length === 0 && missingContext.length === 0;
  return {
    schemaVersion: NOE_CONTEXT_SUFFICIENCY_SCHEMA_VERSION,
    ok: blockers.length === 0,
    sufficient,
    goal: normalizedGoal,
    action: clean(action, 160),
    riskLevel: clean(riskLevel, 40) || 'low',
    roundsUsed: used,
    maxRounds: roundBudget,
    sources: safeSources.map((source) => ({ kind: source.kind, ref: source.ref, available: source.available })),
    blockedSources: blockedSources.map((source) => ({ kind: source.kind, ref: source.ref || 'inline' })),
    missingContext,
    gatherRequests,
    gatheredEvidenceRefs: (Array.isArray(gatheredEvidenceRefs) ? gatheredEvidenceRefs : []).map((ref) => clean(ref, 1000)).filter(Boolean),
    blockers,
  };
}

export function buildNoeContextSufficiencyBlock(result = {}) {
  return [
    '<noe-context-sufficiency>',
    JSON.stringify({
      sufficient: result.sufficient === true,
      missingContext: result.missingContext || [],
      gatherRequests: result.gatherRequests || [],
      blockers: result.blockers || [],
      roundsUsed: result.roundsUsed || 0,
      maxRounds: result.maxRounds || 1,
    }, null, 2),
    '</noe-context-sufficiency>',
  ].join('\n');
}

