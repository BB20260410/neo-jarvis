import { spawnWithTimeout } from './NoeSpawnWithTimeout.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MiniMaxChatAdapter } from './MiniMaxChatAdapter.js';
import { OpenAICompatChatAdapter } from './OpenAICompatChatAdapter.js';
import { buildNoePostReviewPrompt, validateNoePostReviewPack } from './NoePostReviewPack.js';
import { extractNoeConsensusVoteJson } from './NoeConsensusRound.js';
import {
  normalizeConsensusDecision,
  normalizeConsensusModelId,
  quorumThresholdForAvailableModels,
} from './NoeConsensusGate.js';
import {
  redactNoeConsensusText,
  sha256Text,
} from './NoeConsensusLedger.js';
import { CLAUDE_OPUS_48_MODEL, applyClaudeOpus48RuntimeDefaults } from './ClaudeRuntimeDefaults.js';
import { CODEX_GPT_55_MODEL, applyCodexGpt55RuntimeDefaults } from './CodexRuntimeDefaults.js';
import {
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../secrets/NoeProviderSecrets.js';
import { buildNoeSafeChildProcessEnv } from '../security/NoeHostExecEnv.js';

export const NOE_POST_REVIEW_RUNNER_SCHEMA_VERSION = 1;
export const DEFAULT_NOE_POST_REVIEW_RUNNER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const DEFAULT_GEMINI_PRO_MODEL = 'gemini-3.1-pro-preview';
const DEFAULT_XIAOMI_BASE_URL = 'https://token-plan-cn.xiaomimimo.com/v1';
const DEFAULT_XIAOMI_MODEL = 'mimo-v2.5-pro';
const APPROVAL_DECISIONS = new Set(['approve', 'approve_with_changes']);

function clean(value, max = 4000) {
  return redactNoeConsensusText(String(value ?? '').trim()).slice(0, max);
}

function modelAuthority(model) {
  const id = normalizeConsensusModelId(model);
  if (id === 'claude') return 'readonly_source_reviewer';
  if (id === 'm3') return 'suggestion_only';
  if (id === 'codex') return 'writer_integrator';
  return 'advisory';
}

function unavailableRaw(model, error) {
  return JSON.stringify({
    model,
    decision: 'unavailable',
    confidence: 0,
    authority: modelAuthority(model),
    canWrite: false,
    blockers: [`model_unavailable:${clean(error?.message || error || 'unknown', 1000)}`],
    verification_required: [],
    evidence_gaps: [],
    consensus_vote: 'abstain',
  }, null, 2);
}

function runSpawn({ command, args = [], stdin = '', cwd, env }) {
  // 复用 spawnWithTimeout：codex 没额度/认证卡死永不 close 时超时 SIGTERM+SIGKILL 快速失败（治飞轮停摆真凶——原裸
  //   spawn 无超时致 Promise 永不 resolve、selfEvolve tick 卡 running 几小时、整飞轮停摆）。timeoutMs 从 env
  //   NOE_SELFEVO_SPAWN_TIMEOUT_MS，默认 0=不超时（零回归、正常推理不误杀）；owner 设 >0（如 300000=5min）才超时杀卡死。
  return spawnWithTimeout({
    command,
    args,
    stdin,
    cwd,
    env: buildNoeSafeChildProcessEnv(process.env, {
      extraEnv: { LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8', ...(env || {}) },
    }),
    timeoutMs: Number(process.env.NOE_SELFEVO_SPAWN_TIMEOUT_MS) || 0,
  });
}

function codexOutFile(rawOutputFile) {
  const file = clean(rawOutputFile, 2000);
  return file ? `${file}.codex-out.txt` : '';
}

// cloud reviewer（m3/xiaomi 等经 HTTP adapter 的复核）调用：经代理访问国内服务（MiniMax api.minimax.chat）时偶发
//   TLS 波动（GFW 对出境 TLS 间歇干扰，SSL_ERROR_SYSCALL）/ 429 / 空回复。原 `await adapter._doChat` **裸调**——
//   一旦抛错会冒泡崩掉整个 post-review for 循环（claude/gemini 路径走 runSpawn 返回 result.ok 不抛，m3/xiaomi 却直接
//   await，是不一致缺陷：单个 cloud reviewer 失败 = 整轮 round 崩、reviewer 文件没写、manifest 永停 models_run、
//   reviews 永空、self-evolution cycle 永卡 post_review_required，DB complete=0 的实测根因）。
//   故 retry N 次（每次重新发起），仍空/抛 → unavailableRaw（quorum 不计、绝不假 approve、绝不崩 round）。
export async function callCloudReviewer(id, doChat, { attempts = 5 } = {}) {
  let lastErr = 'unknown';
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await doChat();
      const reply = response?.reply || String(response || '');
      if (clean(reply, 50)) return reply;
      lastErr = 'empty_reply';
    } catch (e) {
      lastErr = (e && e.message) || String(e);
      // 熔断短路（MODEL_CIRCUIT_OPEN，仅 NOE_MODEL_CIRCUIT_BREAKER 启用后出现）：该 reviewer 本轮已熔断，
      //   重试只会继续短路——立即 unavailable，不退避空转（让熔断的"快速失败 + 省往返"效果完整、不被退避抵消）。
      if (e?.code === 'MODEL_CIRCUIT_OPEN') return unavailableRaw(id, lastErr);
    }
    // 退避再试：经代理访问国内服务（MiniMax）偶发瞬时 TLS 波动 / 代理连接池竞争（实测：并发的 deep-research 多轮
    //   fetchContent 抢占 EnvHttpProxyAgent 连接时，m3 同期会连续 fetch failed）。失败后递增退避（0.4/0.8/1.2/1.6s）
    //   避开瞬时拥塞窗口，大幅提高经代理偶发失败的最终成功率（仍失败才 unavailable，绝不假 approve）。
    if (attempt < attempts) await new Promise((r) => setTimeout(r, 400 * attempt));
  }
  return unavailableRaw(id, `${lastErr} (after ${attempts} attempts)`);
}

