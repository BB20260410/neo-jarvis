// @ts-check
// composer-ui.js — composer 输入增强：textarea 自适应增高 + 划词浮层 + topic 附件上传 + 展开/收起
// （从 app.js 外迁；app.js 模块化第16批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号（$/escapeHtml/toast 纯工具可解构）。
// 三个 init* 为一次性初始化（绑定监听），boot 只跑一次；暴露在 window.PanelComposer 仅供调试/测试，勿重复调用。
// document 级监听（selectionchange/mousedown/keydown-Esc 隐藏浮层）随迁进 boot：
// main.js 把本模块 import 在 rooms-debate-ui/search-ui 之前，保持外迁前「app.js 同步注册先于各模块 boot 注册」的相对顺序。
(function () {
  'use strict';
  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    const core = window.PanelCore;
    const { $, escapeHtml, toast } = core;

    // S19-2: 全局 textarea auto-resize（随内容增高，避免长文本只能滚动）
    function initAutoResize() {
      const TARGETS = ['#roomTopicInput', '#chatRoomInput', '#chatInput'];
      function fit(ta) {
        if (!ta) return;
        // 用 max-height 做硬上限，超过后转滚动
        const cs = getComputedStyle(ta);
        const maxH = parseInt(cs.maxHeight) || 600;
        ta.style.height = 'auto';
        const next = Math.min(maxH, ta.scrollHeight + 2);
        ta.style.height = next + 'px';
        ta.style.overflowY = ta.scrollHeight > maxH ? 'auto' : 'hidden';
      }
      TARGETS.forEach(sel => {
        const ta = $(sel);
        if (!ta) return;
        // 给 textarea 一个 max-height（避免无限增长撑爆 panel）
        if (!ta.style.maxHeight) ta.style.maxHeight = sel === '#roomTopicInput' ? '60vh' : '40vh';
        ta.addEventListener('input', () => fit(ta));
        // 初次设值后也 fit 一次
        setTimeout(() => fit(ta), 0);
        // 外部 JS 改 value 后请 dispatchEvent('input')，不再轮询 — 见 renderRoomDetail
      });
    }

    // B-004 v0.9: 选中文字浮层（学 Cherry Studio 划词助手）
    function initSelectionPopover() {
      if (typeof window === 'undefined') return;
      let popover = null;
      const MIN_LEN = 5;     // 最少选 5 字符
      const MAX_LEN = 4000;  // 超长不弹（防误触）

      function hide() {
        if (popover) { try { popover.remove(); } catch {} popover = null; }
      }

      function show(text, rect) {
        hide();
        popover = document.createElement('div');
        popover.className = 'selection-popover';
        popover.innerHTML = `
          <button data-act="explain" title="把选中文字作为 prompt 加到对话框 + 加'解释一下'前缀">🔍 解释</button>
          <button data-act="translate" title="翻译这段">🌐 翻译</button>
          <button data-act="rewrite" title="改写优化">✍️ 改写</button>
          <button data-act="to-input" title="加到当前输入框">📥 加到输入</button>
        `;
        // 定位在选中区右上方
        const top = Math.max(8, rect.top - 44);
        const left = Math.min(window.innerWidth - 280, Math.max(8, rect.right - 280));
        popover.style.top = top + 'px';
        popover.style.left = left + 'px';
        document.body.appendChild(popover);

        popover.querySelectorAll('button').forEach(btn => {
          btn.addEventListener('mousedown', (e) => e.preventDefault());  // 防失焦
          btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            applyAction(btn.dataset.act, text);
            hide();
          });
        });
      }

      function applyAction(act, text) {
        const prefixes = {
          explain: '请详细解释下面这段文字：\n\n',
          translate: '请把下面这段翻译成中文（如果已是中文则翻译成英文）：\n\n',
          rewrite: '请帮我改写下面这段，更通顺/精炼：\n\n',
          'to-input': '',
        };
        const prefix = prefixes[act] || '';
        const payload = prefix + text;
        // 优先找：聊天室 chat → chat input → topic
        const targets = ['#chatRoomInput', '#chatInput', '#roomTopicInput'];
        for (const sel of targets) {
          const ta = document.querySelector(sel);
          if (ta && ta.offsetParent !== null) {
            ta.value = (ta.value ? ta.value + '\n\n' : '') + payload;
            ta.dispatchEvent(new Event('input', { bubbles: true }));
            ta.focus();
            try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch {}
            if (typeof toast === 'function') toast(`✓ 已加到 ${sel.slice(1)}（${text.length} 字）`, 'success', 2000);
            return;
          }
        }
        if (typeof toast === 'function') toast('没找到可见输入框，请先打开一个房间', 'warn', 3000);
      }

      document.addEventListener('selectionchange', () => {
        const sel = document.getSelection();
        if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
          hide();
          return;
        }
        const text = sel.toString().trim();
        if (text.length < MIN_LEN || text.length > MAX_LEN) {
          hide();
          return;
        }
        // 不在 input/textarea/cmdk modal 内的选区才弹（防嵌套）
        const anchor = sel.anchorNode?.parentElement;
        if (!anchor) return;
        if (anchor.closest('input, textarea, .cmdk-modal, .confirm-modal, .selection-popover')) {
          hide();
          return;
        }
        const range = sel.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return;
        show(text, rect);
      });

      document.addEventListener('mousedown', (e) => {
        if (popover && !popover.contains(e.target)) hide();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') hide();
      });
    }

    // v0.56 S17-extra：topic textarea 附件上传（选文件 / 拖拽 / 粘贴）+ 实时字数统计
    function initTopicAttachments() {
      const ta = $('#roomTopicInput');
      const fileInput = $('#topicAttachFile');
      const btn = $('#btnTopicAttach');
      const list = $('#topicAttachList');
      const count = $('#topicCharCount');
      if (!ta || !fileInput || !btn || !list || !count) return;

      const MAX_TA = 1048576;            // 1MB cap (跟 maxlength 同)
      const PER_FILE_CAP = 800 * 1024;   // 单文件 800KB cap，防一次性塞爆
      const attached = []; // {name, size}

      const fmtSize = (b) => b < 1024 ? `${b}B` : b < 1024*1024 ? `${(b/1024).toFixed(1)}K` : `${(b/1024/1024).toFixed(2)}M`;

      function renderChips() {
        list.innerHTML = attached.map((a, i) => `
          <span class="attach-chip" title="${escapeHtml(a.name)} · ${fmtSize(a.size)}">
            <span class="attach-chip-name">${escapeHtml(a.name)}</span>
            <span class="muted small">${fmtSize(a.size)}</span>
            <button class="attach-chip-rm" data-idx="${i}" title="移除该附件（仅移除标签，已 append 的内容仍在 textarea）">×</button>
          </span>
        `).join('');
        list.querySelectorAll('.attach-chip-rm').forEach(b => b.addEventListener('click', (e) => {
          const idx = +e.target.dataset.idx;
          attached.splice(idx, 1);
          renderChips();
        }));
      }

      function updateCharCount() {
        const n = ta.value.length;
        count.textContent = n >= 1000 ? `${(n/1000).toFixed(1)}K 字 / 1M 上限` : `${n} 字`;
        count.classList.toggle('warn', n > 500000 && n < 950000);
        count.classList.toggle('danger', n >= 950000);
      }
      ta.addEventListener('input', updateCharCount);
      updateCharCount();

      async function ingestFiles(files) {
        for (const f of files) {
          if (f.size > PER_FILE_CAP) {
            toast(`${f.name} 太大（${fmtSize(f.size)} > 800KB），跳过`, 'warn', 4000);
            continue;
          }
          // 只读文本
          if (f.type && !f.type.startsWith('text/') && !/\.(txt|md|json|log|csv|xml|ya?ml|html?|s?css|js|ts|py|go|rs|java|c|cpp|h|swift|kt|sh|sql|diff|patch)$/i.test(f.name)) {
            toast(`${f.name} 不像文本（${f.type || 'no mime'}），跳过`, 'warn', 4000);
            continue;
          }
          try {
            const text = await f.text();
            const remaining = MAX_TA - ta.value.length - 100;
            if (remaining <= 0) {
              toast(`textarea 已满（1MB 上限），${f.name} 无法 append`, 'error', 4000);
              break;
            }
            const insert = text.length > remaining
              ? text.slice(0, remaining) + `\n…（${f.name} 已截断，超出 1MB 上限）`
              : text;
            const sep = ta.value && !ta.value.endsWith('\n') ? '\n\n' : '\n';
            ta.value += `${sep}--- 📎 附件：${f.name}（${fmtSize(f.size)}）---\n${insert}\n--- /附件 ---\n`;
            attached.push({ name: f.name, size: f.size });
            toast(`📎 已添加 ${f.name}`, 'success', 1800);
          } catch (e) {
            toast(`读取 ${f.name} 失败：${e.message}`, 'error', 4000);
          }
        }
        renderChips();
        updateCharCount();
      }

      btn.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', (e) => {
        ingestFiles([...e.target.files]);
        e.target.value = '';
      });

      // 拖拽
      ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.classList.add('dragover'); });
      ta.addEventListener('dragleave', () => ta.classList.remove('dragover'));
      ta.addEventListener('drop', (e) => {
        e.preventDefault();
        ta.classList.remove('dragover');
        const files = [...(e.dataTransfer?.files || [])];
        if (files.length) ingestFiles(files);
      });

      // 粘贴文件（如截图、复制的文件）
      ta.addEventListener('paste', (e) => {
        const files = [...(e.clipboardData?.files || [])];
        if (files.length) {
          e.preventDefault();
          ingestFiles(files);
        }
      });
    }

    initAutoResize();
    initSelectionPopover();
    initTopicAttachments();

    // v0.56 U6：topic textarea 展开/收起
    $('#btnTopicExpand')?.addEventListener('click', () => {
      const ta = $('#roomTopicInput');
      const btn = $('#btnTopicExpand');
      if (!ta) return;
      const expanded = ta.classList.toggle('is-expanded');
      document.body.classList.toggle('has-topic-expanded', expanded);
      btn.textContent = expanded ? '⤡ 收起' : '⤢ 展开';
      if (expanded) ta.focus();
    });

    // v0.56 U7：单 turn-card 展开/收起（事件委托到 #roomRounds）
    $('#roomRounds')?.addEventListener('click', (e) => {
      const btn = e.target.closest('.room-turn-expand');
      if (!btn) return;
      e.stopPropagation();
      const card = btn.closest('.room-turn-card');
      if (!card) return;
      const expanded = card.classList.toggle('is-expanded');
      document.body.classList.toggle('has-turn-expanded', expanded);
      btn.textContent = expanded ? '⤡' : '⤢';
      btn.title = expanded ? '收起' : '全屏展开看完整内容';
    });

    window.PanelComposer = {
      initAutoResize, initSelectionPopover, initTopicAttachments,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
