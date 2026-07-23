# Noe 任务交接 — 2026-06-05（给接手 AI / Codex 直接续作）

> 你是接手 Noe 项目开发的 AI。读完本文件就能进入状态、直接继续未完成的任务。

## 📌 接手第一步（按顺序读）
1. **本文件** — 任务现状 + 待办 + 怎么继续
2. **`CLAUDE.md`** — 项目工程约束 / 红线（**必读，覆盖默认行为**）
3. `docs/Noe上网搜索与移植收尾计划_2026-06-05.md` — 后续 5 阶段详细计划
4. `docs/Odysseus可移植模块评估报告_2026-06-05.md` — 移植决策依据（哪些该做/不该做）

**项目**：Noe / Neo 贾维斯 — 本地优先个人 AI 助手。Node ES module + Express + Electron，端口 51835，入口 `~/Desktop/Neo 贾维斯`。

---

## ✅ 当前完成摘要（2026-06-05 14:58）

- 搜索/研究已接入 `/api/noe/do`、`public/cognitive.html`、`VoiceSession`，默认优先 MiniMax Search API。
- Codex/Claude CLI 搜索 fallback 已修正并真实 smoke，默认仍关闭，只有显式 env 才 spawn。
- SkillExtractor 自动提炼、Noe 派活确认链、ActPipeline 安全执行脚手架已完成。
- 文件整理 execute/undo 后会 best-effort 同步统一知识库索引。
- Karpathy/Obsidian/开源知识库研究已落地为 LLM Wiki：`raw/` 4 条研究笔记、`wiki/` 4 个概念页、模板、ingest/lint/query CLI、只读 API，并已接入 `/api/noe/do` 本地知识意图。
- 51835 已重启到当前代码，当前 live 9/9、managed 10/10；新增总验收、前端验收、语音 transcript 单测、LLM Wiki raw 质量门和 managed 派活 confirm 验收；51735 未触碰。

## ⏳ 当前剩余动作

- Obsidian MCP：需要用户先提供真实 vault + Local REST API key；当前不能自动获取，也不写 placeholder key。
- Obsidian MCP 自检已加：`npm run obsidian:mcp:check`，只读报告缺 vault / Local REST API listener / Noe MCP 注册；优先接 Local REST API 插件内置 MCP，第三方 MCP 备用。
- Obsidian MCP dry-run 配置已加：`npm run obsidian:mcp:plan`，只输出脱敏模板，不写 key、不注册、不安装。
- 自动语音证据已过：合成音频 → 本地 whisper → Noe voice text route；物理麦克风 UI 权限如需可再复测。
- Noe 派活真实启动：需要用户审批预算/执行。
- “图一”未提供；若要纳入研究，需要用户发图或给文件路径。

---

## 🔧 关键技术细节（接手必读）

### 重启 panel（反复踩坑！改后端必做）
```bash
for p in $(lsof -ti:51835); do kill -9 $p; done   # 先停占 51835 的旧进程
sleep 2; lsof -ti:51835                            # 确认归零（应为空）
cd "/Users/hxx/Desktop/Neo 贾维斯" && npm start     # 再启
```
**坑**：反复 `npm start` 会残留旧进程跑旧代码（=改了不生效的元凶）。`dotenv` 只启动读一次，改 `.env` 必重启。**别误杀 51735**（那是母项目 Xike Lab，不是 Noe）。

### 测试命令
```bash
npm run test:p0:unit     # P0 单元门，当前 Tests 58 passed
npm run verify:noe:full-current  # 当前总验收；Obsidian/真实派活/图一缺证据会标 external_blocked，不算代码失败
npm run verify:cognitive # Playwright 验证 cognitive Wiki/搜索/研究入口与本地 Wiki 按钮
npx vitest run tests/unit/research-websearch.test.js tests/unit/hwfit.test.js tests/unit/skill-extractor.test.js   # 移植模块 24 测试
npx eslint <file>        # lint（应 0 error）
node --check <file>      # 语法
```

