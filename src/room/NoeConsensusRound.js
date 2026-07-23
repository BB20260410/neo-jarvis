import { readFileSync } from 'node:fs';
import {
  buildNoeConsensusLedger,
  redactNoeConsensusText,
  sha256Text,
} from './NoeConsensusLedger.js';
import {
  normalizeConsensusDecision,
  normalizeConsensusModelId,
} from './NoeConsensusGate.js';

const DEFAULT_AUTHORITIES = Object.freeze({
  codex: 'writer_integrator',
  claude: 'readonly_source_reviewer',
  gemini: 'advisory',
  m3: 'suggestion_only',
  xiaomi: 'advisory',
});
const M3_FORBIDDEN_CONTENT_FIELDS = Object.freeze([
  'diffs',
  'patches',
  'tool_calls',
  'toolCalls',
  'commands',
  'files_read',
  'filesRead',
  'fileWrites',
  'files_written',
]);

function cleanString(value) {
  return String(value || '').trim();
}

function cleanLedgerArrayItem(value) {
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value).slice(0, 4000).trim();
    } catch {
      return cleanString(value);
    }
  }
  return cleanString(value).slice(0, 4000);
}

function parseJsonCandidate(candidate) {
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractNoeConsensusVoteJsonWithStrategy(rawText) {
  const text = cleanString(rawText);
  if (!text) return { parsed: null, strategy: 'empty' };

  const direct = parseJsonCandidate(text);
  if (direct) return { parsed: direct, strategy: 'direct' };

  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]);
  for (const candidate of fenced.reverse()) {
    const parsed = parseJsonCandidate(candidate.trim());
    if (parsed) return { parsed, strategy: 'fenced_json' };
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const parsed = parseJsonCandidate(text.slice(firstBrace, lastBrace + 1));
    if (parsed) return { parsed, strategy: 'brace_slice' };
  }

  return { parsed: null, strategy: 'unparsed' };
}

export function extractNoeConsensusVoteJson(rawText) {
  return extractNoeConsensusVoteJsonWithStrategy(rawText).parsed;
}

function defaultCanWrite(model) {
  return model === 'codex';
}

function hasNonEmptyValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return Boolean(value);
}

function contentViolationsFor(model, parsed) {
  if (model !== 'm3') return [];
  return M3_FORBIDDEN_CONTENT_FIELDS.filter((field) => hasNonEmptyValue(parsed[field]));
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanLedgerArrayItem(item)).filter(Boolean);
}

export function buildNoeConsensusVoteFromRaw({ model, rawOutput, rawOutputRef, evidenceRef }) {
  const normalizedModel = normalizeConsensusModelId(model);
  const extracted = extractNoeConsensusVoteJsonWithStrategy(rawOutput);
  const parsed = extracted.parsed || {};
  const parsedModel = normalizeConsensusModelId(parsed.model);
  // 安全：投票身份只信可信槽（participant.model），绝不让模型自报的 parsed.model 改写身份/授权。
  // 自报与可信槽不一致 → 仍以可信槽为准并记违规；可信槽缺失时才退回自报（无可信来源可冒领）。
  const identityViolations = [];
  let finalModel = normalizedModel;
  if (!finalModel) {
    finalModel = parsedModel;
  } else if (parsedModel && parsedModel !== normalizedModel) {
    identityViolations.push(`model_identity_mismatch:claimed=${parsedModel}:trusted=${normalizedModel}`);
  }
  const rawDecision = parsed.decision || parsed.voteDecision || parsed.consensusDecision;
  const decision = normalizeConsensusDecision(rawDecision || 'unavailable');
  const parseStatus = rawDecision ? 'parsed' : 'unavailable';
  // 安全：身份被冒领时，自报的授权字段（canWrite/authority/firstClass）也不可信，
  // 一律退回"可信身份"的默认值，不让冒领者顺带夹带 canWrite:true 等提权声明。
  const identitySpoofed = identityViolations.length > 0;
  const canWrite = !identitySpoofed && typeof parsed.canWrite === 'boolean'
    ? parsed.canWrite
    : defaultCanWrite(finalModel);
  const authority = (!identitySpoofed && cleanString(parsed.authority)) || DEFAULT_AUTHORITIES[finalModel] || 'advisory';
  const firstClass = identitySpoofed
    ? finalModel === 'claude'
    : (finalModel === 'claude' ? parsed.firstClass !== false : parsed.firstClass);
  return {
    model: finalModel,
    decision,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
    authority,
    canWrite,
    firstClass,
    rawOutputRef: cleanString(rawOutputRef),
    rawOutputSha256: sha256Text(rawOutput),
    evidenceRef,
    blockers: cleanStringArray(Array.isArray(parsed.blockers) ? parsed.blockers : Array.isArray(parsed.must_fix_before_implementation) ? parsed.must_fix_before_implementation : []),
    recommendedFirstSlice: cleanStringArray(parsed.recommended_first_slice),
    verificationRequired: cleanStringArray(parsed.verification_required || parsed.verificationRequired),
    consensusVote: cleanString(parsed.consensus_vote || parsed.consensusVote || ''),
    contentViolations: contentViolationsFor(finalModel, parsed),
    identityViolations,
    parseStatus,
    parseStrategy: extracted.strategy,
    unavailableReason: decision === 'unavailable'
      ? cleanLedgerArrayItem(parsed.unavailable_reason || parsed.unavailableReason || parsed.reason || parsed.blockers?.[0] || (parseStatus === 'parsed' ? 'model_reported_unavailable' : 'unparsed_or_missing_decision'))
      : undefined,
  };
}

export function buildNoeConsensusLedgerFromRawOutputs(input = {}, opts = {}) {
  const participants = Array.isArray(input.participants) ? input.participants : [];
  const parseErrors = [];
  const votes = [];

  for (const participant of participants) {
    const rawOutput = redactNoeConsensusText(participant.rawOutput ?? readFileSync(participant.rawOutputFile, 'utf8'));
    const vote = buildNoeConsensusVoteFromRaw({
      model: participant.model,
      rawOutput,
      rawOutputRef: participant.rawOutputRef || participant.rawOutputFile,
      evidenceRef: input.evidenceRef,
    });
    if (vote.parseStatus !== 'parsed') parseErrors.push(`vote_unparsed:${vote.model || participant.model || 'unknown'}`);
    votes.push(vote);
  }

  const ledger = buildNoeConsensusLedger({
    roundId: input.roundId,
    goal: input.goal,
    evidenceRef: input.evidenceRef,
    requiredModels: input.requiredModels,
    boundaries: input.boundaries,
    votes,
    implementation: input.implementation,
    artifacts: input.artifacts,
    notes: input.notes,
  }, opts);

  return { ledger, votes, parseErrors };
}
