const DELEGATE_RE = /让|派给|交给|叫|请|启动|开个|开一个|多\s*AI|协作|团队|squad|arena|codex|claude|minimax/i;
const WORK_RE = /修|改|写|开发|实现|重构|测试|审查|研究|整理|生成|执行|跑|部署|做|处理|解决/i;

function cleanTask(text) {
  return String(text || '')
    .replace(/^(请|帮我|麻烦)?\s*(让|派给|交给|叫)?\s*/i, '')
    .replace(/^(codex|claude|minimax|多\s*AI|AI\s*团队|团队|squad|arena)\s*(帮我|去|来)?\s*/i, '')
    .trim()
    .slice(0, 500);
}

function target(text) {
  const s = String(text || '').toLowerCase();
  if (/codex/.test(s)) return 'codex';
  if (/claude/.test(s)) return 'claude';
  if (/minimax|m3/.test(s)) return 'minimax';
  if (/多\s*ai|团队|squad/.test(s)) return 'squad';
  if (/arena|核对|评审/.test(s)) return 'arena';
  return 'auto';
}

function modeForTarget(t) {
  if (t === 'squad') return 'squad';
  if (t === 'arena') return 'arena';
  if (t === 'claude' || t === 'codex' || t === 'minimax') return 'chat';
  return 'debate';
}

export function detectTaskIntent(text) {
  const raw = String(text || '').trim();
  if (!raw || !DELEGATE_RE.test(raw) || !WORK_RE.test(raw)) return null;
  const targetAdapter = target(raw);
  const instructions = cleanTask(raw);
  if (!instructions) return null;
  return {
    intent: 'delegate_task',
    targetAdapter,
    targetMode: modeForTarget(targetAdapter),
    title: instructions.slice(0, 80),
    instructions,
    approvalRequired: true,
    dryRunOnly: true,
  };
}

export function formatTaskIntentReply(plan) {
  if (!plan) return '';
  const assignee = plan.targetAdapter === 'auto' ? '合适的协作房间' : plan.targetAdapter;
  return `【派活计划】\n目标：${assignee}\n模式：${plan.targetMode}\n任务：${plan.instructions}\n\n这只是计划，未创建房间、未启动 CLI、未消耗配额。确认后应走委派/审批链再启动。`;
}
