import { noeUiSignalToken, postNoeUiSignal } from './noe-ui-signals.js?v=ui-signals-20260608a';
import {
  DEFAULT_TOOL_ID,
  buildFreedomRequestBody,
  defaultFreedomArgs,
  parseFreedomArgsJson,
} from './noe-freedom-request.js';
import {
  applyFreedomNextAction,
  applyFreedomNextActionChain,
  buildFreedomChainArgsFromNextActions,
  buildFreedomNextActionChainRequest,
  extractFreedomNextActions,
  renderFreedomNextActions,
  renderOwnerAuthorizedAccountTargets,
} from './noe-freedom-followups.js';
import { renderFreedomStageSummary } from './noe-freedom-stage-summary.js';
import { escapeHtml, redactFreedomUiValue } from './noe-freedom-ui-utils.js';

let latestQuickStarts = [];
let latestNextActions = [];
let currentFreedomSession = null;

export {
  applyFreedomNextAction,
  applyFreedomNextActionChain,
  buildFreedomChainArgsFromNextActions,
  buildFreedomNextActionChainRequest,
  buildFreedomRequestBody,
  defaultFreedomArgs,
  extractFreedomNextActions,
  parseFreedomArgsJson,
  redactFreedomUiValue,
  renderFreedomNextActions,
  renderFreedomStageSummary,
  renderOwnerAuthorizedAccountTargets,
};

export function formatFreedomResult(result = {}) {
  const safe = redactFreedomUiValue(result);
  return JSON.stringify(safe, null, 2);
}

function headers() {
  return { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': noeUiSignalToken() || '' };
}

// 裸开页面（无 owner token）时暂停受保护接口请求，免 401 噪声（rooms-core-ui / license-ui 同款契约）。
// 优先经 window.PanelCore 桥取 app.js 的 hasOwnerToken；桥未就绪退 PanelOwnerAuth；最后退本模块自身 token 源。
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

async function getJson(path) {
  const res = await fetch(path, { headers: headers() });
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !body.error) body.error = `HTTP ${res.status}`;
  return body;
}

