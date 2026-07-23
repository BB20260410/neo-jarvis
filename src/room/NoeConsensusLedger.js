import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import {
  NOE_REQUIRED_BOUNDARY_IDS,
  validateNoeConsensusLedger,
} from './NoeConsensusGate.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_CONSENSUS_LEDGER_SCHEMA_VERSION = 1;
export const DEFAULT_NOE_CONSENSUS_LEDGER_DIR = 'output/noe-multimodel';

// 2026-07-02 P0 单源化：本文件旧有的私有 SECRET_PATTERNS 已删除，redaction 统一委托
//   NoeContextScrubber.redactSensitiveText（覆盖面为旧模式的严格超集：多 provider env key /
//   stripe / google / telegram / jwt / github / slack / aws / 通用 KEY=value / cookie-password 字段）。
export const NOE_CONSENSUS_REDACTION_POLICY_SUMMARY = Object.freeze([
  'unified_source: src/runtime/NoeContextScrubber.js SECRET_PATTERNS（全仓单源）',
  'provider_env_assignment: MINIMAX / OBSIDIAN / OPENAI / XIAOMI / ANTHROPIC / GEMINI 等',
  'authorization_bearer_header',
  'panel_owner_token_header_or_field',
  'vendor_key_shapes: sk- / sk_live / AIza / tp- / ghp_ / xox / AKIA / telegram / jwt',
  'generic_key_value_assignment_and_cookie_password_fields',
  'owner_token_query_parameter',
]);

function cleanString(value) {
  return String(value || '').trim();
}

export function sha256Text(value) {
  return createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

export function redactNoeConsensusText(value) {
  return redactSensitiveText(String(value || ''));
}

export function makeNoeConsensusRoundId(label = '', now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const slug = cleanString(label)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${stamp}${slug ? `-${slug}` : ''}-${randomUUID().slice(0, 8)}`;
}

export function resolveNoeConsensusRef(root, ref) {
  const text = cleanString(ref);
  if (!text) throw new Error('consensus ref required');
  if (isAbsolute(text)) throw new Error(`absolute consensus ref is not allowed: ${text}`);
  const full = resolve(root, text);
  const rel = relative(root, full);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`consensus ref escapes repo: ${text}`);
  return full;
}

export function buildNoeConsensusLedger(input = {}, opts = {}) {
  const createdAt = opts.createdAt || new Date().toISOString();
  const roundId = input.roundId || makeNoeConsensusRoundId(input.goal || 'noe-consensus', new Date(createdAt));
  const ledger = {
    schemaVersion: NOE_CONSENSUS_LEDGER_SCHEMA_VERSION,
    roundId,
    createdAt,
    goal: cleanString(input.goal),
    evidenceRef: cleanString(input.evidenceRef),
    requiredModels: Array.isArray(input.requiredModels) && input.requiredModels.length ? input.requiredModels : undefined,
    boundaries: Array.isArray(input.boundaries) ? input.boundaries : [...NOE_REQUIRED_BOUNDARY_IDS],
    votes: Array.isArray(input.votes) ? input.votes : [],
    implementation: input.implementation || {},
    artifacts: Array.isArray(input.artifacts) ? input.artifacts : [],
    notes: redactNoeConsensusText(input.notes || ''),
  };
  const validation = validateNoeConsensusLedger(ledger, opts.gate || {});
  return {
    ...ledger,
    gate: {
      ok: validation.ok,
      validated: validation.validated === true,
      errors: validation.errors,
      warnings: validation.warnings,
      consensus: validation.consensus,
      sha256: sha256Text(JSON.stringify({
        goal: ledger.goal,
        evidenceRef: ledger.evidenceRef,
        requiredModels: ledger.requiredModels,
        boundaries: ledger.boundaries,
        votes: ledger.votes,
        implementation: ledger.implementation,
        artifacts: ledger.artifacts,
      })),
    },
  };
}

export function validateNoeConsensusLedgerArtifact(ledger, opts = {}) {
  const root = opts.root || process.cwd();
  const errors = [];
  const warnings = [];
  const validation = validateNoeConsensusLedger(ledger, opts.gate || {});
  errors.push(...validation.errors);
  warnings.push(...validation.warnings);

  if (ledger?.schemaVersion !== NOE_CONSENSUS_LEDGER_SCHEMA_VERSION) {
    errors.push(`unsupported_schema_version:${ledger?.schemaVersion ?? 'missing'}`);
  }
  if (!cleanString(ledger?.roundId)) errors.push('ledger_round_id_required');
  if (!cleanString(ledger?.createdAt)) errors.push('ledger_created_at_required');

  if (opts.requireEvidenceFile && cleanString(ledger?.evidenceRef)) {
    try {
      const file = resolveNoeConsensusRef(root, ledger.evidenceRef);
      if (!existsSync(file)) errors.push(`missing_evidence_file:${ledger.evidenceRef}`);
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  for (const vote of Array.isArray(ledger?.votes) ? ledger.votes : []) {
    if (!cleanString(vote?.rawOutputRef)) {
      if (opts.requireRawOutputFiles) errors.push(`missing_raw_output_file_ref:${vote?.model || 'unknown'}`);
      continue;
    }
    try {
      const file = resolveNoeConsensusRef(root, vote.rawOutputRef);
      if (opts.requireRawOutputFiles && !existsSync(file)) errors.push(`missing_raw_output_file:${vote.model}:${vote.rawOutputRef}`);
      if (existsSync(file) && cleanString(vote.rawOutputSha256)) {
        const actual = sha256Text(readFileSync(file, 'utf8'));
        if (actual !== vote.rawOutputSha256) errors.push(`raw_output_sha256_mismatch:${vote.model}`);
      }
    } catch (e) {
      errors.push(e.message);
    }
  }

  if (ledger?.gate) {
    if (Boolean(ledger.gate.ok) !== Boolean(validation.ok)) errors.push('stored_gate_result_is_stale');
    if (ledger.gate.sha256 && ledger.gate.sha256 !== buildNoeConsensusLedger(ledger, { createdAt: ledger.createdAt }).gate.sha256) {
      errors.push('stored_gate_sha256_is_stale');
    }
  } else if (opts.requireStoredGate !== false) {
    errors.push('stored_gate_required');
  }

  return {
    ok: errors.length === 0 && validation.ok,
    errors,
    warnings,
    consensus: validation.consensus,
  };
}

export function writeNoeConsensusLedgerFile(ledger, opts = {}) {
  const root = opts.root || process.cwd();
  const outDir = resolveNoeConsensusRef(root, opts.outDir || DEFAULT_NOE_CONSENSUS_LEDGER_DIR);
  const roundDir = join(outDir, cleanString(ledger.roundId || makeNoeConsensusRoundId(ledger.goal)));
  mkdirSync(roundDir, { recursive: true });
  const file = join(roundDir, 'ledger.json');
  const text = `${JSON.stringify(ledger, null, 2)}\n`;
  writeFileSync(file, text, { mode: 0o600 });
  return file;
}

export function readNoeConsensusLedgerFile(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}
