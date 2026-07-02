// @ts-check
// term-ui.js — v0.23 内嵌真终端 PTY + xterm.js（termState/showTermArea/hideTermArea/openTerm/getXtermTheme/closeTerm
// + #btnTerminal/#btnTermNew/#btnTermInCwd/#btnTermClose/#btnTermBack 绑定）
// （从 app.js 外迁；app.js 模块化第20批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// CDN 全局依赖保持：window.Terminal / window.FitAddon（xterm.js）+ window.createPlainTerminal 降级兜底。
// 跨文件依赖全走 window 懒解析：handleApprovalRequired（PanelApprovals）。
// 注：代码块复制/折叠 document 委托不随迁——按钮由 renderMarkdown 生成，属主=markdown 区（批21）。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, api, toast, shortenPath, wsUrl } = core;

    const termState = {
      termId: null,
      ws: null,
      xterm: null,
      fitAddon: null,
      resizeObserver: null,
    };

    function showTermArea() {
      $('#mainHeader').style.display = 'none';
      $('#chatArea').style.display = 'none';
      $('#roomArea').style.display = 'none';
      $('#pluginArea').style.display = 'none';
      const ov = $('#overviewArea'); if (ov) ov.style.display = 'none';
      $('#termArea').style.display = 'flex';
    }

    function hideTermArea() {
      $('#termArea').style.display = 'none';
      if (core.state.activeId) {
        $('#chatArea').style.display = 'flex';
      } else {
        $('#mainHeader').style.display = 'flex';
      }
    }

    async function openTerm(cwd) {
      showTermArea();
      if (termState.termId) {
        // 关闭旧 term
        await closeTerm();
      }
      const container = $('#termContainer');
      container.innerHTML = '';
      try {
        const r = await api('/api/term', {
          method: 'POST',
          body: JSON.stringify({ cwd: cwd || null, cols: 100, rows: 30 }),
        });
        termState.termId = r.termId;
        $('#termMeta').textContent = `pid ${r.pid} · ${shortenPath(r.cwd)} · ${r.shell.split('/').pop()}`;
        $('#btnTermClose').style.display = 'inline-flex';

        const hasXterm = typeof window.Terminal === 'function' && typeof window.FitAddon?.FitAddon === 'function';
        const xterm = hasXterm ? new window.Terminal({
          cursorBlink: true,
          fontFamily: '"SF Mono", Menlo, monospace',
          fontSize: 13,
          theme: getXtermTheme(),
          scrollback: 2000,
          convertEol: false,
        }) : window.createPlainTerminal?.(container);
        if (!xterm) throw new Error('终端前端库未加载');
        let fitAddon = null;
        if (hasXterm) {
          fitAddon = new window.FitAddon.FitAddon();
          xterm.loadAddon(fitAddon);
          xterm.open(container);
          fitAddon.fit();
        }
        xterm.focus();
        termState.xterm = xterm;
        termState.fitAddon = fitAddon;

        // 连 WS
        const ws = new WebSocket(wsUrl(`/ws/term/${r.termId}`));
        termState.ws = ws;
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === 'data') xterm.write(msg.data);
            else if (msg.type === 'approval_required') {
              window.PanelApprovals?.handleApprovalRequired?.(msg);
            } else if (msg.type === 'exit') {
              xterm.write(`\r\n\x1b[33m[终端退出 code=${msg.exitCode}]\x1b[0m\r\n`);
              $('#termMeta').textContent = `已退出 (code ${msg.exitCode})`;
              termState.termId = null;
            }
          } catch {}
        };
        ws.onopen = () => {
          // 立即发一次 resize 给服务端，让 PTY 大小跟 xterm 对齐
          const cols = xterm.cols, rows = xterm.rows;
          try { ws.send(JSON.stringify({ type: 'resize', cols, rows })); } catch {}
        };
        xterm.onData(d => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: d }));
        });
        xterm.onResize(({ cols, rows }) => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'resize', cols, rows }));
        });

        // 容器 resize 自动 fit
        if (termState.resizeObserver) termState.resizeObserver.disconnect();
        termState.resizeObserver = new ResizeObserver(() => { try { fitAddon?.fit?.(); } catch {} });
        termState.resizeObserver.observe(container);

        toast('终端已打开 · 跑 `claude` 试试 TUI 模式', 'success', 3500);
      } catch (e) {
        toast('开终端失败: ' + e.message, 'error');
        $('#termMeta').textContent = '失败';
      }
    }

    function getXtermTheme() {
      const isDark = document.documentElement.classList.contains('dark') ||
        (!document.documentElement.classList.contains('light') && window.matchMedia('(prefers-color-scheme: dark)').matches);
      return isDark ? {
        background: '#0d0e14', foreground: '#e5e2db', cursor: '#C15F3C', selectionBackground: '#3a3733',
        black: '#181818', red: '#b3322f', green: '#138a36', yellow: '#d97706',
        blue: '#339cff', magenta: '#7c3aed', cyan: '#06b6d4', white: '#afafaf',
      } : {
        background: '#F8F6F2', foreground: '#2D2D2D', cursor: '#C15F3C', selectionBackground: '#e8e3d8',
        black: '#0d0d0d', red: '#b3322f', green: '#138a36', yellow: '#d97706',
        blue: '#0285ff', magenta: '#7c3aed', cyan: '#06b6d4', white: '#5d5d5d',
      };
    }

    async function closeTerm() {
      if (termState.ws) { try { termState.ws.close(); } catch {} }
      if (termState.termId) {
        try { await api(`/api/term/${termState.termId}`, { method: 'DELETE' }); } catch {}
      }
      if (termState.xterm) { try { termState.xterm.dispose(); } catch {} }
      if (termState.resizeObserver) { try { termState.resizeObserver.disconnect(); } catch {} }
      termState.termId = null;
      termState.ws = null;
      termState.xterm = null;
      termState.fitAddon = null;
      termState.resizeObserver = null;
      $('#termContainer').innerHTML = '';
      $('#btnTermClose').style.display = 'none';
      $('#termMeta').textContent = '未打开';
    }

    $('#btnTerminal')?.addEventListener('click', () => {
      if (termState.termId) {
        showTermArea(); // 已开就切回显示
      } else {
        openTerm(null);
      }
    });
    $('#btnTermNew')?.addEventListener('click', () => openTerm(null));
    $('#btnTermInCwd')?.addEventListener('click', () => openTerm(core.state.activeCwd || null));
    $('#btnTermClose')?.addEventListener('click', async () => {
      await closeTerm();
      toast('终端已关闭', 'info', 1500);
    });
    $('#btnTermBack')?.addEventListener('click', hideTermArea);

    window.PanelTerm = {
      showTermArea,
      hideTermArea,
      openTerm,
      closeTerm,
      getXtermTheme,
      termState,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
