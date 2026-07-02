// MiniMaxSuggestionPipeline
//
// API-only suggestion pipeline for M3. Callers provide selected context; M3
// returns structured suggestions. This pipeline never grants local filesystem,
// shell, or patch application capability.

import { randomUUID } from 'node:crypto';
import { MiniMaxChatAdapter } from './MiniMaxChatAdapter.js';
import {
  buildM3SuggestionPrompt,
  classifyM3SuggestionTask,
  validateM3SuggestionPlan,
} from './MiniMaxSuggestionRouter.js';
import {
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../secrets/NoeProviderSecrets.js';

const DEFAULT_MODEL = 'MiniMax-M3';
const DEFAULT_BASE_URL = 'https://api.minimax.chat/v1';

export const M3_STAGE_CHECKPOINTS = Object.freeze({
  CE03: { taskType: 'p0_p1_gap_scan', label: '技术方案后产品缺口扫描' },
  CE05: { taskType: 'evidence_review', label: '代码开发后证据缺口扫描' },
  CE08: { taskType: 'chinese_product_audit', label: '功能验证后中文体验审计' },
  CE10: { taskType: 'p0_p1_gap_scan', label: '验收前反向审计' },
  CE11: { taskType: 'retrospective', label: '复盘错误经验提炼' },
});

export const M3_COLD_REVIEW_CHECKPOINTS = Object.freeze({
  search: {
    taskType: 'chinese_product_audit',
    label: '搜索/TTS 冷审查',
    focus: ['必须先给结论', '不要复读搜索标题列表', 'TTS 不读 URL/HTML/img/src/href', '冲突或弱来源要说不确定性'],
  },
  voice: {
    taskType: 'chinese_product_audit',
    label: '语音交互冷审查',
    focus: ['回复要自然短句', '失败原因要中文可执行', '不泄漏 thinking 或英文元评语', '不要建议模型硬超时'],
  },
  identity: {
    taskType: 'evidence_review',
    label: '身份/主人门禁冷审查',
    focus: ['区分主人/已知人物/未知人物', '证据要包含分数和阈值', '不要把旧视觉上下文当事实', '隐私风险要明说'],
  },
  execution: {
    taskType: 'evidence_review',
    label: '执行/派活安全冷审查',
    focus: ['写文件/移动/命令前必须预览确认', '真实派活要用户审批预算', 'M3 只能建议不能执行', '回滚和失败状态要清楚'],
  },
});

function text(value, max = 200_000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function extractJson(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || {});
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const object = raw.match(/\{[\s\S]*\}/);
  if (object) {
    try { return JSON.parse(object[0]); } catch {}
  }
  return null;
}

export function createM3SuggestionTask(input = {}) {
  const route = classifyM3SuggestionTask(input);
  const prompt = route.ok ? buildM3SuggestionPrompt(input) : '';
  return {
    id: input.id || `m3s_${randomUUID().slice(0, 12)}`,
    createdAt: new Date().toISOString(),
    taskType: route.taskType || input.taskType || 'evidence_review',
    route,
    prompt,
    contextChars: text(input.context || input.content || '').length,
    finalAuthority: 'Claude/GPT-Codex',
  };
}

export function checkpointForStage(stageId) {
  return M3_STAGE_CHECKPOINTS[stageId] || null;
}

export function checkpointForColdReview(area) {
  return M3_COLD_REVIEW_CHECKPOINTS[String(area || '').trim().toLowerCase()] || null;
}

export function buildStageSuggestionInput(stageId, context = '', extra = {}) {
  const checkpoint = checkpointForStage(stageId) || { taskType: 'evidence_review', label: '通用证据复核' };
  return {
    taskType: checkpoint.taskType,
    title: checkpoint.label,
    context,
    ...extra,
  };
}

export function buildM3ColdReviewInput(area, context = '', extra = {}) {
  const key = String(area || '').trim().toLowerCase();
  const checkpoint = checkpointForColdReview(key) || { taskType: 'evidence_review', label: '通用冷审查', focus: ['只审查调用方提供的精选上下文'] };
  const focus = checkpoint.focus.map((item, i) => `${i + 1}. ${item}`).join('\n');
  const title = text(extra.title || checkpoint.label, 120);
  return {
    taskType: checkpoint.taskType,
    title,
    context: [
      `# ${title}`,
      '',
      'M3 角色：只做冷审查建议，不读取本地文件，不运行命令，不写 diff，不做最终裁定。',
      '最终裁定与落地者：Claude/GPT-Codex。',
      '',
      '## 审查重点',
      focus,
      '',
      '## 精选上下文',
      text(context || extra.context || extra.content || '', 120_000),
    ].join('\n'),
    reviewArea: key || 'general',
  };
}

export async function runM3SuggestionTask(input = {}, opts = {}) {
  const task = createM3SuggestionTask(input);
  if (!task.route.ok) {
    return {
      ok: false,
      status: task.route.status,
      task,
      error: task.route.reason,
    };
  }

  let rawReply = '';
  let rawResponse = null;

  if (typeof opts.runner === 'function') {
    rawResponse = await opts.runner({ task, input, prompt: task.prompt });
    rawReply = typeof rawResponse === 'string' ? rawResponse : text(rawResponse?.reply || rawResponse?.content || rawResponse);
  } else {
    const secretResolution = opts.apiKey
      ? { ok: true, value: opts.apiKey, source: 'caller', sourceRef: 'apiKey' }
      : (opts.secretResolver || resolveNoeProviderSecret)('minimax');
    const apiKey = secretResolution?.value || '';
    if (!apiKey) {
      return {
        ok: false,
        status: 'm3_api_not_configured',
        task,
        error: describeNoeProviderSecretFailure('minimax', secretResolution),
      };
    }
    const adapterOptions = {
      apiKey,
      baseUrl: opts.baseUrl || process.env.MINIMAX_BASE_URL || DEFAULT_BASE_URL,
      model: opts.model || process.env.MINIMAX_MODEL || DEFAULT_MODEL,
      maxCompletionTokens: opts.maxCompletionTokens ?? opts.maxTokens ?? 32768,
      reasoningSplit: opts.reasoningSplit ?? true,
      thinking: opts.thinking,
    };
    if (Object.prototype.hasOwnProperty.call(opts, 'timeoutMs')) adapterOptions.timeout = opts.timeoutMs;
    const adapter = opts.adapter || new MiniMaxChatAdapter(adapterOptions);
    rawResponse = await adapter._doChat([{ role: 'user', content: task.prompt }], {
      model: opts.model || process.env.MINIMAX_MODEL || DEFAULT_MODEL,
      abortSignal: opts.abortSignal,
      maxCompletionTokens: opts.maxCompletionTokens ?? opts.maxTokens,
      noAbort: opts.noAbort !== false,
      reasoningSplit: opts.reasoningSplit ?? true,
      thinking: opts.thinking,
    });
    rawReply = text(rawResponse?.reply || rawResponse);
  }

  const plan = extractJson(rawReply);
  if (!plan) {
    return {
      ok: false,
      status: 'invalid_m3_json',
      task,
      raw: rawResponse,
      error: 'M3 suggestion pipeline requires parseable JSON output.',
    };
  }

  const validation = validateM3SuggestionPlan(plan);
  if (!validation.ok) {
    return {
      ok: false,
      status: validation.status,
      task,
      plan,
      raw: rawResponse,
      error: validation.error,
    };
  }

  return {
    ok: true,
    status: 'suggestions_saved',
    task,
    plan,
    raw: rawResponse,
    finalAuthority: validation.finalAuthority,
  };
}
