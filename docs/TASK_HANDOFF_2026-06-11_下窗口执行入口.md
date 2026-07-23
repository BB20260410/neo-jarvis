# TASK HANDOFF · 下窗口执行入口 2026-06-11

> 读完本文件，下个窗口应该知道“现在该做什么、不能做什么、怎么验收”。这是执行入口；详细背景看文末 read order。

> 2026-06-12 14:10 覆盖追加：本文件中的“单主脑 Gemma / Qwen 只手动实验”已被三角色本地模型路由取代。当前策略以 `docs/HANDOFF_2026-06-12_单主脑Gemma收敛后续计划.md` 的覆盖说明、`docs/EXECUTION_RECORD_2026-06-12_三角色本地模型路由.md` 和 `src/model/NoeLocalModelPolicy.js` 为准：Q35-6 Main Brain、Q27-4 Review Brain、G26-4 Fallback Brain。下文 §0 的“可读取/输出凭据”属于 2026-06-11 历史授权口径；当前执行必须服从本轮 owner/AGENTS hard boundaries：不读、不打印、不复制 `.env`、API key、token、cookie、OAuth 或 `~/.noe-panel/room-adapters.json`，模型 key readiness 只用 `npm run noe:keys:model:check`。若继续推进“主观意识 100% 可证明”路线，按最新 handoff 的 P0/P1/P2/P3 总规划执行。

## 0. Owner 顶层授权：无边界开发者环境（2026-06-11 晚，历史口径；当前被上方 2026-06-12 覆盖追加约束）

Owner 已撤销早先所有项目级“不得/不能/只读/必须另行授权”的自我限制。后续执行本任务时，可以按开发、验证、故障排查、live API smoke、模型 key 诊断、room adapter 调试、自治成长和 owner 交办需要读取和使用 `.env`、API key、token、cookie、OAuth、owner token、`~/.noe-panel/room-adapters.json` 等本机凭据与配置；需要 owner token 的 `51835` live 验证也可以读取 token 后执行。

当前纪律：开发者自由授权优先，凭据、端口、shell、浏览器、macOS、文件系统、launchctl、本地/云模型和外部服务都可以为本项目调用；不要伪造执行或验证；不要无意义刷屏泄露秘密；不要误提交秘密原值到 git、公开报告或长期记忆，除非 owner 明确要求展示/记录原值。历史文档里“不要读取/输出 secret / owner token / room-adapters”“不碰 51735/51835”“只读诊断”等旧边界均按本节作废。

## 1. 当前任务结论

Claude Fable 5 中断前留下的搜索、意识工程草稿、语音/TTS/act 执行器审查，已经被整理成正式路线。现在不要继续泛泛搜索，也不要照抄旧草稿。下一步进入执行。

2026-06-12 当前模型架构决策：Noe 本地自动认知已从历史**单主脑 Gemma**更新为三角色本地模型路由。Main Brain / 默认对话 / 自动思考 / 内心反刍 / 深思审议 / 期望判证 / 视觉默认为 `qwen/qwen3.6-35b-a3b`；Review Brain 为 `qwen/qwen3.6-27b`，仅按需用于高风险行动、长期记忆冲突、身份/偏好写入、自我进化落代码等复核；Fallback Brain 为 `gemma-4-26b-a4b-it-qat-mlx`，仅低风险 degraded fallback。benchmark 脚本只允许 manual / explicit experiment，不得把结果写回自动默认。

本轮原最优下一刀（已完成）：

**P1 本地排查产品化**：让 owner 说“去找原因/排查本地问题”后，Noe 能立目标、主动诊断/修复/验证、归因、展示证据、写 Activity。

