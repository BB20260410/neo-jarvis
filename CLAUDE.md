# Neo (Noe) — 项目级 CLAUDE.md

> 全局 ~/.claude/CLAUDE.md 已生效（全速 / 中文 / 自测 / 红线 / 不设超时 / 烧辅助模型配额）；Claude Code 自带行为（简洁、工具纪律、TodoWrite、commit 礼仪、不主动建文档、no emoji、`file_path:line` 等）不在此复述。
> 本文件只写 **Neo 特有约定**。接手先读最新 `docs/HANDOFF_*.md` + `AGENTS.md` 接手必读定位进度。

## 接手边界速查（handoff-consistency 钉死，勿删这些精确措辞）
- **secret**：不打印、复制、总结或暴露 `.env` / `~/.noe-panel/room-adapters.json` 等含 secret 文件原值；查模型 key 用 `npm run noe:keys:model:check`（只打印状态不打印 secret）。
- **端口/git**：不触碰 `51735`（母项目，默认只观察）；非 owner 明确要求**不 commit、amend、push、reset** noe-main（本地领先 origin、owner 惯例不 push）。
- **接手读序**：最新 `docs/HANDOFF_*.md`（当前 **2026-06-21_心跳自改通+P0P5重编**，下一步分 4 优先级 A→D）优先 > `2026-06-12 handoff` > 旧 2026-06-05 至 2026-06-11 文档只作为背景；验收基线看 `NOE_100_ACCEPTANCE_MATRIX.md`。

## 本质 & 启动
- 本地多 AI 个人 OS（Jarvis 风）：Express + WebSocket 后端 + Web GUI；私有仓 `noe@noe-main`。
- 启动走守卫，**别直接 `node server.js`**：`npm start` = `node scripts/ensure-node22.mjs --require-22 --exec server.js`（端口 **51835**，仅 127.0.0.1）；指定端口用 `npm run start:noe`（= 同守卫带 `PORT=51835`）。直接 `node server.js` 会绕过 Node22 守卫，在本机 Node26 下正是触发 PTY/打包异常的情形。
- Node 锁 `.nvmrc=22.22.2`（CI 固定 22.x，`engines>=22`）；异常先回退 22.22.2 复测。
- 终端用 CC：`npm run claude:neo`（= `bash scripts/claude-neo-terminal.sh`，自动注入 `claude-opus-4-8 --effort xhigh` + 追加 `docs/prompts/claude-terminal-neo-48.md` 作 system prompt；不动 `~/.claude`、不自启 51835）。临时改档：`npm run claude:neo -- --effort max`。
- 本地模型策略以 `src/model/NoeLocalModelPolicy.js` 为准：Main `qwen/qwen3.6-35b-a3b` / Review `qwen/qwen3.6-27b` / Fallback `gemma-4-26b-a4b-it-qat-mlx`（高风险/删除/发布/自改代码前触发 Review 复核）。

## 端口（动前先查归属）
- **51835** = live panel。开发期可自主重启（含 kickstart）：kill 前先 `lsof -i:51835` 验 PID/cwd 确属本项目，重启后实测证明生效。别假设非目标端口都是自己的残留。
- **51735** = 母项目，默认只观察不触碰。
- 分量改动用高位隔离端口端到端验，用 `PORT=51999 npm start`（**别用 `npm run start:noe`——脚本内联死 PORT=51835，外部 PORT 无效**，2026-07-03 实测），别在 51835 上做破坏性自测。

## .env 开关默认 OFF（本项目最有效的防伤害模式）
- 任何新功能、新认知/情感/行为动力学：加 `.env` flag，**默认 OFF**，等 owner 在场 kickstart/首验后再考虑默认 ON。开关清单 + 点火步骤写进 HANDOFF。
- **"分量动作"判据**：凡碰 `src/cognition/` `src/loop/` self-evolution（NoePatchApply 自改代码）/ 情感 VAD / GWT 工作区重平衡 → 视为分量动作：单测 + 隔离端口端到端证据 + .env flag 默认 OFF + 留 owner 点火，不擅自默认 ON。其余按全局全速做。