async function runBuiltInReviewer(args) {
  const id = normalizeConsensusModelId(args?.model);
  try {
    return await runBuiltInReviewerInner(id, args);
  } catch (e) {
    // 防御命脉：任何 reviewer 路径意外抛错（secret 解析、adapter 构造等）都降级成 unavailable，绝不让单个 reviewer 崩整轮 round。
    return unavailableRaw(id || args?.model, (e && e.message) || String(e));
  }
}

async function runBuiltInReviewerInner(id, { model, prompt, rawOutputFile, root, secretResolver = resolveNoeProviderSecret }) {
  if (id === 'claude') {
    const claudeModel = process.env.NOE_CONSENSUS_CLAUDE_MODEL || CLAUDE_OPUS_48_MODEL;
    const args = ['--print', '--permission-mode', 'plan', '--tools', '', '--no-session-persistence', '--output-format', 'text', '--model', claudeModel];
    applyClaudeOpus48RuntimeDefaults(args, claudeModel);
    if (!args.includes('--effort')) args.push('--effort', 'max');
    const result = await runSpawn({ command: process.env.CLAUDE_BIN || 'claude', args, stdin: prompt, cwd: root });
    if (!result.ok) return unavailableRaw(id, result.error || result.stderr || `exit_${result.code}`);
    return result.stdout.trim();
  }
  if (id === 'gemini') {
    const geminiModel = process.env.NOE_CONSENSUS_GEMINI_MODEL || DEFAULT_GEMINI_PRO_MODEL;
    const result = await runSpawn({
      command: process.env.GEMINI_BIN || 'gemini',
      args: ['--skip-trust', '--approval-mode', 'plan', '--output-format', 'text', '-m', geminiModel, '--prompt', prompt],
      cwd: root,
    });
    if (!result.ok) return unavailableRaw(id, result.error || result.stderr || `exit_${result.code}`);
    return result.stdout.trim();
  }
  if (id === 'm3') {
    const secret = secretResolver('minimax');
    const apiKey = secret?.value || '';
    if (!apiKey) return unavailableRaw(id, describeNoeProviderSecretFailure('minimax', secret));
    const adapter = new MiniMaxChatAdapter({
      apiKey,
      baseUrl: process.env.MINIMAX_BASE_URL,
      model: process.env.MINIMAX_MODEL || 'MiniMax-M3',
    });
    return callCloudReviewer(id, () => adapter._doChat([{ role: 'user', content: prompt }], { noAbort: true }));
  }
  if (id === 'xiaomi') {
    const secret = secretResolver('xiaomi');
    const apiKey = secret?.value || '';
    if (!apiKey) return unavailableRaw(id, describeNoeProviderSecretFailure('xiaomi', secret));
    const adapter = new OpenAICompatChatAdapter({
      id: 'xiaomi-mimo',
      displayName: 'Xiaomi MiMo',
      apiKey,
      baseUrl: process.env.XIAOMI_BASE_URL || DEFAULT_XIAOMI_BASE_URL,
      model: process.env.XIAOMI_MODEL || DEFAULT_XIAOMI_MODEL,
      timeout: 0,
      temperature: 0.2,
      maxTokens: 4096,
    });
    return callCloudReviewer(id, () => adapter._doChat([{ role: 'user', content: prompt }], {
      noAbort: true,
      model: process.env.XIAOMI_MODEL || DEFAULT_XIAOMI_MODEL,
      temperature: 0.2,
      maxTokens: 4096,
    }));
  }
  if (id === 'codex') {
    const outFile = codexOutFile(rawOutputFile);
    if (!outFile) return unavailableRaw(id, 'raw_output_file_required');
    const codexModel = process.env.NOE_CONSENSUS_CODEX_MODEL || CODEX_GPT_55_MODEL;
    const args = ['exec', '--skip-git-repo-check', '-C', root, '-o', outFile, '-m', codexModel];
    applyCodexGpt55RuntimeDefaults(args, codexModel);
    args.push('-');
    const result = await runSpawn({ command: process.env.CODEX_BIN || 'codex', args, stdin: prompt, cwd: root });
    if (existsSync(outFile)) return readFileSync(outFile, 'utf8');
    if (!result.ok) return unavailableRaw(id, result.error || result.stderr || `exit_${result.code}`);
    return result.stdout.trim();
  }
  return unavailableRaw(id || model, `unknown_reviewer:${model}`);
}

