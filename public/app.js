// Noe — 前端

// Round 5：owner-token bootstrap —— 后端启动时打印 ?t=<token> 入口 URL；
// 这里读出存 sessionStorage 然后清掉 URL（避免 referer / 浏览历史 / 截图泄漏）。
// 之后 api() 和 wsUrl() 自动注入；用户手动复制 URL 才能拿 token，
// 本机其他 UID 裸 curl `/` 拿不到（HTML 静态文件不 inject）。
let panelOwnerTokenMemory = '';
(() => {
  try {
    const params = new URLSearchParams(location.search);
    const t = (params.get('t') || '').trim();
    if (t && t.length >= 32) {
      panelOwnerTokenMemory = t;
      window.__panelOwnerToken = t;
      try { sessionStorage.setItem('panel-owner-token', t); } catch {}
      try { localStorage.setItem('panel-owner-token', t); } catch {}
      params.delete('t');
      const q = params.toString();
      history.replaceState(null, '', location.pathname + (q ? '?' + q : '') + location.hash);
    }
  } catch {}
})();
function getOwnerToken() {
  try {
    return sessionStorage.getItem('panel-owner-token')
      || localStorage.getItem('panel-owner-token')
      || panelOwnerTokenMemory
      || window.__panelOwnerToken
      || '';
  } catch {
    return panelOwnerTokenMemory || window.__panelOwnerToken || '';
  }
}
function hasOwnerToken() {
  return getOwnerToken().length >= 32;
}
window.PanelOwnerAuth = {
  getToken: getOwnerToken,
  hasToken: hasOwnerToken,
};
function wsUrl(path) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getOwnerToken();
  const sep = path.includes('?') ? '&' : '?';
  return `${proto}://${location.host}${path}${token ? sep + 'token=' + encodeURIComponent(token) : ''}`;
}

// Round 5：全局 fetch 劫持兜底 —— app.js 有 70+ 处直接 fetch('/api/...')，
// 改每处太繁琐易漏；这里只对同源 /api/ 和 /v1/ 路径注入 token，
// 跨域请求（anthropic.com 等）和已被显式设过 header 的请求不受影响。
(() => {
  if (window.__panelFetchPatched) return;
  window.__panelFetchPatched = true;
  const _fetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string'
        ? input
        : (input && typeof input.url === 'string' ? input.url : '');
      const sameOriginApi = url.startsWith('/api/') || url.startsWith('/v1/');
      if (sameOriginApi && typeof input === 'string') {
        const token = getOwnerToken();
        if (token) {
          init = init || {};
          const h = new Headers(init.headers || {});
          if (!h.has('X-Panel-Owner-Token')) h.set('X-Panel-Owner-Token', token);
          init.headers = h;
        }
      }
    } catch {}
    return _fetch(input, init);
  };
})();