## 新文件三件套 + 文件大小
- **新文件**：`// @ts-check` 文件头 + 注入式(DI)设计（依赖从参数传入，别全局乱抓）+ 配套单测。
- **新文件 < 500 行**；新前端进 `public/src/web/`（各域 `*-ui.js`）、CSS 进 `public/css/` 分域段；新后端路由进 `src/server/routes/*.js`（`export function register<Name>Routes(app, deps){}`），可复用服务进 `src/server/services/`。**新增功能优先新建文件**。
- 老大文件是已知欠债（现场实测 `server.js`≈2500、`CrossVerifyDispatcher.js`/`AgentRunStore.js`≈3300 等 30+ 文件超线，以 `wc -l` 为准）：改到顺手拆，**但别为达标硬拆稳定大文件，也别往已超线文件继续加**。
- 架构骨架：前端 `app.js` 是 IIFE 壳（非 module，仅剩引导/胶水）、`main.js` ES module 入口桥 `window.PanelUtils`/`window.PanelStore`、`src/components/{Modal,UI}.js` 挂 `window`；后端全 ES module。
- 工程规范（前端禁 native `confirm/prompt/alert`，用 `toast/confirmModal/promptModal`；后端 route try/catch + `{ok:false,error}` + 合适 HTTP code；`safeResolveFsPath()` 路径沙箱；body length cap；Origin 白名单）由 `eslint.config.mjs` + pre-commit lint 在机器层强制——**按 lint 走即可，别在脑子里背这些**。安全护栏实体：`src/server/auth/origin-allow.js`、`src/server/services/path-sandbox.js`（grep 定位，别认行号）。

## 测试 = 全绿，基线只许涨
- 完成判据：`npm test`（vitest）+ `npm run test:e2e`（本地 UI walkthrough）全绿；`npm run perf-check` 性能/健康 audit；`npm run verify:handoff` 钉文档一致性与脱敏。
- **基线以最新 HANDOFF 实测为准、只许 ≥ 且全绿**（文件数/测试数高频漂移，别写死进本文件，留 HANDOFF）。
- 迭代中途可只跑受影响子集（`vitest run <path>`）省时；**milestone / push 前再跑全量 + perf-check**。
- 质量门已激活：`core.hooksPath=scripts/git-hooks`（clone 后重跑一次 `git config core.hooksPath scripts/git-hooks` 激活）。pre-commit=staged lint + 冲突标记；pre-push=全量 vitest。`--no-verify` 仅紧急。

## 多窗口协作避撞（Codex/Claude 并行是常态）
- 工作区常有别窗未提交的 "done" 改动（按 docs/ + superpowers + plans 干）。遇非本会话改动：先 `git diff` 摸意图 + 跑测试再判断，**别当撞车就停，也别静默 clobber**。
- 公共文件（`server.js` / `noe.js`）改前先看当前内容，**只动自己任务域文件，单 writer**。Codex 常驻 freedom + P8 线（走 `src/server/routes/noeFreedom.js`，由 `noe.js` import 注册）。
- 即使授权清理脏区，也别删别窗在做的工作（如 owner 的 `public/mind.*` / `public/src/web/noe-world-earth.js`）。

## 项目专属禁区（叠加全局红线）
- 不 `cat .env` / `~/.noe-panel/room-adapters.json`（含 apiKey）；查模型 key 用 `npm run noe:keys:model:check`（只打印状态不打印 secret）。
- 本地 protected/live 操作经 standing autonomy grant 自我授权：`npm run noe:autonomy:grant|check|revoke`（授权文件只存 scope/边界，不存 secret 原值）。
- git：**绝不 `git add -A`**（用 `git add <指定文件>`）；noe-main 本地领先 origin，owner 惯例 **不 push**，除非 owner 明确要求才 commit/push。
- 评测/模型调用记 `stop_reason`/truncation；单次输出被 length 截断要续写或标 incomplete，不当完整结论。

## milestone 收尾（不是每轮停下写文档）
- 连续任务跑到 milestone 再收口：更新/新建 `docs/HANDOFF_*.md`（含本轮 commit、当前基线测试数、新增 env 开关 + 点火步骤、未提交的别窗工作说明）。迭代流水顺手记 `PROGRESS_LOOP.md` / `CHANGELOG.md`（真实落点；**无 DEVLOG，别凭空建**）。
- 出事翻 `docs/RUNBOOK_出事翻这页.md`。仅当 owner 明确要无人值守续作才挂 `/loop docs/LOOP_PROMPT_Neo自主进化.md`（高耗，别每轮默认挂）。

## 工程真实性（本项目教训）
- 机制"存在"≠"活着"，断言前 grep/实测——踩过死 CI、没演练过的备份。secret 原值不入日志/报告/长期记忆/git；做过什么留可验证证据。
