// archive-ui.js — 聊天归档配置 UI（从 app.js 外迁；第2批）
// 依赖经 window.PanelCore/Modal 桥；setTimeout 延迟初始化。inline onclick 改走 window.PanelArchive.retry（全局可调）。
(function () {
  'use strict';
  function boot() {
    const { $, toast, escapeHtml, createPanelMirroredState } = window.PanelCore;
    const _Modal = window.Modal;

  // ========== v0.54 Sprint 4.5 — 📂 聊天归档配置 ==========
  // v0.84 真做 SSOT 第一步：archiveState 用 Proxy 包装，每次 set 自动镜像到 PanelStore
  const _archiveStateRaw = { config: null, list: [] };
  const archiveState = createPanelMirroredState('archive', _archiveStateRaw);

  // S18-3：改走 Modal 组件
  window.Modal?.register('archiveModal', {
    onOpen: async () => {
      await refreshArchiveConfig();
      renderArchiveModal();
      await refreshArchiveList();
      renderArchiveModal();   // 第二次渲染带上 list
    },
  });
  function openArchiveModal() { window.Modal.open('archiveModal'); }

  async function refreshArchiveConfig() {
    try {
      const resp = await fetch('/api/archive/config');
      if (!resp.ok) {
        archiveState.config = null;
        archiveState.loadError = `HTTP ${resp.status}（panel 端点不存在？检查 panel 版本是否最新；当前 panel 可能需要重启）`;
        return;
      }
      const r = await resp.json();
      archiveState.config = r.config || null;
      archiveState.loadError = null;
    } catch (e) {
      archiveState.config = null;
      archiveState.loadError = '网络或解析错误：' + e.message;
    }
  }

  async function refreshArchiveList() {
    try {
      const r = await fetch('/api/archive/list').then(x => x.json());
      archiveState.list = r.items || [];
    } catch { archiveState.list = []; }
  }

  function archiveTreePreview(cfg) {
    const sample = '搜索2-b31b9a35';
    const sampleB = '机房-abc12345';
    const t = cfg.timeFormat === 'YYYY-MM' ? '2026-05' : '2026-05-20';
    if (cfg.structure === 'flat') {
      return `${cfg.rootPath}/\n├── final-consensus.md\n├── full-transcript.md\n└── meta.json\n\n（所有房文件混在一起，按 room id 区分；不建议房多时用）`;
    }
    if (cfg.structure === 'room-then-time') {
      return `${cfg.rootPath}/\n├── ${sample}/\n│   ├── ${t}/\n│   │   ├── final-consensus.md\n│   │   ├── full-transcript.md\n│   │   └── meta.json\n│   └── 2026-05-19/...\n└── ${sampleB}/\n    └── ${t}/...`;
    }
    // time-then-room
    return `${cfg.rootPath}/\n├── ${t}/\n│   ├── ${sample}/\n│   │   ├── final-consensus.md\n│   │   ├── full-transcript.md\n│   │   └── meta.json\n│   └── ${sampleB}/...\n└── 2026-05-19/...`;
  }

  function renderArchiveModal() {
    const root = $('#archiveModalBody');
    if (!root) return;
    const cfg = archiveState.config;
    if (!cfg) {
      const err = archiveState.loadError || '未知错误';
      root.innerHTML = `<div class="muted small" style="padding:20px;line-height:1.6;">
        <p>❌ <b>归档配置加载失败</b></p>
        <p style="color:var(--color-danger-alt);font-family:ui-monospace,monospace;font-size:11px;">${escapeHtml(err)}</p>
        <p>常见原因：</p>
        <ol style="line-height:1.8;">
          <li>panel 版本太旧没归档端点 → 请重启 panel（终端跑 <code>kill -TERM $(lsof -iTCP:51835 -sTCP:LISTEN -t)</code> 后 <code>cd ~/Desktop/00_项目/05_Claude可视化面板 && nohup node server.js > /tmp/panel.log 2>&1 &</code>）</li>
          <li>配置文件损坏 → 删 <code>~/.noe-panel/archive-config.json</code> 让 panel 用默认</li>
          <li>panel 后端 crash → 看 <code>/tmp/panel*.log</code></li>
        </ol>
        <p><button class="cxbtn cxbtn-primary cxbtn-sm" onclick="window.PanelArchive?.retry()">↻ 重试</button></p>
      </div>`;
      return;
    }
    const list = archiveState.list || [];
    root.innerHTML = `
      <div class="archive-section">
        <div class="archive-section-title">🌳 全局归档根目录</div>
        <div class="archive-form-row">
          <label>rootPath（绝对路径，支持 ~/）</label>
          <input id="arRootPath" maxlength="1024" value="${escapeHtml(cfg.rootPath || '')}" placeholder="~/Documents/noe-archive" />
          <div class="help">所有房间完成后归档到这个目录下。沙箱限制：必须在 home 子树或 /tmp 内，不能命中 .ssh / .aws / Library/Keychains 等敏感目录。</div>
        </div>
        <div class="archive-form-row">
          <label>目录结构</label>
          <select id="arStructure">
            <option value="time-then-room" ${cfg.structure === 'time-then-room' ? 'selected' : ''}>按时间分类 → 房间名分类（推荐）</option>
            <option value="room-then-time" ${cfg.structure === 'room-then-time' ? 'selected' : ''}>按房间名分类 → 时间分类</option>
            <option value="flat" ${cfg.structure === 'flat' ? 'selected' : ''}>扁平（所有文件混在 rootPath 下）</option>
          </select>
        </div>
        <div class="archive-form-row">
          <label>时间格式</label>
          <select id="arTimeFormat">
            <option value="YYYY-MM-DD" ${cfg.timeFormat === 'YYYY-MM-DD' ? 'selected' : ''}>YYYY-MM-DD（每天一个目录）</option>
            <option value="YYYY-MM" ${cfg.timeFormat === 'YYYY-MM' ? 'selected' : ''}>YYYY-MM（每月一个目录）</option>
          </select>
        </div>
        <div class="archive-form-row">
          <label><input type="checkbox" id="arAutoArchive" ${cfg.autoArchive ? 'checked' : ''} /> 房完成后自动归档（建议开启）</label>
          <div class="help">关闭后只能手动 POST /api/archive/rooms/:id 触发，或在房详情区点"📂 立即归档"。</div>
        </div>
      </div>
      <div class="archive-section">
        <div class="archive-section-title">🌲 目录预览</div>
        <div class="archive-tree-preview" id="arTreePreview">${escapeHtml(archiveTreePreview(cfg))}</div>
      </div>
      <div class="archive-section">
        <div class="archive-section-title">📜 已归档房 (<span id="arListCount">${list.length}</span>)</div>
        <div id="arList">${
          list.length === 0
            ? '<div class="archive-list-empty">还没归档过任何房（开 autoArchive 后房完成时自动出现，或手动点立即归档）</div>'
            : list.slice(0, 20).map(it => {
                const modeLabel = ({ debate: '🗣 多模型辩论', squad: '👥 团队拆活', arena: '🏟 联网核对', chat: '💬 单聊' })[it.mode] || it.mode;
                return `<div class="archive-list-item">
                  <span class="mode">${modeLabel}</span>
                  <span class="name">${escapeHtml(it.name)}</span>
                  <span class="dir">${escapeHtml(it.dir)}</span>
                </div>`;
              }).join('') + (list.length > 20 ? `<div class="muted small">…还有 ${list.length - 20} 个</div>` : '')
        }</div>
      </div>
      <div class="archive-actions-row">
        <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-archive>取消</button>
        <button class="cxbtn cxbtn-primary" id="btnArchiveSave">💾 保存配置</button>
      </div>
    `;
    $('#btnArchiveSave')?.addEventListener('click', saveArchiveConfig);
    // 实时预览：改 rootPath/structure/timeFormat 时刷新树
    ['#arRootPath', '#arStructure', '#arTimeFormat'].forEach(sel => {
      $(sel)?.addEventListener('input', () => {
        const preview = $('#arTreePreview');
        if (preview) {
          const pseudo = {
            rootPath: $('#arRootPath').value || cfg.rootPath,
            structure: $('#arStructure').value,
            timeFormat: $('#arTimeFormat').value,
          };
          preview.textContent = archiveTreePreview(pseudo);
        }
      });
    });
    // S18-3：data-close-archive 由 Modal event delegation 接管，不再每次重绑
  }

  async function saveArchiveConfig() {
    const body = {
      rootPath: $('#arRootPath').value.trim(),
      structure: $('#arStructure').value,
      timeFormat: $('#arTimeFormat').value,
      autoArchive: $('#arAutoArchive').checked,
    };
    try {
      const r = await fetch('/api/archive/config', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(x => x.json());
      if (r.ok) {
        archiveState.config = r.config;
        toast('已保存配置', 'success', 1800);
        renderArchiveModal();
      } else {
        toast('保存失败：' + (r.error || 'unknown'), 'error', 5000);
      }
    } catch (e) { toast('保存失败：' + e.message, 'error'); }
  }

  $('#btnArchive')?.addEventListener('click', openArchiveModal);

    window.PanelArchive = { open: openArchiveModal, retry: async () => { await refreshArchiveConfig(); renderArchiveModal(); } };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else setTimeout(boot, 0);
})();
