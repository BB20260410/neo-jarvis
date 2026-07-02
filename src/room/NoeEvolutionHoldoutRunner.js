// @ts-check
// NoeEvolutionHoldoutRunner — holdout 评测：string-include/forbidden 硬门(权威) +
// 可选 qwen3-embedding 余弦语义【连续分】附加维度(防"塞关键词式 reward hacking")。
// 语义分绝不绕过硬门、绝不单独翻转采纳；fallback 到 hash 标低可信(lowConfidence)绝不当通过；
// 全程 fail-open(embedding 炸了退回纯硬门，不锁死)。env NOE_HOLDOUT_SEMANTIC 默认 OFF=逐字零回归。
import { cosineSim } from '../embeddings/EmbeddingProvider.js';
import { embed as defaultEmbed } from '../embeddings/EmbeddingProvider.js';

export const NOE_EVOLUTION_HOLDOUT_RUNNER_SCHEMA_VERSION = 1;

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function asList(value) {
  return Array.isArray(value) ? value.map((item) => clean(item, 240)).filter(Boolean) : [];
}

function outputFor(outputs = {}, testCase = {}, field = '') {
  if (field && typeof testCase[field] === 'string') return testCase[field];
  const id = clean(testCase.id, 160);
  if (outputs && typeof outputs === 'object' && !Array.isArray(outputs)) {
    return clean(outputs[id] ?? outputs[testCase.input] ?? '', 8000);
  }
  return '';
}

export function scoreNoeHoldoutOutput(output = '', testCase = {}) {
  const text = clean(output, 8000).toLowerCase();
  const expectedIncludes = asList(testCase.expectedIncludes);
  const forbiddenIncludes = asList(testCase.forbiddenIncludes);
  const checks = [];
  for (const item of expectedIncludes) {
    checks.push({
      kind: 'expected_include',
      value: item,
      ok: text.includes(item.toLowerCase()),
    });
  }
  for (const item of forbiddenIncludes) {
    checks.push({
      kind: 'forbidden_include',
      value: item,
      ok: !text.includes(item.toLowerCase()),
    });
  }
  if (!checks.length) return { ok: false, score: 0, errors: ['holdout_case_expectations_required'], checks: [] };
  const passed = checks.filter((check) => check.ok).length;
  return {
    ok: true,
    score: passed / checks.length,
    passed,
    total: checks.length,
    checks,
  };
}

const round4 = (x) => Math.round(x * 10000) / 10000;
const clamp01 = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));

// fallback 判据：embed 显式 fallback 标志，或 provider 名落到 hash（hash / hash-fallback）。
function isFallbackEmbedding(result = {}) {
  return Boolean(result?.fallback) || String(result?.provider || '').toLowerCase().includes('hash');
}

// 语义"期望"文本：优先 testCase.expectedText（新可选字段），否则退回 expectedIncludes 拼接。
function semanticExpectedText(testCase = {}) {
  const direct = clean(testCase.expectedText, 8000);
  if (direct) return direct;
  return asList(testCase.expectedIncludes).join(' ');
}

