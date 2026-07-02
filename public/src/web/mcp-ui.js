// mcp-ui.js — MCP 服务器配置 UI（从 app.js 外迁；第2批最后一区）
// 依赖经 window.PanelCore/PanelDialog/Modal/UI 桥；setTimeout 延迟初始化避时序bug。
(function () {
  'use strict';
  function boot() {
    const { $, toast, escapeHtml, requestWithApproval, handleApprovalFlow } = window.PanelCore;
    const { confirmModal } = window.PanelDialog;
    const _Modal = window.Modal, _UI = window.UI;

  const mcpState = { list: [], status: {}, activeName: null, isNew: false };

  // S18-3：改走 Modal 组件
  window.Modal?.register('mcpModal', {
    onOpen: () => refreshMcpList(),
    onClose: () => { mcpState.activeName = null; mcpState.isNew = false; },
  });
  function openMcpModal() { window.Modal.open('mcpModal'); }

  // v0.70.3-t4: MCP 调用历史按钮（W7 接入可见）
  document.addEventListener('click', async (e) => {
    if (e.target?.id !== 'btnMcpCallHistory') return;
    try {
      const r = await fetch('/api/mcp/call-history?limit=50').then(x => x.json());
      if (!r.ok) { toast('拉历史失败：' + (r.error || ''), 'error'); return; }
      const calls = r.calls || [];
      if (calls.length === 0) {
        await confirmModal({ title: '📜 MCP 调用历史', message: '当前无调用记录。\n触发任何 MCP tool（在房间内 / autopilot / squad）后这里会出现 jsonl 日志。', confirmLabel: '关闭', cancelLabel: '' });
        return;
      }
      const lines = calls.slice(-30).reverse().map(c =>
        `${c.at?.slice(11, 19) || '?'} · ${c.serverId}.${c.toolName} · ${c.durationMs}ms · ${c.success ? '✓' : '✗ ' + (c.error || '')}`
      ).join('\n');
      await confirmModal({
        title: `📜 MCP 调用历史（最近 ${calls.length}）`,
        message: lines,
        confirmLabel: '关闭', cancelLabel: '',
      });
    } catch (e) { toast('异常：' + e.message, 'error'); }
  });

  async function refreshMcpList() {
    try {
      const r = await fetch('/api/mcp/servers').then(x => x.json());
      mcpState.list = r.servers || [];
      mcpState.status = r.status || {};
    } catch (e) {
      mcpState.list = [];
      toast('加载 MCP 列表失败：' + e.message, 'error');
    }
    renderMcpList();
    if (mcpState.activeName) {
      const e = mcpState.list.find(s => s.name === mcpState.activeName);
      if (e) renderMcpDetail(e);
      else { mcpState.activeName = null; renderMcpEmpty(); }
    } else if (!mcpState.isNew) {
      renderMcpEmpty();
    }
  }

  function renderMcpList() {
    const root = $('#mcpList');
    const count = $('#mcpCount');
    if (count) count.textContent = String(mcpState.list.length);
    if (!root) return;
    if (mcpState.list.length === 0) {
      root.innerHTML = window.UI.EmptyState({ kind: 'empty', text: '还没配 MCP server · 点 ＋ 新建', padding: '12px 4px' });
      return;
    }
    root.innerHTML = mcpState.list.map(s => {
      const active = mcpState.activeName === s.name ? ' active' : '';
      const disabled = s.enabled === false ? window.UI.Badge({ text: '已禁用', kind: 'disabled' }) : '';
      const typeBadge = window.UI.Badge({ text: s.type, kind: s.type });
      const desc = s.type === 'stdio'
        ? `${escapeHtml(s.command)} ${escapeHtml((s.args || []).join(' '))}`
        : escapeHtml(s.url || '');
      const st = mcpState.status[s.name];
      let statusLine = '<span class="mstatus">未连接</span>';
      if (st) {
        if (st.connected) statusLine = `<span class="mstatus"><span class="ok">● 已连接</span>${st.toolsCount != null ? ' · ' + st.toolsCount + ' tools' : ''}</span>`;
        else if (st.lastError) statusLine = `<span class="mstatus"><span class="err">● 连接失败</span> ${escapeHtml(st.lastError.slice(0, 40))}</span>`;
      }
      return `<div class="mcp-item${active}" data-name="${escapeHtml(s.name)}">
        <div class="mname">${escapeHtml(s.name)} ${typeBadge}${disabled}</div>
        <div class="mdesc">${desc}</div>
        ${statusLine}
      </div>`;
    }).join('');
    root.querySelectorAll('.mcp-item').forEach(el => {
      el.addEventListener('click', () => {
        mcpState.activeName = el.dataset.name;
        mcpState.isNew = false;
        const e = mcpState.list.find(s => s.name === mcpState.activeName);
        if (e) { renderMcpList(); renderMcpDetail(e); }
      });
    });
  }

  function renderMcpEmpty() {
    $('#mcpDetail').innerHTML = `
      <div class="muted small" style="padding:20px;">
        <p><b>MCP（Model Context Protocol）</b>让你给 AI 房成员挂载外部 tool。比如 filesystem server 让 Claude 读文件、playwright server 让 AI 跑浏览器、github server 让 AI 操作 PR。</p>
        <p>配置好后 Claude spawn adapter 自动启用（CLI 原生 <code>--mcp-config</code>）；Codex / Gemini CLI / HTTP adapter 待后续。</p>
        <p>常见公开 server：<code>npx -y @modelcontextprotocol/server-everything</code>（演示）/ <code>server-filesystem</code>（带路径） / <code>server-puppeteer</code>。</p>
      </div>
    `;
  }

  function renderMcpDetail(s) {
    const isNew = mcpState.isNew;
    const t = s.type || 'stdio';
    const args = (s.args || []).join(' ');
    const envJson = s.env && Object.keys(s.env).length > 0 ? JSON.stringify(s.env, null, 2) : '';
    const headersJson = s.headers && Object.keys(s.headers).length > 0 ? JSON.stringify(s.headers, null, 2) : '';
    const stdioFields = t === 'stdio' ? `
      <div class="mcp-form-row">
        <label>command（绝对路径或 PATH 内可执行）</label>
        <input id="mcpCommand" maxlength="256" placeholder="npx / node / /usr/local/bin/uv" value="${escapeHtml(s.command || '')}" />
        <div class="help">禁止含空格 / 元字符 ($ ; & | 等) / 危险命令（rm/curl/sudo/wget）</div>
      </div>
      <div class="mcp-form-row">
        <label>args（空格分隔；JSON 数组也行）</label>
        <input id="mcpArgs" maxlength="2048" placeholder="-y @modelcontextprotocol/server-filesystem ~/Desktop" value="${escapeHtml(args)}" />
      </div>
      <div class="mcp-form-row">
        <label>env（JSON 对象，仅 [A-Z_] 键名）</label>
        <textarea id="mcpEnv" placeholder='{"DEBUG":"*","API_TOKEN":"..."}'>${escapeHtml(envJson)}</textarea>
        <div class="help">含 KEY/TOKEN/SECRET/PASSWORD 的值在列表中会自动掩码显示</div>
      </div>
    ` : '';
    const httpFields = t === 'sse' || t === 'http' ? `
      <div class="mcp-form-row">
        <label>URL</label>
        <input id="mcpUrl" maxlength="2048" placeholder="https://api.example.com/mcp 或 http://localhost:3000/mcp" value="${escapeHtml(s.url || '')}" />
        <div class="help">必须 https:// 或 http://localhost</div>
      </div>
      <div class="mcp-form-row">
        <label>headers（JSON 对象，可空）</label>
        <textarea id="mcpHeaders" placeholder='{"Authorization":"Bearer ..."}'>${escapeHtml(headersJson)}</textarea>
      </div>
    ` : '';

    $('#mcpDetail').innerHTML = `
      <div class="mcp-form-row">
        <label>name（唯一，只能字母数字 _ . -）</label>
        <input id="mcpName" maxlength="64" placeholder="如 filesystem / github / playwright" value="${escapeHtml(s.name || '')}" ${isNew ? '' : 'disabled'} />
        ${isNew ? '' : '<div class="help">name 创建后不可改；如需改名请删了重建</div>'}
      </div>
      <div class="mcp-form-row">
        <label>type</label>
        <select id="mcpType">
          <option value="stdio" ${t === 'stdio' ? 'selected' : ''}>stdio（最常见，本地 spawn 子进程）</option>
          <option value="sse" ${t === 'sse' ? 'selected' : ''}>sse（远程 Server-Sent Events）</option>
          <option value="http" ${t === 'http' ? 'selected' : ''}>http（远程 Streamable HTTP）</option>
        </select>
      </div>
      ${stdioFields}
      ${httpFields}
      <div class="mcp-form-row">
        <label><input type="checkbox" id="mcpEnabled" ${s.enabled !== false ? 'checked' : ''} /> 启用（Claude spawn 时自动注入此 server）</label>
      </div>
      <div id="mcpToolsArea"></div>
      <div class="mcp-form-actions">
        ${isNew ? '' : '<button class="cxbtn cxbtn-danger cxbtn-sm left-grow" id="btnMcpDelete">🗑 删除</button>'}
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnMcpTest" ${isNew ? 'disabled title="先保存才能测试"' : ''}>🧪 测试连接 + 列工具</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnMcpResources" ${isNew ? 'disabled title="先保存才能查看"' : ''}>📂 查看 Resources</button>
        <button class="cxbtn cxbtn-secondary cxbtn-sm" id="btnMcpPrompts" ${isNew ? 'disabled title="先保存才能查看"' : ''}>💬 查看 Prompts</button>
        <button class="cxbtn cxbtn-tertiary cxbtn-sm" data-close-mcp>取消</button>
        <button class="cxbtn cxbtn-primary" id="btnMcpSave">${isNew ? '✓ 创建' : '💾 保存'}</button>
      </div>
    `;
    // type 切换时刷新字段
    $('#mcpType')?.addEventListener('change', (e) => {
      const newT = e.target.value;
      const merged = { ...s, type: newT };
      renderMcpDetail(merged);
    });
    $('#btnMcpSave')?.addEventListener('click', () => saveMcp(isNew ? null : s.name));
    $('#btnMcpTest')?.addEventListener('click', () => testMcp(s.name));
    $('#btnMcpDelete')?.addEventListener('click', () => deleteMcp(s.name));
    // B-013: MCP resources / prompts 查看
    $('#btnMcpResources')?.addEventListener('click', () => viewMcpResources(s.name));
    $('#btnMcpPrompts')?.addEventListener('click', () => viewMcpPrompts(s.name));
    // S18-3：data-close-mcp 由 Modal event delegation 接管，不再每次重绑
  }

  function collectMcpFromForm() {
    const body = {
      name: $('#mcpName')?.value?.trim() || '',
      type: $('#mcpType')?.value || 'stdio',
      enabled: $('#mcpEnabled')?.checked,
    };
    if (body.type === 'stdio') {
      body.command = ($('#mcpCommand')?.value || '').trim();
      // args 支持空格分隔 或 JSON 数组
      const argsRaw = ($('#mcpArgs')?.value || '').trim();
      if (argsRaw.startsWith('[')) {
        try { body.args = JSON.parse(argsRaw); } catch { throw new Error('args JSON 解析失败'); }
      } else {
        body.args = argsRaw ? argsRaw.match(/("[^"]*"|'[^']*'|\S+)/g)?.map(s => s.replace(/^["']|["']$/g, '')) || [] : [];
      }
      const envRaw = ($('#mcpEnv')?.value || '').trim();
      body.env = envRaw ? (() => { try { return JSON.parse(envRaw); } catch { throw new Error('env JSON 解析失败'); } })() : {};
    } else {
      body.url = ($('#mcpUrl')?.value || '').trim();
      const headersRaw = ($('#mcpHeaders')?.value || '').trim();
      body.headers = headersRaw ? (() => { try { return JSON.parse(headersRaw); } catch { throw new Error('headers JSON 解析失败'); } })() : {};
    }
    return body;
  }

  async function saveMcp(nameOrNull) {
    let body;
    try { body = collectMcpFromForm(); }
    catch (e) { toast(e.message, 'error'); return; }
    const isNew = !nameOrNull;
    const path = isNew ? '/api/mcp/servers' : `/api/mcp/servers/${encodeURIComponent(nameOrNull)}`;
    const opts = { method: isNew ? 'POST' : 'PUT', body: JSON.stringify(body) };
    const onSaved = async (label, r) => {
      toast(label, 'success', 1800);
      mcpState.isNew = false;
      mcpState.activeName = r?.server?.name || mcpState.activeName;
      await refreshMcpList();
    };
    const result = await requestWithApproval(path, opts);
    await handleApprovalFlow(result, path, opts, {
      actionLabel: isNew ? '创建 MCP server' : '更新 MCP server',
      onOk: async (r) => { await onSaved(isNew ? '已创建' : '已保存', r.body); },
      onError: (r) => toast('保存失败：' + (r.error || 'unknown'), 'error'),
    });
  }

  // B-013 v0.9：MCP resources 查看（goose-style "MCP 一等公民"）
  async function viewMcpResources(name) {
    try {
      const r = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/resources`).then(x => x.json());
      if (!r.ok) { toast('拉 resources 失败：' + (r.error || ''), 'error'); return; }
      const list = r.resources || [];
      if (list.length === 0) {
        await confirmModal({ title: `📂 ${name} · Resources`, message: '该 MCP server 未暴露任何 resource。\n\nresource 是 MCP server 提供的数据源（文件/URL/查询结果等），AI 可以列出 + 读取。', confirmLabel: '关闭', cancelLabel: '' });
        return;
      }
      const lines = list.map((r, i) =>
        `[${i + 1}] ${r.name || r.uri || '?'}\n     uri: ${r.uri || '-'}\n     ${r.description ? r.description.slice(0, 100) : ''}\n     mime: ${r.mimeType || '-'}`
      ).join('\n\n');
      await confirmModal({
        title: `📂 ${name} · Resources (${list.length})`,
        message: lines,
        confirmLabel: '关闭', cancelLabel: '',
      });
    } catch (e) { toast('异常：' + e.message, 'error'); }
  }

  // B-013 v0.9：MCP prompts 查看
  async function viewMcpPrompts(name) {
    try {
      const r = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}/prompts`).then(x => x.json());
      if (!r.ok) { toast('拉 prompts 失败：' + (r.error || ''), 'error'); return; }
      const list = r.prompts || [];
      if (list.length === 0) {
        await confirmModal({ title: `💬 ${name} · Prompts`, message: '该 MCP server 未暴露任何 prompt 模板。\n\nprompt 是 MCP server 预定义的 prompt 模板（可带参数），AI 可一键应用。', confirmLabel: '关闭', cancelLabel: '' });
        return;
      }
      const lines = list.map((p, i) => {
        const args = (p.arguments || []).map(a => `${a.name}${a.required ? '*' : ''}`).join(', ');
        return `[${i + 1}] ${p.name || '?'}\n     args: ${args || '(无)'}\n     ${p.description ? p.description.slice(0, 100) : ''}`;
      }).join('\n\n');
      await confirmModal({
        title: `💬 ${name} · Prompts (${list.length})`,
        message: lines,
        confirmLabel: '关闭', cancelLabel: '',
      });
    } catch (e) { toast('异常：' + e.message, 'error'); }
  }

  async function testMcp(name) {
    const toolsArea = $('#mcpToolsArea');
    if (toolsArea) toolsArea.innerHTML = window.UI.EmptyState({ kind: 'loading', icon: '🧪', text: '测试连接中（首次连 stdio 可能 5-15s）…' });
    const renderTools = async (body) => {
      const tools = body?.tools || [];
      toolsArea.innerHTML = `
        <div class="mcp-form-row">
          <label>✓ 连接成功 · ${tools.length} tools · ${body?.resourcesCount} resources · ${body?.promptsCount} prompts</label>
          <div class="mcp-tools-list">
            ${tools.length === 0 ? '<div class="muted small">此 server 未声明 tool</div>' :
              tools.map(t => `<div class="mcp-tool-item"><div class="tname">${escapeHtml(t.name)}</div>${t.description ? `<div class="tdesc">${escapeHtml(t.description.slice(0, 200))}</div>` : ''}</div>`).join('')}
          </div>
        </div>
      `;
      await refreshMcpList();
    };
    const path = `/api/mcp/servers/${encodeURIComponent(name)}/test`;
    const opts = { method: 'POST' };
    const result = await requestWithApproval(path, opts);
    await handleApprovalFlow(result, path, opts, {
      actionLabel: '连接测试 MCP server',
      onOk: async (r) => { await renderTools(r.body); },
      onError: (r) => { toolsArea.innerHTML = window.UI.EmptyState({ kind: 'error', icon: '❌', text: '连接失败：' + (r.error || 'unknown') }); },
      onDenied: (r) => { toolsArea.innerHTML = window.UI.EmptyState({ kind: 'error', icon: '❌', text: '测试被拒绝：' + (r.permissionDecision?.reason || 'denied') }); },
    });
  }

  async function deleteMcp(name) {
    const ok = await confirmModal({ title: '删除 MCP server', message: `要删除「${name}」吗？相关连接会立即断开。`, confirmLabel: '删除', cancelLabel: '取消' });
    if (!ok) return;
    const path = `/api/mcp/servers/${encodeURIComponent(name)}`;
    const opts = { method: 'DELETE' };
    const onDeleted = async () => {
      toast('已删除', 'success', 1500);
      mcpState.activeName = null;
      await refreshMcpList();
    };
    const result = await requestWithApproval(path, opts);
    await handleApprovalFlow(result, path, opts, {
      actionLabel: '删除 MCP server',
      onOk: async () => { await onDeleted(); },
      onError: (r) => toast('删除失败：' + (r.error || 'unknown'), 'error'),
    });
  }

  $('#btnMcp')?.addEventListener('click', openMcpModal);
  // 第13批：#btnMcpNew 新建按钮绑定迁回属主模块（原 app.js 散落绑定，改直引模块内符号）
  $('#btnMcpNew')?.addEventListener('click', () => {
    mcpState.isNew = true; mcpState.activeName = null;
    renderMcpList();
    renderMcpDetail({ name: '', type: 'stdio', command: '', args: [], env: {}, enabled: true });
  });

    window.PanelMcp = { open: openMcpModal, get state() { return mcpState; }, renderList: renderMcpList, renderDetail: renderMcpDetail };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else setTimeout(boot, 0);
})();