### 已就绪的 API（都要 owner-token）
Header：`X-Panel-Owner-Token: $(cat ~/.noe-panel/owner-token.txt)`
```
POST /api/noe/research/search  {query,count}          单次搜索（优先 MiniMax）
POST /api/noe/research/fetch   {url,maxChars}         抓网页正文
POST /api/noe/research/deep    {question,maxRounds}   多步研究（SSE 流）
GET  /api/noe/research/status                         搜索源状态
GET  /api/noe/hwfit/recommend                         硬件荐模型
POST /api/noe/skills/extract   {messages,dryRun}      技能提取
```

### 红线 / 约束（CLAUDE.md，**务必遵守**）
- **不 spawn `claude -p` / `codex -p` 子 LLM 烧配额**（你自己就是 agent，别再 spawn 子 LLM 做生产任务）
- **不 commit / push 除非用户明说**；`.env` 有 `MINIMAX_API_KEY`，**绝不进 git**（commit 前自查 diff）
- **改代码前必 Read 原文件**；**文件 < 500 行**；**不加新依赖**（除非用户同意）
- 系统级文件（/etc、plist、launchctl、~/.zshrc、PATH）、网络底层（hosts/DNS/代理）— 红线，别碰
- 改 server.js / src/ 后端 → 告知用户需重启（用户在场可直接重启）

---

## ✅ Codex 续作完成记录（2026-06-05 11:13）

本轮已经按“后续计划”继续推进，以下内容已落地并通过测试：

1. **阶段二完成**：`/api/noe/do` 已接搜索/研究意图，`public/cognitive.html` 已接搜索/研究入口，`VoiceSession` 已接语音搜索/研究播报。搜索层优先 `AISearch`/MiniMax。
2. **阶段三 T3.1 完成**：`AutoSkillExtractor` 已挂到房间完成事件，默认只生成 disabled skill draft，走本地 adapter，不阻塞房间广播。
3. **阶段三 T3.2 安全版完成**：新增 `TaskIntentRouter` + `/api/noe/delegate/plan` + `/api/noe/delegate/confirm`。确认后只创建 idle 待启动房间；`autoStart:true` 只生成 pending approval，不启动 CLI、不调度、不烧配额。
4. **阶段四 T4.1/T4.2 安全脚手架完成**：`ActPipeline` 支持 registered executor + `approvalId + realExecute:true` 后继续执行；新增 `SafeActExecutors`：
   - `file.write_text`：路径沙箱、拒绝 `.env`/`.git`/`node_modules`、内容大小限制。
   - `shell.safe_exec`：argv-only、命令白名单、git/npm 子命令白名单、timeout、输出截断、剥离常见密钥环境变量。

### 本轮新增/修改重点文件

- `src/server/routes/noeDo.js`
- `src/server/routes/noeDelegation.js`
- `src/room/TaskIntentRouter.js`
- `src/room/TaskDelegationPlanner.js`
- `src/loop/SafeActExecutors.js`
- `src/loop/ActPipeline.js`
- `src/voice/VoiceSession.js`
- `public/cognitive.html`
- `server.js`
- `tests/unit/routes/noe-delegation-routes.test.js`
- `tests/unit/noe-act-executors.test.js`

### 验证结果

```bash
npm run test:p0:unit
# 13 files, 58/58 passed

node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run \
  tests/unit/ai-search.test.js \
  tests/unit/research-websearch.test.js \
  tests/unit/hwfit.test.js \
  tests/unit/skill-extractor.test.js \
  tests/unit/auto-skill-extractor.test.js \
  tests/unit/task-intent-router.test.js \
  tests/unit/routes/noe-delegation-routes.test.js \
  tests/unit/noe-voice-session.test.js \
  tests/unit/noe-act-executors.test.js \
  tests/unit/noe-act-pipeline.test.js \
  tests/unit/noe-act-pipeline-safety.test.js \
  tests/unit/noe-act-pipeline-failure-branches.test.js \
  tests/unit/routes/noe-act-routes-status.test.js
# 13 files, 69/69 passed
```

