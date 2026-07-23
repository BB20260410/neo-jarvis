import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { atomicWriteFile } from '../state/atomicJsonFile.js';
import { cleanVisibleModelText, redactSensitiveText } from './NoeContextScrubber.js';
import { parseNoeLlmJsonValue } from './NoeLlmJsonExtractor.js';

export const NOE_BACKGROUND_REVIEW_SCHEMA_VERSION = 1;
export const NOE_BACKGROUND_REVIEW_OUTPUT_DIR = 'output/noe-background-review';
export const NOE_BACKGROUND_REVIEW_ALLOWED_TOOLS = new Set([
  'memory_candidate',
  'skill_draft',
  'review_report',
]);

const REVIEW_PROMPT = `你是 Noe 的后台复盘审阅者。你只能提出 proposal，不能直接写文件、删除文件、上传、发布、重启、杀进程或读取密钥。
请审查最近一轮对话，判断是否需要：
1. 记忆写回 proposal；
2. 技能更新 proposal；
3. Action Catalog proposal；
4. 不需要持久化。
只输出 JSON：{"decision":"propose|skip","memoryProposals":[...],"skillProposals":[...],"actionProposals":[...],"risks":[...],"confidence":0.0}`;

function clean(value, max = 4000) {
  return redactSensitiveText(String(value || '').trim()).slice(0, max);
}

function safeJson(text = '') {
  const source = cleanVisibleModelText(text).text;
  return parseNoeLlmJsonValue(source, null);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeClone(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return clean(value, 4000);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => safeClone(item, depth + 1));
  if (typeof value !== 'object') return clean(value, 1000);
  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    const k = clean(key, 120);
    out[k] = /secret|token|key|password|authorization|cookie/i.test(k) ? '[redacted]' : safeClone(item, depth + 1);
  }
  return out;
}

function toolNameFromCall(call = {}) {
  return clean(call.name || call.toolName || call.function?.name || call.functionName || '', 160);
}

function toolCallsFromResponse(response = {}) {
  return [
    ...asArray(response.toolCalls),
    ...asArray(response.tool_calls),
    ...asArray(response.tools),
  ].map((call) => ({ name: toolNameFromCall(call), raw: safeClone(call) })).filter((call) => call.name);
}

export function validateBackgroundReviewToolCalls(response = {}, {
  allowedTools = NOE_BACKGROUND_REVIEW_ALLOWED_TOOLS,
} = {}) {
  const deniedTools = toolCallsFromResponse(response)
    .filter((call) => !allowedTools.has(call.name))
    .map((call) => call.name);
  return {
    ok: deniedTools.length === 0,
    deniedTools: [...new Set(deniedTools)],
    observedTools: toolCallsFromResponse(response).map((call) => call.name),
    allowedTools: [...allowedTools],
  };
}

function proposalTool(kind) {
  if (kind === 'memory') return 'memory_candidate';
  if (kind === 'skill') return 'skill_draft';
  if (kind === 'clarification') return '';
  return 'review_report';
}

function outputRoot(root, outputDir = NOE_BACKGROUND_REVIEW_OUTPUT_DIR) {
  const rootAbs = resolve(root || process.cwd());
  const allowed = resolve(rootAbs, NOE_BACKGROUND_REVIEW_OUTPUT_DIR);
  const out = resolve(rootAbs, outputDir || NOE_BACKGROUND_REVIEW_OUTPUT_DIR);
  if (out !== allowed && !out.startsWith(`${allowed}/`)) {
    throw new Error('background_review_output_dir_must_be_under_output_noe_background_review');
  }
  return { rootAbs, out };
}

function refFor(rootAbs, file) {
  return relative(rootAbs, file).replace(/\\/g, '/');
}

export function shouldRunBackgroundReview(messages = [], {
  minUserTurns = 1,
  minAssistantTurns = 1,
  minChars = 120,
} = {}) {
  const userTurns = messages.filter((m) => m?.role === 'user' && clean(m.content)).length;
  const assistantTurns = messages.filter((m) => m?.role === 'assistant' && clean(m.content)).length;
  const chars = messages.reduce((sum, m) => sum + clean(m?.content, 20_000).length, 0);
  return userTurns >= minUserTurns && assistantTurns >= minAssistantTurns && chars >= minChars;
}

export function buildBackgroundReviewMessages(messages = [], context = {}, { clarifyEnabled: _clarifyEnabled = false } = {}) {
  const recent = messages.slice(-12).map((m) => ({
    role: m.role,
    content: redactSensitiveText(clean(m.content, 1200)),
  })).filter((m) => m.role && m.content);
  return [
    { role: 'system', content: REVIEW_PROMPT },
    {
      role: 'user',
      content: JSON.stringify({
        projectId: clean(context.projectId || 'noe', 120),
        loadedSkills: Array.isArray(context.loadedSkills) ? context.loadedSkills.slice(0, 20) : [],
        policy: {
          proposalOnly: true,
          allowedTools: [...NOE_BACKGROUND_REVIEW_ALLOWED_TOOLS],
          allowedActions: ['memory_candidate', 'skill_draft', 'review_report'],
          requiresConsensusBeforeWrite: true,
          outputBoundary: NOE_BACKGROUND_REVIEW_OUTPUT_DIR,
        },
        recent,
      }),
    },
  ];
}

