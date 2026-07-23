# Noe 语音交流 + 实时互动实现蓝图（达到并超越 BaiLongma）

生成：2026-06-03（接手会话，基于 BaiLongma 镜像审计 + 本地模型/实时语音 6 路并行深度研究）
硬件前提：Apple M5 Max 128GB（强本地算力）；资源：GPT + Claude 各 $200/月 + MiniMax 订阅
边界：BaiLongma 是**只读参考**（当协议/参数字典用，禁 copy 代码）；Noe 自研旁挂。

## 0. 总判断（一句话路线）

走**级联管线（VAD → 流式 STT → 大脑 LLM → 流式 TTS）+ 服务端 barge-in 打断**，**不用** speech-to-speech 黑盒——因为级联能复用 Noe 现有全套 adapter/dispatcher 当大脑、保留文字日志可审计、可任意换模型。语音做成**旁挂 `src/voice/` 子系统**，不碰大脑路由；STT/TTS 全用 **M5 Max 本地 MLX 模型（独立子进程、零 token、绝不进 Node 主进程）**，中文实时不达标时云端兜底。大脑**三档难度路由**：本地 Qwen3 兜底 ~90% 流量（零成本），MiniMax 中端，GPT/Claude 只接复杂 L3——这是省 token 的核心杠杆。

## 1. 架构（五层级联）

```
①前端采播层  public/src/web/voice-ui.js
   AudioWorklet 采 16kHz PCM · AudioContext 边收边播 · VAD 端点提示
        │ WS /ws/voice（二进制音频帧 + JSON 控制帧）
②传输层      server.js 新增 /ws/voice 分支（照抄 /ws/term 双向骨架，过 _checkWsToken）
        │
③语音 I/O 层  src/voice/  ← 全部 fetch 本地 HTTP 微服务，不在 Node 跑模型
   Silero VAD 切句 → 本地 STT 出 partial/final 文本 ┐  TTS 流式出音频块 ┘
        │
④大脑路由层  src/voice/BrainRouter.js  三档难度选 adapterId
        │
⑤编排层      复用 soloChatDispatcher 实例（不新建 dispatcher）
```

**一轮数据流**：麦克风 PCM →WS→ Silero VAD 切语音段+判 turn → 本地 STT 文本 → BrainRouter 选大脑档 → `soloChatDispatcher.sendMessage(roomId, 文本)` → 大脑回复（监听该房 `broadcastRoom` 的 `chat_ai_msg`）→ 剥 markdown → 本地 TTS 流式 →WS→ 前端边收边播。

**打断（barge-in）数据流**：TTS 播放时麦克风不关、环形预缓冲 1500ms 不发；AnalyserNode 逐帧测振幅 → 连续 3 帧高=duck 压音量 → duck 中再 10 帧高=真人说话 → **三处同时取消**（`soloChatDispatcher.abort(roomId)` + 停 TTS 生成 + 清前端播放 buffer）+ 预缓冲补发不丢开头；6 帧迅速低=冲击噪音恢复不打断；3.5s 无结果=误触发续播。

**🔒 进程隔离铁律**：STT/TTS/VAD 一律跑成本地 HTTP/WS 微服务（Python/Swift 子进程，仿 BaiLongma `manager.js` 守护），Noe 只发 fetch。**绝不把模型推理塞进 Node/Electron 主进程**（better-sqlite3 同步写盘 + WS 广播 + PTY 都在主进程，推理会阻塞事件循环导致全面板卡死，重演 ccusage 卡死 talagentd 的教训）。

## 2. 技术选型（M5 Max 128GB，全具体到项目名）