// v0.56 修复：.inspector 的 backdrop-filter 让自身成为 fixed 子元素的 containing block
// 导致所有 .modal 被囚禁在右侧 300px 内不可见 → 现挪到 body 顶层逃逸
(() => {
  const portal = () => document.querySelectorAll('.modal').forEach(m => {
    if (m.parentElement !== document.body) document.body.appendChild(m);
  });
  // a11y：统一给所有 .modal 补 ARIA dialog 语义（role/aria-modal/aria-labelledby）。
  // 纯加属性、幂等，覆盖现有及未来所有 modal；屏幕阅读器可识别为模态对话框。
  const ariaEnrich = () => document.querySelectorAll('.modal').forEach(m => {
    if (!m.getAttribute('role')) m.setAttribute('role', 'dialog');
    if (!m.getAttribute('aria-modal')) m.setAttribute('aria-modal', 'true');
    if (!m.getAttribute('aria-labelledby') && !m.getAttribute('aria-label')) {
      const h = m.querySelector('.project-modal-head h2, .modal-body h2, h2, .modal-title');
      if (h) {
        if (!h.id) h.id = `${m.id || 'modal'}-title`;
        m.setAttribute('aria-labelledby', h.id);
      } else {
        m.setAttribute('aria-label', '对话框');
      }
    }
  });
  const init = () => { portal(); ariaEnrich(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

const state = {
  sessions: [],
  archivedSessions: [],
  activeId: null,
  ws: null,
  activeBusy: false,
  activeCwd: null,
  filePath: null,
  snapshotTimer: null,
  archivedExpanded: false,
  streamingDivs: new Map(), // v0.15 流式：blockIndex → DOM div
  stderrCurrentDiv: null,    // v0.21 当前 turn 的 stderr 累积 div
  collapsedGroups: new Set((() => {
    try { return JSON.parse(localStorage.getItem('cp-collapsed-groups') || '[]'); }
    catch { return []; }
  })()),
};
function persistCollapsedGroups() {
  try { localStorage.setItem('cp-collapsed-groups', JSON.stringify([...state.collapsedGroups])); } catch {}
}

function queuePanelStoreMirror(path, value) {
  try {
    if (window.PanelStore?.set) {
      window.PanelStore.set(path, value);
      return;
    }
    const pending = window.__panelPendingStateMirrors ||= [];
    const existing = pending.find(item => item && item.path === path);
    if (existing) existing.value = value;
    else pending.push({ path, value });
  } catch {}
}

function createPanelMirroredState(namespace, initialState) {
  for (const key of Object.keys(initialState || {})) {
    queuePanelStoreMirror(`${namespace}.${key}`, initialState[key]);
  }
  return new Proxy(initialState, {
    set(target, key, value) {
      target[key] = value;
      queuePanelStoreMirror(`${namespace}.${String(key)}`, value);
      return true;
    },
  });
}

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function renderOwnerTokenMissingBanner() {
  if (hasOwnerToken()) {
    document.getElementById('ownerTokenMissingBanner')?.remove();
    return;
  }
  if (document.getElementById('ownerTokenMissingBanner')) return;
  const banner = document.createElement('div');
  banner.id = 'ownerTokenMissingBanner';
  banner.style.cssText = [
    'position:fixed',
    'left:16px',
    'right:16px',
    'bottom:16px',
    'z-index:10000',
    'padding:14px 16px',
    'border-radius:14px',
    'background:#111827',
    'color:#f9fafb',
    'box-shadow:0 18px 48px rgba(0,0,0,.28)',
    'font-size:14px',
    'line-height:1.6',
    'display:flex',
    'gap:12px',
    'align-items:flex-start',
    'justify-content:space-between',
  ].join(';');
  banner.innerHTML = `
    <div>
      <b>需要 owner token 才能使用面板功能</b>
      <div style="opacity:.86;">请使用启动脚本或重启命令输出的带 <code>?t=...</code> 链接打开；裸开当前地址会暂停受保护接口轮询，避免误报启动失败。</div>
    </div>
    <button type="button" aria-label="关闭 owner token 提示" style="border:0;border-radius:10px;padding:6px 10px;background:#374151;color:#fff;cursor:pointer;">关闭</button>
  `;
  banner.querySelector('button')?.addEventListener('click', () => banner.remove());
  document.body.appendChild(banner);
}

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  const token = getOwnerToken();
  if (token) headers['X-Panel-Owner-Token'] = token;
  const r = await fetch(path, {
    ...opts,
    headers,
  });
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

// ========== D6 apiCall + P2 审批后重试基础设施（apiCall/requestWithApproval/approveAndRetryRequest/maskUrlForDisplay/openApprovalRetryModal/handleApprovalFlow；无 DOM 绑定无顶层副作用）→ 已外迁 public/src/web/approval-flow-ui.js (window.PanelApprovalFlow)（模块化第21批）==========

// ─── v0.8 ConfirmModal（替代 confirm()）─────
// S29 starter: 主实现挪到 src/web/dialog.js (window.PanelDialog.confirmModal)
// 本 wrapper 22 处现有调用透明走 module；main.js 加载失败 fallback inline
function confirmModal(opts, maybeTitle) {
  if (window.PanelDialog && window.PanelDialog.confirmModal) {
    return window.PanelDialog.confirmModal(opts, maybeTitle);
  }
  // fallback inline
  if (typeof opts === 'string') opts = { message: opts, title: maybeTitle };
  opts = opts || {};
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal';
    overlay.innerHTML = `
      <div class="confirm-modal-bg"></div>
      <div class="confirm-modal-body">
        ${opts.title ? `<h3 class="confirm-modal-title">${escapeHtmlEarly(opts.title)}</h3>` : ''}
        <div class="confirm-modal-message">${escapeHtmlEarly(opts.message || '')}</div>
        <div class="confirm-modal-actions">
          <button class="cxbtn cxbtn-secondary" data-act="cancel">${escapeHtmlEarly(opts.cancelLabel || '取消')}</button>
          <button class="cxbtn ${opts.danger ? 'cxbtn-danger' : 'cxbtn-primary'}" data-act="confirm">${escapeHtmlEarly(opts.confirmLabel || '确认')}</button>
        </div>
      </div>
    `;
    const finish = (result) => {
      overlay.classList.add('confirm-modal-closing');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', keyHandler);
      resolve(result);
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
      // v0.50 Q-01 IME fix: 输入法选字时 Enter 不应触发
      // S17-extra：danger 操作（删除等）不让 Enter 误触发，强制点击
      if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229 && !opts.danger) { e.preventDefault(); finish(true); }
    };
    overlay.querySelector('.confirm-modal-bg').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-act="confirm"]').addEventListener('click', () => finish(true));
    document.addEventListener('keydown', keyHandler);
    document.body.appendChild(overlay);
    // S17-extra：danger 操作默认 focus 在 cancel（更安全），普通操作 focus 在 confirm
    setTimeout(() => overlay.querySelector(opts.danger ? '[data-act="cancel"]' : '[data-act="confirm"]').focus(), 30);
  });
}

// ─── v0.9 PromptModal（替代 prompt()）─────
// S29 starter: 主实现挪到 src/web/dialog.js
function promptModal(opts, maybeDefault) {
  if (window.PanelDialog && window.PanelDialog.promptModal) {
    return window.PanelDialog.promptModal(opts, maybeDefault);
  }
  // fallback inline
  if (typeof opts === 'string') opts = { title: opts, value: maybeDefault };
  opts = opts || {};
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'confirm-modal';
    const inputId = 'pm-' + Math.random().toString(36).slice(2, 8);
    const inputEl = opts.multiline
      ? `<textarea id="${inputId}" class="prompt-modal-input" rows="3" placeholder="${escapeHtmlEarly(opts.placeholder || '')}"></textarea>`
      : `<input type="text" id="${inputId}" class="prompt-modal-input" placeholder="${escapeHtmlEarly(opts.placeholder || '')}" />`;
    overlay.innerHTML = `
      <div class="confirm-modal-bg"></div>
      <div class="confirm-modal-body">
        ${opts.title ? `<h3 class="confirm-modal-title">${escapeHtmlEarly(opts.title)}</h3>` : ''}
        ${opts.message ? `<div class="confirm-modal-message">${escapeHtmlEarly(opts.message)}</div>` : ''}
        ${inputEl}
        <div class="confirm-modal-actions">
          <button class="cxbtn cxbtn-secondary" data-act="cancel">${escapeHtmlEarly(opts.cancelLabel || '取消')}</button>
          <button class="cxbtn cxbtn-primary" data-act="confirm">${escapeHtmlEarly(opts.confirmLabel || '确认')}</button>
        </div>
      </div>
    `;
    const finish = (result) => {
      overlay.classList.add('confirm-modal-closing');
      setTimeout(() => overlay.remove(), 180);
      document.removeEventListener('keydown', keyHandler);
      resolve(result);
    };
    const keyHandler = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      // v0.50 Q-01 IME fix
      if (e.key === 'Enter' && !opts.multiline && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        const v = overlay.querySelector('.prompt-modal-input').value;
        finish(v);
      }
    };
    overlay.querySelector('.confirm-modal-bg').addEventListener('click', () => finish(null));
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => finish(null));
    overlay.querySelector('[data-act="confirm"]').addEventListener('click', () => {
      const v = overlay.querySelector('.prompt-modal-input').value;
      finish(v);
    });
    document.addEventListener('keydown', keyHandler);
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.prompt-modal-input');
    if (opts.value != null) input.value = opts.value;
    setTimeout(() => { input.focus(); input.select?.(); }, 30);
  });
}

