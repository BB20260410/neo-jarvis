# Noe 架构地图（长期活文档）

> 给任何接手者的系统鸟瞰。**只写稳定结构**——行数/测试数这类易变数据不进本文（以现场实测为准）；
> 增量变更看 `docs/HANDOFF_*.md`，工程纪律看 `AGENTS.md` 宪法。最后校订：2026-06-10。

## 一句话

本地优先的多 AI 个人操作系统：一个 Express+WS 面板（127.0.0.1）编排多个 AI（Claude/Codex/Gemini/MiniMax/本地模型）为一个 owner 服务——能听（毫秒级 STT+唤醒词）、能说（多级 TTS 含断网兜底）、能看（截屏 VLM+OCR+人脸）、记得你（多层记忆）、守着你（主动陪伴+治理审计）。

## 进程拓扑

```
node server.js (51835 生产 / 51998 隔离实测 / 51735 是母项目别碰)
├── Express HTTP + WebSocket（Origin 白名单 + owner-token 鉴权）
├── 子进程：claude/codex/gemini CLI（PTY/spawn）、MCP servers（node 直调，~/.noe-panel/mcp-bin/）
├── 按需 spawn：insightface-embed.py（人脸）、noe-ocr.py（OCR，~/.noe-panel/ocr-venv）
└── 伴生服务（owner 手动起；doctor voice.companions 会探活红灯）
    ├── whisper  8123  STT 兜底（mlx-whisper，~/.noe-voice/bin/python scripts/noe-whisper-server.py）
    ├── kokoro   8124  英文 TTS 省配额（NOE_KOKORO=1 启用）
    └── cosyvoice 8125 中文 TTS 断网兜底（~/.noe-voice/cosyvoice/.venv/... scripts/noe-cosyvoice-server.py）
```

## 目录域（src/）

| 域 | 职责 | 关键件 |
|---|---|---|
| `voice/` | 语音对话编排 | `VoiceSession`（听→想→说→记的总管）、`SherpaSttClient`（本地流式 STT+唤醒词 KWS）、`LocalSttClient`(whisper)、`MiniMax/Kokoro/CosyVoiceTtsClient`（TTS 三级链）、`ChatProfileStore`（人格档案+self-knowledge 注入） |
| `vision/` | 视觉感知 | `VisionSession`（截屏/摄像头→VLM 摘要→记忆）、`OcrClient`（RapidOCR 精确读字）、`ScreenCapturer`、`FaceRecognition` |
| `identity/` | 身份与门禁 | `OwnerIdentityStore`（声纹/人脸主人验证）、`Voiceprint`/`VoiceVad`（注意：VAD 预处理会裁渐弱尾音）、`PersonKnowledgeStore`（人物库） |
| `memory/` | 记忆 | `MemoryCore`（SQLite FTS+向量双路召回）、`NoeMemoryCurator`（GC）、`FactExtractor`、`NoePersonCards` |
| `context/` | 上下文工程 | `NoeContextBudgeter`（注入段统一编排+token 预算）、`NoeSelfKnowledge`（能力自知，**新能力必登记**）、`NoeHostContext`（本机感知）、`NoeTrajectoryCompactor` |
| `room/` | 多 AI 协作 | `SoloChatDispatcher`(1v1+轮换建议)、`Debate/Squad/Arena/CrossVerifyDispatcher`（辩论/拆活/对决/集群共识）、`BrainRouter`（按难度路由模型） |
| `permissions/` `safety/` `approval/` | 治理 | `PermissionGovernance`（classify→ask→审批；同指纹 TTL 复用见 `NOE_APPROVAL_REUSE_TTL_MS`）、`ApprovalStore`、`DangerousPatternDetector`、审计 `ActivityLog` |
| `runtime/` | 运行时纪律 | `NoeFreedomExecutor/Adapters`（受治理自由执行，SHELL_BIN 跨平台）、`NoeProcessVitals`（死前留痕/心跳尸检）、`NoeDoctor`（体检含伴生服务探活）、`NoeHangAlert`、`NoeSecretBroker`（keychain 引用不取明文） |
| `autopilot/` `loop/` | 自主循环 | `NoeLoop`（主动陪伴 tick）、`NoeTurnFinalizer`（预算濒尽死前交接）、`NoeGenerationFence`（连发压旧防错乱）、调度 store |
| `media/` | 多媒体生成 | MiniMax 图像/音乐/视频 client + `NoeMediaStudio` 落盘门面 |
| `server/routes/` | HTTP 路由（按域拆自 server.js，持续迁移中） | 鉴权纪律：**含对话/记忆/任务内容的端点（读和写）一律 `requireOwnerToken`**，防回归测试钉死 |
| `mcp/` | MCP 客户端 | `McpClientManager`（lazy connect）；server 固定装 `~/.noe-panel/mcp-bin/`（npx 形态在本机必死，见宪法踩坑） |