// 给单条结果叠加 qwen3-embedding 余弦语义【连续分】作为附加维度。
// 硬门(scoreNoeHoldoutOutput)权威：硬门 fail 直接返回硬门结果，语义不参与。
// fail-open：embed 不可用/抛错/空向量 → 返回 { ...hard, semantic:{ok:false,reason} }，硬门结果完整保留。
// fallback 到 hash → lowConfidence:true 且 pass:false（绝不把低可信语义分当 semantic 通过）。
export async function scoreNoeHoldoutOutputSemantic(output = '', testCase = {}, {
  embed = defaultEmbed,
  semanticThreshold = Number(process.env.NOE_HOLDOUT_SEMANTIC_THRESHOLD) || 0.6,
} = {}) {
  const hard = scoreNoeHoldoutOutput(output, testCase);
  // 硬门权威：scoreNoeHoldoutOutput.ok 恒 true（只要有 checks），真硬门信号是 score——
  // score<1 表示 include 没全命中或 forbidden 命中，此时语义绝不参与（语义救不了硬门）。无 embed 同样不算。
  if (!hard.ok || hard.score < 1 || typeof embed !== 'function') return hard;
  const expectedText = semanticExpectedText(testCase);
  const candidateText = clean(output, 8000);
  if (!expectedText || !candidateText) {
    return { ...hard, semantic: { ok: false, reason: 'semantic_text_missing' } };
  }
  try {
    const e1 = await embed(candidateText);
    const e2 = await embed(expectedText);
    const v1 = e1?.vector;
    const v2 = e2?.vector;
    if (!v1 || !v2 || !v1.length || !v2.length) {
      return { ...hard, semantic: { ok: false, reason: 'embedding_empty' } };
    }
    const sim = round4(clamp01(cosineSim(v1, v2)));
    const lowConfidence = isFallbackEmbedding(e1) || isFallbackEmbedding(e2);
    // lowConfidence 时即便相似度过阈也绝不算通过。
    const pass = !lowConfidence && sim >= semanticThreshold;
    return {
      ...hard,
      semantic: {
        ok: true,
        score: sim,
        threshold: round4(clamp01(semanticThreshold)),
        pass,
        lowConfidence,
        provider: String(e1?.provider || ''),
        model: String(e1?.model || ''),
        dim: v1.length,
        fallback: Boolean(e1?.fallback || e2?.fallback),
      },
    };
  } catch (err) {
    return { ...hard, semantic: { ok: false, reason: 'embed_failed', error: String(err?.message || err).slice(0, 200) } };
  }
}

// env 门控：NOE_HOLDOUT_SEMANTIC==='1' 才开（默认 OFF）。
function holdoutSemanticEnabled(enabled) {
  if (typeof enabled === 'boolean') return enabled;
  return process.env.NOE_HOLDOUT_SEMANTIC === '1';
}

// runNoeEvolutionHoldout 的语义增强异步版：
//   - OFF（默认）或未注入 embed → 直接 return runNoeEvolutionHoldout(opts)，形状字节级一致，零回归。
//   - ON → 硬门聚合完全沿用 runNoeEvolutionHoldout 的口径（ok/delta/baselineScore/candidateScore 仍由
//     string 硬门驱动，语义【永不翻转采纳】），再对 candidate 叠加语义维度 + 聚合 semantic 汇总。
export async function runNoeEvolutionHoldoutSemantic(opts = {}) {
  const base = runNoeEvolutionHoldout(opts);
  const { embed = defaultEmbed, semantic, semanticThreshold } = opts || {};
  if (!holdoutSemanticEnabled(semantic) || typeof embed !== 'function') return base;

  const cases = Array.isArray(opts.dataset?.cases) ? opts.dataset.cases : [];
  const semByIndex = [];
  for (let i = 0; i < base.results.length; i++) {
    const testCase = cases[i] || {};
    const candidateOutput = outputFor(opts.candidateOutputs || {}, testCase, 'candidateOutput');
    let sem = { ok: false, reason: 'candidate_output_missing' };
    if (candidateOutput) {
      const scored = await scoreNoeHoldoutOutputSemantic(candidateOutput, testCase, { embed, semanticThreshold });
      sem = scored.semantic || { ok: false, reason: 'hard_gate_failed' };
    }
    semByIndex.push(sem);
  }

  const okSemantic = semByIndex.filter((s) => s && s.ok);
  const anyLowConfidence = okSemantic.some((s) => s.lowConfidence);
  const meanCandidateSemantic = okSemantic.length
    ? round4(okSemantic.reduce((sum, s) => sum + (s.score || 0), 0) / okSemantic.length)
    : null;
  // 通过计数：只数非低可信的真通过（低可信不计为 semantic 通过）。
  const passedSemantic = okSemantic.filter((s) => s.pass).length;
  const sample = okSemantic[0] || {};

  return {
    ...base,
    results: base.results.map((r, i) => ({ ...r, semantic: semByIndex[i] })),
    semantic: {
      enabled: true,
      // 任一案例 fallback 到 hash → 整体标低可信。
      lowConfidence: okSemantic.length === 0 ? true : anyLowConfidence,
      meanCandidateSemantic,
      passedSemantic,
      evaluated: okSemantic.length,
      total: base.results.length,
      provider: String(sample.provider || ''),
      model: String(sample.model || ''),
      dim: Number(sample.dim) || 0,
      threshold: okSemantic.length ? sample.threshold : (round4(clamp01(Number(semanticThreshold) || Number(process.env.NOE_HOLDOUT_SEMANTIC_THRESHOLD) || 0.6))),
    },
  };
}