| 环节 | 首选 | 备选 | 说明 |
|---|---|---|---|
| **VAD** | Silero VAD v5（独立常驻，5MB，40μs/块） | — | 绝不用 STT 当 VAD（浪费 10-100×） |
| **STT 中文** | SenseVoice Small（MLX，CER 10.78% **胜** Whisper Large-V3 12.55%，118× 实时，300MB） | WhisperKit（CoreML+ANE，WER 2.2%，真流式）/ large-v3-turbo（809MB，~650ms） | SenseVoice 非流式需 VAD 先切句 |
| **STT 云兜底** | 阿里 Paraformer-realtime-v2（<100ms 首字节真流式） | 腾讯/讯飞 | 仅本地中文实时不达标时；签名全在后端，前端零凭据 |
| **TTS 首选（MVP 时 A/B 试听用户定）** | **MiniMax speech-2.6**（已订阅同 key、零额外账号、40+ 语种、零样本克隆、端到端 <250ms 行业顶尖、专为 voice agent） + **豆包 Seed-TTS 2.0**（用户喜欢的声音、可克隆声线） | 两个都接成可插拔 provider | **声音好听以用户试听为准**；MiniMax 已订阅可零成本先试，豆包需开火山引擎账号；可不同场景用不同声音 |
| **TTS 离线/省钱备选** | Kokoro-82M MLX（45ms，免费，**仅 2 中文声线偏机械**） | CosyVoice2-0.5B（MOS 4.7 可克隆，Mac 待 MLX） | 仅断网/极省钱时用，音质达不到豆包/MiniMax |
| **本地大脑/手脚** | Qwen3-30B-A3B（MoE，130 tok/s，工具调用 93%+，256K 上下文） | Qwen3-32B Q4_K_M（100 tok/s）/ Qwen3-8B（200 tok/s 做苦力） | Ollama 0.19+ 开 `OLLAMA_USE_MLX=1`，量化底线 Q4_K_M |
| **自托管语音服务** | mlx-audio（Blaizzy/mlx-audio，统一 STT+TTS，OpenAI 兼容） | speech-swift（soniqo，Swift 原生，/v1/realtime WS） | 起本地端口，VoiceGateway 走 WS/HTTP 接 |

## 3. 多模型大脑/手脚路由（省 token 核心）

**核心思路**：GPT/Claude 大脑只做规划/推理/拍板；本地 Qwen3/MiniMax 手脚做预处理/工具/闲聊；cross_verify 只在高价值交付任务上用，绝不每轮烧 token。

**`src/voice/BrainRouter.js` 三档难度路由**（扩展现成 `MiniMaxSuggestionRouter.classifyM3SuggestionTask` 的 `LOCAL_EXECUTION_PATTERNS`）：
- **L1** 闲聊/确认/复述/简单查 → 本地 Qwen3-30B-A3B（OllamaChatAdapter，零成本零延迟）
- **L2** 一般问答/轻推理/中文写作 → MiniMax（已有 MiniMaxChatAdapter，订阅额度）
- **L3** 多步规划/代码/深推理/拍板 → GPT/Claude（Codex/ClaudeSpawnAdapter）

**关键省 token 本质**：语音对话 90% 是 L1/L2，真正烧 GPT/Claude 的 L3 占比小。业界按难度分级路由省 **40-70%** 成本、难任务质量损失 <2%。

**四个 token 杠杆**：
1. 难度分级路由（最大）——日常对话压本地，不碰付费大脑
2. 本地小模型做苦力——焦点分类/记忆查重/关键词抽取/ASR 后处理/剥 markdown/意图路由全转 Qwen3-8B，GPT/Claude 一概不碰
3. prompt 拆分（仅对 Claude）——稳定 system 吃满 prefix cache + 每轮变化塞 user `<context>` 块；对接 Claude 加 `cache_control`（注意 Anthropic 规则：显式标记 + 5min TTL + 最低 1024 token，不能照搬 BaiLongma 的 DeepSeek 经验值）
4. NoeLoop 空 TICK 不调大脑 + TICK 自主判断用本地模型 + 守红线绝不在 TICK 里 spawn claude -p

