// public/src/web/inspector.js — v0.80 真做拆模块第 2 个：inspector 控件
// 含 resize（左侧 5px 拖动）+ toggle（折叠/展开右栏）+ debate-state log clear
// S24 收尾批22：app.js 内联 IIFE 双实现已删，main.js 正式调用 initInspector()（唯一 init 点）并桥接 window.PanelInspector

/**
 * 初始化 inspector 拖动 resize 控件
 * 持久化宽度到 localStorage 'panel:inspectorW'
 */
export function initInspectorResize() {
  const resizer = document.querySelector('#inspectorResizer');
  if (!resizer) return null;
  const KEY = 'panel:inspectorW';
  const MIN = 220, MAX = 700, DEFAULT = 340;
  // 恢复持久化宽度
  const saved = parseInt(localStorage.getItem(KEY) || '0', 10);
  if (saved >= MIN && saved <= MAX) {
    document.documentElement.style.setProperty('--inspector-w', saved + 'px');
  }
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    e.preventDefault();
    dragging = true;
    resizer.classList.add('dragging');
    document.body.classList.add('inspector-dragging');
  });
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.min(MAX, Math.max(MIN, window.innerWidth - e.clientX));
    document.documentElement.style.setProperty('--inspector-w', w + 'px');
  });
  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('inspector-dragging');
    const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--inspector-w'), 10);
    if (w) localStorage.setItem(KEY, String(w));
  });
  resizer.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty('--inspector-w', DEFAULT + 'px');
    localStorage.setItem(KEY, String(DEFAULT));
  });
  return { MIN, MAX, DEFAULT };
}

/**
 * 初始化 inspector 折叠 toggle 按钮
 */
export function initInspectorToggle() {
  const btn = document.querySelector('#btnInspectorToggle');
  if (!btn) return null;
  const KEY = 'panel:inspectorHidden';
  // 用户手动点过 toggle 后置 1：之后右栏完全尊重用户选择，自动折叠模块不再干预
  const USER_KEY = 'panel:inspectorUserSet';
  const syncBtn = () => {
    const hidden = document.body.classList.contains('inspector-hidden');
    const icon = btn.querySelector('.nav-icon');
    if (icon) icon.textContent = hidden ? '⇤' : '⇥';
    else btn.textContent = hidden ? '⇤' : '⇥';
    btn.title = hidden ? '展开右侧 inspector 面板' : '折叠右侧 inspector 面板';
  };
  const apply = () => {
    // 仅当用户手动设置过才用持久化状态初始化；否则交给自动折叠模块（不在此读 LS，避免覆盖自动态）
    if (localStorage.getItem(USER_KEY) === '1') {
      const hidden = localStorage.getItem(KEY) === '1';
      document.body.classList.toggle('inspector-hidden', hidden);
    }
    syncBtn();
  };
  apply();
  btn.addEventListener('click', () => {
    const hidden = document.body.classList.contains('inspector-hidden');
    localStorage.setItem(KEY, hidden ? '0' : '1');
    // 标记用户已手动控制：自动折叠模块收到事件后停止干预
    localStorage.setItem(USER_KEY, '1');
    document.body.classList.toggle('inspector-hidden', !hidden);
    syncBtn();
    document.dispatchEvent(new CustomEvent('inspector:userset'));
  });
  return { apply, syncBtn };
}

/**
 * 空状态自动折叠 inspector（整合诉求：未选中会话时右栏 340px 纯噪音 → 默认折叠，主区变宽）。
 * 规则：
 *  - 用户从没手动点过 toggle（panel:inspectorUserSet ≠ '1'）时由本模块托管 inspector-hidden：
 *    · #sessionInfo 为空状态（— 未选中 — 或空）→ 自动折叠；
 *    · 选中会话有内容 → 自动展开。
 *  - 不写 panel:inspectorHidden（避免污染用户手动状态）；只切 inspector-hidden class。
 *  - 一旦收到 inspector:userset 事件（用户手动 toggle）→ 立即停手，永不再自动改。
 * @param {{ syncBtn?: () => void }} [toggleCtl] initInspectorToggle 的返回值，用于同步 toggle 图标
 */
export function initInspectorAutoCollapse(toggleCtl) {
  const USER_KEY = 'panel:inspectorUserSet';
  const info = document.querySelector('#sessionInfo');
  if (!info) return null;
  const syncBtn = toggleCtl?.syncBtn;
  let active = localStorage.getItem(USER_KEY) !== '1';
  // 空状态：占位文案（— 未选中 —）或纯空白
  const isEmpty = () => {
    const t = (info.textContent || '').replace(/\s+/g, '');
    return t === '' || t === '—未选中—';
  };
  const apply = () => {
    if (!active) return;
    document.body.classList.toggle('inspector-hidden', isEmpty());
    if (syncBtn) syncBtn();
  };
  apply(); // 首帧：空状态即折叠
  const observer = new MutationObserver(apply);
  observer.observe(info, { childList: true, characterData: true, subtree: true });
  document.addEventListener('inspector:userset', () => {
    active = false;
    observer.disconnect();
  }, { once: true });
  return { apply, isEmpty };
}

/**
 * 初始化 debate-state tab 的 clear 按钮（v0.70.2 W5+W6 配套）
 */
export function initDebateStateClear() {
  const btn = document.querySelector('#btnDebateStateClear');
  if (!btn) return;
  btn.addEventListener('click', () => {
    const log = document.querySelector('#debateStateLog');
    if (log) log.innerHTML = '<div class="muted small">— 等待 debate_state_meta WS 事件 —</div>';
  });
}

/**
 * 一次性初始化所有 inspector 控件
 */
export function initInspector() {
  initInspectorResize();
  const toggleCtl = initInspectorToggle();
  initInspectorAutoCollapse(toggleCtl);
  initDebateStateClear();
}