export async function runBackgroundReview({
  messages = [],
  context = {},
  chat,
  now = () => new Date().toISOString(),
  clarifyEnabled = false,
} = {}) {
  if (!shouldRunBackgroundReview(messages, context)) {
    return { ok: true, skipped: true, reason: 'background_review_signal_too_low', proposals: [] };
  }
  if (typeof chat !== 'function') throw new Error('runBackgroundReview: chat function required');
  const response = await chat(buildBackgroundReviewMessages(messages, context, { clarifyEnabled }), {
    toolPolicy: 'proposal-only',
    allowedTools: [...NOE_BACKGROUND_REVIEW_ALLOWED_TOOLS],
  });
  const toolValidation = validateBackgroundReviewToolCalls(response);
  if (!toolValidation.ok) {
    return {
      ok: false,
      skipped: false,
      reason: 'background_review_denied_non_whitelisted_tool',
      deniedTools: toolValidation.deniedTools,
      observedTools: toolValidation.observedTools,
      proposals: [],
    };
  }
  const raw = clean(response?.reply || response?.text || response, 80_000);
  const parsed = safeJson(raw);
  if (!parsed) {
    return {
      ok: false,
      skipped: false,
      reason: 'background_review_json_parse_failed',
      rawPreview: redactSensitiveText(raw).slice(0, 1000),
      proposals: [],
    };
  }
  const clarifyExtra = (clarifyEnabled && Array.isArray(parsed.clarifications) ? parsed.clarifications : []).slice(0, 5).map((c) => ({ kind: 'clarification', item: { title: 'Clarify', question: clean(c && (c.question || c.text), 600), category: 'owner_intent_ambiguous', proposalOnly: true } })).filter((x) => x.item.question);
  const proposals = [
    ...clarifyExtra,
    ...(Array.isArray(parsed.memoryProposals) ? parsed.memoryProposals.map((item) => ({ kind: 'memory', item })) : []),
    ...(Array.isArray(parsed.skillProposals) ? parsed.skillProposals.map((item) => ({ kind: 'skill', item })) : []),
    ...(Array.isArray(parsed.actionProposals) ? parsed.actionProposals.map((item) => ({ kind: 'action', item })) : []),
  ].slice(0, 20).map((proposal) => ({
    id: randomUUID(),
    kind: proposal.kind,
    tool: proposalTool(proposal.kind),
    status: 'proposed',
    proposalOnly: true,
    requiresConsensusBeforeWrite: true,
    createdAt: now(),
    item: safeClone(proposal.item || {}),
  }));
  return {
    ok: true,
    skipped: parsed.decision === 'skip' || proposals.length === 0,
    decision: parsed.decision === 'skip' ? 'skip' : 'propose',
    proposals,
    risks: Array.isArray(parsed.risks) ? parsed.risks.map((risk) => clean(risk, 500)) : [],
    confidence: Number(parsed.confidence) || 0,
  };
}

export class NoeBackgroundReviewRunner {
  constructor({
    root = process.cwd(),
    outputDir = NOE_BACKGROUND_REVIEW_OUTPUT_DIR,
    chat,
    now = () => new Date().toISOString(),
    clarifyEnabled = false,
  } = {}) {
    const resolved = outputRoot(root, outputDir);
    this.root = resolved.rootAbs;
    this.outputDir = resolved.out;
    this.chat = chat;
    this.now = now;
    this.clarifyEnabled = clarifyEnabled === true;
  }

  writeReport(report = {}) {
    mkdirSync(this.outputDir, { recursive: true, mode: 0o700 });
    const stamp = clean(this.now().replace(/[:.]/g, '-'), 80) || String(Date.now());
    const id = clean(report.reviewId || randomUUID(), 120).replace(/[^a-z0-9_.-]+/gi, '-');
    const file = resolve(this.outputDir, `${stamp}-${id}.json`);
    if (!file.startsWith(`${this.outputDir}/`)) throw new Error('background_review_report_path_escape');
    atomicWriteFile(file, `${JSON.stringify(safeClone(report), null, 2)}\n`);
    return { file, ref: refFor(this.root, file) };
  }

  async run({
    messages = [],
    context = {},
    dryRun = true,
    persist = true,
  } = {}) {
    const reviewId = randomUUID();
    const startedAt = this.now();
    const result = await runBackgroundReview({
      messages,
      context,
      chat: this.chat,
      now: this.now,
      clarifyEnabled: this.clarifyEnabled,
    });
    const report = {
      schemaVersion: NOE_BACKGROUND_REVIEW_SCHEMA_VERSION,
      kind: 'noe_background_review_report',
      reviewId,
      startedAt,
      finishedAt: this.now(),
      dryRun: dryRun !== false,
      proposalOnly: true,
      applySupported: false,
      outputBoundary: NOE_BACKGROUND_REVIEW_OUTPUT_DIR,
      allowedTools: [...NOE_BACKGROUND_REVIEW_ALLOWED_TOOLS],
      context: safeClone({
        projectId: context.projectId || 'noe',
        loadedSkills: asArray(context.loadedSkills).slice(0, 20),
        evidenceRefs: asArray(context.evidenceRefs).slice(0, 50),
      }),
      result,
      proposals: asArray(result.proposals),
      deniedTools: asArray(result.deniedTools),
      directWrites: [],
      nextAction: result.ok === false
        ? 'inspect denied tool or JSON parse failure; do not persist memory or skills'
        : 'review candidates; apply requires a separate gated path',
    };
    const artifact = persist ? this.writeReport(report) : null;
    return {
      ...result,
      reviewId,
      dryRun: dryRun !== false,
      reportRef: artifact?.ref || null,
      outputBoundary: NOE_BACKGROUND_REVIEW_OUTPUT_DIR,
    };
  }
}
