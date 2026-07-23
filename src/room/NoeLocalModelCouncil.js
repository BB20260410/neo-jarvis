import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOE_MAIN_BRAIN_MODEL, isMainBrainModel } from '../model/NoeLocalModelPolicy.js';
import { cleanVisibleModelText, redactSensitiveText, textContainsSecretLike } from '../runtime/NoeContextScrubber.js';

export const LOCAL_COUNCIL_SCHEMA_VERSION = 1;
export const DEFAULT_LOCAL_COUNCIL_DIR = 'output/noe-local-council';
export const DEFAULT_LOCAL_COUNCIL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// 2026-07-02 P0 单源化：私有 SECRET_PATTERNS 已删除，secret 识别统一走
//   NoeContextScrubber.textContainsSecretLike（与全仓 redaction 同一份模式，覆盖面更广）。

function clean(value) { return String(value || '').trim(); }
function nowStamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
function sha256(value) { return createHash('sha256').update(String(value || ''), 'utf8').digest('hex'); }
function safeFileId(value) { return clean(value).replace(/[^a-z0-9_.-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'model'; }

function councilTokenLimit(value, fallback, minimum) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(minimum, Math.trunc(n));
}

export function cleanLocalCouncilReviewRounds(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(3, Math.trunc(n)));
}

export function redactLocalCouncilText(value) {
  return redactSensitiveText(value);
}

export function makeLocalCouncilRoundId(label = 'local-council') {
  const slug = clean(label).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 52);
  return `${nowStamp()}-${slug || 'local-council'}-${randomUUID().slice(0, 8)}`;
}

function parseParamB(id = '') {
  const m = String(id).match(/(?:^|[-_])(\d+(?:\.\d+)?)b(?:[-_]|$)/i);
  return m ? Number(m[1]) : 0;
}

function isEmbeddingModel(id = '', capabilities = []) {
  return /(^|[-_:/@])(?:text-)?(?:embed|embedding)(?:[-_:/@]|$)/i.test(id)
    || (Array.isArray(capabilities) && capabilities.includes('embedding') && !capabilities.includes('completion'));
}

function isVisionModel(id = '', capabilities = []) {
  const name = String(id || '').toLowerCase();
  return /(^|[-_:/@])(?:vl|vision|image|visual)(?:[-_:/@]|$)/i.test(name)
    || (Array.isArray(capabilities) && capabilities.some((c) => /vision|image/i.test(c)));
}

function isStandaloneChatModel(id = '', capabilities = []) {
  const name = String(id || '').toLowerCase();
  if (/(^|[-_:/@])(?:mtp|drafter|draft-model|speculative)(?:[-_:/@]|$)/i.test(name)) return false;
  if (/(^|[-_:/@])assistant(?:[-_:/@]|$)/i.test(name)) return false;
  if (Array.isArray(capabilities) && capabilities.includes('embedding') && !capabilities.includes('completion')) return false;
  return true;
}

function scoreModel(model) {
  const id = String(model.id || '').toLowerCase();
  let score = parseParamB(id) * 10;
  if (isMainBrainModel(model.id) || id.includes(NOE_MAIN_BRAIN_MODEL)) score += 10000;
  if (/deepseek|gemma|qwen/.test(id)) score += 20;
  if (/architect|reason|coder|code/.test(id)) score += 16;
  if (/vl|vision|image/.test(id)) score += 6;
  if (/embed/.test(id)) score -= 1000;
  return score;
}

async function readJson(fetchImpl, url, opts = {}) {
  try {
    const resp = await fetchImpl(url, opts);
    const text = await resp.text().catch(() => '');
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {}
    return { ok: resp.ok, status: resp.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: e?.message || 'connection failed' };
  }
}