// ─── v0.7 Toast 通知（替代 alert）─────
function toast(message, kind = 'info', durationMs = 3500) {
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  // v0.51 T-45 fix: toast 上限 5 条，老的自动消失（防 error spam 堆积撑爆 DOM）
  const MAX_TOAST = 5;
  while (container.children.length >= MAX_TOAST) {
    container.firstChild?.remove();
  }
  const t = document.createElement('div');
  t.className = `toast toast-${kind}`;
  t.innerHTML = `
    <span>${escapeHtmlEarly(message)}</span>
    <button class="toast-close-btn" aria-label="关闭">✕</button>
  `;
  const dismiss = () => {
    if (t.classList.contains('toast-closing')) return;
    t.classList.add('toast-closing');
    setTimeout(() => t.remove(), 220);
  };
  t.querySelector('.toast-close-btn').addEventListener('click', dismiss);
  container.appendChild(t);
  if (durationMs > 0) setTimeout(dismiss, durationMs);
  return dismiss;
}
// escapeHtml 在 app.js 末尾定义，toast 早期被调用 → 这里给个早期可用版本
function escapeHtmlEarly(s) {
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ========== 会话 CRUD + 全局右键菜单 + 双击重命名（listSessions/setSessionArchived/renameSession/closeContextMenu/openContextMenu/startRenameSession/createSession/deleteSession + document click/keydown(Esc 关菜单/中断) + 启动初拉/4s 轮询/visibilitychange 收进 boot）→ 已外迁 public/src/web/sessions-core-ui.js (window.PanelSessionsCore)（模块化第17批）==========

// S24 minimum: escapeHtml 主实现挪到 src/web/utils.js (PanelUtils.escapeHtml)
// 156 处现有调用不动；hot path 走 PanelUtils；main.js 加载失败 fallback inline
function escapeHtml(s) {
  if (window.PanelUtils && window.PanelUtils.escapeHtml) {
    return window.PanelUtils.escapeHtml(s);
  }
  return (s || '').toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// v0.44 P1 #13: 多行字段（reasoning / issues / suggestions）保留换行
// S24 minimum: 同 escapeHtml 风格 wrapper
function escapeHtmlMl(s) {
  if (window.PanelUtils && window.PanelUtils.escapeHtmlMl) {
    return window.PanelUtils.escapeHtmlMl(s);
  }
  return escapeHtml(s).replace(/\n/g, '<br>');
}
// S24 minimum: shortenPath 主实现已挪到 src/web/utils.js (PanelUtils.shortenPath)
// 本 wrapper 保留向后兼容；7 处现有调用不动；main.js 加载失败时降级 inline 实现
function shortenPath(p) {
  if (window.PanelUtils && window.PanelUtils.shortenPath) {
    return window.PanelUtils.shortenPath(p);
  }
  // fallback
  if (!p) return '';
  const home = '/Users/' + (p.split('/')[2] || '');
  return p.replace(home, '~');
}

// ========== v0.24/v0.25 markdown 渲染（_markedConfigured 幂等 + ensureMarkedConfigured/renderMarkdown；CDN 全局 marked/DOMPurify + Path B regex fallback 降级语义随迁原样保留）→ 已外迁 public/src/web/markdown-ui.js (window.PanelMarkdown)（模块化第21批）==========

// ========== 会话列表渲染 + 归档区 + appendMessage（renderList/buildSessionItem/renderArchived/showEmpty/showChat/appendMessage + #archivedToggle 绑定 + 启动 showEmpty() 收进 boot）→ 已外迁 public/src/web/sessions-list-ui.js (window.PanelSessionsList)（模块化第17批）==========

// ========== selectSession + attachSessionWS（会话 WS 总分发）+ stderr/partial 流式 + 状态/成本 chip + danger/loopGuard/focusChain banner（STATE_LABELS/updateStateChip/updateCostChip/refreshCostSpark + #btnDangerDismiss/#btnLoopGuardDismiss 绑定）→ 已外迁 public/src/web/sessions-stream-ui.js (window.PanelSessionsStream)（模块化第18批）==========

// ========== Watcher 监视者 UI（showWatcherVerdict/updateWatcherToggleUI/loadWatcherProviders/watcherState + #btnWatcher*/#watcherProviderSelect 绑定 + 加载即拉 providers 收进 boot）→ 已外迁 public/src/web/watcher-ui.js (window.PanelWatcher)（模块化第18批）==========

// ========== busy UI/中断/send 发送 + Snapshot/Handoff/ctx 仪表 + 新建弹窗（updateBusyUI/interruptCurrentTurn/send/refreshSnapshot/startSnapshotPolling(5s 轮询 document.hidden 感知)/refreshCtx/openModal/closeModal/loadQuickCwd + #btnSend/#chatInput/#btnInterrupt/#btnSnapRefresh/#btnHandoff/#btnExternal/#btnSpawnAll/#btnNew/#btnCreateConfirm/[data-close] 绑定）→ 已外迁 public/src/web/sessions-tools-ui.js (window.PanelSessionsTools)（模块化第19批）==========

// ───── Inspector tabs ─────
let currentTab = 'info';
$$('.ins-tab').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    currentTab = tab;
    $$('.ins-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.ins-content').forEach(c => c.style.display = c.dataset.content === tab ? 'block' : 'none');
    // 第19批外迁：4 个分发目标已出 app.js → window 懒调（sessions-tools/projects-files/safety）
    if (tab === 'files' && state.activeCwd) window.PanelProjectsFiles?.loadFiles?.(state.activeCwd);
    if (tab === 'snapshot') window.PanelSessionsTools?.refreshSnapshot?.();
    if (tab === 'projects') window.PanelProjectsFiles?.loadProjects?.();
    if (tab === 'safety') window.PanelSafety?.refreshSafety?.();
  });
});

