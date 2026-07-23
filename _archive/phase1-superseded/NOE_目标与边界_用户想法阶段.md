# NOE 目标与边界 —— 「用户想法」阶段契约

> 阶段：工程闭环 1/11「用户想法」
> 日期：2026-06-01
> 产出成员：🟣 Claude (xike-builder)
> 工作目录：`/Users/hxx/Desktop/Neo 贾维斯`（硬边界，只在此目录工作）
> 上游输入：`HANDOFF_2026-06-01_Noe_融合可行性结论.md`、`NOE_BAILONGMA_ARCH_AUDIT.md`
> 本文件作用：把"吸收 BaiLongma 做 Jarvis"的原始想法，收敛成**任何成员都能复述的同一个目标**，并锁死范围、约束、不可做事项。

---

## 0. 一句话目标（电梯版，供全员复述）

> **以 Noe（现有本地 Claude 多 session 管理面板，端口 51835）为主产品底座，分阶段、可回滚地吸收 BaiLongma 的"持续运行数字意识"理念（TICK loop / Memory / Focus / Brain UI / Voice / Social），把 Noe 从"被动面板"演进为"主动 Jarvis"；只借鉴架构与理念，不全量复制代码，不在未审计前接入任何工具执行能力。**

复述自检：目标 = **Noe 做底座** + **吸收而非拼接 BaiLongma** + **从被动面板→主动助手** + **可回滚、先审计**。四个要点缺一即范围漂移。

---

## 1. 目标说明（Goal Statement）

| 维度 | 内容 |
|---|---|
| 主产品 | Noe / Neo 贾维斯（**不是**原 Xike Lab 稳定项目，**不是** BaiLongma） |
| 底座现状 | Express + WebSocket 后端 + Web GUI 前端；`npm start` 起 `node server.js`，监听 `127.0.0.1:51835`（已核实 `server.js:317/1620/4581/4710`）；可 `npm run electron` 包成桌面 app |
| 演进方向 | 被动的"多 Claude session 管理面板" → 主动的"常驻数字助理（Jarvis）" |
| 吸收来源 | BaiLongma（`github.com/xiaoyuanda666-ship-it/BaiLongma`，已克隆到 `/Users/hxx/Desktop/BaiLongma-audit`，**MIT 许可**，v2.1.179） |
| 吸收内容 | TICK loop（持续心跳）、Memory（记忆）、Focus Stack（焦点栈）、Brain UI（大脑可视化）、Voice（语音）、Social I/O（社交输入输出）、工具市场（capabilities/marketplace）思路 |
| 吸收方式 | **理念优先、架构参考、按需重写**；BaiLongma 绑死 Electron + Windows（`start:lan` 走 powershell），不可照搬 |

---

## 2. 范围边界（Scope Boundaries）

### ✅ 在范围内（In-Scope）
1. 在 `/Users/hxx/Desktop/Neo 贾维斯` 内部新增/改造模块。
2. 验证 Noe 自身能在 51835 启动，且**不影响**原项目 51735（端口已天然隔离，见 §5 证据）。
3. 把 BaiLongma 的 6 大理念按**最小闭环**逐个落到 Noe 的既有技术栈（Express/WS/Web GUI，非 Electron-only）。
4. 复用 Noe 已有安全护栏（Origin 白名单、`safeResolveFsPath` 沙箱、body length cap、127.0.0.1 only）。

