# Open-source preflight · 公开发布前消毒清单

在 push 到公开 GitHub（如 `neo-jarvis`）**之前**逐项过一遍。
本文件是清单 + 建议命令；**本 goal 不执行 `git push`**（owner 确认后另做）。

## 硬要求（开源诚实）

1. **REAL_APPLY / 真改默认 OFF**；`profile=safe` 双 opt-in 才真改。
2. **禁止**宣称 72h 无人值守 / productionReady。
3. **不**提交真实 API key、owner token、`.env` 内容。
4. README 前门说清：本机优先、默认 dry-run、如何启动 Home。

## 检查表

| # | 检查项 | 命令 / 方式 | 期望 |
|---|--------|-------------|------|
| 1 | `.env` 未被 git 跟踪 | `git ls-files .env .env.local` | 空 |
| 2 | gitignore 含 `.env` | `rg '^\.env' .gitignore` | 有匹配 |
| 3 | 工作区无未忽略的 `.env` 拟提交 | `git status --short \| rg '\.env'` | 无 |
| 4 | 跟踪源码中无 live `sk-` / `xai-` 长串 | 见下方 scan 脚本 | 仅测试 fixture 可含并标注 |
| 5 | 无 owner-token 明文 hex 进仓 | scan `owner-token` 赋值长 hex | 无真实值 |
| 6 | room-adapters / 密钥路径不进仓 | `git ls-files '**/room-adapters.json' '**/*credentials*'` | 空或无 secret |
| 7 | 个人绝对路径（可选） | 文档可用占位；避免粘贴本机 token 路径内容 | — |
| 8 | 危险默认 | 文档与 `SECURITY.md` 声明 dry-run 默认 | 已写 |
| 9 | LICENSE 意图 | 当前 `package.json` 可能仍为 `UNLICENSED` | 公开前 owner 改 MIT/Apache 等 |
| 10 | 演示脚本不教开真改 | `docs/DEMO_60S.md` | 有「不要 REAL_APPLY」 |

## 推荐扫描（仓库根执行）

```bash
# 1–3 跟踪与 ignore
git ls-files .env .env.local .env.* 2>/dev/null
git check-ignore -v .env || true

# 4–6 跟踪文件中的高风险模式（排除 node_modules）
git grep -nE 'sk-[A-Za-z0-9_-]{20,}|xai-[A-Za-z0-9_-]{20,}|PANEL_OWNER_TOKEN\s*=\s*[A-Za-z0-9]{20,}' \
  -- ':!node_modules' ':!*.lock' || true

git ls-files | rg -i 'room-adapters\.json|credentials\.json|\.pem$|id_rsa' || true
```

**允许**：单测里用于断言「必须被 scrub」的假 `sk-...` fixture（路径含 `tests/`）。
**禁止**：生产配置、README、真实 `.env` 片段进跟踪树。

## 本机运行结果

将完整输出保存到会话证据目录或本文件附录。公开发布前应达到：

- `git ls-files .env*` → 空
- 跟踪源码 scan → **无 real secrets**（fixture 除外且已标注）
- `SECURITY.md` + `docs/DEMO_60S.md` 存在且声明 dry-run 默认

## 相关

- [`SECURITY.md`](./SECURITY.md)
- [`docs/DEMO_60S.md`](./docs/DEMO_60S.md)
- [`STATUS.md`](./STATUS.md)

## 最近一次扫描摘要（2026-07-23）

- `.env` 未跟踪：PASS
- 历史审计文档中泄露的 `sk-cp-…` MiniMax key 已替换为 `[REDACTED_MINIMAX_KEY]`
- 单测/脚本中的 scrub fixture（`sk-test…` 等）保留并允许
- REAL_APPLY 默认 OFF 已写入 SECURITY/README/DEMO