前端轻量渲染检查：`http://127.0.0.1:51835/cognitive.html` 移动宽度 390px 下无输入栏横向溢出，搜索/研究按钮可见。未重启 panel；401 日志是未带 owner token 的后台请求。

### 仍需用户/下个窗口注意

- 已改 `server.js` 和后端 route，**必须重启 51835 panel** 才能让新后端 API 生效；不要误杀 51735。
- 本轮没有 commit/push，没有改 `.env`/`.env.local`。
- `claude -p` / `codex -p` 子 LLM spawn 仍未自动启用。多 AI 房间启动仍必须走用户手动确认/正常房间启动链。

---

## ✅ Codex 续作完成记录（2026-06-05 11:24）

在 11:13 记录后又补齐了两个未闭合点：

1. **阶段一 T1.4/T1.5 补齐**：`AISearch` 现在的明确 provider 顺序为 `MiniMax → Codex CLI → Claude CLI → SearXNG → Brave`。
   - Codex/Claude CLI provider 默认关闭。
   - 只有 `NOE_AI_SEARCH_CODEX_CLI=1` 或 `NOE_AI_SEARCH_CLAUDE_CLI=1` 显式打开后才会进入链路。
   - CLI 调用为 argv spawn，不走 shell；环境变量只保留 `PATH/HOME/TMPDIR/LANG/LC_*` 等基础项，避免把 `.env` 密钥传入子进程。
   - 本轮没有实际 spawn Codex/Claude CLI。
2. **阶段三 T3.2 补齐到“确认后可启动链”**：`autoStart:true` 的 Noe 派活现在会创建：
   - pending manual approval
   - `start_noe_delegate` autopilot job
   - `noe_delegate_autostart` agent run
   审批通过后，由 `NoeDelegationAutostart` handler 走预算门；chat 房通过 `SoloChatDispatcher.sendMessage()` 发送首条任务，debate/squad/arena 走现有 `startRoomFromAutopilot()`。确认 route 本身仍不直接启动。

### 新增/修改重点文件

- `src/research/AISearch.js`
- `src/research/WebSearch.js`
- `src/autopilot/NoeDelegationAutostart.js`
- `src/server/routes/noeDelegation.js`
- `server.js`
- `tests/unit/ai-search.test.js`
- `tests/unit/research-websearch.test.js`
- `tests/unit/noe-delegation-autostart.test.js`
- `tests/unit/routes/noe-delegation-routes.test.js`
- `tests/unit/routes/noe-do-routes.test.js`
- `docs/Noe后续计划完成审计_2026-06-05.md`
- `scripts/noe-phase5-runtime-verify.mjs`
- `package.json` (`verify:noe:phase5`)

### 最新验证结果

```bash
npm run test:p0:unit
# 13 files, 58/58 passed

node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run \
  tests/unit/ai-search.test.js \
  tests/unit/research-websearch.test.js \
  tests/unit/hwfit.test.js \
  tests/unit/skill-extractor.test.js \
  tests/unit/auto-skill-extractor.test.js \
  tests/unit/task-intent-router.test.js \
  tests/unit/noe-delegation-autostart.test.js \
  tests/unit/routes/noe-delegation-routes.test.js \
  tests/unit/routes/noe-do-routes.test.js \
  tests/unit/noe-voice-session.test.js \
  tests/unit/noe-act-executors.test.js \
  tests/unit/noe-act-pipeline.test.js \
  tests/unit/noe-act-pipeline-safety.test.js \
  tests/unit/noe-act-pipeline-failure-branches.test.js \
  tests/unit/routes/noe-act-routes-status.test.js
# 15 files, 75/75 passed

npm run verify:noe:phase5
# 当前 51835 旧进程下失败，报告：output/noe-phase5-runtime/phase5-runtime-1780630337106.json
# 重启 51835 后复跑，作为阶段五 live 证据
```

真实 MiniMax 搜索验证（未打印密钥）：`source=minimax`，`viaModel=MiniMax Search API`，`count=2`，首条结果有 URL。

### 当前边界

