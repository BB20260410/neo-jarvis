import { clean, escapeHtml, redactFreedomUiValue } from './noe-freedom-ui-utils.js';

const STAGE_LABELS = {
  account_inventory: '账号盘点',
  open_creator_console: '打开创作台',
  local_draft: '本地草稿',
  preflight: '发布前检查',
  form_fill_plan: '填表计划',
  form_fill_execute: '填表执行',
  media_upload_plan: '上传计划',
  media_upload_execute: '媒体上传',
  final_publish_execute: '最终发布',
  rollback_evidence_gate: '回滚证据门控',
  post_publish_state_probe: '发布后证据',
  dom_recipe_probe: 'DOM 探测',
  dom_recipe_execute: 'DOM 执行',
};

function findStageSummary(result = {}) {
  const runtime = result?.runtime && typeof result.runtime === 'object' ? result.runtime : {};
  return runtime.socialPublishStageSummary
    || result.socialPublishStageSummary
    || runtime.stageSummary
    || result.stageSummary
    || null;
}

function stageLabel(stage = '') {
  return STAGE_LABELS[stage] || stage || 'unknown';
}

export function extractFreedomStageSummary(result = {}) {
  const summary = findStageSummary(result);
  if (!summary || typeof summary !== 'object') return null;
  const safe = redactFreedomUiValue(summary);
  const stages = Array.isArray(safe.stages) ? safe.stages.slice(0, 16).map((stage, index) => ({
    index,
    stage: clean(stage?.stage || '', 120),
    label: stageLabel(stage?.stage),
    stepId: clean(stage?.stepId || '', 160),
    ok: stage?.ok === true,
    blockers: Array.isArray(stage?.blockers) ? stage.blockers.map((item) => clean(item, 240)).filter(Boolean) : [],
    warnings: Array.isArray(stage?.warnings) ? stage.warnings.map((item) => clean(item, 240)).filter(Boolean) : [],
    ledgerRef: clean(stage?.runLedger?.ref || stage?.childLedgerRef || '', 300),
    childLedgerRef: clean(stage?.childLedgerRef || '', 300),
    publishPerformed: stage?.runtime?.publishPerformed === true,
    externalSideEffectPerformed: stage?.runtime?.externalSideEffectPerformed === true,
  })) : [];
  const rollback = safe.rollbackEvidence && typeof safe.rollbackEvidence === 'object' ? safe.rollbackEvidence : null;
  // Accept both the per-call domProbeSummary and the chain-level domRecipeProbe field name.
  const domProbe = (safe.domProbeSummary && typeof safe.domProbeSummary === 'object' ? safe.domProbeSummary : null)
    || (safe.domRecipeProbe && typeof safe.domRecipeProbe === 'object' ? safe.domRecipeProbe : null);
  return {
    ok: safe.ok === true,
    kind: clean(safe.kind || 'social_publish_stage_summary', 120),
    stageCount: Number(safe.stageCount || stages.length || 0),
    completedStepIds: Array.isArray(safe.completedStepIds) ? safe.completedStepIds.map((item) => clean(item, 160)) : [],
    failedStepIds: Array.isArray(safe.failedStepIds) ? safe.failedStepIds.map((item) => clean(item, 160)) : [],
    blockedAt: clean(safe.blockedAtStepId || '', 160),
    publishStepPresent: safe.publishStepPresent === true,
    publishAttempted: safe.publishAttempted === true,
    publishPerformed: safe.publishPerformed === true,
    publishConfirmed: safe.publishConfirmed === true,
    externalSideEffectPlanned: safe.externalSideEffectPlanned === true,
    externalSideEffectPerformed: safe.externalSideEffectPerformed === true,
    domProbe,
    rollback,
    stages,
  };
}

