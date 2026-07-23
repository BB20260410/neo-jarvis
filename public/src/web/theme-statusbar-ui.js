// @ts-check
// theme-statusbar-ui.js — v0.6 主题切换 + Claude 登录按钮 + StatusBar
// （applyTheme/toggleTheme/THEME_NAMES/updateStatusBar + #themeToggle/#btnLoginClaude 绑定 + 4s 兜底刷新
//  + v0.30/v0.46/v0.50 启动版本号拉取并入 boot——属主判断：写 #statusVersion/#brandSubtitle 是
//  StatusBar/品牌 UI，归本模块；main.js 保持纯入口不塞业务）
// （从 app.js 外迁；app.js 模块化第20批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
// 原 app.js 加载即执行副作用全收进 boot() 且只跑一次：恢复保存主题（幂等 class 写入）+
// setInterval(updateStatusBar, 4000) + 版本号 async 拉取，防双轮询/双拉。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, api, toast, confirmModal } = core;

    // ─── v0.6 主题切换 ─────
    function applyTheme(theme) {
      const html = document.documentElement;
      html.classList.remove('light', 'dark', 'scifi');
      if (theme === 'dark' || theme === 'light' || theme === 'scifi') html.classList.add(theme);
      // v0.51 U-08 fix: 隐私模式 / quota 超限时 localStorage 抛错，吞掉防整个 applyTheme 失败
      try { localStorage.setItem('cp-theme', theme); } catch {}
    }
    const THEME_NAMES = { light: '☀️ 明亮', dark: '🌙 暗色', scifi: '🛸 科幻' };
    function toggleTheme() {
      const cur = localStorage.getItem('cp-theme');
      // 循环：light → dark → scifi → light（呼应"多风格模式可选"）
      const next = cur === 'light' ? 'dark' : cur === 'dark' ? 'scifi' : cur === 'scifi' ? 'light' : 'dark';
      applyTheme(next);
      try { if (typeof toast === 'function') toast('主题切换 ' + (THEME_NAMES[next] || next), 'info'); } catch {}
    }
    // 原 app.js 加载即执行：恢复 localStorage 保存的主题（boot 只跑一次，幂等）
    (() => {
      const saved = localStorage.getItem('cp-theme');
      if (saved === 'dark' || saved === 'light' || saved === 'scifi') applyTheme(saved);
    })();
    $('#themeToggle')?.addEventListener('click', toggleTheme);

    // v0.14: 🔐 Claude 登录按钮
    $('#btnLoginClaude')?.addEventListener('click', async () => {
      const ok = await confirmModal({
        title: '在 Terminal 打开 claude /login？',
        message: '会启动 macOS Terminal 跑 `claude /login` 自动进入 OAuth 浏览器跳转。完成登录后关闭 Terminal 窗口回 panel。',
        confirmLabel: '🔐 开始登录',
      });
      if (!ok) return;
      try {
        const r = await api('/api/login-claude', { method: 'POST' });
        toast(r.message || '已开 Terminal 完成登录', 'info', 5000);
      } catch (e) {
        toast('启动登录失败: ' + e.message, 'error');
      }
    });

    // ─── v0.6 StatusBar 更新 ─────
    function updateStatusBar() {
      const active = core.state.sessions.length;
      const busy = core.state.sessions.filter(s => s.busy || s.runState === 'running' || s.runState === 'thinking').length;
      const archived = core.state.archivedSessions.length;
      const totalCost = core.state.sessions.reduce((s, x) => s + (x.totalUSD || 0), 0);
      $('#statusActive').textContent = `Claude 会话活跃 ${active}`;
      $('#statusBusy').textContent = `Claude 会话在跑 ${busy}`;
      $('#statusArchived').textContent = `归档 ${archived}`;
      $('#statusCost').textContent = `累计 $${totalCost.toFixed(3)}`;
      const sync = $('#statusSync');
      const dot = $('#statusDotSync');
      sync.textContent = `同步 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      dot.className = 'status-dot';
    }
    // updateStatusBar 已经在 listSessions 末尾自动调（经 PanelCore 桥懒转发）；额外 4s 兜底刷新一下时间显示
    setInterval(updateStatusBar, 4000);

    // v0.30 fix: 启动时拉动态版本号写到 brand-subtitle
    // v0.46: 同时刷 statusVersion（之前硬编码 v0.6）
    (async () => {
      try {
        const r = await api('/api/version');
        const sub = $('#brandSubtitle');
        if (sub && r.version) sub.textContent = `多会话管理 · v${r.version}`;
        const title = $('#brandTitle');
        if (title && r.appName) title.textContent = r.appName;
        const ver = $('#statusVersion');
        if (ver && r.version) ver.textContent = `v${r.version} · ⌘K 命令面板`;
        // v0.50 帮助 tab 也同步版本号
        const aboutVer = $('#aboutVersion');
        if (aboutVer && r.version) aboutVer.textContent = `v${r.version}`;
      } catch {}
    })();

    window.PanelTheme = {
      applyTheme,
      toggleTheme,
      updateStatusBar,
      THEME_NAMES,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