// ========== v0.27 安全历史 tab（refreshSafety/renderWatcherSection/renderHookEventsSection/attachWatcherSectionHandlers/maybeRefreshSafetyIfOpen + #btnSafetyRefresh 绑定）→ 已外迁 public/src/web/safety-ui.js (window.PanelSafety)（模块化第19批）==========

// ========== 项目监控 + 接力链 history modal + 文件浏览器 + 全局 ⌘N/⌘1-9（loadProjects/openProjectModal/closeProjectModal/openHistoryModal/loadHistoryArchive/closeHistoryModal/loadFiles/formatSize/openFileInChat + #btnProjectsRefresh/#chainBadge/[data-close-project]/[data-close-history] 绑定 + document keydown ×2）→ 已外迁 public/src/web/projects-files-ui.js (window.PanelProjectsFiles)（模块化第19批）==========

// ========== v0.6 主题切换 + Claude 登录按钮 + StatusBar（applyTheme/toggleTheme/THEME_NAMES/updateStatusBar + #themeToggle/#btnLoginClaude 绑定 + 恢复保存主题/4s setInterval 收进 boot）→ 已外迁 public/src/web/theme-statusbar-ui.js (window.PanelTheme)（模块化第20批）==========

// ========== v0.6 ⌘K 命令面板（cmdkState/buildCmdkItems/openCmdk/closeCmdk/renderCmdk + #cmdkInput/#cmdkModal 绑定 + 全局 ⌘K/⌘D keydown 收进 boot）→ 已外迁 public/src/web/cmdk-ui.js (window.PanelCmdk 合并挂载，BUILTIN_COMMANDS 桥仍由 main.js 提供)（模块化第20批）==========

// ========== v0.23 内嵌真终端 PTY+xterm（termState/showTermArea/hideTermArea/openTerm/getXtermTheme/closeTerm + #btnTerminal/#btnTermNew/#btnTermInCwd/#btnTermClose/#btnTermBack 绑定；CDN 全局 window.Terminal/FitAddon/createPlainTerminal 依赖保持）→ 已外迁 public/src/web/term-ui.js (window.PanelTerm)（模块化第20批）==========
// ========== v0.25 代码块复制/折叠 document click 委托（按钮由 renderMarkdown 生成，属主=markdown 区，委托收进 boot 只绑一次）→ 已随迁 public/src/web/markdown-ui.js (window.PanelMarkdown)（模块化第21批）==========

// ========== v0.30/v0.46/v0.50 启动版本号（async IIFE 拉 /api/version 写 #brandSubtitle/#brandTitle/#statusVersion/#aboutVersion）→ 已并入 public/src/web/theme-statusbar-ui.js boot()（写 #statusVersion 属 StatusBar UI，归该模块；main.js 保持纯入口）（模块化第20批）==========

// ========== v0.39 多 AI 聊天室 ==========
// ========== 房间核心状态/列表/选择/归档/WS/MODEL_OPTIONS → 已外迁 public/src/web/rooms-core-ui.js (window.PanelRoomsCore)（模块化第10批）==========

