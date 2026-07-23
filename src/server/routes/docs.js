// 暴露 docs/*.md 给前端展示 —— 从 server.js 抽出（D2）。仅 GET 只读，文件名白名单。
// app 级 owner-token 守卫兜底鉴权；rootDir 注入（指向项目根，docs/ 在其下）。

import { join } from 'path';
import { readFileSync } from 'fs';

const DOC_WHITELIST = new Set(['CCR_USAGE.md', 'HOOKS_USAGE.md']);

export function registerDocsRoutes(app, { rootDir }) {
  app.get('/api/docs/:name', (req, res) => {
    const name = req.params.name;
    if (!DOC_WHITELIST.has(name)) return res.status(404).json({ error: 'doc not found' });
    try {
      const content = readFileSync(join(rootDir, 'docs', name), 'utf-8');
      res.type('text/markdown').send(content);
    } catch (e) {
      // 不泄露 fs 错误细节
      console.error('[docs read]', e?.message || e);
      res.status(404).json({ error: 'doc not available' });
    }
  });
}
