# HANDOFF · ContextEngine 通电窗口（2026-06-10 下午-傍晚，/loop 四迭代）

> 给下一个 AI（按你一无所知写）：本窗按 `docs/ROADMAP_后续发展规划_2026-06-10.md` 推荐顺序，把**方向二→方向一→方向三全项**做完了。AI 可自主推进的路线图项已尽，循环已主动收尾。先读 `AGENTS.md` 宪法再动手。

## 0. 一句话总账

13+1 个 commit（c3f2fba 及之前已 push；本交接文档 commit 留给活跃窗口随下次里程碑一起推），每刀过 pre-commit lint、每次 push 过 pre-push 全量 vitest。四个新功能 env 门控**全默认 OFF**。

## 1. 已完成（带验证证据）

### 方向二 · NoeTurnContextEngine 通电（地基）
- **新文件** `src/context/NoeTurnContextEngine.js`（@ts-check/全注入/<500 行）：VoiceSession._respondCore 原 12 段内联 `ctx.add` 供给（自我认知/人物库/承诺/预取/人物卡/工具桥/动作桥/身份/认人/视觉/纠错/召回）等价迁入。**供给层=本引擎，裁剪层=NoeContextBudgeter**，两层配齐。`buildPeopleBrief` 迁入引擎、VoiceSession re-export 保旧 import。
- **验证**：行为逐字不变——既有注入测试未改一字全绿；8-agent 对抗审查工作流（3 视角逐字对比 HEAD~2 旧版 + 逐条对抗复核）**等价性发现 0 坐实**；唯一坐实项「单测契约空洞」（复核者变异实测 8 处改坏全量照绿）已补：全 13 段 id/keep/顺序总契约+声纹措辞分支+视觉第三态+召回/动作桥入参透传（`tests/unit/noe-turn-context-engine.test.js` 27 项，变异复测可抓红）。
- **段级白名单 `sections`**：null=全开（语音旧行为）；数组=只跑列出的段、**白名单外连副作用都不跑**（聊天室借此关死 self-knowledge 人格污染 / action 误写记忆库）。

### 方向一 · 聊天室拉齐（`NOE_CHAT_CONTEXT=1` 默认 OFF）
- `SoloChatDispatcher` 构造注入 `contextEngine`：聊天室 1v1 注入 `['people','tool-bridge','recall']` 三段；记忆域固定 `'noe'`（room.cwd 只是预算口径）；输入截 2000 与语音同口径；引擎失败不阻断聊天。未注入=旧行为逐字不变。
- 装配点 `server.js` soloChatDispatcher 构造处（env 门控在装配点，dispatcher 本身不读 env）。
- **验证**：`tests/unit/solo-chat-context-engine.test.js` 5 项 + 51998 隔离端口实机 smoke（NOE_CHAT_CONTEXT=1 起服→HTTP 活→SIGTERM 干净退）。

### 方向三 · 记忆语义去重（`NOE_MEMORY_DEDUP_SEMANTIC=1` 默认 OFF，另需 `NOE_MEMORY_EMBED` 非 hash）
- `NoeMemoryDedup.decideSemanticConflict` 纯函数零 LLM：向量分≥0.82 且字符分<0.62 双指标，抓「换关键词矛盾」（我喜欢美式→我改喝拿铁）；近重复仍归字符路。保守铁律：跨 scope/salience≥5/短句(<6字)一律不判。
- `MemoryCore.semanticConflictSweep`：写后异步（写路径保持同步），命中走现成 `merge()` 可逆合并（旧条 hidden=merged_into:<新id> 可 unhide + merge_trace 留痕 + 清旧向量）。**hash provider 直接拒跑**防误删。
- **验证**：`tests/unit/noe-memory-dedup-semantic.test.js` 11 项（验收样例闭环/字符路不串道/hash 拒跑/保护铁律/fail-open）。阈值 0.82 是保守起点，owner 用一阵漏合并就降 `NOE_MEMORY_DEDUP_SEMANTIC_THRESHOLD`（建议每次 -0.04）。

