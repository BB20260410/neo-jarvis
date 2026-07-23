# CE12 P0 操作手册 - Noe / Neo 贾维斯

更新时间：2026-06-02
适用范围：`/Users/hxx/Desktop/Neo 贾维斯` 的 CE12 P0 产品化基础。

## 1. 每次接手先做

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
pwd
git -c core.quotepath=false status --short
npm run verify:node22
npm run verify:p0:docs
```

不要因为 worktree 很脏就回滚。大量未提交文件来自前序阶段，除非用户明确要求，不要 `git reset --hard`、不要大范围 checkout、不要 `git add .`。

## 2. 启动 Noe

```bash
npm run start:noe
```

启动后：

```bash
cat ~/.noe-panel/owner-token.txt
open "http://127.0.0.1:51835/?t=$(cat ~/.noe-panel/owner-token.txt)"
```

说明：

- Noe 使用 `~/.noe-panel/owner-token.txt`。
- 原项目 Xike Lab 常用 `~/.claude-panel/owner-token.txt`，不要混用。
- Noe 端口是 51835，原项目端口是 51735。

## 3. 验证入口

| 命令 | 目的 | 预期 |
|---|---|---|
| `npm run verify:p0:docs` | 文档事实源和入口校验 | docs checks passed |
| `npm run verify:p0:fast` | 快速 P0 回归 | 轻量门全 PASS |
| `npm run verify:p0` | 全量 P0 回归 | 7/7 门通过，exit 0 |
| `npm run test:p0:unit` | 核心 P0 单测 | 40/40 或更多全过 |
| `npm run test:p0:integration` | server/API/storage 集成 | 18/18 checks passed |
| `npm run test:p0:funcverify` | 真实 51835 主路径 | 14/14 checks passed |
| `npm run test:e2e:p0` | Brain UI Playwright | 17/17 checks passed |
| `npm run smoke:electron` | Electron smoke | electron-smoke PASS |

`verify:p0:fast` 不是最终验收。它跳过 Electron 和浏览器 e2e。

## 4. Node22 与 ABI

Noe 的可复验证据使用 Node `22.22.2`：

```bash
node scripts/ensure-node22.mjs --require-22 --json
node scripts/ensure-node22.mjs --require-22 --print-bin
```

如果当前 shell 是 Node26，不要直接裸跑 ABI 敏感命令。使用：

```bash
node scripts/ensure-node22.mjs --require-22 --exec <script-or-binary> [...args]
```

常见误判：

- `node -v` 显示 v26 不等于失败；外层 runner 可是 Node26。
- `better-sqlite3` 相关任务必须 re-exec 到 Node22。
- 裸 `vitest run` 失败不作为 P0 失败依据；认可 `npm test` 或 `npm run test:p0:unit`。

## 5. 功能验证前置

`npm run test:p0:funcverify` 会检查原项目 51735 是否运行。如果 51735 没运行，U1 会按设计失败。

先检查：

```bash
lsof -nP -iTCP:51735 -sTCP:LISTEN
lsof -nP -iTCP:51835 -sTCP:LISTEN
```

规则：

- 51735 是原项目，不要杀。
- 51835 如被旧 Noe 占用，可以先确认 PID 后只清理 51835。
- 功能验证脚本会隔离 HOME/PANEL_DB_PATH，不污染真实 Noe 数据。

## 6. 证据路径

- 聚合验证：`output/ce12-p0/p0-verify-all-*.json`
- latest 聚合：`output/ce12-p0/p0-verify-all-latest.json`
- 集成报告：`output/ce12-p0/integration/integration-report-*.json`
- CE08 主路径：`output/ce12-p0/ce08/funcverify-report-*.json`
- Brain UI 截图：`output/playwright/noe-brain-ui-p0-*.png`
- Electron smoke：`output/electron-smoke/electron-smoke-*.jsonl`

引用证据时写清命令、exit code 和具体文件路径。

## 7. 安全操作规则

- 低风险 act：只允许 dry-run completed。
- 高风险 act：默认 awaiting approval。
- 危险 act：默认 `blocked_safety`。
- MiniMaxSpawnAdapter：只允许 patch-only 审计；`diffs` 非空、shell/write/delete/move/apply_patch 都 fail-closed。
- ToolRegistry：未审计 handler 不接入真实执行。
- 不提交或记录 raw secret。

## 8. 排障

### `NODE_MODULE_VERSION` 不匹配

```bash
npm run verify:node22
/Users/hxx/.nvm/versions/node/v22.22.2/bin/npm rebuild better-sqlite3 node-pty @homebridge/node-pty-prebuilt-multiarch
```

### Brain UI e2e 找不到浏览器

优先使用项目 Playwright 缓存；不要把 Browser/iab 插件不可用当产品失败。当前文档承认该降级。

### Electron smoke 卡住

检查 `output/electron-smoke/*.jsonl`，确认 `app_ready`、`menu_registered`、`server_ready`、`window_loaded` 是否齐备。P0 不要求签名、公证或 DMG。

### 文档和代码不一致

先跑：

```bash
npm run verify:p0:docs
```

如果失败，优先修文档事实源或真实代码锚点，不要继续引用旧 `NOE_PHASE9_DOCS_CANONICAL.md` 的过期结论。
