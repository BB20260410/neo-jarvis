export const CLAUDE_OPUS_48_MODEL = 'claude-opus-4-8';

export const CLAUDE_OPUS_48_WORKFLOW_PROMPT =
  'Claude Opus 4.8 runtime defaults for this panel: use xhigh effort. For coding, migration, research, or other agentic multi-step work, prefer Claude Code Dynamic Workflows when parallel subagents or workflow orchestration would materially improve coverage. Keep small direct tasks direct.';

export function isClaudeOpus48Model(model) {
  const value = String(model || '').trim().toLowerCase();
  return value === CLAUDE_OPUS_48_MODEL || value === 'opus';
}

export function applyClaudeOpus48RuntimeDefaults(args, model) {
  if (!Array.isArray(args) || !isClaudeOpus48Model(model)) return args;
  if (!args.includes('--effort')) args.push('--effort', 'xhigh');
  if (!args.includes('--append-system-prompt')) args.push('--append-system-prompt', CLAUDE_OPUS_48_WORKFLOW_PROMPT);
  return args;
}