**意图二级分流**：实时闲聊/问答 → SoloChat+本地大脑（低延迟）；语音下达可交付工程任务（"帮我把 X 实现并验收"）→ 后台异步 CrossVerify/Collaboration，语音只播进度。**严禁 cross_verify 接每句实时语音**（单轮数十次模型调用、700K-1.2M token 预算阈值，会瞬间烧爆+延迟几十秒）。

## 4. Noe 对接（精确到文件/行）

**复用（零改大脑）**：
- `soloChatDispatcher`（server.js:2032）当对话主循环，`VoiceSession` 调其 `sendMessage(roomId, text)`，不新建 dispatcher
- 打断复用 `soloChatDispatcher.abort(roomId)`（:66）+ `activeAborts` Map（:48）——LLM 取消已现成
- 监听该房 `broadcastRoom`（:1572）的 `chat_ai_msg`（:164）拿 reply 喂 TTS
- 共享 `roomAdapterPool`（:1860 的 Map），本地大脑 `map.set` 一行全局可用
- `MemoryCore.write`（:116）/`FocusStack.push`（:50）做语音记忆沉淀；`NoeLoop` tickHandler（:1659 已挂）做主动开口
- `RoomAdapter.chat` 外层已自带 Budget/CircuitBreaker/Bulkhead/RateLimiter/AbortSignal——本地模型并发闸免费拿
- `ToolRegistry`（:1632 已注册内置只读工具）让本地模型执行查文件/查记忆，大脑只决策

**新增 5 文件**：`src/voice/VoiceSession.js`（会话编排器）、`LocalSttClient.js`、`LocalTtsClient.js`（仿 OllamaChatAdapter 的 fetch+AbortController+timeout）、`BrainRouter.js`（三档路由）、`src/server/routes/voice.js`（registerVoiceRoutes，try/catch + requireOwnerToken）。

**改 3 处**：① server.js WS upgrade（:4673）加 `/ws/voice` 分支（照抄 /ws/term :4722，**不用** /ws/global 只读单播）+ 装配区（:2032 后）new VoiceSession + registerVoiceRoutes + buildRoomAdapters（:1860）加本地大脑；② public/index.html 挂麦克风按钮 + 引 voice-ui.js；③ electron-main.js（:282）加 `session.setPermissionRequestHandler` 放行 media（当前完全没有，必加）。**零新 npm 依赖**（STT/TTS 是进程外本地 HTTP 服务）。

**持续意识 + 主动开口（超越 BaiLongma 纯被动）**：三时态注入（现在=绝对时间+存在时长 / 过去=最近对话+actionLog 防重复动作 / 未来=到期提醒）；NoeLoop actMode 空闲时检查 FocusStack 待办/MemoryCore 到期提醒主动 TTS 播报——**死守克制：默认沉默、只有真新事才开口、30 分钟冷却**，否则变"焦虑的自动播报系统"。

## 5. 分阶段路线（每阶段可独立交付，建在已有 dispatcher/memory 上无大重构）

- **阶段0 准备**（半天，需你同意装本地服务）：起 mlx-audio/speech-swift 跑 STT/TTS HTTP 微服务 + Ollama 升 0.19+ 拉 qwen3:30b-a3b，命令行先验证微服务可用（不碰 Noe）
- **阶段1 MVP 最小闭环**（1-2 天，零 token 零 npm）：新增 src/voice/ 三件套 + /ws/voice + 前端麦克风（先 PTT 按住空格最可靠），转写文本喂现成 soloChatDispatcher，大脑先用已常驻 Ollama，TTS 先 Kokoro 整句播。**目标：能说一句、Noe 文字回、念出来**
- **阶段2 大脑分级+手脚分流**（1-2 天，开始省 token）：上 BrainRouter 三档，L3 切 Claude/Codex，读文件/查记忆注册为 readonly tool 交本地模型，spawn-CLI 大脑配语音垫话掩盖延迟
- **阶段3 流式+VAD 自动断句**（2-3 天）：STT 出 partial 边说边显示、TTS 句级流式、Silero VAD 替代 PTT、AudioWorklet 替 ScriptProcessor。目标暖态 <1s
- **阶段4 barge-in 打断**（2-3 天，体验天花板，工程深坑）：两阶段 duck 状态机 + 三处取消链；阈值经验值做成 localStorage 可调
- **阶段5 主动性+人格化**（2-3 天，超越点）：NoeLoop actMode 主动播报 + 三时态注入 + 长期记忆人格化
- **阶段6 多模型协作语音化**（2-3 天，Noe 独有杀手锏）：语音下达可交付任务 → 后台异步 CrossVerify/Collaboration，语音播报结论

