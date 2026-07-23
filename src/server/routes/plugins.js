// @ts-check
// Noe — Plugins routes (S23)
// v0.52 W1：plugin registry（通用 CLI Wrapper 雏形，独立于 roomAdapterPool）
// 从 server.js 2650-2828 提取，行为完全一致
//
// 内部创建 PluginRegistry（原 server.js 2651 的 const），返回 { pluginRegistry } 供需要方使用

import { PluginRegistry } from '../../plugin/PluginRegistry.js';
import { PluginSpawnAdapter } from '../../plugin/PluginSpawnAdapter.js';
import { PluginHttpAdapter } from '../../plugin/PluginHttpAdapter.js';
import { requireOwnerToken } from '../auth/owner-token.js';
import { permissionApprovalIdFromRequest, permissionHttpBody, permissionHttpStatus } from '../../permissions/PermissionGovernance.js';

export function registerPluginsRoutes(app, deps) {
  const { permissionGovernance, safeResolveFsPath, metricsStore, send500 } = deps;

  // 测试可注入假 registry；生产路径与原 server.js 行为一致（构造 + load + 启动日志）
  const pluginRegistry = deps.pluginRegistry || new PluginRegistry();
  if (!deps.pluginRegistry) {
    const loaded = pluginRegistry.load();
    console.log(`[PluginRegistry] 已加载 ${loaded.length} 个 plugin（${loaded.filter(p => p.valid).length} 可用）`);
    for (const p of loaded) {
      const tag = p.valid ? '✓' : '✗';
      console.log(`  ${tag} [${p.source}] ${p.id} → ${p.displayName}${p.error ? ' (' + p.error + ')' : ''}`);
    }
  }

  function requirePluginPermission(req, res, input) {
    const permission = permissionGovernance.evaluatePermission({
      actorType: 'owner',
      actorId: 'local-owner',
      approvalId: permissionApprovalIdFromRequest(req),
      cwd: process.cwd(),
      risk: 'high',
      ...input,
    });
    if (!permission || permission.decision === 'allow') return true;
    res.status(permissionHttpStatus(permission)).json(permissionHttpBody(permission));
    return false;
  }

  function stripPermissionFields(body = {}) {
    const clean = { ...(body || {}) };
    delete clean.approvalId;
    delete clean.permissionApprovalId;
    delete clean.resumeApprovalId;
    return clean;
  }

  // GET /api/plugins — 列已加载 plugin manifest（摘要）
  app.get('/api/plugins', requireOwnerToken, (req, res) => {
    res.json({ ok: true, plugins: pluginRegistry.list() });
  });

  // GET /api/plugins/:id — 返完整 manifest JSON（含 bin/input/output/events/dashboard）
  app.get('/api/plugins/:id', requireOwnerToken, (req, res) => {
    const id = req.params.id;
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) return res.status(400).json({ error: 'plugin id 非法' });
    const entry = pluginRegistry.get(id);
    if (!entry) return res.status(404).json({ error: 'plugin 不存在' });
    res.json({
      ok: true,
      id: entry.manifest.id,
      source: entry.source,
      valid: entry.valid,
      error: entry.error,
      resolvedBin: entry.resolvedBin,
      manifest: entry.manifest,
    });
  });

  // POST /api/plugins/install — 装一份用户 manifest（body 直接是 manifest 对象）
  // 改：owner-token 保护 — manifest 里可以指定 bin path → 装恶意 manifest = RCE 入口
  app.post('/api/plugins/install', requireOwnerToken, (req, res) => {
    const rawManifest = req.body;
    if (!rawManifest || typeof rawManifest !== 'object') return res.status(400).json({ error: 'manifest 必须是 JSON 对象' });
    // 大小上限
    try { if (JSON.stringify(rawManifest).length > 32 * 1024) return res.status(413).json({ error: 'manifest 过大（>32KB）' }); } catch {}
    const manifest = stripPermissionFields(rawManifest);
    if (!requirePluginPermission(req, res, {
      action: 'skill.plugin.configure',
      target: {
        section: 'plugins',
        operation: 'install',
        pluginId: manifest.id || null,
        type: manifest.type || null,
        hasBin: !!manifest.bin,
        commandCount: Array.isArray(manifest.commands) ? manifest.commands.length : 0,
      },
    })) return;
    const r = pluginRegistry.install(manifest);
    if (!r.ok) return res.status(422).json({ error: r.error });
    res.json({ ok: true, entry: { id: manifest.id, displayName: manifest.displayName, valid: r.entry?.valid, error: r.entry?.error } });
  });

  // DELETE /api/plugins/:id — 卸载用户 plugin（内置禁删）
  app.delete('/api/plugins/:id', requireOwnerToken, (req, res) => {
    const id = req.params.id;
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) return res.status(400).json({ error: 'plugin id 非法' });
    if (!requirePluginPermission(req, res, {
      action: 'skill.plugin.configure',
      target: { section: 'plugins', operation: 'delete', pluginId: id },
    })) return;
    const r = pluginRegistry.uninstall(id);
    if (!r.ok) return res.status(r.error?.includes('内置') ? 403 : 404).json({ error: r.error });
    res.json({ ok: true });
  });

  // POST /api/plugins/reload — 重扫两个目录
  app.post('/api/plugins/reload', requireOwnerToken, (req, res) => {
    if (!requirePluginPermission(req, res, {
      action: 'skill.plugin.configure',
      target: { section: 'plugins', operation: 'reload' },
    })) return;
    const loaded = pluginRegistry.reload();
    res.json({ ok: true, plugins: pluginRegistry.list(), count: loaded.length });
  });

  // POST /api/plugins/:id/exec — 跑一个 command
  // body: { commandId, params, prompt, model, cwd, abortAfterMs? }
  // 改：owner-token 保护 — exec 会按 manifest 拼 argv 启子进程，必须本机 owner
  app.post('/api/plugins/:id/exec', requireOwnerToken, async (req, res) => {
    const id = req.params.id;
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) return res.status(400).json({ error: 'plugin id 非法' });
    const entry = pluginRegistry.get(id);
    if (!entry) return res.status(404).json({ error: 'plugin 不存在' });
    if (!entry.valid) return res.status(424).json({ error: 'plugin 不可用: ' + (entry.error || 'bin 探测失败') });

    const { commandId, params = {}, prompt = '', model, cwd } = req.body || {};
    if (!commandId || typeof commandId !== 'string') return res.status(400).json({ error: 'commandId required' });
    // prompt 长度限制（防 10MB 撑爆）
    if (typeof prompt !== 'string' || prompt.length > 64 * 1024) return res.status(413).json({ error: 'prompt 过长（>64KB）或类型错' });
    // cwd 沙箱
    let safeCwd = undefined;
    if (typeof cwd === 'string' && cwd.trim()) {
      if (cwd.length > 1024) return res.status(400).json({ error: 'cwd 过长' });
      const safe = safeResolveFsPath(cwd.trim());
      if (!safe) return res.status(403).json({ error: 'cwd 越权或敏感目录' });
      safeCwd = safe;
    }

    if (!requirePluginPermission(req, res, {
      action: 'skill.plugin.execute',
      cwd: safeCwd || process.cwd(),
      target: {
        section: 'plugins',
        operation: 'exec',
        pluginId: id,
        commandId,
        source: entry.source,
        type: entry.manifest.type || 'spawn',
        resolvedBin: entry.resolvedBin || null,
        cwd: safeCwd || null,
        model: model || null,
        promptLength: prompt.length,
      },
    })) return;

    // v0.53 Sprint 3.5：plugin exec 也 record metrics
    // v0.54 Sprint 4：按 manifest.type 分派 Spawn / Http adapter
    const startedAt = Date.now();
    try {
      const adapter = entry.manifest.type === 'http'
        ? new PluginHttpAdapter(entry)
        : new PluginSpawnAdapter(entry);
      const result = await adapter.execCommand(commandId, params, {
        prompt, model, cwd: safeCwd,
      });
      try {
        metricsStore.record({
          roomId: '', roomMode: 'plugin', roomName: entry.manifest.displayName || id,
          projectId: safeCwd || '',
          turn: `plugin:${id}.${commandId}`,
          adapter: id, model: model || '',
          latencyMs: Date.now() - startedAt,
          tokensIn: result.tokensIn || 0, tokensOut: result.tokensOut || 0,
          success: true, errorKind: null,
        });
      } catch {}
      res.json({ ok: true, reply: result.reply, tokensIn: result.tokensIn, tokensOut: result.tokensOut });
    } catch (e) {
      try {
        metricsStore.record({
          roomId: '', roomMode: 'plugin', roomName: entry.manifest.displayName || id,
          projectId: safeCwd || '',
          turn: `plugin:${id}.${commandId}`,
          adapter: id, model: model || '',
          latencyMs: Date.now() - startedAt,
          tokensIn: 0, tokensOut: 0,
          success: false, errorKind: e?.name || 'error',
        });
      } catch {}
      send500(res, e);
    }
  });

  return { pluginRegistry };
}
