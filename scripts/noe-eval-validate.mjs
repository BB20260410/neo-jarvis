#!/usr/bin/env node
// @ts-check

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { validateNeoEvalArtifact } from '../src/eval/NeoEvalSchema.js';

const ROOT = resolve(process.cwd());

function rel(file) {
  return relative(ROOT, file).replaceAll('\\', '/');
}

function refPath(file) {
  return rel(resolve(ROOT, String(file || '').trim()));
}

function isPrivateHoldoutRef(file) {
  const ref = refPath(file);
  return ref === 'evals/neo/private_holdout'
    || ref.startsWith('evals/neo/private_holdout/')
    || ref.includes('/evals/neo/private_holdout/');
}

function artifactKind(input = {}) {
  if (input?.kind === 'neo_eval_raw_score') return 'raw_score';
  if (input?.caseSet) return 'run';
  if (input?.caseResults) return 'score';
  return 'case';
}

// 默认 walk 跳过「非 NeoEval-case 格式、自带独立 validator」的子树，避免把它们的 .json
// 误当 NeoEval case 校验而假红。selfimprove-bench 走 src/evals/NoeSelfImproveBench* 自校验；
// memory-bench(P6 记忆召回基准)的 cases 仍是合法 NeoEval case（可用 --check-artifacts 显式校验），
// 但同目录的 fixtures.json 是语料而非 case，故整子树跳过默认 walk，由其 runner 单测自校验。
const WALK_SKIP_DIRS = new Set(['selfimprove-bench', 'memory-bench']);

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && WALK_SKIP_DIRS.has(entry.name)) continue;
    const file = join(dir, entry.name);
    if (entry.isDirectory()) walk(file, out);
    else if (entry.isFile() && extname(entry.name) === '.json') out.push(file);
  }
  return out;
}

function parseArgs(argv) {
  const args = { files: [], checkArtifacts: false };
  for (const arg of argv) {
    if (arg === '--check-artifacts') args.checkArtifacts = true;
    else args.files.push(arg);
  }
  return args;
}

function refsForArtifact(input = {}) {
  const refs = [];
  if (Array.isArray(input?.source?.evidenceRefs)) refs.push(...input.source.evidenceRefs);
  if (input?.source?.episodeRef) refs.push(input.source.episodeRef);
  if (Array.isArray(input?.caseSet?.caseRefs)) refs.push(...input.caseSet.caseRefs);
  for (const ref of [input?.outputs?.rawRef, input?.outputs?.scoreRef]) {
    if (ref) refs.push(ref);
  }
  return refs.filter(Boolean);
}