### ⛔ 在范围外（Out-of-Scope，红线）
1. **不**改原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`（任何文件都不碰）。
2. **不**把 BaiLongma 全量 `cp` 进 Noe（理念可借，代码逐块审计后重写）。
3. **不**在未审计前接入任何**工具执行能力**（BaiLongma 的 `capabilities/marketplace`、`tool-router` 涉及让 AI 跑命令，未审计禁止接）。
4. **不**在 BaiLongma-audit 目录里写代码（它是只读审计副本）。
5. **本阶段不写功能代码**——"用户想法"阶段只产出目标契约；写代码是第 5 阶段的事。

### 🔁 阶段顺序（不可乱序，每步可独立回滚）
1. 只读审计 BaiLongma（已完成，见 `NOE_BAILONGMA_ARCH_AUDIT.md`）
2. 验证 Noe 在 51835 启动 + 不影响 51735
3. NoeLoop 最小闭环（TICK loop lite）
4. Memory Core（记忆核心）
5. Brain UI Lite（大脑 UI 精简版）
6. Voice / Social / Jarvis 体验

---

## 3. 成功标准（Success Criteria，可度量）

| # | 标准 | 验收方式 |
|---|---|---|
| S1 | 本阶段：全员能复述同一个目标，无范围漂移 | 用 §0 四要点对照各成员方案，缺要点=不通过 |
| S2 | Noe 在 51835 可启动 | `curl -s 127.0.0.1:51835` 有响应 |
| S3 | 启动 Noe 不影响原项目 51735 | 两端口可共存，互不抢占（端口不同，见 §5） |
| S4 | 借鉴**零代码污染** | 任何并入 Noe 的代码均经审计+重写，保留 MIT 版权声明；`git diff` 可逐行追溯 |
| S5 | 每个吸收模块是**最小闭环**且**可回滚** | 单 sprint 内可 `git revert` 而不破坏面板主功能 |
| S6 | 安全护栏不被削弱 | 既有 4 道护栏（Origin 白名单/路径沙箱/body cap/127.0.0.1）在新模块上同样生效 |

---

## 4. 风险与假设（Risks & Assumptions）

| 类型 | 项 | 应对 |
|---|---|---|
| 风险 | BaiLongma 绑死 Electron + Windows（`start:lan` 走 powershell），照搬必崩 | 只取理念，按 Noe 的 Express/WS 重写 |
| 风险 | `capabilities/marketplace` / `tool-router` = 让 AI 执行工具，未审计接入有安全隐患 | 列为 Out-of-Scope #3，审计通过前禁接 |
| 风险 | TICK loop 常驻心跳可能烧 Claude 付费配额（红线 #4） | NoeLoop 默认空转/手动触发，不自动 spawn `claude -p` |
| 风险 | 文件硬规则 <500 行，而 `app.js` 6500+/`server.js` 4100+ 已超 | 新模块独立成文件，不往巨型文件里塞 |
| 假设 | BaiLongma MIT 许可允许借鉴（已核实 `LICENSE` = MIT, ©2026 xiaoyuanda666-ship-it） | 并入代码保留版权声明，合规 |
| 假设 | 51835/51735 端口隔离即项目隔离 | 已核实两项目 server.js 常量不同（§5） |
| 假设 | Noe 现有安全护栏可直接覆盖新模块 | 新路由走 `register<Name>Routes` + try/catch + 既有沙箱 |

---

## 5. 关键事实核实证据（本阶段实测）

```
# 端口隔离（已核实）
Noe   server.js:317  const PANEL_PORT = process.env.PORT || 51835;
原项目 server.js:317  const PANEL_PORT = process.env.PORT || 51735;
→ 两项目默认端口不同，可共存，启动 Noe 不抢占原项目。

# BaiLongma 许可与结构（已核实）
LICENSE = MIT License, Copyright (c) 2026 xiaoyuanda666-ship-it
package.json: name=bailongma, version=2.1.179, main=electron/main.cjs (Electron 绑定)
src/ 含: memory/ context/ social/ voice/ capabilities/ ticker.js(TICK) ui/ tool-router(test) 等
→ 理念齐全，但绑 Electron + 含工具执行能力，需审计后重写，不可照搬。
```

---

## 6. 与工程闭环 11 阶段的衔接

| 阶段 | 本阶段如何为它铺路 |
|---|---|
| 1 用户想法（当前） | 产出本契约：目标/边界/成功标准/风险锁定，全员可复述 |
| 2 需求分析与拆解 | 下游把 §1 演进方向拆成 NoeLoop/Memory/BrainUI/Voice/Social 5 条需求线，逐条对照 §2 边界 |
| 3 技术方案设计 | 依据 §4 风险（Electron 不可照搬、工具执行禁接）选型：在 Express/WS 上设计，不引 Electron-only 依赖 |
| 4 任务分配与排期 | 按 §2 阶段顺序（审计→启动验证→NoeLoop→Memory→BrainUI→Voice/Social）串行排期，每步可回滚 |
| 5 代码开发 | 新模块独立成文件（<500 行），复用 §6 安全护栏；保留 MIT 版权声明 |
| 6 单元测试 | 复用 Noe 既有 vitest + 4 个 `.s18-*.mjs` smoke，不新增依赖 |
| 7 集成测试 | 每 3 task 跑 68/68 回归 smoke（见 CLAUDE.md），确保面板主功能不退化 |
| 8 功能验证 | 对照 §3 成功标准 S2–S6 逐项 curl/diff/revert 验证 |
| 9 文档编写 | 更新 `HANDOFF.md` 变更历史 + 本系列融合文档 |
| 10 交付验收 | 以 §3 成功标准为验收清单，S1–S6 全绿才算闭环 |
| 11 复盘优化 | 回看 §4 风险是否兑现，迭代下一轮吸收模块 |

---

## 7. 红线清单（碰到先停）

1. 改原项目 `05_Claude可视化面板` 任何文件 → 停。
2. 全量复制 BaiLongma 进 Noe → 停。
3. 未审计接入工具执行（marketplace / tool-router）→ 停。
4. NoeLoop 自动 spawn `claude -p` 烧配额 → 停。
5. 削弱既有安全护栏 / 监听非 127.0.0.1 → 停。
6. 本阶段写功能代码（越权到第 5 阶段）→ 停。
