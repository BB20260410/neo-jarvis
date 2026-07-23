# Neo 贾维斯（Noe）

**本机优先的个人 Agent OS**：打字/语音办事、持久记忆、多模型协作与**有边界的自进化**——默认 **dry-run，不偷偷改你的代码**。

> 一句定位：白龙马式「能用」的前门 × Neo 证据/治理内核 × 完全开源换名气（公开仓见下方）。
> **不是**「又一个云聊天」；**不宣称** 72 小时无人值守或 productionReady。

| | |
|---|---|
| **主界面** | [`/home.html`](./public/home.html) — 感知 · 对话 · 记忆 |
| **端口** | `51835` |
| **安全默认** | 自进化 `profile=safe` · REAL_APPLY **默认 OFF**（双开关才真改） |
| **公开意图** | [github.com/BB20260410/neo-jarvis](https://github.com/BB20260410/neo-jarvis)（push 由 owner 确认） |
| **60 秒演示** | [`docs/DEMO_60S.md`](./docs/DEMO_60S.md) |
| **安全** | [`SECURITY.md`](./SECURITY.md) |
| **开源消毒** | [`OPEN_SOURCE_PREFLIGHT.md`](./OPEN_SOURCE_PREFLIGHT.md) |
| **当前进度** | [`STATUS.md`](./STATUS.md) · [`TASKS.md`](./TASKS.md) |

---

## 快速开始

需要 **Node 22+**（仓库 `.nvmrc` / `npm run verify:node22`）。

```bash
cd "/path/to/Neo 贾维斯"   # 本仓库根目录
npm install
npm run verify:node22
npm run start:noe          # PORT=51835
```

浏览器打开（**必须**带 owner token，否则无法对话/导出记忆）：

```bash
open "http://127.0.0.1:51835/home.html?t=$(cat ~/.noe-panel/owner-token.txt)"
```

- 首次启动会在 `~/.noe-panel/owner-token.txt` 生成 token（`0600`）。**不要**把 token 提交进 git 或贴到公开帖。
- 专家工作台：`/index.html`；沉浸舱：`/cognitive.html`；进化只读仪表：`/evolution.html`。

### 日常最少配置（Home 设置抽屉）

- 模型 **Base URL** + **模型 ID** + 语音开关 → 持久化到本机 `product-daily-settings`（不必手改 `.env` 做日常切换）。
- API 密钥仍走专家「完整模型/密钥」或本机 `~/.noe-panel/room-adapters.json`（**勿入库**）。

---

## 产品表面（已上线）

| 能力 | 怎么用 |
|------|--------|
| Home 三栏 + 真对话 | `/home.html`；有 `?t=` 时走 rooms chat |
| 状态芯片 | 模式 / 语音 / 进化 dry-run 诚实文案 |
| 待确认 | 顶栏「待确认」芯片 → 允许/拒绝（拒绝不执行） |
| 记忆导出 | 记忆栏「导出」→ JSON/Markdown（密钥 scrub） |
| 改文件 diff | 确认卡上「diff 预览」 |
| 进化 dry-run | `/evolution.html` 或 `/api/noe/evolution-dashboard` |

演示分镜与口播：[`docs/DEMO_60S.md`](./docs/DEMO_60S.md)。

---

## 安全与红线（开源话术）

1. **真改默认 OFF**；safe 下需 `NOE_SELFEVO_ALLOW_REAL_APPLY=1` **且** `NOE_SELF_EVOLUTION_REAL_APPLY=1` 等门控。
2. 高风险文件/shell 需确认卡。
3. `.env`、owner token、room-adapters 密钥**永不提交**。
4. 详见 [`SECURITY.md`](./SECURITY.md) 与 [`OPEN_SOURCE_PREFLIGHT.md`](./OPEN_SOURCE_PREFLIGHT.md)。

AI / 贡献者工程约束：[`AGENTS.md`](./AGENTS.md) · [`CLAUDE.md`](./CLAUDE.md) · [`docs/AI_AGENT_HANDBOOK.md`](./docs/AI_AGENT_HANDBOOK.md)。

---

## 语音 · 视觉 · 主动陪伴（可选）

本地优先：whisper STT、可选本地 VLM、MiniMax TTS（需自备 key）。入口：认知舱 / 专家面板相关区。缺依赖则降级提示，不拖垮主面板。

```bash
npm run voice:up    # 可选：本地 whisper 服务
```

| 能力 | 依赖 |
|------|------|
| 语音转写 | `~/.noe-voice` + mlx-whisper |
| 本地脑 | Ollama / LM Studio 等 |
| TTS | 自备 MiniMax 等（写在本机配置，不进 git） |

---

## 打包（开发期）

```bash
npm run package          # 本地 ad-hoc .app
npm run dist             # ad-hoc DMG/ZIP，非公证
npm run dist:signed      # 仅 owner 配置正式签名/公证后
```

开发期**不要求**公证；对外分发需单独完成 Developer ID / Gatekeeper。

---

## 验证

```bash
npm run verify:node22
# 产品 polish 相关单测示例：
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run \
  tests/unit/noe-product-daily-settings.test.js \
  tests/unit/noe-pending-confirm-card.test.js \
  tests/unit/noe-memory-export-package.test.js \
  tests/unit/noe-evolution-dashboard.test.js
```

更全的 P0/CE12 门禁见下方历史文档与 `npm run test:p0:unit` 等脚本。

---

## 历史：CE12 P0 与交接（非当前「唯一现状」）

以下材料仍有用，但**不再**是 README 的唯一当前叙事。产品主路径已收敛到 **Home + 设置/确认/记忆/进化 dry-run**（见 `STATUS.md`）。

<details>
<summary>展开 CE12 / 旧交接索引</summary>

- 工作区曾称 Noe；中文品牌 **Neo 贾维斯**。
- CE12 规范：`NOE_CE12_P0_*.md`、[`NOE_CE12_P0_DOCS_CANONICAL.md`](./NOE_CE12_P0_DOCS_CANONICAL.md)。
- 交接示例：[`docs/HANDOFF_2026-06-11_六任务全收口交接.md`](./docs/HANDOFF_2026-06-11_六任务全收口交接.md)。
- 产品完善路线（较旧）：[`docs/NOE_PRODUCT_COMPLETENESS_PLAN_2026-06-06.md`](./docs/NOE_PRODUCT_COMPLETENESS_PLAN_2026-06-06.md)。
- 概念：M3 = MiniMax 建议员（suggestion-only，非任意 shell）；Noe ≠ 旧 Xike Lab 51735 面板。

```bash
npm run verify:p0:docs
npm run verify:p0:acceptance
npm run test:p0:unit
```

</details>

### 已知限制（诚实）

- 完整「贾维斯」体验与社交 I/O 仍在演进。
- 默认不对危险操作自动真执行。
- Electron 默认可打 ad-hoc 包，不等于商店分发就绪。
- ABI / 原生依赖须 Node 22（`scripts/ensure-node22.mjs`）。

---

## License

**AGPL-3.0-only** — 见根目录 [`LICENSE`](./LICENSE)。
网络提供修改版服务时须遵守 AGPL 对源码提供的要求。商业授权若另有约定见仓库 `COMMERCIAL-LICENSE.md`（若存在）。
