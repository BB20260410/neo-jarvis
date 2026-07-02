import { buildFreedomRequestBody } from './noe-freedom-request.js';
import { clean, escapeHtml, redactFreedomUiValue } from './noe-freedom-ui-utils.js';

export function extractFreedomNextActions(result = {}) {
  const runtime = result?.runtime && typeof result.runtime === 'object' ? result.runtime : {};
  const source = Array.isArray(runtime.nextFreedomActions)
    ? runtime.nextFreedomActions
    : Array.isArray(result.nextFreedomActions)
      ? result.nextFreedomActions
      : [];
  return source.slice(0, 12).map((item, index) => ({
    index,
    stepId: clean(item?.stepId || `step-${index + 1}`, 120),
    title: clean(item?.title || item?.label || '', 160),
    actionId: clean(item?.actionId || item?.toolId || item?.operation || '', 180),
    mode: clean(item?.mode || 'developer_unrestricted', 80),
    args: redactFreedomUiValue(item?.args || {}),
  })).filter((item) => item.actionId).map((item, index) => ({ ...item, index }));
}

export function renderFreedomNextActions(result = {}) {
  const actions = extractFreedomNextActions(result);
  if (!actions.length) return '<div class="noe-brain-empty">暂无继续动作。</div>';
  return `
    <div class="noe-brain-row">
      <strong>继续执行链</strong>
      <span>${actions.length} 个动作 · 可载入检查，也可用当前 Dev Session 执行全部</span>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" type="button" data-noe-next-action-chain="1">载入全部</button>
      <button class="cxbtn cxbtn-primary cxbtn-sm" type="button" data-noe-next-action-chain-run="1">执行全部</button>
    </div>
    ${actions.map((item) => `
    <div class="noe-brain-row">
      <strong>${escapeHtml(item.title || item.stepId)}</strong>
      <span>${escapeHtml(item.actionId)} · ${escapeHtml(item.mode)}</span>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" type="button" data-noe-next-action-index="${item.index}">载入</button>
    </div>
  `).join('')}
  `;
}

export function renderOwnerAuthorizedAccountTargets(result = {}) {
  const runtime = result?.runtime && typeof result.runtime === 'object' ? result.runtime : result;
  const targets = Array.isArray(runtime?.ownerAuthorizedAccountTargets)
    ? runtime.ownerAuthorizedAccountTargets.slice(0, 12).map(redactFreedomUiValue)
    : [];
  if (!targets.length) return '<div class="noe-brain-empty">暂无已授权账号目标。</div>';
  return `
    <div class="noe-brain-row">
      <strong>已授权账号目标</strong>
      <span>${targets.length} 个可由开发者模式控制的浏览器登录态目标 · 不读取 cookie/密码/页面正文</span>
    </div>
    ${targets.map((target) => `
    <div class="noe-brain-row">
      <strong>${escapeHtml(target.host || target.targetId || 'account')}</strong>
      <span>${escapeHtml(target.app || '-')}${target.socialPlatform ? ` · ${escapeHtml(target.socialPlatform)}` : ''} · ${escapeHtml(target.origin || '')} · actions:${Array.isArray(target.nextFreedomActions) ? target.nextFreedomActions.length : 0}</span>
    </div>
  `).join('')}
  `;
}

export function applyFreedomNextAction(nextAction = {}, root = document) {
  if (!nextAction?.actionId) return { ok: false, reason: 'next_action_missing_action' };
  const tool = root.querySelector?.('#noeFreedomTool');
  const mode = root.querySelector?.('#noeFreedomMode');
  const args = root.querySelector?.('#noeFreedomArgs');
  if (tool) tool.value = nextAction.actionId;
  if (mode) mode.value = nextAction.mode || 'developer_unrestricted';
  if (args) args.value = JSON.stringify(nextAction.args || {}, null, 2);
  return { ok: true, actionId: nextAction.actionId };
}

export function buildFreedomChainArgsFromNextActions(nextActions = [], { stopOnError = true } = {}) {
  const steps = (Array.isArray(nextActions) ? nextActions : []).map((item, index) => ({
    stepId: clean(item?.stepId || `step-${index + 1}`, 120),
    actionId: clean(item?.actionId || item?.toolId || item?.operation || '', 180),
    mode: clean(item?.mode || 'developer_unrestricted', 80),
    args: redactFreedomUiValue(item?.args || {}),
  })).filter((item) => item.actionId && item.actionId !== 'noe.freedom.chain.execute');
  return {
    ok: steps.length > 0,
    args: {
      stopOnError: stopOnError !== false,
      persistChildLedgers: true,
      steps,
    },
  };
}

export function buildFreedomNextActionChainRequest(nextActions = [], {
  sessionId = '',
  persistLedger = true,
  runId = '',
} = {}) {
  const activeSessionId = clean(sessionId, 180);
  if (!activeSessionId) return { ok: false, error: 'developer_session_required_for_next_action_chain_execute' };
  const built = buildFreedomChainArgsFromNextActions(nextActions);
  if (!built.ok) return { ok: false, error: built.reason || 'next_action_chain_empty' };
  return buildFreedomRequestBody({
    action: 'noe.freedom.chain.execute',
    argsJson: JSON.stringify(built.args, null, 2),
    mode: 'developer_unrestricted',
    sessionId: activeSessionId,
    realExecute: true,
    persistLedger,
    runId: runId || `freedom-ui-chain-${Date.now()}`,
  });
}

export function applyFreedomNextActionChain(nextActions = [], root = document) {
  const built = buildFreedomChainArgsFromNextActions(nextActions);
  if (!built.ok) return { ok: false, reason: 'next_action_chain_empty' };
  const tool = root.querySelector?.('#noeFreedomTool');
  const mode = root.querySelector?.('#noeFreedomMode');
  const args = root.querySelector?.('#noeFreedomArgs');
  if (tool) tool.value = 'noe.freedom.chain.execute';
  if (mode) mode.value = 'developer_unrestricted';
  if (args) args.value = JSON.stringify(built.args, null, 2);
  return { ok: true, actionId: 'noe.freedom.chain.execute', stepCount: built.args.steps.length };
}