// === 外迁桥（供 public/src/web/*.js 取用 app.js 顶层共享符号；S24 app.js 模块化）===
window.PanelCore = {
  get state() { return state; },
  // 第10批外迁：roomState 本体已出 app.js → 经 PanelRoomsCore 实时取
  // （消费者 boot 快照亦可用：main.js import 顺序保证 rooms-core-ui 先 boot）
  get roomState() { return window.PanelRoomsCore?.roomState; },
  $, $$, toast, escapeHtml, createPanelMirroredState,
  // 第2批引入直引；第21批外迁（approval-flow-ui）：审批后重试基础设施已出 app.js → 改 window 懒转发
  // （webhook/mcp/plugin/safety/room-adapter 消费方 boot 解构拿到转发器，调用时实时解析）
  requestWithApproval: (...a) => window.PanelApprovalFlow?.requestWithApproval?.(...a),
  handleApprovalFlow: (...a) => window.PanelApprovalFlow?.handleApprovalFlow?.(...a),
  get webhookState() { return window.PanelWebhook?.state; },
  get mcpState() { return window.PanelMcp?.state; },
  // 第3批引入直引；第10批外迁（rooms-members-ui）：成员/providers 群已出 app.js → 改 window 懒转发
  refreshRoomProviders: (...a) => window.PanelRoomsMembers?.refreshRoomProviders?.(...a),
  renderRoomMembers: (...a) => window.PanelRoomsMembers?.renderRoomMembers?.(...a),
  startElapsedTicker: (...a) => window.PanelRoomsMembers?.startElapsedTicker?.(...a),
  // 第3批引入直引；第21批外迁（markdown-ui）：markdown 渲染已出 app.js → 改 window 懒转发
  // （消息渲染热路径：sessions-list/stream/tools 等消费方 boot 解构拿到转发器，调用时实时解析）
  renderMarkdown: (...a) => window.PanelMarkdown?.renderMarkdown?.(...a),
  // 第3批外迁新增（activity-ui）：审计时间线模块依赖的 app.js 顶层符号
  api,
  activityTime, safeClassToken,
  stagedDiffReviewText, governanceCenterBytes, governanceShortHash,
  // openAgentRunFromActivity/openAgentRunArtifact 已外迁到 agent-graph-ui.js，改为 getter
  get openAgentRunFromActivity() { return window.PanelAgentGraph?.openAgentRunFromActivity; },
  get openAgentRunArtifact() { return window.PanelAgentGraph?.openAgentRunArtifact; },
  fallbackCopy,
  // 第3批引入直引；第10批外迁（rooms-core-ui）：房间核心群已出 app.js → 改 window 懒转发
  showRoomArea: (...a) => window.PanelRoomsCore?.showRoomArea?.(...a),
  loadRooms: (...a) => window.PanelRoomsCore?.loadRooms?.(...a),
  selectRoom: (...a) => window.PanelRoomsCore?.selectRoom?.(...a),
  // 第4批外迁新增（overview-ui）；第15批 cleanOldMetrics 本体迁入语义属主 overview-ui → getter 改 window 懒取
  get cleanOldMetrics() { return window.PanelOverview?.cleanOldMetrics; },
  // 智能体图谱外迁第二步：agentRegistryState 经 PanelAgentGraph 模块访问
  get agentRegistryState() { return window.PanelAgentGraph?.state; },
  // 修复：总览区块F治理摘要的审批/委派跳转入口
  // 第6批外迁：审批/委派中心已出 app.js → 改懒转发函数（外部模块 boot 时 destructure 拿到转发器，
  // 与 PanelApprovals/PanelDelegation 的 boot 顺序无关，调用时再解析）
  openApprovalModal: (...a) => window.PanelApprovals?.openApprovalModal?.(...a),
  openDelegationModal: (...a) => window.PanelDelegation?.openDelegationModal?.(...a),
  // 第4批外迁新增（governance-ui）：委派跳转需要设置 activeId；第6批改经 PanelDelegation 取
  get delegationState() { return window.PanelDelegation?.state; },
  // 第6批外迁新增（approvals/delegation-ui）：模态输入框（函数声明已 hoist，直引有效）；
  // lineage 短显 shortLineageValue 第10批随 rooms-core-ui 出走 → 改 window 懒转发
  promptModal,
  shortLineageValue: (...a) => window.PanelRoomsCore?.shortLineageValue?.(...a),
  // 第8批引入闭包转发；第11批外迁（rooms-debate-ui）：renderRoomDebate 已出 app.js → 改 window 懒转发
  renderRoomDebate: (...a) => window.PanelRoomsDebate?.renderRoomDebate?.(...a),
  // 第11批引入闭包转发；第12批外迁（rooms-chat/actions-ui）：renderChatRoom/abortDebate/pullRoomAndRender
  // 已出 app.js → 改 window 懒转发。escapeHtmlMl 函数声明已 hoist，直引有效
  renderChatRoom: (...a) => window.PanelRoomsChat?.renderChatRoom?.(...a),
  abortDebate: (...a) => window.PanelRoomsActions?.abortDebate?.(...a),
  pullRoomAndRender: (...a) => window.PanelRoomsActions?.pullRoomAndRender?.(...a),
  escapeHtmlMl,
  // 第9批引入闭包转发；第10批外迁（rooms-core-ui）：两纯函数已出 app.js → 改 window 懒转发
  statusLabel: (...a) => window.PanelRoomsCore?.statusLabel?.(...a),
  isRoomRunningLike: (...a) => window.PanelRoomsCore?.isRoomRunningLike?.(...a),
  // 第5批引入；第10批外迁（rooms-members-ui）：技能/providers 缓存已出 app.js → 经新 window 全局实时取
  // （getter 延迟求值传统保留：曾因 MODEL_OPTIONS TDZ ReferenceError 崩整个 app.js）
  refreshRoomSkills: (...a) => window.PanelRoomsMembers?.refreshRoomSkills?.(...a),
  getOwnerToken,
  get MODEL_OPTIONS() { return window.PanelRoomsCore?.MODEL_OPTIONS; },
  get roomSkillsCache() { return window.PanelRoomsMembers?.roomSkillsCache; },
  get roomProvidersCache() { return window.PanelRoomsMembers?.roomProvidersCache; },
  // roomSkillsLoaded 保留可写代理：agent-graph-ui.js 写 false 触发技能重拉
  get roomSkillsLoaded() { return window.PanelRoomsMembers?.roomSkillsLoaded; },
  set roomSkillsLoaded(v) { window.PanelRoomsMembers?.setRoomSkillsLoaded?.(v); },
  // 第10批外迁新增（rooms-core/members-ui）：模块依赖的 app.js 顶层符号（函数声明已 hoist，直引有效）
  hasOwnerToken, renderOwnerTokenMissingBanner, confirmModal, shortenPath, wsUrl,
  // 第12批外迁（rooms-events-ui）：handleRoomEvent 已出 app.js → 改 window 懒转发（已外迁的 attachRoomWS 经此调用）
  handleRoomEvent: (...a) => window.PanelRoomsEvents?.handleRoomEvent?.(...a),
  // 第12批引入直引；第21批外迁（approval-flow-ui）：apiCall 已出 app.js → 改 window 懒转发
  apiCall: (...a) => window.PanelApprovalFlow?.apiCall?.(...a),
  // 第17+18批外迁（sessions 域四模块）：selectSession/listSessions/openContextMenu 已出 app.js → 改 window 懒转发
  // （openContextMenu 通用件：消息右键/会话右键共用，经桥暴露给后续批次）
  selectSession: (...a) => window.PanelSessionsStream?.selectSession?.(...a),
  listSessions: (...a) => window.PanelSessionsCore?.listSessions?.(...a),
  openContextMenu: (...a) => window.PanelSessionsCore?.openContextMenu?.(...a),
  // 第17+18批引入直引；第19批外迁（sessions-tools/safety/projects-files）：批17/18 留守闭包直引已出 app.js
  // → 改 window 懒转发（sessions-core/stream 的 core.updateBusyUI?.() 等调用点零改动，调用时实时解析）
  updateBusyUI: (...a) => window.PanelSessionsTools?.updateBusyUI?.(...a),
  interruptCurrentTurn: (...a) => window.PanelSessionsTools?.interruptCurrentTurn?.(...a),
  refreshSnapshot: (...a) => window.PanelSessionsTools?.refreshSnapshot?.(...a),
  startSnapshotPolling: (...a) => window.PanelSessionsTools?.startSnapshotPolling?.(...a),
  refreshCtx: (...a) => window.PanelSessionsTools?.refreshCtx?.(...a),
  loadFiles: (...a) => window.PanelProjectsFiles?.loadFiles?.(...a),
  maybeRefreshSafetyIfOpen: (...a) => window.PanelSafety?.maybeRefreshSafetyIfOpen?.(...a),
  // 第20批外迁（theme-statusbar-ui）：updateStatusBar 已出 app.js → 改 window 懒转发
  // （sessions-core 的 core.updateStatusBar?.() 调用点零改动，调用时实时解析）
  updateStatusBar: (...a) => window.PanelTheme?.updateStatusBar?.(...a),
  // 留守符号直引（函数声明已 hoist，直引有效）
  persistCollapsedGroups, escapeHtmlEarly,
  get currentTab() { return currentTab; },
};