export function buildNoePostReviewFromRaw({ reviewer, rawOutput, rawOutputRef }) {
  const model = normalizeConsensusModelId(reviewer?.model || reviewer || '');
  const parsed = extractNoeConsensusVoteJson(rawOutput) || {};
  const parsedModel = normalizeConsensusModelId(parsed.model);
  const finalModel = parsedModel || model;
  const decision = normalizeConsensusDecision(parsed.decision || parsed.voteDecision || 'unavailable');
  return {
    model: finalModel,
    decision,
    confidence: typeof parsed.confidence === 'number' ? parsed.confidence : undefined,
    authority: clean(parsed.authority || modelAuthority(finalModel), 120),
    canWrite: false,
    rawOutputRef: clean(rawOutputRef, 1000),
    rawOutputSha256: sha256Text(`${redactNoeConsensusText(rawOutput)}\n`),
    blockers: Array.isArray(parsed.blockers) ? parsed.blockers.map((item) => clean(item, 1000)) : [],
    verification_required: Array.isArray(parsed.verification_required) ? parsed.verification_required.map((item) => clean(item, 1000)) : [],
    evidence_gaps: Array.isArray(parsed.evidence_gaps) ? parsed.evidence_gaps.map((item) => clean(item, 1000)) : [],
    consensus_vote: clean(parsed.consensus_vote || parsed.consensusVote || '', 80),
  };
}

function requiredReviewerSet(pack) {
  return new Set((pack.postReviewPlan?.reviewers || [])
    .filter((reviewer) => reviewer.required === true)
    .map((reviewer) => normalizeConsensusModelId(reviewer.model))
    .filter(Boolean));
}

