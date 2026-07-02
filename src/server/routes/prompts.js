// Quick prompts 模板（F6）—— 从 server.js 抽出（D2 拆分）。
// 完全自包含：prompts.json 的读写 + 三个 CRUD 路由，无 server.js 闭包依赖（dataDir 注入）。
// 写端点 owner-token 保护：prompts 落 ~/.noe-panel/prompts.json。

import { join } from 'path';
import { existsSync, readFileSync, writeFileSync, copyFileSync, chmodSync, renameSync } from 'fs';
import { randomUUID } from 'crypto';
import { requireOwnerToken } from '../auth/owner-token.js';

export function registerPromptsRoutes(app, { dataDir }) {
  const PROMPTS_FILE = join(dataDir, 'prompts.json');

  function loadPrompts() {
    if (!existsSync(PROMPTS_FILE)) return [];
    try {
      const list = JSON.parse(readFileSync(PROMPTS_FILE, 'utf-8'));
      // load 时 cap 200（与 POST cap 一致）
      if (Array.isArray(list) && list.length > 200) {
        console.warn(`[loadPrompts] prompts.json 含 ${list.length} 条，超过 200 上限，仅加载最新 200`);
        return [...list].slice(0, 200);  // unshift 顺序：head 是新的
      }
      return list;
    } catch (e) {
      // 损坏时备份原文件，避免下次 savePrompts 直接覆盖丢全部历史
      try {
        const bak = PROMPTS_FILE + '.corrupted-' + Date.now() + '.bak';
        copyFileSync(PROMPTS_FILE, bak);
        console.error(`[prompts.json] corrupted, backed up to ${bak}:`, e.message);
      } catch {}
      return [];
    }
  }

  function savePrompts(list) {
    try {
      // 原子写
      const tmp = PROMPTS_FILE + '.tmp';
      writeFileSync(tmp, JSON.stringify(list, null, 2), { mode: 0o600 });
      try { chmodSync(tmp, 0o600); } catch {}
      renameSync(tmp, PROMPTS_FILE);
      return true;
    } catch (e) { console.warn('save prompts:', e.message); return false; }
  }

  app.get('/api/prompts', requireOwnerToken, (req, res) => res.json({ ok: true, prompts: loadPrompts() }));

  app.post('/api/prompts', requireOwnerToken, (req, res) => {
    const { name, content } = req.body || {};
    if (!name || typeof name !== 'string' || !name.trim()) return res.status(400).json({ error: 'name required' });
    if (!content || typeof content !== 'string') return res.status(400).json({ error: 'content required' });
    if (name.length > 100) return res.status(400).json({ error: 'name 过长' });
    if (content.length > 50000) return res.status(400).json({ error: 'content 过长（>50KB）' });
    const list = loadPrompts();
    if (list.length >= 200) return res.status(429).json({ error: '已达 200 条上限' });
    const item = { id: randomUUID(), name: name.trim(), content, createdAt: new Date().toISOString() };
    list.unshift(item);
    // 强健工程：写盘失败不再静默装成功（磁盘满/权限错时旧实现照样回 200，重启后数据蒸发）
    if (!savePrompts(list)) return res.status(500).json({ error: '保存失败（磁盘写入异常，详见 server 日志）' });
    res.json({ ok: true, prompt: item });
  });

  app.delete('/api/prompts/:id', requireOwnerToken, (req, res) => {
    const list = loadPrompts();
    const idx = list.findIndex(p => p.id === req.params.id);
    if (idx < 0) return res.status(404).json({ error: 'not found' });
    list.splice(idx, 1);
    if (!savePrompts(list)) return res.status(500).json({ error: '保存失败（磁盘写入异常，详见 server 日志）' });
    res.json({ ok: true });
  });
}