// ========== 辩论渲染 renderRoomDebate → 已外迁 public/src/web/rooms-debate-ui.js (window.PanelRoomsDebate)（模块化第11批）==========

// ========== cluster runtime 实时渲染群 → 已外迁 public/src/web/rooms-cluster-live-ui.js (window.PanelRoomsClusterLive)（模块化第9批）==========

if (typeof window !== 'undefined') {
  Object.defineProperty(window, '__noeClusterTest', {
    configurable: true,
    value: {
      // 第9批外迁：cluster runtime 实时渲染群已出 app.js → 懒解析指向 window.PanelRoomsClusterLive（e2e 仍经此钩子调用）
      crossVerifyStageBadges: (...a) => window.PanelRoomsClusterLive?.crossVerifyStageBadges?.(...a),
      // 第12批外迁：handleRoomEvent 已出 app.js → 懒解析指向 window.PanelRoomsEvents（e2e 仍经此钩子调用）
      handleRoomEvent: (...a) => window.PanelRoomsEvents?.handleRoomEvent?.(...a),
      renderClusterRuntimeHeartbeatLine: (...a) => window.PanelRoomsClusterLive?.renderClusterRuntimeHeartbeatLine?.(...a),
      renderClusterRuntimeRecoveryLine: (...a) => window.PanelRoomsClusterLive?.renderClusterRuntimeRecoveryLine?.(...a),
      renderClusterRuntimeResumePolicyLine: (...a) => window.PanelRoomsClusterLive?.renderClusterRuntimeResumePolicyLine?.(...a),
      // 第8批外迁：实现已出 app.js → 懒解析指向 window.PanelRoomsClusterTools（e2e 仍经此钩子调用）
      formatClusterDiagnosticsMarkdown: (...a) => window.PanelRoomsClusterTools?.formatClusterDiagnosticsMarkdown?.(...a),
      renderCrossVerifyConsensusMarkdown: (...a) => window.PanelRoomsClusterLive?.renderCrossVerifyConsensusMarkdown?.(...a),
    },
  });
}

// ========== 房间状态纯函数/lineage（statusLabel/isRoomRunningLike/shortLineageValue/renderRoomLineage）→ 已外迁 public/src/web/rooms-core-ui.js (window.PanelRoomsCore)（模块化第10批）==========

// ========== 房间成员/技能/providers/计时器群（ROOM_STATUS_ZH 随核心迁 rooms-core-ui）→ 已外迁 public/src/web/rooms-members-ui.js (window.PanelRoomsMembers)（模块化第10批）==========

// ========== 轮次卡群 + 全局 Esc 结束辩论（ROUND_TITLES/getRoundTitle/renderRounds/getCurrentRoomStatus/renderTurnCard/retryTurn/ensureRoundCard）→ 已外迁 public/src/web/rooms-debate-ui.js (window.PanelRoomsDebate)（模块化第11批）==========

// ========== Squad 看板 + 任务详情抽屉（SQUAD_COLS/squadCurrentTasks/_squadTaskStartedAt/renderSquadKanban/retrySquadTask/openSquadDetail）→ 已外迁 public/src/web/rooms-squad-ui.js (window.PanelRoomsSquad)（模块化第11批）==========

// ===== v0.48 Chat 房 1v1 渲染 =====
// ========== chatMedia 媒体附件（草稿托盘/上传/渲染/任务上下文注入）→ 已外迁 public/src/web/rooms-chat-media-ui.js (window.PanelRoomsChatMedia)（模块化第7批）==========

// ========== Chat 房 1v1 渲染/发送（renderChatRoom/buildChatMessageEl/sendChatMessage/abortChat）→ 已外迁 public/src/web/rooms-chat-ui.js (window.PanelRoomsChat)（模块化第12批）==========

// ========== 房间 WS 事件总分发 handleRoomEvent（debate/squad/arena/cross_verify/chat/cluster 全 mode）→ 已外迁 public/src/web/rooms-events-ui.js (window.PanelRoomsEvents)（模块化第12批）==========

// ========== 房间操作群 + 房间域顶层 DOM 绑定块（startDebate/abortDebate/deleteRoom/pullRoomAndRender/delegateActiveRoom/addRoomRequirement + #btnRooms/#btnRoom*/#btnChat*/结论转发/拖放粘贴/#qaStrictSelect）→ 已外迁 public/src/web/rooms-actions-ui.js (window.PanelRoomsActions)（模块化第12批）==========

// ========== cluster 工具/formatter/操作群（预检/并发预算/诊断/自愈/交付包）→ 已外迁 public/src/web/rooms-cluster-tools-ui.js (window.PanelRoomsClusterTools)（模块化第8批）==========

// ========== 重启/续跑/大轮数绑定（#btnRoomRestart/#btnRoomResume/#roomDebateRoundsInput）→ 已外迁 public/src/web/rooms-actions-ui.js (window.PanelRoomsActions)（模块化第12批）==========

// ============ v0.54 Sprint 10：删除 Ruflo 集成（用户不用） ============

// ========== Plugin 中心（pluginState/showPluginArea/hidePluginArea/loadPluginList/renderPluginList/renderPluginDetail/runPluginCommand/installPluginFromFile + #btnPlugin* 绑定）→ 已外迁 public/src/web/plugin-ui.js (window.PanelPlugin)（模块化第13批）==========


