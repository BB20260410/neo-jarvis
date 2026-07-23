# Neo 贾维斯 · 60 秒演示脚本（产品链）

**用途**：抖音/当面演示用的**真实产品路径**清单（约 60 秒）。
**原则**：只展示已上线界面；不开启真改；不假装「72 小时全自动」。
**入口**：`http://127.0.0.1:51835/home.html`（需启动日志里的 `?t=` owner token）。

---

## 启动（演示前 10 秒，可剪掉）

```bash
cd "/path/to/Neo 贾维斯"   # 本仓库根
npm run start:noe          # 端口 51835
# 用终端打印的完整 URL 打开（含 ?t=…），或：
# open "http://127.0.0.1:51835/home.html?t=$(cat ~/.noe-panel/owner-token.txt)"
```

---

## 60 秒分镜（计时）

| 秒 | 动作 | 真实界面 / 路由 | 口播要点 |
|----|------|-----------------|----------|
| **0–8** | 打开 **Home** | `public/home.html` → `/home.html` | 「本机个人 Agent · 默认安全」 |
| **8–15** | 看顶栏 **状态芯片** | `#statusChips`：模式 / 心跳 / 语音 / **进化** | 进化应显示 **dry-run** 或「未武装」类诚实文案；**不要**演示时开 REAL_APPLY |
| **15–28** | 对话区发一句 | `#composerForm` → rooms chat（有 token 时真发；无 token 会诚实报错） | 例：「你好，用一句话介绍你自己」；失败则指着错误气泡：「需要 ?t= token，不装假成功」 |
| **28–38** | 点 **设置** | `#btnOpenSettings` → `#settingsDrawer` → `#productSettingsSection` | 展示 **模型 Base URL**、**模型 ID**、语音开关（`#setModelBaseUrl` / `#setModelId` / `#setVoiceEnabled`）；说「日常不必手改 .env」 |
| **38–45** | 记忆栏 | `#memoryList` + **导出** `#btnMemoryExport` | 有记忆则点导出 JSON/MD；空则读 empty-hint：「还没有记忆…」——**空状态也诚实** |
| **45–52** | 待确认 | `#pendingChip`（有则点开 `#confirmPanel`） | 有队列：展示风险标签 + 拒绝不会执行；**零 pending 时芯片隐藏**——同样诚实 |
| **52–60** | 进化 dry-run | 页脚「进化 dry-run」→ `/evolution.html` 或 API `/api/noe/evolution-dashboard` | 读 **边界 / REAL_APPLY**：safe 默认 **dry-run · 默认不真改源码**；禁止在演示中双开关真改 |

---

## 口播定稿（可直接念，约 55 字/10 秒 × 6）

1. 「这是 Neo 贾维斯：本机优先的个人 Agent，不是又一个云聊天。」
2. 「顶栏告诉你模式和进化状态——默认 dry-run，不会偷偷改你代码。」
3. 「中间打字就能聊；没配 token 或模型会直说失败，不装已完成。」
4. 「设置里只改 Base URL 和模型 ID，密钥走高级面板。」
5. 「记忆可浏览、可导出；高风险操作要你点允许才会动。」
6. 「进化页只读观测——真改要显式双开关，开源默认关。」

---

## 绝对不要做的事

- 不要在演示中设置 `NOE_SELF_EVOLUTION_REAL_APPLY=1` 或宣称「已无人值守自改」。
- 不要宣称 72 小时全自动 / productionReady。
- 不要展示 `.env`、owner token 明文、API key。
- 不要把专家页 `index.html` 当「唯一首页」——主演示用 **Home**。

---

## 相关表面（已上线，脚本不虚构）

| 能力 | 位置 |
|------|------|
| Home 三栏 | `public/home.html` + `public/src/web/home-shell-ui.js` |
| 设置最少表单 | `GET/POST /api/noe/product-settings` |
| 待确认 | `GET /api/noe/pending-confirms` · `#confirmPanel` |
| 记忆导出 | `#btnMemoryExport` · `/api/noe/memory-export-package` |
| Diff 预览 | 确认卡「diff 预览」· `POST /api/noe/diff-preview` |
| 进化仪表 | `public/evolution.html` · `/api/noe/evolution-dashboard` |
| 版本/四环芯片 | `GET /api/version` |

更长产品进度见仓库根 `STATUS.md`；总纲见 owner 规划 `MASTER_PLAN`（若本机有）。