export function evaluateNoePostReviewResults(reviews = [], pack = {}) {
  const required = requiredReviewerSet(pack);
  const errors = [];
  const byModel = new Map();
  for (const review of Array.isArray(reviews) ? reviews : []) {
    const model = normalizeConsensusModelId(review?.model);
    if (!model || !required.has(model)) continue;
    if (byModel.has(model)) errors.push(`post_review_duplicate_required_reviewer:${model}`);
    byModel.set(model, review);
    if (!clean(review.rawOutputRef, 1000)) errors.push(`post_review_missing_raw_output_ref:${model}`);
    if (review.canWrite === true) errors.push(`post_review_reviewer_must_not_write:${model}`);
    if (model === 'm3' && review.authority !== 'suggestion_only') errors.push('post_review_m3_must_be_suggestion_only');
  }
  for (const model of required) {
    if (!byModel.has(model)) errors.push(`post_review_missing_required_reviewer:${model}`);
  }
  const requiredReviews = [...byModel.values()];
  const available = requiredReviews.filter((review) => review.decision !== 'unavailable');
  const approvals = requiredReviews.filter((review) => APPROVAL_DECISIONS.has(review.decision));
  const unavailable = requiredReviews.filter((review) => review.decision === 'unavailable').map((review) => review.model);
  const quorum = quorumThresholdForAvailableModels(available.length);
  if (!quorum.ok) errors.push(`post_review_${quorum.reason}`);
  if (approvals.length < quorum.threshold) errors.push(`post_review_dynamic_quorum_required:${approvals.length}/${quorum.threshold}`);
  return {
    ok: errors.length === 0,
    errors,
    threshold: quorum.threshold,
    availableCount: available.length,
    approvedCount: approvals.length,
    approvals: approvals.map((review) => review.model),
    unavailable,
  };
}

function buildCodexFallbackPrompt({ fallbackFor, pack, unavailableRaw }) {
  return [
    'You are Codex providing supplemental fallback review for an unavailable Noe post-review model.',
    'Return only JSON. Do not edit files. Do not run commands. Do not expose secret values.',
    'This fallback is Codex evidence only and must not be counted as the unavailable reviewer vote.',
    '',
    'Required JSON shape:',
    '{',
    '  "model": "codex",',
    `  "fallback_for": "${fallbackFor}",`,
    '  "counted_in_post_review_quorum": false,',
    '  "decision": "approve|approve_with_changes|reject|abstain",',
    '  "confidence": 0.0,',
    '  "authority": "writer_integrator_supplemental",',
    '  "canWrite": true,',
    '  "blockers": [],',
    '  "verification_required": [],',
    '  "evidence_gaps": [],',
    '  "consensus_vote": "yes|no|abstain"',
    '}',
    '',
    '# Fallback for',
    fallbackFor,
    '',
    '# Unavailable raw excerpt',
    clean(unavailableRaw, 4000),
    '',
    '# Pack summary',
    JSON.stringify({
      goal: pack.goal,
      consensus: pack.consensus,
      implementation: pack.implementation,
      runtimeVerification: pack.runtimeVerification,
      rollback: pack.rollback,
      tests: pack.tests,
    }, null, 2),
  ].join('\n');
}

async function maybeRunCodexFallback({ review, pack, roundRelDir, roundDir, root, runners, secretResolver, enabled }) {
  if (!enabled || review.model === 'codex' || review.decision !== 'unavailable') return null;
  const rawOutputRef = join(roundRelDir, `codex-fallback-for-${review.model}.txt`);
  const rawOutputFile = join(roundDir, `codex-fallback-for-${review.model}.txt`);
  const prompt = buildCodexFallbackPrompt({ fallbackFor: review.model, pack, unavailableRaw: JSON.stringify(review, null, 2) });
  const runner = runners?.codex;
  const raw = runner
    ? await runner({ model: 'codex', prompt, rawOutputRef, rawOutputFile, root, fallbackFor: review.model, countedInPostReviewQuorum: false })
    : await runBuiltInReviewer({ model: 'codex', prompt, rawOutputFile, root, secretResolver });
  const stored = `${redactNoeConsensusText(raw)}\n`;
  writeFileSync(rawOutputFile, stored, { mode: 0o600 });
  return {
    type: 'codex_post_review_fallback',
    model: 'codex',
    fallbackFor: review.model,
    countedInPostReviewQuorum: false,
    rawOutputRef,
    rawOutputSha256: sha256Text(stored),
    reason: 'reviewer_unavailable_or_no_quota',
  };
}