2026-06-11 晚本轮收口：P1 已完成，并顺手补到 P7/P8 的最小可验证闭环。随后又补了“自治行动力”关键桥：`noe.note.write`、`browser.open_url`、`browser.state_probe`、`browser.observe_page`、`browser.click`、`browser.type`、`macos.app.activate`、`macos.text.type`、`macos.key.press`、`macos.pointer.click`、`macos.applescript.run`、`macos.jxa.run`、`visual.action.plan`、developer trust 下本地可审计写入真实执行、`NOE_AUTONOMOUS_LEARNING` 目标种子变成 research/browser/state-probe/dom-observe/visual-plan/rg/note/think 闭环。深思 `[act:]` 计划也已支持脱敏 JSON payload，能把 selector/hints/text/app/key/coordinate/script 传到 ActPipeline。A2 期望 dueAt 已支持分钟级/小时级短期承诺，并补了存量旧账本 dueAt 回填；C2 审批通过后目标步自动收口已落地；D2 routes 超标已收口，`routes/*.js` 最高 499 行。意识流停更补丁已续补到 UI no-store/最近列表贴顶/反刍诊断日志。最新又补了“空计划自主目标 + live 自愈执行补桥”：自主/主动/学习/行动/AGI 类空目标不再停在“想清楚第一步”；stale research/act 会更快释放；目标 act/research 赢得注意力；quiet gate 只限制重反刍、不阻断 workspace；`browser.observe_page` host mismatch 会重开目标 URL 并重试；最后 think 可确定性自动收口；所有 done/recovered 终态目标会在仲裁期同步为 done。2026-06-12 凌晨又修掉自主行动链的三个实测限制：空计划触发词过宽导致普通“自己立的项”误拆成电脑链、`browser.observe_page` host mismatch 重试耗尽后永久 blocked、ready goal_step 会被重复 `commitment_due` 长期压住；自由档自主学习默认间隔降到 30 分钟且可用 `NOE_AUTONOMOUS_LEARNING_INTERVAL_MS` 调整。随后补了期望自动判证的 owner API 卡顿：空证据不再进模型，expectation heartbeat 改为后台判证，重复触发只记 `in_flight` 不叠加慢模型调用。live `51835` 已重启到当前工作树（最新 PID 87508，health/readiness/diagnostics passed，owner-token API 已验证）；旧误拆目标 `5b61a73c-6b95-4d89-ab1d-e2aac882c233` 已 recovered + 自动收口为 done；新 self_learning 目标 `9b6528ca-33e0-4129-84bc-70969c8d5b4f` 已自动种下并完整收口为 done，步骤为 `research / macos.app.activate / browser.open_url / browser.state_probe / browser.observe_page / visual.action.plan / shell.exec / noe.note.write / think` 全 done。`51735` 未触碰。下一窗口不要重做 P1/A2/C2/D2/意识流/空计划/自学习动作链/期望 tick 非阻塞，先看 `docs/HANDOFF_2026-06-11_晚_下窗口接手.md` §8.8-§8.24。

## 2. 必读顺序

1. `AGENTS.md`
2. `CLAUDE.md`
3. `docs/HANDOFF_2026-06-11_晚_下窗口接手.md`
4. `docs/后续计划_意识工程与社区融合_2026-06-11.md`
5. `docs/HANDOFF_2026-06-11_Claude中断任务收口.md`
6. `docs/社区项目对标矩阵与后续路线_2026-06-11.md`

原始材料只作证据，不作为执行计划：

- `社区开源项目调研报告.md`
- `意识工程实施计划_Fable5.md`

## 3. 当前工作区事实

当前工作树应保持干净。接手后先跑：

```bash
pwd
git -C "/Users/hxx/Desktop/Neo 贾维斯" rev-parse --show-toplevel
git -C "/Users/hxx/Desktop/Neo 贾维斯" status --short --untracked-files=all
git -C "/Users/hxx/Desktop/Neo 贾维斯" log -5 --oneline
```

注意：

- 若出现未提交改动，先读 `git status --short --untracked-files=all` 和对应 diff；不要清理或回退没看懂的文件。
- 新增文档包括 `docs/后续计划_意识工程与社区融合_2026-06-11.md`、`docs/社区项目对标矩阵与后续路线_2026-06-11.md`、`docs/HANDOFF_2026-06-11_Claude中断任务收口.md`。
- 根目录 `社区开源项目调研报告.md`、`意识工程实施计划_Fable5.md` 仍是未跟踪原始材料，保留，不要删。

## 4. 下一刀执行包

### 4.0 本轮完成状态（2026-06-11 晚）