export async function discoverLocalModelProviders({ fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const lmBase = (env.LM_STUDIO_BASE_URL || env.NOE_LMSTUDIO_URL || 'http://127.0.0.1:1234/v1').replace(/\/$/, '');
  const ollamaBase = (env.OLLAMA_BASE_URL || env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
  const [lm, ollama] = await Promise.all([
    readJson(fetchImpl, `${lmBase}/models`, { headers: { Authorization: 'Bearer lm-studio' } }),
    readJson(fetchImpl, `${ollamaBase}/api/tags`),
  ]);

  const lmModels = (Array.isArray(lm.json?.data) ? lm.json.data : [])
    .map((m) => ({ id: clean(m.id), provider: 'lmstudio', baseUrl: lmBase, capabilities: m.capabilities || [] }))
    .filter((m) => m.id && !isEmbeddingModel(m.id, m.capabilities) && isStandaloneChatModel(m.id, m.capabilities))
    .map((m) => ({ ...m, paramB: parseParamB(m.id), vision: isVisionModel(m.id, m.capabilities), score: scoreModel(m) }));
  const ollamaModels = (Array.isArray(ollama.json?.models) ? ollama.json.models : [])
    .map((m) => ({ id: clean(m.name), provider: 'ollama', baseUrl: ollamaBase, capabilities: m.capabilities || [] }))
    .filter((m) => m.id && !isEmbeddingModel(m.id, m.capabilities) && isStandaloneChatModel(m.id, m.capabilities))
    .map((m) => ({ ...m, paramB: parseParamB(m.id), vision: isVisionModel(m.id, m.capabilities), score: scoreModel(m) }));

  const providers = [
    { id: 'lmstudio', label: 'LM Studio', available: lm.ok && lmModels.length > 0, baseUrl: lmBase, status: lm.ok ? `已连接 · ${lmModels.length} 个模型` : (lm.error || `HTTP ${lm.status}`), models: lmModels },
    { id: 'ollama', label: 'Ollama', available: ollama.ok && ollamaModels.length > 0, baseUrl: ollamaBase, status: ollama.ok ? `已连接 · ${ollamaModels.length} 个模型` : (ollama.error || `HTTP ${ollama.status}`), models: ollamaModels },
  ];
  const models = providers.flatMap((p) => p.models.map((m) => ({ ...m, providerLabel: p.label })));
  return { ok: true, providers, models, recommendedRoles: assignLocalCouncilRoles(models) };
}

export function assignLocalCouncilRoles(models = [], task = {}) {
  const usable = models.filter((m) => m?.id && m.provider).sort((a, b) => scoreModel(b) - scoreModel(a));
  const unique = [];
  for (const model of usable) {
    if (!unique.some((m) => `${m.provider}:${m.id}` === `${model.provider}:${model.id}`)) unique.push(model);
  }
  const reasoner = unique[0] || null;
  const critic = unique.find((m) => m !== reasoner && m.provider !== reasoner?.provider) || unique.find((m) => m !== reasoner) || null;
  const synthesizer = unique.find((m) => m !== critic && m !== reasoner) || reasoner || null;
  const router = [...unique].sort((a, b) => (a.paramB || 999) - (b.paramB || 999))[0] || null;
  const wantsVision = Boolean(task.hasImages || task.requiresVision);
  const visionReviewer = wantsVision ? unique.find((m) => m.vision) || null : null;
  return { router, reasoner, critic, synthesizer, visionReviewer };
}

export function evaluateLocalCouncilQuorum(participants = []) {
  const available = participants.filter((p) => p.status !== 'unavailable');
  const approvals = available.filter((p) => ['approve', 'approve_with_changes'].includes(p.decision));
  const threshold = available.length >= 4 ? 3 : available.length === 3 ? 2 : available.length === 2 ? 2 : Infinity;
  const errors = [];
  if (available.length < 2) errors.push(`insufficient_available_models:${available.length}`);
  if (available.length >= 2 && approvals.length < threshold) errors.push(`insufficient_approvals:${approvals.length}/${threshold}`);
  return {
    ok: errors.length === 0,
    availableCount: available.length,
    threshold: Number.isFinite(threshold) ? threshold : null,
    approvedCount: approvals.length,
    approvals: approvals.map((p) => p.modelKey),
    unavailable: participants.filter((p) => p.status === 'unavailable').map((p) => p.modelKey),
    errors,
  };
}

export function selectLocalCouncilModels(models = [], maxParticipants = 4) {
  const limit = Math.max(2, Math.min(8, Number(maxParticipants) || 4));
  const sorted = models.filter((m) => m?.id && m.provider).slice().sort((a, b) => scoreModel(b) - scoreModel(a));
  const selected = [];
  const add = (model) => {
    if (!model) return;
    const key = `${model.provider}:${model.id}`;
    if (selected.length < limit && !selected.some((m) => `${m.provider}:${m.id}` === key)) selected.push(model);
  };
  const providers = [...new Set(sorted.map((m) => m.provider))]
    .sort((a, b) => scoreModel(sorted.find((m) => m.provider === b)) - scoreModel(sorted.find((m) => m.provider === a)));
  const byProvider = new Map(providers.map((provider) => [provider, sorted.filter((m) => m.provider === provider)]));
  let index = 0;
  while (selected.length < limit) {
    let added = false;
    for (const provider of providers) {
      add(byProvider.get(provider)?.[index]);
      added = true;
      if (selected.length >= limit) break;
    }
    if (!added || providers.every((provider) => !byProvider.get(provider)?.[index + 1])) break;
    index += 1;
  }
  for (const model of sorted) add(model);
  return selected;
}

function modelKey(model) {
  return `${model.provider}:${model.id}`;
}

function extractJson(text = '') {
  const raw = String(text || '').trim().replace(/<\|channel\>[\s\S]*?(?=\{)/, '');
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const source = fenced || raw;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(source.slice(start, end + 1)); } catch { return null; }
}

export function cleanVisibleLocalCouncilAnswer(text = '') {
  const { text: value } = cleanVisibleModelText(text);
  const parsed = extractJson(value);
  const visible = parsed?.answer
    || parsed?.finalAnswer
    || parsed?.final_answer
    || parsed?.final
    || parsed?.response
    || value;
  return redactLocalCouncilText(visible).trim();
}

function normalizeDecision(value) {
  const v = clean(value).toLowerCase();
  return ['approve', 'approve_with_changes', 'reject', 'abstain'].includes(v) ? v : 'reject';
}

export function classifyLocalModelCallIssue(value = '') {
  const text = String(value || '');
  if (/model unloaded/i.test(text)) return 'model_unloaded';
  if (/HTTP 5\d\d/i.test(text) || /Internal Server Error/i.test(text)) return 'provider_server_error';
  if (/HTTP 4\d\d/i.test(text)) return 'provider_request_rejected';
  if (/connection failed|ECONNREFUSED|fetch failed|socket hang up/i.test(text)) return 'provider_unreachable';
  if (/raw_json_parse_failed/i.test(text)) return 'invalid_json_response';
  return text ? 'provider_call_failed' : 'unknown';
}

function redactParsed(value) {
  if (typeof value === 'string') return redactLocalCouncilText(value);
  if (Array.isArray(value)) return value.map(redactParsed);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactParsed(v)]));
  }
  return value;
}