export async function runNoePostReviewRound(input = {}, opts = {}) {
  const root = opts.root || DEFAULT_NOE_POST_REVIEW_RUNNER_ROOT;
  if (input.runModels && input.costAcknowledged !== true) throw new Error('model_cost_ack_required');
  const pack = input.pack || {};
  const packValidation = validateNoePostReviewPack(pack, { requireReviewerOutputRefs: true });
  if (!packValidation.ok) return { ok: false, status: 'pack_invalid', errors: packValidation.errors };

  const roundId = clean(input.roundId || `post-review-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}`, 120);
  const outDir = clean(input.outDir || 'output/noe-post-review', 1000);
  const roundRelDir = join(outDir, roundId);
  const roundDir = resolve(root, roundRelDir);
  mkdirSync(roundDir, { recursive: true });

  const reviewers = (pack.postReviewPlan?.reviewers || []).map((reviewer) => ({
    ...reviewer,
    model: normalizeConsensusModelId(reviewer.model),
    rawOutputRef: join(roundRelDir, `${normalizeConsensusModelId(reviewer.model)}-post-review.txt`),
    rawOutputFile: join(roundDir, `${normalizeConsensusModelId(reviewer.model)}-post-review.txt`),
    prompt: buildNoePostReviewPrompt({ pack, reviewer: reviewer.model }),
  }));
  const manifest = {
    schemaVersion: NOE_POST_REVIEW_RUNNER_SCHEMA_VERSION,
    ok: true,
    status: input.runModels ? 'models_run' : 'dry_run',
    roundId,
    packRef: clean(input.packRef || '', 1000),
    codexFallbackPolicy: {
      enabled: input.codexFallbackOnUnavailable !== false,
      countedInPostReviewQuorum: false,
      reason: 'reviewer_unavailable_or_no_quota',
    },
    reviewers: reviewers.map((reviewer) => ({
      model: reviewer.model,
      required: reviewer.required === true,
      authority: reviewer.authority,
      canWrite: false,
      rawOutputRef: reviewer.rawOutputRef,
      promptChars: reviewer.prompt.length,
    })),
  };
  writeFileSync(join(roundDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  if (!input.runModels) return { ...manifest, roundDir, reviews: [], postReview: null };

  const reviews = [];
  const fallbackArtifacts = [];
  for (const reviewer of reviewers) {
    const runner = opts.runners?.[reviewer.model];
    const raw = runner
      ? await runner({ ...reviewer, root, pack })
      : await runBuiltInReviewer({ ...reviewer, root, secretResolver: opts.secretResolver });
    const stored = `${redactNoeConsensusText(raw)}\n`;
    writeFileSync(reviewer.rawOutputFile, stored, { mode: 0o600 });
    const review = buildNoePostReviewFromRaw({ reviewer, rawOutput: raw, rawOutputRef: reviewer.rawOutputRef });
    reviews.push(review);
    const fallback = await maybeRunCodexFallback({
      review,
      pack,
      roundRelDir,
      roundDir,
      root,
      runners: opts.runners,
      secretResolver: opts.secretResolver,
      enabled: input.codexFallbackOnUnavailable !== false,
    });
    if (fallback) fallbackArtifacts.push(fallback);
  }
  const summary = evaluateNoePostReviewResults(reviews, pack);
  const postReview = {
    ok: summary.ok,
    reviews,
    approvals: summary.approvedCount,
    dynamicQuorum: summary,
    artifacts: fallbackArtifacts,
  };
  manifest.status = summary.ok ? 'post_review_passed' : 'post_review_blocked';
  manifest.fallbacks = fallbackArtifacts;
  writeFileSync(join(roundDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(join(roundDir, 'post-review.json'), `${JSON.stringify(postReview, null, 2)}\n`, { mode: 0o600 });
  return {
    ok: summary.ok,
    status: manifest.status,
    roundId,
    roundDir,
    manifestRef: relative(root, join(roundDir, 'manifest.json')),
    postReviewRef: relative(root, join(roundDir, 'post-review.json')),
    postReview,
  };
}