function renderDomProbe(domProbe) {
  if (!domProbe) return '';
  const missing = Array.isArray(domProbe.missingRoles) ? domProbe.missingRoles.join(', ') : '';
  const found = Array.isArray(domProbe.foundRoles) ? domProbe.foundRoles.join(', ') : '';
  return `
    <div class="noe-brain-row">
      <strong>DOM readiness</strong>
      <span>${domProbe.ok ? 'ready' : 'not ready'} · found: ${escapeHtml(found || '-')} · missing: ${escapeHtml(missing || '-')}</span>
    </div>
  `;
}

function renderRollback(rollback) {
  if (!rollback) return '';
  const missing = Array.isArray(rollback.missingEvidence) ? rollback.missingEvidence.join(', ') : '';
  const platform = rollback.platform ? ` · ${escapeHtml(rollback.platform)}` : '';
  const target = rollback.postUrlRef ? ` · target:${escapeHtml(rollback.postUrlRef)}` : '';
  return `
    <div class="noe-brain-row">
      <strong>Rollback evidence</strong>
      <span>${escapeHtml(rollback.evidenceStatus || 'unknown')}${platform} · verified:${rollback.verifiedByNoe === true ? 'yes' : 'no'}${missing ? ` · missing:${escapeHtml(missing)}` : ''}${target}</span>
    </div>
  `;
}

function renderStageRow(stage, blockedAt) {
  const icon = stage.ok ? '✓' : '✗';
  const isHere = Boolean(blockedAt) && stage.stepId === blockedAt;
  const marks = [
    stage.publishPerformed ? '已发布' : '',
    stage.externalSideEffectPerformed ? '已产生外部副作用' : '',
    stage.warnings.length ? `⚠${stage.warnings.length}` : '',
  ].filter(Boolean).join(' · ');
  const rowClass = `noe-brain-row noe-brain-row--stage${stage.ok ? '' : ' noe-brain-row--blocked'}${isHere ? ' noe-brain-row--blocked-here' : ''}`;
  return `
    <div class="${rowClass}">
      <strong>${icon} ${escapeHtml(stage.label)}</strong>
      <span>${stage.ok ? 'ok' : 'blocked'}${isHere ? ' ← 卡在这里' : ''} · ${escapeHtml(stage.stepId || stage.stage)}${marks ? ` · ${escapeHtml(marks)}` : ''}${stage.ledgerRef ? ` · ledger:${escapeHtml(stage.ledgerRef)}` : ''}</span>
    </div>
  `;
}

export function renderFreedomStageSummary(result = {}) {
  const summary = extractFreedomStageSummary(result);
  if (!summary) return '<div class="noe-brain-empty">暂无社交发布阶段摘要。</div>';
  const blockers = summary.stages.flatMap((stage) => stage.blockers.map((blocker) => `${stage.stepId || stage.stage}: ${blocker}`));
  const blockedAtLabel = summary.blockedAt ? ` · 卡点:${escapeHtml(summary.blockedAt)}` : '';
  return `
    <div class="noe-brain-row noe-brain-row--summary${summary.ok ? '' : ' noe-brain-row--blocked'}">
      <strong>${summary.ok ? '✓' : '✗'} 社交发布链</strong>
      <span>${summary.ok ? 'passed' : 'blocked'} · stages:${summary.stageCount} · publish:${summary.publishConfirmed ? 'confirmed' : summary.publishStepPresent ? 'planned' : 'none'} · side effect:${summary.externalSideEffectPerformed ? 'performed' : summary.externalSideEffectPlanned ? 'planned' : 'none'}${blockedAtLabel}</span>
    </div>
    ${summary.stages.map((stage) => renderStageRow(stage, summary.blockedAt)).join('')}
    ${blockers.length ? `<div class="noe-brain-row"><strong>Blockers</strong><span>${escapeHtml(blockers.slice(0, 12).join(' / '))}</span></div>` : ''}
    ${renderDomProbe(summary.domProbe)}
    ${renderRollback(summary.rollback)}
  `;
}
