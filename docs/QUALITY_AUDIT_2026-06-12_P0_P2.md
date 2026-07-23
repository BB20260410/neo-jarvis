# Neo Quality Audit 2026-06-12

隔离 worktree：`/Users/hxx/Documents/Neo-Quality-Audit`

分支：`codex/p0-p2-quality-audit`

基线：`145e642 本地模型: 收敛单主脑 Gemma`

## 执行边界

- 未写入主工作区 `/Users/hxx/Desktop/Neo 贾维斯`，避免影响其它活跃窗口。
- 未触碰 `51735`。
- 未启动、重启、杀死或接管 `51835`。
- 未读取、打印或复制 `.env`、API key、token、cookie、OAuth 文件、`~/.noe-panel/room-adapters.json`。
- 未触碰 `games/cartoon-apocalypse/**`。

## 已完成改动

### P0 安全/可靠性

1. Webhook 发证响应不再返回完整 license。
   - 改为返回 `issued/email/tier/licenseReturned:false`。
   - 防止完整 license 进入第三方 webhook 响应、代理日志或重试日志。

2. Webhook secret 统一规范化。
   - 拒绝非字符串和过短 secret。
   - 存储前 trim，避免 UI 或脚本误传空白导致签名不一致。

3. 房间媒体读取加 realpath 存储边界。
   - `GET /api/rooms/:id/media/:mediaId` 只允许读取该房间项目 `attachments/` 或 panel fallback media 目录内的真实文件。
   - 越界路径返回 404。

### P1/P2 代码质量

4. 新增 `scripts/noe-quality-audit.mjs`。
   - 扫描后端鉴权、动态 `sendFile`、webhook license 响应、字符串执行、前端 HTML sink、超大文件等。
   - 输出 `output/quality-audit/QUALITY_AUDIT.md` 和 `output/quality-audit/quality-audit.json`。
   - 当前结果：P0 = 0，P1 = 0，P2 = 0。

5. 收敛 cognitive stream DOM sink。
   - `public/cognitive.html`
   - `public/src/web/cognitive-command-surface.js`
   - `public/src/web/cognitive-local-council.js`
   - `public/src/web/cognitive-research.js`
   - `public/src/web/cognitive-taskflow.js`
   - 从 `innerHTML` 拼接改为 DOM API + `textContent`，并加颜色格式白名单。

6. 收敛前端高信号 DOM sink / class token。
   - `public/src/web/search-ui.js`：搜索高亮改成 DOM 分段 `<mark>`，不再拼接高亮 HTML。
   - `public/src/web/cmdk-ui.js`：命令图标/标题/副标题改成 `textContent`。
   - `public/src/web/cognitive-attachments.js`：附件元信息改成 DOM API。
   - `public/mind.js`：情感曲线改成 SVG DOM；目标 id/status/source/priority 输出加转义或规范化。
   - `public/src/web/overview-ui.js`：总览数字和健康行加 `safeClassToken`/`escapeHtml`/数字规范化。
   - `public/src/web/projects-files-ui.js`：history trigger class 和 project modal 状态文本规范化。
   - `public/src/web/sessions-list-ui.js`：session runState class 规范化，title 转义。
   - `public/src/web/rooms-core-ui.js`：房间状态 fallback 文本转义。
   - `public/src/web/autopilot-ui.js`：max hop 配置输出数字规范化。
   - `public/src/web/rooms-squad-ui.js`：审查时间片段转义。

7. Markdown sink 统一治理。
   - 审计器现在验证 `public/src/web/markdown-ui.js` 的集中 `renderMarkdown`。
   - 只有同时存在 `DOMPurify.sanitize` 路径和 `escapeHtml(text)` fallback 时，调用点才不报 P2。
   - 当前 13 个 Markdown sink 均通过集中 sanitizer 证明。

## 剩余事项

当前审计 findings 为 0，没有剩余 P0/P1/P2 阻断项。

后续建议：

1. 继续保持所有 rich text 只通过 `renderMarkdown` 统一入口。
2. 不要在调用点直接绕过 sanitizer 写 `innerHTML`。
3. 如果未来启用 Trusted Types，可把 `renderMarkdown` 作为唯一 TrustedHTML 生产点。

## 验证结果

- `node --check scripts/noe-quality-audit.mjs`
- `node --check src/server/routes/roomsMedia.js`
- `node --check src/server/routes/payment-webhooks.js`
- `node --check src/server/routes/lemonsqueezy.js`
- `node --check public/src/web/cognitive-command-surface.js`
- `node --check public/src/web/cognitive-local-council.js`
- `node --check public/src/web/cognitive-research.js`
- `node --check public/src/web/cognitive-taskflow.js`
- `node --check public/mind.js`
- `node --check public/src/web/search-ui.js`
- `node --check public/src/web/cmdk-ui.js`
- `node --check public/src/web/cognitive-attachments.js`
- `node --check public/src/web/overview-ui.js`
- `node --check public/src/web/projects-files-ui.js`
- `node --check public/src/web/rooms-core-ui.js`
- `node --check public/src/web/rooms-squad-ui.js`
- `node --check public/src/web/autopilot-ui.js`
- `node scripts/noe-quality-audit.mjs`: findings 0, P0 0, P1 0, P2 0
- `vitest run tests/unit/routes/payment-webhooks.test.js tests/unit/routes/rooms-advanced-routes.test.js`: 2 files, 23 tests passed
- `npm run test:p0:unit`: 88 files, 682 tests passed
- `npm run verify:noe:self-evolution`: 198 passed, 0 failed
- `npm run verify:handoff`: 24 passed, 0 failed
- `git diff --check -- ':!games/cartoon-apocalypse/**'`

## 合并建议

等 `019eb890-0cb0-76e0-b19f-9a740d277228` 停止写主仓库后，再把该分支合入主工作区。合并前先在主仓库执行：

```bash
git -C "/Users/hxx/Desktop/Neo 贾维斯" status --short
git -C "/Users/hxx/Desktop/Neo 贾维斯" log -5 --oneline
```

如果主仓库仍有未提交改动，优先用 cherry-pick 或手工分块移植这些文件，避免覆盖其它窗口的未提交成果。