## 语音链路（最常用主路径）

```
前端 noe-voice.js（VAD 连续监听｜唤醒词门控可选：先打 /api/noe/voice/wakeword）
  → POST /api/noe/voice/chat {audio}
  → VoiceSession.chat：声纹/人脸门禁 → STT（sherpa 毫秒级，whisper 运行时兜底）
  → ContextBudgeter 组装注入段（人物库/承诺/工具/动作/视觉/记忆…按 keep 预算裁剪）
  → BrainRouter 选模型 → 回复 sanitize/质检/防复读
  → TTS：首句优先（restTtsText 回前端，前端经 /api/noe/voice/tts 续播无缝接上）
       回退链 = 按语言主选 → MiniMax → CosyVoice（中文断网兜底）
  → 记忆沉淀 + 承诺抽取
```

## 数据落点（~/.noe-panel/）

`panel.db`（SQLite 主库，自动快照 backups/ 保留 7 份）· `owner-token.txt`(0600) · `mcp-servers.json` · `exec-policy.json`（trustLevel，非 default 启动会 warn）· `last-exit.json`（死前留痕）· `chat-profiles.json` · `mcp-bin/`（MCP 固定安装）· `ocr-venv/`
模型类在 `~/.noe-voice/`：sherpa 模型 `models/sherpa/` · cosyvoice 仓+venv · kokoro onnx。

## 关键 env 速查

`NOE_STT=auto|sherpa|whisper` · `NOE_WAKEWORD_THRESHOLD` · `NOE_SILERO_VAD=1`（神经网络 VAD 精筛真人声、滤噪声，默认 OFF；`NOE_SILERO_VAD_THRESHOLD` 默认 0.5）· `NOE_COSYVOICE=0`关兜底 · `NOE_KOKORO=1` · `NOE_VOICE_LLM_STREAM=1`（大脑边吐字边早合成首句 TTS，首声提前≈一次合成时长，默认 OFF）· `NOE_CONTEXT_BUDGET_TOKENS`（注入预算，默认 6000）· `NOE_ROTATE_TOKENS`（聊天房轮换阈值，默认 24k）· `NOE_CHAT_CONTEXT=1`（聊天室 1v1 接 ContextEngine：召回记忆/查人物库/跑工具桥，默认 OFF）· `NOE_APPROVAL_REUSE_TTL_MS`（审批同指纹复用窗，默认 10min，0 关）· `NOE_MEMORY_DEDUP=1`（记忆写入近重复去重/合并，默认 OFF；`NOE_MEMORY_DEDUP_THRESHOLD` 默认 0.62）· `NOE_MEMORY_DEDUP_SEMANTIC=1`（语义冲突合并"美式→拿铁"，需 `NOE_MEMORY_EMBED` 非 hash，默认 OFF；`NOE_MEMORY_DEDUP_SEMANTIC_THRESHOLD` 默认 0.82）· `NOE_VITALS_INTERVAL_MS`（心跳）· `NOE_DREAM=1` 梦境整合 · `NOE_MEMORY_GC=1|dry` · `TELEGRAM_BOT_TOKEN` · `NOE_NTFY_TOPIC`

## 质量门

本地：pre-commit=staged lint，pre-push=全量 vitest。远程：GitHub Actions `panel quality gate`（macos-14+ubuntu：lint baseline→vitest→npm audit→Playwright e2e）。实机自测一律隔离端口 51998——**起 server 前先 `lsof` 确认端口干净**（残留旧进程会让你对着旧代码调试新接口）。
