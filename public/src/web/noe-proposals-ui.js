import { noeUiSignalToken, postNoeUiSignal } from './noe-ui-signals.js?v=ui-signals-20260608a';
import { escapeHtml } from './noe-freedom-ui-utils.js';

const SECRET_TEXT_RE = /\b(sk-[A-Za-z0-9_-]{16,}|tp-[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/g;
const SECRET_QUERY_RE = /([?&#][^=&#]*(?:secret|token|key|password|authorization|credential|cookie)[^=&#]*=)([^&#\s]+)/gi;

let latestProposals = [];

function headers() {
  return { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': noeUiSignalToken() || '' };
}

function hasOwnerToken() {
  try {
    const win = globalThis.window;
    if (typeof win?.PanelCore?.hasOwnerToken === 'function') return win.PanelCore.hasOwnerToken() === true;
    if (typeof win?.PanelOwnerAuth?.hasToken === 'function') return win.PanelOwnerAuth.hasToken() === true;
    return (noeUiSignalToken() || '').length >= 32;
  } catch {
    return false;
  }
}

function clean(value, max = 1000) {
  return String(value ?? '')
    .replace(SECRET_TEXT_RE, '[redacted]')
    .replace(SECRET_QUERY_RE, '$1[redacted]')
    .trim()
    .slice(0, max);
}

async function getJson(path) {
  const res = await fetch(path, { headers: headers() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.error) body.error = `HTTP ${res.status}`;
  return body;
}

async function postJson(path, payload = {}) {
  const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(payload) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.error) body.error = `HTTP ${res.status}`;
  return body;
}

function postSignal(action, payload = {}) {
  postNoeUiSignal('card.action', {
    component: 'NoeProposalInbox',
    cardId: 'noeProposalInboxPanel',
    target: 'noe-proposal-inbox',
    action,
    payload,
  });
}

function setStatus(text, root = document) {
  const el = root.querySelector?.('#noeProposalInboxStatus');
  if (el) el.textContent = text;
}

function sourceLabel(source = '') {
  if (source === 'background_review') return 'Background';
  if (source === 'boot_self_check') return '开机自检';
  if (source === 'skill_curator') return 'Skill';
  if (source === 'self_model') return 'Self-model';
  return source || 'unknown';
}

function detailLine(label, value) {
  return `
    <div class="noe-brain-row">
      <strong>${escapeHtml(label)}</strong>
      <span>${escapeHtml(clean(value, 600))}</span>
    </div>
  `;
}

function isSelfModelDiff(proposal = {}) {
  return proposal.source === 'self_model' && proposal.type === 'self_model_diff';
}

function selfModelApplyControls(proposal = {}) {
  if (!isSelfModelDiff(proposal)) return '';
  const id = escapeHtml(clean(proposal.id, 160));
  const approved = proposal.status === 'approved_for_gated_apply';
  return `
    <div class="noe-brain-row">
      <strong>self-model apply</strong>
      <span>owner checkbox required · dry-run first · real apply requires approved proposal</span>
    </div>
    <div class="noe-brain-controls" style="align-items:center;gap:8px;flex-wrap:wrap;">
      <label class="noe-brain-chip" style="display:inline-flex;align-items:center;gap:6px;">
        <input type="checkbox" data-noe-self-model-confirm-id="${id}">
        owner confirm
      </label>
      <button class="cxbtn cxbtn-secondary cxbtn-xs" type="button" data-noe-self-model-apply-id="${id}" data-noe-self-model-dry-run="true">Self-model dry-run</button>
      <button class="cxbtn cxbtn-secondary cxbtn-xs" type="button" data-noe-self-model-apply-id="${id}" data-noe-self-model-dry-run="false" ${approved ? '' : 'disabled'}>Apply self-model</button>
    </div>
  `;
}

export function renderMemoryCandidateStatus(status = null) {
  if (!status || status.ok !== true) {
    const reason = status?.error || status?.status || 'unavailable';
    return `<div class="noe-brain-empty">Memory candidate status: ${escapeHtml(clean(reason, 160))}</div>`;
  }
  const pending = status.pending || {};
  const queue = status.queue || {};
  const reports = status.reports || {};
  const readiness = status.readiness || {};
  const latestApply = clean(readiness.latestApplyReportRef || reports.apply?.latest?.ref || '', 500);
  return `
    <div class="noe-brain-row">
      <strong>Memory candidates</strong>
      <span>queue ${Number(queue.records) || 0} · pending ${Number(pending.records) || 0} · owner review ${Number(pending.pendingOwnerReview) || 0}</span>
    </div>
    <div class="noe-brain-row">
      <strong>Latest reports</strong>
      <span>review ${escapeHtml(clean(readiness.latestReviewStatus || '-', 80))} · apply ${escapeHtml(clean(readiness.latestApplyStatus || '-', 80))} · rollback ${escapeHtml(clean(readiness.latestRollbackStatus || '-', 80))}</span>
    </div>
    <div class="noe-brain-row">
      <strong>Rollback input</strong>
      <span>${latestApply ? escapeHtml(latestApply) : 'no apply report yet'}</span>
    </div>
  `;
}

export function renderProposalRows(proposals = []) {
  if (!proposals.length) return '<div class="noe-brain-empty">暂无 proposal。先运行 background review 或 skill curator dry-run。</div>';
  return proposals.map((proposal) => {
    const id = clean(proposal.id, 120);
    const title = clean(proposal.title || proposal.preview?.title || id, 160);
    const summary = clean(proposal.summary || proposal.preview?.summary || '', 220);
    const kind = clean(proposal.kind || proposal.type || '', 80);
    const status = clean(proposal.status || 'proposed', 80);
    const source = sourceLabel(proposal.source);
    return `
      <div class="noe-brain-row" data-noe-proposal-row="${escapeHtml(id)}">
        <strong>${escapeHtml(title)}</strong>
        <span>${escapeHtml(source)} · ${escapeHtml(kind)} · ${escapeHtml(status)}${summary ? ' · ' + escapeHtml(summary) : ''}</span>
        <button class="cxbtn cxbtn-tertiary cxbtn-xs" type="button" data-noe-proposal-id="${escapeHtml(id)}">View</button>
      </div>
    `;
  }).join('');
}

export function renderProposalDetail(proposal = null) {
  if (!proposal) return '<div class="noe-brain-empty">选择一条 proposal 查看详情。这里只读，不会自动应用。</div>';
  const gate = proposal.requiresGatedApply ? 'requires gated apply' : 'read only';
  const writes = Array.isArray(proposal.directWrites) && proposal.directWrites.length ? proposal.directWrites.join(', ') : 'none';
  const ownerDecision = proposal.ownerDecision?.status ? `${proposal.ownerDecision.status} @ ${proposal.ownerDecision.decidedAt || '-'}` : 'none';
  // self_model_diff 提案的通用 Materialize 只入队 self-model-diffs.jsonl(不真改身份),
  // 与下方专属 "Apply self-model"(真改身份)并存会误导 owner;故对该类型隐藏通用 Materialize,
  // 引导走 dry-run → Apply self-model 的专属流程。
  const materializeBtn = isSelfModelDiff(proposal)
    ? ''
    : `<button class="cxbtn cxbtn-secondary cxbtn-xs" type="button" data-noe-proposal-execute-id="${escapeHtml(clean(proposal.id, 160))}" ${proposal.status === 'approved_for_gated_apply' ? '' : 'disabled'}>Materialize</button>`;
  return [
    detailLine('title', proposal.title || proposal.id),
    detailLine('source', `${sourceLabel(proposal.source)} · ${proposal.sourceReportRef || ''}`),
    detailLine('type', `${proposal.kind || '-'} / ${proposal.type || '-'}`),
    detailLine('summary', proposal.summary || proposal.preview?.summary || '-'),
    detailLine('apply', `${proposal.applySupported ? 'supported' : 'not supported here'} · ${gate}`),
    detailLine('owner decision', ownerDecision),
    detailLine('direct writes', writes),
    detailLine('id', proposal.id || '-'),
    `
      <div class="noe-brain-controls" style="align-items:center;gap:8px;flex-wrap:wrap;">
        <button class="cxbtn cxbtn-secondary cxbtn-xs" type="button" data-noe-proposal-decision="approve_for_gated_apply" data-noe-proposal-decision-id="${escapeHtml(clean(proposal.id, 160))}">Approve gated</button>
        ${materializeBtn}
        <button class="cxbtn cxbtn-tertiary cxbtn-xs" type="button" data-noe-proposal-decision="defer" data-noe-proposal-decision-id="${escapeHtml(clean(proposal.id, 160))}">Defer</button>
        <button class="cxbtn cxbtn-tertiary cxbtn-xs" type="button" data-noe-proposal-decision="dismiss" data-noe-proposal-decision-id="${escapeHtml(clean(proposal.id, 160))}">Dismiss</button>
      </div>
    `,
    selfModelApplyControls(proposal),
  ].join('');
}

function ensurePanel(root = document) {
  const existing = root.querySelector?.('#noeProposalInboxPanel');
  if (existing) return existing;
  const grid = root.querySelector?.('#noeBrainArea .noe-brain-grid') || root.querySelector?.('.noe-brain-grid');
  if (!grid?.appendChild) return null;
  const panel = root.createElement('section');
  panel.className = 'noe-brain-panel noe-brain-panel-wide';
  panel.id = 'noeProposalInboxPanel';
  panel.dataset.noePanel = 'proposal-inbox';
  panel.innerHTML = `
    <div class="noe-brain-panel-head">
      <span>Proposal Inbox</span>
      <span class="noe-brain-chip" id="noeProposalInboxStatus">loading</span>
    </div>
    <div class="noe-brain-controls" style="align-items:center;gap:8px;flex-wrap:wrap;">
      <select id="noeProposalSource" title="Proposal source">
        <option value="">all sources</option>
        <option value="background_review">background review</option>
        <option value="boot_self_check">开机自检</option>
        <option value="skill_curator">skill curator</option>
        <option value="self_model">self model</option>
      </select>
      <select id="noeProposalStatus" title="Proposal status">
        <option value="">all status</option>
        <option value="proposed">proposed</option>
        <option value="approved_for_gated_apply">approved for gated apply</option>
        <option value="deferred">deferred</option>
        <option value="dismissed">dismissed</option>
      </select>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnNoeProposalRefresh" type="button">Refresh</button>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnNoeMemoryCandidateReview" type="button">Review Queue</button>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" id="btnNoeMemoryCandidateApplyDryRun" type="button">Apply Dry-run</button>
      <input id="noeMemoryRollbackRef" type="text" placeholder="apply report ref" style="min-width:220px;" />
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" id="btnNoeMemoryCandidateRollbackDryRun" type="button">Rollback Dry-run</button>
      <button class="cxbtn cxbtn-tertiary cxbtn-sm" id="btnNoeMemoryCandidateStatus" type="button">Status</button>
      <span class="noe-brain-chip">read-only</span>
    </div>
    <div class="noe-brain-list" id="noeMemoryCandidateStatus"></div>
    <div class="noe-brain-list" id="noeProposalInboxList"></div>
    <div class="noe-brain-list" id="noeProposalDetail"></div>
  `;
  grid.appendChild(panel);
  return panel;
}

function queryString(root = document) {
  const params = new URLSearchParams();
  const source = root.querySelector?.('#noeProposalSource')?.value || '';
  const status = root.querySelector?.('#noeProposalStatus')?.value || '';
  if (source) params.set('source', source);
  if (status) params.set('status', status);
  params.set('limit', '50');
  return params.toString();
}

export async function refreshProposalInbox(root = document) {
  const list = root.querySelector?.('#noeProposalInboxList');
  const detail = root.querySelector?.('#noeProposalDetail');
  const memoryStatus = root.querySelector?.('#noeMemoryCandidateStatus');
  if (!hasOwnerToken()) {
    setStatus('blocked', root);
    latestProposals = [];
    if (list) list.innerHTML = '<div class="noe-brain-empty">owner token missing；不请求受保护 proposal API。</div>';
    if (detail) detail.innerHTML = renderProposalDetail(null);
    if (memoryStatus) memoryStatus.innerHTML = '<div class="noe-brain-empty">owner token missing；不请求受保护 memory candidate API。</div>';
    return { ok: false, error: 'owner_token_missing' };
  }
  setStatus('loading', root);
  const out = await getJson(`/api/noe/proposals?${queryString(root)}`);
  latestProposals = Array.isArray(out.proposals) ? out.proposals : [];
  if (list) list.innerHTML = renderProposalRows(latestProposals);
  if (detail) detail.innerHTML = renderProposalDetail(latestProposals[0] || null);
  setStatus(out.ok ? `${latestProposals.length}/${out.counts?.total ?? latestProposals.length}` : 'blocked', root);
  postSignal('loaded', { count: latestProposals.length, ok: out.ok === true });
  await refreshMemoryCandidateStatus(root);
  return out;
}

export async function refreshMemoryCandidateStatus(root = document) {
  const el = root.querySelector?.('#noeMemoryCandidateStatus');
  if (!hasOwnerToken()) {
    if (el) el.innerHTML = '<div class="noe-brain-empty">owner token missing；不请求受保护 memory candidate API。</div>';
    return { ok: false, error: 'owner_token_missing' };
  }
  const out = await getJson('/api/noe/memory-candidates/status?limit=10');
  if (el) el.innerHTML = renderMemoryCandidateStatus(out);
  const refInput = root.querySelector?.('#noeMemoryRollbackRef');
  if (out.ok && refInput && !refInput.value && out.readiness?.latestApplyReportRef) {
    refInput.value = clean(out.readiness.latestApplyReportRef, 500);
  }
  postSignal('memory-candidate-status', {
    ok: out.ok === true,
    pending: Number(out.pending?.records) || 0,
    queue: Number(out.queue?.records) || 0,
  });
  return out;
}

export async function loadProposalDetail(id, root = document) {
  const detail = root.querySelector?.('#noeProposalDetail');
  const cached = latestProposals.find((proposal) => proposal.id === id);
  if (detail) detail.innerHTML = renderProposalDetail(cached || null);
  if (!id || !hasOwnerToken()) return { ok: Boolean(cached), proposal: cached || null };
  const out = await getJson(`/api/noe/proposals/${encodeURIComponent(id)}`);
  if (detail) detail.innerHTML = renderProposalDetail(out.proposal || cached || null);
  postSignal('detail-opened', { id, ok: out.ok === true });
  return out;
}

export async function recordProposalDecision(id, decision, root = document) {
  if (!id || !decision || !hasOwnerToken()) return { ok: false, error: 'owner_token_missing_or_invalid_decision' };
  setStatus('saving', root);
  const out = await postJson(`/api/noe/proposals/${encodeURIComponent(id)}/decision`, {
    decision,
    confirmOwner: true,
    reason: 'owner_ui_click',
  });
  const detail = root.querySelector?.('#noeProposalDetail');
  if (detail && out.proposal) detail.innerHTML = renderProposalDetail(out.proposal);
  setStatus(out.ok ? 'decision saved' : 'blocked', root);
  postSignal('decision-recorded', { id, decision: clean(decision, 80), ok: out.ok === true });
  if (out.ok) await refreshProposalInbox(root);
  return out;
}

export async function executeProposalMaterialization(id, root = document) {
  if (!id || !hasOwnerToken()) return { ok: false, error: 'owner_token_missing' };
  setStatus('materializing', root);
  const out = await postJson(`/api/noe/proposals/${encodeURIComponent(id)}/execute`, {
    dryRun: false,
    confirmOwner: true,
  });
  setStatus(out.ok ? 'materialized' : 'blocked', root);
  postSignal('materialized', {
    id,
    ok: out.ok === true,
    status: clean(out.execution?.status || out.error || '', 120),
    reportRef: clean(out.execution?.reportRef || '', 300),
  });
  if (out.ok) await refreshProposalInbox(root);
  return out;
}

function selfModelOwnerConfirmed(id, root = document) {
  const cleanId = clean(id, 160);
  const checkbox = root.querySelector?.(`[data-noe-self-model-confirm-id="${cleanId}"]`);
  return checkbox?.checked === true;
}

export async function applySelfModelProposalFromUi(id, { dryRun = true } = {}, root = document) {
  if (!id || !hasOwnerToken()) return { ok: false, error: 'owner_token_missing' };
  if (!selfModelOwnerConfirmed(id, root)) {
    setStatus('owner confirm required', root);
    postSignal('self-model-apply-blocked', { id: clean(id, 160), dryRun: dryRun === true, reason: 'owner_confirmation_required' });
    return { ok: false, error: 'owner_confirmation_required' };
  }
  setStatus(dryRun ? 'self-model dry-run' : 'self-model applying', root);
  const out = await postJson(`/api/noe/proposals/${encodeURIComponent(id)}/self-model-apply`, {
    dryRun: dryRun === true,
    confirmOwner: true,
  });
  setStatus(out.ok ? (dryRun ? 'self-model dry-run ok' : 'self-model applied') : 'blocked', root);
  postSignal('self-model-apply', {
    id,
    ok: out.ok === true,
    dryRun: dryRun === true,
    versionId: clean(out.selfModelApply?.versionId || '', 80),
    error: clean(out.error || out.selfModelApply?.reason || '', 160),
  });
  if (out.ok) await refreshProposalInbox(root);
  return out;
}

export async function reviewMemoryCandidateQueue(root = document) {
  if (!hasOwnerToken()) return { ok: false, error: 'owner_token_missing' };
  setStatus('reviewing memory queue', root);
  const out = await postJson('/api/noe/memory-candidates/review', {
    dryRun: false,
    confirmOwner: true,
  });
  setStatus(out.ok ? `memory review ${clean(out.status || 'ok', 80)}` : 'blocked', root);
  postSignal('memory-candidate-review', {
    ok: out.ok === true,
    status: clean(out.status || out.error || '', 120),
    pendingRef: clean(out.pendingRef || '', 300),
    reportRef: clean(out.reportRef || '', 300),
  });
  await refreshMemoryCandidateStatus(root);
  return out;
}

export async function dryRunMemoryCandidateApply(root = document) {
  if (!hasOwnerToken()) return { ok: false, error: 'owner_token_missing' };
  setStatus('apply dry-run', root);
  const out = await postJson('/api/noe/memory-candidates/apply', {
    dryRun: true,
  });
  setStatus(out.ok ? `apply ${clean(out.status || 'ok', 80)}` : 'blocked', root);
  postSignal('memory-candidate-apply-dry-run', {
    ok: out.ok === true,
    status: clean(out.status || out.error || '', 120),
    reportRef: clean(out.reportRef || '', 300),
  });
  await refreshMemoryCandidateStatus(root);
  return out;
}

export async function dryRunMemoryCandidateRollback(root = document) {
  if (!hasOwnerToken()) return { ok: false, error: 'owner_token_missing' };
  const ref = clean(root.querySelector?.('#noeMemoryRollbackRef')?.value || '', 500);
  setStatus('rollback dry-run', root);
  const out = await postJson('/api/noe/memory-candidates/rollback', {
    applyReportRef: ref,
    dryRun: true,
  });
  setStatus(out.ok ? `rollback ${clean(out.status || 'ok', 80)}` : 'blocked', root);
  postSignal('memory-candidate-rollback-dry-run', {
    ok: out.ok === true,
    status: clean(out.status || out.error || '', 120),
    applyReportRef: ref,
    reportRef: clean(out.reportRef || '', 300),
  });
  await refreshMemoryCandidateStatus(root);
  return out;
}

export function installNoeProposalInbox({ root = document } = {}) {
  const panel = ensurePanel(root);
  if (!panel) return { ok: false, reason: 'noe_brain_grid_missing' };
  root.querySelector?.('#btnNoeProposalRefresh')?.addEventListener?.('click', () => refreshProposalInbox(root));
  root.querySelector?.('#btnNoeMemoryCandidateReview')?.addEventListener?.('click', () => reviewMemoryCandidateQueue(root));
  root.querySelector?.('#btnNoeMemoryCandidateApplyDryRun')?.addEventListener?.('click', () => dryRunMemoryCandidateApply(root));
  root.querySelector?.('#btnNoeMemoryCandidateRollbackDryRun')?.addEventListener?.('click', () => dryRunMemoryCandidateRollback(root));
  root.querySelector?.('#btnNoeMemoryCandidateStatus')?.addEventListener?.('click', () => refreshMemoryCandidateStatus(root));
  root.querySelector?.('#noeProposalSource')?.addEventListener?.('change', () => refreshProposalInbox(root));
  root.querySelector?.('#noeProposalStatus')?.addEventListener?.('change', () => refreshProposalInbox(root));
  root.querySelector?.('#noeProposalInboxList')?.addEventListener?.('click', (event) => {
    const target = event?.target?.closest?.('[data-noe-proposal-id]') || event?.target;
    const id = target?.dataset?.noeProposalId;
    if (id) loadProposalDetail(id, root);
  });
  root.querySelector?.('#noeProposalDetail')?.addEventListener?.('click', (event) => {
    const selfModelTarget = event?.target?.closest?.('[data-noe-self-model-apply-id]') || event?.target;
    const selfModelId = selfModelTarget?.dataset?.noeSelfModelApplyId;
    if (selfModelId) {
      applySelfModelProposalFromUi(selfModelId, { dryRun: selfModelTarget?.dataset?.noeSelfModelDryRun !== 'false' }, root);
      return;
    }
    const executeTarget = event?.target?.closest?.('[data-noe-proposal-execute-id]') || event?.target;
    const executeId = executeTarget?.dataset?.noeProposalExecuteId;
    if (executeId) {
      executeProposalMaterialization(executeId, root);
      return;
    }
    const target = event?.target?.closest?.('[data-noe-proposal-decision]') || event?.target;
    const decision = target?.dataset?.noeProposalDecision;
    const id = target?.dataset?.noeProposalDecisionId;
    if (id && decision) recordProposalDecision(id, decision, root);
  });
  refreshProposalInbox(root).catch((error) => {
    setStatus('blocked', root);
    const list = root.querySelector?.('#noeProposalInboxList');
    if (list) list.innerHTML = `<div class="noe-brain-empty">${escapeHtml(error?.message || String(error))}</div>`;
  });
  return { ok: true };
}

if (typeof document !== 'undefined') {
  const boot = () => installNoeProposalInbox();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
