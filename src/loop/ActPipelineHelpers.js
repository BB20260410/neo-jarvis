import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const DESTRUCTIVE_ACTIONS = new Set([
  'file.delete',
  'file.move.bulk',
  'file.batch_move',
  'network.upload',
  'network.external_post',
  'shell.exec',
  'tool.execute',
]);

export function nowMs() {
  return Date.now();
}

export function str(value, max = 1000) {
  if (value === undefined || value === null || value === '') return '';
  return String(value).slice(0, max).trim();
}

export function safeObject(value) {
  if (!value || typeof value !== 'object') return {};
  try { return JSON.parse(JSON.stringify(value)); } catch { return {}; }
}

export function normalizeRisk(value, action = '') {
  // self-evolution(Noe 自改自身代码)恒为 critical,无视传入值——禁止被显式 low 降级、
  // 禁止走 autoExecuteLowRisk 自动执行(auto 仅对 low),必须显式 realExecute:true + 过 self-evolution gate。
  if (/self_evolution/i.test(action)) return 'critical';
  // ③ 能力自举（自动下载安装第三方软件 = 供应链高危）恒为 critical，禁止被 autoExecuteLowRisk 无门自动执行。
  if (/noe\.capability\./i.test(action)) return 'critical';
  const risk = str(value || '', 40).toLowerCase();
  if (['low', 'medium', 'high', 'critical'].includes(risk)) return risk;
  if (DESTRUCTIVE_ACTIONS.has(action)) return 'critical';
  if (/delete|remove|upload|external|shell|exec|write|move/i.test(action)) return 'high';
  return 'low';
}

export function riskNeedsApproval(risk) {
  return risk === 'high' || risk === 'critical';
}

export function titleFromContext({ focusItems = [] } = {}) {
  const first = Array.isArray(focusItems) ? focusItems[0] : null;
  return str(first?.title || first?.summary || 'Noe focus review', 240) || 'Noe focus review';
}

function safeText(value, max = 500) {
  const text = redactSensitiveText(str(value, max)).replace(/\s+/g, ' ').trim();
  return text && text !== '[REDACTED]' ? text : '';
}

function firstSafe(...values) {
  for (const value of values) {
    const text = safeText(value);
    if (text) return text;
  }
  return '';
}

export function semanticContextFromFocusItems({ focusItems = [] } = {}) {
  const items = (Array.isArray(focusItems) ? focusItems : [])
    .filter((item) => item && typeof item === 'object')
    .slice(0, 3);
  if (!items.length) return {};

  const first = items[0];
  const out = {};
  const summaries = items
    .map((item) => firstSafe(item.summary, item.text, item.title, item.queryText))
    .filter(Boolean)
    .slice(0, 3);
  if (summaries.length) out.summary = summaries.join(' | ').slice(0, 900);

  const goalTitle = firstSafe(first.goalTitle, first.goal?.title, first.goal);
  if (goalTitle) out.goalTitle = goalTitle;

  const expectation = firstSafe(
    first.expectedClaim,
    first.expectation,
    first.claim,
    first.source === 'expectation_due' ? first.queryText : '',
    first.source === 'expectation_due' ? first.text : '',
  );
  if (expectation) out.expectedClaim = expectation;

  const checkpoint = firstSafe(first.checkpoint, first.stepText, first.step, first.queryText);
  if (checkpoint) {
    out.checkpoint = checkpoint;
    out.stepText = checkpoint;
  }

  const actionSpec = safeObject(first.actionSpec);
  const task = firstSafe(actionSpec.title, actionSpec.task, first.task, first.intent);
  if (task) out.task = task;
  return out;
}
