// Noe 全量双语引擎 —— 运行时翻译中文文本节点（零侵入 app.js 13k 行）
// en 模式：TreeWalker 翻译所有匹配字典的中文文本 + MutationObserver 捕获动态新增 + 翻译 placeholder/title/aria-label
// zh 模式：用 __origText / data-orig_* 无损恢复原中文
// 字典逐轮扩充（全量双语是 sprint，分多次补全各视图）。未收录的中文暂留原文，不会报错。
(function () {
  const DICT = {
    // ── 顶部品牌 / 侧栏 ──
    '多会话管理': 'Multi-Session Manager',
    '设置': 'Settings',
    '新建会话': 'New Session',
    '还没有活跃会话': 'No active sessions yet',
    '工作台': 'Workspace', '治理': 'Governance', '系统': 'System', '外观': 'Appearance',
    '认知': 'Cognition', '总览': 'Overview', '终端': 'Terminal', '房间': 'Rooms',
    '代码': 'Code', '知识': 'Knowledge', '审批': 'Approvals', '审计': 'Audit',
    '委派': 'Delegation', '自驾': 'Autopilot', '插件': 'Plugins', '模型': 'Models',
    '推送': 'Webhooks', '归档': 'Archive', '登录': 'Login', '主题': 'Theme', '右栏': 'Panel',
    // ── 欢迎页 ──
    '欢迎使用 Noe': 'Welcome to Noe',
    '选一个直接开始': 'Pick one to get started',
    '单模型聊天': 'Single-Model Chat',
    '多模型辩论': 'Multi-Model Debate',
    'AI 团队拆活': 'AI Team Breakdown',
    '联网核对': 'Web Fact-Check',
    '集群协同': 'Cluster Collaboration',
    '新建 Claude 会话': 'New Claude Session',
    '内嵌终端': 'Embedded Terminal',
    '1v1 持续对话': '1-on-1 continuous chat',
    '最简模式': 'Simplest mode',
    '提案 → 互评 → 共识': 'Propose → Critique → Consensus',
    '头脑风暴': 'Brainstorm',
    'PM 拆 → Dev → QA': 'PM split → Dev → QA',
    '项目落地': 'Ship projects',
    '多 AI + Judge 联网': 'Multi-AI + Judge online',
    '事实验证': 'Fact verification',
    '多模型互审': 'Multi-model cross-review',
    '一致才下一步': 'Consensus before next step',
    'PTY 跑 claude': 'PTY runs claude',
    'PTY 跑任意命令': 'PTY runs any command',
    'git/claude/等': 'git/claude/etc',
    '或键盘': 'Or keyboard',
    '命令面板': 'Command Palette',
    '看完整快捷键': 'View all shortcuts',
    // ── 状态栏 ──
    '同步': 'Sync', '会话活跃': 'sessions active', '会话在跑': 'sessions running',
    '运行中': 'Running', '房': 'rooms', '累计': 'Total', '快捷键': 'Shortcuts',
    // ── 右侧 inspector ──
    '信息': 'Info', '事实': 'Facts', '安全': 'Security', '项目': 'Project',
    '文件': 'Files', '帮助': 'Help', '未选中': 'Nothing selected', '— 未选中 —': '— Nothing selected —',
    // ── 认知界面 ──
    '感知 L1': 'Perception L1',
    '实时视频 · 你': 'Live Video · You',
    '此刻看到': 'Seeing now',
    '推理流 · L2 Reasoning': 'Reasoning · L2',
    '对 Noe 说点什么…': 'Say something to Noe…',
    '看': 'Look', '实时对话': 'Live Talk',
    '看屏幕': 'Watch screen', '看摄像头': 'Watch camera',
    '认知界面就绪': 'Cognitive surface ready',
    '主动陪伴：开': 'Proactive: On', '主动陪伴：关': 'Proactive: Off',
    '视频背景：开': 'Video BG: On', '视频背景：关': 'Video BG: Off',
    '多 AI 房间': 'Multi-AI Rooms', 'Noe Brain 仪表盘': 'Noe Brain Dashboard',
    '经典主面板（全部功能）': 'Classic Panel (all features)',
    '工作台 / 管理（回主面板）': 'Workspace / Admin (back to panel)',
    '视觉 / 主动': 'Vision / Proactive',
  };

  let lang = (function () { try { return localStorage.getItem('noe-lang') || 'zh'; } catch { return 'zh'; } })();
  const HAS_ZH = /[一-鿿]/;
  const ATTRS = ['placeholder', 'title', 'aria-label'];

  let SUB_KEYS = Object.keys(DICT).filter((k) => k.length >= 2).sort((a, b) => b.length - a.length);
  function rebuildSubKeys() { SUB_KEYS = Object.keys(DICT).filter((k) => k.length >= 2).sort((a, b) => b.length - a.length); }
  // 外置字典（agent 批量翻译的 605 条放 i18n-dict.json，避免 i18n.js 臃肿，可持续扩充）
  async function loadExtraDict() { try { const r = await fetch('/i18n-dict.json', { cache: 'no-store' }); if (r.ok) { const ex = await r.json(); Object.assign(DICT, ex); rebuildSubKeys(); } } catch {} }
  function tr(s) {
    const k = s.trim();
    if (!k || !HAS_ZH.test(k)) return null;
    if (DICT[k]) return s.replace(k, DICT[k]);
    // 子串替换：文本含字典词（≥2 字，长词优先避免短词抢匹配）则替换；单字词只整句匹配防误伤
    let out = s, hit = false;
    for (const zh of SUB_KEYS) { if (out.indexOf(zh) >= 0) { out = out.split(zh).join(DICT[zh]); hit = true; } }
    return hit ? out : null;
  }

  function transTextNode(node) {
    const orig = node.__o != null ? node.__o : node.textContent;
    const t = tr(orig);
    if (t != null) { if (node.__o == null) node.__o = node.textContent; node.textContent = t; }
  }

  function transAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (!v) continue;
      const t = tr(v);
      if (t != null) { const dk = 'data-i18n-o-' + a; if (!el.hasAttribute(dk)) el.setAttribute(dk, v); el.setAttribute(a, t); }
    }
  }

  function walk(root) {
    if (lang !== 'en' || !root) return;
    if (root.nodeType === 3) { transTextNode(root); return; }
    if (root.nodeType !== 1) return;
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const list = []; let n; while ((n = tw.nextNode())) list.push(n);
    for (const node of list) transTextNode(node);
    transAttrs(root);
    root.querySelectorAll && root.querySelectorAll('[placeholder],[title],[aria-label]').forEach(transAttrs);
  }

  function restore() {
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const list = []; let n; while ((n = tw.nextNode())) list.push(n);
    for (const node of list) if (node.__o != null) node.textContent = node.__o;
    for (const a of ATTRS) document.querySelectorAll('[data-i18n-o-' + a + ']').forEach((el) => { el.setAttribute(a, el.getAttribute('data-i18n-o-' + a)); });
  }

  let observer = null, pending = [], scheduled = false;
  function flush() {
    scheduled = false;
    if (lang !== 'en') { pending = []; return; }
    const batch = pending; pending = [];
    if (observer) observer.disconnect();              // 处理时断开，避免 walk 改 DOM 自触发
    for (const node of batch) { try { walk(node); } catch {} }
    if (observer && lang === 'en') observer.observe(document.body, { childList: true, subtree: true });
  }
  function startObserver() {
    if (!observer) observer = new MutationObserver((muts) => {
      for (const m of muts) for (const node of m.addedNodes) if (node.nodeType === 1 || node.nodeType === 3) pending.push(node);
      if (pending.length && !scheduled) { scheduled = true; requestAnimationFrame(flush); }
    });
    observer.observe(document.body, { childList: true, subtree: true });   // 仅 childList，不监听 characterData
  }

  // 异步增量翻译整个 body：TreeWalker 边走边译，每帧只占 8ms，绝不阻塞主线程（主面板 DOM 巨大）
  function walkAsyncBody() {
    if (lang !== 'en') return;
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    function chunk() {
      if (lang !== 'en') return;
      const t0 = performance.now(); let node = null;
      while (performance.now() - t0 < 8 && (node = tw.nextNode())) transTextNode(node);
      if (node) requestAnimationFrame(chunk);
      else { try { document.body.querySelectorAll('[placeholder],[title],[aria-label]').forEach(transAttrs); } catch {} }
    }
    requestAnimationFrame(chunk);
  }
  function setLang(l) {
    lang = l === 'en' ? 'en' : 'zh';
    try { localStorage.setItem('noe-lang', lang); } catch {}
    // 不改 document.lang：设 lang=en 会误导浏览器自动翻译把英文 Noe/Claude 反翻成中文
    if (lang === 'en') { walkAsyncBody(); startObserver(); }
    else { restore(); }
    const btn = document.getElementById('langToggle'); if (btn) btn.textContent = lang === 'en' ? '🌐 中' : '🌐 EN';
  }

  function injectToggle() {
    if (document.getElementById('langToggle')) return;
    const btn = document.createElement('button');
    btn.id = 'langToggle';
    btn.type = 'button';
    btn.textContent = lang === 'en' ? '🌐 中' : '🌐 EN';
    btn.title = '切换中文 / English';
    btn.style.cssText = 'position:fixed;left:14px;bottom:12px;z-index:9999;padding:5px 12px;border-radius:16px;border:1px solid rgba(140,170,205,.35);background:rgba(20,32,48,.72);color:#cfe0f0;font-size:12px;font-family:ui-monospace,monospace;cursor:pointer;backdrop-filter:blur(8px);transition:opacity .2s';
    btn.addEventListener('mouseenter', () => { btn.style.opacity = '.8'; });
    btn.addEventListener('mouseleave', () => { btn.style.opacity = '1'; });
    btn.addEventListener('click', () => setLang(lang === 'en' ? 'zh' : 'en'));
    document.body.appendChild(btn);
  }

  window.NoeI18n = { get lang() { return lang; }, setLang, toggle() { setLang(lang === 'en' ? 'zh' : 'en'); }, DICT, t: (s) => { const t = tr(s); return t == null ? s : t; } };

  async function boot() { try { document.documentElement.setAttribute('translate', 'no'); document.documentElement.classList.add('notranslate'); } catch {} await loadExtraDict(); injectToggle(); if (lang === 'en') setLang('en'); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