- 仍需重启 51835 panel 才能让后端新代码生效。
- 当前 51835 PID 62708 仍是旧 node 进程；`verify:noe:phase5` 已证明健康接口可用但新研究/派活/认知入口未生效。
- Codex/Claude CLI 搜索和 Noe 派活自动启动都必须由用户显式开关/审批触发；默认不会烧配额。
- 未 commit/push，未改 `.env`/`.env.local`。
- 完成审计见 `docs/Noe后续计划完成审计_2026-06-05.md`。

---

## ✅ Codex 续作完成记录（2026-06-05 11:48）

在不重启用户当前 51835 旧进程的前提下，补齐了阶段五隔离运行态验收：

1. `scripts/noe-phase5-runtime-verify.mjs` 新增 `--managed` 模式：
   - 使用临时 HOME、临时 SQLite DB、随机非保留端口启动当前工作树 `server.js`。
   - 自动读取隔离 owner token，跑同一组阶段五检查。
   - 完成后关停临时 Noe 服务并清理临时 HOME。
   - 保留默认 live 模式不变：`npm run verify:noe:phase5` 仍检查当前 51835。
2. 修复验收脚本误判点：
   - `cognitive.html` 非 JSON 响应从保留 1000 字符改为保留 50000 字符，确保能检查文件尾的 `cognitive-research.js` 入口。
   - 运行报告中的服务日志会脱敏启动 URL token；已检查 `output/noe-phase5-runtime/*.json` 无 owner token 泄漏。

### 最新验证结果

```bash
npm run verify:noe:phase5 -- --managed
# 7/7 passed
# report: output/noe-phase5-runtime/phase5-runtime-1780631247094.json
# mode=managed, source=minimax, viaModel=MiniMax Search API

npm run test:p0:unit
# 13 files, 58/58 passed

node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run \
  tests/unit/ai-search.test.js \
  tests/unit/research-websearch.test.js \
  tests/unit/hwfit.test.js \
  tests/unit/skill-extractor.test.js \
  tests/unit/auto-skill-extractor.test.js \
  tests/unit/task-intent-router.test.js \
  tests/unit/noe-delegation-autostart.test.js \
  tests/unit/routes/noe-delegation-routes.test.js \
  tests/unit/routes/noe-do-routes.test.js \
  tests/unit/noe-voice-session.test.js \
  tests/unit/noe-act-executors.test.js \
  tests/unit/noe-act-pipeline.test.js \
  tests/unit/noe-act-pipeline-safety.test.js \
  tests/unit/noe-act-pipeline-failure-branches.test.js \
  tests/unit/routes/noe-act-routes-status.test.js
# 15 files, 75/75 passed
```

### 仍需用户动作

- 真实 51835 仍是旧进程 PID 62708；按 CLAUDE.md 红线，Codex 未擅自重启。
- 用户重启 51835 后，运行 `npm run verify:noe:phase5` 获取 live 模式 7/7 证据。
- Codex/Claude CLI 搜索和派活真实启动仍必须由用户显式开关/审批；自动语音证据已过。

---

## ✅ Codex 续作完成记录（2026-06-05 11:58）

继续按“后续计划全部完成”的审计口径补齐一个代码侧漏项：深度研究 SSE 路由此前只由模块单测间接覆盖，未直接覆盖 `/api/noe/research/deep` 的 SSE 事件流。

### 本次小补丁

- `src/server/routes/research.js`：允许注入 `webSearch` / `researcher`，生产默认仍是 `createAISearch()` + `createDeepResearcher()`。
- `tests/unit/routes/research-routes.test.js`：新增 deep research SSE route 单测，覆盖 `start/progress/result/done` 事件。
- `tests/unit/routes/noe-do-routes.test.js`：新增 `/api/noe/do` 的 deep research intent 单测，确保“研究一下 X”走 injected researcher，不落到 MCP。

### 最新验证结果