async function callLocalModel(model, messages, opts = {}) {
  if (model.provider === 'ollama') {
    const body = { model: model.id, stream: false, messages, options: { temperature: opts.temperature ?? 0.2, num_predict: opts.maxTokens ?? 700 }, think: false };
    const out = await readJson(opts.fetchImpl, `${model.baseUrl.replace(/\/$/, '')}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!out.ok) throw new Error(out.error || `ollama HTTP ${out.status}`);
    return { text: clean(out.json?.message?.content), usage: { tokensIn: out.json?.prompt_eval_count || 0, tokensOut: out.json?.eval_count || 0 }, raw: out.json };
  }
  const body = { model: model.id, messages, temperature: opts.temperature ?? 0.2, max_tokens: opts.maxTokens ?? 700 };
  const out = await readJson(opts.fetchImpl, `${model.baseUrl.replace(/\/$/, '')}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer lm-studio' }, body: JSON.stringify(body) });
  if (!out.ok) throw new Error(out.error || `lmstudio HTTP ${out.status}: ${out.text?.slice(0, 200) || ''}`);
  return { text: clean(out.json?.choices?.[0]?.message?.content), usage: { tokensIn: out.json?.usage?.prompt_tokens || 0, tokensOut: out.json?.usage?.completion_tokens || 0 }, raw: out.json };
}

function rel(root, file) { return relative(root, file).replace(/\\/g, '/'); }

function writeRaw(roundDir, root, name, content) {
  const file = join(roundDir, name);
  const text = `${redactLocalCouncilText(content)}\n`;
  writeFileSync(file, text, { mode: 0o600 });
  return { ref: rel(root, file), sha256: sha256(text) };
}

function buildContextPrompt(input) {
  return `目标：${redactLocalCouncilText(input.goal || input.text || '')}\n边界：本地模型只做回答质量、反思、证据补强和建议；不能授权删除、上传、外部发布、密钥、重启或杀进程。\n证据：${redactLocalCouncilText(input.evidenceText || '')}`;
}

function modelForParticipant(models, participant) {
  return models.find((m) => `${m.provider}:${m.id}` === participant?.modelKey) || null;
}

function isPositiveDecision(decision) {
  return ['approve', 'approve_with_changes'].includes(decision);
}

function participantHasUsableAnswer(participant) {
  return participant?.status !== 'unavailable' && participant?.parsed && isPositiveDecision(participant.decision);
}

function orderParticipantsForReview(available, roles) {
  const ordered = [];
  const add = (participant) => {
    if (participant && !ordered.some((p) => p.modelKey === participant.modelKey)) ordered.push(participant);
  };
  for (const roleName of ['reasoner', 'critic', 'synthesizer', 'visionReviewer', 'router']) {
    const model = roles[roleName];
    if (!model) continue;
    add(available.find((p) => p.modelKey === `${model.provider}:${model.id}`));
  }
  for (const participant of available.slice().sort((a, b) => a.modelKey.localeCompare(b.modelKey))) add(participant);
  return ordered;
}

function summarizeReviewsForPrompt(reviews = []) {
  return reviews.map((review) => ({
    round: review.round,
    reviewer: review.reviewer,
    target: review.target,
    decision: review.decision,
    risks: review.risks || [],
    evidence_gaps: review.evidence_gaps || [],
    accepted_points: review.accepted_points || [],
    confidence: review.confidence ?? 0,
    errors: review.errors || [],
  }));
}

async function runOneCrossReview({ roundNumber, reviewRounds, reviewer, target, previousReviews, selected, roundDir, root, contextPack, fetchImpl, maxTokens }) {
  const reviewerModel = modelForParticipant(selected, reviewer);
  if (!target || !reviewer || !reviewerModel || reviewer.modelKey === target.modelKey) return null;

  const reviewPrompt = `${contextPack}\n\n你是第 ${roundNumber}/${reviewRounds} 轮本地模型交叉审阅者。请审阅目标模型输出，结合之前互评摘要继续找漏洞、反例、证据缺口和可采纳点；不要重复上一轮已经说清楚的内容。\n目标模型：${target.modelKey}\n目标决策：${target.decision}\n目标输出：${JSON.stringify(target.parsed || target.errors || {})}\n之前互评摘要：${JSON.stringify(summarizeReviewsForPrompt(previousReviews).slice(-12))}\n\n只输出 JSON：{"decision":"approve|approve_with_changes|reject|abstain","risks":["..."],"evidence_gaps":["..."],"accepted_points":["..."],"confidence":0.0}`;
  const startedAt = Date.now();
  const baseName = `cross-review-r${roundNumber}-${reviewerModel.provider}-${safeFileId(reviewerModel.id)}-to-${safeFileId(target.modelKey)}`;
  try {
    const out = await callLocalModel(reviewerModel, [{ role: 'user', content: reviewPrompt }], { fetchImpl, maxTokens: maxTokens || 600 });
    const raw = out.text || JSON.stringify(out.raw || {});
    const file = writeRaw(roundDir, root, `${baseName}.raw.txt`, raw);
    const parsed = extractJson(out.text || '');
    const redactedParsed = parsed ? redactParsed(parsed) : null;
    return {
      round: roundNumber,
      reviewer: reviewer.modelKey,
      target: target.modelKey,
      decision: parsed ? normalizeDecision(parsed.decision) : 'reject',
      risks: redactedParsed?.risks || [],
      evidence_gaps: redactedParsed?.evidence_gaps || [],
      accepted_points: redactedParsed?.accepted_points || [],
      confidence: redactedParsed?.confidence ?? 0,
      rawOutputRef: file.ref,
      rawOutputSha256: file.sha256,
      elapsedMs: Date.now() - startedAt,
      usage: out.usage || {},
      errors: parsed ? [] : ['cross_review_raw_json_parse_failed'],
    };
  } catch (e) {
    const file = writeRaw(roundDir, root, `${baseName}.unavailable.txt`, e?.message || String(e));
    return {
      round: roundNumber,
      reviewer: reviewer.modelKey,
      target: target.modelKey,
      decision: 'unavailable',
      risks: [],
      evidence_gaps: [],
      accepted_points: [],
      confidence: 0,
      rawOutputRef: file.ref,
      rawOutputSha256: file.sha256,
      elapsedMs: Date.now() - startedAt,
      usage: {},
      errors: [e?.message || String(e)],
    };
  }
}

async function runCrossReviewRounds({ available, selected, roles, reviewRounds, roundDir, root, contextPack, fetchImpl, maxTokens }) {
  if (available.length < 2) return [];
  const ordered = orderParticipantsForReview(available, roles);
  const reviews = [];
  for (let roundNumber = 1; roundNumber <= reviewRounds; roundNumber += 1) {
    const targetOffset = ((roundNumber - 1) % (ordered.length - 1)) + 1;
    const previousReviews = reviews.slice();
    const roundReviews = await Promise.all(ordered.map((reviewer, index) => runOneCrossReview({
      roundNumber,
      reviewRounds,
      reviewer,
      target: ordered[(index + targetOffset) % ordered.length],
      previousReviews,
      selected,
      roundDir,
      root,
      contextPack,
      fetchImpl,
      maxTokens,
    })));
    reviews.push(...roundReviews.filter(Boolean));
  }
  return reviews;
}

export async function runLocalModelCouncil(input = {}, opts = {}) {
  const root = opts.root || DEFAULT_LOCAL_COUNCIL_ROOT;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const roundId = input.roundId || makeLocalCouncilRoundId(input.goal || input.text || 'local-council');
  const reviewRounds = cleanLocalCouncilReviewRounds(input.reviewRounds ?? input.rounds ?? input.discussionRounds, 1);
  const roundDir = resolve(root, DEFAULT_LOCAL_COUNCIL_DIR, roundId);
  mkdirSync(roundDir, { recursive: true, mode: 0o700 });

  const discovery = opts.discovery || await discoverLocalModelProviders({ fetchImpl, env: opts.env || process.env });
  const selected = selectLocalCouncilModels(opts.models || discovery.models || [], input.maxParticipants || 4);
  const candidatePool = selectLocalCouncilModels(opts.models || discovery.models || [], 8);
  const roles = assignLocalCouncilRoles(selected, { hasImages: Array.isArray(input.images) && input.images.length > 0, requiresVision: input.requiresVision });
  const blockers = [];
  if (selected.length < 2) blockers.push(`local_council_requires_two_models:${selected.length}`);

  const contextPack = buildContextPrompt(input);
  const participants = [];
  const backupParticipants = [];
  if (blockers.length === 0) {
    const prompt = `${contextPack}\n\n请作为本地 council 成员独立判断。只输出 JSON：{"decision":"approve|approve_with_changes|reject|abstain","answer":"...","risks":["..."],"evidence_gaps":["..."],"actions":["..."],"confidence":0.0}`;
    const callParticipant = async (model, backupFor = '') => {
      const key = modelKey(model);
      const startedAt = Date.now();
      try {
        const out = await callLocalModel(model, [{ role: 'user', content: prompt }], { fetchImpl, maxTokens: councilTokenLimit(input.maxTokens, 700, 512) });
        const raw = out.text || JSON.stringify(out.raw || {});
        const file = writeRaw(roundDir, root, `${model.provider}-${model.id.replace(/[^a-z0-9_.-]+/gi, '-')}.raw.txt`, raw);
        const parsed = extractJson(out.text || '');
        const redactedParsed = parsed ? redactParsed(parsed) : null;
        const decision = parsed ? normalizeDecision(parsed.decision) : 'unavailable';
        const errors = parsed ? [] : ['raw_json_parse_failed'];
        return { modelKey: key, provider: model.provider, model: model.id, roles: Object.entries(roles).filter(([, v]) => v && `${v.provider}:${v.id}` === key).map(([k]) => k), backupFor, status: parsed ? 'available' : 'unavailable', decision, rawOutputRef: file.ref, rawOutputSha256: file.sha256, elapsedMs: Date.now() - startedAt, usage: out.usage || {}, parsed: redactedParsed, errors, health: { ready: errors.length === 0, issue: errors.length ? classifyLocalModelCallIssue(errors[0]) : '' } };
      } catch (e) {
        const message = e?.message || String(e);
        const file = writeRaw(roundDir, root, `${model.provider}-${model.id.replace(/[^a-z0-9_.-]+/gi, '-')}.unavailable.txt`, message);
        return { modelKey: key, provider: model.provider, model: model.id, roles: [], backupFor, status: 'unavailable', decision: 'unavailable', rawOutputRef: file.ref, rawOutputSha256: file.sha256, elapsedMs: Date.now() - startedAt, usage: {}, parsed: null, errors: [message], health: { ready: false, issue: classifyLocalModelCallIssue(message) } };
      }
    };
    participants.push(...await Promise.all(selected.map((model) => callParticipant(model))));
    const attempted = new Set(participants.map((p) => p.modelKey));
    while (participants.filter((p) => p.status !== 'unavailable').length < 2) {
      const next = candidatePool.find((model) => !attempted.has(modelKey(model)));
      if (!next) break;
      const fallbackFor = participants.find((p) => p.status === 'unavailable' && !backupParticipants.includes(p.modelKey))?.modelKey || 'insufficient_available_models';
      attempted.add(modelKey(next));
      backupParticipants.push(fallbackFor);
      participants.push(await callParticipant(next, fallbackFor));
    }
  }

  const quorum = evaluateLocalCouncilQuorum(participants);
  const crossReviews = await runCrossReviewRounds({
    available: participants.filter((p) => p.status !== 'unavailable'),
    selected: candidatePool,
    roles,
    reviewRounds,
    roundDir,
    root,
    contextPack,
    fetchImpl,
    maxTokens: councilTokenLimit(input.reviewMaxTokens || input.maxTokens, 600, 512),
  });
  const summaries = participants.map((p) => ({ modelKey: p.modelKey, decision: p.decision, answer: p.parsed?.answer || '', risks: p.parsed?.risks || p.errors || [], confidence: p.parsed?.confidence ?? 0 }));
  const reviewSummaries = summarizeReviewsForPrompt(crossReviews);
  let finalAnswer = '';
  let synthesis = null;
  const synthesisErrors = [];
  if (quorum.ok) {
    const synthesizerParticipant = participants.find((p) => roles.synthesizer && p.modelKey === `${roles.synthesizer.provider}:${roles.synthesizer.id}` && participantHasUsableAnswer(p))
      || participants.find(participantHasUsableAnswer)
      || participants.find((p) => p.status !== 'unavailable');
    const synthesizerModel = modelForParticipant(candidatePool, synthesizerParticipant);
    if (!synthesizerModel) {
      synthesisErrors.push('synthesis_model_unavailable');
    } else {
      const out = await callLocalModel(synthesizerModel, [{ role: 'user', content: `${contextPack}\n\n成员摘要：${JSON.stringify(summaries)}\n交叉审阅摘要：${JSON.stringify(reviewSummaries)}\n\n请综合输出最终中文答案，必须说明支持/反对/不确定，并优先吸收多轮互评中已经被两个以上模型重复指出的问题。` }], { fetchImpl, maxTokens: councilTokenLimit(input.synthesisMaxTokens || input.maxTokens, 900, 640) }).catch((e) => ({ text: `综合失败：${e.message}`, usage: {}, raw: {} }));
      const file = writeRaw(roundDir, root, `synthesizer-${synthesizerModel.provider}-${synthesizerModel.id.replace(/[^a-z0-9_.-]+/gi, '-')}.raw.txt`, out.text || '');
      finalAnswer = cleanVisibleLocalCouncilAnswer(out.text || '');
      synthesis = { modelKey: `${synthesizerModel.provider}:${synthesizerModel.id}`, rawOutputRef: file.ref, rawOutputSha256: file.sha256, usage: out.usage || {} };
      if (!finalAnswer) synthesisErrors.push('synthesis_visible_answer_missing');
    }
  }
  const allBlockers = [...blockers, ...quorum.errors, ...synthesisErrors];
  const ok = allBlockers.length === 0 && quorum.ok;

  const ledger = {
    schemaVersion: LOCAL_COUNCIL_SCHEMA_VERSION,
    roundId,
    createdAt: new Date().toISOString(),
    goal: redactLocalCouncilText(input.goal || input.text || ''),
    contextPackSha256: sha256(contextPack),
    providers: (discovery.providers || []).map((p) => ({ id: p.id, available: p.available, status: p.status, modelCount: p.models?.length || 0 })),
    roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v ? `${v.provider}:${v.id}` : null])),
    selection: { requestedMaxParticipants: input.maxParticipants || 4, initialParticipants: selected.map(modelKey), backupForUnavailable: participants.filter((p) => p.backupFor).map((p) => ({ modelKey: p.modelKey, backupFor: p.backupFor })) },
    discussion: { reviewMode: 'ring-cross-review', reviewRoundsRequested: reviewRounds, reviewRoundsCompleted: crossReviews.length ? Math.max(...crossReviews.map((r) => r.round || 0)) : 0, crossReviewCount: crossReviews.length },
    participants,
    crossReviews,
    modelHealth: participants.map((p) => ({
      modelKey: p.modelKey,
      provider: p.provider,
      status: p.status,
      decision: p.decision,
      ready: p.health?.ready === true,
      issue: p.health?.issue || '',
    })),
    quorum,
    synthesis,
    synthesisErrors,
    finalAnswer: redactLocalCouncilText(finalAnswer),
    blockers: allBlockers,
    authority: { canAuthorizeSensitiveActions: false, bypassesNoeConsensusGate: false, bypassesPermissionGovernance: false, bypassesActPipeline: false },
  };
  const ledgerPath = join(roundDir, 'ledger.json');
  writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 });
  const warnings = [];
  if (selected.length > 4) warnings.push('local_council_participants_above_default_4');
  if (ledger.selection.backupForUnavailable.length) warnings.push('local_council_backup_participants_used');
  return { ok, finalAnswer: ledger.finalAnswer, participants, quorum, reviewRounds, crossReviewCount: crossReviews.length, ledgerPath: rel(root, ledgerPath), roundDir: rel(root, roundDir), blockers: ledger.blockers, warnings };
}

export function assertLocalCouncilLedgerSafe(ledger) {
  const text = JSON.stringify(ledger || {});
  const unsafe = textContainsSecretLike(text);
  return { ok: !unsafe, errors: unsafe ? ['ledger_contains_secret_like_text'] : [] };
}

export function localCouncilLedgerExists(root, ledgerPath) {
  return existsSync(resolve(root, ledgerPath));
}