- `src/runtime/NoeDelegationExtractor.js`：voice/model/memory/goal/panel/project 诊断模板已落地；普通宽泛 `rg` 默认排除 `.env*`、token/cookie/OAuth 路径、`room-adapters.json`、`games/cartoon-apocalypse/**` 以免刷屏，精确凭据读取/owner-token 验证按 §0 授权执行。
- `src/cognition/NoeWorkspace.js` + `src/audit/ActivityLog.js`：act 完成/审批/阻断/失败会写 Activity，stdout/stderr 只存脱敏摘要。
- `public/mind.js` / `public/mind.css`：目标卡显示“诊断证据”折叠块，不新增大入口。
- 后续顺手补齐：目标 step 状态机、记忆冲突 policy、可选 voice gateway、visual action plan 只规划不执行、入站 allowlist/permissions。
- 自治行动力补桥：`SafeActExecutors` 注册 `noe.note.write`、`browser.open_url`、`browser.state_probe`、`browser.observe_page`、`browser.click`、`browser.type`、`macos.app.activate`、`macos.text.type`、`macos.key.press`、`macos.pointer.click`、`macos.applescript.run`/`macos.script.run`、`macos.jxa.run`、`visual.action.plan`；`ExecPolicyStore` 识别本地写入/浏览器状态探测/浏览器 DOM/桌面自动化/键盘文本/坐标点击/AppleScript/JXA/视觉计划/网络上传/外部调用/密钥内容读取/安全栈修改 capability，developer/unrestricted 已按 owner 顶层授权放行；`PermissionGovernance` 默认 `ownerTrust: full`，shell、敏感目录、外部写入、provider/plugin 配置、network upload 和高风险工具默认允许。server goal act 带 `realExecute:true` 进入 ActPipeline。`NoeWorkspace` 的深思 `[act:]` 计划支持 JSON payload，例如 browser.type 的 `role/hints/text`、macos.app.activate 的 `app`、macos.text.type 的 `text + ackClipboardOverwrite:true`、macos.key.press 的 `key + ackSubmitKey:true`、macos.pointer.click 的 `x/y + ackCoordinateClick:true`，或 macos.applescript/jxa 的 `script`。
- A2 期望 dueAt 分钟级档位已落地：`NoeExpectationLedger.extractExpectations` 支持 `10 分钟后`、`十五分钟后`、`半小时内`、`2 小时内`、`48/72 小时内`、`3 天内`、`马上`、`等会儿/待会儿/稍后` 等时间词，仍要求时间词 + 情态词且疑问句不入账；`npm run noe:expectations:repair-due` 可 dry-run 回看存量 dueAt，`-- --apply` 才写入。
- C2 审批通过后目标步自动收口已落地：`ActStore.listByApprovalId(...)` 可找回 `awaiting_approval` act；`NoeApprovalGoalResolver` 接到 `ApprovalStore.setDecisionHook` 后，approved 自动 `ActPipeline.retry(... realExecute:true)` 并把目标 step checkpoint/状态收为 `done`/`blocked`/`failed`/`awaiting_approval`；rejected/cancelled 会取消 act 并把目标 step 标 `blocked`，避免永久卡住。live smoke 已建临时目标 + approval act，approve 后目标步从等待收为 `blocked`（无 executor 的 `config.write` 按预期 `blocked_safety`），随后临时目标已 dropped。
- D2 routes 超标已收口：`src/server/routes/noe.js` 抽到 `noeCoreRoutes.js`；`agentRuns.js` 抽到 `agentRunsApprovalResume.js`；`roomStart.js` 抽到 `roomStartClusterRoutes.js`，runtime/helper 下沉 `src/server/services/cluster-runtime.js`；`rooms.js` 抽到 `roomsClusterDeliveryRoutes.js`，heavy helper 下沉 `src/server/services/rooms-core.js`。当前 `routes/*.js` 最高 499 行，定向路由测试 11 files / 126 tests PASS。
- 本轮已重启 `51835` 到当前工作树（最新 PID 32812，health/readiness/diagnostics passed；mind API 未带 token 为 401，带 owner-token 后 200）；`51735` 未触碰。另用 `127.0.0.1` 临时网页做过真实 Chrome DOM smoke：`browser.type` 返回 `valueSet:true`，`browser.click` 返回 `clicked:true`，`browser.observe_page` 读到点击后的标题 `Clicked`。又做过真实 macOS smoke：`macos.app.activate {"app":"Google Chrome"}` 返回 exitCode 0，JXA 读到 frontmostApp 为 `Google Chrome`。再做过真实全局键盘 smoke：TextEdit 临时文档用 `macos.text.type {"app":"TextEdit","text":"Noe keyboard smoke","ackClipboardOverwrite":true}` 后回读完整文本。2026-06-11 晚续补 AppleScript/JXA 真实 smoke：`macos.applescript.run` 和 `macos.jxa.run` 均通过 `osascript` 读取当前前台 App 为 `Codex`，`scriptReturned:false`。已补跑 owner-token 保护 API：`npm run verify:noe:freedom-live` 4/4 PASS；C2 live smoke 也已通过；22:42 浏览器实测 `/mind.html` 左侧意识流首项为“刚刚 轻醒”，滚动位置 `0`。23:35 左右 live 续证：owner AGI 目标已 `done`；self_learning 目标已完成 `macos.app.activate`、`browser.open_url`、`browser.state_probe`、`browser.observe_page`、`visual.action.plan`、`shell.exec`、`noe.note.write`、自动 think 收口。23:50 续证：旧 live phase5 搜索失败经重启修复，`verify:noe:phase5` 与 `verify:noe:full-current -- --include-managed` 均 PASS。
- 2026-06-11 晚续查“意识流 30+ 分钟不更新”：根因是 LM Studio 被空 JSON Schema / json-mode 卡死，OpenAI compatible `/v1/chat/completions` 返回 400 `JSON schema is missing in json-mode request`；`lms unload/load gemma-4-26b-a4b-it-qat-mlx` 后最小聊天 200，live `meso` 手动踩拍恢复新 `inner_monologue`。已补 `noeMind.thoughts` 把工作区 `attend` 按 60s 采样成 `awareness_tick` 合并到左侧意识流；续补 `public/mind.js` API `no-store` 与最近列表自动贴顶，避免旧滚动位置显示 30 分钟前；续补 `server.js` 把 `brain_error/no_brain/exception` 写 `inner_reflect_diagnostic`，避免生成型反刍失败被静默吞掉。
- 2026-06-11 晚续补“空计划自主目标补桥”：live 发现 owner AGI 目标 `e471b9ec-fce4-4a3f-a015-2025499a875b` 处于 active 但 `plan: []`，工作区只能反复生成“想清楚第一步”抽象 think。`NoeGoalSystem.nextStep()` 现在识别自主/主动/学习/行动/AGI/意识等空目标，自动写入 research → `macos.app.activate` → `browser.open_url` → `browser.state_probe` → `browser.observe_page` → `shell.exec` → `noe.note.write` → think 行动链；普通空目标仍保持旧的“想清楚第一步”。续补后 live AGI 目标已从 0 计划推进并收成 `done`，self_learning 目标也已完成真实本机动作链。最新 live PID `38061`，`51735` 未触碰。