function validateFile(file, { checkArtifacts = false } = {}) {
  const abs = resolve(ROOT, file);
  const ref = rel(abs);
  const errors = [];
  if (isPrivateHoldoutRef(file) && ref.endsWith('.json')) {
    return {
      file: ref,
      kind: 'private_holdout',
      parsed: null,
      ok: false,
      errors: ['private_holdout_json_must_not_be_committed'],
      warnings: [],
    };
  }
  let parsed = null;
  try {
    parsed = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (error) {
    return { file: ref, ok: false, errors: [`json_parse_failed:${String(error?.message || error).slice(0, 160)}`], warnings: [] };
  }
  const kind = artifactKind(parsed);
  const validation = validateNeoEvalArtifact(parsed, { kind });
  errors.push(...validation.errors);
  if (checkArtifacts) {
    for (const artifactRef of refsForArtifact(parsed)) {
      if (/^https?:\/\//.test(String(artifactRef))) continue;
      if (isPrivateHoldoutRef(artifactRef)) errors.push(`artifact_ref_private_holdout_forbidden:${artifactRef}`);
      else if (!existsSync(resolve(ROOT, artifactRef))) errors.push(`artifact_ref_missing:${artifactRef}`);
    }
    if (kind === 'run') {
      const rawRef = parsed?.outputs?.rawRef || '';
      if (rawRef && !isPrivateHoldoutRef(rawRef) && existsSync(resolve(ROOT, rawRef))) {
        try {
          const raw = JSON.parse(readFileSync(resolve(ROOT, rawRef), 'utf8'));
          if (raw?.kind !== 'neo_eval_raw_score') errors.push(`outputs_rawRef_kind_mismatch:${rawRef}:${raw?.kind || 'blank'}`);
          if (raw?.runId !== parsed.id) errors.push(`outputs_rawRef_runId_mismatch:${rawRef}:${raw?.runId || 'blank'}/${parsed.id || 'blank'}`);
          if (refPath(raw?.runRef || '') !== ref) errors.push(`outputs_rawRef_runRef_mismatch:${rawRef}:${raw?.runRef || 'blank'}/${ref}`);
        } catch (error) {
          errors.push(`outputs_rawRef_parse_failed:${rawRef}:${String(error?.message || error).slice(0, 160)}`);
        }
      }
    }
  }
  return {
    file: ref,
    kind,
    parsed,
    ok: errors.length === 0,
    errors,
    warnings: validation.warnings,
  };
}

function addCrossConsistencyErrors(results) {
  const caseByFile = new Map();
  const caseById = new Map();
  const runById = new Map();
  const scoreByRunId = new Map();

  for (const result of results) {
    if (!result.parsed) continue;
    if (result.kind === 'case') {
      caseByFile.set(result.file, result);
      if (result.parsed.id) caseById.set(String(result.parsed.id), result);
    } else if (result.kind === 'run') {
      if (result.parsed.id) runById.set(String(result.parsed.id), result);
    } else if (result.kind === 'score') {
      if (result.parsed.runId) scoreByRunId.set(String(result.parsed.runId), result);
    }
  }

  for (const result of results.filter((item) => item.kind === 'run' && item.parsed)) {
    const run = result.parsed;
    const runCaseIds = [];
    const expectedLayer = String(run.caseSet?.layer || '');
    for (const ref of Array.isArray(run.caseSet?.caseRefs) ? run.caseSet.caseRefs : []) {
      const normalizedRef = refPath(ref);
      const caseResult = caseByFile.get(normalizedRef);
      if (!caseResult) continue;
      const caseId = String(caseResult.parsed?.id || '');
      if (caseId) runCaseIds.push(caseId);
      if (caseResult.kind !== 'case') {
        result.errors.push(`case_ref_not_case:${ref}`);
      }
      if (caseResult.parsed?.layer !== expectedLayer) {
        result.errors.push(`case_ref_layer_mismatch:${ref}:${caseResult.parsed?.layer || 'blank'}/${expectedLayer || 'blank'}`);
      }
    }

    const scoreRef = run.outputs?.scoreRef ? refPath(run.outputs.scoreRef) : '';
    const scoreResult = results.find((item) => item.file === scoreRef);
    if (scoreResult && scoreResult.parsed?.runId !== run.id) {
      result.errors.push(`outputs_scoreRef_runId_mismatch:${run.outputs.scoreRef}:${scoreResult.parsed?.runId || 'blank'}/${run.id || 'blank'}`);
    }

    const scoreForRun = scoreByRunId.get(String(run.id || ''));
    if (scoreForRun && runCaseIds.length) {
      const allowedCaseIds = new Set(runCaseIds);
      for (const caseResult of Array.isArray(scoreForRun.parsed?.caseResults) ? scoreForRun.parsed.caseResults : []) {
        if (!allowedCaseIds.has(String(caseResult?.caseId || ''))) {
          scoreForRun.errors.push(`caseResult_caseId_not_in_run:${caseResult?.caseId || 'blank'}`);
        }
      }
    }
  }

  for (const result of results.filter((item) => item.kind === 'score' && item.parsed)) {
    const runId = String(result.parsed.runId || '');
    const run = runById.get(runId);
    if (!run) continue;
    const runCaseIds = new Set(
      (Array.isArray(run.parsed?.caseSet?.caseRefs) ? run.parsed.caseSet.caseRefs : [])
        .map((ref) => caseByFile.get(refPath(ref))?.parsed?.id)
        .filter(Boolean)
        .map(String),
    );
    for (const caseResult of Array.isArray(result.parsed.caseResults) ? result.parsed.caseResults : []) {
      const caseId = String(caseResult?.caseId || '');
      if (runCaseIds.size && !runCaseIds.has(caseId)) result.errors.push(`caseResult_caseId_not_in_run:${caseId || 'blank'}`);
      if (caseId && !caseById.has(caseId)) result.errors.push(`caseResult_caseId_not_in_validated_cases:${caseId}`);
    }
  }

  for (const result of results) {
    result.ok = result.errors.length === 0;
  }
}

function publicResult(result) {
  const { parsed: _parsed, ...item } = result;
  return item;
}

const args = parseArgs(process.argv.slice(2));
const files = args.files.length ? args.files : walk(resolve(ROOT, 'evals/neo'));
const results = files.map((file) => validateFile(file, { checkArtifacts: args.checkArtifacts }));
addCrossConsistencyErrors(results);
const failed = results.filter((item) => !item.ok);
const report = {
  ok: failed.length === 0,
  checked: results.length,
  failed: failed.length,
  policy: {
    runtimeTouched: false,
    memoryV2Writes: false,
    liveRestart: false,
    secretValuesReturned: false,
  },
  results: results.map(publicResult),
};

console.log(JSON.stringify(report, null, 2));
if (!report.ok) process.exit(1);
