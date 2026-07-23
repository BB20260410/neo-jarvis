# Security · Neo 贾维斯

## 默认安全立场

- **本地优先**：面板默认监听本机（如 `127.0.0.1:51835`）。
- **自进化真改默认 OFF**：`profile=safe` 下需双 opt-in（`NOE_SELFEVO_ALLOW_REAL_APPLY=1` **且** `NOE_SELF_EVOLUTION_REAL_APPLY=1`）及门控后才可能真改源码；开源演示与文档**不得**把真改当默认。
- **Owner token**：写配置 / 记忆导出 / 待确认等需 `X-Panel-Owner-Token`（见 `~/.noe-panel/owner-token.txt`，权限 0600）。**不要**把 token 提交进 git 或贴到公开 README。
- **高风险操作**：文件删除 / shell 等需确认卡；拒绝后不得执行。

## 密钥与敏感路径（勿入库）

| 路径 / 模式 | 说明 |
|-------------|------|
| `.env` / `.env.*` | 本地密钥；已在 `.gitignore` |
| `~/.noe-panel/owner-token.txt` | 本机 owner token |
| `~/.noe-panel/room-adapters.json` | 可含 API key |
| `~/.noe-panel/product-daily-settings.json` | 日常模型 URL（无 key） |
| `**/*token*` / `**/*credentials*` | 凭据类文件 |

公开仓发布前请跑 [`OPEN_SOURCE_PREFLIGHT.md`](./OPEN_SOURCE_PREFLIGHT.md)。

## 报告问题

安全问题请勿在公开 Issue 贴真实 secret。优先私信 maintainer 或使用 GitHub Security Advisory（若已启用）。

## 相关

- [`docs/DEMO_60S.md`](./docs/DEMO_60S.md) — 演示不开启真改
- [`STATUS.md`](./STATUS.md) — 当前产品进度
