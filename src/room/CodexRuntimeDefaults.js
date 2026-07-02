export const CODEX_GPT_55_MODEL = 'gpt-5.5';
export const CODEX_HIGHEST_REASONING_EFFORT = 'xhigh';

export function isCodexGpt55Default(model) {
  const value = String(model || '').trim().toLowerCase();
  // In this panel the empty Codex model means "use the local CLI default",
  // currently surfaced in the UI as gpt-5.5.
  return value === '' || value === CODEX_GPT_55_MODEL;
}

export function applyCodexGpt55RuntimeDefaults(args, model) {
  if (!Array.isArray(args) || !isCodexGpt55Default(model)) return args;
  const hasReasoningOverride = args.some((arg) => String(arg).startsWith('model_reasoning_effort='));
  if (!hasReasoningOverride) {
    args.push('-c', `model_reasoning_effort="${CODEX_HIGHEST_REASONING_EFFORT}"`);
  }
  return args;
}