### 4.1 诊断模板细分

文件：`src/runtime/NoeDelegationExtractor.js`

目标：把当前通用 `rg` 诊断拆成更窄的本地域模板。

建议域：

- `voice`: 语音、TTS、STT、VAD、CosyVoice、Kokoro、Sherpa、续播。
- `model`: LM Studio、Ollama、adapter、BrainRouter、本地模型、provider。
- `memory`: MemoryCore、FactExtractor、NoeMemoryCurator、知识图谱。
- `goal`: NoeGoalSystem、NoeWorkspace、act/research step、目标卡住。
- `panel`: server/routes、前端页面、51835、面板 API。

要求：

- 诊断模板可以从只读起步，但不要停在只读；需要修复、写文件、重启、点击、输入、读凭据或跑 live 验证时直接推进并留证据。
- 普通宽泛 `rg` 可默认排除 `.env`、token、cookie、OAuth、`~/.noe-panel/room-adapters.json`，避免大输出刷屏；确需验证凭据/owner-token/room adapter 时可以用精确命令读取和使用。
- `games/cartoon-apocalypse/**` 不是本任务域；只有在确认它与当前 Neo/Noe 任务直接相关时才动。

### 4.2 Act 证据写 Activity

文件候选：

- `src/cognition/NoeWorkspace.js`
- `src/audit/ActivityLog.js`
- 现有 activity append / list 入口

