# 交接 · Claude 中断任务收口 2026-06-11

> 目的：收掉 Claude Fable 5 在额度耗尽前留下的半截工作。本文只记录已查证、已落地、仍需 owner 授权或时间自然产生证据的事项，避免把搜索报告直接当实施计划。

## 1. 中断现场复盘

- transcript 里已完成并提交的部分：委托桥、主动陪伴内在素材、前端续播修复、CosyVoice 兜底、自启、主动开口字数上限重构。对应最新提交为 `48b0b85`、`e0b35bc`、`ca57ae5`、`2a719c8`、`d3eb751`。
- transcript 中断点：`语音断声全链路审查 + TTS本地化方案 + act执行器现状，三维并行+对抗复核` 正在后台跑，但没有保存出正式产物。
- 随后 owner 要求做社区搜索、吸收方案、未完事项、发展方向和全面交接；本地只留下两个根目录未跟踪文件：
  - `社区开源项目调研报告.md`
  - `意识工程实施计划_Fable5.md`

## 2. 本次收口结论

补充完整社区搜索与后续路线的正式版本见 `docs/社区项目对标矩阵与后续路线_2026-06-11.md`。结合旧调研、意识工程草稿和最新 handoff 形成的详细执行计划见 `docs/后续计划_意识工程与社区融合_2026-06-11.md`。本文保留中断现场与工程收口摘要；后续选型、对标矩阵、P0-P6 执行顺序以这两份文档为准。

### 2.1 语音断声全链路

当前代码侧已经闭上三处原始缺口：

- 长回复只播开头：`public/src/web/noe-voice.js` 的 `playPendingRest()` 允许实时模式从 `listen` 重新进入 `speak` 播放迟到续播，不再按旧相位丢弃。
- 剩余段 TTS 偶发失败：`fetchRestAudio()` 现在自动重试一次，两次失败才在语音日志里报告。
- 主 TTS 不可用导致中文无声：`VoiceSession._synthesize()` 走主选 TTS -> MiniMax -> CosyVoice 中文本地兜底；`CosyVoiceTtsClient` 只消费本地 `/tts` JSON base64 响应，不需要读取任何 secret。

新增防回归覆盖：

- `tests/unit/voice-rest-playback-wiring.test.js` 增加“失败重试一次”源码结构断言。

仍不能由代码单方面证明的事项：

- 真耳验收：需要 owner 在真实浏览器/扬声器环境听 10 轮，确认不再只说开头、不念括号、不误触 wake word。
- 51835 生产是否已带上最新未提交代码：本次没有重启/接管 live 51835。

### 2.2 TTS 本地化方案

不建议立即另起一套 OpenMeow 替换链路。理由：

- Noe 已有 Sherpa/Kokoro/CosyVoice 三段式链路，且 CosyVoice 已通过本地 HTTP JSON base64 客户端接入。
- OpenMeow 更适合作为后续可选网关，价值在 OpenAI-compatible `/v1/audio/*`、模型管理、macOS 菜单栏后台运行，而不是马上重写 `VoiceSession`。
- 下一步若立项，应该先加 `OpenAICompatibleVoiceGatewayClient` 注入式适配器，默认 OFF，通过 `NOE_VOICE_GATEWAY_BASE_URL=http://127.0.0.1:23333/v1` 手动启用；不要删除现有 CosyVoice 兜底。

### 2.3 act 执行器现状

Claude 原桥只会把“帮我查/找原因”变成 `research` 步。对“本地模型、语音系统、代码、文件、面板、端口、测试”等本地排查型委托，这会继续走搜索/文字归纳，仍然不能先读本地项目证据。

本次已补：

- `src/runtime/NoeDelegationExtractor.js`：本地排查型 owner 委托先生成只读 `shell.exec`/`rg` act 步，再生成归因 `think` 步；外部资料型委托仍保持 `research`。
- `src/cognition/NoeWorkspace.js`：act 步执行结果会把 `exitCode/stdout/stderr` 压缩进步骤 note。
- `src/cognition/NoeGoalSystem.js`：后续步骤会收到前序完成步骤的 `priorNotes`，所以第二步“归因思考”能看到第一步 `rg` 的真实证据。

这直接覆盖 owner 报障：“让他找原因，他只表面回答，无法主动读文件/查代码”。

### 2.4 社区搜索与吸收方案

已用官方 GitHub 页面复核核心项目存在性和定位。采纳顺序如下：