## 6. 达到 / 超越 BaiLongma

**追平**：语音=I/O 适配器不碰大脑（Noe 复用 SoloChatDispatcher，工程量比 BaiLongma 从零写小）；barge-in 两阶段 duck；TICK 心跳+三时态注入+焦点栈（Noe 已有 NoeLoop+MemoryCore+FocusStack）。

**超越**：
1. **本地 STT 质量碾压**——BaiLongma 默认 Whisper small（为 Windows 普通机）；Noe 用 SenseVoice（中文 CER 胜 Whisper Large-V3）/ large-v3-turbo，MLX Metal 加速
2. **本地大脑当手脚省 token**——BaiLongma 单 Agent 一个大脑；Noe 用 Qwen3-30B 兜底 90% 流量+做苦力，GPT/Claude 只接 L3（BaiLongma 没有真正本地模型层）
3. **多模型协作语音化**——Noe 有 CrossVerify/Debate/Collaboration/Arena 全套，多模型辩论结论可语音播报（BaiLongma 架构上做不到）
4. **工程结构**——BaiLongma 单体 1626 行 index.js；Noe 按域拆 39 routes + Provider 抽象 + 韧性栈，语音旁挂可整体回滚
5. **平台契合**——BaiLongma Windows-only + Python whisper；Noe macOS+MLX 原生吃满 M5 Neural Accelerator，本地语音全栈暖态 250-700ms

**不抄**：数字意识/觉醒期/启动自检表演性流程；写死的未来模型名（MiniMax-M2.7/deepseek-v4，2026-06 不存在）；单体巨文件；Windows NSIS 打包。

## 7. 需你裁定（实现前）

1. **装本地语音微服务**（红线：起常驻服务）——mlx-audio/speech-swift + Ollama 升级。是整个方案地基，建议同意。
2. **STT 中文方案**：A) 本地 SenseVoice（零成本/隐私/非流式需 VAD）B) 阿里 Paraformer 云（<100ms/烧 API）。建议默认 A，不达标再加 B。
3. **TTS 中文音色（MVP 时 A/B 试听用户定）**：MiniMax speech-2.6（用户已订阅、同 key 零额外账号、<250ms 专为 voice agent）与 豆包 Seed-TTS 2.0（用户喜欢的声音、需开火山引擎）**两个都接成可插拔 provider，同句话试听让用户选**。MiniMax 已订阅可零成本先试；声音好听以用户实感为准，不预判。两家都支持声音克隆，可后续克隆用户想要的任意声线。本地 Kokoro 降为断网/省钱备选。可不同场景用不同声音。
4. **barge-in 是否第一版做**：建议先 PTT 跑通验证价值，barge-in 放阶段 4。
5. **TTS 是否允许偶尔走 MiniMax 烧配额**（红线4）：建议默认全本地、显式开启高质量模式才用。
6. **改 server.js 需重启 panel**（红线：不自主重启）——每次改完告知你执行。
7. **Electron 麦克风权限**——macOS 首次弹系统授权需你同意一次（正常授权）。
8. **安全边界**——语音是新输入入口，/ws/voice 强制 _checkWsToken，现有 PermissionGovernance/ActPipeline fail-closed 护栏对语音同样生效，不因本地麦克风放松鉴权。