### 方向三 · LLM 流式早鸟 TTS（`NOE_VOICE_LLM_STREAM=1` 默认 OFF）
- **adapter 层**：`OllamaChatAdapter`（NDJSON）+ `OpenAICompatChatAdapter` 基类（SSE+stream_options.include_usage，lmstudio/gemini-openai/custom 全继承）——`opts.onDelta` 回调存在才开流式，最终返回与非流式**完全同形**，上层零感知；MiniMax 原生 adapter 不支持时自动忽略零影响。
- **新文件** `src/voice/VoiceStreamEarlyTts.js` 首句探测器：判据与 `splitFirstSentence` 同口径；遇 `<think>`/harmony 泄漏永久放弃；sanitize 注入式（与整段管线同款——后续窗口给 sanitize 加的全角括号剥除等也自动作用于早鸟前缀）。
- **VoiceSession 收尾对账**：早鸟句与最终首句逐字一致才采用——质检/复读重试换答案就丢早鸟走旧路，**绝不放错音频**，最多浪费一次 TTS；栅栏已压制不浪费配额。
- **验证**：17 项单测（`tests/unit/voice-llm-stream.test.js`）+ 真机两轮：① 真 ollama 9b 档+1.2s 模拟 TTS（同次反事实口径）首声提前 **947/1200/1111ms**；② LM Studio 真机 SSE：8 增量片/首 delta 409ms/usage 真实回传/拼接一致。

## 2. 进行中

无。本窗任务域清空，循环已主动停止。

## 3. 改了哪些公共文件

- `server.js`：仅 2 处微增（import 2 行 + soloChatDispatcher 构造加 contextEngine 参数）。**未动窗口 C 拆分大区**。
- `src/voice/VoiceSession.js`：632→约 560 行（供给段换引擎调用 + 流式早鸟接线）。⚠️ **交接时另一窗口正在此文件上活跃**（已加全角括号剥除、本地模型链路修复、InnerMonologue 等 6+ commit）——VoiceSession 单 writer 现归该窗口，后续接手先 `git status`+`git log -5`。
- `ARCHITECTURE.md` env 速查 +4 开关；ROADMAP 头部进度注记；双窗口总交接 §8 全程留痕。

## 4. 等 owner 的事

1. **重启生产**：`launchctl kickstart -k gui/$(id -u)/com.noe.panel`（多窗积压改动一起生效）。
2. 想体验就开（`.env`，全默认关）：`NOE_CHAT_CONTEXT=1`（聊天室记得你）/ `NOE_MEMORY_DEDUP_SEMANTIC=1`（语义去重，需 `NOE_MEMORY_EMBED=ollama`）/ `NOE_VOICE_LLM_STREAM=1`（语音首声快 1-2s）。
3. MiniMax 真档下流式早鸟的体感验证（基准用的本地模拟 TTS，机制已证、量级吻合）。

## 5. 下一步建议（按 ROADMAP）

- **不要再造能力轮子**（ROADMAP §4 铁律）。剩余项：唤醒词真实调优（要 owner 误判样本）/ 方向五产品化（owner 定节奏；打包冒烟 CI job 是现成入口）/ 方向四前端测试（窗口 C 域，勿抢）。
- 两条房务（对抗审查 rejected 清单遗留）：① `LegacyNoeContextEngine`（src/context/NoeContextEngine.js）仍是零接线死代码——标废弃或把 uiSignals/acuiCards 独有件收编进 Turn 引擎；② 聊天室记忆按房隔离（现固定 'noe' 域）若要做需 owner 拍板分区策略。
- MiniMax adapter 流式（SSE）可照 OpenAICompat 模式补，让云档语音也吃到早鸟——边际收益小（语音默认压本地），有闲再做。

## 6. 验证入口（接手先跑）

```bash
npx vitest run tests/unit --silent                      # 全量（本窗交接时 313 文件/2544+ 全绿）
npx vitest run tests/unit/noe-turn-context-engine.test.js tests/unit/solo-chat-context-engine.test.js \
  tests/unit/noe-memory-dedup-semantic.test.js tests/unit/voice-llm-stream.test.js   # 本窗四大件
```
实机自测一律隔离端口 51998（先 `lsof` 确认干净），绝不碰 51835/51735。