```bash
npm run test:p0:unit
# 13 files, 58/58 passed

node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run \
  tests/unit/ai-search.test.js \
  tests/unit/research-websearch.test.js \
  tests/unit/hwfit.test.js \
  tests/unit/skill-extractor.test.js \
  tests/unit/auto-skill-extractor.test.js \
  tests/unit/task-intent-router.test.js \
  tests/unit/noe-delegation-autostart.test.js \
  tests/unit/routes/research-routes.test.js \
  tests/unit/routes/noe-delegation-routes.test.js \
  tests/unit/routes/noe-do-routes.test.js \
  tests/unit/noe-voice-session.test.js \
  tests/unit/noe-act-executors.test.js \
  tests/unit/noe-act-pipeline.test.js \
  tests/unit/noe-act-pipeline-safety.test.js \
  tests/unit/noe-act-pipeline-failure-branches.test.js \
  tests/unit/routes/noe-act-routes-status.test.js
# 16 files, 77/77 passed

npm run verify:noe:phase5 -- --managed
# 7/7 passed
# report: output/noe-phase5-runtime/phase5-runtime-1780631859070.json
# mode=managed, source=minimax, viaModel=MiniMax Search API

npm run verify:noe:phase5
# live 当前失败，报告：output/noe-phase5-runtime/phase5-runtime-1780631660280.json
# 原因：51835 仍是旧后端进程；静态 cognitive.html 已更新，但 /api/noe/research/status 和 /api/noe/do 新 intent 未生效。
```

### 当前边界不变

- 未重启 51835，未误杀 51735。
- 未 commit/push/stage，未改 `.env`/`.env.local`。
- 未 spawn Codex/Claude CLI；真实派活启动仍需用户显式审批，自动语音证据已过。

---

## ✅ Codex 续作完成记录（2026-06-05 12:03）

继续审计 `docs/Noe动手干活与知识库整合计划_2026-06-05.md`，补齐阶段 1/4 的文件索引同步闭环：

1. `src/server/routes/noeDo.js`
   - 整理执行 `fs_organize_execute` 成功后，best-effort 调 `fs_organize_sync({ batch_id, reason:'execute' })`。
   - 撤销 `fs_organize_undo` 成功后，best-effort 调 `fs_organize_sync({ batch_id, reason:'undo' })`。
   - `fs_organize_sync` 不存在或失败时不阻断移动/撤销，只在响应里返回 `sync:{attempted,ok,error}`。
2. `tests/unit/routes/noe-do-routes.test.js`
   - 覆盖整理 confirm 后 sync 成功。
   - 覆盖 sync 不可用时执行仍成功。
   - 覆盖撤销后 sync。

### 最新验证结果

```bash
npm run test:p0:unit
# 13 files, 58/58 passed

node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run \
  tests/unit/ai-search.test.js \
  tests/unit/research-websearch.test.js \
  tests/unit/hwfit.test.js \
  tests/unit/skill-extractor.test.js \
  tests/unit/auto-skill-extractor.test.js \
  tests/unit/task-intent-router.test.js \
  tests/unit/noe-delegation-autostart.test.js \
  tests/unit/routes/research-routes.test.js \
  tests/unit/routes/noe-delegation-routes.test.js \
  tests/unit/routes/noe-do-routes.test.js \
  tests/unit/noe-voice-session.test.js \
  tests/unit/noe-act-executors.test.js \
  tests/unit/noe-act-pipeline.test.js \
  tests/unit/noe-act-pipeline-safety.test.js \
  tests/unit/noe-act-pipeline-failure-branches.test.js \
  tests/unit/routes/noe-act-routes-status.test.js
# 16 files, 80/80 passed

npm run verify:noe:phase5 -- --managed
# 7/7 passed
# report: output/noe-phase5-runtime/phase5-runtime-1780632207977.json
# mode=managed, source=minimax, viaModel=MiniMax Search API
```

### 剩余不可由 Codex 擅自完成

- 真实 51835 仍是旧进程 PID 62708；未重启。
- 51735 仍在 PID 54215；未触碰。
- Obsidian MCP 需用户先安装 Obsidian + Local REST API 插件并提供本机 API 配置。
- Codex/Claude CLI 搜索开关、Noe 派活真实启动需要用户显式授权/操作；自动语音证据已过。

---