// v0.50 全局错误兜底：未捕获的 Promise/异常显示 toast（避免静默崩）
// v0.51 R-10 fix: 过滤掉浏览器/扩展噪声（ResizeObserver / "Script error." / 跨源 / 扩展 / CDN）
const NOISY_ERROR_PATTERNS = [
  /ResizeObserver loop/i,
  /^Script error\.?$/i,
  /Loading chunk \d+ failed/i,
  /NetworkError when attempting to fetch resource/i,
];
function isNoisyError(msg, filename) {
  if (!msg) return true;
  if (filename && (filename.includes('extension://') || filename.includes('cdn.jsdelivr') || filename.includes('chrome-extension'))) return true;
  return NOISY_ERROR_PATTERNS.some(re => re.test(msg));
}
window.addEventListener('error', (e) => {
  if (isNoisyError(e.message, e.filename)) return;
  try { toast('页面错误：' + (e.message || 'unknown'), 'error', 5000); } catch {}
});
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || String(e.reason || '').slice(0, 200);
  if (!msg || msg.includes('AbortError') || isNoisyError(msg)) return;
  try { toast('异步错误：' + msg, 'error', 5000); } catch {}
});

// v0.50 Q-04 fix: clipboard 降级到 execCommand（非 secure context / 旧浏览器）
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    toast(ok ? '已复制（兼容模式）' : '复制失败，请手动选中', ok ? 'success' : 'warn');
  } catch (e) {
    toast('复制失败：' + e.message, 'error');
  }
}

// ============ v0.50 体验优化 6 件套 ============

// ========== F1 跨 session 全局搜索（⌘⇧F）+ v0.53 跨房搜索（⌘⇧R）（searchState/roomSearchState + 输入/键盘/modal 绑定）→ 已外迁 public/src/web/search-ui.js (window.PanelSearch)（模块化第14批）==========

// ========== F3 浏览器通知（notifState/notifInit/maybeNotify，notifInit 收进 boot 只执行一次）→ 已外迁 public/src/web/prompts-notify-ui.js (window.PanelPromptsNotify)（模块化第14批）==========

// ========== F4 ⌘? cheatsheet（openCheatsheet/closeCheatsheet + #cheatsheetModal/#statusKbBtn 绑定）→ 已外迁 public/src/web/search-ui.js (window.PanelSearch)（模块化第14批）==========

// ========== F6 Prompts 模板库（openPrompts/closePrompts/loadPromptsList + #btnPromptAdd/#promptsModal 绑定）→ 已外迁 public/src/web/prompts-notify-ui.js (window.PanelPromptsNotify)（模块化第14批）==========

// ========== F5 + F7 message 右键菜单（收藏/分叉）+ ⭐ 渲染（_toggleStarInflight/toggleStar/forkSession + chatOutput ⭐ click/contextmenu document 委托）→ 已外迁 public/src/web/sessions-tools-ui.js (window.PanelSessionsTools)（模块化第22批）==========

// ========== F8 ctx 警告条（updateCtxWarningBar/ensureCtxBar/showCtxBar/hideCtxBar + 5s setInterval document.hidden 感知；F3 turn_end 通知 hook 属 prompts-notify-ui 第14批已迁）→ 已随迁 public/src/web/sessions-tools-ui.js（模块化第22批）==========

// ========== 快捷键统一处理 document keydown（⌘⇧F/⌘⇧R/⌘P/⌘? + Esc 四 modal）→ 已外迁 public/src/web/search-ui.js (window.PanelSearch) boot 只绑一次（模块化第14批）==========

// ========== F3 长任务 turn_end 通知 4s 轮询（notifTrack busy 沿降检测）→ 已外迁 public/src/web/prompts-notify-ui.js (window.PanelPromptsNotify) boot 只起一次（模块化第14批）==========

// ========== v0.53 Sprint 3 — 📊 总览面板已外迁 → public/src/web/overview-ui.js (window.PanelOverview) ==========
// ========== P0 Governance Center — 统一治理入口 → 已外迁 → public/src/web/governance-ui.js (window.PanelGovernance) ==========
// 治理通用工具（被 activity-ui 经桥复用 + 治理模块经桥用），留 app.js
function governanceCenterBytes(bytes) {
  const n = Number(bytes || 0);
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function governanceShortHash(value) {
  const text = String(value || '');
  return text ? text.slice(0, 10) : '-';
}

function stagedDiffReviewText(diff = {}) {
  const summary = diff?.summary || {};
  if (!diff?.id && !diff?.sha256 && !summary.fileCount) return '';
  return `+${Number(summary.totalAdditions || 0)}/-${Number(summary.totalRemovals || 0)} · ${Number(summary.newFileCount || 0)} new · ${Number(summary.existingFileCount || 0)} existing · ${Number(summary.verificationCoveredFileCount || 0)}/${Number(summary.fileCount || 0)} verified · ${Number(summary.uncoveredFileCount || 0)} uncovered · ${Number(summary.highRiskFileCount || 0)} high risk · ${governanceShortHash(diff.sha256 || diff.id)}`;
}

// ========== cleanOldMetrics 清理老 metrics → 已外迁（语义属主）public/src/web/overview-ui.js (window.PanelOverview.cleanOldMetrics)（模块化第15批）==========

// v0.53 Sprint 3.5：/ws/global 改为全局长连接（不依赖 overview 打开）+ 自动重连
const globalWsState = { ws: null, reconnectAttempts: 0, reconnectTimer: null };
// S24 外迁基建：/ws/global 消息改 pub/sub 派发。区块各自 subscribe 自己的 handler，
// 解开 onmessage 对各区私有 state 的直读耦合（report 已外迁；overview 待外迁）。
const globalWsSubscribers = [];
function subscribeGlobalWs(fn) { if (typeof fn === 'function' && !globalWsSubscribers.includes(fn)) globalWsSubscribers.push(fn); }
function ensureGlobalWs() {
  if (!hasOwnerToken()) {
    renderOwnerTokenMissingBanner();
    return null;
  }
  if (globalWsState.ws && globalWsState.ws.readyState <= 1) return globalWsState.ws;
  try {
    const ws = new WebSocket(wsUrl('/ws/global'));
    globalWsState.ws = ws;
    ws.onopen = () => { globalWsState.reconnectAttempts = 0; };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      for (const fn of globalWsSubscribers) { try { fn(msg, e); } catch {} }
    };
    ws.onclose = () => {
      globalWsState.ws = null;
      // 指数退避重连（上限 8s，最多 8 次）
      globalWsState.reconnectAttempts++;
      if (globalWsState.reconnectAttempts > 8) return;
      const delay = Math.min(8000, 800 * Math.pow(2, globalWsState.reconnectAttempts - 1));
      if (globalWsState.reconnectTimer) clearTimeout(globalWsState.reconnectTimer);
      globalWsState.reconnectTimer = setTimeout(ensureGlobalWs, delay);
    };
    ws.onerror = () => {};
  } catch (e) {
    console.warn('connect /ws/global failed:', e.message);
  }
  return globalWsState.ws;
}
// 暴露给外迁模块：区块 boot 时 window.PanelGlobalWs.subscribe(handler) 注册自己的 WS 处理
window.PanelGlobalWs = { ensure: ensureGlobalWs, subscribe: subscribeGlobalWs, get state() { return globalWsState; } };
// report+overview 已各自外迁、带走自己的 WS handler