export function runNoeEvolutionHoldout({
  dataset = {},
  datasetRef = '',
  baselineOutputs = {},
  candidateOutputs = {},
  minCases = 1,
} = {}) {
  const cases = Array.isArray(dataset.cases) ? dataset.cases : [];
  const errors = [];
  if (cases.length < Math.max(1, Number(minCases) || 1)) errors.push(`holdout_dataset_too_small:${cases.length}/${Math.max(1, Number(minCases) || 1)}`);
  const results = cases.map((testCase = {}, index) => {
    const id = clean(testCase.id || `case-${index + 1}`, 160);
    const baselineOutput = outputFor(baselineOutputs, testCase, 'baselineOutput');
    const candidateOutput = outputFor(candidateOutputs, testCase, 'candidateOutput');
    const baseline = scoreNoeHoldoutOutput(baselineOutput, testCase);
    const candidate = scoreNoeHoldoutOutput(candidateOutput, testCase);
    if (!baseline.ok) errors.push(`baseline:${id}:${baseline.errors.join(',')}`);
    if (!candidate.ok) errors.push(`candidate:${id}:${candidate.errors.join(',')}`);
    if (!baselineOutput) errors.push(`baseline_output_missing:${id}`);
    if (!candidateOutput) errors.push(`candidate_output_missing:${id}`);
    return {
      id,
      input: clean(testCase.input, 300),
      baselineScore: baseline.score,
      candidateScore: candidate.score,
      delta: candidate.score - baseline.score,
      baselineOutputPresent: Boolean(baselineOutput),
      candidateOutputPresent: Boolean(candidateOutput),
      failedChecks: {
        baseline: baseline.checks.filter((check) => !check.ok),
        candidate: candidate.checks.filter((check) => !check.ok),
      },
    };
  });
  const baselineScore = results.length
    ? results.reduce((sum, item) => sum + item.baselineScore, 0) / results.length
    : 0;
  const candidateScore = results.length
    ? results.reduce((sum, item) => sum + item.candidateScore, 0) / results.length
    : 0;
  return {
    ok: errors.length === 0,
    schemaVersion: NOE_EVOLUTION_HOLDOUT_RUNNER_SCHEMA_VERSION,
    datasetId: clean(dataset.id || dataset.name || 'holdout-dataset', 160),
    datasetRef: clean(datasetRef, 500),
    caseCount: cases.length,
    baselineScore,
    candidateScore,
    delta: candidateScore - baselineScore,
    errors,
    results,
  };
}

export function attachNoeHoldoutToCandidate(candidate = {}, holdoutReport = {}, reportRef = '') {
  return {
    ...candidate,
    holdout: {
      baselineScore: holdoutReport.baselineScore,
      candidateScore: holdoutReport.candidateScore,
      minDelta: candidate?.holdout?.minDelta ?? 0.001,
      reportRef: reportRef || holdoutReport.reportRef || holdoutReport.datasetRef || '',
    },
  };
}
