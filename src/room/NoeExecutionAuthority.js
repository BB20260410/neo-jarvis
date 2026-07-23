export const NOE_DEFAULT_ACTIVE_EXECUTOR = 'codex';

export const NOE_EXECUTOR_PROFILES = Object.freeze({
  codex: Object.freeze({
    id: 'codex',
    label: 'Codex',
    authority: 'active_executor',
    canWriteFiles: true,
    canRunShell: true,
    canApplyPatch: true,
    requiresExplicitSelection: false,
  }),
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude',
    authority: 'active_executor',
    canWriteFiles: true,
    canRunShell: true,
    canApplyPatch: true,
    requiresExplicitSelection: true,
  }),
  gemini: Object.freeze({
    id: 'gemini',
    label: 'Gemini',
    authority: 'advisory',
    canWriteFiles: false,
    canRunShell: false,
    canApplyPatch: false,
    requiresExplicitSelection: false,
  }),
  m3: Object.freeze({
    id: 'm3',
    label: 'MiniMax M3',
    authority: 'suggestion_only',
    canWriteFiles: false,
    canRunShell: false,
    canApplyPatch: false,
    requiresExplicitSelection: false,
  }),
});

function cleanString(value) {
  return String(value || '').trim();
}

export function normalizeExecutionActorId(value) {
  const id = cleanString(value).toLowerCase().replace(/[_\s]+/g, '-');
  if (!id) return '';
  if (id === 'gpt' || id === 'gpt-codex' || id === 'openai-codex') return 'codex';
  if (id === 'claude-code' || id === 'anthropic-claude') return 'claude';
  if (id === 'gemini-cli' || id === 'google-gemini') return 'gemini';
  if (id === 'minimax' || id === 'minimax-m3' || id === 'mini-max-m3') return 'm3';
  return id;
}

function boolFromAvailability(value, fallback = true) {
  if (value === false) return false;
  if (value && typeof value === 'object' && value.available === false) return false;
  if (value && typeof value === 'object' && value.status === 'unavailable') return false;
  return fallback;
}

function selectedByUser(selection = {}) {
  return selection.userSelected === true ||
    selection.selectedBy === 'user' ||
    selection.source === 'user' ||
    cleanString(selection.userApprovalRef).length > 0;
}

function selectedByConsensus(selection = {}) {
  return selection.consensusApproved === true ||
    selection.selectedBy === 'consensus' ||
    selection.source === 'consensus' ||
    cleanString(selection.ledgerRef || selection.consensusLedgerRef).length > 0;
}

export function executorProfileFor(actorId) {
  const id = normalizeExecutionActorId(actorId || NOE_DEFAULT_ACTIVE_EXECUTOR);
  return NOE_EXECUTOR_PROFILES[id] || null;
}

export function resolveNoeActiveExecutor({
  requestedExecutor = NOE_DEFAULT_ACTIVE_EXECUTOR,
  availability = {},
  selection = {},
} = {}) {
  const requested = normalizeExecutionActorId(requestedExecutor || NOE_DEFAULT_ACTIVE_EXECUTOR);
  const profile = executorProfileFor(requested);
  const errors = [];
  const warnings = [];

  if (!profile) {
    return {
      ok: false,
      executor: requested,
      profile: null,
      errors: [`active_executor_unknown:${requested || 'blank'}`],
      warnings,
    };
  }

  if (!profile.canWriteFiles || !profile.canApplyPatch) errors.push(`active_executor_not_writable:${requested}`);
  if (!boolFromAvailability(availability[requested], true)) errors.push(`active_executor_unavailable:${requested}`);
  if (profile.requiresExplicitSelection && !selectedByUser(selection) && !selectedByConsensus(selection)) {
    errors.push(`active_executor_requires_explicit_selection:${requested}`);
  }
  if (Array.isArray(selection.concurrentExecutors) && selection.concurrentExecutors.length > 1) {
    errors.push('active_executor_single_writer_required');
  }
  if (selection.concurrentWriters && Number(selection.concurrentWriters) > 1) {
    errors.push('active_executor_single_writer_required');
  }

  return {
    ok: errors.length === 0,
    executor: requested,
    profile,
    selectionSource: selectedByUser(selection) ? 'user' : selectedByConsensus(selection) ? 'consensus' : 'default',
    errors,
    warnings,
  };
}

export function validateNoeImplementationExecutor(implementation = {}, opts = {}) {
  const requested = implementation.activeExecutor || implementation.executor || implementation.writer || opts.defaultExecutor || NOE_DEFAULT_ACTIVE_EXECUTOR;
  const resolution = resolveNoeActiveExecutor({
    requestedExecutor: requested,
    availability: opts.availability || implementation.executorAvailability || {},
    selection: implementation.executorSelection || implementation.activeExecutorSelection || {},
  });
  const writer = normalizeExecutionActorId(implementation.writer || requested);
  const errors = [...resolution.errors];
  const warnings = [...resolution.warnings];

  if (resolution.executor && writer !== resolution.executor) {
    errors.push(`implementation_writer_must_match_active_executor:${writer || 'blank'}!=${resolution.executor}`);
  }
  if (Array.isArray(implementation.writers) && implementation.writers.length > 1) {
    errors.push('implementation_single_writer_required');
  }
  if (implementation.canWrite === false) errors.push(`implementation_active_executor_cannot_write:${writer || resolution.executor}`);

  return {
    ok: errors.length === 0,
    activeExecutor: resolution.executor,
    writer,
    profile: resolution.profile,
    selectionSource: resolution.selectionSource,
    errors,
    warnings,
  };
}