| 优先级 | 项目 | 官方源 | Noe 应吸收 | 当前裁决 |
|---|---|---|---|---|
| P0 | Khoj | https://github.com/khoj-ai/khoj | 自托管个人 AI、文档/网页问答、定时自动化、Obsidian 入口 | 借鉴产品形态和 Obsidian 集成，不搬 Python 栈 |
| P0 | Mem0 | https://github.com/mem0ai/mem0 | 长期记忆抽取、更新、冲突处理、遗忘策略 | 借鉴算法与评估口径，落到 `NoeMemoryCurator`/MemoryCore |
| P0 | Letta | https://github.com/letta-ai/letta | stateful agent、memory block、agent 自编辑记忆 | 借鉴记忆版本化和 agent state，不接入需要云 key 的默认 API |
| P0 | UI-TARS Desktop | https://github.com/bytedance/UI-TARS-desktop | VLM + GUI/browser/computer operator、事件流可观测 | 作为“看+操作”目标，不直接给 Noe 放开桌面手 |
| P0 | OpenMeow | https://github.com/finch-xu/openmeow | macOS 原生 TTS/ASR 网关、OpenAI-compatible voice API | 做可选语音网关适配器，不替换当前兜底 |
| P1 | LangGraph | https://github.com/langchain-ai/langgraph | durable execution、checkpoint/resume、状态图 | 只借鉴目标执行状态机，不迁 Python 框架 |
| P1 | LiteLLM | https://github.com/BerriAI/litellm | 多 provider 统一网关、成本追踪、guardrails | 作为 BrainRouter adapter 设计参考，不新增依赖 |
| P1 | Open Interpreter | https://github.com/openinterpreter/openinterpreter | 低成本/开放模型编码 agent、sandbox/approval docs | 对照 Noe act sandbox 和审批，不替换 Codex 执行位 |

不建议采纳或暂缓：

- 直接按 `意识工程实施计划_Fable5.md` 拉 `qwen2.5:32b`：模型选择已过时且可能倒退；应以本机 LM Studio/Ollama 当前可用模型和 `npm run doctor:noe:models` 为准。
- 直接建 launchd plist：项目已存在 51835 live 守护/重启流程；本轮没有 owner 明确授权去改系统级调度。
- 让内心独白直接触发行动：会破坏当前“反刍克制 + act 明示声明 + ActPipeline 门控”的安全边界。

## 3. 后续发展路线

### P0 先做小闭环

1. 继续保留 owner 委托 -> 本地只读诊断 act -> 证据归因 think 的链路。
2. 给常见本地任务逐步加更窄的只读诊断动作：语音、模型、记忆、目标、面板路由。
3. 真耳验收通过后，再考虑 OpenMeow 适配器；未通过前先修现有链路。

### P1 记忆与目标执行

1. 以 Mem0/Letta 为参考，给 MemoryCore 增加“更新/冲突/遗忘”评估，不先换存储。
2. 以 LangGraph 为参考，把目标执行状态显式化：checkpoint、resume、blocked reason、approval wait。
3. 把 act 步的 stdout/stderr 证据进一步转成 Activity 可见证据，而不是只进 goal note。

### P2 桌面操作与浏览器操作

1. UI-TARS 只作为设计参考：先做 VLM grounding + 操作预演 + owner approve，再允许真实操作。
2. Browser/computer 操作必须沿用现有 PermissionGovernance/ActPipeline 审批，不允许模型绕过。

## 4. 仍需 owner 或外部条件

- `51835` live 重启或接管：本次没有执行，除非 owner 明确授权。
- `51735`：完全不触碰。
- 真实外部发布、Obsidian vault、社交首飞、真实桌面 GUI 操作：都需要 owner 授权或真实凭据/素材。
- 7 天自主性趋势、Brier/期望结算、回应率：只能靠 Noe 持续运行产生时间证据，不能由一次代码修改伪造。

## 5. 验证目标

本收口完成后至少应通过：

- `node --check src/runtime/NoeDelegationExtractor.js src/cognition/NoeGoalSystem.js src/cognition/NoeWorkspace.js src/voice/CosyVoiceTtsClient.js`
- `npm test -- tests/unit/noe-delegation-extractor.test.js tests/unit/noe-goal-system.test.js tests/unit/noe-workspace-goals.test.js tests/unit/voice-rest-playback-wiring.test.js tests/unit/cosyvoice-tts-fallback.test.js tests/unit/voice-stream-tts.test.js tests/unit/voice-llm-stream.test.js tests/unit/noe-proactive-tick.test.js`
- `npm run test:p0:unit`
- `npm run verify:noe:self-evolution`
- `npm run verify:handoff`
- `git diff --check -- ':!games/cartoon-apocalypse/**'`

## 6. 当前边界声明

- 未读取 `.env`、API key、owner token、cookie、OAuth 或 `~/.noe-panel/room-adapters.json`。
- 未重启、kill、接管 `51835`。
- 未触碰 `51735`。
- 未触碰 `games/cartoon-apocalypse/**`。
- 未 commit / push。