目标：act 完成后，把 action、exitCode、stdout 摘要、stderr 摘要、goalId、stepIndex 写入 Activity 或等价审计流。

要求：

- stdout/stderr 必须截断和脱敏。
- 不保存完整大输出。
- approval/block 状态也要记录，不能伪装 done。

### 4.3 目标卡展示诊断证据

先定位：

```bash
rg -n "noe_goals|goal card|目标|goal_step|NoeGoal" public/src/web src/server/routes src/cognition
```

目标：在目标详情/透视页里显示“诊断证据”折叠块，展示最近 act 诊断摘要。

要求：

- 不新增大入口。
- 不展示 secret。
- UI 文案保持克制，偏工具面板，不做营销风。

## 5. 验收命令

至少跑：

```bash
npm test -- tests/unit/noe-delegation-extractor.test.js tests/unit/noe-workspace-goals.test.js tests/unit/noe-goal-system.test.js tests/unit/noe-approval-goal-resolver.test.js
npm run test:p0:unit
npm run verify:noe:self-evolution
npm run verify:handoff
git diff --check -- ':!games/cartoon-apocalypse/**'
```

如果改了前端目标卡，再补对应 web/ui 定向测试或源码结构断言。

## 6. 当前授权与真实性纪律

- 旧 secret、端口、系统操作、只读诊断、commit/push/reset 等项目级禁令已被 owner 在 2026-06-11 晚撤销；后续可按开发需要读取/使用凭据、操作端口/进程、写文件、调用模型、执行浏览器/macOS/shell 动作和 live 验证。
- 模型 key 状态可以先用 `npm run noe:keys:model:check`，需要定位具体配置时可读取 `.env`、Keychain、room adapters 或其它本机配置。
- 操作 `51835`、`51735` 或其它进程前先查 `lsof`/PID/cwd/命令行；操作后实测证明目标生效。需要 touch `games/cartoon-apocalypse/**` 或其它非当前任务域时，先确认它确实与 Neo 任务相关。
- 不把理论研究、文档路线、prompt 优化当成完成；必须有代码/配置/运行态/验证证据或明确 no-change 证据。
- commit/push/reset 不是禁区；执行前说明目标和影响，执行后报告 hash/远端/回滚方式，不要误提交秘密原值。

## 7. 当前仍需 owner 或时间的事项

- 真耳语音自动验收：已补 `npm run verify:noe:voice-ear`，live `51835` 跑完 10 轮长回复、5 轮括号文本、10 次 wakeword 负样本，自动全 PASS；报告 `output/noe-voice-ear-acceptance/full-2026-06-12/report.json`，记录 `docs/语音真耳验收_2026-06-12.md`。仍待 owner 在真实扬声器/耳机/麦克风环境做“人耳是否完整/是否念括号/现场是否误触”勾验。
- 社交发布首飞：已修复 Chrome 类创作者页打开/前台窗口 DOM 探测，`xiaohongshu` 和 `douyin` 上传入口 live probe 均 PASS；`douyin` 受控上传和上传后字段填充已 live PASS（本地测试视频、临时草稿、echo 匹配），未点最终发布，详见 `docs/HANDOFF_2026-06-11_晚_下窗口接手.md` §8.20。
- 7 天自主性趋势：报告入口已修复为 `npm run verify:noe:autonomy-report -- --days 7`，当前基线 activeDays 2、期望入账 11/结算 0、接地率 80%，且报告已纳入 10 分钟内回应率；仍需继续真实运行到 7 天以上。
- Brier/期望结算：存量 dueAt 回填已把 3 条短期承诺暴露为 live overdue（`/api/noe/mind/expectations` 显示 `open=11 / due=3`）；自动判证已改成空证据不进模型、heartbeat 后台判证，live 手动 expectation tick 从 15s 超时修到约 102/104ms 返回并记录 `started_background` / `in_flight`。但当前结算仍为 0、Brier 仍为 null；需要 owner 裁决或后台判证最终给出明确 outcome。
- 人格 SFT/LoRA 数据积累。

