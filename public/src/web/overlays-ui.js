// @ts-check
// overlays-ui.js — 全局 overlay 管理：Esc 逐层关 + a11y focus-trap + modal-bg 点关 + 欢迎页 [data-cta] 入口
// （从 app.js 外迁；app.js 模块化第16批 2026-06-11）
// 依赖经 window.PanelCore 桥取 $；window.Modal 调用时懒取（IIFE 组件，classic script 先于本 module 加载）。
//
// ⚠️ Esc 注册顺序契约（外迁前后等价性，e2e walkthrough 把关）：
// - 全部监听都挂 document 冒泡段（与外迁前一致，不改捕获段）；本页无任何 window 级 keydown 监听，
//   Esc 命中时的 e.stopPropagation() 只拦 document→window 冒泡，不影响 document 同节点其余监听（≠stopImmediatePropagation）。
// - 同节点监听按注册序触发，且各 Esc 处理器都按「当下 DOM 状态」自查（关过的层不会被重复处理），
//   顺序唯一可观测的影响是「叠层同开时一次 Esc 关几层」：外迁前 closeTopOverlay 同步注册，
//   先于 rooms-debate-ui/search-ui 的 boot 注册；外迁后靠 main.js 把本模块 import 在它们之前保持同序
//   （module boot 均为 setTimeout(boot,0)，FIFO=import 顺序）。app.js 留守的同步 Esc 监听
//   （右键菜单/busy 中断/project/history/newModal）本就先于 closeTopOverlay，留守后依旧先于本模块，等价。
// - Modal 组件的 trapHandler（只管 Tab）在 modal open() 时才注册，永远晚于本模块 boot，相对顺序不变。
(function () {
  'use strict';
  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    const core = window.PanelCore;
    const { $ } = core;

    // v0.56 U7+S17-3：ESC 按"最上一层"顺序逐层关（confirmModal > 普通 modal > 展开态 > drawer）
    function closeTopOverlay() {
      // 1. confirmModal / promptModal（动态 append，layer 最高）
      const confirms = [...document.querySelectorAll('.confirm-modal:not(.confirm-modal-closing)')];
      if (confirms.length) {
        const top = confirms[confirms.length - 1];
        // 优先点 cancel 走正常 finish(null) 路径（会 resolve Promise 给调用方）
        const cancel = top.querySelector('[data-act="cancel"]');
        if (cancel) cancel.click(); else top.remove();
        return true;
      }
      // 2. cmdk-modal（display:flex）
      const cmdkOpen = [...document.querySelectorAll('.cmdk-modal')].filter(m => m.style.display === 'flex');
      if (cmdkOpen.length) {
        cmdkOpen[cmdkOpen.length - 1].style.display = 'none';
        return true;
      }
      // 3. 普通 modal
      const modalOpen = [...document.querySelectorAll('.modal')].filter(m => m.style.display === 'flex');
      if (modalOpen.length) {
        const top = modalOpen[modalOpen.length - 1];
        // S18-3：Modal 注册过的走 Modal.close（触发 onClose hook + detach focus trap + 清 openStack）
        if (top.id && window.Modal && window.Modal.isManaged(top.id)) {
          window.Modal.close(top.id);
        } else {
          top.style.display = 'none';
        }
        return true;
      }
      // 4. turn-card 全屏展开
      const expCard = document.querySelector('.room-turn-card.is-expanded');
      if (expCard) {
        expCard.classList.remove('is-expanded');
        const btn = expCard.querySelector('.room-turn-expand');
        if (btn) { btn.textContent = '⤢'; btn.title = '全屏展开看完整内容'; }
        document.body.classList.remove('has-turn-expanded');
        return true;
      }
      // 5. topic textarea 全屏展开
      const ta = $('#roomTopicInput');
      if (ta?.classList.contains('is-expanded')) {
        ta.classList.remove('is-expanded');
        document.body.classList.remove('has-topic-expanded');
        const tb = $('#btnTopicExpand'); if (tb) tb.textContent = '⤢ 展开';
        return true;
      }
      // 6. drawer / overlay
      const drawer = document.querySelector('.squad-task-detail-overlay.open, .drawer.open, [data-overlay-open="1"]');
      if (drawer) {
        drawer.classList.remove('open');
        drawer.removeAttribute('data-overlay-open');
        return true;
      }
      return false;
    }
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (closeTopOverlay()) e.stopPropagation();
    });

    // a11y focus-trap：modal 打开时把 Tab 焦点限制在最上层 modal 内（键盘用户不会 Tab 到背景）。
    // 仅在有 .modal display:flex 时介入、仅处理 Tab；其余按键/无 modal 时完全不干预。
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const open = [...document.querySelectorAll('.modal')].filter(m => m.style.display === 'flex');
      if (!open.length) return;
      const modal = open[open.length - 1]; // 最上层
      const focusables = [...modal.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      )].filter(el => el.offsetParent !== null || el === document.activeElement); // 可见的
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      // 焦点不在本 modal 内 → 拉回首个；否则在首/尾按 Tab/Shift+Tab 时回绕
      if (!modal.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      }
    });

    // v0.56 U9+S17-4：点 modal-bg 关 modal，但要 mousedown + mouseup 都在 bg 上才算
    // 避免用户在 modal 内拖选文本，鼠标抬起在 bg 上时误关
    let _bgMouseDownTarget = null;
    document.addEventListener('mousedown', (e) => {
      _bgMouseDownTarget = e.target.classList?.contains('modal-bg') ? e.target : null;
    });
    document.addEventListener('mouseup', (e) => {
      const t = _bgMouseDownTarget;
      _bgMouseDownTarget = null;
      if (!t || e.target !== t) return;
      const modal = t.closest('.modal');
      if (!modal) return;
      // S18-3：注册过 Modal 的走 Modal.close 触发 onClose hook（state 复位/focus 归位）
      if (modal.id && window.Modal && window.Modal.isManaged(modal.id)) {
        window.Modal.close(modal.id);
      } else {
        modal.style.display = 'none';
      }
    });

    // v0.56 U13：欢迎页任务入口 — 点击直接进入对应流程
    document.querySelectorAll('[data-cta]').forEach(btn => {
      btn.addEventListener('click', () => {
        const cta = btn.dataset.cta;
        if (cta === 'cognitive') { window.location.href = '/cognitive.html'; return; }
        if (cta === 'new-session') { $('#btnNew')?.click(); return; }
        if (cta === 'terminal')    { $('#btnTerminal')?.click(); return; }
        if (cta.startsWith('rooms-')) {
          const mode = cta.slice(6); // chat/debate/squad/arena
          $('#btnRooms')?.click();
          const targetBtn = ({
            chat: '#btnRoomNewChat',
            debate: '#btnRoomNewDebate',
            squad: '#btnRoomNewSquad',
            arena: '#btnRoomNewArena',
            cv: '#btnRoomNewCv',
          })[mode];
          if (targetBtn) requestAnimationFrame(() => $(targetBtn)?.click());
        }
      });
    });

    window.PanelOverlays = {
      closeTopOverlay,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