async function postJson(path, body) {
  const res = await fetch(path, { method: 'POST', headers: headers(), body: JSON.stringify(body || {}) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok && !json.error) json.error = `HTTP ${res.status}`;
  return json;
}

function postSignal(action, payload = {}) {
  postNoeUiSignal('card.action', {
    component: 'NoeFreedomTools',
    cardId: 'noeFreedomToolsPanel',
    target: 'noe-brain-freedom-tools',
    action,
    payload,
  });
}

export function renderFreedomToolList(tools = []) {
  if (!tools.length) return '<div class="noe-brain-empty">暂无 freedom capabilities；请确认 owner token 或后端路由。</div>';
  return tools.slice(0, 9).map((tool) => `
    <div class="noe-brain-row">
      <strong>${escapeHtml(tool.name || tool.id)}</strong>
      <span>${escapeHtml(tool.id)} · ${escapeHtml(tool.capability || '')} · ${escapeHtml(tool.riskLevel || '')}</span>
    </div>
  `).join('');
}

export function renderDeveloperModeProfile(profile = {}) {
  if (!profile?.mode) return '<div class="noe-brain-empty">developer mode profile unavailable</div>';
  const powers = [
    profile.canRunLocalShell ? 'Shell' : '',
    profile.canRunSsh ? 'SSH' : '',
    profile.canRunMacAutomation ? 'macOS 自动化' : '',
    profile.canOpenBrowserAccounts ? '账号登录态' : '',
    profile.canControlAllOwnerAuthorizedAccounts ? '所有已授权账号' : '',
    profile.canUseBrowserLoggedInSessions ? '浏览器会话' : '',
    profile.canPublishExternally ? '外部发布' : '',
    profile.canUploadFiles ? '文件上传' : '',
    profile.canUseSecretRefs ? '密钥引用' : '',
    profile.canUseKeychainSecretRefs ? 'Keychain 引用' : '',
    profile.canUseEnvSecretRefs ? '.env 引用' : '',
    profile.canUseSshAgentAndConfiguredKeys ? 'SSH agent/key' : '',
    profile.canUseToolMarketplace ? '工具市场' : '',
  ].filter(Boolean);
  const hardVetoes = Array.isArray(profile.hardVetoes) ? profile.hardVetoes : [];
  return `
    <div class="noe-brain-row">
      <strong>${escapeHtml(profile.label || '开发者最大权限')}</strong>
      <span>${escapeHtml(profile.mode)} · ${profile.skipsTrustManifestAndAllowlist ? '跳过 allowlist/trust manifest' : '需要 allowlist'} · secret 明文不输出</span>
    </div>
    <div class="noe-brain-row">
      <strong>能力</strong>
      <span>${escapeHtml(powers.join(' / ') || 'none')}</span>
    </div>
    <div class="noe-brain-row">
      <strong>硬红线</strong>
      <span>${escapeHtml(hardVetoes.join(' / ') || 'none')}</span>
    </div>
  `;
}

function renderToolOptions(tools = [], selected = DEFAULT_TOOL_ID) {
  return tools.map((tool) => `<option value="${escapeHtml(tool.id)}"${tool.id === selected ? ' selected' : ''}>${escapeHtml(tool.name || tool.id)}</option>`).join('');
}

export function renderQuickStartOptions(quickStarts = []) {
  return [
    '<option value="">选择任务模板...</option>',
    ...quickStarts.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.title || item.id)}</option>`),
  ].join('');
}

export function applyFreedomQuickStart(quickStart = {}, root = document) {
  if (!quickStart?.actionId) return { ok: false, reason: 'quick_start_missing_action' };
  const tool = root.querySelector?.('#noeFreedomTool');
  const mode = root.querySelector?.('#noeFreedomMode');
  const args = root.querySelector?.('#noeFreedomArgs');
  if (tool) tool.value = quickStart.actionId;
  if (mode) mode.value = quickStart.mode || 'developer_unrestricted';
  if (args) args.value = JSON.stringify(quickStart.args || {}, null, 2);
  return { ok: true, actionId: quickStart.actionId };
}

function ensurePanel(root = document) {
  const existing = root.querySelector?.('#noeFreedomToolsPanel');
  if (existing) return existing;
  const grid = root.querySelector?.('#noeBrainArea .noe-brain-grid') || root.querySelector?.('.noe-brain-grid');
  if (!grid?.appendChild) return null;
  const panel = root.createElement('section');
  panel.className = 'noe-brain-panel noe-brain-panel-wide';
  panel.id = 'noeFreedomToolsPanel';
  panel.dataset.noePanel = 'freedom-tools';
  panel.innerHTML = `
    <div class="noe-brain-panel-head">
      <span>Developer Freedom</span>
      <span class="noe-brain-chip" id="noeFreedomStatus">loading</span>
    </div>
    <div class="noe-brain-controls" style="align-items:center;gap:8px;flex-wrap:wrap;">
      <select id="noeFreedomQuickStart" title="开发者任务模板"></select>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnNoeFreedomApplyTemplate" type="button">Apply</button>
      <select id="noeFreedomMode" title="真实执行授权模式">
        <option value="developer_unrestricted">developer_unrestricted</option>
        <option value="owner_supervised_unrestricted">owner_supervised_unrestricted</option>
        <option value="dry_run">dry_run</option>
      </select>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnNoeFreedomStartSession" type="button">Start Dev Session</button>
      <span class="noe-brain-chip" id="noeFreedomSessionStatus">session off</span>
      <select id="noeFreedomTool" title="Freedom tool"></select>
      <label style="display:inline-flex;align-items:center;gap:4px;font-size:13px;"><input id="noeFreedomPersist" type="checkbox" checked /> ledger</label>
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnNoeFreedomRefresh" type="button">Refresh</button>
    </div>
    <textarea id="noeFreedomArgs" rows="5" spellcheck="false" style="font-family:ui-monospace, SFMono-Regular, Menlo, monospace; resize:vertical;" aria-label="Freedom tool JSON args"></textarea>
    <div class="noe-brain-controls">
      <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnNoeFreedomDryRun" type="button">Dry-run</button>
      <button class="cxbtn cxbtn-primary cxbtn-sm" id="btnNoeFreedomExecute" type="button">Execute</button>
    </div>
    <div class="noe-brain-list" id="noeFreedomDeveloperModeProfile"></div>
    <div class="noe-brain-list" id="noeFreedomToolList"></div>
    <pre id="noeFreedomResult" class="noe-brain-empty" style="white-space:pre-wrap;max-height:260px;overflow:auto;">等待操作。</pre>
    <div class="noe-brain-list" id="noeFreedomStageSummary"></div>
    <div class="noe-brain-list" id="noeFreedomAccountTargets"></div>
    <div class="noe-brain-list" id="noeFreedomNextActions"></div>
  `;
  grid.appendChild(panel);
  return panel;
}

function setStatus(text, root = document) {
  const el = root.querySelector?.('#noeFreedomStatus');
  if (el) el.textContent = text;
}

function setSessionStatus(text, root = document) {
  const el = root.querySelector?.('#noeFreedomSessionStatus');
  if (el) el.textContent = text;
}

function setResult(value, root = document) {
  const el = root.querySelector?.('#noeFreedomResult');
  if (el) el.textContent = value;
}

function setNextActions(result = {}, root = document) {
  latestNextActions = extractFreedomNextActions(result);
  const el = root.querySelector?.('#noeFreedomNextActions');
  if (el) el.innerHTML = renderFreedomNextActions(result);
}

function setOwnerAuthorizedAccountTargets(result = {}, root = document) {
  const el = root.querySelector?.('#noeFreedomAccountTargets');
  if (el) el.innerHTML = renderOwnerAuthorizedAccountTargets(result);
}

function setStageSummary(result = {}, root = document) {
  const el = root.querySelector?.('#noeFreedomStageSummary');
  if (el) el.innerHTML = renderFreedomStageSummary(result);
}

async function refreshCapabilities(root = document) {
  setStatus('loading', root);
  // 无 owner token 时不发受保护请求，直接按 blocked 渲染（与有 token 但被拒的 UI 同形）
  const out = hasOwnerToken()
    ? await getJson('/api/noe/freedom/capabilities')
    : { ok: false, error: 'owner_token_missing' };
  const tools = Array.isArray(out.tools) ? out.tools : [];
  latestQuickStarts = Array.isArray(out.quickStarts) ? out.quickStarts : [];
  const quickSelect = root.querySelector?.('#noeFreedomQuickStart');
  if (quickSelect) quickSelect.innerHTML = renderQuickStartOptions(latestQuickStarts);
  const select = root.querySelector?.('#noeFreedomTool');
  if (select) {
    const selected = select.value || DEFAULT_TOOL_ID;
    select.innerHTML = renderToolOptions(tools, selected);
    if (!select.value && tools[0]) select.value = tools.find((tool) => tool.id === DEFAULT_TOOL_ID)?.id || tools[0].id;
  }
  const list = root.querySelector?.('#noeFreedomToolList');
  if (list) list.innerHTML = renderFreedomToolList(tools);
  const developerModeProfile = root.querySelector?.('#noeFreedomDeveloperModeProfile');
  if (developerModeProfile) developerModeProfile.innerHTML = renderDeveloperModeProfile(out.developerMode || {});
  const toolId = select?.value || DEFAULT_TOOL_ID;
  const args = root.querySelector?.('#noeFreedomArgs');
  if (args && !args.value.trim()) args.value = defaultFreedomArgs(toolId);
  if (out.ok) {
    setStatus(`ready · ${tools.length}`, root);
    postSignal('capabilities-loaded', { toolCount: tools.length, developerMode: out.developerMode?.mode || '' });
  } else {
    setStatus('blocked', root);
    setResult(formatFreedomResult(out), root);
    setStageSummary({}, root);
    setOwnerAuthorizedAccountTargets({}, root);
    setNextActions({}, root);
  }
  return out;
}

async function startDeveloperFreedomSession(root = document) {
  setSessionStatus('starting', root);
  const out = await postJson('/api/noe/freedom/session/start', {
    mode: 'developer_unrestricted',
    ownerPresent: true,
    reason: 'Started from Noe Freedom Tools UI.',
  });
  if (out.ok && out.session?.sessionId) {
    currentFreedomSession = out.session;
    setSessionStatus(`session on · ${out.session.mode}`, root);
    setResult(formatFreedomResult({ ok: true, session: out.session }), root);
    setStageSummary({}, root);
    setOwnerAuthorizedAccountTargets({}, root);
    postSignal('developer-session-started', { mode: out.session.mode, sessionId: out.session.sessionId });
  } else {
    setSessionStatus('session blocked', root);
    setResult(formatFreedomResult(out), root);
    setStageSummary({}, root);
    setOwnerAuthorizedAccountTargets({}, root);
  }
  return out;
}

async function runFreedom(realExecute, root = document) {
  const action = root.querySelector?.('#noeFreedomTool')?.value || DEFAULT_TOOL_ID;
  const mode = root.querySelector?.('#noeFreedomMode')?.value || 'developer_unrestricted';
  const argsJson = root.querySelector?.('#noeFreedomArgs')?.value || '{}';
  const persistLedger = root.querySelector?.('#noeFreedomPersist')?.checked !== false;
  const built = buildFreedomRequestBody({
    action,
    argsJson,
    mode,
    sessionId: currentFreedomSession?.sessionId || '',
    realExecute,
    persistLedger,
  });
  if (!built.ok) {
    setStatus('blocked', root);
    setResult(formatFreedomResult(built), root);
    setStageSummary({}, root);
    setOwnerAuthorizedAccountTargets({}, root);
    return built;
  }
  setStatus(realExecute ? 'executing' : 'dry-run', root);
  postSignal(realExecute ? 'execute' : 'dry-run', { action, mode, persistLedger });
  const out = await postJson(realExecute ? '/api/noe/freedom/execute' : '/api/noe/freedom/dry-run', built.body);
  setStatus(out.ok ? 'ok' : 'blocked', root);
  setResult(formatFreedomResult(out), root);
  setStageSummary(out, root);
  setOwnerAuthorizedAccountTargets(out, root);
  setNextActions(out, root);
  return out;
}

async function executeFreedomNextActionChain(root = document) {
  const persistLedger = root.querySelector?.('#noeFreedomPersist')?.checked !== false;
  const built = buildFreedomNextActionChainRequest(latestNextActions, {
    sessionId: currentFreedomSession?.sessionId || '',
    persistLedger,
  });
  if (!built.ok) {
    setStatus('blocked', root);
    setResult(formatFreedomResult(built), root);
    setStageSummary({}, root);
    setOwnerAuthorizedAccountTargets({}, root);
    return built;
  }
  setStatus('executing-chain', root);
  postSignal('next-action-chain-execute', { stepCount: latestNextActions.length, sessionId: currentFreedomSession?.sessionId || '' });
  const out = await postJson('/api/noe/freedom/execute', built.body);
  setStatus(out.ok ? 'ok' : 'blocked', root);
  setResult(formatFreedomResult(out), root);
  setStageSummary(out, root);
  setOwnerAuthorizedAccountTargets(out, root);
  setNextActions(out, root);
  return out;
}

export function installNoeFreedomTools({ root = document } = {}) {
  const panel = ensurePanel(root);
  if (!panel) return { ok: false, reason: 'noe_brain_grid_missing' };
  const toolSelect = root.querySelector?.('#noeFreedomTool');
  const args = root.querySelector?.('#noeFreedomArgs');
  toolSelect?.addEventListener?.('change', () => {
    if (args) args.value = defaultFreedomArgs(toolSelect.value);
  });
  root.querySelector?.('#btnNoeFreedomApplyTemplate')?.addEventListener?.('click', () => {
    const id = root.querySelector?.('#noeFreedomQuickStart')?.value || '';
    const picked = latestQuickStarts.find((item) => item.id === id);
    const out = applyFreedomQuickStart(picked, root);
    if (out.ok) {
      setStatus('template', root);
      setResult(formatFreedomResult({ ok: true, template: picked?.id, action: picked?.actionId, argsPreview: picked?.args || {} }), root);
      setStageSummary({}, root);
      setOwnerAuthorizedAccountTargets({}, root);
      setNextActions({}, root);
      postSignal('quick-start-applied', { id: picked?.id || '', actionId: picked?.actionId || '' });
    }
  });
  root.querySelector?.('#noeFreedomNextActions')?.addEventListener?.('click', (event) => {
    const target = event?.target?.closest?.('[data-noe-next-action-index]') || event?.target;
    const chainRunTarget = event?.target?.closest?.('[data-noe-next-action-chain-run]')
      || (target?.dataset?.noeNextActionChainRun ? target : null);
    if (chainRunTarget?.dataset?.noeNextActionChainRun) {
      executeFreedomNextActionChain(root);
      return;
    }
    const chainTarget = event?.target?.closest?.('[data-noe-next-action-chain]') || (target?.dataset?.noeNextActionChain ? target : null);
    if (chainTarget?.dataset?.noeNextActionChain) {
      const out = applyFreedomNextActionChain(latestNextActions, root);
      if (out.ok) {
        setStatus('next-chain', root);
        setResult(formatFreedomResult({
          ok: true,
          loadedNextActionChain: true,
          action: out.actionId,
          stepCount: out.stepCount,
        }), root);
        setStageSummary({}, root);
        setOwnerAuthorizedAccountTargets({}, root);
        setNextActions({}, root);
        postSignal('next-action-chain-loaded', { actionId: out.actionId, stepCount: out.stepCount });
      }
      return;
    }
    const index = Number(target?.dataset?.noeNextActionIndex);
    const picked = Number.isFinite(index) ? latestNextActions[index] : null;
    const out = applyFreedomNextAction(picked, root);
    if (out.ok) {
      setStatus('next-action', root);
      setResult(formatFreedomResult({
        ok: true,
        loadedNextAction: picked?.stepId || '',
        action: picked?.actionId || '',
        argsPreview: picked?.args || {},
      }), root);
      setStageSummary({}, root);
      setOwnerAuthorizedAccountTargets({}, root);
      setNextActions({}, root);
      postSignal('next-action-loaded', { stepId: picked?.stepId || '', actionId: picked?.actionId || '' });
    }
  });
  root.querySelector?.('#btnNoeFreedomRefresh')?.addEventListener?.('click', () => refreshCapabilities(root));
  root.querySelector?.('#btnNoeFreedomStartSession')?.addEventListener?.('click', () => startDeveloperFreedomSession(root));
  root.querySelector?.('#btnNoeFreedomDryRun')?.addEventListener?.('click', () => runFreedom(false, root));
  root.querySelector?.('#btnNoeFreedomExecute')?.addEventListener?.('click', () => runFreedom(true, root));
  refreshCapabilities(root).catch((error) => {
    setStatus('blocked', root);
    setResult(formatFreedomResult({ ok: false, error: error?.message || String(error) }), root);
    setStageSummary({}, root);
    setOwnerAuthorizedAccountTargets({}, root);
  });
  return { ok: true };
}

if (typeof document !== 'undefined') {
  const boot = () => installNoeFreedomTools();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