## ✅ Codex 续作完成记录（2026-06-05 12:05）

继续审计 `docs/知识库方法论研究与落地_2026-06-05.md`，补齐文档中写“已落地”但磁盘未找到的 Karpathy LLM Wiki 最小结构。

新增：

- `knowledge/llm-wiki/CLAUDE.md`：维护规则、ingest/lint/page 规范。
- `knowledge/llm-wiki/raw/.gitkeep`：append-only 原始素材入口。
- `knowledge/llm-wiki/wiki/index.md`：概念页目录。
- `knowledge/llm-wiki/wiki/log.md`：append-only 维护日志。

边界：

- 未接 Obsidian MCP；它需要用户先安装 Obsidian + Local REST API 插件并提供 API 配置。
- 未写入任何 Obsidian API key、MCP env 或 `.env`。

---

## ✅ Codex 续作完成记录（2026-06-05 13:25）

用户已授权运行态动作后，继续完成阶段五验证和 CLI fallback 修正。

新增/修正：

1. `src/research/AISearch.js`
   - Codex CLI fallback 默认参数从错误的 `codex -p <prompt>` 修为 `codex --search --ask-for-approval never exec --sandbox read-only --ephemeral <prompt>`。
   - Claude CLI fallback 默认参数修为 `claude --print --permission-mode dontAsk --allowedTools WebSearch --disallowedTools Bash,Edit,Write,Read --output-format text --no-session-persistence <prompt>`。
   - `safeEnv()` 仍剥离 API key，只补 `USER` / `LOGNAME` 以允许 Claude 读取本机登录态。
2. `tests/unit/ai-search.test.js`
   - 覆盖 Codex 新参数。
   - 覆盖 Claude constrained WebSearch 参数。
3. 运行态
   - 使用 `PANEL_RESTART_FORCE_DIRECT=1 PANEL_NO_OPEN=1` 重启 51835，未触碰 51735。
   - 当前 51835 listener PID：9471；51735 仍保留 PID：54215。
   - `/tmp/noe-panel-51835-start.log` 已确认 token 脱敏。

### 最新验证结果

```bash
npm test -- tests/unit/ai-search.test.js
# 1 file, 4/4 passed

NOE_AI_SEARCH_CODEX_CLI=1 NOE_AI_SEARCH_CODEX_TIMEOUT_MS=180000 node --input-type=module ...
# Codex fallback smoke passed: count=1, source=codex, hasUrl=true

NOE_AI_SEARCH_CLAUDE_CLI=1 NOE_AI_SEARCH_CLAUDE_TIMEOUT_MS=180000 node --input-type=module ...
# Claude fallback smoke passed: count=1, source=claude, hasUrl=true

npm run verify:noe:phase5
# live 7/7 passed
# report: output/noe-phase5-runtime/phase5-runtime-1780637019063.json
# baseUrl=http://127.0.0.1:51835, source=minimax, viaModel=MiniMax Search API
```

### Obsidian MCP 当前结论

- 本机未发现 Obsidian 进程，`127.0.0.1:27123` 未监听。
- `~/Library/Application Support/obsidian/obsidian.json` 仅记录一个旧 vault：`/Users/hxx/Desktop/AI模型项目/01`，但该路径当前不存在。
- `/Users/hxx/Desktop` 与 `/Users/hxx/Documents` 下未发现 `.obsidian`；未发现 Local REST API 插件配置或 API key。
- `~/.noe-panel/mcp-servers.json` 当前只注册 `unified-kb`，未注册 Obsidian MCP。
- 因此不能自动获取 Obsidian MCP API；不要写 placeholder key。若后续需要接 Obsidian，先安装/打开 Obsidian vault 和 Local REST API 插件，再把 key 接入 MCP 配置。
- 最新取舍：Local REST API 插件已提供内置 Streamable HTTP MCP（`/mcp/`），Noe 的 MCP 客户端已支持 `http` transport；优先接插件内置 MCP，`@cyanheads/obsidian-mcp-server` 只作备用。

---

## ✅ Codex 续作完成记录（2026-06-05 13:58）