// ========== 房间模板 modal（roomTemplateState/modeChip/openRoomTemplateModal/closeRoomTemplateModal/renderRoomTemplateList/renderRoomTemplateItem/selectRoomTemplate/createRoomFromTemplate/deleteRoomTemplate + #btnRoomNewFromTemplate/[data-close-room-template] 绑定）→ 已外迁 public/src/web/room-templates-ui.js (window.PanelRoomTemplates)（模块化第13批）==========
// overview 4 绑定已外迁 → overview-ui.js boot()

// ========== v0.54 Sprint 4 — 🔔 Webhook 出站推送 ==========
// Webhook 区已外迁 → public/src/web/webhook-ui.js (window.PanelWebhook)

// 聊天归档配置区已外迁 → public/src/web/archive-ui.js (window.PanelArchive)
// S18-3：data-close-archive 全局绑定由 Modal event delegation 接管

// ========== v0.55 Sprint 12 — 🔌 MCP 服务器 ==========
// MCP 区已外迁 → public/src/web/mcp-ui.js (window.PanelMcp)


// Agent 图谱区已外迁 → public/src/web/agent-graph-ui.js (window.PanelAgentGraph)

// ========== Codebase Center（codebaseCenterState/openCodebaseCenterModal/renderCodebaseCenter/runCodebaseQuery/runCodebaseQuestion/addCodebaseResultsToDispatch/openDispatchPreviewFromCodebase + #btnCodebaseCenter/[data-close-codebase-center] 绑定）→ 已外迁 public/src/web/codebase-center-ui.js (window.PanelCodebase)（模块化第15批）==========

// ========== 知识库（证据 FTS 检索）→ 已外迁 public/src/web/knowledge-ui.js (window.PanelKnowledge)（模块化第6批）==========

// ========== 本地审批中心 → 已外迁 public/src/web/approvals-ui.js (window.PanelApprovals)（模块化第6批）==========

// 审计时间线通用工具（被多区复用，留 app.js）
function activityTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '-';
  try { return new Date(n).toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch { return '-'; }
}
function safeClassToken(value) {
  return String(value || 'none').replace(/[^a-z0-9_-]/gi, '-').slice(0, 40) || 'none';
}
// ========== 委派中心 → 已外迁 public/src/web/delegation-ui.js (window.PanelDelegation)（模块化第6批）==========

// #btnMcpNew 新建绑定 → 已迁回属主 public/src/web/mcp-ui.js boot()（模块化第13批）
// S18-3：data-close-mcp 全局绑定由 Modal event delegation 接管

// ========== v0.55 Sprint 13-D — 📈 时间线 → 已外迁 public/src/web/timeline-ui.js (window.PanelTimeline)（模块化第6批）==========

// 房详情区"📂 立即归档"#btnArchiveNow 绑定 → 已迁回属主 public/src/web/rooms-actions-ui.js boot()（模块化第13批；操作对象=当前活跃房间，归房间操作群）
// #btnWebhookNew 新建绑定 → 已迁回属主 public/src/web/webhook-ui.js boot()（模块化第13批）
// S18-3：data-close-webhook 全局绑定由 Modal event delegation 接管

// ========== composer 输入增强（textarea 自适应/划词浮层/topic 附件/展开收起）→ 已外迁 public/src/web/composer-ui.js (window.PanelComposer)（模块化第16批）==========

// ========== 全局 overlay 管理（Esc 逐层关 closeTopOverlay/focus-trap/modal-bg 点关/[data-cta] 入口）→ 已外迁 public/src/web/overlays-ui.js (window.PanelOverlays)（模块化第16批）==========

// ========== v0.56 U12/U3 inspector resize 拖动条 + 折叠 toggle + v0.70.2 debate-state log clear（内联 IIFE 双实现已删；逐行比对与 src/web/inspector.js 模块版语义等价——模块版为更干净超集：initDebateStateClear 独立拆出、querySelector≡$、返回值无消费方）→ 接线既有模块 public/src/web/inspector.js（main.js import 后正式调用 initInspector()；window.PanelInspector 暴露不变）（模块化第22批）==========

// 启动
renderOwnerTokenMissingBanner();
// 第17批外迁：listSessions 初拉 + 4s visibility-aware 轮询 + visibilitychange → 收进 sessions-core-ui.js boot()；
// showEmpty 初始空态 → 收进 sessions-list-ui.js boot()（均只执行/只起一次，防双轮询）
// v0.53 Sprint 3.5：建立 /ws/global 全局连接，接 health_warning 推送
ensureGlobalWs();