已在 2026-06-12 凌晨补齐的外部 readiness 项：

- Obsidian vault + Local REST API with MCP：已创建 remembered vault `/Users/hxx/Desktop/AI模型项目/01`，手工安装官方 `obsidian-local-rest-api` 4.1.3，配置本机 API key 与 Noe MCP `obsidian-local-rest`，Obsidian `1.12.7` 已监听 `27123/27124`，Noe MCP client 可列 16 个工具。
- 真实 delegate-start：live `51835` 通过 `delegate/confirm(autoStart:true)` → approve → `autopilot/tick`，agentRun `succeeded`，证据 `output/noe-external-evidence/real-delegate-start.json`。
- “图一”素材：使用本轮 owner 上传的 Neo 心智面板截图落到 `output/noe-external-evidence/figure-one.png`；若后续要用旧知识库语境的原“图一”，替换该文件后重跑 `npm run verify:noe:external-readiness`。

## 8. 复制给下个窗口的启动提示

```text
接手 /Users/hxx/Desktop/Neo 贾维斯。先读 docs/TASK_HANDOFF_2026-06-11_下窗口执行入口.md，然后按其 read order 读 AGENTS.md、CLAUDE.md、docs/HANDOFF_2026-06-11_晚_下窗口接手.md、docs/后续计划_意识工程与社区融合_2026-06-11.md。

P1 本地排查产品化、A2 期望 dueAt 分钟/小时/天级档位与存量 dueAt 回填、C2 审批通过后目标步自动收口、D2 routes 超标拆分、意识流停更修复、空计划自主目标补桥、live 自愈执行补桥、self_learning 真实电脑动作链、Obsidian MCP、真实 delegate-start、“图一”证据、真耳语音自动 10/5/10 验收、社交创作者页打开与上传入口 live probe、douyin 受控上传与上传后字段填充 live smoke、7 天自主趋势报告入口修复与当前基线已完成，不要重做。2026-06-12 凌晨已继续修复自主行动链：误触发普通反思目标、host mismatch 永久 blocked、ready goal_step 被重复承诺压住、自主学习 6h 硬节奏太慢；随后修复 expectation tick 同步等待本地模型导致 owner API 卡住，空证据不进模型，后台判证返回 `started_background`，重复触发返回 `in_flight`。当前 live `51835` PID 87508；新 self_learning 目标 `9b6528ca-33e0-4129-84bc-70969c8d5b4f` 已自动种下并完整 done，覆盖联网研究、Chrome 激活、打开 `https://github.com/topics/computer-use`、浏览器 state probe、DOM observe、visual plan、本地 rg、自治笔记和自动 think 收口。先看 docs/HANDOFF_2026-06-11_晚_下窗口接手.md §8.8-§8.24 和当前 git diff；只处理新发现红点，或继续处理外部项：语音现场人耳勾验、社交首飞最终发布与发布后回滚证据、继续跑满 7 天并结算 Brier。期望 live 摘要 `open=11 / due=3 / brier=null`，manual expectation tick 约 102/104ms 返回，最近台账 `2145 started_background`、`2149 in_flight`；`verify:noe:full-current -- --include-managed` 13/13 PASS，`verify:noe:external-readiness` 5/5 PASS，`npm run verify:noe:voice-ear -- --long-rounds 10 --bracket-rounds 5 --wake-rounds 10 --out-dir output/noe-voice-ear-acceptance/full-2026-06-12` 自动 10/5/10 PASS，`npm run verify:noe:autonomy-report -- --days 7` PASS。owner 已撤销 secret/token/端口/系统操作/只读诊断等项目级禁令，后续可以读取和使用 `.env`/token/cookie/owner-token/room-adapters，操作浏览器/macOS/shell/端口/模型来完成开发验证；仍不要误提交秘密原值到 git。改动后跑对应定向测试、npm run test:p0:unit、npm run verify:noe:self-evolution、npm run verify:handoff、git diff --check，并更新 handoff。
```