按用户要求继续完成 Karpathy / Obsidian / 开源社区知识库研究与低负担复刻。

新增/修正：

1. `src/knowledge/LLMWiki.js`
   - 新增确定性 `ingestWiki()`：`raw/` 研究笔记 → `wiki/*.md` 概念页 + `wiki/index.md` + `wiki/log.md`。
   - 新增 `lintWiki()`：检查孤立页、缺来源、坏本地链接。
   - 新增 `searchWiki()`：只读检索概念页，返回 title/file/score/snippet。
2. CLI
   - `npm run wiki:ingest`
   - `npm run wiki:lint`
   - `npm run wiki:query -- <query>`
3. Noe API
   - `GET /api/knowledge/llm-wiki/search?q=...&topK=...`，owner-token，只读，不触发模型、不烧配额。
   - `/api/noe/do` 支持 `localWiki:true` 或 Karpathy/Obsidian/知识库类本地问题优先查 LLM Wiki。
4. `knowledge/llm-wiki/`
   - 新增 `templates/raw-research.md`、`templates/concept.md`。
   - 新增 4 条 raw 研究笔记：Karpathy LLM Wiki、Obsidian optional UI layer、open-source triage、Noe operating model。
   - 已生成 4 个概念页：`karpathy-llm-wiki-method.md`、`obsidian-optional-ui-layer.md`、`open-source-triage-for-noe-knowledge.md`、`noe-llm-wiki-operating-model.md`。
5. `docs/知识库方法论研究与落地_2026-06-05.md`
   - 重写为当前事实版，包含可复刻清单、经验萃取、ROI 路线图、价值评估表、开源证据和明确放弃项。
   - GitHub API 实测记录：`claude-obsidian`、`llm-wiki-compiler`、`obsidian-mcp-server`、`haiku.rag`、Smart Connections、Copilot、Templater、Dataview。

### 最新验证结果

```bash
npm test -- tests/unit/obsidian-mcp-readiness.test.js tests/unit/noe-external-readiness.test.js tests/unit/llm-wiki.test.js tests/unit/routes/knowledge-evidence-routes.test.js tests/unit/routes/noe-do-routes.test.js
# 5 files, 27/27 passed

npm run wiki:ingest
# rawCount=4, pageCount=4

npm run wiki:lint
# ok=true, checked=4, issues=[]

npm run obsidian:mcp:check
# read-only check：当前不通过；旧 vault 不存在，27123/27124 未监听，未注册 Obsidian MCP

npm run wiki:query -- Karpathy wiki
# first hit: Karpathy LLM Wiki Pattern

npm run verify:noe:phase5 -- --managed
# 10/10 passed
# report: output/noe-phase5-runtime/phase5-runtime-1780643593950.json

PANEL_RESTART_FORCE_DIRECT=1 PANEL_NO_OPEN=1 ... scripts/restart-panel.mjs
# 51835 restarted, current PID 74484; 51735 remains PID 54215

npm run verify:noe:phase5
# live 9/9 passed
# report: output/noe-phase5-runtime/phase5-runtime-1780642502391.json
# LLM Wiki first hit: Karpathy LLM Wiki Pattern

Playwright mobile check
# cognitive.html has btnLocalWiki, no horizontal overflow, click returns Obsidian local Wiki answer

npm run verify:noe:full-current -- --include-managed
# passed；report: output/noe-full-current/full-current-1780645267425.json
```

### 当前边界

- 没有 commit/push/stage。
- 没有写 `.env`、Obsidian API key、MiniMax key、owner token。
- 没有安装 Obsidian 插件、没有新增 npm 依赖、没有 launchd/cron/background watcher。
- `scripts/restart-panel.mjs` 已自动脱敏启动日志里的 `?t=` token；当前 `/tmp/noe-panel-51835-start.log` 已复扫无明文 token。
- Obsidian MCP 仍是条件接受：必须用户先提供真实 vault + Local REST API key。
- “图一”未在当前上下文提供，未作为证据；提供后应放入 `knowledge/llm-wiki/raw/` 后重新 ingest/lint。
