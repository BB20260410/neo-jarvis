// MiniMaxSuggestionRouter
//
// M3 is a suggestion-only helper. It can turn caller-provided context into
// optimization ideas, risk notes, product gaps, evidence gaps, and patch
// suggestions. It cannot execute local tools, read files, write diffs, apply
// patches, or sign off final delivery.

const TEXT_LIMIT = 80_000;

export const M3_SUGGESTION_TASKS = Object.freeze({
  log_summary: '日志摘要',
  evidence_review: '证据链复核',
  p0_p1_gap_scan: 'P0/P1 缺口扫描',
  chinese_product_audit: '中文产品体验审计',
  patch_suggestion: 'patch 建议',
  context_compress: '长上下文压缩',
  retrospective: '复盘建议',
});

export const M3_SUGGESTION_ACTIONS = Object.freeze([
  'session_new',
  'messages',
  'diff',
  'suggestions',
  'risk_notes',
  'product_gaps',
  'evidence_gaps',
  'patch_suggestions',
  'do_not_block_reason',
]);

const LOCAL_EXECUTION_PATTERNS = [
  /\b(shell|bash|zsh|cmd|powershell|terminal)\b/i,
  /\b(file\.read|file\.write|file\.delete|file\.move|apply_patch|patch\.apply|tool_calls?)\b/i,
  /\b(rm\s+-rf|unlink|chmod|chown|kill\s+-9|lsof\s+-ti)\b/i,
  /读文件|读取本地|写文件|删除文件|移动文件|执行命令|运行命令|终端|真实执行|外发|上传|发布/,
];

function text(value, max = TEXT_LIMIT) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

export function classifyM3SuggestionTask(input = {}) {
  const taskType = text(input.taskType || input.type || 'evidence_review', 80);
  const taskLabel = M3_SUGGESTION_TASKS[taskType] || M3_SUGGESTION_TASKS.evidence_review;
  const requested = [
    input.taskType,
    input.title,
    input.request,
    ...list(input.requestedActions),
  ].map((item) => text(item, 2000)).join('\n');
  const localExecutionHits = LOCAL_EXECUTION_PATTERNS
    .filter((pattern) => pattern.test(requested))
    .map((pattern) => pattern.source);

  if (localExecutionHits.length > 0 || input.requiresLocalTools || input.requiresShell || input.requiresFileSystem) {
    return {
      ok: false,
      route: 'claude_codex_main_chain',
      status: 'blocked_local_execution',
      taskType,
      taskLabel,
      m3Role: 'not_assigned',
      reason: 'M3 suggestion-only route refuses local tools, filesystem access, shell, mutation, or external publishing.',
      localExecutionHits,
      finalAuthority: 'Claude/GPT-Codex',
    };
  }

  return {
    ok: true,
    route: 'minimax_m3_suggestion_only',
    status: 'routed',
    taskType,
    taskLabel,
    m3Role: 'suggestion_only_helper',
    permissionLevel: 'API_ONLY_TEXT_CONTEXT',
    localTools: false,
    finalAuthority: 'Claude/GPT-Codex',
    allowedActions: M3_SUGGESTION_ACTIONS,
  };
}

export function buildM3SuggestionPrompt(input = {}) {
  const route = classifyM3SuggestionTask(input);
  const schema = {
    actions: ['suggestions'],
    diffs: [],
    task_type: route.taskType || input.taskType || 'evidence_review',
    suggestions: [],
    risk_notes: [],
    product_gaps: [],
    evidence_gaps: [],
    patch_suggestions: [],
    do_not_block_reason: '',
    final_authority: 'Claude/GPT-Codex',
  };

  return [
    '你是 MiniMax M3 建议员，不是执行员。',
    '你只能基于调用方提供的文本提出优化意见和建议。',
    '禁止读取本地文件、运行 shell、写文件、删除、移动、apply_patch、外发数据或请求 secret。',
    '你不能做最终验收，最终裁定权属于 Claude/GPT-Codex。',
    '如果发现需要真实修改，只能写入 patch_suggestions，diffs 必须保持空数组。',
    `任务类型: ${schema.task_type}`,
    `输出 JSON schema: ${JSON.stringify(schema)}`,
    '',
    '[provided_context]',
    text(input.context || input.content || '', TEXT_LIMIT),
  ].join('\n');
}

export function validateM3SuggestionPlan(planInput = {}) {
  const plan = planInput && typeof planInput === 'object' ? planInput : {};
  const actions = list(plan.actions).map((item) => text(item, 80)).filter(Boolean);
  const unsafeActions = actions.filter((action) => !M3_SUGGESTION_ACTIONS.includes(action));
  if (unsafeActions.length > 0) {
    return {
      ok: false,
      status: 'blocked_safety',
      error: `M3 suggestion-only output contains unsafe actions: ${unsafeActions.join(', ')}`,
    };
  }
  if (list(plan.diffs).length > 0) {
    return {
      ok: false,
      status: 'blocked_safety',
      error: 'M3 suggestion-only output must keep diffs=[]; real edits require Claude/GPT-Codex.',
    };
  }
  if (list(plan.tool_calls).length || list(plan.tools).length || list(plan.commands).length || list(plan.files_read).length) {
    return {
      ok: false,
      status: 'blocked_safety',
      error: 'M3 suggestion-only output must not include tool_calls/tools/commands/files_read.',
    };
  }
  return {
    ok: true,
    status: 'suggestions_saved',
    actions: actions.length ? actions : ['suggestions'],
    diffs: [],
    finalAuthority: plan.final_authority || 'Claude/GPT-Codex',
  };
}
