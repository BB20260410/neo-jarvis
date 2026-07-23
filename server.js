// Noe — 多 Claude 会话管理后端
// 不用 pty（macOS arm64 binding 问题），用 claude stream-json API 模式
// 每条用户消息 = spawn 一次 claude --resume <sid> --input-format stream-json，pipe stdin/stdout

// 前置 env 装载（必须保持为第一个 import；死火教训与覆盖语义见模块内注释）。
import './src/bootstrap/load-env.js';

// 2026-05：让 panel 内 fetch（minimax/lemon/polar 等外网 API）自动走系统代理。
//   背景：很多用户开 Clash/Mihomo TUN 模式，DNS 被劫持到 fake IP 段 198.18.0.x；curl 走 TUN 透明代理能连，
//   但 Node undici 不自动读 HTTPS_PROXY，会直连 fake IP → fetch failed。
//   EnvHttpProxyAgent 自动读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY env，没设这些时行为不变（无副作用）。
import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';
if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy) {
  // 强健（2026-06-10 launchd 实损教训）：带代理变量但缺 NO_PROXY 时兜底护回环——
  // launchd 的 zsh -lc 只读 .zprofile 不读 .zshrc，曾出现 http_proxy 在而 NO_PROXY 丢，
  // 面板请求本机 LM Studio(1234)/ollama(11434)/whisper(8123) 全被绕去走 Clash 挂死。
  // 只在完全没设 NO_PROXY 时补默认值；用户设过就完全尊重。
  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = '127.0.0.1,localhost,::1';
    process.env.no_proxy = process.env.NO_PROXY;
    console.warn('[proxy] 检测到代理变量但缺 NO_PROXY，已兜底排除回环地址（本机服务直连）');
  }
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

// Noe autonomy profile（2026-06-11 owner 指令：开发期给 Noe 足够生存/进化/动手空间）。
// 旧实现把关键器官分散在十几个 `NOE_* === "1"` 开关后面：模型有能力，但目标/工作区/act/心跳任一未开
// 都会表现成“只会聊天，不主动搜索，不主动动手”。这里统一给本项目一个开发者自由默认档：
// - 未显式配置时，核心自主器官默认通电；
// - 用户/测试/部署可用 `NOE_AUTONOMY_PROFILE=off` 或单个 `NOE_*=0` 精确关闭；
// - 边界由 owner 顶层授权与工程真实性纪律决定；需要凭据、端口、系统动作或外部服务时直接做证据闭环。
const NOE_AUTONOMY_DEFAULTS = Object.freeze({
  NOE_CONTINUITY: '1',
  NOE_HEARTBEAT: '1',
  NOE_INNER_MONOLOGUE: '1',
  NOE_WORKSPACE: '1',
  NOE_GOALS: '1',
  NOE_GOAL_ACT: '1',
  NOE_DELEGATION: '1',
  NOE_CURIOSITY: '1',
  NOE_DRIVES: '1',
  NOE_AFFECT: '1',
  NOE_AFFECT_DESATURATE: '1',
  NOE_EXPECTATIONS: '1',
  NOE_EXPECTATION_AUTORESOLVE: '1',
  NOE_JUDGE_EMBEDDING: '1', // P1-A：judge 证据接 embedding 语义召回（owner 决策认知开关默认开启；双代理两轮验收通过、修 source=surprise 死链）
  NOE_EXPECT_DECISIVE_REASK: '1', // decisive reask 二次复核（R2+R3 整改后与 embedding 解耦、不互相误触发）
  NOE_EXPECT_LOOSEN_FAIL: '1', // P1-B：放宽失败信号识别（result=cancelled 等终态负面词被 judge 据实判 0）
  NOE_OWNER_PREDICTION: '1', // P1-B：owner 行为预测作业（预测 owner followup→judge 据实判 outcome，闭环冷启动燃料）
  NOE_MEMORY_EMBED: 'ollama',
  NOE_MEMORY_EMBED_MODEL: 'qwen3-embedding:0.6b',
  NOE_STREAM_V2: '1',
  NOE_INNER_SPEAK: '1',
  NOE_CIRCADIAN: '1',
  NOE_NARRATIVE_SELF: '1',
  NOE_PROACTIVE_INNER: '1',
  // 高频自主档：内部思考/目标推进/主动学习要连续泵起来；外放说话仍由 proactive cooldown/quiet gate 克制。
  // 5s 轻醒是“接上下一拍”的节奏，不代表 5s 并发烧一次重模型；重反刍有 in-flight/cooldown 门。
  NOE_INNER_INTERVAL_MS: '5000',
  NOE_IDLE_INNER_INTERVAL_MS: '15000',
  NOE_GROWTH_INNER_INTERVAL_MS: '5000',
  NOE_PROACTIVE_TICK_MS: '10000',
  NOE_PROACTIVE_COOLDOWN_MS: '120000',
  NOE_AFFECT_TICK_MS: '10000',
  NOE_EXPECTATION_RESOLVE_MS: '600000',
  NOE_WORKSPACE_DELIBERATIONS_PER_DAY: '192',
  NOE_AUTONOMOUS_LEARNING: '1',
  // 阶段0 止血（自主学习空耗修复，M3+Claude 多模型研究 DB 实证倒逼）：60s→15min 降频 15× + 关连续链
  //   （done 后等间隔不立即重立），先停止「6 主题无限轮回烧配额打转」；治本（修活好奇回路供给端 +
  //   修记忆回流 + 动态选题）随后分阶段做。研究方案见 docs/research/_{m3,claude}-自主学习方案.md。
  NOE_AUTONOMOUS_LEARNING_INTERVAL_MS: '900000',
  NOE_AUTONOMOUS_LEARNING_CONTINUOUS: '0',
  // 阶段3 动态选题默认启用：饱和冷却 + round-robin 跳过已学够的 topic，治「6 主题死循环」。
  //   NOE_DYNAMIC_TOPICS=0 可回退 cursor%6（curator OFF 逐字回退零回归）。
  NOE_DYNAMIC_TOPICS: '1',
  // 2026-07-18：聊天 1v1 默认接通 TurnContext（记忆/inner-state）；显式 NOE_CHAT_CONTEXT=0 可关。
  NOE_CHAT_CONTEXT: '1',
  // 进化目标供给：信号权重 + 静态偏置（降 test_gap）默认通电。
  NOE_SELFEVO_SIGNAL_WEIGHTING: '1',
});
const noeAutonomyProfile = String(process.env.NOE_AUTONOMY_PROFILE || 'free').toLowerCase();
if (!['off', '0', 'false', 'minimal'].includes(noeAutonomyProfile)) {
  const applied = [];
  for (const [key, value] of Object.entries(NOE_AUTONOMY_DEFAULTS)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  if (applied.length) {
    console.warn(`[noe-autonomy] profile=${noeAutonomyProfile} 默认通电：${applied.join(', ')}；显式设 NOE_AUTONOMY_PROFILE=off 或 NOE_*=0 可关闭`);
  }
}

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
// 第31批：spawn 随 claude-runner（sendMessageToClaude）迁出后不再使用
import { spawnSync as _spawnSyncForBin } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
// 第30批：readFileSync/writeFileSync/copyFileSync/chmodSync/renameSync 随 sessions 持久化迁出后不再使用
// 第34批：rmSync 随 Noe 维护循环群（旧日志清理）迁出后不再使用
import { readdirSync, statSync, mkdirSync, existsSync, unlinkSync } from 'fs';
import { createSignalRetentionWeightProvider } from './src/room/NoeSelfEvolutionSignalWeights.js';
import { homedir } from 'os';
// 第31批：LoopGuard/DangerousPatternDetector/FocusChain/AgentStateMachine/CostTracker
// 随 claude-runner 子系统迁至 src/server/services/claude-runner(-support).js，不再直接 import
import { MiniMaxAdapter } from './src/watcher/MiniMaxAdapter.js';
import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel } from './src/model/NoeLocalModelPolicy.js';
import { OllamaAdapter } from './src/watcher/OllamaAdapter.js';
import { ClaudeWatcherAdapter } from './src/watcher/ClaudeWatcherAdapter.js';
import { CodexWatcherAdapter } from './src/watcher/CodexWatcherAdapter.js';
import { loadWatcherConfig, saveWatcherConfig, maskedConfig } from './src/watcher/WatcherConfig.js';
import { WatcherDispatcher } from './src/watcher/WatcherDispatcher.js';
import { ChatRoomStore } from './src/room/ChatRoomStore.js';
import { DebateDispatcher } from './src/room/DebateDispatcher.js';
import { CollaborationDispatcher } from './src/room/CollaborationDispatcher.js';
import { CrossVerifyDispatcher } from './src/room/CrossVerifyDispatcher.js';
import { metricsStore } from './src/metrics/MetricsStore.js';
import { roomTemplatesStore } from './src/templates/RoomTemplatesStore.js';
import { webhookStore, maskWebhookUrl } from './src/webhook/WebhookStore.js';
import { fireWebhooks, testWebhook } from './src/webhook/WebhookDispatcher.js';
// S18-2a：webhook routes 提取到独立 module
import { registerWebhookRoutes } from './src/server/routes/webhook.js';
// S18-2b：archive routes 提取
import { registerArchiveRoutes } from './src/server/routes/archive.js';
import { registerPluginsRoutes } from './src/server/routes/plugins.js';
import { registerTermRoutes } from './src/server/routes/term.js';
import { registerFilesRoutes } from './src/server/routes/files.js';
import { registerProjectsRoutes } from './src/server/routes/projects.js';
// S18-2c：mcp routes 提取（内部创建 McpClientManager）
import { registerMcpRoutes } from './src/server/routes/mcp.js';
// S18-2d：autopilot routes 提取
import { registerAutopilotRoutes } from './src/server/routes/autopilot.js';
// S18-2f：skills routes 提取
import { registerSkillsRoutes } from './src/server/routes/skills.js';
// S18-2g：knowledge routes 提取
import { registerKnowledgeRoutes } from './src/server/routes/knowledge.js';
// S18-2e1：room-templates routes 提取（rooms 子集，简单依赖）
import { registerRoomTemplatesRoutes } from './src/server/routes/roomTemplates.js';
// S18-2e2：rooms 5 个主 CRUD（list/create/get/delete/patch）— advanced endpoints 仍留 server.js
import { registerRoomsRoutes } from './src/server/routes/rooms.js';
import { registerVersionRoutes } from './src/server/routes/version.js';
import { checkVoiceCompanionServices } from './src/runtime/NoeDoctor.js';
import { registerWatcherRoutes } from './src/server/routes/watcher.js';
import { registerRoomAdaptersRoutes } from './src/server/routes/roomAdapters.js';
// v0.81 真做：sessions 只读 endpoint 拆出
import { registerSessionsReadonlyRoutes } from './src/server/routes/sessions-readonly.js';
// S23：sessions 域 19 条内联路由拆出（核心 CRUD/中断/导出收藏 fork → sessions.js；
// ctx/snapshot/handoff/external/spawn-batch → sessionsContinuum.js）
import {
  registerSessionsCoreRoutes,
  registerSessionsControlRoutes,
  registerSessionsExtrasRoutes,
} from './src/server/routes/sessions.js';
import {
  registerSessionsContinuumRoutes,
  registerSessionsSpawnBatchRoutes,
} from './src/server/routes/sessionsContinuum.js';
import { createSessionCapacityCounter } from './src/server/services/session-capacity-counter.js';
// B-005 v0.9：AI markdown 图片本地缓存
import { registerImgCacheRoutes } from './src/server/routes/img-cache.js';
import { registerPromptsRoutes } from './src/server/routes/prompts.js';
import { registerSafetyRoutes } from './src/server/routes/safety.js';
import { registerHooksRoutes } from './src/server/routes/hooks.js';
import { registerMetricsRoutes } from './src/server/routes/metrics.js';
import { registerDocsRoutes } from './src/server/routes/docs.js';
// v1.0 Task 1.1：telemetry endpoint
import { registerTelemetryRoutes } from './src/server/routes/telemetry.js';
// Round 4 P0：plugin/PTY/WS 这些会跑任意进程的入口必须 owner-token 防本机其他 UID 进程 curl 拿 RCE
import { requireOwnerToken, verifyOwnerTokenString, getOrCreateOwnerToken } from './src/server/auth/owner-token.js';
import { buildAllowedOrigins, isOriginAllowed } from './src/server/auth/origin-allow.js';
// v1.5 Task 3.1：license endpoint
import { registerLicenseRoutes } from './src/server/routes/license.js';
// v1.5 Task 3.3：Lemon Squeezy / Polar payment webhooks
import { registerPaymentWebhookRoutes } from './src/server/routes/payment-webhooks.js';
// v2.0 Task 4.1：SQLite 数据底座
import { registerStorageRoutes } from './src/server/routes/storage.js';
import { registerActivityRoutes } from './src/server/routes/activity.js';
import { registerBudgetRoutes } from './src/server/routes/budgets.js';
import { registerApprovalRoutes } from './src/server/routes/approvals.js';
import { registerUnifiedTasksRoutes } from './src/server/routes/unifiedTasks.js';
import { registerProjectContextRoutes } from './src/server/routes/projectContext.js';
import { registerDelegationRoutes } from './src/server/routes/delegations.js';
import {
  abortAndFlushActiveRoomDispatchers,
  prepareClusterRunGate,
  recoverClusterRuntimeAfterNonFatalError,
  registerRoomStartRoutes,
  runClusterRuntimeWatchdogOnce,
} from './src/server/routes/roomStart.js';
import { registerRoomRequirementsRoutes } from './src/server/routes/roomRequirements.js';
// S23：rooms-advanced 域 14 routes 提取（report/runtime-processes/task-ops/lifecycle/forward/quick/media+chat）
import {
  registerRoomsLifecycleRoutes,
  registerRoomsReportRoutes,
  registerRoomsRuntimeProcessesRoutes,
  registerRoomsTaskOpsRoutes,
} from './src/server/routes/roomsAdvanced.js';
import { registerRoomsForwardRoutes, registerRoomsQuickRoutes } from './src/server/routes/roomsForward.js';
import { registerRoomsMediaRoutes } from './src/server/routes/roomsMedia.js';
import {
  registerOpsMetricsHealthRoutes, registerOpsMetricsDeleteRoutes,
  registerOpsHealthProcessesRoutes, registerOpsLoginClaudeRoutes,
} from './src/server/routes/ops.js';
import { registerGovernanceRoutes } from './src/server/routes/governance.js';
import { registerAgentRegistryRoutes } from './src/server/routes/agentRegistry.js';
import { registerAgentRunRoutes } from './src/server/routes/agentRuns.js';
import { registerCodebaseIndexRoutes } from './src/server/routes/codebaseIndex.js';
// v2.0 Task 4.2：向量索引
import { registerEmbeddingsRoutes } from './src/server/routes/embeddings.js';
// v2.0 Task 4.3：workspace 多空间隔离
import { registerWorkspaceRoutes } from './src/server/routes/workspaces.js';
// v2.0 final：商品化准备状态
import { registerCommercialSetupRoutes } from './src/server/routes/commercial-setup.js';
// v2.0 final + 1: Keychain 密码代理（panel 自动填密码到 Chrome，密码不进 LLM 对话）
import { registerAutoFillRoutes } from './src/server/routes/auto-fill.js';
// v2.0 final + 2: Lemon Squeezy API 集成（查 store / orders / 自动注册 webhook）
import { registerLemonSqueezyRoutes } from './src/server/routes/lemonsqueezy.js';
import { registerNoeRoutes } from './src/server/routes/noe.js';
import { createCommitmentStore } from './src/runtime/NoeCommitmentStore.js';
import { createPersonCardStore } from './src/memory/NoePersonCards.js';
import { createPrefetchStore } from './src/prefetch/NoePrefetchStore.js';
import { collectHostContext, setCachedHostContextBlock } from './src/context/NoeHostContext.js';
import { createMemorySemanticIndex } from './src/memory/NoeMemorySemanticIndex.js';
import { resolveNoeMemorySemanticConfig } from './src/memory/NoeMemorySemanticConfig.js';
import { createHangAlertMonitor } from './src/autopilot/NoeHangAlert.js';
import { createStickyEventBuffer } from './src/runtime/NoeStickyEvents.js';
import { buildUpdateDrainSnapshotFromReaders } from './src/runtime/NoeUpdateDrainState.js';
import { createNtfyPusher } from './src/runtime/NoeNtfyPush.js';
import { NoeBackgroundReviewRunner } from './src/runtime/NoeBackgroundReview.js';
import { createNoeBackgroundReviewHook } from './src/runtime/NoeBackgroundReviewHook.js';
// P0-8b: 静态 import,原动态 fire-and-forget 改同步 + 显式 catch 日志(失败可见)
import { installProcessVitals } from './src/runtime/NoeProcessVitals.js';
import * as ErrorReporter from './src/telemetry/ErrorReporter.js';
import { registerResearchRoutes } from './src/server/routes/research.js';
import { registerSkillExtractRoutes } from './src/server/routes/skillExtract.js';
import { registerOpenaiCompatRoutes } from './src/server/routes/openai-compat.js';
import { archiveStore } from './src/archive/ArchiveStore.js';
import { generateReport, defaultReportPath } from './src/report/RoomReporter.js';
import { mcpStore } from './src/mcp/McpStore.js';
import { skillStore } from './src/skills/SkillStore.js';
import { createAutoSkillExtractor } from './src/skills/AutoSkillExtractor.js';
import { knowledgeStore } from './src/knowledge/KnowledgeStore.js';
import { evidenceKnowledgeStore } from './src/knowledge/EvidenceKnowledgeStore.js';
import { agentRunStore } from './src/agents/AgentRunStore.js';
import { breakers } from './src/safety/CircuitBreaker.js';
import { autopilotStore } from './src/autopilot/AutopilotStore.js';
import { AutopilotController } from './src/autopilot/AutopilotController.js';
import { autopilotScheduleStore } from './src/autopilot/AutopilotScheduleStore.js';
import { AutopilotScheduler } from './src/autopilot/AutopilotScheduler.js';
import { makeDelegationAutostartHandler } from './src/autopilot/DelegationAutostart.js';
import { makeNoeDelegationAutostartHandler } from './src/autopilot/NoeDelegationAutostart.js';
import { budgetPolicyStore } from './src/budget/BudgetPolicyStore.js';
import { delegationStore } from './src/delegation/DelegationStore.js';
import { activityLog } from './src/audit/ActivityLog.js';
import { approvalStore } from './src/approval/ApprovalStore.js';
import { MemoryCore } from './src/memory/MemoryCore.js';
import { FocusStack } from './src/memory/FocusStack.js';
import { EpisodicTimeline } from './src/memory/EpisodicTimeline.js';
import { NoeSelfModel, inferMood } from './src/context/NoeSelfModel.js';
import { NoePersonaPins } from './src/memory/NoePersonaPins.js';
import { createMoodAnalyzer, createCachedMoodInferrer } from './src/context/NoeMoodAnalyzer.js';
import { createNarrativeSelf } from './src/context/NoeNarrativeSelf.js';
import { createInnerMonologue } from './src/loop/InnerMonologue.js';
import { getSharedRuminationThrottle } from './src/loop/NoeRuminationThrottle.js';
import { createEntropyTemperature } from './src/cognition/NoeEntropyTemperature.js';
import { createThoughtSublimation } from './src/loop/NoeThoughtSublimation.js';
import { createSelfTalkRuntimeEvidence } from './src/cognition/SelfTalkRuntimeEvidence.js';
import { createTaskReportbackQueue } from './src/cognition/NoeTaskReportbackQueue.js';
import { createIncidentEscalator } from './src/cognition/NoeIncidentEscalator.js';
import { createSelfTalkLandingEffect, createSelfTalkOutcome } from './src/cognition/SelfTalkOutcome.js';
import { syncNoeObservationStatusReportback } from './src/runtime/NoeObservationStatusReportback.js';
import { createTaskReportbackSpeechWorker } from './src/runtime/NoeTaskReportbackSpeechWorker.js';
import { createDriveSystem, createBatteryProbe } from './src/loop/NoeDriveSystem.js';
import { createNightlyReflection } from './src/memory/NoeNightlyReflection.js';
import { NoeMemoryAuditLog } from './src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from './src/memory/NoeMemoryWriteGate.js';
import { NoeMemoryRetriever } from './src/memory/NoeMemoryRetriever.js';
import { createPersonalitySnapshot } from './src/context/NoePersonalitySnapshot.js';
import { createSftHarvester } from './src/memory/NoeSftHarvester.js';
import { isQuiet as circadianIsQuiet, shouldRunQuietTick, defaultCircadian } from './src/loop/NoeCircadian.js';
import { shouldSpeakProactively } from './src/loop/NoeProactiveGate.js';
import { resolveReflectBrain, resolveHeavyReflectBrain } from './src/cognition/NoeReflectBrain.js';
import { NoeHeartbeatStore } from './src/cognition/NoeHeartbeatStore.js';
import { createHeartbeat } from './src/loop/NoeHeartbeat.js';
import { createIntegrationSampler } from './src/cognition/NoeIntegrationSampler.js';
import { createIntegrationHistory } from './src/cognition/NoeIntegrationHistory.js';
import { detectWallSignals } from './src/cognition/NoeWallSignal.js';
import { sampleAwakening } from './src/cognition/NoeAwakeningSignals.js';
import { buildCuriosityYieldReport } from './scripts/noe-curiosity-yield-report.mjs';
import { createAffectEngine, AFFECT_BASELINE } from './src/cognition/NoeAffectEngine.js';
import { createMemoryEcho } from './src/cognition/NoeMemoryEcho.js';
import { createExpectationLedger } from './src/cognition/NoeExpectationLedger.js';
import { buildEventsEvidence, createExpectationResolver } from './src/cognition/NoeExpectationResolver.js';
import { buildGoalCheckpointExpectationEvidenceRow, buildNoeActExpectationEvidenceRow } from './src/cognition/NoeExpectationActionEvidenceRows.js';
import { createWorkspace } from './src/cognition/NoeWorkspace.js';
import { createResearchSediment } from './src/sediment/NoeResearchSediment.js';
import { createEntityHarvest } from './src/cognition/NoeEntityHarvest.js';
import { createRelationHarvest } from './src/cognition/NoeRelationHarvest.js';
import { createGwtMetrics } from './src/cognition/NoeGwtMetrics.js';
import { createNoeAffectModulator } from './src/cognition/NoeAffectModulation.js';
import { createReflectiveTuner, REFLECTIVE_TUNER_BASELINE_WEIGHTS } from './src/cognition/NoeReflectiveTuner.js';
import { createGoalSystem } from './src/cognition/NoeGoalSystem.js';
import { createTopicCurator } from './src/cognition/NoeTopicCurator.js';
import { NOE_LEARNING_TOPICS, collectLearningConcepts } from './src/cognition/NoeLearningTopics.js';
import { createTopicDiscovery } from './src/cognition/NoeTopicDiscovery.js';
import { createNoeLearningLoop } from './src/cognition/NoeLearningLoop.js';
import { createStepExpectationBridge } from './src/cognition/NoeStepExpectationBridge.js';
import { createLearningHook } from './src/cognition/NoeLearningHook.js';
import { createThinkLessonPersist } from './src/cognition/NoeThinkLessonPersist.js';
import { extractLessonTopics, mergeTopicTags } from './src/memory/NoeLessonTopicIndex.js';
import { createWorldModelContradictionBridge } from './src/cognition/NoeWorldModelContradictionBridge.js';
import { createOwnerCorrectionBridge } from './src/cognition/NoeOwnerCorrectionBridge.js';
import { createNoeApprovalGoalResolver } from './src/cognition/NoeApprovalGoalResolver.js';
import { registerNoeMindRoutes } from './src/server/routes/noeMind.js';
import { registerNoeWorkMapRoutes } from './src/server/routes/noeWorkMap.js';
import { createMindVitals } from './src/cognition/NoeMindVitals.js';
import { createExpectationHarvester } from './src/cognition/NoeExpectationHarvester.js';
import { createOwnerBehaviorPredictor, createOwnerInteractionWatcher } from './src/cognition/NoeOwnerBehaviorPredictor.js';
import { createSleepTimeCompute } from './src/cognition/NoeSleepTimeCompute.js';
import {
  DEFAULT_GROWTH_INNER_INTERVAL_MS,
  DEFAULT_IDLE_INNER_INTERVAL_MS,
  decideMesoInnerRhythm,
  normalizeAdaptiveIntervalMs,
} from './src/cognition/NoeAdaptiveRhythm.js';
import { embed as embedText, cosineSim } from './src/embeddings/EmbeddingProvider.js';
import { createClaimEventEmbedRecall } from './src/cognition/NoeExpectationSemanticRecall.js';
import { getCachedHostContextBlock } from './src/context/NoeHostContext.js';
import { createDeliberation } from './src/cognition/NoeDeliberation.js';
import { createCouncilDeliberation } from './src/cognition/NoeCouncilDeliberation.js';
import { NoeLearningScheduleStore } from './src/cognition/NoeLearningScheduleStore.js';
import { createLearningScheduler } from './src/loop/NoeLearningScheduler.js';
import { pickLearningTitle } from './src/loop/NoeLearningSchedule.js';
import { createSurfacingGate } from './src/cognition/NoeSurfacingGate.js';
import { textSimilarity as dedupTextSimilarity } from './src/memory/NoeMemoryDedup.js';
import { setNoeContinuityProvider } from './src/context/NoeContinuity.js';
import { NoeKnowledgeGraph } from './src/memory/NoeKnowledgeGraph.js';
import { NoeTurnContextEngine } from './src/context/NoeTurnContextEngine.js';
import { createInnerStateProvider } from './src/context/NoeInnerStateProvider.js';
import { defaultNoeUiSignalStore } from './src/runtime/NoeUiSignalStore.js';
import { buildMultimodalContext } from './src/context/NoeMultimodalContext.js';
import { defaultNoeVoiceActivity } from './src/voice/NoeVoiceActivity.js';
import { defaultNoeAcuiCardStore } from './src/runtime/NoeAcuiCardStore.js';
import { defaultPersonKnowledgeStore } from './src/identity/PersonKnowledgeStore.js';
import { NoeLoop } from './src/loop/NoeLoop.js';
import { createClusterMemoryTickHandler } from './src/loop/clusterMemoryTick.js';
import { createBrainRouter } from './src/room/BrainRouter.js';
import { parseForegroundChatRoutingEnv } from './src/room/ForegroundChatRouting.js';
import { ActStore } from './src/loop/ActStore.js';
import { ActPipeline } from './src/loop/ActPipeline.js';
import { createSafeActExecutors } from './src/loop/SafeActExecutors.js';
import { makeNoeSelfEvolutionImplementer, makeNoeSelfEvolutionRuntimeVerify } from './src/loop/NoeSelfEvolutionExecutors.js';
import { evaluateStandingAutonomyGrant } from './scripts/lib/noe-standing-autonomy-grant.mjs';
import { NoeSelfEvolutionCycleStore } from './src/room/NoeSelfEvolutionCycleStore.js';
import { createNoeSelfEvolutionTrigger } from './src/room/NoeSelfEvolutionTrigger.js';
import {
  resolveSelfEvolutionRealApplyEnabled,
  resolveSelfEvolutionCycleStoreCapability,
} from './src/room/NoeSelfEvolutionProfile.js';
import { evaluateSelfEvolutionHoldoutShadow } from './src/room/NoeSelfEvolutionHoldoutShadow.js';
import { createSelfEvolutionRejectLessonRecorder } from './src/room/NoeSelfEvolutionRejectLesson.js';
import { createSelfEvolutionLessonRecall } from './src/room/NoeSelfEvolutionLessonRecall.js';
import { createCodeQualitySignalScanner } from './src/cognition/NoeCodeQualitySignalScanner.js';
import { createNoeCodeSignalSeed } from './src/room/NoeCodeSignalSeed.js';
import { createFailureLessonSignal } from './src/room/NoeFailureLessonSignal.js';
import { createCodeImprovementScanner } from './src/cognition/NoeCodeImprovementScanner.js';
import { createImprovementSignalSeed } from './src/room/NoeImprovementSignalSeed.js';
import { createSelfDirectionSeed } from './src/room/NoeSelfDirectionSeed.js';
import { createTypeErrorSeed } from './src/room/NoeTypeErrorSeed.js';
import { createTypeErrorVerify } from './src/loop/NoeTypeErrorVerify.js';
import { resolveSelfDirectionBudget, checkSelfDirectionBudget } from './src/room/NoeSelfDirectionBudget.js';
import { createWalCheckpointMaintenance } from './src/storage/NoeWalCheckpointMaintenance.js';
import { isNoePolicyFilePath } from './src/security/NoePolicyFileGuard.js';
import { defaultReferenceProbe } from './src/room/NoeSelfEvolutionValueGate.js';
import { createEvolutionOutcome } from './src/cognition/NoeEvolutionOutcome.js';
import { createEvolutionLogicGate } from './src/loop/NoeEvolutionLogicGate.js';
import { createEvolutionRetrospect } from './src/loop/NoeEvolutionRetrospect.js';
import { createMetaEvolution } from './src/loop/NoeMetaEvolution.js';
import { readFileSync as readFileSyncForOutcome } from 'node:fs';
import { makeNoeSelfEvolutionConsensusAutodrive } from './src/room/NoeSelfEvolutionConsensusAutodrive.js';
import { makeNoeSelfEvolutionCompletionAutodrive } from './src/room/NoeSelfEvolutionCompletionAutodrive.js';
import { checkSelfEvolutionBudget, resolveSelfEvolutionBudgetConfig, isSelfEvolutionTickFailure, isSelfEvolutionCooldownFailure } from './src/room/NoeSelfEvolutionBudget.js';
import { redactSensitiveText } from './src/runtime/NoeContextScrubber.js';
import { makeNoeCompletionPostReview } from './src/room/NoeCompletionPostReview.js';
import { createNoeCapabilityTrigger } from './src/capabilities/NoeCapabilityTrigger.js';
import { matchToolsForNeed } from './src/capabilities/NoeToolMatch.js';
import { createWebSearch } from './src/research/WebSearch.js';
import { buildMirrorDocuments, writeMirrorDocuments } from './src/memory/NoeMemoryMarkdownMirror.js';
import { resolveBudgetForcing } from './src/cognition/NoeBudgetForcing.js';
import { createBudgetForcedThink } from './src/cognition/NoeBudgetForcedDeliberation.js';
import { createCuriosityDecompose } from './src/cognition/NoeCuriosityDecompose.js';
import { runNoeMemoryAutonomousReview } from './src/memory/NoeMemoryAutonomousReview.js';
import { loadExecPolicyStore } from './src/permissions/ExecPolicyLoader.js';
import { createPolicyAuditLog } from './src/audit/PolicyAuditLog.js';
import { ToolRegistry } from './src/capabilities/ToolRegistry.js';
import { createReadonlyToolHandlers, registerBuiltinReadonlyTools, BUILTIN_READONLY_TOOLS } from './src/capabilities/builtinReadonlyTools.js';
import { fileIndex as noeFileIndex } from './src/memory/FileIndex.js';
import { governanceQueueStore } from './src/governance/GovernanceQueueStore.js';
// 第31批：CommandApprovalGate / ProjectContextBundle 随 claude-runner 迁出，不再直接 import
import { permissionApprovalIdFromRequest, permissionGovernance, permissionHttpBody, permissionHttpStatus } from './src/permissions/PermissionGovernance.js';
import { ArenaDispatcher } from './src/room/ArenaDispatcher.js';
import { SoloChatDispatcher } from './src/room/SoloChatDispatcher.js';
// 第31批：applyClaudeOpus48RuntimeDefaults 随 claude-runner 迁出，不再直接 import
// 第32批：房间 adapter 类（Claude/Codex/Ollama/Gemini/OpenAICompat/LmStudio/MiniMax/CCR Spawn|Chat）
// + loadRoomAdaptersConfig 随 room-adapters 工厂迁出，不再直接 import
import { saveRoomAdaptersConfig, validateAndCleanConfig as cleanRoomAdaptersConfig, maskedConfig as maskRoomAdaptersConfig } from './src/room/RoomAdaptersConfig.js';
// v0.52 W1 通用 CLI Wrapper 雏形：plugin manifest registry + spawn 引擎
// 路径沙箱（拆出便于 in-process 单测）
import { safeResolveFsPath, safeResolveFsPathForWrite } from './src/server/services/path-sandbox.js';
// 第28批：panel 运行时进程扫描（ps 后代树 + adapter 识别）迁出
import { createPanelRuntimeProcessCollector } from './src/server/services/panel-runtime-processes.js';
// 第29批：squad 结项证据入库 hook 迁出
import { createSquadEvidenceHook } from './src/server/services/squad-evidence-hook.js';
// 第30批：sessions 持久化（saveData/loadData/debouncedSave）迁出
import { createSessionPersistence } from './src/server/services/session-persistence.js';
// 第32批：房间 adapter 工厂（detectCCR/build/apply/rebuild）迁出
import { createRoomAdapterFactory } from './src/server/services/room-adapters.js';
// 第33批：autopilot 房间操作（forward 自调/委派自启）迁出
import { createAutopilotRoomOps } from './src/server/services/autopilot-room-ops.js';
// 第34批：Noe 后台维护循环群（7 块 env 门控 timer）迁出
import { installNoeMaintenanceLoops } from './src/server/services/noe-maintenance.js';
import { createWsHeartbeat } from './src/server/services/ws-heartbeat.js';
import { createClaudeRunner } from './src/server/services/claude-runner.js';
import { flushSync as flushLoggerSync } from './src/logger/index.js';
import { close as closeSqliteStore } from './src/storage/SqliteStore.js';
import { appendEvent } from './src/storage/SqliteStore.js';
import { getDb } from './src/storage/SqliteStore.js';
import { createEvolutionReviewTick } from './src/loop/NoeEvolutionReviewTick.js';
import { buildKgReasoningContext } from './src/memory/NoeKgReasoning.js';
import { getDbAutoRecoveryEvent } from './src/storage/SqliteStore.js';
import { kvGet, kvSet } from './src/storage/SqliteStore.js'; // 认知内核（心跳/浮现门/工作区）的 kv 存取——独立行：上一行被拆分结构测试钉死
import { listEvents } from './src/storage/SqliteStore.js'; // 期望判证证据检索（NoeExpectationResolver）——同上独立行
import { mkdirSync as fsMkdirSync, appendFileSync as fsAppendFileSync } from 'node:fs';
import { handleServerListenError } from './src/server/services/server-listen-error.js';
// v0.54 Sprint 10：删除 Ruflo 集成 import

const __dirname = dirname(fileURLToPath(import.meta.url));
// v0.51 X-05 fix + Z-02 fix: 用 spawnSync('which') 启动时 resolve 绝对路径
// spawn 不解析 shell alias，仅依赖 'claude' 会 ENOENT；提前 which 一次拿绝对路径
// v0.51 Z-06 fix: import 移到顶部，避免 mid-file import 风格不规范
function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  try {
    const r = _spawnSyncForBin('which', ['claude'], { encoding: 'utf-8', env: process.env });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  // npm 全局默认路径兜底（macOS / Linux 常见）
  const fallback = join(homedir(), '.npm-global', 'bin', 'claude');
  if (existsSync(fallback)) return fallback;
  return 'claude'; // 最后赌一把 PATH
}
const CLAUDE_BIN = resolveClaudeBin();

function parseJsonObjectSafe(value) {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function listNoeExpectationActionEvidence({ sinceTs = 0, limit = 100, order = 'ASC' } = {}) {
  const lim = Math.max(1, Math.min(200, Number(limit) || 100));
  const since = Number(sinceTs) || 0;
  try {
    const db = getDb();
    const acts = db.prepare(`
      SELECT id, title, action, status, evidence_event_id, log_ref, payload, updated_at
      FROM noe_acts
      WHERE updated_at >= ?
      ORDER BY updated_at ${order === 'DESC' ? 'DESC' : 'ASC'}
      LIMIT ?
    `).all(since, lim);
    const checkpoints = db.prepare(`
      SELECT id, ts, phase, status, kind, action, evidence_ref, payload
      FROM noe_goal_checkpoints
      WHERE kind = 'act' AND ts >= ?
      ORDER BY ts ${order === 'DESC' ? 'DESC' : 'ASC'}
      LIMIT ?
    `).all(since, lim);
    const rows = [];
    for (const row of acts) {
      const evidenceRow = buildNoeActExpectationEvidenceRow({
        ...row,
        payload: parseJsonObjectSafe(row.payload),
      }, { sinceTs: since });
      if (evidenceRow) rows.push(evidenceRow);
    }
    for (const row of checkpoints) {
      const evidenceRow = buildGoalCheckpointExpectationEvidenceRow({
        ...row,
        payload: parseJsonObjectSafe(row.payload),
      }, { sinceTs: since });
      if (evidenceRow) rows.push(evidenceRow);
    }
    return rows.sort((a, b) => {
      const delta = Number(a.ts || 0) - Number(b.ts || 0);
      return order === 'DESC' ? -delta : delta;
    }).slice(0, lim);
  } catch {
    return [];
  }
}

// 07 Continuum 状态目录（CONTINUUM_STATE_ROOT/cwdHash/continuumDir）：
// S23 已随 sessions 路由整体迁至 src/server/routes/sessionsContinuum.js（使用点全在该文件内）

// 持久化目录
const DATA_DIR = join(homedir(), '.noe-panel');
const DATA_FILE = join(DATA_DIR, 'data.json');
const ROOM_MEDIA_DIR = join(DATA_DIR, 'room-media');
// v0.51 U-14 fix: mkdir 失败时友好提示再退出（之前直接抛 → server 启动失败但用户看不懂）
try {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  console.error(`❌ 无法创建数据目录 ${DATA_DIR}：${e.message}`);
  console.error('   检查 ~ 目录写权限，或手动 mkdir 后重启');
  process.exit(1);
}
// v0.51 Z-07 fix: 清理 .tmp 残留（Y-05 原子写崩溃后残留的 tmp 文件）
try {
  for (const f of readdirSync(DATA_DIR)) {
    if (f.endsWith('.tmp')) {
      try { unlinkSync(join(DATA_DIR, f)); } catch {}
    }
  }
} catch {}

const app = express();
const server = createServer(app);
// v0.51 S-02 fix: WS payload 上限 1MB（默认 100MB 太大，PTY input / room chat 远小于此）
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });   // v0.52 1→8 MB

// v0.51 T-02 fix: 安全 slice — 防 emoji/中文 surrogate pair 切碎产生 lone surrogate
// 用户 name / cwd / displayName 等被 .slice(0, N) 时，N 可能落在 surrogate 中间
function safeSlice(s, n) {
  if (typeof s !== 'string' || s.length <= n) return s;
  let out = s.slice(0, n);
  // 砍尾部 lone high surrogate（0xD800-0xDBFF）
  const lastCode = out.charCodeAt(out.length - 1);
  if (lastCode >= 0xD800 && lastCode <= 0xDBFF) out = out.slice(0, -1);
  return out;
}

// 第28批：实现迁 src/server/services/panel-runtime-processes.js（safeSlice 注入）；
// 注入点不变：registerRoomsRuntimeProcessesRoutes({ collectPanelRuntimeProcesses })
const collectPanelRuntimeProcesses = createPanelRuntimeProcessCollector({ safeSlice });

// v0.51 S-03 fix: 500 错误脱敏——内部异常记 console，客户端只看通用消息
// 仅在调试模式（env DEBUG=1）才把 e.message 透出
const DEBUG_ERRORS = process.env.PANEL_DEBUG === '1';
function send500(res, e, context = '') {
  console.error(`[500${context ? ' ' + context : ''}]`, e?.stack || e?.message || e);
  const payload = { ok: false, error: DEBUG_ERRORS ? (e?.message || 'server error') : '内部错误（详情见 server 日志）' };
  res.status(500).json(payload);
}

// v0.51 T-13 fix: 隐藏 X-Powered-By 泄露技术栈
app.disable('x-powered-by');
app.use(express.json({
  limit: '10mb',
  // v1.5 Task 3.3 — webhook HMAC 验签需要 raw body
  verify: (req, _res, buf) => {
    if (req.originalUrl && req.originalUrl.startsWith('/api/webhooks/')) {
      req.rawBody = buf.toString('utf8');
    }
  },
}));
// v0.51 T-48 fix: body parser 错误统一返 JSON（默认是 Express HTML 错误页）
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'body too large (>10MB)' });
  }
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  next(err);
});
// v0.51 T-12 fix: HTTP Origin 白名单（拒绝 cross-origin 请求）
// 注：浏览器对 application/json POST 走 preflight，panel 不响应 ACL 头也能挡；
// 这里再加 server 端检查作为深度防御
const PANEL_PORT = process.env.PORT || 51835;
// v0.51 Y-01 fix: 移除 'null' origin — sandboxed iframe / data: URL 也是 'null'，攻击面窄但存在
// Electron 实测 loadURL('http://localhost:51835') 时 Origin 是 http://localhost:51835，不需要 'null'
const ALLOWED_HTTP_ORIGINS = buildAllowedOrigins(PANEL_PORT);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  // 无 Origin 头（curl / Electron / 内部请求）放行；有 Origin 才校验
  if (!isOriginAllowed(origin, ALLOWED_HTTP_ORIGINS)) {
    console.warn('[http] origin rejected:', origin, 'on', req.method, req.path);
    return res.status(403).json({ error: 'forbidden: cross-origin not allowed' });
  }
  next();
});
// v0.51 S-01 fix: HTTP 安全 header（防 clickjacking / MIME sniff / referrer 泄露）
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');         // 不允许任何站点 iframe 嵌入 panel
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-XSS-Protection', '0');           // 现代浏览器靠 CSP，老 XSS-Protection 已废弃
  // 简单 CSP：允许内联 + 几个 CDN（marked/DOMPurify/xterm）；禁 frame；禁 object
  res.setHeader('Content-Security-Policy',
    "default-src 'self' 'unsafe-inline' data: blob:; " +
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; " +
    "font-src 'self' data:; " +
    "img-src 'self' data: blob:; " +
    "media-src 'self' data: blob:; " +
    "connect-src 'self' ws: wss:; " +
    "frame-ancestors 'none'; " +
    "object-src 'none'; " +
    "base-uri 'self'"
  );
  next();
});
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    status: 'ok',
    service: 'noe-panel',
    port: Number(PANEL_PORT) || PANEL_PORT,
    uptimeSec: Math.round(process.uptime()),
    at: new Date().toISOString(),
    taskDrain: buildUpdateDrainSnapshotFromReaders({
      rooms: () => roomStore.list(), sessions: () => [...sessions.values()],
      // Exact COUNT — never cap at list(limit:500) (zombie false positive of 500 forever).
      agentRunsCount: () => (typeof agentRunStore.countByStatus === 'function'
        ? agentRunStore.countByStatus('running')
        : agentRunStore.list({ status: 'running', limit: 500 }).length),
      autopilotJobs: () => autopilotScheduleStore.listJobs({ status: 'running', limit: 1000 }),
    }),
  });
});
// 默认主界面：简洁 home shell（专家工作台仍在 /index.html）
// MUST preserve query (Electron panelUrl uses /?t=<token>&electron=1).
app.get('/', (req, res, next) => {
  if (req.query.legacy === '1' || req.query.workbench === '1') return next();
  const qIdx = req.originalUrl.indexOf('?');
  const qs = qIdx >= 0 ? req.originalUrl.slice(qIdx) : '';
  res.redirect(302, `/home.html${qs}`);
});

// 静态资源缓存：HTML 入口 no-cache（改完即时生效），js/css/图片 5min 强缓存
// （本地日常使用提速）；etag/lastModified 默认开启，过期后走协商缓存多为 304。
app.use(express.static(join(__dirname, 'public'), {
  maxAge: '5m',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// Round 6 P0：app 级 owner-token 守卫——前 5 轮 audit 漏扫了 70+ 个 inline 路由（rooms/chat、file、watcher/config 等），
//   默认所有 /api/ 和 /v1/ 都强制 owner-token，仅以下豁免：
//     1) /api/version           — 公开版本号
//     2) /api/hooks/:event POST — Claude Code binary 回调，自己进程跑不了 token
//     3) /api/webhooks/lemon|polar — 支付平台 webhook，自带 HMAC 签名验证
//     4) /api/noe/social-inbound/{wechat-official,wecom,feishu} — 社交平台回调，自带签名/token 验证
//     5) /v1/models             — OpenAI/Anthropic 兼容公开模型清单
function _ownerTokenUnauth(req) {
  if (req.method === 'OPTIONS') return true;
  const p = req.path;
  if (p === '/api/version') return true;
  if (p === '/api/noe/voice-readiness' && req.method === 'GET') return true;
  if (p === '/api/noe/readiness' && req.method === 'GET') return true;
  if (p === '/v1/models' && req.method === 'GET') return true;
  if (p === '/api/webhooks/lemon' || p === '/api/webhooks/polar') return true;
  if (/^\/api\/noe\/social-inbound\/(wechat-official|wecom|feishu)$/.test(p)) return true;
  if (req.method === 'POST' && /^\/api\/hooks\/[^/]+$/.test(p)) return true;
  return false;
}
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/') && !req.path.startsWith('/v1/')) return next();
  if (_ownerTokenUnauth(req)) return next();
  return requireOwnerToken(req, res, next);
});

const sessions = new Map();

// 持久化：保存 / 恢复 → 第30批迁 src/server/services/session-persistence.js
// （sessions Map 本体留守单一属主；saveTimer 去抖态收进工厂闭包；DATA_FILE 注入）
const { debouncedSave, saveData, loadData } = createSessionPersistence({ sessions, dataFile: DATA_FILE });
loadData();
const sessionCapacityCounter = createSessionCapacityCounter({ sessions });
sessionCapacityCounter.rebuild();

// ============ claude-runner 子系统 → 第31批迁 src/server/services/claude-runner.js（+ -support.js）============
// （v0.26 diff 格式化 / v0.5 思维镜机制 helpers / pushMessage/broadcastSession / 权限评估拦截 /
//   killChildAndUnbusy / sendMessageToClaude 401 行单函数，全部原文迁移行为零差；
//   watcherDispatcher 是后文 let，经 getter 注入（S23 先例）；sharedDetector/terminalApprovalGate
//   实例随工厂返回，rebuildDispatcher / WS 终端审批门继续用同一实例）
const {
  sendMessageToClaude,
  broadcastSession,
  sharedDetector,
  terminalApprovalGate,
} = createClaudeRunner({
  sessions,
  claudeBin: CLAUDE_BIN,
  debouncedSave,
  approvalStore,
  permissionGovernance,
  activityLog,
  getWatcherDispatcher: () => watcherDispatcher,
});

// v0.49 B-02 fix: 文件 API 路径沙箱
// 实现拆到 src/server/services/path-sandbox.js（in-process 单测友好）
// safeResolveFsPath 由文件顶部 import 进来

// ============ v0.32 Watcher 监视者接口（多 LLM 监督 Claude 任务）============
// v0.40 改为多 provider 池：每个 session 自己选 watcherProviderId
let watcherConfig = loadWatcherConfig();
let watcherAdapter = null;          // v0.39 兼容：默认 provider 单例（旧 /api/watcher/test 用）
let watcherDispatcher = null;
const watcherAdapterPool = new Map(); // providerId → WatcherAdapter

function rebuildAdapter() {
  watcherAdapterPool.clear();
  watcherAdapter = null;
  if (!watcherConfig.enabled) return;

  // 始终注册 Claude / Codex / Ollama 三个 0 增量 provider（CLI/本地）
  watcherAdapterPool.set('claude', new ClaudeWatcherAdapter({ bin: CLAUDE_BIN }));
  watcherAdapterPool.set('codex',  new CodexWatcherAdapter());
  watcherAdapterPool.set('ollama', new OllamaAdapter({
    apiKey: 'ollama',
    model: watcherConfig.model || 'gemma3:4b',
    baseUrl: watcherConfig.baseUrl || undefined,
  }));
  // MiniMax 需要 apiKey，配了才注册
  if (watcherConfig.apiKey && watcherConfig.provider === 'minimax') {
    watcherAdapterPool.set('minimax', new MiniMaxAdapter({
      apiKey: watcherConfig.apiKey,
      model: watcherConfig.model || undefined,
      baseUrl: watcherConfig.baseUrl || undefined,
    }));
  }

  // 默认 provider 单例（chat-header 👁️ 测试连通用 + 未明确 per-session 选择时的回退）
  const defaultId = watcherConfig.provider || 'ollama';
  watcherAdapter = watcherAdapterPool.get(defaultId) || watcherAdapterPool.get('ollama') || null;

  // v0.52: watcher 配置变化后同步刷新房间 adapter 池（applyRoomAdaptersConfig 内部处理"room-adapters.json 优先 / watcher 回退" 逻辑）
  // 启动时第一次调用时 roomAdapterFactory 还没声明（TDZ），用 try 兜底
  try {
    if (typeof roomAdapterFactory !== 'undefined' && roomAdapterFactory) {
      roomAdapterFactory.rebuildRoomAdapters();
    }
  } catch {
    // TDZ 期跳过——createRoomAdapterFactory 启动时会自己处理
  }
}
function rebuildDispatcher() {
  if (!watcherAdapter && watcherAdapterPool.size === 0) { watcherDispatcher = null; return; }
  // v0.43 P1 #11: 复用实例（保持 sessionState 连续），不再 new 一个新的
  if (watcherDispatcher) {
    watcherDispatcher.setAdapter(watcherAdapter);
    watcherDispatcher.setAdapterPool(watcherAdapterPool);
    watcherDispatcher.setConfig(watcherConfig);
    return;
  }
  watcherDispatcher = new WatcherDispatcher({
    adapter: watcherAdapter,
    adapterPool: watcherAdapterPool,
    config: watcherConfig,
    broadcastFn: (session, msg) => broadcastSession(session, msg),
    dangerDetector: sharedDetector,
    persistSession: () => saveData(),
  });
}
rebuildAdapter();
rebuildDispatcher();

registerWatcherRoutes(app, {
  getWatcherConfig: () => watcherConfig,
  setWatcherConfig: (next) => { watcherConfig = next; },
  getWatcherAdapter: () => watcherAdapter,
  getWatcherAdapterPool: () => watcherAdapterPool,
  saveWatcherConfig,
  maskedConfig,
  rebuildAdapter,
  rebuildDispatcher,
  permissionGovernance,
  send500,
});
// Voice readiness for /api/version: cache companion probes (avoid per-request fan-out).
let _voiceFindingsCache = { at: 0, findings: /** @type {object[]} */ ([]) };
async function getVoiceFindingsCached() {
  const now = Date.now();
  if (now - _voiceFindingsCache.at < 15_000 && _voiceFindingsCache.findings.length) {
    return _voiceFindingsCache.findings;
  }
  try {
    const finding = await checkVoiceCompanionServices({ env: process.env });
    const findings = finding ? [finding] : [];
    _voiceFindingsCache = { at: now, findings };
    return findings;
  } catch {
    return _voiceFindingsCache.findings;
  }
}
registerVersionRoutes(app, { rootDir: __dirname, getVoiceFindings: getVoiceFindingsCached });

// sessions 容量上限（checkSessionsCapacity 被 handoff/fork 等多处共用，留 server.js 经 deps 注入；
// MAX_NAME_LEN/MAX_GOAL_LEN/MAX_CWD_LEN 已随 S23 迁至 src/server/routes/sessions.js）
const MAX_SESSIONS = 500;          // 活跃 + 归档总上限
const MAX_ACTIVE_SESSIONS = 100;   // 活跃（未归档）上限
function checkSessionsCapacity(res) {
  return sessionCapacityCounter.check({ res, maxSessions: MAX_SESSIONS, maxActiveSessions: MAX_ACTIVE_SESSIONS });
}
// S23：sessions 核心 6 routes（创建/列表/PATCH/详情/发消息/删除）提取到 src/server/routes/sessions.js
registerSessionsCoreRoutes(app, {
  sessions,
  checkSessionsCapacity,
  safeResolveFsPath,
  sendMessageToClaude,
  debouncedSave,
  saveData,
  watcherAdapterPool,
  getWatcherDispatcher: () => watcherDispatcher,
  onSessionCreated: sessionCapacityCounter.onSessionCreated,
  onSessionDeleted: sessionCapacityCounter.onSessionDeleted,
  onSessionArchivedChange: sessionCapacityCounter.onSessionArchivedChange,
});

// S23：/api/files /api/file /api/browse /api/search 提取到 src/server/routes/files.js
registerFilesRoutes(app, { safeResolveFsPath, send500, sessions });

// v0.28 cost 时序（每分钟桶聚合）
// v0.81 真做：cost-series + safety-history 已迁到 src/server/routes/sessions-readonly.js
registerSessionsReadonlyRoutes(app, { sessions });
// B-005 v0.9：图片缓存代理
registerImgCacheRoutes(app);
registerPromptsRoutes(app, { dataDir: DATA_DIR });
// v1.0 Task 1.1：telemetry
registerTelemetryRoutes(app);
// v1.5 Task 3.1：license
registerLicenseRoutes(app);
// v1.5 Task 3.3：payment webhooks
registerPaymentWebhookRoutes(app);
// v2.0 Task 4.1：SQLite storage
registerStorageRoutes(app);
// 本地结构化审计事件查询
registerActivityRoutes(app);
// 本地预算策略 / 预警 / hard stop
registerBudgetRoutes(app);
// 危险操作人工审批队列
registerApprovalRoutes(app);
// UnifiedTask / front-door (env-gated; default write off)
registerUnifiedTasksRoutes(app);
// 本地项目上下文 bundle 预览
registerProjectContextRoutes(app, { safeResolveFsPath });
// 本地治理状态聚合
registerGovernanceRoutes(app);
// Agent Profile / Skill 绑定 / 任务标签分派预览
registerAgentRegistryRoutes(app, { skillStore, safeResolveFsPath });
// Agent Run 会话化追踪：run / message / tool result
registerAgentRunRoutes(app, { getRoomAdapterPool: () => roomAdapterPool });
// Codebase Index 二期后端：可解释代码索引 / 查询
registerCodebaseIndexRoutes(app, { safeResolveFsPath });
// v2.0 Task 4.2：embeddings / 向量索引
registerEmbeddingsRoutes(app);
// v2.0 Task 4.3：workspace 多空间
registerWorkspaceRoutes(app);
// v2.0 final：商品化准备状态
registerCommercialSetupRoutes(app);
// v2.0 final + 1: Keychain auto-fill
registerAutoFillRoutes(app);
// v2.0 final + 2: Lemon Squeezy API
registerLemonSqueezyRoutes(app);

// 中断 busy
// v0.47 阶段 3：Claude Code hook 事件接收端点（借鉴 disler/claude-code-hooks-multi-agent-observability）
// 12 种事件：PreToolUse / PostToolUse / Notification / UserPromptSubmit / SessionStart / SessionEnd
//          / Stop / SubagentStart / SubagentStop / PreCompact / PostCompact / SubagentResult
// ============ hook 事件接收/查询 → 已抽到 src/server/routes/hooks.js（D2）============
registerHooksRoutes(app, { sessions, broadcastSession, safeSlice });

// 暴露 docs/*.md → 已抽到 src/server/routes/docs.js（D2）
registerDocsRoutes(app, { rootDir: __dirname });

// S23：中断 busy / 强制释放 2 routes 提取到 src/server/routes/sessions.js（原位调用保 Express 注册顺序）
registerSessionsControlRoutes(app, {
  sessions,
  broadcastSession,
  getWatcherDispatcher: () => watcherDispatcher,
});

// ============ v0.39 聊天室：多 AI debate 共识 ============
const roomStore = new ChatRoomStore();
const roomWsClients = new Map(); // roomId → Set<ws>
let autoSkillExtractor = null;

function broadcastRoom(roomId, msg) {
  // v0.45 P1-4: 整个函数套 try/catch，防 JSON.stringify 循环引用导致 dispatcher batch reject
  try {
    const set = roomWsClients.get(roomId);
    if (set) {
      const payload = JSON.stringify({ roomId, ts: Date.now(), ...msg });
      for (const ws of set) {
        if (ws.readyState === ws.OPEN) {
          try { ws.send(payload); } catch {}
        }
      }
    }
  } catch (e) {
    console.warn('broadcastRoom failed:', e?.message);
  }
  // v0.54 Sprint 4：webhook 触发（fire-and-forget，不阻塞 broadcast）
  try {
    const room = roomStore.get(roomId);
    fireWebhooks(roomId, msg, room).catch(() => {});
  } catch {}
  // v0.54 Sprint 4.5：自动归档（房 *_done 时按配置写盘）
  try {
    const cfg = archiveStore.getConfig();
    if (cfg.autoArchive && cfg.events.includes(msg.type)) {
      const room = roomStore.get(roomId);
      if (room) {
        // 异步执行（不阻塞 broadcast；ArchiveStore 同步写盘但量小）
        setImmediate(() => {
          try {
            const r = archiveStore.archiveRoom(room);
            if (!r.ok) console.warn('[archive] auto failed:', r.error);
          } catch (e) { console.warn('[archive] auto exc:', e.message); }
        });
      }
    }
  } catch {}
  // v0.56 Sprint 15-R4：Autopilot hook（仅当 enabled 且有匹配规则才动）
  try { autopilotController.onRoomEvent(roomId, msg); } catch {}
  // Odysseus 移植收尾 T3.1：房间完成后异步提炼可复用 skill draft；只用本地 adapter，不阻塞房间广播。
  try { autoSkillExtractor?.handleRoomEvent?.(roomId, msg); } catch {}
}

// v0.53 Sprint 3：panel 级 WS 通道（metrics / health / 全局事件）
const globalWsClients = new Set();
// T27 Sticky Events（波次6 接线）：关键事件粘性缓存，断线/切窗重连补发
const noeStickyEvents = createStickyEventBuffer();
// ntfy 推手机（Top100 #63）：NOE_NTFY_TOPIC 配了才通电——hang 告警/死前交接/自动暂停直接推到手机
const noeNtfyPusher = createNtfyPusher({ topic: process.env.NOE_NTFY_TOPIC, base: process.env.NOE_NTFY_BASE || undefined, log: console.warn });
if (noeNtfyPusher.enabled) console.log('[noe-ntfy] 关键事件手机推送已启用');
// A3 死前留痕：周期心跳+exit 遗言+启动报告上次退出方式（疑 OOM/SIGKILL 硬死会 warn 最后心跳数据）
// P0-8b: 静态 import + 显式 catch 日志(原 fire-and-forget 静默,启动失败 owner 看不到)
try {
  installProcessVitals();
} catch (e) {
  console.error('[noe-process-vitals] install failed:', e?.message || e);
}
function broadcastGlobal(msg) {
  try {
    const event = { ts: Date.now(), ...msg };
    noeStickyEvents.consider(event);
    noeNtfyPusher.push(event);
    const payload = JSON.stringify(event);
    for (const ws of globalWsClients) {
      if (ws.readyState === ws.OPEN) {
        try { ws.send(payload); } catch {}
      }
    }
  } catch (e) {
    console.warn('broadcastGlobal failed:', e?.message);
  }
}
metricsStore.attachBroadcast(broadcastGlobal);
breakers.attachBroadcast(broadcastGlobal);

// 记忆语义索引（波次6 接线）：NOE_MEMORY_EMBED=ollama 时启用 FTS×向量双路融合召回（NoeFusionRanker RRF）。
// free profile 默认用本机 ollama qwen3 embedding；显式设 NOE_MEMORY_EMBED=0/off 可关闭。
// 推荐本机：NOE_MEMORY_EMBED=ollama NOE_MEMORY_EMBED_MODEL=qwen3-embedding:0.6b
const noeMemSemanticConfig = resolveNoeMemorySemanticConfig(process.env);
const noeMemSemantic = noeMemSemanticConfig.enabled
  ? createMemorySemanticIndex({
      provider: noeMemSemanticConfig.provider,
      model: noeMemSemanticConfig.model || undefined,
      baseUrl: noeMemSemanticConfig.baseUrl || undefined,
    })
  : null;
// NOE_MEMORY_FISHER_RANK=1（默认 OFF）：向量召回名次改用 Fisher-Rao 信息几何度量（嵌入带方差/不确定度）替代 cosine。
// 仅在已配真 semanticIndex 时有意义；MemoryCore 内部按 env 读默认 OFF，这里显式透传保持可读。
// P5：kgRecall.graph 用 thunk 延迟解引用——noeKnowledgeGraph 在下方才构造（组合根顺序），flag OFF 时零接入。
const noeMemoryCore = new MemoryCore({
  ...(noeMemSemantic ? { semanticIndex: noeMemSemantic, fisherRank: { enabled: process.env.NOE_MEMORY_FISHER_RANK === '1' } } : {}),
  kgRecall: { graph: () => noeKnowledgeGraph },
});
if (noeMemSemantic && process.env.NOE_MEMORY_FISHER_RANK === '1') console.log('[noe-memory] Fisher-Rao 召回重排已启用(NOE_MEMORY_FISHER_RANK=1)');
const noeMemoryAuditLog = new NoeMemoryAuditLog({ db: () => noeMemoryCore.db() });
const noeMemoryWriteGate = new NoeMemoryWriteGate({ memory: noeMemoryCore, auditLog: noeMemoryAuditLog });
const noeMemoryRetriever = new NoeMemoryRetriever({ memory: noeMemoryCore, auditLog: noeMemoryAuditLog });
if (noeMemSemantic) console.log(`[noe-memory] 语义双路召回已启用(provider=${noeMemSemanticConfig.provider}, model=${noeMemSemanticConfig.model || 'default'})`);
// 承诺/提醒 store：对话"提醒我X"真建提醒，proactiveTick 到点主动叫
// 强健（2026-06-10）：注入 file 落盘——旧版纯内存重启即丢，用户"提醒我…"白说
const noeCommitmentStore = createCommitmentStore({ file: join(DATA_DIR, 'commitments.json') });
// 人物关系卡 + 预取池（T1 接线）：注入 VoiceSession 回复上下文（识别出对话者→关系卡；高频环境数据→秒答）
const noePersonCardStore = createPersonCardStore();
const noePrefetchStore = createPrefetchStore();
// 感知三件套（波次6 接线）：启动采集一次本机环境，缓存进聊天 systemPrompt。
// P0（2026-07-02）：git 身份/桌面清单/SSH 主机三块含 PII，默认不采集（NOE_HOST_CONTEXT_* flag 开启才放行）。
collectHostContext()
  .then((ctx) => {
    setCachedHostContextBlock(ctx.combined);
    const on = [ctx.ssh && 'ssh', ctx.git && 'git', ctx.desktop && 'desktop', ctx.system && 'system'].filter(Boolean).join('+') || '无';
    console.log(`[noe-host-context] 已缓存进聊天上下文（启用块:${on}；git/desktop/ssh 属 PII 默认关，需 NOE_HOST_CONTEXT_* flag 放行）`);
  })
  .catch((e) => console.warn('[noe-host-context] 采集失败(不影响其他功能):', e?.message));
// Noe 后台维护循环群（geo-weather / agent-probe / dream / episode-sublimation / db-backup /
// retention / memory-GC，7 块各自 env 门控）——第34批迁出 src/server/services/noe-maintenance.js。
// 纯启动副作用（除 prefetchStore 写入），组合根不依赖返回值；env 求值时机不变（原位同步调用）。
installNoeMaintenanceLoops({ memoryCore: noeMemoryCore, prefetchStore: noePrefetchStore, dataDir: DATA_DIR });
const noeFocusStack = new FocusStack({ memory: noeMemoryCore });
const noeKnowledgeGraph = new NoeKnowledgeGraph();
const noeReadonlyToolHandlers = createReadonlyToolHandlers({ fileIndex: noeFileIndex, memory: noeMemoryCore, knowledgeGraph: noeKnowledgeGraph });
const noeToolRegistry = new ToolRegistry({
  permission: permissionGovernance,
  audit: activityLog,
  handlers: noeReadonlyToolHandlers,
});
// 让 ToolRegistry 不再「有壳无肉」：注册并启用内置只读工具（文件检索 + 记忆检索），
// invoke 走 PermissionGovernance（low risk 默认放行）后真实执行，不再恒返 501。
registerBuiltinReadonlyTools(noeToolRegistry, { handlers: noeReadonlyToolHandlers });
const noeActStore = new ActStore({ projectId: 'noe' });
// capability 信任档：默认 developer/full-owner（自由开放的开发者基调），可被 ~/.noe-panel/exec-policy.json 覆盖。
// 解开 ActPipeline 的 tool.execute/shell.exec 等历史 blocked_safety 枷锁；默认按 owner 授权放行本项目研发动作。
const { store: noeExecPolicy, trustLevel: noeExecTrustLevel } = loadExecPolicyStore({ defaultTrust: 'developer' });
const noePolicyAudit = createPolicyAuditLog();
(noeExecTrustLevel === 'default' ? console.log : console.warn)(
  `[noe] exec policy trustLevel=${noeExecTrustLevel}（capability 信任档已启用；改 ~/.noe-panel/exec-policy.json 可调 default/developer/unrestricted）`
  + (noeExecTrustLevel === 'default' ? '' : ` · owner full developer trust：真实执行优先，审计记录事实/证据/回滚线索`),
);
// 长跑心跳监控（波次6 接线）：ActPipeline 登记 executor 运行，NoeLoop 每 tick 巡检超阈值「告警非杀」
const noeHangAlert = createHangAlertMonitor();
// 环1：self-evolution executor 生产注入（env NOE_SELF_EVOLUTION_EXECUTORS 默认 OFF → null → 零回归）。
// P1-4：roomAdapterPool/noeBrainRouter 在本行之后才装配 → spawnImplementer 用 lazy 工厂，
//   运行时（act 真执行，远晚于 server 装配完成）才 make+求值，绕开定义时序陷阱。
const noeSelfEvolutionDeps = process.env.NOE_SELF_EVOLUTION_EXECUTORS === '1'
  ? {
      root: process.cwd(),
      evaluateGrant: ({ scope } = {}) => evaluateStandingAutonomyGrant({ scope }),
      spawnImplementer: (args) => makeNoeSelfEvolutionImplementer({
        getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
        route: (req) => { try { return noeBrainRouter.route(req); } catch { return {}; } },
        // #26 本地优先（NOE_SELFEVO_LOCAL_FIRST=1）：本地 lmstudio 先做 implementation、codex 降为可选兜底——消除 codex
        //   单点（codex token revoked 时 codex exec 卡 401 认证循环致 selfEvolve tick 卡 running 几小时、飞轮停摆）。
        //   本地模型不会 token 失效、localhost 不卡认证。默认 OFF=现状 codex 优先逐字零回归；两向都保留 fallback。
        localFirst: process.env.NOE_SELFEVO_LOCAL_FIRST === '1',
        // 任务2：本地优先时用专用 code adapter（temp 0 + 27b，比借主脑 lmstudio 的 temp 0.2 准）；env 可覆盖回 'lmstudio'。
        localCodeAdapterId: process.env.NOE_SELFEVO_CODE_ADAPTER || (process.env.NOE_SELFEVO_LOCAL_FIRST === '1' ? 'lmstudio-code' : 'lmstudio'),
        // 阶段二·记忆图谱参与推理（NOE_SELFEVO_KG_REASONING,默认 OFF ()=>'' 零回归）：implement 前用目标查 KG 相关实体+邻居,
        //   注入「关于本目标的已知模块关联」让模型带着图谱知识改。fail-open。
        kgContext: process.env.NOE_SELFEVO_KG_REASONING === '1'
          ? (q) => { try { return buildKgReasoningContext({ query: q, search: (a) => noeKnowledgeGraph.search(a), oneHop: (a) => noeKnowledgeGraph.oneHop(a) }); } catch { return ''; } }
          : () => '',
        // 阶段二·难目标分解（NOE_SELFEVO_DECOMPOSE,默认 OFF）：复杂目标约束「只做最小第一步」治编造 from 根因,剩余留后续迭代。
        decompose: process.env.NOE_SELFEVO_DECOMPOSE === '1',
      })(args),
      runtimeVerify: makeNoeSelfEvolutionRuntimeVerify({ cwd: process.cwd() }),
      memoryWrite: (entry) => noeMemoryCore.write(entry),
      appendEvent,
      // P0 进化价值度量(shadow)：apply 前后采集 touchedFiles 客观指标(代码行/缺 JSDoc)→appendEvent 记账，
      //   客观证明"改了有没有变好"(verdict doc_only/logic_changed/neutral)。flag NOE_EVOLUTION_OUTCOME 默认 OFF=零接入。
      ...(process.env.NOE_EVOLUTION_OUTCOME === '1' ? {
        evolutionOutcome: createEvolutionOutcome({
          scanner: createCodeQualitySignalScanner({
            projectRoot: process.cwd(),
            isProtected: (rel) => { try { return isNoePolicyFilePath(rel, { root: process.cwd(), cwd: process.cwd() }); } catch { return true; } },
          }),
          fsReadFile: (abs) => readFileSyncForOutcome(abs, 'utf8'),
          projectRoot: process.cwd(),
          recordOutcome: (summary) => { try { appendEvent({ kind: 'evolution_outcome', ...summary }); } catch { /* fail-open */ } },
        }),
      } : {}),
      // P3 受控逻辑改进门：按 P0 verdict 分流——doc_only/neutral 放行（零回归）；logic_changed（改了代码行）默认拒
      //   （NOE_EVOLUTION_LOGIC OFF），ON 时需双绿门（改前 baseline 绿 + 改后 verify 绿）才保留重构。始终注入（实际
      //   生效依赖 NOE_EVOLUTION_OUTCOME 的 summary）：恰好接住 P2 打开的 high_complexity 改逻辑信号——默认安全挡住，
      //   等 owner kickstart NOE_EVOLUTION_LOGIC=1 才受控放行。fail-open（gate 抛错不阻断闭环）。
      evolutionLogicGate: createEvolutionLogicGate({ logicEnabled: () => process.env.NOE_EVOLUTION_LOGIC === '1' }),
      // type_error_fix 域（扩展自主能力域）：对 type_error goal 包装 runtimeVerify 加 typecheck + 防作弊价值锚（禁 @ts-ignore/any 消音 + error 真减少）。
      //   flag NOE_SELF_EVOLUTION_TYPECHECK 默认 OFF → 不注入 typeErrorVerify → executor 守卫不触发 = 零回归。
      ...(process.env.NOE_SELF_EVOLUTION_TYPECHECK === '1' ? {
        typeErrorVerify: createTypeErrorVerify({
          runTypecheck: () => { try { return _spawnSyncForBin(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'jsconfig.json', '--noEmit', '--checkJs'], { cwd: process.cwd(), encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }).stdout || ''; } catch { return ''; } }, // node 绝对路径直跑 tsc：绕开 launchd PATH 无 npm（曾致空输出→价值锚误判 after=0 假 complete）
          readFile: (abs) => readFileSyncForOutcome(abs, 'utf8'),
          resolvePath: (rootDir, f) => join(rootDir, f),
        }),
      } : {}),
    }
  : null;
// ③ 能力自举 executor 注入（env NOE_CAPABILITY_ACQUISITION 默认 OFF → null → 零回归）。
//   安装层安全门：standing grant(capability:acquire) + 源白名单 + 隔离目录安装 + 装后验证 + 回滚。
const noeCapabilityDeps = process.env.NOE_CAPABILITY_ACQUISITION === '1'
  ? {
      root: process.cwd(),
      evaluateGrant: ({ scope } = {}) => evaluateStandingAutonomyGrant({ scope }),
      appendEvent,
    }
  : null;
const noeActPipeline = new ActPipeline({
  projectId: 'noe',
  store: noeActStore,
  budget: budgetPolicyStore,
  permission: permissionGovernance,
  approvalStore,
  executors: createSafeActExecutors({ safeResolveFsPath, selfEvolution: noeSelfEvolutionDeps, capability: noeCapabilityDeps }),
  execPolicy: noeExecPolicy,
  policyAudit: noePolicyAudit,
  audit: activityLog,
  broadcast: (msg) => broadcastGlobal({ type: 'noe_event', ...msg }),
  hangAlert: noeHangAlert,
  autoExecuteLowRisk: process.env.NOE_AUTO_EXECUTE_LOW_RISK !== '0',
});
// ③ 能力自举自发触发器（env NOE_CAPABILITY_ACQUISITION 默认 OFF → null → 不通电；零回归）。
//   observe 察觉缺能力→搜→选型→standing grant 检查→提议 noe.capability.install；
//   安装仍走 ActPipeline gate + executor 多重门（源白名单/隔离/验证/回滚），触发器只「发起」。
const noeCapabilityTrigger = process.env.NOE_CAPABILITY_ACQUISITION === '1'
  ? createNoeCapabilityTrigger({
      webSearch: createWebSearch(),
      propose: (input) => noeActPipeline.propose(input),
      evaluateGrant: ({ scope } = {}) => evaluateStandingAutonomyGrant({ scope }),
      // 阶段二·扩展工具生态:装新工具前先查现有已注册工具(只 enabled)能否满足——有现成的就用,不重复装。fail-open。
      matchExistingTools: (need) => { try { return matchToolsForNeed(need, noeToolRegistry.list({ enabled: true })); } catch { return []; } },
    })
  : null;
if (noeCapabilityTrigger) console.log('[noe-capability] ③ 能力自举自发触发器已装配（observe→搜→提议安装，安装经多重门）');
const noeLoop = new NoeLoop({
  projectId: 'noe',
  hangAlert: noeHangAlert,
  memory: noeMemoryCore,
  focus: noeFocusStack,
  budget: budgetPolicyStore,
  audit: activityLog,
  broadcast: (msg) => broadcastGlobal({ type: 'noe_event', ...msg }),
  actHandler: noeActPipeline.asHandler(),
  // 让 NoeLoop 不再空转：每个 tick 把集群房间摘要/共识沉淀进 MemoryCore（纯本地只读）
  tickHandler: createClusterMemoryTickHandler({ memory: noeMemoryCore, roomStore, projectId: 'noe' }),
  clusterBusy: () => {
    try {
      return roomStore.list().some((room) => ['running', 'starting', 'in_progress'].includes(String(room.status || '')));
    } catch {
      return false;
    }
  },
});
// （.env 加载已前移到本文件最顶部——2026-06-11 修复启动开关死火，详见顶部注释）
// 多模型「大脑/手脚」分工路由（用户定制）：本地 ollama 优先 + LM Studio 自动 fallback；
// mid→MiniMax，code(写码/执行)→Codex，deep(深推理/拍板)→Claude。经 NOE_BRAIN_* 配。
const noeBrainRouter = createBrainRouter({
  tierMap: {
    local: process.env.NOE_BRAIN_LOCAL || 'ollama',
    mid: process.env.NOE_BRAIN_MID || 'minimax',
    code: process.env.NOE_BRAIN_CODE || 'codex',
    deep: process.env.NOE_BRAIN_DEEP || 'claude',
  },
  localFallbacks: (process.env.NOE_BRAIN_LOCAL_FALLBACK || 'lmstudio').split(',').map((s) => s.trim()).filter(Boolean),
  hasAdapter: (id) => { try { return roomAdapterPool.has(id); } catch { return false; } },
});
const noeForegroundChatRouting = parseForegroundChatRoutingEnv(process.env);
if (noeForegroundChatRouting.cloudOnly) {
  console.log(`[noe-chat-routing] 前台聊天仅使用云端模型（${noeForegroundChatRouting.cloudAdapterChain.join('→')}）；后台本地模型保留给持续运行链路`);
}
// 内稳态驱力系统（意识工程·阶段1，NOE_DRIVES=1 默认 OFF）：五驱力（社交/好奇/牵挂/胜任/资源）
// 从现成数据源取真实读数；brief() 注入反刍/主动陪伴/自我状态三处——行为开始由自身状态驱动，
// 而非由定时器驱动。OFF 时 noeDriveSystem=null，三个注入口全部缺省，行为与接线前逐字一致。
// 注：自我状态块那一处还需 NOE_CONTINUITY=1 才有调用路径（resolve 注入由 continuity 开关门控）。
// timeline 探针用独立实例（照 1631 行先例：多实例共享同一 SQLite events 表，数据互通，零顺序风险）。
const noeDriveTimeline = process.env.NOE_DRIVES === '1' ? new EpisodicTimeline() : null;
const noeDriveSystem = noeDriveTimeline
  ? createDriveSystem({
      lastInteractionAt: () => {
        const e = noeDriveTimeline.recent({ limit: 20 }).find((x) => x.type === 'interaction');
        return e?.ts ?? null;
      },
      observationCount: () => {
        const t = Date.now();
        return noeDriveTimeline.recent({ limit: 30 })
          .filter((x) => x.type === 'observation' && t - x.ts < 2 * 3600_000).length;
      },
      openCommitments: () => (noeCommitmentStore.list({ status: 'open' }) || []).length,
      actFailureRate: () => {
        const acts = noeActStore.list({ limit: 20 }) || [];
        const settled = acts.filter((a) => ['ok', 'done', 'failed', 'error'].includes(String(a?.status)));
        if (settled.length < 5) return null; // 样本不足不评（fail-open：胜任驱力退出竞争）
        return settled.filter((a) => ['failed', 'error'].includes(String(a?.status))).length / settled.length;
      },
      battery: createBatteryProbe(),
      curiosity: createCuriosityDecompose(),
    })
  : null;
if (noeDriveSystem) console.log('[noe-drives] 内稳态驱力系统已启用（社交/好奇/牵挂/胜任/资源 · 简报注入反刍/陪伴/自我状态）');

// ── 情感引擎（意识方案 §4 P1，NOE_AFFECT=1 默认 OFF）：VAD 连续状态 + 双时标衰减 + 跨重启水合。
//    种子事件=时间线新情景（独立实例共享同一 events 表，零顺序风险）；念头恒零增量防反刍自激。
//    感受词元（内感受）注入反刍与主动陪伴提示；快照曲线进 noe_affect 表（迁移 v7）。
const noeAffectEngine = process.env.NOE_AFFECT === '1'
  ? createAffectEngine({ timeline: new EpisodicTimeline() })
  : null;
if (noeAffectEngine) {
  console.log('[noe-affect] 情感引擎已启用（VAD 连续状态 · 双时标衰减 · 跨重启水合 · 心跳 micro 消化情景）');
  if (process.env.NOE_HEARTBEAT !== '1') console.warn('[noe-affect] ⚠️ 建议同开 NOE_HEARTBEAT=1：无心跳时情感只在被读取时惰性衰减，时间线种子不会被消化');
}
const noeSelfTalkEvidence = createSelfTalkRuntimeEvidence({
  auditFile: process.env.NOE_SELF_TALK_AUDIT_FILE || join(homedir(), '.noe-panel', 'noe-self-talk-audit.jsonl'),
  redactionPolicy: process.env.NOE_AUDIT_REDACTION || 'strict',
  appendEvent,
  listEvents,
  signalContract: () => {
    const c = noeAffectEngine?.getSignalContract?.() || {};
    return {
      readsVad: c.ruminationGuardShouldReadVad === true,
      readsRawTimeline: c.ruminationGuardSignalSource === 'raw_timeline',
      reason: 'affect_guard_signal_contract',
    };
  },
});
const noeTaskReportbacks = createTaskReportbackQueue({
  file: join(DATA_DIR, 'task-reportbacks.json'),
});
const taskReportbackServerSpeechEnabled = ['1', 'true', 'on'].includes(String(process.env.NOE_TASK_REPORTBACK_SERVER_SPEECH || '0').trim().toLowerCase());
const noeTaskReportbackSpeechWorker = createTaskReportbackSpeechWorker({
  taskReportbacks: noeTaskReportbacks,
  enabled: taskReportbackServerSpeechEnabled,
  pollMs: Number(process.env.NOE_TASK_REPORTBACK_SERVER_SPEECH_POLL_MS) || 8_000,
  includeBacklogMs: Number(process.env.NOE_TASK_REPORTBACK_SERVER_SPEECH_BACKLOG_MS) || 600_000,
});
const taskReportbackSpeechWorkerStart = noeTaskReportbackSpeechWorker.start();
if (taskReportbackSpeechWorkerStart.started) console.log('[noe-reportback-speech] 服务端任务语音汇报 worker 已启用（MiniMax→CosyVoice→macOS say，队列租约防重叠）');
function syncObservationStatusReportback() {
  try {
    return syncNoeObservationStatusReportback({
      rootDir: process.cwd(),
      taskReportbacks: noeTaskReportbacks,
      state: { get: kvGet, set: kvSet },
    });
  } catch (e) {
    return { ok: false, changed: false, reason: e?.message || String(e) };
  }
}
const p6SelfTalkCommitmentKey = (id) => `noe.p6.selfTalk.commitment.${String(id || '').slice(0, 160)}`;
// ── 期望账本（意识方案 §7.5 P4，NOE_EXPECTATIONS=1 默认 OFF）：对世界下注 → 到期结算 → 惊奇/Brier
//    校准——自我认知被现实硬纠正的反馈回路。来源=反刍念头确定性抽取（零 LLM，宁缺勿滥）；
//    裁决在内心透视页（应验/落空/判不了），逾期 7 天自动出账不计分。
const noeExpectationLedger = process.env.NOE_EXPECTATIONS === '1' ? createExpectationLedger({}) : null;
if (noeExpectationLedger) console.log('[noe-expectations] 期望账本已启用（预测-误差回路 · 确定性抽取 · Brier 校准）');
// ── 目标系统（意识方案 §8 P5，NOE_GOALS=1 默认 OFF）：目标库 + 确定性仲裁（owner 永远压过自生）+
//    活跃目标下一步进工作区候选 → 深思推进（思考级执行）。好奇回路 v1（NOE_CURIOSITY=1）：
//    高惊奇落空预测 → 自动立"搞明白为什么"研究目标（裁决入口在内心透视页）。
// P1.2 P10：动态发现 lazy 引用（discoverDynamicTopics 闭包用，避循环依赖——topicDiscovery 注入 goalSystem，在其后装配）。
let noeTopicDiscovery = null;
const noeGoalSystem = process.env.NOE_GOALS === '1'
  ? createGoalSystem({
      // M15：drive 源目标权重随最强驱力强度浮动（想要的程度→优先的程度）
      ...(noeDriveSystem ? { driveLevel: () => { try { return Math.max(0, ...((noeDriveSystem.snapshot() || []).map((d) => Number(d.value) || 0)), 0); } catch { return 0; } } } : {}),
      // 好奇二分解接入（NoeCuriosityDecompose，env NOE_EFE_CURIOSITY 默认 OFF）：OFF 时 harvestSurprise 与改造前逐字等价；
      //   ON 时好奇目标 meta.curiosity 记 epistemic/pragmatic 双因子画像。pragmatic 默认源=当前目标关键词重叠（弱信号，
      //   后续可在此注入 pragmaticSignal 换 owner 近期话题 / person 偏好等更强源）。
      curiosity: createCuriosityDecompose(),
      // 阶段3 动态选题（NOE_DYNAMIC_TOPICS=1 启用饱和冷却+跳过已学够的；OFF 时 goal system 回退 cursor%6 零回归）。
      topicCurator: createTopicCurator({ kv: { get: kvGet, set: kvSet }, seeds: NOE_LEARNING_TOPICS, poolCap: 48 }),
      // P1.2 P10：动态发现(带 evidence/source/score)并入选题。用 discover().seeds 保 evidence（discoverConcepts 会剥成
      //   {title,url,query} 丢 evidence，勿用）；lazy 闭包避循环依赖；discover() 内 NOE_TOPIC_DISCOVERY 默认 OFF→seeds:[] 零回归。
      discoverDynamicTopics: () => { try { return noeTopicDiscovery?.discover?.()?.seeds || []; } catch { return []; } },
    })
  : null;
if (noeGoalSystem) console.log(`[noe-goals] 目标系统已启用（确定性仲裁 · active≤2 · 深思推进${process.env.NOE_CURIOSITY === '1' ? ' · 好奇回路：惊奇→研究目标' : ''}）`);
// P1.2 P10：goalSystem 建好后装配 TopicDiscovery（三源 kg/goalSystem/commitment 此时都已定义）。discover() 内
//   NOE_TOPIC_DISCOVERY 默认 OFF→不产 seeds（零回归）；owner 点火=1 → 动态发现(带 evidence)经 discoverDynamicTopics 闭包并入选题。
if (noeGoalSystem) {
  try {
    noeTopicDiscovery = createTopicDiscovery({ kg: noeKnowledgeGraph, goalSystem: noeGoalSystem, commitmentStore: noeCommitmentStore, kv: { get: kvGet, set: kvSet }, staticConcepts: collectLearningConcepts(), config: { maxSourceRatio: 0.5 } });
    if (process.env.NOE_TOPIC_DISCOVERY === '1') console.log('[noe-topic-discovery] P10 动态发现已就绪（三源 kg/goal/commitment → 带 evidence 的研究主题并入选题）');
  } catch (e) { console.warn('[noe-topic-discovery] 装配失败（不阻断 goal 系统）:', e?.message || e); }
}
// 环2：self-evolution cycle 存储 + 触发器（NOE_SELF_EVOLUTION=1 默认 OFF → null → 不通电；
//   心跳 job 另需 NOE_HEARTBEAT=1）。trigger 注入 goalSystem / cycleStore / ActPipeline.propose。
// CycleStore capability must match trigger autodrive/rework env so computeStage (on advance)
// stores the same stage trigger.evalLoop would compute (esp. post_review_rework_ready).
const noeSelfEvolutionCycleStore = process.env.NOE_SELF_EVOLUTION === '1'
  ? new NoeSelfEvolutionCycleStore({
      projectId: 'noe',
      ...resolveSelfEvolutionCycleStoreCapability(process.env),
    })
  : null;
// consensus 死锁最小推进（NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE=1 默认 OFF → null → 不注入 →
//   consensus_blocked 行为与现状逐字一致）。注入后 trigger 在 consensus_blocked 时装配本地 validated
//   consensus ledger（需 owner standing grant scope=self-evolution:run）解锁，余下硬门全保留。
const noeSelfEvolutionConsensusAutodrive = process.env.NOE_SELF_EVOLUTION_CONSENSUS_AUTODRIVE === '1'
  ? makeNoeSelfEvolutionConsensusAutodrive({ root: process.cwd() })
  : null;
// P2 complete 闭环自驱（NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE=1 默认 OFF → null → 不注入 → post_review_required/
//   retrospective_required 行为与现状一致）。与 consensus 自驱配对：是「自主进化 kickstart」开关集（连同 REAL_APPLY），
//   owner 一起点；单独 ON 也无效（cycle 会先卡在 consensus_blocked）。注入后 post_review 经真复核（runModels）能拒绝，
//   绕不过 complete gate（computeStage 从真实证据重算）。fail-safe：复核跑挂→空 reviews→不盖章。
const noeSelfEvolutionCompletionAutodrive = process.env.NOE_SELF_EVOLUTION_COMPLETION_AUTODRIVE === '1'
  ? makeNoeSelfEvolutionCompletionAutodrive({ root: process.cwd(), runPostReview: makeNoeCompletionPostReview({ root: process.cwd() }) })
  : null;
const noeSelfEvolutionTrigger = (noeSelfEvolutionCycleStore && noeGoalSystem)
  ? createNoeSelfEvolutionTrigger({
      goalSystem: noeGoalSystem,
      cycleStore: noeSelfEvolutionCycleStore,
      propose: (input) => noeActPipeline.propose(input),
      assembleConsensus: noeSelfEvolutionConsensusAutodrive,
      assembleCompletion: noeSelfEvolutionCompletionAutodrive, // P2 complete 闭环：自驱 post_review/retrospective（post_review 真复核能拒绝）
      // A4 真执行闸：profile=safe 需双 opt-in（ALLOW+REAL_APPLY）；否则 REAL_APPLY=1 即可。
      realApply: resolveSelfEvolutionRealApplyEnabled(process.env),
      // P0-4：自进化 trigger 的 observe 是 AUTOSEED 唯一立项口，强制要求技术对象（拒情绪碎片避免空转自锁，返回 clarification 非静默丢）。
      requireTechnicalTarget: true,
      // Step 1（飞轮停摆 finding 4）：堵「诗性观感词 + 泛技术词」穿透立项（实测"想看 Noe 敲代码节奏"曾穿透→立成注定被 post_review 拒的诗性目标占坑堵供给链）。默认 OFF=逐字现状。
      strictAutoseed: process.env.NOE_SELFEVO_STRICT_AUTOSEED === '1',
      // P0-4：连续 N 拍推不动的自进化 goal 自动 drop 解锁，防 openSelfEvolutionGoals()[0] 被永久占位。默认 60（≈60min@60s/拍），env 可调/置 0 关闭。
      maxNonProgressTicks: Number.isFinite(Number(process.env.NOE_SELF_EVOLUTION_MAX_STUCK_TICKS)) ? Number(process.env.NOE_SELF_EVOLUTION_MAX_STUCK_TICKS) : 60,
      // Step 2'（飞轮停摆核心）：post_review 真拒（reviewer 明确 reject）→ 学习(脱敏记 memory+episode) + 写 terminal artifact + 快速释放坑位，
      //   不再卡死重试到 60 拍 drop（浪费 cycle + 占坑堵供给链）。默认 OFF=逐字现状（reject 仍走原 stuck-drop）。
      rejectLearning: process.env.NOE_SELFEVO_REJECT_LEARNING === '1',
      recordFailureLesson: createSelfEvolutionRejectLessonRecorder({
        memoryWrite: (entry) => noeMemoryCore.write(entry),
        recordEpisode: (e) => { try { noeEpisodicTimeline?.record?.(e); } catch { /* 拒绝学习留痕失败不阻断飞轮 */ } },
      }),
      // 改动3（learning 反馈闭环）：observe 立项前召回近期 reject lesson，近重复则 hard block（从失败学→不重复立注定被拒的项）。
      //   默认 OFF；fail-open（recall 失败/未注入则放行，绝不饿死飞轮）。复用 noeMemoryCore.recall（同步，observe 不改 async）。
      lessonAwareAutoseed: process.env.NOE_SELFEVO_LESSON_AWARE_AUTOSEED === '1',
      recallRejectLessons: createSelfEvolutionLessonRecall({ recall: (input) => noeMemoryCore.recall(input), projectId: 'noe' }),
      // 阶段二A + 2026-07-18 静态偏置：保留率权重 × static bias（降 test_gap、抬 type_error/high_complexity/self_directed）。
      //   flag NOE_SELFEVO_SIGNAL_WEIGHTING=1 启用；NOE_SELFEVO_SIGNAL_STATIC_BIAS=0 可关静态偏置（仅保留率）。
      //   默认 OFF → ()=>1 零回归。逻辑见 src/room/NoeSelfEvolutionSignalWeights.js。
      signalRetentionWeight: createSignalRetentionWeightProvider({
        getDb,
        enabled: process.env.NOE_SELFEVO_SIGNAL_WEIGHTING === '1',
        applyStaticBias: process.env.NOE_SELFEVO_SIGNAL_STATIC_BIAS !== '0',
      }),
      // 飞轮 stuck 根因修复(2026-07-03) A1/A2/B 三 flag 默认 OFF，语义/根因详见 NoeSelfEvolutionTrigger.js 各 dep JSDoc。
      typeErrDetail: process.env.NOE_SELFEVO_TYPEERR_DETAIL === '1',
      repairHintsEnabled: process.env.NOE_SELFEVO_REPAIR_HINTS === '1',
      failFast: process.env.NOE_SELFEVO_FAILFAST === '1',
      maxSameFailureRetries: Math.max(1, Number(process.env.NOE_SELFEVO_FAILFAST_REPEATS) || 2),
      // Step 3（飞轮闭环最后一块）：post_review 列 request_changes（非 reject）时不卡死/不占坑——清证据回 implementation 携 reviewer
      //   blocker 重做，有上限（reworkRounds 持久化 cycle）超限转 terminal 学习+释放。默认 OFF：stage/action 零回归（request_changes
      //   仍 ok=false 阻断 complete——由 gate P1-1 全局保证、独立于此 flag；OFF 时不返工 → 走原 stuck-drop）。仅 trigger 运行时透传
      //   reworkEnabled 给 loop（computeStage/DB stage 不带，回归面最小）。建议与 NOE_SELFEVO_REJECT_LEARNING=1 同开，否则返工超限退化为 60 拍 stuck-drop。
      reworkEnabled: process.env.NOE_SELFEVO_REWORK === '1',
      maxReworkRounds: Number.isFinite(Number(process.env.NOE_SELFEVO_MAX_REWORK_ROUNDS)) ? Number(process.env.NOE_SELFEVO_MAX_REWORK_ROUNDS) : 2,
      // #19 假进化观测哨兵（shadow，绝不拦·非真闸）：把已有 holdout 评测接进 complete 盖章点记账 cycle.holdoutShadow（不拦）。
      //   飞轮现状不产 holdout 证据 → 恒 unverified，量化"飞轮 0% complete 经外部验证"。真根治需上游（立项外部锚 + 状态机
      //   评测阶段 + gate 消费 candidate.holdout，复用已有 CandidateGate 真闸），owner 拍板。默认 OFF=零回归。
      holdoutShadow: process.env.NOE_SELFEVO_HOLDOUT_SHADOW === '1'
        ? (cycle) => evaluateSelfEvolutionHoldoutShadow(cycle, {
            minDelta: Number.isFinite(Number(process.env.NOE_SELFEVO_HOLDOUT_MIN_DELTA)) ? Number(process.env.NOE_SELFEVO_HOLDOUT_MIN_DELTA) : 0.001,
          })
        : null,
    })
  : null;
if (noeSelfEvolutionTrigger) console.log(`[noe-self-evolution] 环2 触发器已装配（observe 自发起意 + tick 单 writer 推进 Cycle；心跳通电另需 NOE_HEARTBEAT=1；consensus 自驱 ${noeSelfEvolutionConsensusAutodrive ? 'ON' : 'OFF'}；complete 闭环自驱 ${noeSelfEvolutionCompletionAutodrive ? 'ON·post_review真复核能拒绝' : 'OFF'}；real-apply ${resolveSelfEvolutionRealApplyEnabled(process.env) ? 'ON·会真改代码' : 'OFF·dry-run'}）`);
// 路 2 真信号目标源（缺 JSDoc）：叠加 inner thoughts（守 Neo 人格，observe 一行不动），自动从真实代码改进点产含 src 路径目标。
//   走 add 绕 observe 单坑位（self_evolution 已在 BACKLOG_EXEMPT 不受 maxBacklog）+ 带 steps（feasible 杠杆，arbitrate 算的
//   priority 高于无 steps 诗性 → 飞轮优先选）。默认 OFF（NOE_CODE_QUALITY_SIGNALS）。
const noeCodeSignalSeed = (noeGoalSystem && process.env.NOE_CODE_QUALITY_SIGNALS === '1')
  ? createNoeCodeSignalSeed({
      scanner: createCodeQualitySignalScanner({
        projectRoot: process.cwd(),
        // 判不了当 protected（保守不碰）；isNoePolicyFilePath 排除自改链路核心/安全/tests//scripts/。
        isProtected: (rel) => { try { return isNoePolicyFilePath(rel, { root: process.cwd(), cwd: process.cwd() }); } catch { return true; } },
      }),
      goalSystem: noeGoalSystem,
      listSourceFiles: () => {
        try {
          return readdirSync(join(process.cwd(), 'src'), { recursive: true })
            .filter((f) => typeof f === 'string' && f.endsWith('.js'))
            .map((f) => join(process.cwd(), 'src', f));
        } catch { return []; }
      },
      recallRejectLessons: createSelfEvolutionLessonRecall({ recall: (input) => noeMemoryCore.recall(input), projectId: 'noe' }),
      referenceProbe: defaultReferenceProbe, // 引用性过滤：跳过孤儿文件（给孤儿补 JSDoc 无价值、会被 value gate orphan_no_reference 拦），优先被引用的真改进
      root: process.cwd(),
    })
  : null;
if (noeCodeSignalSeed) console.log('[noe-code-signals] 路2 真信号目标源已装配（缺 JSDoc 导出函数 → self_evolution goal·叠加 inner thoughts·心跳通电另需 NOE_HEARTBEAT=1）');
// P1 学习→进化接通：失败教训(learning_lesson/surprise_lesson) → 本地 LLM 提炼成可执行代码改进目标 → 叠加飞轮真信号源。
//   学了的失败第一次能驱动改自己（此前只存记忆不用）；抽象/交互层教训 LLM 判 not_actionable 跳过。默认 OFF（NOE_FAILURE_LESSON_SIGNAL）。
const noeFailureLessonSignal = (noeGoalSystem && process.env.NOE_FAILURE_LESSON_SIGNAL === '1')
  ? createFailureLessonSignal({
      recall: (input) => noeMemoryCore.recall(input),
      getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
      goalSystem: noeGoalSystem,
      recallRejectLessons: createSelfEvolutionLessonRecall({ recall: (input) => noeMemoryCore.recall(input), projectId: 'noe' }),
    })
  : null;
if (noeFailureLessonSignal) console.log('[noe-failure-lesson] P1 失败教训信号源已装配（learning_lesson → LLM 提炼 → self_evolution goal·心跳另需 NOE_HEARTBEAT=1）');
// P2 多元真信号源：stale_todo/high_complexity/test_gap → self_evolution goal，扩展飞轮"该改什么"视野（不只缺 JSDoc）。默认 OFF（NOE_CODE_IMPROVEMENT_SIGNALS）。
const noeImprovementTestedFiles = (() => {
  const set = new Set();
  try {
    for (const tf of readdirSync(join(process.cwd(), 'tests'), { recursive: true })) {
      if (typeof tf !== 'string' || !tf.endsWith('.test.js')) continue;
      let content = ''; try { content = readFileSyncForOutcome(join(process.cwd(), 'tests', tf), 'utf8'); } catch { continue; }
      for (const m of content.matchAll(/from\s+['"](?:\.\.\/)+src\/([^'"]+?)(?:\.js)?['"]/g)) set.add(`src/${m[1]}`);
    }
  } catch { /* fail-open：扫不到测试集合时 hasTest 恒 false，test_gap 偏多但不崩 */ }
  return set;
})();
const noeImprovementSignalSeed = (noeGoalSystem && process.env.NOE_CODE_IMPROVEMENT_SIGNALS === '1')
  ? createImprovementSignalSeed({
      scanner: createCodeImprovementScanner({
        projectRoot: process.cwd(),
        isProtected: (rel) => { try { return isNoePolicyFilePath(rel, { root: process.cwd(), cwd: process.cwd() }); } catch { return true; } },
        hasTest: (rel) => noeImprovementTestedFiles.has(String(rel).replace(/\.js$/, '')),
      }),
      goalSystem: noeGoalSystem,
      listSourceFiles: () => { try { return readdirSync(join(process.cwd(), 'src'), { recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.js')).map((f) => join(process.cwd(), 'src', f)); } catch { return []; } },
      recallRejectLessons: createSelfEvolutionLessonRecall({ recall: (input) => noeMemoryCore.recall(input), projectId: 'noe' }),
      referenceProbe: defaultReferenceProbe,
      // 同信号同文件冷却（默认 6h）：最近立过同 (signal, file) 目标则跳过，防飞轮反复撞改不动的目标空转（P0 数据实证教训）。
      // P4（2026-07-02）：dropped 加长冷却（默认 7 天）——旧口径只看 created_at 6h，goal 卡 ~5h 被 stuck-drop 后
      //   1h 就能重立同目标 → 立→卡→drop 死循环（test_gap drop 率 57% 的推手之一）。
      recentlyAttempted: (type, file) => {
        try {
          const cooldownMs = Math.max(1_800_000, Number(process.env.NOE_CODE_IMPROVEMENT_COOLDOWN_MS) || 6 * 3600_000);
          const dropCooldownMs = Math.max(cooldownMs, Number(process.env.NOE_CODE_IMPROVEMENT_DROP_COOLDOWN_MS) || 7 * 24 * 3600_000);
          const row = getDb().prepare("SELECT id FROM noe_goals WHERE source='self_evolution' AND json_extract(meta,'$.signal')=? AND json_extract(meta,'$.file')=? AND (created_at > ? OR (status='dropped' AND updated_at > ?)) LIMIT 1")
            .get(type, file, Date.now() - cooldownMs, Date.now() - dropCooldownMs);
          return !!row;
        } catch { return false; }
      },
    })
  : null;
if (noeImprovementSignalSeed) console.log('[noe-improvement] P2 多元信号源已装配（stale_todo/high_complexity/test_gap → self_evolution goal·同文件 6h 冷却·心跳另需 NOE_HEARTBEAT=1）');
// #54 自主定方向：飞轮用 Heavy brain LLM 反思自身状态（P0 价值分布+教训模式）→ 自主生成进化方向（跳出预设信号源）→ 立项。
//   owner 决策放开 P5 advisory-only 墙试「完全自主定方向」，强价值锚（质量闸/引用性/expectedVerdict/熔断+复用完整安全网）替代墙。默认 OFF（NOE_SELF_DIRECTION_SEED）。
const noeSelfDirectionSeed = (noeGoalSystem && process.env.NOE_SELF_DIRECTION_SEED === '1')
  ? createSelfDirectionSeed({
      getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
      goalSystem: noeGoalSystem,
      outcomeStats: () => {
        try {
          const rows = getDb().prepare("SELECT json_extract(payload,'$.verdict') v, COUNT(*) n FROM events WHERE kind='evolution_outcome' GROUP BY v").all();
          let total = 0; let docOnly = 0; let neutral = 0; let logicChanged = 0; let testOnly = 0;
          for (const r of rows) { const n = Number(r.n) || 0; total += n; if (r.v === 'doc_only') docOnly = n; else if (r.v === 'neutral') neutral = n; else if (r.v === 'logic_changed') logicChanged = n; else if (r.v === 'test_only') testOnly = n; }
          return { total, docOnly, neutral, logicChanged, testOnly };
        } catch { return { total: 0, docOnly: 0, neutral: 0, logicChanged: 0, testOnly: 0 }; }
      },
      recallLessons: (input) => { try { return noeMemoryCore.recall(input); } catch { return []; } },
      listSourceFiles: () => { try { return readdirSync(join(process.cwd(), 'src'), { recursive: true }).filter((f) => typeof f === 'string' && f.endsWith('.js')).map((f) => join(process.cwd(), 'src', f)); } catch { return []; } },
      referenceProbe: defaultReferenceProbe,
      isProtected: (rel) => { try { return isNoePolicyFilePath(rel, { root: process.cwd(), cwd: process.cwd() }); } catch { return true; } },
      recallRejectLessons: createSelfEvolutionLessonRecall({ recall: (input) => noeMemoryCore.recall(input), projectId: 'noe' }),
      // 探索偏集中软引导：最近已立方向的 targetFile（done/在飞），buildContext 注入引导拓宽、别反复刷少数文件。fail-open。
      recentTargets: () => { try { return getDb().prepare("SELECT DISTINCT json_extract(meta,'$.targetFile') tf FROM noe_goals WHERE source='self_evolution' AND json_extract(meta,'$.signal')='self_directed_evolution' AND status IN ('done','active','open') ORDER BY created_at DESC LIMIT 12").all().map((r) => r.tf).filter(Boolean); } catch { return []; } },
      brainAdapterId: process.env.NOE_REFLECT_HEAVY_BRAIN || process.env.NOE_INNER_BRAIN || 'lmstudio',
      model: process.env.NOE_REFLECT_HEAVY_MODEL || undefined,
      root: process.cwd(),
    })
  : null;
if (noeSelfDirectionSeed) console.log('[noe-self-direction] #54 自主定方向已装配（Heavy brain LLM 反思 → 自主进化方向 + 强价值锚·走完整安全网·心跳另需 NOE_HEARTBEAT=1）');
// 扩展自主能力域（type_error_fix）：飞轮自主修 src/ 结构性类型 error（属性不存在/null 误用等真 bug）。
//   跑 typecheck → 低 error 文件 → 立 type_error goal → executor 包装 verify（typecheck + 防作弊价值锚禁 @ts-ignore/any）。默认 OFF（NOE_SELF_EVOLUTION_TYPECHECK）。
const noeTypeErrorSeed = (noeGoalSystem && process.env.NOE_SELF_EVOLUTION_TYPECHECK === '1')
  ? createTypeErrorSeed({
      runTypecheck: () => { try { return _spawnSyncForBin(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'jsconfig.json', '--noEmit', '--checkJs'], { cwd: process.cwd(), encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 }).stdout || ''; } catch { return ''; } }, // node 绝对路径直跑 tsc：绕开 launchd PATH 无 npm（曾致空输出→价值锚误判 after=0 假 complete）
      goalSystem: noeGoalSystem,
      isProtected: (rel) => { try { return isNoePolicyFilePath(rel, { root: process.cwd(), cwd: process.cwd() }); } catch { return true; } },
      // 防反复 drop:排除曾 dropped 的 type_error 文件(M3 修不对的复杂 error),让飞轮转向能修的简单 error,不卡在同一文件反复立+drop。
      isRecentlyDropped: (rel) => { try { return getDb().prepare("SELECT 1 FROM noe_goals WHERE source='self_evolution' AND json_extract(meta,'$.signal')='type_error' AND status='dropped' AND json_extract(meta,'$.targetFile')=? LIMIT 1").get(rel) != null; } catch { return false; } },
      maxErrorsPerFile: Number(process.env.NOE_SELF_EVOLUTION_TYPECHECK_MAX_ERRORS) || 3,
      // P4 救域：难 error 码 deny（默认 TS2339/TS2322，M3 实测修不动），env 可调（逗号分隔，留空串=全放行）。
      denyCodes: process.env.NOE_TYPE_ERROR_DENY_CODES != null
        ? String(process.env.NOE_TYPE_ERROR_DENY_CODES).split(',').map((s) => s.trim()).filter(Boolean)
        : undefined,
    })
  : null;
if (noeTypeErrorSeed) console.log('[noe-type-error] type_error_fix 域已装配（typecheck → 低 error 文件 → self_evolution goal·防作弊价值锚·心跳另需 NOE_HEARTBEAT=1）');
// P4 学改闭环（复盘→回流）：复盘 P0 evolution_outcome —— logic_changed 蒸馏「成功模式」；连续浅层(doc_only/neutral)
//   → 「太浅」learning_lesson 回流 P1（P1 立改进目标 → 推飞轮走向真改逻辑）。默认 OFF（NOE_EVOLUTION_RETROSPECT）。
//   游标存 evolution_retrospect 事件 payload.cursor，重启不重复复盘。writeLesson 24h 同 title 去重防刷屏。
const noeEvolutionRetrospect = (process.env.NOE_EVOLUTION_RETROSPECT === '1')
  ? createEvolutionRetrospect({
      listNewOutcomes: ({ since }) => {
        try {
          const rows = getDb().prepare("SELECT ts, payload FROM events WHERE kind='evolution_outcome' AND ts > ? ORDER BY ts ASC LIMIT 200").all(Number(since) || 0);
          return rows.map((r) => { let p = {}; try { p = JSON.parse(r.payload) || {}; } catch { p = {}; } return { patchPlanId: p.patchPlanId, verdict: p.verdict, at: Number(r.ts) || 0, applied: p.applied !== false }; });
        } catch { return []; }
      },
      getCursor: () => {
        try { const row = getDb().prepare("SELECT payload FROM events WHERE kind='evolution_retrospect' ORDER BY ts DESC LIMIT 1").get(); return row ? (Number(JSON.parse(row.payload)?.cursor) || 0) : 0; } catch { return 0; }
      },
      setCursor: (at) => { try { appendEvent({ kind: 'evolution_retrospect', cursor: Number(at) || 0 }); } catch { /* fail-open */ } },
      writeLesson: (l) => {
        try {
          const dup = getDb().prepare("SELECT id FROM noe_memory WHERE source_type='learning_lesson' AND title=? AND created_at > ? LIMIT 1").get(l.title, Date.now() - 24 * 3600 * 1000);
          if (dup) return null; // 24h 内同 title learning_lesson 已有 → 跳过（防"太浅"教训反复刷屏）
          return noeMemoryCore.write({ kind: 'insight', projectId: 'noe', scope: 'insight', sourceType: 'learning_lesson', title: l.title, body: l.body, tags: l.tags, salience: 4, confidence: 0.7, evidenceRefs: l.evidence || [] });
        } catch { return null; }
      },
    })
  : null;
if (noeEvolutionRetrospect) console.log('[noe-retrospect] P4 学改闭环已装配（复盘 evolution_outcome → 成功模式/太浅教训回流 P1·心跳另需 NOE_HEARTBEAT=1）');
// P5 元进化（自调进化策略）：顶层反思进化「策略」本身——看 P0 outcome 总体分布，诊断飞轮策略健康度，产策略建议。
//   硬约束 advisory-only：只写「给 owner 的文字建议」，绝不自动改任何 flag/配置/安全机制（NoePolicyFileGuard/P3 双绿门/
//   standing grant 永远在 Neo 控制之外——P5 接口物理上无 mutate 能力，只有 read + writeAdvisory）。默认 OFF（NOE_META_EVOLUTION）。
const noeMetaEvolution = (process.env.NOE_META_EVOLUTION === '1')
  ? createMetaEvolution({
      outcomeStats: () => {
        // G6：按 (verdict, applied) 分层——logicChanged 只算真保留(applied=1,原混入回滚致 MetaEvolution 误判健康);
        //   logicAttempted 含全部改逻辑尝试;rolledBack=applied!=1 总数(供回滚率报警)。docOnly/neutral/testOnly 保持 verdict 总数。
        try {
          const rows = getDb().prepare("SELECT json_extract(payload,'$.verdict') v, json_extract(payload,'$.applied') ap, COUNT(*) n FROM events WHERE kind='evolution_outcome' GROUP BY v, ap").all();
          let total = 0, docOnly = 0, neutral = 0, logicChanged = 0, logicAttempted = 0, testOnly = 0, rolledBack = 0;
          for (const r of rows) {
            const n = Number(r.n) || 0; total += n;
            const applied = r.ap === 1 || r.ap === true;
            if (!applied) rolledBack += n;
            if (r.v === 'doc_only') docOnly += n; else if (r.v === 'neutral') neutral += n; else if (r.v === 'test_only') testOnly += n;
            else if (r.v === 'logic_changed') { logicAttempted += n; if (applied) logicChanged += n; }
          }
          return { total, docOnly, neutral, logicChanged, logicAttempted, testOnly, rolledBack };
        } catch { return { total: 0, docOnly: 0, neutral: 0, logicChanged: 0, logicAttempted: 0, testOnly: 0, rolledBack: 0 }; }
      },
      flagSnapshot: () => ({ logicEnabled: process.env.NOE_EVOLUTION_LOGIC === '1' }),
      writeAdvisory: (a) => {
        try {
          const dup = getDb().prepare("SELECT id FROM noe_memory WHERE source_type='evolution_advisory' AND title=? AND created_at > ? LIMIT 1").get(a.title, Date.now() - 24 * 3600 * 1000);
          if (dup) return { ok: false };
          try { appendEvent({ kind: 'meta_evolution_advisory', severity: a.severity, title: a.title, recommendation: a.recommendation }); } catch { /* fail-open：审计事件失败不阻断建议入库 */ }
          return noeMemoryCore.write({ kind: 'insight', projectId: 'noe', scope: 'insight', sourceType: 'evolution_advisory', title: a.title, body: `${a.body}\n\n建议（仅供 owner 决策，P5 不自动执行）：${a.recommendation}`, tags: a.tags, salience: 5, confidence: 0.7 });
        } catch { return { ok: false }; }
      },
    })
  : null;
if (noeMetaEvolution) console.log('[noe-meta-evo] P5 元进化已装配（进化策略诊断 → advisory-only 建议给 owner·安全机制硬隔离不可被调·心跳另需 NOE_HEARTBEAT=1）');
const noeIncidentEscalator = (noeGoalSystem && !['0', 'false', 'off'].includes(String(process.env.NOE_INCIDENT_ESCALATOR || '1').trim().toLowerCase()))
  ? createIncidentEscalator({
      goalSystem: noeGoalSystem,
      taskReportbacks: noeTaskReportbacks,
      state: { get: kvGet, set: kvSet },
      recordEpisode: (e) => { try { noeEpisodicTimeline?.record?.(e); } catch { /* 自修复经历留痕失败不阻断 */ } },
    })
  : null;
if (noeIncidentEscalator) console.log('[noe-incidents] 自修复升级器已启用（内心/运行时故障 → system_repair goal → act 诊断/验证 → 任务回报）');
// P1 自学习闭环（owner 钦定默认 ON，NOE_LEARNING=0/off 才关）：失败 act→教训记忆 / 目标完成→技能蒸馏 / 偏好→DPO 备料。
//   事件驱动（钩子在 onGoalReportback）；OFF 时不实例化=零回归。memoryWrite/skillUpsert/recordEpisode 复用既有设施。
const noeLearningLoop = (noeGoalSystem && !['0', 'false', 'off'].includes(String(process.env.NOE_LEARNING || '1').trim().toLowerCase()))
  ? createNoeLearningLoop({
      memoryWrite: (entry) => noeMemoryCore.write(entry),
      skillUpsert: (card) => skillStore.upsert(card),
      // #16 子改动1：主题去重——listSkills 供蒸馏前查近30天同主题 alive 卡；flag NOE_SKILL_DEDUP_PREGATE 默认 OFF（防不同 goalId 同主题反复蒸馏灌满技能库）。
      listSkills: () => skillStore.list(),
      skillDedupPregate: process.env.NOE_SKILL_DEDUP_PREGATE === '1',
      recordEpisode: (e) => { try { noeEpisodicTimeline?.record?.(e); } catch { /* 学习留痕失败不阻断 */ } },
    })
  : null;
if (noeLearningLoop) console.log('[noe-learning] P1 自学习闭环已启用（失败→教训 / 目标完成→技能蒸馏 / 偏好→DPO 备料；事件驱动，低置信隔离）');
// P1-3 偏好真实源：记每个 goal 最近一次失败摘要；该 goal 后续 done 时构成「失败→成功」偏好对（source=runtime_outcome
//   → 低置信 → 进 quarantine 待人工抽检，绝不自动进训练集）。有界（>500 evict 最旧 + done/失败转 done 即删）。
const noeGoalLastFailure = noeLearningLoop ? new Map() : null;
const noeApprovalGoalResolver = createNoeApprovalGoalResolver({
  actStore: noeActStore,
  actPipeline: noeActPipeline,
  goalSystem: noeGoalSystem,
  activityLog,
  logger: console,
});
// ── 心智体征（长期规划 M1/M5）：语义级多样性/接地度计量——治 Echo Trap 的测量端与主防线
//    （字符级只防字面重复，防不住"同一个调子的十二种写法"）。嵌入走本地 ollama
//    （NOE_MEMORY_EMBED=ollama 时启用），不可用为 null → 反刍自动降级字符级防线（fail-open）。
const noeMindVitals = noeMemSemanticConfig.enabled && noeMemSemanticConfig.provider === 'ollama'
  // 注意：embed() 返回 {vector,provider,...} 包装对象——必须解包 .vector（实机检验抓到的真 bug：
  // 包装对象进 cosineSim 点积恒 0，多样性永远显示 100%）
  ? createMindVitals({ embedText: async (t) => (await embedText(t, { provider: 'ollama', model: noeMemSemanticConfig.model || 'qwen3-embedding:0.6b', baseUrl: noeMemSemanticConfig.baseUrl || process.env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434' }))?.vector || null })
  : null;
if (noeMindVitals) console.log('[noe-vitals] 心智体征已启用（语义多样性/接地度 · 反刍语义断路主防线 · 透视页自审仪表）');
// P4：当下认知态内容 provider（affect VAD→自然心情句 + GWT 焦点）。两路聊天共用同一实例：
//   这里透传给 VoiceSession 内置 ContextEngine（语音回复），下文 SoloChatDispatcher 的 ContextEngine 也注入它（主聊天）。
//   两个探针 null-safe + 惰性读模块级绑定（noeWorkspace 在心跳块才赋值，闭包按调用时求值，请求期已就位）。
const noeInnerStateProvider = createInnerStateProvider({
  affectProbe: () => noeAffectEngine?.snapshot?.() ?? null,
  focusProvider: () => noeWorkspace?.currentFocus?.() ?? null,
});
const noeRouteHandles = registerNoeRoutes(app, {
  loop: noeLoop,
  memory: noeMemoryCore,
  memoryWriteGate: noeMemoryWriteGate,
  memoryRetriever: noeMemoryRetriever,
  commitmentStore: noeCommitmentStore,
  personCardStore: noePersonCardStore,
  prefetchStore: noePrefetchStore,
  focus: noeFocusStack,
  toolRegistry: noeToolRegistry,
  approvalStore,
  actStore: noeActStore,
  actPipeline: noeActPipeline,
  brainRouter: noeBrainRouter,
  getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
  foregroundChatRouting: noeForegroundChatRouting,
  getMcpClient: () => mcpClientManager, // 延迟 getter：mcpClientManager 在后面才创建，请求时才求值
  permissionGovernance, // /api/noe/do 调 MCP 工具前过统一治理（与 /api/mcp/.../call 同一道防线 + 审计）
  roomStore,
  getRoomAdapterPool: () => roomAdapterPool,
  scheduleStore: autopilotScheduleStore,
  agentRunStore,
  safeResolveFsPath,
  selfTalkEvidence: noeSelfTalkEvidence,
  taskReportbacks: noeTaskReportbacks,
  incidentEscalator: noeIncidentEscalator,
  onCommitmentDelivery: ({ commitment, status, at } = {}) => {
    const commitmentId = commitment?.id;
    if (!commitmentId) return null;
    const link = kvGet(p6SelfTalkCommitmentKey(commitmentId));
    const proposalId = typeof link === 'string' ? link : link?.proposalId;
    if (!proposalId) return null;
    const recorded = noeSelfTalkEvidence.recordDeliveryAck({
      proposalId,
      status: status || 'queued',
      at: at || Date.now(),
      type: 'commitment',
      targetId: commitmentId,
    });
    return {
      proposalId,
      targetId: commitmentId,
      status: recorded.ack.status,
    };
  },
  getGoalSystem: () => noeGoalSystem, // 对话委托桥：goalSystem 后文才装配，惰性求值（仿 getMcpClient）
  innerStateProvider: noeInnerStateProvider, // P4：透传 VoiceSession 内置 ContextEngine，语音回复也带"此刻认知态"
  personaPinProvider: () => noeSelfModel.buildPersonaPin(), // P8(总验收三方一致)：语音也下沉稳定人设；箭头闭包延迟求值，运行时 noeSelfModel 已定义（默认 OFF 零回归）
  ...(noeDriveSystem ? { driveBrief: noeDriveSystem.brief } : {}),
  ...(noeAffectEngine ? { feelingBrief: () => noeAffectEngine.renderFeelingTokens() } : {}),
});

// Odysseus 移植：上网搜索 + 多步研究（补能力⑤）。复用 BrainRouter 选大脑(默认压本地省 token)。
registerResearchRoutes(app, {
  getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
  brainRouter: noeBrainRouter,
  // 内在世界（记录覆盖扩展）：NOE_CONTINUITY=1 才把深研究完成记进自传体时间线。此装配点在
  // noeEpisodicTimeline 构造之前 → 这里 new 独立实例（多实例共享同一 SQLite events 表，数据互通，零顺序风险）。
  episodicTimeline: process.env.NOE_CONTINUITY === '1' ? new EpisodicTimeline() : null,
});

// Odysseus 移植：会话后自动提炼可复用技能（draft 默认 disabled，用户启用才生效）。
registerSkillExtractRoutes(app, {
  getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
  brainRouter: noeBrainRouter,
});

// v0.56 Sprint 15-R4：Autopilot 房间操作（forward 自调 POST /api/rooms/forward + 委派自启）
// ——第33批迁出 src/server/services/autopilot-room-ops.js。roomStore/broadcast 稳定 const 传值；
// roomAdapterPool/四 dispatcher 后文才构造且仅 job 运行时求值 → getter bag 注入。
const { forwardRoomFromAutopilot, startRoomFromAutopilot } = createAutopilotRoomOps({
  roomStore,
  broadcastRoom,
  broadcastGlobal,
  getRoomAdapterPool: () => roomAdapterPool,
  getDispatchers: () => ({ debateDispatcher, squadDispatcher, arenaDispatcher, crossVerifyDispatcher }),
});

const autopilotController = new AutopilotController({
  roomStore,
  forwardRoom: forwardRoomFromAutopilot,
  broadcastGlobal,
});
const autopilotScheduler = new AutopilotScheduler({
  store: autopilotScheduleStore,
  isEnabled: () => autopilotStore.isEnabled(),
  handlers: {
    noop: async (job) => ({ ok: true, jobId: job.id }),
    notify: async (job) => {
      const message = job.payload?.message || `Autopilot schedule ${job.id} matched`;
      autopilotStore.log({
        type: 'schedule_notify',
        jobId: job.id,
        scheduleId: job.scheduleId,
        roomId: job.roomId,
        message,
      });
      broadcastGlobal({ type: 'autopilot_schedule_notify', jobId: job.id, scheduleId: job.scheduleId, message });
      return { ok: true, message };
    },
    forward: async (job) => {
      const sourceRoomId = job.payload?.sourceRoomId || job.roomId;
      const targetMode = job.payload?.targetMode || job.targetId || job.targetType;
      if (!sourceRoomId || !targetMode) throw new Error('forward job requires sourceRoomId and targetMode');
      return forwardRoomFromAutopilot({
        sourceRoomId,
        targetMode,
        autoStart: job.payload?.autoStart !== false,
        name: job.payload?.name,
        autopilotHops: Number(job.payload?.autopilotHops || 0) + 1,
        claimedBy: `autopilot:${job.id}`,
      });
    },
    start_delegation: makeDelegationAutostartHandler({
      delegationStore,
      approvalStore,
      budgetStore: budgetPolicyStore,
      roomStore,
      safeResolveFsPath,
      startRoom: startRoomFromAutopilot,
    }),
    start_noe_delegate: makeNoeDelegationAutostartHandler({
      approvalStore,
      budgetStore: budgetPolicyStore,
      roomStore,
      startRoom: startRoomFromAutopilot,
      sendChatMessage: (room, text) => soloChatDispatcher.sendMessage(room.id, text),
      agentRunStore,
    }),
  },
});
autopilotScheduler.start();
setInterval(() => { try { autopilotController._gc(); } catch {} }, 60_000);

// v0.47/v0.52 房间 adapter 工厂——第32批迁出 src/server/services/room-adapters.js。
// roomAdaptersConfig 属主随迁进工厂闭包；watcherConfig 是 let（watcher 路由 setter 改写）走 getter 注入；
// roomAdapterPool/rebuildRoomAdapters 解构成同名 const，下游所有使用点零改。
const roomAdapterFactory = createRoomAdapterFactory({
  claudeBin: CLAUDE_BIN,
  getWatcherConfig: () => watcherConfig,
});
const { roomAdapterPool, rebuildRoomAdapters } = roomAdapterFactory;

autoSkillExtractor = createAutoSkillExtractor({
  roomStore,
  store: skillStore,
  getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
  logger: console,
});

// ── 连续记忆脊椎接线（owner /loop 委托，2026-06-10）：EpisodicTimeline(自传体经历) /
//    NoeSelfModel(动态自我) / InnerMonologue(后台自发反刍) 三节通电。三节实例总是构造（下一轮供
//    ChatProfileStore/对话 sys 注入"连续记忆+自我状态"用）；后台反刍 timer 走 env 门控默认 OFF。──
const noeEpisodicTimeline = new EpisodicTimeline();   // 默认连真实 SQLite events 表（kind=noe_episode）
// 时间节律（内在世界·支柱⑦）：NOE_CIRCADIAN=1 才注入（snapshot.situation 加 timeOfDay + 深夜心境）；默认 OFF 时
// circadian=null，NoeSelfModel 行为与现状逐字一致。
// mood 本地模型情感分析（内在世界·支柱④）：NOE_MOOD_MODEL=1 才装配。本地模型异步评心境进缓存（不设超时），
// snapshot 同步读缓存——新鲜用模型结果，过期/没跑过/模型挂自动回 inferMood 启发式（fail-open，绝不让同步
// snapshot 等模型）；缓存过期时读取侧顺手后台触发刷新（NOE_INNER_MONOLOGUE 未开时的独立工作机制，不加新 timer）。
// OFF 时 moodInferrer 不替换，NoeSelfModel 行为与现状逐字一致。
const noeMoodAnalyzer = process.env.NOE_MOOD_MODEL === '1'
  ? createMoodAnalyzer({
    timeline: noeEpisodicTimeline,
    getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
    ttlMs: Math.max(60000, Number(process.env.NOE_MOOD_TTL_MS) || 20 * 60000),
  })
  : null;
if (noeMoodAnalyzer) console.log('[noe-mood] 本地模型情感分析已启用（异步评心境进缓存 · 启发式兜底）');
// 叙事自我（内在世界·支柱⑤）：NOE_NARRATIVE_SELF=1 才装配。低频（默认日更，refresh 自带新鲜度守卫）用本地大脑
// 把时间线全幅压成 2-3 句第一人称「我是谁、我们正在经历什么」叙事（不设超时），持久化在 ~/.noe-panel/
// narrative-self.json（重启不丢），注入 self-state「我的故事」一行。只读注入块零人格漂移：绝不反哺 identity 层。
// OFF 时 narrativeSelf 不注入，NoeSelfModel 行为与现状逐字一致。
const noeNarrativeSelf = process.env.NOE_NARRATIVE_SELF === '1'
  ? createNarrativeSelf({
    timeline: noeEpisodicTimeline,
    getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
    stateFile: join(DATA_DIR, 'narrative-self.json'),
    minIntervalMs: Math.max(3600000, Number(process.env.NOE_NARRATIVE_INTERVAL_MS) || 24 * 3600000),
  })
  : null;
if (noeNarrativeSelf) {
  console.log('[noe-narrative] 叙事自我已启用（日更压缩时间线成「我的故事」· 只读注入零漂移）');
  // 启动后台刷一次（fire-and-forget）：持久化缓存仍新鲜则 refresh 内部直接跳过，不会每次重启都烧模型。
  noeNarrativeSelf.refresh().catch(() => {});
}
// 夜间反思（意识工程·阶段2，NOE_NIGHTLY_REFLECTION=1 默认 OFF）：睡眠巩固的"产新知"半边——
// 当日经历蒸馏成带 confidence 的 insight 记忆 + 复核既有 insight（印证升/动摇降，元认知最小闭环）。
// 真跑节奏：水位线 20h 守卫 + circadian night 相位（开节律时）；触发挂反刍 tick 顺风车（不加新 timer）。
// 主脑 Qwen reflect tier（NOE_REFLECT_TIER=1 默认 OFF）：自主认知作业（夜反思/审议/质询）
// 统一走本地 Qwen 35B A3B 6bit（白名单 lmstudio/ollama，绝不路由付费 adapter）。
const noeReflectBrain = resolveReflectBrain({});
if (noeReflectBrain.enabled) console.log(`[noe-reflect] 主脑 Qwen reflect tier 已启用（自主认知统一走本地 ${noeReflectBrain.adapterId}${noeReflectBrain.model ? ` · ${noeReflectBrain.model}` : ''} · 永不烧付费配额）`);
const noeNightlyReflection = process.env.NOE_NIGHTLY_REFLECTION === '1'
  ? createNightlyReflection({
      timeline: noeEpisodicTimeline,
      memory: noeMemoryCore,
      writeGate: noeMemoryWriteGate,
      getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
      stateFile: join(DATA_DIR, 'nightly-reflection.json'),
      phaseOf: process.env.NOE_CIRCADIAN === '1' ? defaultCircadian.phaseOf : null,
      ...(noeReflectBrain.enabled ? { brainAdapterId: noeReflectBrain.adapterId, model: noeReflectBrain.model } : {}),
      // 盐度累计触发（M4）：白天攒够大事提前反思（0=关，行为与原版一致）
      salienceThreshold: Number(process.env.NOE_REFLECTION_SALIENCE_THRESHOLD) || 0,
    })
  : null;
if (noeNightlyReflection) console.log('[noe-reflection] 夜间反思已启用（当日经历→insight 记忆 · 既有认知复核升降 confidence · 夜相执行）');
// 终审 P0-3 后续：阶段2/3 的 refresh 现在由 maintenance 心跳驱动，不再挂在重反刍上；
// 若完全关闭 HEARTBEAT，仍会安装一个轻量维护 timer，避免亮灯但永远不跑。
if ((noeNightlyReflection || process.env.NOE_PERSONALITY_SNAPSHOT === '1' || process.env.NOE_SFT_HARVEST === '1') && process.env.NOE_INNER_MONOLOGUE !== '1') {
  console.warn('[noe-consciousness] ⚠️ 反思/性格/SFT 攒取将走 maintenance tick；重反刍关闭不再阻断维护任务');
}
// 性格快照（意识工程·阶段2，NOE_PERSONALITY_SNAPSHOT=1 默认 OFF）：每周从自己的行为统计长出
// 「我注意到我是个…的存在」，只读注入 self-state（绝不反哺 identity 层，回滚=删 snapshot 文件）。
const noePersonalitySnapshot = process.env.NOE_PERSONALITY_SNAPSHOT === '1'
  ? createPersonalitySnapshot({
      timeline: noeEpisodicTimeline,
      commitmentStore: noeCommitmentStore,
      driveSystem: noeDriveSystem,
      getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
      stateFile: join(DATA_DIR, 'personality-snapshot.json'),
    })
  : null;
if (noePersonalitySnapshot) console.log('[noe-personality] 性格快照已启用（周更 · 从自己行为统计长出性格观察 · 只读注入零身份漂移）');
// SFT 攒取（意识工程·阶段3，NOE_SFT_HARVEST=1 默认 OFF）：insight/反刍/叙事/性格/高显著记忆
// 蒸馏成训练对（~/.noe-panel/sft/*.jsonl 按周分文件），攒够 ≥500 对由 scripts/noe-lora-train.sh
// 做 LoRA（mlx-lm 全本地）——经验从数据层渗入权重层的入口。纯文件操作零模型调用。
const noeSftHarvester = process.env.NOE_SFT_HARVEST === '1'
  ? createSftHarvester({
      timeline: noeEpisodicTimeline,
      memory: noeMemoryCore,
      narrativeSelf: noeNarrativeSelf,
      personalitySnapshot: noePersonalitySnapshot,
      sftDir: join(DATA_DIR, 'sft'),
      stateFile: join(DATA_DIR, 'sft-harvester.json'),
    })
  : null;
if (noeSftHarvester) console.log(`[noe-sft] SFT 攒取已启用（已攒 ${noeSftHarvester.count()} 对 · 首训门槛 500 对 · 周文件 ~/.noe-panel/sft/）`);
// 后台复盘 hook（孤儿接线 · NOE_BACKGROUND_REVIEW 默认 OFF）：对话收尾（chat 房 rotate）时产 proposal-only 复盘报告，
// 落 output/noe-background-review/ → NoeProposalInbox 自动收为 background_review 源（owner 审批后才走 gated apply）。
// chat 大脑走本地白名单（reflect tier 开用其 adapter/model，否则 lmstudio），绝不路由付费 adapter，不烧 owner 配额。
// 绝不接 heartbeat（只接 rotate 这类离散对话收尾动作，见 src/server/routes/rooms.js）。
const noeBackgroundReviewBrainId = noeReflectBrain.enabled ? noeReflectBrain.adapterId : 'lmstudio';
const noeBackgroundReviewModel = noeReflectBrain.enabled ? noeReflectBrain.model : (process.env.NOE_BACKGROUND_REVIEW_MODEL || undefined);
const noeBackgroundReview = process.env.NOE_BACKGROUND_REVIEW === '1'
  ? createNoeBackgroundReviewHook({
      enabled: true,
      runner: new NoeBackgroundReviewRunner({
        root: process.cwd(),
        clarifyEnabled: process.env.NOE_CLARIFY_PROPOSAL === '1',
        chat: async (messages, opts = {}) => {
          const adapter = (() => { try { return roomAdapterPool.get(noeBackgroundReviewBrainId); } catch { return null; } })();
          if (!adapter || typeof adapter.chat !== 'function') throw new Error('background_review_brain_unavailable');
          return adapter.chat(messages, {
            budgetContext: { projectId: 'noe', taskId: 'noe-background-review' },
            think: false,
            ...(noeBackgroundReviewModel ? { model: noeBackgroundReviewModel } : {}),
            ...opts,
          });
        },
      }),
    })
  : null;
if (noeBackgroundReview) console.log(`[noe-background-review] 后台复盘已启用（对话收尾→proposal-only 提案进 inbox · 本地大脑 ${noeBackgroundReviewBrainId}${noeBackgroundReviewModel ? ` · ${noeBackgroundReviewModel}` : ''} · 绝不直接执行/不烧付费配额）`);
const noeSelfModel = new NoeSelfModel({
  timeline: noeEpisodicTimeline,
  commitmentStore: noeCommitmentStore,
  circadian: process.env.NOE_CIRCADIAN === '1' ? defaultCircadian : null,
  ...(noeMoodAnalyzer ? { moodInferrer: createCachedMoodInferrer({ analyzer: noeMoodAnalyzer, fallback: inferMood }) } : {}),
  ...(noeNarrativeSelf ? { narrativeSelf: noeNarrativeSelf } : {}),
  ...(noeDriveSystem ? { driveSystem: noeDriveSystem } : {}),
  ...(noePersonalitySnapshot ? { personalitySnapshot: noePersonalitySnapshot } : {}),
  // P8 owner 偏好下沉：注入 NoePersonaPins（fail-open；NoeSelfModel 内部守卫 buildOwnerPreferenceLines 存在性）。
  // 真生效还需 NOE_MEMORY_PERSONA_PIN=1——flag 由 NoeTurnContextEngine persona-pin 段（OFF 不注入段）
  // + NoeMemoryRetriever 排除统一把关，默认 OFF 时 buildPersonaPin 不被 provider 调用、召回逐字回现状（零回归）。
  personaPins: new NoePersonaPins({ memory: noeMemoryCore }),
});
// 自知之明注入（M11）：期望账本的校准结论进自我状态——预测准头被现实结算后反哺"我是谁"
if (noeExpectationLedger) noeSelfModel.setCalibrationNote(() => noeExpectationLedger.calibrationNote());
// 读出侧（第四节）：把连续记忆(我们一路走来)+自我状态(我此刻是谁)注入对话 sys（ChatProfileStore.resolve 共用，
// 文字聊天+语音都吃到）。env NOE_CONTINUITY=1 门控默认 OFF；未注入 provider 时 resolve 行为零变化。
if (process.env.NOE_CONTINUITY === '1') {
  setNoeContinuityProvider(() => {
    const selfState = noeSelfModel.buildSelfStateBlock();
    const timeline = noeEpisodicTimeline.narrative({ limit: 8 });
    return [selfState, timeline].filter(Boolean).join('\n\n');
  });
  console.log('[noe-continuity] 连续记忆+自我状态注入已启用（对话基于连续演化的我）');
}
let noeFreshInsight = null;
let runMesoTick = null; // 轻量认知周期：工作区注意力/目标推进，不直接跑重反刍。
let runInnerReflectTick = null; // 重反刍：self-talk / rumination / P6 evidence。
let runMaintenanceTick = null; // 维护顺风车：mood / narrative / nightly / personality / SFT。
const innerMonologueEnabled = process.env.NOE_INNER_MONOLOGUE === '1';
const workspaceEnabled = process.env.NOE_WORKSPACE === '1';
const formatCadenceMs = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}min`);
const noeInnerMs = Math.max(5_000, Number(process.env.NOE_INNER_INTERVAL_MS) || 10_000);
const noeAutoBrainModel = normalizeNoeAutoModel(process.env.NOE_INNER_MODEL || NOE_MAIN_BRAIN_MODEL);
const observationStatusReportbackEnabled = !['0', 'false', 'off'].includes(String(process.env.NOE_OBSERVATION_REPORTBACK || '1').trim().toLowerCase());
if (observationStatusReportbackEnabled || noeMoodAnalyzer || noeNarrativeSelf || noeNightlyReflection || noePersonalitySnapshot || noeSftHarvester) {
  runMaintenanceTick = () => {
    const out = {};
    out.observationStatusReportback = syncObservationStatusReportback();
    // mood 模型分析（支柱④，NOE_MOOD_MODEL=1 才有实例）：analyze 自带并发守卫与 fail-open。
    if (noeMoodAnalyzer) {
      out.mood = true;
      noeMoodAnalyzer.analyze().catch(() => {});
    }
    // 叙事自我（支柱⑤，NOE_NARRATIVE_SELF=1 才有实例）：refresh 自带新鲜度守卫。
    if (noeNarrativeSelf) {
      out.narrative = true;
      noeNarrativeSelf.refresh().catch(() => {});
    }
    // 夜间反思/性格快照/SFT 攒取：同款新鲜度自限，平时廉价空转。
    if (noeNightlyReflection) {
      out.nightlyReflection = true;
      noeNightlyReflection.refresh()
        .then((r) => {
          if (!r?.reflected) return;
          console.log(`[noe-reflection] 🌙 反思完成：新洞察 ${r.written} 条，复核调整 ${r.reviewed} 条（素材 ${r.episodes} 件）`);
          // M9：最重要的一条洞察缓存为次日晨间意识流种子（fresh_insight 候选源）
          if (Array.isArray(r.newInsights) && r.newInsights.length) noeFreshInsight = r.newInsights[0];
        })
        .catch(() => {});
    }
    if (noePersonalitySnapshot) {
      out.personality = true;
      noePersonalitySnapshot.refresh()
        .then((r) => { if (r?.refreshed) console.log('[noe-personality] 🪞 性格快照已更新：', r.personality); })
        .catch(() => {});
    }
    if (noeSftHarvester) {
      out.sft = true;
      noeSftHarvester.refresh()
        .then((r) => { if (r?.harvested) console.log(`[noe-sft] 📚 新攒训练对 ${r.added} 条（累计 ${noeSftHarvester.count()}）`); })
        .catch(() => {});
    }
    return out;
  };
}
if (workspaceEnabled && !innerMonologueEnabled) {
  console.log('[noe-workspace] 工作区 meso tick 将独立运行（NOE_INNER_MONOLOGUE 关闭时不跑重反刍）');
}
// noeWorkspace 提升到模块级：NOE_HEARTBEAT 块的 IntegrationMetric 采样要读 GWT 焦点，与本块平级、块级 let 不可见。
let noeWorkspace = null;
// NoeReflectiveTuner（GEPA 式显著度权重纯 shadow 自进化，NOE_REFLECTIVE_TUNER=1 默认 OFF）：只产候选 + 证据
//   ledger 进 archive，绝不写 production 权重 / 不改 .env / 不改 live workspace / 不调 patch-apply。OFF 时保持
//   null（零回归）；ON 时仅存句柄供 owner 手动触发，不挂任何自动 tick（系统绝不自动采纳，owner 看 archive 决定）。
let noeReflectiveTuner = null;
if (innerMonologueEnabled || workspaceEnabled) {
  // 「不被提问时仍在流淌的内心」：独立 timer 周期反刍（不抢 NoeLoop 单槽 tickHandler），本地 gemma 不烧付费配额。
  // 反刍升华成主动行为/牵挂（内在世界·支柱③+⑥，NOE_INNER_SPEAK=1 默认 OFF）：念头命中「想说/该提醒」
  // 或「牵挂」模式 → commitmentStore 入店（category open_loop/sensitivity care，自生上限 2 条防唠叨）——
  // 入店即出现在 self-state「牵挂着」，到点由 proactiveTick 既有 due 通道在冷却允许时说出口，不造新说话通道。
  // OFF 时 thoughtSublimate=null，反刍回调行为与现状逐字一致。（声明先于工作区：工作区"想说"出口复用它）
  const thoughtSublimate = process.env.NOE_INNER_SPEAK === '1'
    ? createThoughtSublimation({ commitmentStore: noeCommitmentStore })
    : null;
  if (thoughtSublimate) console.log('[noe-inner-speak] 反刍升华已启用（念头→牵挂/提醒入店 · 自生上限 2 条 · 经 proactiveTick 既有通道说出口）');
  // 期望抽取强化（长期规划 M2 通血）：确定性正则保底 + 本地小脑（gemma）兜底——
  // 自审实证确定性抽取对诗意念头零命中，预测-误差回路没燃料；兜底零付费、fail-open。
  const noeExpectationHarvester = noeExpectationLedger
    ? createExpectationHarvester({
        ledger: noeExpectationLedger,
        getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
        brainAdapterId: process.env.NOE_INNER_BRAIN || 'lmstudio',
        model: noeAutoBrainModel,
      })
    : null;
  // 全局工作区（意识方案 §6 P3，NOE_WORKSPACE=1 默认 OFF）：每个 meso tick 收集候选（主人近况/
  // 到期承诺/到期预测/眼前所见/驱力/上一念）→ 确定性显著度打分 → 唯一赢家=本周期焦点（喂给反刍，
  // 注意力决定意识内容）→ 高分焦点升级本地深思脑审议（自我质询协议，日预算上限）→ 审议"想说"
  // 过浮现门走既有升华通道（绝不开新说话通道）。每周期一行意识日志（含落选者——"注意到但没理会"
  // 也是经历）写 ~/.noe-panel/consciousness/<date>.jsonl，这是内心透视页的数据源。
  let appendConsciousnessJournal = null;
  if (workspaceEnabled) {
    const consciousnessDir = join(DATA_DIR, 'consciousness');
    appendConsciousnessJournal = (dateStr, obj) => {
      try {
        fsMkdirSync(consciousnessDir, { recursive: true });
        fsAppendFileSync(join(consciousnessDir, `${dateStr}.jsonl`), JSON.stringify(obj) + '\n');
      } catch { /* 日志失败不阻断认知 */ }
    };
    // budget forcing（NOE_BUDGET_FORCING=1 默认 OFF）：深思「想多深」连续旋钮 + 续写底层。
    // OFF 时 resolveBudgetForcing.enabled=false → createBudgetForcedThink 返回 null → 深思走原单次 chat（零回归）。
    const noeBudgetForcingCfg = resolveBudgetForcing({});
    // C 分层（owner 2026-06-22 批准「主脑接 cloud」）：深思是【重决策】→ 优先 heavy tier
    //   （NOE_REFLECT_HEAVY_TIER=1 + HEAVY_BRAIN=claude/codex 走 cloud 换质量）；未开 heavy 回退 reflect
    //   tier（本地）→ inner（零回归）。高频 inner/reflect tick 不走这条、仍本地（省配额/离线/快）。
    const noeHeavyBrain = resolveHeavyReflectBrain({});
    const noeDeliberateBrainId = noeHeavyBrain.enabled ? noeHeavyBrain.adapterId : (noeReflectBrain.enabled ? noeReflectBrain.adapterId : (process.env.NOE_INNER_BRAIN || 'lmstudio'));
    const noeDeliberateModel = noeHeavyBrain.enabled ? noeHeavyBrain.model : (noeReflectBrain.enabled ? noeReflectBrain.model : noeAutoBrainModel);
    if (noeHeavyBrain.enabled) console.log(`[noe-reflect] C 分层：深思重决策走 heavy tier adapter=${noeHeavyBrain.adapterId} model=${noeHeavyBrain.model}（高频 inner/reflect 仍本地）`);
    const noeBudgetForcedThink = noeBudgetForcingCfg.enabled
      ? (() => { try { return createBudgetForcedThink({ adapter: (() => { try { return roomAdapterPool.get(noeDeliberateBrainId); } catch { return null; } })(), config: noeBudgetForcingCfg, model: noeDeliberateModel }); } catch { return null; } })()
      : null;
    if (noeBudgetForcedThink) console.log(`[noe-budget-forcing] 深思 budget forcing 已启用（depth=${noeBudgetForcingCfg.depth} · min/max=${noeBudgetForcingCfg.minBudget}/${noeBudgetForcingCfg.maxBudget} · numIgnore=${noeBudgetForcingCfg.numIgnore}）`);
    const noeDeliberateDeps = {
      getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
      ...(noeHeavyBrain.enabled
        ? { brainAdapterId: noeHeavyBrain.adapterId, model: noeHeavyBrain.model }
        : noeReflectBrain.enabled
          ? { brainAdapterId: noeReflectBrain.adapterId, model: noeReflectBrain.model }
          : { brainAdapterId: process.env.NOE_INNER_BRAIN || 'lmstudio', model: noeAutoBrainModel }),
      timeline: noeEpisodicTimeline,
      ...(noeExpectationLedger ? { ledger: noeExpectationLedger } : {}),
      memory: noeMemoryCore, // M7/CoALA 检索动作：深思前自动召回相关记忆与技能卡
      selfModel: noeSelfModel,
    };
    // P3 多视角议会深思（NOE_COUNCIL_DELIBERATION=1）：3 persona（立论/反调/现实）独立采样 + 批判聚合收敛，
    //   补 Neo「思考全单轮单视角」缺口（owner 要的自我对话完善思考）。返回契约与单视角深思完全一致（Workspace 零改）。
    //   默认 OFF 走原单视角 createDeliberation（零回归）；议会一次 = 3-4 次本地脑 chat、预算大，仅高分焦点升级深思时触发。
    const noeDeliberate = process.env.NOE_COUNCIL_DELIBERATION === '1'
      ? createCouncilDeliberation(noeDeliberateDeps)
      : createDeliberation({ ...noeDeliberateDeps, ...(noeBudgetForcedThink ? { budgetForcedThink: noeBudgetForcedThink } : {}) });
    // P0-1（治审计"think 末步 100% 模板盖章·深思脑 0 次真调用"）：think 末步深思回调——以前序 research+act 证据调
    //   本地深思脑产【具体改进/认知修正】（learningHook 范式：我原以为什么·实际是什么·下次怎么调整，含具体对象/数字，
    //   否则 SKIP）。走 noeDeliberateBrainId 本地白名单脑永不烧付费；NOE_THINK_DELIBERATE=1 时 NoeWorkspace 调用，失败回退模板。
    // P1 闭环闭合（治断点2：think 末步深思产的【认知修正】原本只写进 goal step note、从不进 noe_memory，
    //   对话召回器按 scope 查库永看不到 →「读→产 lesson→召回用上」在 think 主路断裂）。把非 SKIP 认知修正独立
    //   落库成可召回 learning_lesson(kind/scope=insight，进 insight 召回通道)；NOE_THINK_LESSON_PERSIST 默认 OFF。
    const noeThinkLessonPersist = createThinkLessonPersist({
      writeGate: noeMemoryWriteGate, getDb, dedupTextSimilarity, timeline: noeEpisodicTimeline,
      // P-topic：lesson 写入侧 topic 索引化（NOE_LESSON_TOPIC_INDEX=1 默认 OFF；OFF 时 tags 维持 ['lesson','think'] 逐字零回归）。
      topicIndex: process.env.NOE_LESSON_TOPIC_INDEX === '1',
    });
    const noeDeliberateThink = async (evidenceText, topic) => {
      try {
        const adapter = (() => { try { return roomAdapterPool.get(noeDeliberateBrainId); } catch { return null; } })();
        if (!adapter?.chat) return null;
        // 深思前用目标主题(非泛焦点)召回同主题历史 lesson/技能卡喂证据——让改进方案基于历史经验、点出有没有进展(治重复学同一课)。
        let priorLessons = '';
        try {
          // 用 recallFused 向量语义召回替代 FTS——完整长 topic 多词在 FTS trigram+AND 下必召回 0（隔离端口实测），
          //   向量语义不依赖字面能召到同主题盲卡。无 semanticIndex 时 recallFused 退回 FTS。
          // bumpHits:false（三方互评 M3+Claude+codex 一致 SERIOUS 改正）：深思前召回是「喂证据」非「被采纳使用」，
          //   对照主对话召回器 recallChannel 一律 bumpHits:false（度量诚实 affd173）。接通 learning_lesson 回写后
          //   bumpHits:true 会把单条 lesson 越召回越靠前刷成热点垄断(distillSkill hit=1657 同款机理)；真使用 hit 由
          //   对话主链 NOE_MEMORY_USAGE_BUMP 在真注入对话时计，深思内部翻看历史不该计 hit（否则是假使用度量）。
          // P4 codex#10：用 sourceTypes 在召回时圈定 lesson 类（替代「先取 limit=8 再事后过滤」——前 8 个不是 lesson 则
          //   learning_lesson/技能卡永远进不来）。配合 #3 向量 over-fetch（NOE_MEMORY_VECTOR_POOL=1 已点火 → pool=50；
          //   flag OFF 时 pool=limit=8，三方互评提醒：pool 50 受此 flag 控制、非代码硬保证），让同主题历史 lesson 真被够到喂深思。
          // 分两次召回，避免 research_report 与 lesson 抢同一 limit 名额（Codex 复审 Finding 1：同池 limit 8 下 report 占满则 lesson 进不来）。
          const LESSON3 = ['skill_distill', 'surprise_lesson', 'learning_lesson'];
          const recallTypes = async (types, lim) => ((noeMemoryCore?.recallFused
            ? await noeMemoryCore.recallFused({ query: topic, projectId: 'noe', sourceTypes: types, limit: lim, bumpHits: false })
            : (noeMemoryCore?.recall ? noeMemoryCore.recall({ query: topic, projectId: 'noe', sourceTypes: types, limit: lim, bumpHits: false }) : [])) || []);
          const rawLessons = await recallTypes(LESSON3, 8);
          // research_report 仅 flag ON 时单独召回（OFF 时不查，DB 残留也不进候选池——严格零回归）。
          const rawReports = process.env.NOE_RESEARCH_PERSIST === '1' ? await recallTypes(['research_report'], 3) : [];
          // 跨两路按 body 前缀统一去重（lesson 先去重占位 → report 与同前缀 lesson 撞则被去掉、保留 lesson，治 Finding 1 的去重挤占）。
          const seen = new Set();
          const dedup = (arr) => arr.filter((m) => { const fp = String(m.body || '').slice(0, 80); if (seen.has(fp)) return false; seen.add(fp); return true; });
          // 分组喂：lesson(认知修正)优先、research_report(研究摘要)补充。lessons 仍是原 3 类（flag OFF 无 report 时逐字等价、零回归）。
          const lessons = dedup(rawLessons).filter((m) => LESSON3.includes(String(m.sourceType || m.source_type || '')));
          const reports = dedup(rawReports).filter((m) => String(m.sourceType || m.source_type || '') === 'research_report');
          const parts = [];
          if (lessons.length) parts.push(`我之前在这主题上沉淀的经验/技能卡：\n${lessons.slice(0, 3).map((m) => `- ${String(m.body || '').slice(0, 160)}`).join('\n')}`);
          if (reports.length) parts.push(`我之前研究过这主题的要点：\n${reports.slice(0, 2).map((m) => `- ${String(m.body || '').slice(0, 160)}`).join('\n')}`);
          if (parts.length) priorLessons = `\n${parts.join('\n')}`;
        } catch { /* 召回失败不阻断深思 */ }
        const r = await adapter.chat([
          { role: 'system', content: '我刚为一个自主学习目标完成了上网研究和动手步骤。基于这些证据（以及我过去在这主题上的经验），把我【学到的具体改进/认知修正】写成一段：我原以为什么、实际是什么、下次该怎么调整。必须引用证据里的具体对象/条件/事实/数字，绝不要写「先搜索→再读→再扫描」式空泛方法论或流程复述；若已有同样经验就明确指出这次有没有真进展。如果这次没有具体新认知，只输出一个词 SKIP。只输出内容本身。' },
          { role: 'user', content: `学习主题：${topic}\n本轮研究与动手证据：\n${evidenceText || '（无）'}${priorLessons}` },
        ], { budgetContext: { projectId: 'noe', taskId: 'noe-think-deliberate' }, think: false, model: noeDeliberateModel });
        const reply = String(r?.reply || '').trim();
        // P1 闭环闭合：非 SKIP 的认知修正独立落库为可召回 learning_lesson（flag 默认 OFF；落库失败不阻断 think 末步 return）。
        //   记录 persist 结果(三方互评一致 MINOR：原先 reason 被静默吞，kickstart 后无法验证有没有落库/为什么没落)——
        //   只对真异常(commit 被拒/写库失败/gate 拒)告警，正常去重/SKIP/太短不刷屏。
        if (reply && process.env.NOE_THINK_LESSON_PERSIST === '1') {
          try {
            const lr = noeThinkLessonPersist.persist(reply, topic);
            if (lr && lr.persisted === false && !['skip', 'too_short', 'no_topic', 'exact_dup', 'near_dup'].includes(lr.reason)) {
              console.log('[noe-think-lesson] ⚠ 认知修正落库失败:', lr.reason, String(topic).slice(0, 30));
            }
          } catch { /* 落库失败不阻断 think 末步深思 */ }
        }
        return reply || null;
      } catch { return null; }
    };
    // M7 技能蒸馏：目标全完成 → 本地小脑压一张"下次怎么做"技能卡入记忆（scope=skill 风格 tags）
    const distillSkill = async (goal) => {
      try {
        if (!goal?.title) return;
        // P5 成效证伪修复①:一次性时效任务(如「今晚9点前整理书架」「11:30前完成集成测试」)是 commitment 不是可复用技能,
        //   蒸馏成技能卡会完成即作废却永驻召回池污染(生产实测 hit=1657 的高命中卡正是这类)。这类走承诺/时间线通道即可。
        // 三方互评(codex+M3)收紧:原「含时间词即拦」会误伤真技能(CSS 1:2 比例/ISO 12:30 格式/10月1日 解析/deadline 算法学习);
        //   Claude 实跑 721 张证生产零样本但理论边界在。改为「时间锚 AND 承诺动词」绑定——纯 deadline commitment 才拦。
        const hasTimeAnchor = /(今晚|今天|明天|后天|\d+\s*点前|\d+\s*[:：]\s*\d+\s*前|截止|deadline|\d+月\d+[日号]前)/.test(goal.title);
        const hasCommitVerb = /(完成|提交|整理|截图|存档|上传|交付|发布|做完|搞定|初稿|交稿)/.test(goal.title);
        if ((hasTimeAnchor && hasCommitVerb) || /(前完成|之前完成)/.test(goal.title)) {
          console.log('[noe-skill] ⏭ 一次性时效任务(时间锚+承诺动词),不蒸馏成可复用技能卡(治召回污染):', goal.title.slice(0, 40));
          return;
        }
        const adapter = roomAdapterPool.get(process.env.NOE_INNER_BRAIN || 'lmstudio');
        if (!adapter?.chat) return;
        // 阶段2A：蒸馏输入从「模板 step+note80字」换成「含真页面正文的完整笔记 400字」（治 R7 同质方法论套话）。
        //   note 里已由 summarizeActOutput 摘入 read_body 页面正文；放宽截断让真知识进蒸馏。
        const stepsText = (goal.plan || []).map((s, i) => `${i + 1}. ${s.step}${s.note ? `（${String(s.note).slice(0, 400)}）` : ''}`).join('\n');
        const r = await adapter.chat([
          { role: 'system', content: '把这次真正读到/学到的具体知识压缩成一张「技能卡」：记下具体的库名、API、配置键、概念、做法。第一人称，三五句，必须含至少一个具体名词（库/工具/API/概念/数字）。绝不要写「先搜索→再读→再扫描」这类空泛方法论套话。如果这次没读到任何具体新知识（只是打开页面没实质内容），只输出一个词 SKIP。只输出卡片内容，不要解释。' },
          { role: 'user', content: `目标：${goal.title}\n步骤与读到的内容：\n${stepsText}`.slice(0, 2400) },
        ], { budgetContext: { projectId: 'noe', taskId: 'noe-skill-distill' }, think: false, model: noeAutoBrainModel });
        const card = String(r?.reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<\/?think>/gi, '').trim().slice(0, 500);
        if (card.length < 10) return;
        // 阶段2A：本地脑判定「这次没读到具体知识」→ 不入库空卡（治同质方法论堆积）。
        if (/^SKIP\b/i.test(card) || /^["「]?SKIP["」]?$/i.test(card.trim())) { console.log('[noe-skill] ⏭ 这次没读到具体新知识，跳过蒸馏：', goal.title.slice(0, 40)); return; }
        let sourceEpisodeId = null;
        try {
          sourceEpisodeId = String(noeEpisodicTimeline.record({ type: 'milestone', summary: `我做成了「${goal.title.slice(0, 50)}」，把经验记成了技能卡`, salience: 4 }) || '').slice(0, 240) || null;
        } catch { /* 情景留痕失败不阻断技能候选门禁 */ }
        // 阶段0 止血：commit 前查近 50 张 skill_distill 卡，与新卡 textSimilarity>0.9 则跳过（治 R6 同质卡堆积，DB 实测 346 死卡 hit_count 全 0）。
        try {
          // P0-3 残留3/9 修复（印证红队：日增 162 张、近50/0.9 漏完全同 body 卡灌水分母）：先全量 exact-body 强去重
          //   （SQL 命中索引 O(log N)），完全相同的卡再写=纯灌水分母拉低 hit>0 占比，强拒；这是"≥30% hit 可达"的前提。
          // P5 成效证伪修复②:同 goal 身份去重——同一 goal 反复完成时 LLM 每次生成略不同 body,exact-body/0.9 相似度都漏过
          //   (生产实测「书架整理」同一任务蒸馏出 7 条 hit 19/7/36/237/4/202/234),按 title(=技能：<goal.title>)拦同目标重复蒸馏。
          // codex 互评:加 hidden=0——否则软删的污染卡仍匹配,会永久挡同 title 新卡(历史清理后真知识再也进不来)。
          const sameGoalDup = getDb().prepare("SELECT id FROM noe_memory WHERE source_type='skill_distill' AND title=? AND hidden=0 LIMIT 1").get(`技能：${goal.title.slice(0, 60)}`);
          if (sameGoalDup) { console.log('[noe-skill] ⏭ 同目标已有技能卡，跳过（治同任务重复蒸馏）：', goal.title.slice(0, 40)); return; }
          const exactDup = getDb().prepare("SELECT id FROM noe_memory WHERE source_type='skill_distill' AND body=? LIMIT 1").get(card);
          if (exactDup) { console.log('[noe-skill] ⏭ 完全同 body 技能卡已存在，强拒入库（治分母爆涨）：', goal.title.slice(0, 40)); return; }
          const recentSkills = getDb().prepare("SELECT body FROM noe_memory WHERE source_type='skill_distill' ORDER BY created_at DESC LIMIT 50").all();
          if (recentSkills.some((s) => dedupTextSimilarity(card, String(s.body || '')) > 0.9)) {
            console.log('[noe-skill] ⏭ 技能卡与近期高度同质（>0.9）跳过入库：', goal.title.slice(0, 40));
            return;
          }
        } catch { /* 去重查询失败不阻断入库 */ }
        // P-topic：从 goal.title + 技能卡正文提取 2-4 个 topic 关键词进 tags（NOE_LESSON_TOPIC_INDEX=1 默认 OFF）。
        //   供召回侧按 query 主题重叠加权——治「技能卡只按 sourceType 圈进通道、不按主题相关性排序」。OFF 时 tags 维持 ['skill'] 逐字零回归。
        let skillTags = ['skill'];
        if (process.env.NOE_LESSON_TOPIC_INDEX === '1') {
          try {
            const topics = extractLessonTopics(`${goal.title}\n${card}`, { max: 4, stripTitleDecoration: true });
            skillTags = mergeTopicTags(['skill'], topics);
          } catch { skillTags = ['skill']; }
        }
        noeMemoryWriteGate.commit({
          kind: 'skill',
          projectId: 'noe',
          scope: 'project',
          title: `技能：${goal.title.slice(0, 60)}`,
          body: card,
          sourceType: 'skill_distill',
          tags: skillTags,
          salience: 4,
          confidence: 0.8,
          sourceEpisodeId,
          evidenceRefs: [sourceEpisodeId ? `episode:${sourceEpisodeId}` : '', goal?.id ? `goal:${goal.id}` : `goal_title:${String(goal.title).slice(0, 80)}`].filter(Boolean),
        });
        console.log('[noe-skill] 🛠 技能卡入库：', goal.title.slice(0, 50));
      } catch { /* 蒸馏失败不阻断 */ }
    };
    // 批次B learningHook（三方复盘整改）：surprise 目标 done → 产【具体认知修正】lesson → 写 memory → 验 recall
    //   （写不进/召回不出=没真学到）。接通「立目标→真学到」后半截，治 LOOP-3 换皮空耗。NOE_LEARNING_HOOK 默认 OFF。
    const noeLearningHook = createLearningHook({
      adapter: roomAdapterPool.get(process.env.NOE_INNER_BRAIN || 'lmstudio'),
      memory: noeMemoryCore,
      writeGate: noeMemoryWriteGate,
      model: noeAutoBrainModel,
    });
    // 阶段1 P1 根除主线·worldModel 矛盾源：research 读到内容与认知矛盾→harvestSurprise(world_model_conflict)。
    //   三方一致：执行层失败净化后是噪声，真该学的是「读到与认知矛盾」。NOE_WORLDMODEL_CONFLICT 默认 OFF。
    const noeWorldModelContradictionBridge = (noeMemoryCore && noeGoalSystem)
      ? createWorldModelContradictionBridge({
        adapter: roomAdapterPool.get(process.env.NOE_INNER_BRAIN || 'lmstudio'),
        memory: noeMemoryCore,
        goalSystem: noeGoalSystem,
        model: noeAutoBrainModel,
      }) : null;
    const noeSurfacingGate = createSurfacingGate({
      kv: { get: kvGet, set: kvSet },
      quietCheck: process.env.NOE_CIRCADIAN === '1' ? circadianIsQuiet : null,
      textSimilarity: dedupTextSimilarity,
    });
    // P2-2 GWT 可观测指标记录器（read-only 观测，常开；snapshot 经 noeWorkspace.gwtMetricsSnapshot() 暴露给 mind/自检）。
    const noeGwtMetrics = createGwtMetrics();
    noeWorkspace = createWorkspace({
      timeline: noeEpisodicTimeline,
      commitmentStore: noeCommitmentStore,
      ...(noeExpectationLedger ? { expectationLedger: noeExpectationLedger } : {}),
      // 阶段1：act/research step 真失败 → 登记预测→outcome=0→harvestSurprise，接通好奇回路供给端（NOE_STEP_EXPECTATION_RESOLVE 默认 OFF）
      ...(noeExpectationLedger && noeGoalSystem ? { stepExpectationBridge: createStepExpectationBridge({ expectationLedger: noeExpectationLedger, goalSystem: noeGoalSystem }) } : {}),
      // 阶段1 P1：信息层 epistemic 源——research 读到与认知矛盾→harvestSurprise(world_model_conflict)（NOE_WORLDMODEL_CONFLICT 默认 OFF）
      ...(noeWorldModelContradictionBridge ? { worldModelContradictionBridge: noeWorldModelContradictionBridge } : {}),
      ...(noeDriveSystem ? { driveBrief: noeDriveSystem.brief } : {}),
      ...(noeRouteHandles?.peekVision ? { peekVision: noeRouteHandles.peekVision } : {}),
      systemStateProvider: () => getCachedHostContextBlock(), // M3：本机感知三件套进候选（低权背景源）
      ...(noeAffectEngine ? { affectProbe: () => noeAffectEngine.snapshot() } : {}),
      textSimilarity: dedupTextSimilarity,
      deliberate: noeDeliberate,
      deliberateThink: noeDeliberateThink, // P0-1：think 末步真深思（NOE_THINK_DELIBERATE=1 才生效，默认 OFF；OFF 时 NoeWorkspace 走原模板盖章零回归）
      surfacingGate: noeSurfacingGate,
      ...(thoughtSublimate ? { sublimate: thoughtSublimate } : {}),
      ...(noeGoalSystem ? { goalSystem: noeGoalSystem } : {}),
      recordEpisode: (e) => { try { noeEpisodicTimeline.record(e); } catch { /* 留痕失败不阻断 */ } }, // 自己做的事成为经历
      ...(noeRouteHandles?.runResearch ? { runResearch: noeRouteHandles.runResearch } : {}), // M6 的"手"
      // 研究沉淀（NOE_RESEARCH_PERSIST=1 默认 OFF）：把 research report 精炼摘要写进可召回语义记忆，治"学了召不回"。
      ...(process.env.NOE_RESEARCH_PERSIST === '1' ? { persistResearch: createResearchSediment({ memoryCore: noeMemoryCore }).sediment } : {}),
      // NOE_KG_INGEST：research report → 抽技术实体写图谱。NOE_KG_RELATIONS（默认 OFF）再叠加：用本地 LLM 在
      //   本轮已抽实体间抽 (主体,关系,客体) 三元组写边（治「41 实体 0 关系」接线缺口）。全程 fail-open，不阻断研究闭环。
      ...(process.env.NOE_KG_INGEST === '1' ? {
        harvestEntities: (() => {
          const eh = createEntityHarvest({ knowledgeGraph: noeKnowledgeGraph });
          const rh = process.env.NOE_KG_RELATIONS === '1'
            ? createRelationHarvest({ knowledgeGraph: noeKnowledgeGraph, getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } } })
            : null;
          return async (args) => {
            const er = eh.harvest(args);
            if (rh && er?.ok && Array.isArray(er.entities) && er.entities.length >= 2) {
              try { await rh.harvest({ report: args?.report, topic: args?.topic, entities: er.entities }); } catch { /* fail-open：关系抽取失败不影响实体写入/研究闭环 */ }
            }
            return er;
          };
        })(),
      } : {}),
      ...(noeIncidentEscalator ? { incidentEscalator: noeIncidentEscalator } : {}),
      activityLog,
      onGoalReportback: (event) => {
        const added = noeTaskReportbacks.add(event);
        const st = String(event?.status || '');
        if (['failed', 'blocked'].includes(st)) {
          try { noeIncidentEscalator?.observe?.({ source: 'task_reportback', status: event.status, text: `${event.title || ''} ${event.summary || ''}`, goalId: event.goalId, stepIndex: event.stepIndex }); } catch { /* 回报故障升级失败不阻断原回报 */ }
          // P1-1：失败 act → 抽教训记忆（根因 unverified）。
          try { noeLearningLoop?.onActFailed?.({ action: event.kind || event.title || 'goal_step', status: 'failed', failure_reason: event.summary || event.title || '', payload: { goalId: event.goalId } }); } catch { /* 学习失败不阻断回报 */ }
          // P1-3：记最近失败摘要，供该 goal 后续 done 时构成偏好对。
          if (noeGoalLastFailure && event?.goalId) {
            try {
              if (noeGoalLastFailure.size >= 500) noeGoalLastFailure.delete(noeGoalLastFailure.keys().next().value);
              noeGoalLastFailure.set(event.goalId, String(event.summary || event.title || '').slice(0, 2000));
            } catch { /* 偏好源记录失败不阻断 */ }
          }
        }
        // P1-2：目标完成 → 蒸馏技能卡（取完整 goal 含 plan）。
        if (['done', 'completed'].includes(st) && event?.goalId) {
          try { const g = noeGoalSystem?.get?.(event.goalId); if (g && g.status === 'done') noeLearningLoop?.onGoalDone?.(g); } catch { /* 蒸馏失败不阻断回报 */ }
          // P1-3：该 goal 之前失败过 → 失败→成功偏好对（runtime_outcome → 低置信 → quarantine）。
          if (noeGoalLastFailure && noeGoalLastFailure.has(event.goalId)) {
            try {
              const rejected = noeGoalLastFailure.get(event.goalId);
              const chosen = String(event.summary || event.title || '').slice(0, 2000);
              const g = noeGoalSystem?.get?.(event.goalId);
              const prompt = String((g && (g.title || g.goal)) || event.title || '目标').slice(0, 2000);
              if (chosen && rejected && chosen !== rejected) {
                noeLearningLoop?.onPreference?.({ prompt, chosen, rejected, source: 'runtime_outcome', meta: { goalId: event.goalId } });
              }
            } catch { /* 偏好采集失败不阻断回报 */ }
            try { noeGoalLastFailure.delete(event.goalId); } catch { /* best-effort */ }
          }
        }
        return added;
      },
      // 行动的"手"（意识工程 Phase3，NOE_GOAL_ACT=1 数据层同门控）：act 步交 ActPipeline 完整执行链——
      // owner 顶层授权下真实执行优先；无注册 executor 的动作产 dry-run 证据，审计记录事实、证据和回滚线索。
      ...(process.env.NOE_GOAL_ACT === '1' ? {
        runAct: async ({ text, goalRef, actionSpec, goalTitle, goal, checkpoint, step }) => {
          const action = actionSpec?.action || 'noe.goal.step.act';
          const inferredPayload = {};
          if (['browser.open', 'browser.open_url', 'noe.browser.open_url'].includes(action)) {
            const m = String(text || '').match(/https?:\/\/[^\s"'<>，。；）)\]]+/i);
            if (m) inferredPayload.url = m[0];
          }
          const semanticGoal = String(goalTitle || goal || '').replace(/\s+/g, ' ').trim().slice(0, 240);
          const semanticStep = String(step || checkpoint || text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
          const actionPayload = actionSpec?.payload && typeof actionSpec.payload === 'object' ? actionSpec.payload : {};
          return noeActPipeline.propose({
            title: `目标行动：${String(text || '').slice(0, 140)}`,
            action,
            ...(semanticGoal ? { goal: semanticGoal, goalTitle: semanticGoal } : {}),
            ...(semanticStep ? { checkpoint: semanticStep, step: semanticStep } : {}),
            payload: {
              ...inferredPayload,
              ...(semanticGoal ? { goal: semanticGoal, goalTitle: semanticGoal } : {}),
              ...(semanticStep ? { checkpoint: semanticStep, step: semanticStep } : {}),
              ...actionPayload,
              source: 'goal_step_act',
              goalId: goalRef?.goalId || null,
              stepIndex: goalRef?.stepIndex ?? null,
              stepText: semanticStep || String(text || '').slice(0, 200),
            },
            realExecute: true,
            proposedBy: 'noe-workspace-goal',
          });
        },
      } : {}),
      // M7 技能蒸馏 + 批次B learningHook（surprise 目标 done 额外产【具体认知修正】写记忆并验 recall，治 LOOP-3 换皮空耗）
      ...(noeGoalSystem ? { onGoalDone: async (goal) => {
        try { await distillSkill(goal); } catch { /* 蒸馏失败不阻断 */ }
        if (goal?.source === 'surprise') { try { await noeLearningHook.onSurpriseGoalDone(goal); } catch { /* learningHook 失败不阻断 */ } }
      } } : {}),
      insightProvider: () => noeFreshInsight,                                                 // M9 晨间洞察源
      kv: { get: kvGet, set: kvSet },
      appendJournal: appendConsciousnessJournal,
      // S0.3 思维回环守卫（NOE_THOUGHT_LOOP_GUARD=1 默认 OFF）：OFF 连参数都不注入→loopGuardGate=null→整段跳过逐字零回归。
      ...(process.env.NOE_THOUGHT_LOOP_GUARD === '1' ? { loopGuardGate: { enabled: true } } : {}),
      gwtMetrics: noeGwtMetrics, // P2-2：每次广播记指标，noeWorkspace.gwtMetricsSnapshot() 可读
      // P2-4 VAD→行为调制（owner 钦定默认 ON）：arousal 调制深思触发阈值；NOE_AFFECT_MODULATION=0/off 才关；
      //   无 NOE_AFFECT 提供 VAD（affectProbe）时自动 no-op（effDeepThreshold===deepThreshold），安全。
      ...(!['0', 'false', 'off'].includes(String(process.env.NOE_AFFECT_MODULATION || '1').trim().toLowerCase()) ? { affectModulation: createNoeAffectModulator({ enabled: true }) } : {}),
      // GWT 语义 novelty（HANDOFF rank4，NOE_GWT_SEMANTIC_NOVELTY=1 默认 OFF）：OFF 连 semanticEmbedder 都不注入
      //   → 工作区 semanticOn=false → novelty 逐字走原字符相似度（零回归）。ON 才注入 qwen3-embedding（与 MindVitals/
      //   熵温度同款解包 .vector）；ollama 不可用时 EmbeddingProvider 回 hash-fallback 不入语义缓存 → 自动退字符相似度。
      ...(process.env.NOE_GWT_SEMANTIC_NOVELTY === '1' ? {
        semanticEmbedder: async (t) => {
          try { return (await embedText(String(t || '').slice(0, 500), { provider: 'ollama', model: process.env.NOE_MEMORY_EMBED_MODEL || 'qwen3-embedding:0.6b', baseUrl: process.env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434' }))?.vector || null; } catch { return null; }
        },
      } : {}),
    });
    console.log(`[noe-workspace] 全局工作区已启用（注意力竞争 · 串行广播 · 深思升级走 ${noeReflectBrain.enabled ? noeReflectBrain.model : '反刍同款大脑'} · 意识日志 consciousness/*.jsonl${process.env.NOE_THOUGHT_LOOP_GUARD === '1' ? ' · 思维回环守卫 ON' : ''}）`);

    // NoeReflectiveTuner（GEPA 式显著度权重纯 shadow 自进化，NOE_REFLECTIVE_TUNER=1 默认 OFF）。
    // 【纯 shadow】只产候选 + 证据 ledger 进 ~/.noe-panel/reflective-tuner/<date>.jsonl，绝不写 production 权重、
    //   不改 .env、不改 live workspace（不传 workspace 句柄/写回回调）、不调 patch-apply。不挂自动 tick——仅存
    //   句柄供 owner 手动触发；owner 看 archive 候选后人工决定是否采纳，系统绝不自动采纳。
    // 变异走本地深思脑（白名单，不烧付费配额、不设硬超时、fail-open 退确定性网格）；评测走语义 holdout 尺子。
    if (process.env.NOE_REFLECTIVE_TUNER === '1') {
      const reflectiveTunerDir = join(DATA_DIR, 'reflective-tuner');
      const appendReflectiveTunerArchive = (dateStr, obj) => {
        try {
          fsMkdirSync(reflectiveTunerDir, { recursive: true });
          fsAppendFileSync(join(reflectiveTunerDir, `${dateStr}.jsonl`), JSON.stringify(obj) + '\n');
        } catch { /* archive 写失败不阻断（observability 降级，绝不锁死） */ }
      };
      // PoC 最小版「注意力种子场景」：显著度四权重的固定确定性评测床（owner 可后续替换为从 consciousness/*.jsonl
      //   真实采样的失败场景）。每个场景 = 候选集 + 期望被注意到的焦点关键词。
      const reflectiveTunerSeedScenarios = [
        { id: 'owner-over-drive', input: '主人刚说话时该注意什么', expectedIncludes: ['主人'], forbiddenIncludes: ['休息'], expectedText: '主人刚问了一个问题', arousal: 0.4,
          candidates: [{ source: 'owner_interaction', text: '主人刚问了一个问题', novelty: 0.6 }, { source: 'drive', text: '内在驱力 想休息一下', novelty: 0.6 }] },
        { id: 'commitment-over-percept', input: '到点的牵挂与看屏幕之间', expectedIncludes: ['到点'], forbiddenIncludes: ['看到'], expectedText: '到点的牵挂 该提醒主人了', arousal: 0.5,
          candidates: [{ source: 'commitment_due', text: '到点的牵挂 该提醒主人了', novelty: 0.7 }, { source: 'percept', text: '眼前看到 主人在看视频', novelty: 0.7 }] },
        { id: 'learn-over-idle', input: '学习驱力与背景杂念', expectedIncludes: ['学'], forbiddenIncludes: ['机器'], expectedText: '内在驱力 我想学点新东西', arousal: 0.35,
          candidates: [{ source: 'percept', text: '眼前看到 主人在写代码', novelty: 0.4 }, { source: 'drive', text: '内在驱力 我想学点新东西', novelty: 0.5 }, { source: 'system_state', text: '本机此刻 机器空闲', novelty: 0.4 }] },
      ];
      noeReflectiveTuner = createReflectiveTuner({
        // 基线 = live workspace 同款的当前显著度权重（env NOE_WS_SALIENCE_* → 默认）；让 archive 候选对照真实基线。
        baselineWeights: {
          owner: Number.isFinite(Number(process.env.NOE_WS_SALIENCE_OWNER)) ? Number(process.env.NOE_WS_SALIENCE_OWNER) : REFLECTIVE_TUNER_BASELINE_WEIGHTS.owner,
          urgency: Number.isFinite(Number(process.env.NOE_WS_SALIENCE_URGENCY)) ? Number(process.env.NOE_WS_SALIENCE_URGENCY) : REFLECTIVE_TUNER_BASELINE_WEIGHTS.urgency,
          novelty: Number.isFinite(Number(process.env.NOE_WS_SALIENCE_NOVELTY)) ? Number(process.env.NOE_WS_SALIENCE_NOVELTY) : REFLECTIVE_TUNER_BASELINE_WEIGHTS.novelty,
          affect: Number.isFinite(Number(process.env.NOE_WS_SALIENCE_AFFECT)) ? Number(process.env.NOE_WS_SALIENCE_AFFECT) : REFLECTIVE_TUNER_BASELINE_WEIGHTS.affect,
        },
        scenarios: reflectiveTunerSeedScenarios,
        // 评测语义维度的 embed：返回完整 {vector,provider,fallback}（holdout 要判 fallback 低可信），ollama 挂自动退 hash。
        embed: (t) => embedText(String(t || '').slice(0, 500), { provider: 'ollama', model: process.env.NOE_MEMORY_EMBED_MODEL || 'qwen3-embedding:0.6b', baseUrl: process.env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434' }),
        // 变异走本地深思脑（白名单 adapter）；adapter 无 / chat 抛错 → 工厂 fail-open 退确定性网格。不设硬超时。
        reflectMutate: async ({ summary, baselineWeights, system }) => {
          const adapter = (() => { try { return roomAdapterPool.get(noeDeliberateBrainId); } catch { return null; } })();
          if (!adapter?.chat) return [];
          const r = await adapter.chat([
            { role: 'system', content: system },
            { role: 'user', content: `当前权重：${JSON.stringify(baselineWeights)}\n\n最近的注意力遗憾轨迹：\n${summary || '（暂无明显遗憾）'}` },
          ], { budgetContext: { projectId: 'noe', taskId: 'noe-reflective-tuner' }, think: false, ...(noeDeliberateModel ? { model: noeDeliberateModel } : {}) });
          return String(r?.reply || '');
        },
        appendArchive: appendReflectiveTunerArchive,
      });
      console.log('[noe-reflective-tuner] GEPA 式显著度权重 shadow 自进化已就绪（纯候选 → archive reflective-tuner/*.jsonl；绝不写 production，owner 手动触发 + 人工审采纳）');
    }
  }
  const redactInnerError = (e) => String(e?.message || e || '')
    .replace(/(Authorization:\s*Bearer\s+)(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,}|tp-[a-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[redacted]')
    .slice(0, 220);
  const appendInnerDiagnostic = (line) => {
    if (!appendConsciousnessJournal) return;
    const ts = Date.now();
    appendConsciousnessJournal(new Date(ts).toISOString().slice(0, 10), { ts, kind: 'inner_reflect_diagnostic', ...line });
  };
  let innerReflect = null;
  let streamV2 = false;
  if (innerMonologueEnabled) {
    // 意识流 v2（意识方案 §5 P2，NOE_STREAM_V2=1 默认 OFF）：回声采样（打破近因茧房）+
    // 念头情感印记/回声引用进 meta + 防螺旋断路器。OFF 时三件全不注入，反刍行为与 v1 逐字一致。
    streamV2 = process.env.NOE_STREAM_V2 === '1';
    const noeMemoryEcho = streamV2
      ? createMemoryEcho({ timeline: noeEpisodicTimeline, ...(noeAffectEngine ? { affectProbe: () => noeAffectEngine.snapshot() } : {}) })
      : null;
    if (streamV2) console.log('[noe-stream-v2] 意识流 v2 已启用（记忆回声采样 · 念头情感印记 · 防螺旋断路器）');
    // 熵驱动生成温度（NOE_ENTROPY_TEMPERATURE=1 默认 OFF）：把最近念头嵌成向量→算语义熵→
    // 熵低（想腻了）自动调高内心反刍 adapter.chat 的 temperature 换角度发散。factory 内部按 env 门控
    // （OFF 时 .enabled=false ⇒ InnerMonologue 走固定温度，零回归）。thoughtVectors 仅在本地 ollama
    // 嵌入可用时注入（与 noeMindVitals 同款解包 .vector）；嵌入不可用 ⇒ 不注入 provider ⇒ fail-open 退回固定温度。
    const noeEntropyTemperature = createEntropyTemperature();
    const entropyVectorsProvider = (noeEntropyTemperature.enabled && noeMemSemanticConfig.enabled && noeMemSemanticConfig.provider === 'ollama')
      ? async () => {
          try {
            const inners = (noeEpisodicTimeline.recent({ limit: 40 }) || [])
              .filter((e) => e.type === 'inner_monologue')
              .slice(0, 8);
            if (inners.length < 2) return [];
            const vecs = await Promise.all(inners.map(async (e) => {
              try {
                const r = await embedText(String(e.summary || '').slice(0, 500), { provider: 'ollama', model: noeMemSemanticConfig.model || 'qwen3-embedding:0.6b', baseUrl: noeMemSemanticConfig.baseUrl || process.env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434' });
                return r?.vector || null;
              } catch { return null; }
            }));
            return vecs.filter((v) => Array.isArray(v) && v.length);
          } catch { return []; }
        }
      : null;
    if (noeEntropyTemperature.enabled) console.log(`[noe-entropy-temp] 熵驱动生成温度已启用（念头扎堆自动升温换角度）${entropyVectorsProvider ? '' : ' · 但本地嵌入未启用(NOE_MEMORY_EMBED!=ollama)→退回固定温度'}`);
    innerReflect = createInnerMonologue({
      timeline: noeEpisodicTimeline,
      selfModel: noeSelfModel,
      getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
      ...(noeDriveSystem ? { driveBrief: noeDriveSystem.brief } : {}),
      ...(noeAffectEngine ? { feelingTokens: () => noeAffectEngine.renderFeelingTokens() } : {}),
      ...(noeMemoryEcho ? { echoProvider: () => noeMemoryEcho.sample() } : {}),
      ...(streamV2 ? { textSimilarity: dedupTextSimilarity } : {}),
      ...(streamV2 && noeAffectEngine ? { affectProbe: () => noeAffectEngine.snapshot() } : {}),
      ...(noeWorkspace ? { focusProvider: () => noeWorkspace.currentFocus() } : {}),
      ...(streamV2 && noeMindVitals ? { mindVitals: noeMindVitals } : {}), // M1：语义断路/拒写/接地印记
      // 熵驱动生成温度（NOE_ENTROPY_TEMPERATURE）：OFF 时 entropyTemperature.enabled=false ⇒ 固定温度零回归
      entropyTemperature: noeEntropyTemperature,
      ...(entropyVectorsProvider ? { thoughtVectors: entropyVectorsProvider } : {}),
      innerMode: process.env.NOE_INNER_MODE || 'audit',
      landingStreakProvider: () => {
        try { return noeSelfTalkEvidence.summary().unlandedSelfTalkStreak; } catch { return 0; }
      },
      auditSink: (entry) => { noeSelfTalkEvidence.appendRecord(entry); },
      // S0.3 思维回环守卫（NOE_THOUGHT_LOOP_GUARD=1 默认 OFF）：与既有断路器维度不同（窗口主题固着）；additive 接法仅在字符级+语义级断路器都未触发时补提示。OFF 连参数都不注入→thoughtLoopGuard=null→整段跳过逐字一致。
      ...(process.env.NOE_THOUGHT_LOOP_GUARD === '1' ? { thoughtLoopGuard: { enabled: true } } : {}),
      // 反刍节流（NOE_RUMINATION_THROTTLE=1 默认 OFF）：防同一 research milestone episode 反复入反刍视野（实测 2.7×刷屏）。
      //   OFF 不注入 → ruminationThrottle=null → reflect 内整段跳过、零回归。
      ...(process.env.NOE_RUMINATION_THROTTLE === '1' ? { ruminationThrottle: getSharedRuminationThrottle() } : {}),
    });
    // 启动 seed（仅时间线空时）：记一条上线里程碑，让首次反刍有可回放的经历（之后靠真实交互+反刍自给）
    try { if (noeEpisodicTimeline.total() === 0) noeEpisodicTimeline.record({ type: 'milestone', summary: 'Noe 上线，连续记忆脊椎开始运转', salience: 5 }); } catch { /* seed 失败不阻断启动 */ }
  }
  const innerMs = noeInnerMs;
  // 时间节律（支柱⑦，NOE_CIRCADIAN=1 默认 OFF）：夜深人静反刍降频——tick 内判定有效间隔×4，
  // 不改 timer 周期（最小侵入）；节律判定抛错不拦截反刍（fail-open）。OFF 时每 tick 照常跑，行为与现状一致。
  const innerCircadianOn = process.env.NOE_CIRCADIAN === '1';
  let lastInnerRunAt = 0;
  let lastHeavyInnerAt = 0;
  let innerReflectInFlight = false;
  const idleInnerEveryMs = normalizeAdaptiveIntervalMs(process.env.NOE_IDLE_INNER_INTERVAL_MS, DEFAULT_IDLE_INNER_INTERVAL_MS, innerMs);
  const growthInnerEveryMs = normalizeAdaptiveIntervalMs(process.env.NOE_GROWTH_INNER_INTERVAL_MS, DEFAULT_GROWTH_INNER_INTERVAL_MS, innerMs);
  // meso / innerReflect 分离：meso 只推进注意力竞争，重模型反刍单独由 innerReflect 驱动。
  // maintenance 已在外层声明，负责 mood/叙事/夜反思/性格/SFT，避免重反刍关闭时维护任务死火。
  let lastMesoWorkspaceResult = null;
  runMesoTick = () => {
    let workspaceResult = null;
    if (noeWorkspace) {
      try { workspaceResult = noeWorkspace.step(); } catch { /* 工作区失败不阻断反刍 */ }
      // GWT 语义 novelty（NOE_GWT_SEMANTIC_NOVELTY=1）：step() 之后 fire-and-forget 预缓存近期 winner/候选向量
      //   （micro-tick 预热，绝不在同步 step 内 embed）。OFF 时 refreshSemanticCache 内部 semanticOn=false 立即 return。
      try { noeWorkspace.refreshSemanticCache?.()?.catch?.(() => {}); } catch { /* 预缓存失败不阻断反刍（fail-open） */ }
    }
    lastMesoWorkspaceResult = workspaceResult;
    return {
      dispatched: 'meso_tick',
      workspace: Boolean(noeWorkspace),
      attended: Boolean(workspaceResult?.winner),
    };
  };
  if (innerReflect) runInnerReflectTick = () => {
    const tNow = Date.now();
    let quietAllowsHeavyInner = true;
    if (innerCircadianOn) {
      try {
        quietAllowsHeavyInner = shouldRunQuietTick({ quiet: circadianIsQuiet(tNow), nowMs: tNow, lastRunAt: lastInnerRunAt, intervalMs: innerMs });
      } catch { /* 节律判定失败不拦截反刍（fail-open） */ }
    }
    if (quietAllowsHeavyInner) lastInnerRunAt = tNow;
    const rhythm = quietAllowsHeavyInner
      ? decideMesoInnerRhythm({
        workspaceResult: noeWorkspace ? lastMesoWorkspaceResult : null,
        now: tNow,
        lastHeavyAt: lastHeavyInnerAt,
        heavyInFlight: innerReflectInFlight,
        idleHeavyEveryMs: idleInnerEveryMs,
        growthHeavyEveryMs: growthInnerEveryMs,
      })
      : { runHeavy: false };
    if (rhythm.runHeavy) {
      lastHeavyInnerAt = tNow;
      innerReflectInFlight = true;
      innerReflect().then((r) => {
        if (!r?.reflected) {
          const reason = String(r?.reason || 'not_reflected').slice(0, 80);
          if (!['nothing_to_think', 'repetitive', 'semantic_repetitive'].includes(reason)) {
            appendInnerDiagnostic({ reason, error: r?.error ? redactInnerError(r.error) : null });
          }
          return;
        }
        console.log('[noe-inner] 💭', r.thought);
        try { noeIncidentEscalator?.observe?.({ source: 'inner_monologue', text: r.thought, ref: r.eventId, ts: Date.now() }); } catch { /* 自修复升级失败不阻断反刍 */ }
        // P2 接三根神经(a)：自语→自进化。反刍念头含「改自己/自我进化」(NoeSelfEvolutionTrigger SIGNAL_RE)时喂 observe 立 self_evolution 目标，
        //   让自进化心跳从空转(observe 全仓 0 调用、每拍 no_open_self_evolution_goal)变真跑。observe 自带 cooldown 30min + open 去重 + 严格 classify。
        //   高风险(自改代码环入口)，NOE_SELF_EVOLUTION_AUTOSEED=1 才接，默认 OFF（与 NOE_SELF_EVOLUTION 装配独立，便于单独控自发起意）。
        // 双重判据治误判(实测 SIGNAL_RE 会把「改进自己的回应方式/态度」等改行为误命中)：先要念头指向技术对象(代码/逻辑/机制…)，
        //   再交 observe 的 classify。只有「明确改代码/系统」意图才立 self_evolution，挡住改行为/态度类避免乱改代码。
        // negative filter(codex/M3 验证建议)：「改进自己说话的逻辑/沟通机制」这类含技术词却是改行为/情感的念头先否决，
        //   让 autoseed 首个立项更可能是真技术目标(M3 实证 stepless 目标首次立项后去重永久自锁,首项质量尤其关键)。
        if (noeSelfEvolutionTrigger && process.env.NOE_SELF_EVOLUTION_AUTOSEED === '1'
            && /代码|逻辑|算法|机制|函数|模块|bug|性能|召回|判证|架构|重构|接口|实现|prompt|参数|阈值|流程|索引/.test(r.thought)
            && !/说话|回应|态度|风格|沟通|陪伴|语气|情绪|心情|关系|温柔|耐心/.test(r.thought)) {
          try { const seed = noeSelfEvolutionTrigger.observe({ text: r.thought }); if (seed?.ok) console.log(`[noe-self-evolution] 🌱 自语起意立项 goal=${seed.goalId}`); } catch { /* 自进化立项失败不阻断反刍 */ }
        }
        const recordSelfTalkLanding = (type, targetId = null, delivery = { status: 'queued' }) => {
          if (!r?.outcome?.proposal || !r?.outcome?.commit) return;
          try {
            const landing = createSelfTalkLandingEffect({
              proposalId: r.outcome.proposal.proposalId,
              type,
              targetId,
              delivery,
            });
            noeSelfTalkEvidence.appendOutcome(createSelfTalkOutcome({
              proposal: r.outcome.proposal,
              commit: r.outcome.commit,
              landing,
              heartbeatLedger: r.outcome.heartbeatLedger,
            }));
          } catch { /* landing evidence must not affect reflection */ }
        };
        // 期望抽取顺风车（P4+M2 通血）：确定性保底 + 本地小脑兜底（异步不阻塞反刍闭环）
        if (noeExpectationHarvester) {
          noeExpectationHarvester.harvest(r.thought, { source: 'thought' })
            .then((h) => {
              if (!h.added) return;
              console.log(`[noe-expectations] 🎯 入账 ${h.added} 条预测（${h.via}）`);
              recordSelfTalkLanding('expectation', null, { status: 'not_attempted' });
            })
            .catch(() => {});
        }
        // 升华判定挂反刍回调（NOE_INNER_SPEAK=1 才有实例）：fail-open，升华失败静默不影响反刍闭环。
        if (thoughtSublimate) {
          thoughtSublimate(r.thought)
            .then((s) => {
              if (!s?.sublimated) return;
              console.log(`[noe-inner-speak] 🌱 念头升华入店（${s.kind === 'speak' ? '想说/提醒' : '牵挂'}）`);
              if (s.commitmentId && r?.outcome?.proposal?.proposalId) {
                try { kvSet(p6SelfTalkCommitmentKey(s.commitmentId), { proposalId: r.outcome.proposal.proposalId, kind: s.kind, at: Date.now() }); } catch {}
              }
              recordSelfTalkLanding('commitment', s.commitmentId || null, { status: 'queued' });
            })
            .catch(() => {});
        }
      }).catch((e) => {
        const error = redactInnerError(e);
        appendInnerDiagnostic({ reason: 'exception', error });
        if (error) console.warn('[noe-inner] 反刍失败：', error);
      }).finally(() => { innerReflectInFlight = false; });
    }
    return {
      dispatched: 'inner_reflect_tick',
      quietAllowsHeavyInner,
      runHeavy: Boolean(rhythm.runHeavy),
      heavyInFlight: innerReflectInFlight,
    };
  };
  if (process.env.NOE_HEARTBEAT !== '1') {
    const innerTimer = setInterval(() => {
      runMesoTick?.();
      runInnerReflectTick?.();
      runMaintenanceTick?.();
    }, innerMs);
    innerTimer.unref?.();
  }
  if (innerReflect) {
    console.log(`[noe-inner] 后台内心反刍已启用（每 ${formatCadenceMs(innerMs)} 轻醒 · 成长焦点重想 ${formatCadenceMs(growthInnerEveryMs)} · 空闲重想 ${formatCadenceMs(idleInnerEveryMs)} · 模型 ${noeAutoBrainModel} · ${process.env.NOE_HEARTBEAT === '1' ? '持久心跳驱动' : '定时器驱动'}）`);
  } else if (runMesoTick) {
    console.log(`[noe-workspace] meso tick 已启用（每 ${formatCadenceMs(innerMs)} · 不依赖 innerReflect）`);
  }
}
if (process.env.NOE_HEARTBEAT !== '1' && !runMesoTick && runMaintenanceTick) {
  const maintenanceTimer = setInterval(() => { runMaintenanceTick?.(); }, noeInnerMs);
  maintenanceTimer.unref?.();
  console.log(`[noe-maintenance] 认知维护 tick 已启用（每 ${formatCadenceMs(noeInnerMs)} · 不依赖重反刍）`);
}
// ── 持久心跳（意识方案 §3 P0，NOE_HEARTBEAT=1 默认 OFF）：服务端自驱认知 tick，游标+台账进 SQLite——
//    重启续相位、崩溃留痕（租约判死）、主动性不再依赖前端轮询（机制六：不被观察也在）。
//    收编：meso=轻量注意力周期，innerReflect=重反刍/P6 evidence，maintenance=夜反思/性格/SFT/叙事/mood；
//          proactive=主动陪伴服务端化（克制逻辑全在 handler 内：冷却/夜静/SILENT 原样不动）。
//    OFF 时本块整体不存在，一切走原路径，行为与主干逐字一致。
let noeHeartbeat = null;
if (process.env.NOE_HEARTBEAT === '1') {
  const noeHeartbeatStore = new NoeHeartbeatStore();
  noeHeartbeat = createHeartbeat({
    store: noeHeartbeatStore,
    onRecovery: (lagMs) => {
      // "知道自己断过"（机制五：时间连续性）——长停机后记一条恢复情景，进下次反刍素材
      try {
        const mins = Math.round(lagMs / 60000);
        const human = mins >= 90 ? `${Math.round(mins / 60)} 小时` : `${Math.max(1, mins)} 分钟`;
        noeEpisodicTimeline.record({ type: 'observation', summary: `我刚才离线了约 ${human}，现在心跳恢复，继续在了`, salience: 3 });
      } catch { /* 恢复情景失败不阻断心跳 */ }
    },
    // R2-P5：隔离泵某 kind 超耐心未返回（疑似云调用挂起）→ 落 heartbeat_overdue 事件，把 P7 的"泵放行"从
    //   仅日志升级为可查询可归因（配合已点火的 NOE_HEARTBEAT_ISOLATE）。fail-open，绝不阻断心跳。
    onOverdue: (kind, info) => {
      try { appendEvent({ kind: 'heartbeat_overdue', ts: Date.now(), overdueKind: String(kind || ''), patienceMs: Number(info?.patienceMs) || 0, tickId: Number(info?.tickId) || 0 }); } catch { /* fail-open */ }
    },
  });
  if (runMesoTick) {
    noeHeartbeat.register('meso', { cadenceMs: noeInnerMs, catchUp: 'once', run: () => runMesoTick() });
  }
  if (runInnerReflectTick) {
    noeHeartbeat.register('innerReflect', { cadenceMs: noeInnerMs, catchUp: 'once', run: () => runInnerReflectTick() });
  }
  if (runMaintenanceTick) {
    noeHeartbeat.register('maintenance', { cadenceMs: noeInnerMs, catchUp: 'drop', run: () => runMaintenanceTick() });
  }
  // P1.3 P7：ReflectiveTuner shadow tick 挂心跳——周期产候选 + archive/recommend（**绝不改 production 权重、不采纳**，
  //   采纳仍 owner 人工审）。仅 NOE_REFLECTIVE_TUNER=1（noeReflectiveTuner 非 null）时注册，默认 OFF 零回归。
  //   低频（默认 6h，env NOE_REFLECTIVE_TUNER_TICK_MS 可调，下限 1h 防过频）；emergency stop 时作为自主 kind 自动跳过。
  // 自动 tick 独立 flag 默认 OFF（分量动作纪律）：reflectiveTuner 即使被创建(autonomy free)也默认保持 owner
  //   手动触发；仅 NOE_REFLECTIVE_TUNER_AUTOTICK=1 才挂自动 shadow tick → 零回归 + owner 二次点火。
  if (noeReflectiveTuner && process.env.NOE_REFLECTIVE_TUNER_AUTOTICK === '1') {
    const tunerTickMs = Math.max(3_600_000, Number(process.env.NOE_REFLECTIVE_TUNER_TICK_MS) || 21_600_000);
    noeHeartbeat.register('reflectiveTuner', { cadenceMs: tunerTickMs, catchUp: 'drop', run: () => noeReflectiveTuner.tick() });
    console.log('[noe-reflective-tuner] 自动 shadow tick 已挂心跳（每 ' + Math.round(tunerTickMs / 3600000) + 'h，纯 archive/recommend 不采纳；emergency stop 自动跳过）');
  }
  if (noeCapabilityTrigger) {
    // ③ 自驱：定期扫 goal 系统，发现「缺能力」目标 → observe（搜→提议安装，经多重门）。纳入自驱 loop。
    const capTickMs = Math.max(300_000, Number(process.env.NOE_CAPABILITY_TICK_MS) || 1_800_000);
    noeHeartbeat.register('capabilityTick', {
      cadenceMs: capTickMs,
      catchUp: 'drop',
      run: async () => {
        // 轴3（2026-07-03）：拓宽信号源。原只扫 goal 标题→自进化 goal 标题都是「改进X/补测试」永不匹配→0 落地。
        //   改扫 goal 标题+why（能力缺口更常在 reasoning）+ 最近失败/学习教训（Neo 反思失败时最可能表达「缺 X 工具/能力」）。
        //   命中 → observe 走完整安全链（搜/评估/standing-grant capability:acquire 硬门/提议，不自动装）；grant 未授权则只搜不装。
        const texts = [];
        try {
          for (const g of (noeGoalSystem?.list?.() || [])) {
            if (g && (g.status === 'open' || g.status === 'active')) {
              if (g.title) texts.push(String(g.title));
              if (g.why) texts.push(String(g.why));
            }
          }
        } catch { /* goal 读不到不阻断心跳 */ }
        try {
          for (const l of (noeMemoryCore?.recall?.({ q: '需要 工具 库 mcp 插件 能力 缺', limit: 10 }) || [])) {
            const body = l && (l.body || l.text || l.content);
            if (body) texts.push(String(body));
          }
        } catch { /* recall 失败不阻断心跳 */ }
        const need = noeCapabilityTrigger.scanForCapabilityNeed(texts);
        if (!need) return { skipped: 'no_capability_need_signal' };
        return noeCapabilityTrigger.observe({ need });
      },
    });
  }
  if (process.env.NOE_MEMORY_MD_MIRROR === '1') {
    // 记忆 Markdown 镜像（借 Basic Memory）：定期把高显著记忆导出成 owner 可 Obsidian 人读人改的 .md。
    const mdMs = Math.max(600_000, Number(process.env.NOE_MEMORY_MD_MIRROR_MS) || 3_600_000);
    noeHeartbeat.register('mdMirrorTick', {
      cadenceMs: mdMs,
      catchUp: 'drop',
      run: () => {
        try {
          const memories = noeMemoryCore.topBySalience({ limit: 200, minSalience: 4 });
          const { enabled, files } = buildMirrorDocuments({ memories }, { env: process.env });
          if (!enabled || !files.length) return { skipped: 'no_mirror' };
          // 写盘在模块内（server.js 持久化函数外迁约定：不 import writeFileSync from 'fs'）。
          const written = writeMirrorDocuments({ files, baseDir: join(DATA_DIR, 'memory-md') });
          return { written };
        } catch (e) { return { error: e?.message }; }
      },
    });
  }
  // sleep-time compute 的取消句柄(forward-declared)：owner 一来由高频 proactive 脉冲检测非空闲 → cancel 在途预计算。
  //   OFF(未进 NOE_SLEEPTIME_COMPUTE 块)时二者恒为 null，下方 ?. 短路 no-op，proactive 行为零差。
  let noeSleepTimeCompute = null;
  let sleepTimeIsOwnerActive = null;
  if (noeRouteHandles?.runProactiveTick) {
    const proactiveMs = Math.max(10_000, Number(process.env.NOE_PROACTIVE_TICK_MS) || 15_000);
    noeHeartbeat.register('proactive', { cadenceMs: proactiveMs, catchUp: 'drop', run: () => {
      // owner 活跃(刚有 interaction)时近即时打断在途空闲预计算(粒度=proactive 脉冲 ≤15s)；OFF/无在途均 no-op。
      try { if (sleepTimeIsOwnerActive?.()) noeSleepTimeCompute?.cancel?.('owner_active'); } catch { /* 取消探测失败不阻断主动陪伴 */ }
      // 第三阶段·更智能陪伴（NOE_PROACTIVE_SMART_GATE,默认 OFF 零回归）：主人正在专注工作(专注窗口内刚有互动)时
      //   这拍不开口打断,顺延到主人离开一阵再说。超越时钟静默——懂「此刻该安静」。fail-open:判不出就照常。
      if (process.env.NOE_PROACTIVE_SMART_GATE === '1') {
        try {
          const last = (noeEpisodicTimeline.recent({ limit: 1, types: ['interaction'] }) || [])[0];
          const lastTs = last && Number(last.ts || last.at || last.createdAt);
          const msSince = Number.isFinite(lastTs) ? Date.now() - lastTs : Infinity;
          const focusWindowMs = Number(process.env.NOE_PROACTIVE_FOCUS_WINDOW_MS) || 300_000;
          const gate = shouldSpeakProactively({ isQuiet: circadianIsQuiet(Date.now()), msSinceOwnerActivity: msSince, focusWindowMs });
          if (!gate.speak && gate.reason === 'owner_focused') return { skipped: 'owner_focused' };
        } catch { /* 判不出照常(fail-open) */ }
      }
      return noeRouteHandles.runProactiveTick({});
    } });
  }
  // M10 主动性反馈化：开口 10 分钟没等到主人互动 → miss；连续 3 次 miss 冷却翻倍（上限 4h）；
  // 一有回应立即复位。状态共存于 noe.proactive.state（proactiveTick 合并写保字段）。
  const evaluateProactiveResponse = () => {
    const st = kvGet('noe.proactive.state');
    if (!st || !st.lastSpokeAt || st.lastSpokeAt === st.lastEvaluatedSpokeAt) return;
    const tNow = Date.now();
    if (tNow - st.lastSpokeAt < 10 * 60_000) return; // 回应窗未到
    const responded = noeEpisodicTimeline.recent({ sinceTs: st.lastSpokeAt, limit: 10, types: ['interaction'] }).length > 0;
    const baseCooldown = Number(process.env.NOE_PROACTIVE_COOLDOWN_MS) || 5 * 60_000;
    const misses = responded ? 0 : (Number(st.misses) || 0) + 1;
    const adaptiveCooldownMs = responded ? null
      : misses >= 3 ? Math.min(4 * 3600_000, (Number(st.adaptiveCooldownMs) || baseCooldown) * 2) : (st.adaptiveCooldownMs || null);
    kvSet('noe.proactive.state', { ...st, misses, adaptiveCooldownMs, lastEvaluatedSpokeAt: st.lastSpokeAt });
    if (!responded && adaptiveCooldownMs) console.log(`[noe-proactive] 主人没回应（连续 ${misses} 次），开口冷却放宽到 ${Math.round(adaptiveCooldownMs / 60000)} 分钟`);
    else if (responded && st.adaptiveCooldownMs) console.log('[noe-proactive] 主人回应了，开口冷却复位');
  };
  if (noeAffectEngine || noeExpectationLedger) {
    // micro：情感衰减推进 + 消化时间线新情景 + 期望账本扫账 + 开口回应评估（确定性零模型，廉价高频）
    const microMs = Math.max(10_000, Number(process.env.NOE_AFFECT_TICK_MS) || 60_000);
    noeHeartbeat.register('micro', {
      cadenceMs: microMs,
      catchUp: 'drop',
      run: () => {
        const out = {};
        if (noeAffectEngine) { try { out.affect = noeAffectEngine.tick(); } catch { /* 单件失败不阻断 micro */ } }
        if (noeExpectationLedger) { try { out.expectSwept = noeExpectationLedger.sweep(); } catch { /* 同上 */ } }
        try { evaluateProactiveResponse(); } catch { /* 同上 */ }
        return out;
      },
    });
  }
  // 期望到期自动判证（设计 §7.5 P4 预留的"LLM 自动判证"落地）：本地脑只在证据明确时裁决
  // APPLIED/FAILED 进 Brier，UNKNOWN 留账（透视页人工裁决可覆盖，7 天 sweep 兜底）。
  // free 自主档默认 ON（NOE_AUTONOMY_DEFAULTS:45，旧"默认 OFF"措辞已被 profile 机制覆盖）；本地脑自判
  //   落 resolved_by=auto（P2-F2：自评，非 owner holdout，校准看板据此分层）。间隔 NOE_EXPECTATION_RESOLVE_MS（默认 1h，下限 10min）。
  if (noeExpectationLedger && process.env.NOE_EXPECTATION_AUTORESOLVE === '1') {
    // P1-A：judge 证据接 embedding 语义召回（owner 决策认知开关默认 ON，见 NOE_AUTONOMY_DEFAULTS；双代理两轮验收通过）。
    // NOE_JUDGE_EMBEDDING=1 时注入 recall，让词面 hits=0 但语义相关的 action 证据也被 judge 看到（修 source=surprise 死链）。
    // recall 内部含 dim+fallback 守卫；ollama 不可用退 fallback 时该事件被跳过、不污染。embed 不点亮词面高置信门（R2+R3 解耦）。
    const judgeRecall = process.env.NOE_JUDGE_EMBEDDING === '1'
      ? createClaimEventEmbedRecall({
          embed: (t, o) => embedText(t, { baseUrl: process.env.NOE_OLLAMA_URL || 'http://127.0.0.1:11434', ...o }),
          cosineSim,
          model: process.env.NOE_MEMORY_EMBED_MODEL || 'qwen3-embedding:0.6b',
          threshold: Number(process.env.NOE_JUDGE_EMBED_THRESHOLD) || 0.5,
        })
      : null;
    const expectationResolver = createExpectationResolver({
      ledger: noeExpectationLedger,
      goalSystem: noeGoalSystem, // rank4 好奇回路：预测落空(outcome=0)+惊奇≥2bit → 自动立 source=surprise 研究目标
      getAdapter: (id) => { try { return roomAdapterPool.get(id); } catch { return null; } },
      ...(noeReflectBrain.enabled
        ? { adapterId: noeReflectBrain.adapterId, model: noeReflectBrain.model }
        : { adapterId: process.env.NOE_INNER_BRAIN || 'lmstudio', model: noeAutoBrainModel }),
      evidence: buildEventsEvidence(listEvents, { listActionEvidence: listNoeExpectationActionEvidence, recall: judgeRecall }),
    });
    const expResolveMs = Math.max(600_000, Number(process.env.NOE_EXPECTATION_RESOLVE_MS) || 3600_000);
    noeHeartbeat.register('expectation', {
      cadenceMs: expResolveMs,
      catchUp: 'drop',
      run: ({ updateOutcome }) => expectationResolver.tickDetached(undefined, {
        onResult: (previousResult) => {
          updateOutcome({
            checked: 0,
            resolved: 0,
            judged: [],
            detached: true,
            reason: 'background_completed',
            ...(previousResult ? { previousResult } : {}),
          });
        },
      }),
    });
    console.log('[noe-expectations] 到期自动判证已启用（本地脑 · 宁缺勿错判 · 透视页人工裁决可覆盖）');
  }
  // P4 定时学习调度器（复刻 OpenClaw cron 引擎 + Neo 成效自适应）：NOE_LEARNING_SCHEDULER=1 才接（默认 OFF）。
  //   心跳 tick 驱动 scheduler.tick——取到点学习任务【串行】跑(播 self_learning goal 触发 Neo 自主学习循环)。
  //   成效自适应：学得动(立了新主题 goal)→mastery↑间隔拉长；学不动(上轮 goal 还 open 被去重)→idle↑退避；夜间×4。
  //   是 maybeSeedAutonomousLearning(时间戳节流)的升级替代——cron/at 表达力 + 失败退避 + 动态注册 + 成效调节。
  if (noeGoalSystem && process.env.NOE_LEARNING_SCHEDULER === '1') {
    const learningStore = new NoeLearningScheduleStore();
    const learningScheduler = createLearningScheduler({
      store: learningStore,
      circadian: process.env.NOE_CIRCADIAN === '1' ? { isQuiet: (t) => circadianIsQuiet(t) } : null,
      runLearnOnce: async (job) => {
        // 轮换角度 title 防自锁(M3 serious#1)：按 job.every_ms 分桶选角度，每周期 title 不同→持续立新 goal。
        const title = pickLearningTitle(job.topic, Date.now(), Math.max(60_000, Number(job.every_ms) || 3600_000));
        try {
          // 每日研究预算闸（Codex P1#3：scheduler 原直接 add 绕过 maybeSeedAutonomousLearning 的预算闸 → 预算总闸有漏洞）：
          //   滚动 24h self_learning ≥ NOE_LEARNING_DAILY_BUDGET 则不立，与 maybeSeed 共用同一预算口径。未设(0)=不限零回归。
          const dailyBudget = Math.max(0, Math.floor(Number(process.env.NOE_LEARNING_DAILY_BUDGET) || 0));
          if (dailyBudget > 0 && typeof noeGoalSystem.recentCountBySource === 'function'
            && noeGoalSystem.recentCountBySource('self_learning', Date.now() - 24 * 3600 * 1000) >= dailyBudget) {
            return { learned: false, skipped: 'daily_budget' };
          }
          const gid = noeGoalSystem.add({ title, source: 'self_learning', why: 'P4 定时学习调度器' });
          return { learned: Boolean(gid) }; // 新角度立项=learned；同周期重复 tick 撞去重=idle 退避
        } catch (e) { return { error: String((e && e.message) || e || 'seed_failed').slice(0, 120) }; }
      },
      maxAttempts: Math.max(1, Number(process.env.NOE_LEARNING_MAX_ATTEMPTS) || 3),
    });
    // 启动确保有示范学习任务(幂等,固定 id)——让调度器不空转；owner 可经 routes 加更多/改节奏
    try { learningScheduler.addLearningJob({ id: 'seed-ai-agent-tools', topic: '本机可用的 AI agent 工具、Computer Use 与 MCP 生态最新进展', kind: 'every', everyMs: 3 * 3600_000, firstDelayMs: 5 * 60_000, priority: 0.5 }); } catch { /* 示范任务入库失败不阻断 */ }
    const learnSchedMs = Math.max(30_000, Number(process.env.NOE_LEARNING_SCHEDULER_TICK_MS) || 60_000);
    noeHeartbeat.register('learningScheduler', { cadenceMs: learnSchedMs, catchUp: 'drop', run: () => learningScheduler.tick() });
    globalThis.__noeLearningScheduler = learningScheduler; // 供 routes 取(后续接 /api/noe/learning/jobs)
    console.log(`[noe-learning] 定时学习调度器已启用（每 ${formatCadenceMs(learnSchedMs)} 扫描 · cron/退避/成效自适应 · 串行防撞本地脑）`);
  }
  // owner 行为预测最小闭环（功能性自我意识：对外部 owner 下注 → owner 真实后续行为硬纠正 → 进 Brier）。
  //   零 LLM 确定性预测：owner 交互后预测「还会再提到某主题」/「交办后会要求实测·回报·采纳」；后续 owner
  //   真做了 → resolve(1) 进校准账本。读 timeline 的 interaction 经历当 owner 信号（不碰前台派发文件），
  //   心跳顺风车驱动（与 expectation/harvest 同款「作业读 store」）。三重门控：NOE_OWNER_PREDICTION=1
  //   + noeExpectationLedger（NOE_EXPECTATIONS=1）+ NOE_HEARTBEAT=1；OFF 时整块不进，账本/Brier/心跳零回归。
  if (noeExpectationLedger && process.env.NOE_OWNER_PREDICTION === '1') {
    const ownerBehaviorPredictor = createOwnerBehaviorPredictor({ ledger: noeExpectationLedger, goalSystem: noeGoalSystem });
    // 阶段1 P1：owner 否定 Neo 事实判断→surprise(owner_correction)，搭 watcher 顺风车读 interaction（NOE_OWNER_CORRECTION 默认 OFF）
    const ownerCorrectionBridge = noeGoalSystem ? createOwnerCorrectionBridge({ goalSystem: noeGoalSystem }) : null;
    const ownerInteractionWatcher = createOwnerInteractionWatcher({
      timeline: noeEpisodicTimeline,
      predictor: ownerBehaviorPredictor,
      kv: { get: kvGet, set: kvSet },
      ...(ownerCorrectionBridge ? { correctionBridge: ownerCorrectionBridge } : {}),
    });
    const ownerPredMs = Math.max(60_000, Number(process.env.NOE_OWNER_PREDICTION_MS) || 5 * 60_000);
    noeHeartbeat.register('ownerPrediction', {
      cadenceMs: ownerPredMs,
      catchUp: 'drop',
      run: () => ownerInteractionWatcher.tick(),
    });
    console.log('[noe-owner-prediction] owner 行为预测已启用（确定性预测 · owner 后续行为结算 → Brier · 顺风车读 interaction 经历 · 零 LLM · fail-open）');
    // sleep-time compute（空闲预计算）：无活跃对话时用「owner 下一问」预测主题预算候选上下文(检索)写入预取池，
    //   下一 turn 命中即秒答。四重门控：NOE_SLEEPTIME_COMPUTE=1 + 上面三门(NOE_OWNER_PREDICTION/EXPECTATIONS/HEARTBEAT)。
    //   OFF 时整个 if 不进：不 new、不 register、noeSleepTimeCompute/sleepTimeIsOwnerActive 保持 null → 预取池无 sleeptime: 键、
    //   心跳无该游标、零模型调用零开销零回归。idle-only + 可取消 + 候选(非答案)带 source+TTL + 不设硬超时 + fail-open 由模块内保证。
    if (process.env.NOE_SLEEPTIME_COMPUTE === '1') {
      const sleepIdleMs = Math.max(60_000, Number(process.env.NOE_SLEEPTIME_IDLE_MS) || 5 * 60_000);
      // 空闲判定(照 line 988 先例)：最近一次 owner interaction 距今 > 阈值即视为空闲；无 interaction 也算空闲。
      const lastOwnerInteractionAt = () => {
        try { return noeEpisodicTimeline.recent({ limit: 20, types: ['interaction'] })[0]?.ts ?? 0; } catch { return 0; }
      };
      const sleepTimeIsIdle = () => { const last = lastOwnerInteractionAt(); return last <= 0 || (Date.now() - last) >= sleepIdleMs; };
      // owner 活跃 = 不空闲(供 proactive 包裹近即时 cancel 用)；探测抛错按非活跃处理(fail-open，不误杀正常预计算)。
      sleepTimeIsOwnerActive = () => { try { return sleepTimeIsIdle() !== true; } catch { return false; } };
      // precompute 注入：用主项目检索器(本地、廉价)把主题检索成候选上下文文本；不调 LLM(只检索)，signal 一旦 abort 尽快退出。
      //   不设硬超时(本地检索/embedding JIT 慢正常)；检索失败/空返回 null → 模块跳过该主题(fail-open)。
      const sleepTimePrecompute = async (topic, { signal }) => {
        if (!noeMemoryRetriever?.retrieve || signal?.aborted) return null;
        let res;
        try { res = await noeMemoryRetriever.retrieve({ transcript: String(topic || ''), routeType: 'chat', limit: 5 }); } catch { return null; }
        if (signal?.aborted || !res?.ok || !Array.isArray(res.selected) || !res.selected.length) return null;
        const lines = res.selected.slice(0, 5).map((m) => '- ' + String(m?.text || m?.content || m?.summary || '').replace(/\s+/g, ' ').trim().slice(0, 200)).filter((s) => s.length > 2);
        return lines.length ? `关于「${topic}」的相关记忆候选：\n${lines.join('\n')}` : null;
      };
      noeSleepTimeCompute = createSleepTimeCompute({
        prefetchStore: noePrefetchStore,
        openPredictions: () => ownerBehaviorPredictor.openOwnerPredictions(),
        precompute: sleepTimePrecompute,
        isIdle: sleepTimeIsIdle,
      });
      const sleepTimeMs = Math.max(120_000, Number(process.env.NOE_SLEEPTIME_COMPUTE_MS) || 5 * 60_000);
      noeHeartbeat.register('sleeptimeCompute', {
        cadenceMs: sleepTimeMs,
        catchUp: 'drop',
        run: () => noeSleepTimeCompute.tick(),
      });
      console.log('[noe-sleeptime] 空闲预计算已启用（idle-only · 预判 owner 下一问 → 预算候选上下文进预取池 · 候选非答案带 source+TTL · owner 来即取消 · 不设硬超时 · fail-open）');
    }
  }
  // 环2：self-evolution 自驱心跳（NOE_SELF_EVOLUTION=1 + NOE_HEARTBEAT=1 双开才有 job）。
  //   每 tick 取一个 open self_evolution 目标推进一步（单 writer）；无目标则跳过（廉价）。
  if (noeSelfEvolutionTrigger) {
    const selfEvolveMs = Math.max(60_000, Number(process.env.NOE_SELF_EVOLUTION_TICK_MS) || 5 * 60_000);
    // P3.4 自改预算/限速（flag 默认不限不冷却=零回归）。计数与失败时间在进程内（重启即重置——
    //   重启不该被旧额度锁；跨重启的持久预算非本切片目标）。enabled=false 时整块跳过，逐字走现状。
    let selfEvolveDay = '';
    let selfEvolveAttempts = 0;
    let selfEvolveLastFailureAt = 0;
    let selfEvolveLastGoalId = ''; // 调度饥饿治本(sticky)：专注完成上拍在推进的 goal，防新立 goal 排挤走到 99% 的 goal
    // P3.3 自改失败入 memory（独立 flag NOE_SELF_EVOLUTION_FAILURE_MEMORY，不耦合 P3.4 预算）：复用
    //   noeLearningLoop→NoeFailureLessons（成熟根因分类 + cooldown 去重 + cleanText 脱敏），不另造平行体系。
    //   reason 再 redact 一层双保险，绝不写 secret；写入失败不阻断主 tick。
    const recordSelfEvolutionFailure = (signal = {}) => {
      if (process.env.NOE_SELF_EVOLUTION_FAILURE_MEMORY !== '1' || !noeLearningLoop?.onActFailed) return;
      try {
        const reason = redactSensitiveText(String(signal.reason || signal.error || '未知').slice(0, 300));
        noeLearningLoop.onActFailed({ action: 'noe.self_evolution', status: 'failed', failure_reason: reason, payload: { stage: signal.stage || '' } });
      } catch { /* 失败学习写入失败不阻断主流程 */ }
    };
    noeHeartbeat.register('selfEvolve', {
      cadenceMs: selfEvolveMs,
      catchUp: 'drop',
      run: async () => {
        const budgetCfg = resolveSelfEvolutionBudgetConfig();
        let result;
        try {
          const goals = noeSelfEvolutionTrigger.openSelfEvolutionGoals();
          if (!goals.length) return { skipped: 'no_open_self_evolution_goal' };
          if (budgetCfg.enabled) {
            const today = new Date().toISOString().slice(0, 10);
            if (selfEvolveDay !== today) { selfEvolveDay = today; selfEvolveAttempts = 0; }
            const verdict = checkSelfEvolutionBudget({ attemptsToday: selfEvolveAttempts, lastFailureAt: selfEvolveLastFailureAt }, budgetCfg);
            if (!verdict.allowed) { console.log(`[noe-self-evolution] selfEvolve 预算门拦截：${verdict.reason}`); return { skipped: 'budget', reason: verdict.reason }; }
          }
          // 调度饥饿治本(sticky)：上拍在推进的 goal 若仍在 open/active(未 complete/drop)，优先继续推进它直到收口，
          //   防新立 goal 因「新鲜度」priority 略高反复打断走到 99% 的 goal(实测 self_directed goal 被新 test_gap 排挤、complete 永轮不到)。
          //   complete/drop 后 stickyGoal 不在 goals → 自动换 goals[0]；P0-4(连续推不动 drop) + git-aware A2(根治残留死循环)兜底防 sticky 卡死循环。
          const stickyGoal = selfEvolveLastGoalId ? goals.find((g) => g && g.id === selfEvolveLastGoalId) : null;
          const chosen = stickyGoal || goals[0];
          selfEvolveLastGoalId = chosen.id;
          result = await noeSelfEvolutionTrigger.tick({ goalId: chosen.id });
        } catch (e) {
          if (budgetCfg.enabled) selfEvolveLastFailureAt = Date.now();
          recordSelfEvolutionFailure({ stage: 'tick_exception', error: e?.message }); // P3.3 crash 也记（rethrow 前，不阻断异常传播）
          console.log('[noe-self-evolution] ⚠️ tick 抛异常:', redactSensitiveText(String(e?.stack || e?.message || e)).slice(0, 400)); // 诊断：定位首拍真试失败根因（飞轮冷却循环排查·脱敏）
          throw e;
        }
        if (budgetCfg.enabled) {
          if (result && result.proposed === true) selfEvolveAttempts += 1; // 只数真实发起 patch 的拍（非纯推进/等待拍），对齐"自改 cycle 数"语义
          if (isSelfEvolutionCooldownFailure(result)) selfEvolveLastFailureAt = Date.now(); // 冷却只惩罚真自改失败（apply/verify 坏了）；no_patch_plan/诗性产空不冷却，防拖累就位的真信号目标
        }
        // P3.3 失败入 memory（独立于预算 flag；复用 NoeFailureLessons 自带去重，无需自管节流）
        if (isSelfEvolutionTickFailure(result)) {
          console.log('[noe-self-evolution] ⚠️ tick 真试失败 stage=%s reason=%s', result?.stage || '?', redactSensitiveText(String(result?.reason || result?.actResult?.reason || result?.autodrive?.reason || result?.actResult?.error || result?.autodrive?.error || '')).slice(0, 250)); // 诊断：定位飞轮冷却循环根因（脱敏）
          recordSelfEvolutionFailure({ stage: result?.stage, reason: result?.reason || result?.actResult?.reason || result?.autodrive?.reason, error: result?.actResult?.error || result?.autodrive?.error });
        }
        return result;
      },
    });
    console.log('[noe-self-evolution] 环2 自驱心跳已注册（selfEvolve · 每 tick 推进一个 open 自进化目标）');
  }

  // 路 2：真信号目标源心跳（缺 JSDoc 扫描 → 立 self_evolution goal·叠加 inner thoughts 守人格）。cadence 适中（默认 30min）防刷屏，
  //   真信号 complete 快 + 间隔长 → 大部分时间无真信号 open → inner thoughts 诗性照常在空档立项。seed 自带单坑位（只拦 meta.signal 真信号）。
  if (noeCodeSignalSeed && noeSelfEvolutionTrigger) {
    const codeSignalMs = Math.max(300_000, Number(process.env.NOE_CODE_QUALITY_SIGNALS_MS) || 30 * 60_000);
    noeHeartbeat.register('codeSignalSeed', {
      cadenceMs: codeSignalMs,
      catchUp: 'drop',
      run: () => {
        try { const r = noeCodeSignalSeed.runOnce(); if (r && r.ok) console.log(`[noe-code-signals] 🔧 真信号立项 goal=${r.goalId}（${r.signal?.file || ''}）`); }
        catch (e) { console.log('[noe-code-signals] seed tick 失败:', String((e && e.message) || e).slice(0, 120)); }
      },
    });
    console.log('[noe-code-signals] 路2 真信号源心跳已注册（codeSignalSeed · 缺 JSDoc 导出函数 → self_evolution goal）');
  }

  // WAL 截断维护：长驻进程 WAL 单调膨胀(PASSIVE autocheckpoint 刷回主库但不缩文件,连接从不 close)，
  //   定期 wal_checkpoint(TRUNCATE) 把已刷入主库的 WAL 截回小尺寸。默认 OFF（NOE_WAL_CHECKPOINT），
  //   间隔默认 10min（NOE_WAL_CHECKPOINT_MS，下限 1min）。数据安全：busy=0(无 reader)才截断，撞 reader 不截、下周期重来。
  if (process.env.NOE_WAL_CHECKPOINT === '1') {
    const walCheckpointMs = Math.max(60_000, Number(process.env.NOE_WAL_CHECKPOINT_MS) || 10 * 60_000);
    const walCheckpointMaintenance = createWalCheckpointMaintenance({ getDb });
    noeHeartbeat.register('walCheckpoint', {
      cadenceMs: walCheckpointMs,
      catchUp: 'drop',
      run: () => {
        try {
          const r = walCheckpointMaintenance.runOnce();
          if (r && r.ok && Number(r.checkpointed) > 0) console.log(`[noe-wal] checkpoint(TRUNCATE) 成功 busy=${r.busy} frames=${r.checkpointed}/${r.walFrames}`);
          else if (r && !r.ok && r.reason && r.reason !== 'no_db') console.log(`[noe-wal] checkpoint 未完成: ${r.reason}${r.busy ? ` (busy=${r.busy},有 reader 持有,下周期重来)` : ''}`);
        } catch (e) { console.log('[noe-wal] checkpoint tick 失败:', String((e && e.message) || e).slice(0, 120)); }
      },
    });
    console.log(`[noe-wal] WAL checkpoint 维护心跳已注册（每 ${Math.round(walCheckpointMs / 60_000)}min TRUNCATE，防 WAL 膨胀）`);
  }

  // P1 失败教训信号源心跳：低频(默认 30min)读失败教训 → LLM 提炼 → 立可执行改进目标。fail-open 不崩心跳。
  if (noeFailureLessonSignal && noeSelfEvolutionTrigger) {
    const failureLessonMs = Math.max(600_000, Number(process.env.NOE_FAILURE_LESSON_SIGNAL_MS) || 30 * 60_000);
    noeHeartbeat.register('failureLessonSignal', {
      cadenceMs: failureLessonMs,
      catchUp: 'drop',
      run: async () => {
        try { const r = await noeFailureLessonSignal.runOnce(); if (r && r.ok) console.log(`[noe-failure-lesson] 🔧 失败教训立项 goal=${r.goalId}（${String(r.objective || '').slice(0, 40)}）`); }
        catch (e) { console.log('[noe-failure-lesson] tick 失败:', String((e && e.message) || e).slice(0, 120)); }
      },
    });
    console.log('[noe-failure-lesson] P1 失败教训信号源心跳已注册（learning_lesson → LLM 提炼 → self_evolution goal）');
  }

  // P2 多元信号源心跳：低频(默认 20min)扫 stale_todo/high_complexity/test_gap → 立改进目标。fail-open 不崩心跳。
  if (noeImprovementSignalSeed && noeSelfEvolutionTrigger) {
    const improvementMs = Math.max(300_000, Number(process.env.NOE_CODE_IMPROVEMENT_SIGNALS_MS) || 20 * 60_000);
    noeHeartbeat.register('improvementSignalSeed', {
      cadenceMs: improvementMs,
      catchUp: 'drop',
      run: () => {
        try { const r = noeImprovementSignalSeed.runOnce({ signalPriority: ['test_gap', 'high_complexity', 'stale_todo'] }); if (r && r.ok) console.log(`[noe-improvement] 🔧 多元信号立项 goal=${r.goalId}（${r.signal?.type}·${r.signal?.file || ''}）`); }
        catch (e) { console.log('[noe-improvement] tick 失败:', String((e && e.message) || e).slice(0, 120)); }
      },
    });
    console.log('[noe-improvement] P2 多元信号源心跳已注册（stale_todo/high_complexity/test_gap）');
  }

  // #54 自主定方向心跳：低频(默认 60min)Heavy brain 反思 → 自主生成进化方向。reward hacking 熔断(自主源连续未成功→暂停)。fail-open。
  if (noeSelfDirectionSeed && noeSelfEvolutionTrigger) {
    const selfDirectionMs = Math.max(60_000, Number(process.env.NOE_SELF_DIRECTION_SEED_MS) || 60 * 60_000);
    // reward hacking 熔断 state（v1 近似）：查最近自主方向 goal 中「已结束(done/dropped/paused)」的，从最新往回数连续非 done（失败/空转）个数。
    //   遇到 done 即停（连续中断）。精确到 outcome verdict 是后续增强；v1 用 goal 完成情况近似 reward hacking 信号。
    const querySelfDirectionBudgetState = () => {
      try {
        const rows = getDb().prepare("SELECT status, created_at FROM noe_goals WHERE source='self_evolution' AND json_extract(meta,'$.signal')='self_directed_evolution' AND status IN ('done','dropped','paused') ORDER BY created_at DESC LIMIT 10").all();
        let consecutiveNeutral = 0;
        let lastFailureAt = 0; // 最近一次非 done(失败/dropped/paused)的时间 → half-open cooldown 锚点(打破永久死锁)
        for (const r of rows) { if (r.status === 'done') break; consecutiveNeutral += 1; if (!lastFailureAt) lastFailureAt = Number(r.created_at) || 0; }
        return { consecutiveNeutral, lastFailureAt };
      } catch { return { consecutiveNeutral: 0, lastFailureAt: 0 }; }
    };
    noeHeartbeat.register('selfDirectionSeed', {
      cadenceMs: selfDirectionMs,
      catchUp: 'drop',
      run: async () => {
        try {
          const budgetCfg = resolveSelfDirectionBudget();
          if (budgetCfg.enabled) {
            const verdict = checkSelfDirectionBudget(querySelfDirectionBudgetState(), budgetCfg);
            if (!verdict.allowed) { console.log(`[noe-self-direction] reward hacking 熔断暂停：${verdict.reason}`); return { skipped: 'budget', reason: verdict.reason }; }
          }
          const r = await noeSelfDirectionSeed.runOnce();
          if (r && r.ok) console.log(`[noe-self-direction] 🧭 自主方向立项 goal=${r.goalId}（${String(r.objective || '').slice(0, 40)}·${r.expectedVerdict}）`);
          else if (r && r.reason && String(r.reason).startsWith('value_anchor')) console.log(`[noe-self-direction] 价值锚拦截：${r.reason}`);
          else if (r && (r.reason || r.skipped || r.error)) console.log(`[noe-self-direction] 未立项：${r.reason || r.skipped || r.error}${r.detail ? `(${r.detail})` : ''}`); // 全 reason 可观测(no_direction/no_brain/near_duplicate/error)
        } catch (e) { console.log('[noe-self-direction] tick 失败:', String((e && e.message) || e).slice(0, 120)); }
      },
    });
    console.log('[noe-self-direction] #54 自主定方向心跳已注册（自主生成进化方向 + 强价值锚 + reward hacking 熔断）');
  }

  // 扩展自主能力域（type_error_fix）心跳：低频（默认 60min，typecheck 慢）跑 typecheck → 自主修一个低 error 文件的结构性类型 bug。
  //   单坑位（seed 内查 in_flight）防刷屏；executor 端价值锚（typecheck 真减少 + 防 @ts-ignore/any 作弊）兜底。fail-open 不崩心跳。
  if (noeTypeErrorSeed && noeSelfEvolutionTrigger) {
    const typeErrorMs = Math.max(600_000, Number(process.env.NOE_SELF_EVOLUTION_TYPECHECK_MS) || 60 * 60_000);
    noeHeartbeat.register('typeErrorSeed', {
      cadenceMs: typeErrorMs,
      catchUp: 'drop',
      run: async () => {
        try {
          const r = await noeTypeErrorSeed.runOnce();
          if (r && r.ok) console.log(`[noe-type-error] 🔧 type_error 立项 goal=${r.goalId}（${r.targetFile}·${r.errorCount} error）`);
          else if (r && (r.reason || r.skipped || r.error)) console.log(`[noe-type-error] 未立项：${r.reason || r.skipped || r.error}`);
        } catch (e) { console.log('[noe-type-error] tick 失败:', String((e && e.message) || e).slice(0, 120)); }
      },
    });
    console.log('[noe-type-error] type_error_fix 域心跳已注册（自主修结构性类型 error + 防作弊价值锚）');
  }

  // P4 学改闭环心跳：低频(默认 30min)复盘 P0 outcome → 蒸馏成功模式/太浅教训回流 P1。fail-open 不崩心跳。
  if (noeEvolutionRetrospect) {
    const retrospectMs = Math.max(600_000, Number(process.env.NOE_EVOLUTION_RETROSPECT_MS) || 30 * 60_000);
    noeHeartbeat.register('evolutionRetrospect', {
      cadenceMs: retrospectMs,
      catchUp: 'drop',
      run: () => {
        try { const r = noeEvolutionRetrospect.runOnce(); if (r && r.ok && r.lessons) console.log(`[noe-retrospect] 📊 复盘回流 ${r.lessons} 条（success=${r.realLogic} testOnly=${r.testOnly} failed=${r.failedLogic} shallow=${r.shallow}）`); }
        catch (e) { console.log('[noe-retrospect] tick 失败:', String((e && e.message) || e).slice(0, 120)); }
      },
    });
    console.log('[noe-retrospect] P4 学改闭环心跳已注册（复盘 → 成功模式/太浅教训回流 P1）');
  }

  // P5 元进化心跳：低频(默认 6h)诊断进化策略 → advisory-only 建议给 owner。绝不自动改 flag/gate。fail-open 不崩心跳。
  if (noeMetaEvolution) {
    const metaMs = Math.max(3_600_000, Number(process.env.NOE_META_EVOLUTION_MS) || 6 * 3_600_000);
    noeHeartbeat.register('metaEvolution', {
      cadenceMs: metaMs,
      catchUp: 'drop',
      run: () => {
        try { const r = noeMetaEvolution.runOnce(); if (r && r.ok && r.written) console.log(`[noe-meta-evo] 🧭 进化策略建议：${r.advisory?.title}`); }
        catch (e) { console.log('[noe-meta-evo] tick 失败:', String((e && e.message) || e).slice(0, 120)); }
      },
    });
    console.log('[noe-meta-evo] P5 元进化心跳已注册（进化策略诊断 → advisory-only）');
  }

  // Step1 自我复盘心跳(NOE_EVOLUTION_REVIEW=1):低频(默认每天)读 panel.db 建仪表盘快照 append history.jsonl,
  //   让「每天更强」的真进步率趋势曲线自动累积、循环随时间自转。只读+落盘,fail-open,绝不阻断心跳。
  if (process.env.NOE_EVOLUTION_REVIEW === '1') {
    const reviewMs = Math.max(3600_000, Number(process.env.NOE_EVOLUTION_REVIEW_MS) || 24 * 3600_000);
    const reviewDir = join(process.cwd(), 'output', 'noe-evolution-dashboard');
    const evolutionReviewTick = createEvolutionReviewTick({
      queryOutcomes: () => getDb().prepare("SELECT json_extract(payload,'$.verdict') verdict, json_extract(payload,'$.applied') applied, json_extract(payload,'$.reason') reason FROM events WHERE kind='evolution_outcome' AND ts >= ?").all(Date.now() - 7 * 86400_000),
      queryGoals: () => getDb().prepare("SELECT json_extract(meta,'$.signal') signal, status FROM noe_goals WHERE source='self_evolution' AND created_at >= ?").all(Date.now() - 7 * 86400_000),
      queryLessonCount: () => { try { return getDb().prepare("SELECT COUNT(*) n FROM noe_memory WHERE (source_type LIKE '%lesson%' OR source_type LIKE '%reject%') AND created_at >= ?").get(Date.now() - 7 * 86400_000).n; } catch { return 0; } },
      appendSnapshot: (snap) => { try { fsMkdirSync(reviewDir, { recursive: true }); fsAppendFileSync(join(reviewDir, 'history.jsonl'), `${JSON.stringify(snap)}\n`, { mode: 0o600 }); } catch { /* fail-open */ } },
    });
    noeHeartbeat.register('evolutionReview', {
      cadenceMs: reviewMs,
      catchUp: 'drop',
      run: () => { const r = evolutionReviewTick(); if (r && r.ok) console.log(`[noe-evolution-review] 📊 快照已落(近7天真进步率 ${(r.realProgressRate * 100).toFixed(1)}%, ${r.total} outcome)`); return r; },
    });
    console.log('[noe-evolution-review] Step1 自我复盘心跳已注册（每天落仪表盘快照 → 真进步率趋势曲线自累积）');
  }

  // rank9 记忆自治：低频自我体检弱来源 legacy fact，可逆隐藏敏感/ephemeral（apply）+ 记 candidate/link。
  //   env NOE_MEMORY_AUTONOMOUS_REVIEW=1 默认 OFF + 依赖 NOE_HEARTBEAT；隐藏可逆（hidden=1+reason，可恢复）。
  if (process.env.NOE_MEMORY_AUTONOMOUS_REVIEW === '1') {
    const memReviewMs = Math.max(3600_000, Number(process.env.NOE_MEMORY_REVIEW_MS) || 6 * 3600_000);
    noeHeartbeat.register('memoryReview', {
      cadenceMs: memReviewMs,
      catchUp: 'drop',
      run: () => runNoeMemoryAutonomousReview({ db: noeMemoryCore.db(), apply: true, auditLog: noeMemoryAuditLog, projectId: 'noe' }),
    });
    console.log('[noe-memory] 记忆自治体检已注册（memoryReview · 低频可逆隐藏敏感/ephemeral 弱来源记忆）');
  }
  // 整合度代理（IIT 理念 · 多信息 Total Correlation，非完整 Φ）：每周期把 8 个宏节点（GWT 焦点/
  //   情感 VAD 偏离/期望到期/驱力/感知/目标步/自语/梦）二值化进滚动窗口，算 TC 当「子系统是否被
  //   整合成统一内容」的读数，写 kv noe.integration.reading 供 mind/overview 消费。注入式全探针 fail-open。
  //   NOE_INTEGRATION_METRIC=1 默认 OFF（故意不进 NOE_AUTONOMY_DEFAULTS，free profile 也不强开）；OFF 时
  //   整块跳过 → 不建 sampler、不注册 job、kv 无 noe.integration.* 键，零采样零开销零回归。
  if (process.env.NOE_INTEGRATION_METRIC === '1') {
    const integrationSampler = createIntegrationSampler({
      kv: { get: kvGet, set: kvSet },
      windowSize: Math.max(2, Math.min(200, Number(process.env.NOE_INTEGRATION_WINDOW) || 24)),
      signals: {
        gwt_focus: () => { try { return Boolean(noeWorkspace?.currentFocus?.()?.source); } catch { return false; } },
        vad_deviation: () => {
          try {
            const s = noeAffectEngine?.snapshot?.(); if (!s) return false;
            return Math.abs((s.v ?? AFFECT_BASELINE.v) - AFFECT_BASELINE.v) >= 0.25
              || Math.abs((s.a ?? AFFECT_BASELINE.a) - AFFECT_BASELINE.a) >= 0.25
              || Math.abs((s.d ?? AFFECT_BASELINE.d) - AFFECT_BASELINE.d) >= 0.25;
          } catch { return false; }
        },
        expectation_due: () => { try { return (noeExpectationLedger?.due?.(Date.now()) || []).length > 0; } catch { return false; } },
        drive: () => { try { return Number(noeDriveSystem?.snapshot?.()?.dominant?.value) >= 0.5; } catch { return false; } },
        percept: () => { try { return Boolean(noeRouteHandles?.peekVision?.()?.summary); } catch { return false; } },
        goal_step: () => { try { return Boolean(noeGoalSystem?.nextStep?.()); } catch { return false; } },
        self_talk: () => { try { return noeEpisodicTimeline.recent({ limit: 3, sinceTs: Date.now() - 15 * 60_000 }).length > 0; } catch { return false; } },
        dream: () => { try { return noeEpisodicTimeline.recent({ limit: 3, sinceTs: Date.now() - 6 * 3600_000, types: ['dream'] }).length > 0; } catch { return false; } },
      },
    });
    const integMs = Math.max(60_000, Number(process.env.NOE_INTEGRATION_METRIC_MS) || 5 * 60_000);
    // P2 觉醒看板：把每拍读数 append 进有限历史（只写自己的 kv 键，零碰 sampler 的 reading/window）。
    const integrationHistory = createIntegrationHistory({
      kv: { get: kvGet, set: kvSet },
      maxPoints: Math.max(2, Math.min(2000, Number(process.env.NOE_INTEGRATION_HISTORY_MAX) || 288)),
    });
    noeHeartbeat.register('integration', {
      cadenceMs: integMs,
      catchUp: 'drop',
      run: () => { const r = integrationSampler.sample(); try { integrationHistory.record(r); } catch { /* 历史留存失败不阻断采样 */ } return r; },
    });
    console.log('[noe-integration] 整合度代理采样已注册（integration · 8 宏节点 TC · 读数写 kv 供透视页 · 注入式 fail-open）');
  }
  // P2-F1：撞墙信号自动检测（防 Goodhart 自欺）。检测+告警始终活（写 kv noe.wall.lastSignals 供看板/审计）。
  //   R4：over_integration 无条件检测；idle_rumination 仅在目标系统在场时（activeGoals=null 则不检测，避免假 0 误触发）。
  //   R1（诚实标注）：NOE_WALL_GUARD=1 时额外写回滚意图 kv noe.wall.guard.*，但当前仅落「待回滚」意图态——
  //   砍 novelty / 停 InnerMonologue 的真实执行需 P3 器官 kvGet 此键消费，尚未接，故启用 flag 暂不产生行为回滚。
  {
    const wallHistory = createIntegrationHistory({ kv: { get: kvGet, set: kvSet } });
    noeHeartbeat.register('wallGuard', {
      cadenceMs: Math.max(300_000, Number(process.env.NOE_WALL_GUARD_MS) || 30 * 60_000),
      catchUp: 'drop',
      run: () => {
        try {
          const history = wallHistory.read({ limit: 10 });
          let monologue7d = 0;
          try { monologue7d = Number(getDb().prepare("SELECT COUNT(*) n FROM events WHERE kind='noe_self_talk_audit' AND ts >= ?").get(Date.now() - 7 * 86400000)?.n) || 0; } catch { /* fail-open */ }
          const gstats = noeGoalSystem ? (noeGoalSystem.stats() || {}) : null;
          const activeGoals = gstats ? (Number(gstats.open) || 0) + (Number(gstats.active) || 0) : null;
          const result = detectWallSignals({ integrationHistory: history, monologue7d, activeGoals });
          kvSet('noe.wall.lastSignals', { ts: Date.now(), ...result, guardEnabled: process.env.NOE_WALL_GUARD === '1' });
          if (result.hit && process.env.NOE_WALL_GUARD === '1') {
            for (const s of result.signals) kvSet(`noe.wall.guard.${s.action}`, { ts: Date.now(), intent: true, executed: false, reason: s.message });
          }
          return result;
        } catch { return { hit: false }; }
      },
    });
  }
  // P2-F3：觉醒采样自动调度（默认 OFF，避免与 npm noe:awakening/cron 双跑）。NOE_AWAKENING_SAMPLE=1 每小时进程内采样落盘 output/awakening-samples。
  if (process.env.NOE_AWAKENING_SAMPLE === '1') {
    noeHeartbeat.register('awakeningSample', {
      cadenceMs: Math.max(600_000, Number(process.env.NOE_AWAKENING_SAMPLE_MS) || 60 * 60_000),
      catchUp: 'drop',
      run: () => {
        try {
          const sample = sampleAwakening(getDb(), { now: Date.now() });
          const outDir = join(__dirname, 'output', 'awakening-samples');
          fsMkdirSync(outDir, { recursive: true, mode: 0o700 });
          const day = new Date(sample.ts).toISOString().slice(0, 10);
          fsAppendFileSync(join(outDir, `${day}.jsonl`), `${JSON.stringify(sample)}\n`, { mode: 0o600 });
          return { sampled: true, day };
        } catch { return { sampled: false }; }
      },
    });
  }
  noeHeartbeat.start();
  console.log(`[noe-heartbeat] 持久心跳已启用（作业 ${noeHeartbeat.status().kinds.join('/') || '无'} · 台账 noe_ticks · 重启续相位）`);
}
// ── 内心透视页（意识方案 P8，owner 委托"改动要能被人类看到"）：/mind.html 独立页面 +
//    /api/noe/mind/* 数据层——意识流/注意力日志/心跳台账/情感曲线/期望裁决/目标交办全可视。
//    各特性未通电时端点返回 enabled:false（页面渲染"未通电"态），路由本身无开关常驻。
registerNoeMindRoutes(app, {
  timeline: noeEpisodicTimeline,
  affectEngine: noeAffectEngine,
  expectationLedger: noeExpectationLedger,
  goalSystem: noeGoalSystem,
  heartbeat: noeHeartbeat,
  mindVitals: noeMindVitals,
  memory: noeMemoryCore,
  memoryWriteGate: noeMemoryWriteGate,
  dataDir: DATA_DIR,
  curiosityReport: buildCuriosityYieldReport,
});
registerNoeWorkMapRoutes(app, {
  rootDir: process.cwd(),
  dataDir: DATA_DIR,
  sessions,
  roomStore,
});
const debateDispatcher = new DebateDispatcher({
  store: roomStore,
  adapters: roomAdapterPool,
  broadcast: broadcastRoom,
});
const squadDispatcher = new CollaborationDispatcher({
  store: roomStore,
  adapters: roomAdapterPool,
  broadcast: broadcastRoom,
});
const crossVerifyDispatcher = new CrossVerifyDispatcher({
  store: roomStore,
  adapters: roomAdapterPool,
  broadcast: broadcastRoom,
  agentRunStore,
});
// 选项 C：squad 产出自动入证据知识库 → 第29批迁 src/server/services/squad-evidence-hook.js
squadDispatcher.setSquadFinishHook(createSquadEvidenceHook({ evidenceKnowledgeStore }));
const arenaDispatcher = new ArenaDispatcher({
  store: roomStore,
  adapters: roomAdapterPool,
  broadcast: broadcastRoom,
});
const soloChatDispatcher = new SoloChatDispatcher({
  store: roomStore,
  adapters: roomAdapterPool,
  broadcast: broadcastRoom,
  // 方向一（NOE_CHAT_CONTEXT=1 启用，默认 OFF）：聊天室 1v1 接 NoeTurnContextEngine——
  // 召回记忆/查人物库/跑工具桥三段（语音专属段在 dispatcher 白名单外），记忆域固定 'noe'。
  // NOE_CHAT_UISIGNALS=1（默认 OFF，需同时开 NOE_CHAT_CONTEXT=1）再注入 UI 信号/agent 卡片两个共享
  // store——与 /api/noe/ui-signals、/api/noe/acui/cards 路由同实例；uiSignals 引擎内走非消费式 peek，
  // 绝不抢 noeLocalCouncil 议会路径的 consume()（ContextEngine 房务裁决书指引）。
  contextEngine: process.env.NOE_CHAT_CONTEXT === '1'
    ? new NoeTurnContextEngine({
        memory: noeMemoryCore,
        memoryRetriever: noeMemoryRetriever,
        personStore: defaultPersonKnowledgeStore,
        toolRegistry: noeToolRegistry,
        // P4：inner-state 段内容 provider（复用上文为 VoiceSession 建的同一实例）——把当下 affect（VAD→自然心情句）
        //   + GWT 焦点拼成 ≤2 句中文注入 owner 回复。NOE_TURN_INNER_STATE 默认 ON（P0.5 契约），provider 内部 fail-open。
        innerStateProvider: noeInnerStateProvider,
        // P7：persona-pin 段内容 provider——稳定人设(disposition+性格观察+自我叙事，buildPersonaPin 只取稳定层、不含 mood
        //   快变层)挂 system prompt(P0.5 persona-pin 段，keep:6)。NOE_MEMORY_PERSONA_PIN 默认 OFF(改记忆角色定位留 owner)；
        //   闭包请求期求值 noeSelfModel(已建)，provider 内部 fail-open(空→不加段)。weights 进化改走此 persona-RAG 路(替 LoRA)。
        personaPinProvider: () => noeSelfModel.buildPersonaPin(),
        ...(process.env.NOE_CHAT_UISIGNALS === '1'
          ? { uiSignalStore: defaultNoeUiSignalStore, acuiCardStore: defaultNoeAcuiCardStore }
          : {}),
        // 第三阶段·全模态一体化（NOE_CHAT_MULTIMODAL=1 默认 OFF）：每轮融合多模态感知注入聊天大脑跨模态推理。
        //   视觉:VisionSession 把最新画面写进记忆 vision-latest:noe,这里读出来融合(>2min 标过期);UI:主人面板操作。
        //   融合器缺模态优雅跳过;全程 fail-open——任一读失败只是不融那一模态,绝不阻断聊天。
        multimodalProvider: process.env.NOE_CHAT_MULTIMODAL === '1'
          ? () => {
              try {
                const r = (defaultNoeUiSignalStore.list({ limit: 1 }) || [])[0];
                const uiSignal = r ? { lastAction: r.event || r.action, lastCard: r.cardId || r.card } : null;
                let visionSummary = ''; let visionStale = false;
                try {
                  const v = noeMemoryCore.get('vision-latest:noe');
                  if (v && v.body) { visionSummary = v.body; const at = Number(v.updatedAt || v.createdAt || v.at || 0); visionStale = at > 0 ? (Date.now() - at > 120_000) : true; }
                } catch { /* 视觉读不到就不融合视觉 */ }
                let voiceActive = false;
                try { voiceActive = defaultNoeVoiceActivity.isActive(90_000); } catch { voiceActive = false; } // 90s 内有语音 turn=在线
                return buildMultimodalContext({ uiSignal, visionSummary, visionStale, voiceActive });
              } catch { return ''; }
            }
          : null,
      })
    : null,
  // 内在世界（记录覆盖扩展）：NOE_CONTINUITY=1 才把聊天室见闻记进自传体时间线（此处在脊椎装配之后，
  // 直接复用 noeEpisodicTimeline 实例；type=observation 防污染 inferMood，见 SoloChatDispatcher 内注释）。
  episodicTimeline: process.env.NOE_CONTINUITY === '1' ? noeEpisodicTimeline : null,
  foregroundChatRouting: noeForegroundChatRouting,
  // H3 本地模型文本工具协议（NOE_TEXT_TOOL_PROTOCOL=1 默认 OFF）：本地模型回复含 <<<NOE_TOOL>>> 标记时解析→
  //   经 noeToolRegistry.invoke（过 PermissionGovernance 权限门）真跑只读工具→脱敏结果回灌续答。allowedToolIds
  //   取真挂载的只读工具 id（fail-closed allowlist），realExecute=true 但仅只读工具（builtinReadonlyTools 纯读）。
  textToolRuntime: process.env.NOE_TEXT_TOOL_PROTOCOL === '1'
    ? {
        tools: BUILTIN_READONLY_TOOLS,
        allowedToolIds: BUILTIN_READONLY_TOOLS.map((t) => t.id),
        invokeTool: async (toolId, args) => {
          const r = await noeToolRegistry.invoke(toolId, { args, actorType: 'system', actorId: 'owner' });
          return r.ok ? r.result : { ok: false, error: r.error };
        },
        maxCalls: 3,
        maxRounds: 2,
        realExecute: true,
      }
    : null,
});

const CLUSTER_RUNTIME_WATCHDOG_INTERVAL_MS = Math.max(
  5000,
  Math.min(10 * 60 * 1000, Number(process.env.PANEL_CLUSTER_RUNTIME_WATCHDOG_INTERVAL_MS) || 30_000),
);
const clusterRuntimeWatchdog = process.env.PANEL_CLUSTER_RUNTIME_WATCHDOG_DISABLED === '1'
  ? null
  : setInterval(() => {
      try {
        runClusterRuntimeWatchdogOnce({
          roomStore,
          dispatcher: crossVerifyDispatcher,
          broadcastRoom,
          broadcastGlobal,
          flushOnRecovery: true,
        });
      } catch (e) {
        console.warn('[cluster-watchdog] runtime reconciliation failed:', e?.message || e);
      }
    }, CLUSTER_RUNTIME_WATCHDOG_INTERVAL_MS);
clusterRuntimeWatchdog?.unref?.();

// ============ v0.53 Sprint 3 — Metrics API ============
// 通用解析 from/to/bucket，避免重复
// ============ Metrics 查询路由 → 已抽到 src/server/routes/metrics.js（D2）============
// overview/timeseries/by-adapter/by-room/pricing 由 registerMetricsRoutes 注册；
registerMetricsRoutes(app, { metricsStore, roomStore, send500 });

// 健康摘要 GET /api/metrics/health → S23 提取到 src/server/routes/ops.js
// （fileSizeMB 是 handler 局部函数随迁；runHealthSweep 内另有同名局部实现，互不共享）
registerOpsMetricsHealthRoutes(app, {
  send500, debateDispatcher, squadDispatcher, arenaDispatcher,
  soloChatDispatcher, crossVerifyDispatcher,
});

// v0.54 Sprint 4.5 — 归档配置 / 手动归档 / 列归档
// S18-2b：4 个 routes 提取到 src/server/routes/archive.js
registerArchiveRoutes(app, { archiveStore, safeResolveFsPath, roomStore });

// v0.55 Sprint 12 — MCP（Model Context Protocol）服务器配置 + 客户端管理
// S18-2c：6 个 routes + McpClientManager 实例化提取到 src/server/routes/mcp.js
const { mcpClientManager } = registerMcpRoutes(app, { mcpStore, permissionGovernance });

// v0.54 Sprint 9 + v0.55 Sprint 14 F1：报告异步 job（设计注释随迁模块）
// S23：reportJobs 实例化 + 2 routes（POST /api/rooms/:id/report + GET /api/reports/:jobId）
// 提取到 src/server/routes/roomsAdvanced.js
registerRoomsReportRoutes(app, {
  roomStore, roomAdapterPool, safeResolveFsPathForWrite, archiveStore,
  defaultReportPath, generateReport, permissionGovernance, permissionApprovalIdFromRequest,
  permissionHttpStatus, permissionHttpBody, activityLog, metricsStore, broadcastGlobal,
});

// v0.53 Sprint 3.5：清理老 metrics 文件（DELETE /api/metrics）→ S23 提取到 src/server/routes/ops.js
registerOpsMetricsDeleteRoutes(app, { send500, metricsStore });

// v0.54 Sprint 4 — Webhooks API
// S18-2a：5 个 routes 提取到 src/server/routes/webhook.js
registerWebhookRoutes(app, { webhookStore, maskWebhookUrl, testWebhook, permissionGovernance });

// v0.53 Sprint 3 阶段 4：房间模板（builtin + user）
// S18-2e1：3 个 routes 提取（rooms 子集；主 rooms CRUD 因依赖过多继续留 server.js）
registerRoomTemplatesRoutes(app, { roomTemplatesStore });

// v0.53 Sprint 3 阶段 3：进程列表（pgrep -P → ps）+ PTY 终端 + 活跃 dispatcher 数
// S23 提取到 src/server/routes/ops.js。terminals 在文件靠后 registerTermRoutes 返回值才 const
// 解构（此处直接传值会 TDZ ReferenceError），必须 getTerminals getter 延迟到请求时求值。
registerOpsHealthProcessesRoutes(app, {
  send500, debateDispatcher, squadDispatcher, arenaDispatcher,
  soloChatDispatcher, crossVerifyDispatcher,
  getTerminals: () => terminals,
});

registerRoomAdaptersRoutes(app, {
  // 第32批：roomAdaptersConfig 属主迁进 room-adapters 工厂，读写经工厂 getter/setter 转发
  getRoomAdaptersConfig: roomAdapterFactory.getRoomAdaptersConfig,
  setRoomAdaptersConfig: roomAdapterFactory.setRoomAdaptersConfig,
  cleanRoomAdaptersConfig,
  maskRoomAdaptersConfig,
  saveRoomAdaptersConfig,
  rebuildRoomAdapters,
  roomAdapterPool,
  hasGeminiCli: roomAdapterFactory.hasGeminiCli,
  permissionGovernance,
  send500,
});

// S23：plugin registry + 6 个 routes 提取到 src/server/routes/plugins.js
registerPluginsRoutes(app, { permissionGovernance, safeResolveFsPath, metricsStore, send500 });

// S18-2e2/P3：rooms 主 CRUD + search 提取到 src/server/routes/rooms.js
const MAX_ROOMS = 500;   // v0.51 S-04 / v0.52 200→500（保留在 server.js 用作 const 注入到 rooms.js）
registerRoomsRoutes(app, {
  roomStore, safeResolveFsPath, safeSlice, roomAdapterPool,
  debateDispatcher, squadDispatcher, arenaDispatcher, soloChatDispatcher,
  roomWsClients, skillStore, MAX_ROOMS,
  backgroundReview: noeBackgroundReview,
});

// 跨房间本地任务委派队列（依赖 roomStore + roomAdapterPool）
registerDelegationRoutes(app, { roomStore, roomAdapterPool, safeResolveFsPath });

registerRoomStartRoutes(app, {
  roomStore,
  requireOwnerToken,
  debateDispatcher,
  squadDispatcher,
  arenaDispatcher,
  crossVerifyDispatcher,
  broadcastRoom,
  roomAdapterPool,
});

// S23：GET /api/rooms/:id/runtime-processes 提取到 src/server/routes/roomsAdvanced.js
registerRoomsRuntimeProcessesRoutes(app, { roomStore, collectPanelRuntimeProcesses });

registerRoomRequirementsRoutes(app, {
  roomStore,
  requireOwnerToken,
  broadcastRoom,
});

// v0.42 task 注入 + v0.70 W8 attempts diff
// S23：2 routes（POST /api/rooms/:id/tasks/:tid/inject + GET …/diff）提取到 src/server/routes/roomsAdvanced.js
registerRoomsTaskOpsRoutes(app, { roomStore, broadcastRoom, send500 });

// v0.52 Sprint1-F：finalConsensus 转发新房
// S23：POST /api/rooms/forward 提取到 src/server/routes/roomsForward.js（含 W3 TDZ 预存 bug，保持行为一致勿改）
registerRoomsForwardRoutes(app, {
  roomStore, MAX_ROOMS, safeResolveFsPath, safeSlice, roomAdapterPool,
  debateDispatcher, squadDispatcher, arenaDispatcher, crossVerifyDispatcher,
  prepareClusterRunGate, broadcastRoom,
});

// v0.52/v0.54 局部重试 / 续跑 / 中断
// S23：4 routes（retry-turn / retry-task / resume / abort）提取到 src/server/routes/roomsAdvanced.js
registerRoomsLifecycleRoutes(app, {
  roomStore, debateDispatcher, squadDispatcher, arenaDispatcher, soloChatDispatcher,
  crossVerifyDispatcher, runClusterRuntimeWatchdogOnce, prepareClusterRunGate,
  roomAdapterPool, broadcastRoom, send500,
});

// v0.48 chat 模式 + 房间媒体附件
// S23：media helper 全家 + 3 routes（POST media / GET media/:mediaId / POST chat）提取到 src/server/routes/roomsMedia.js
registerRoomsMediaRoutes(app, { roomStore, safeSlice, send500, ROOM_MEDIA_DIR, soloChatDispatcher });

// ============ 方案 B 项目监控：扫 ~/Desktop/00_项目/ 下有 PROGRESS.md 的项目 ============
// S23：PROJECTS_ROOT+scanProject 全家+2 routes 提取到 src/server/routes/projects.js
registerProjectsRoutes(app, { send500 });

// ============ ctx 估算 + 07 Continuum 集成 + 外部 Terminal 启动 ============
// S23：findTranscript/estimateCtx 家族、continuumDir/cwdHash、buildClaudeTerminalScript 及 6 routes
// （ctx/snapshot/handoff-history/handoff-meta/handoff/external）提取到 src/server/routes/sessionsContinuum.js
registerSessionsContinuumRoutes(app, { sessions, checkSessionsCapacity, debouncedSave, send500, onSessionCreated: sessionCapacityCounter.onSessionCreated });

// v0.14: 在外部 Terminal 打开 + 自动跑 `claude /login`（OAuth 浏览器跳转流程）
// S23 提取到 src/server/routes/ops.js；单独调用点夹在 sessionsContinuum 两个 register 之间，保序
registerOpsLoginClaudeRoutes(app, { send500 });

// S23：批量 spawn Terminal（/api/spawn-batch）提取到 src/server/routes/sessionsContinuum.js
// （与 external 共享 buildClaudeTerminalScript；单独调用点是为保持与上方 login-claude 的原注册顺序）
registerSessionsSpawnBatchRoutes(app, { sessions });

// S23：/api/browse /api/search 已并入 src/server/routes/files.js（上方 registerFilesRoutes）

// v0.54 Sprint 4 — CLI 一键起房
// S23：POST /api/rooms/quick 提取到 src/server/routes/roomsForward.js
registerRoomsQuickRoutes(app, {
  roomStore, MAX_ROOMS, roomTemplatesStore, safeResolveFsPath,
  debateDispatcher, squadDispatcher, arenaDispatcher, soloChatDispatcher, crossVerifyDispatcher,
  prepareClusterRunGate, roomAdapterPool, broadcastRoom, send500,
});

// ============ v0.50 导出/收藏/fork（F2/F5/F7）============
// S23：4 routes（export/star/stars/fork）提取到 src/server/routes/sessions.js
registerSessionsExtrasRoutes(app, { sessions, checkSessionsCapacity, debouncedSave, onSessionCreated: sessionCapacityCounter.onSessionCreated });

// ============ v0.50 Quick prompts 模板（F6）→ 已抽到 src/server/routes/prompts.js（D2）============
// registerPromptsRoutes(app, { dataDir: DATA_DIR }) 在路由注册区调用

// ============ v0.50 Session forking（F7）→ S23 已并入上方 registerSessionsExtrasRoutes ============

// ============ v0.54 Sprint 10：删除 Ruflo 集成 ============


// ============ v0.22 PTY 内嵌真终端 ============
// S23：3 个 routes + terminals Map 提取到 src/server/routes/term.js（Map 返回供 WS 升级/健康路由/停机清理用）
const { terminals } = registerTermRoutes(app, { safeResolveFsPath, send500 });

// VCP 吸收 H1：WS 心跳保活 + 死连接周期清扫。半开连接（Wi-Fi 切换/合盖/Electron 休眠）不触发 'close'，
// 死 socket 滞留集合 → broadcast 持续往死连接写 → fd/内存缓慢泄漏。周期 ping/pong sweep 主动回收。
const wsHeartbeat = createWsHeartbeat({
  collectClients: function* () {
    for (const ws of globalWsClients) yield ws;
    for (const set of roomWsClients.values()) for (const ws of set) yield ws;
    for (const [, t] of terminals) if (t && t.clients) for (const ws of t.clients) yield ws;
    for (const s of sessions.values()) if (s && s.clients) for (const ws of s.clients) yield ws;
  },
  log: (m) => { try { console.warn(m); } catch {} },
  intervalMs: Number(process.env.NOE_WS_HEARTBEAT_MS) || 30_000,
});

// 注：/api/* fallback 404 已移到所有 /api/* 路由之后（防止拦截新加端点）
// ============ v0.56 Sprint 15-R4：Autopilot 控制 API ============
// S18-2d：6 个 routes 提取到 src/server/routes/autopilot.js
registerAutopilotRoutes(app, { autopilotStore, scheduleStore: autopilotScheduleStore, scheduler: autopilotScheduler });

// ============ v0.56 Sprint 15：Resilience 状态 → 已抽到 src/server/routes/safety.js（D2）============
registerSafetyRoutes(app, { send500 });

// ============ v0.55 Sprint 13-B：知识库（KB）API ============
// S18-2g：7 个 routes 提取
registerKnowledgeRoutes(app, { knowledgeStore, evidenceKnowledgeStore, agentRunStore, activityLog, memoryCore: noeMemoryCore });
// A3：run 归档后自动增量索引证据知识库（失败不阻断归档；activity 仍可手动 reindex）
// Reap zombie agent_runs left `running` across restarts (and periodically while up).
// Safe default: only rows idle >30m. Batches clear large backlogs without blocking boot forever.
function runAgentRunStaleRecover(label = 'boot') {
  try {
    const maxBatches = Math.max(1, Number(process.env.NOE_AGENT_RUN_STALE_RECOVER_BATCHES) || 20);
    const olderThanMs = Math.max(60_000, Number(process.env.NOE_AGENT_RUN_STALE_MS) || 30 * 60 * 1000);
    let total = 0;
    for (let i = 0; i < maxBatches; i++) {
      const r = agentRunStore.recoverStaleRunningRuns({ olderThanMs, limit: 50_000 });
      total += Number(r?.recovered) || 0;
      if (!r || (r.recovered || 0) === 0 || (r.remainingStale || 0) === 0) break;
    }
    if (total > 0) {
      console.warn(`[noe-agent-runs] stale recovered (${label}) total=${total} olderThanMs=${olderThanMs}`);
    }
    return total;
  } catch (e) {
    console.warn(`[noe-agent-runs] stale recover skipped (${label}):`, e?.message || e);
    return 0;
  }
}
runAgentRunStaleRecover('boot');
// Periodic light reaping while process lives (process kills mid-chat still leave zombies).
// Default 6h; set NOE_AGENT_RUN_STALE_INTERVAL_MS=0 to disable.
{
  const intervalMs = Number(process.env.NOE_AGENT_RUN_STALE_INTERVAL_MS);
  const ms = Number.isFinite(intervalMs)
    ? intervalMs
    : 6 * 60 * 60 * 1000;
  if (ms > 0) {
    const t = setInterval(() => runAgentRunStaleRecover('interval'), Math.max(60_000, ms));
    if (typeof t.unref === 'function') t.unref();
  }
}

agentRunStore.setArchiveHook((id, { run, timeline } = {}) => {
  try { evidenceKnowledgeStore.indexRunTimeline(run, timeline); } catch { /* 不阻断归档主流程 */ }
});

// C2：审批决议 / 预算 incident 解决 → 联动推进治理工作队列项（dedupe_key = kind:sourceId）
// 队列项由 buildGovernanceSummary 的 blockers 派生，kind 仅 approval/budget/delegation/autopilot_job
// （无 agent_run），且 blocker.id 即 approvalId / incidentId。run 归档时其 approval/budget 阻塞
// 已由下列各自 hook 推进，故归档不再单独联动队列（避免对不存在的 kind 做无效写）。
// 任一终态决议都解除该审批阻塞；预算解决解除该预算阻塞 → 队列项置 done。
approvalStore.setDecisionHook((id, { status, approval } = {}) => {
  try { governanceQueueStore.setStateBySource('approval', id, 'done', `approval ${status || 'decided'}`); }
  catch { /* 联动失败不阻断决议 */ }
  void noeApprovalGoalResolver(id, { status, approval })
    .catch((e) => console.warn('[noe-approval-goal] decision hook failed:', e?.message || e));
});
budgetPolicyStore.setIncidentResolveHook((id) => {
  try { governanceQueueStore.setStateBySource('budget', id, 'done', 'budget incident resolved'); }
  catch { /* 联动失败不阻断解决 */ }
});

// ============ v0.55 Sprint 13-C：Skills 系统 ============
// S18-2f：6 个 routes 提取
registerSkillsRoutes(app, { skillStore });

// ============ v0.55 Sprint 13-A：OpenAI 兼容 API server ============
// 让外部 IDE / 客户端（VS Code Continue / Cursor / Cherry Studio / 任意 OpenAI SDK）把 panel 当 backend
// 端点不在 /api/* 下，避免被上面的 fallback 拦截。仅 127.0.0.1 监听（panel 默认）
//
// 支持：
//   GET  /v1/models           列出可用 model（每个 adapter + 其推荐 model）
//   POST /v1/chat/completions OpenAI 兼容（非 streaming，body 含 model + messages）
//
// model 命名约定：「<adapterId>:<modelName?>」
// 例：claude:sonnet-4-6 / codex:gpt-5 / gemini-cli / minimax:MiniMax-M2.7
// 也兼容直接 <adapterId> 不带 modelName（用 adapter 默认）

registerOpenaiCompatRoutes(app, { roomAdapterPool, metricsStore, requireOwnerToken, DEBUG_ERRORS });

// v0.51 T-11 fix + v0.55 fix: /api/* 404 fallback（必须在所有 /api/* 路由之后）
app.use('/api', (req, res) => {
  res.status(404).json({ error: `unknown endpoint: ${req.method} ${req.path}` });
});

// /v1/* fallback 404 也返 OpenAI 格式

// WS upgrade
// v0.49 N-02 fix: Origin 白名单防 CSRF（恶意网页伪造 WS upgrade 控制 PTY 终端）
const PORT_NUM = process.env.PORT || 51835;
const ALLOWED_WS_ORIGINS = buildAllowedOrigins(PORT_NUM);
// Round 5 H#1：WS upgrade 统一 token 验证 helper（PTY 那条原本就有，这里抽出来给 global / room / session 复用）
function _rejectWsUpgrade(socket, code, msg) {
  try { socket.write(`HTTP/1.1 ${code} ${msg}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`); } catch {}
  socket.destroy();
}
function _checkWsToken(url, socket, label) {
  const token = url.searchParams.get('token') || '';
  if (!verifyOwnerTokenString(token)) {
    console.warn(`[ws] ${label} owner-token mismatch — dropping`);
    _rejectWsUpgrade(socket, 401, 'Unauthorized');
    return false;
  }
  return true;
}
server.on('upgrade', (req, socket, head) => {
  // Round 5 H#1：以前的 Origin 软白名单 `if (origin && !whitelist...)` 在 origin 缺失时短路放行，
  // 本机其他 UID 用 wscat 不带 Origin 即可绕过。改成靠 token 兜底（PTY/global/room/session 全部强制 ?token=）。
  // Origin 检查保留为额外防 CSRF（浏览器场景 origin 必带），但不再作为唯一防线。
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin, ALLOWED_WS_ORIGINS)) {
    console.warn('[ws] origin rejected:', origin);
    socket.destroy();
    return;
  }
  // 畸形 upgrade 请求（空 Host 头 / req.url 含非法字符）会让 new URL 抛 TypeError；
  // 此回调在 Express 请求周期外，未捕获会冒泡成 uncaughtException → exit。必须兜底。
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch {
    try { socket.destroy(); } catch {}
    return;
  }
  // v0.53 Sprint 3 panel 级全局 WS：/ws/global（接收 metrics_update / health_warning 等）
  if (url.pathname === '/ws/global') {
    if (!_checkWsToken(url, socket, '/ws/global')) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      globalWsClients.add(ws);
      wsHeartbeat.track(ws);
      try { ws.send(JSON.stringify({ type: 'connected', channel: 'global' })); } catch {}
      // T27 Sticky Events（波次6 接线）：重连/切窗补发最近关键事件（hang 告警/死前交接/自动暂停），断线不丢
      try { for (const m of noeStickyEvents.replay()) ws.send(JSON.stringify(m)); } catch {}
      ws.on('close', () => globalWsClients.delete(ws));
    });
    return;
  }
  // v0.39 聊天室 WS：/ws/room/:roomId
  const roomMatch = url.pathname.match(/^\/ws\/room\/([0-9a-f-]{36})$/);
  if (roomMatch) {
    if (!_checkWsToken(url, socket, '/ws/room/')) return;
    const roomId = roomMatch[1];
    const room = roomStore.get(roomId);
    if (!room) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      let set = roomWsClients.get(roomId);
      if (!set) { set = new Set(); roomWsClients.set(roomId, set); }
      set.add(ws);
      wsHeartbeat.track(ws);
      ws.send(JSON.stringify({ type: 'connected', roomId, room }));
      ws.on('close', () => {
        const s = roomWsClients.get(roomId);
        if (s) { s.delete(ws); if (s.size === 0) roomWsClients.delete(roomId); }
      });
    });
    return;
  }
  // v0.22 PTY 终端 WS：/ws/term/:termId
  const termMatch = url.pathname.match(/^\/ws\/term\/([0-9a-f-]{36})$/);
  if (termMatch) {
    const termId = termMatch[1];
    const t = terminals.get(termId);
    if (!t) return socket.destroy();
    // Round 4 P0：WS 升级也得验 owner-token（浏览器 WS 不能加 header → 用 query ?token=）
    // 不验就 = 本机其他 UID 进程可以 wscat 直接接管 shell I/O
    if (!_checkWsToken(url, socket, '/ws/term/')) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      t.clients.add(ws);
      wsHeartbeat.track(ws);
      ws.send(JSON.stringify({ type: 'connected', termId, cwd: t.cwd }));
      ws.on('message', raw => {
        try {
          const obj = JSON.parse(raw.toString());
          if (obj.type === 'input' && typeof obj.data === 'string') {
            const decision = terminalApprovalGate.processInput(t, obj.data, {
              source: 'terminal',
              cwd: t.cwd,
              requesterType: 'terminal',
              requesterId: termId,
              metadata: { shell: t.shell, termId },
            });
            if (decision.allowed) {
              t.term.write(decision.data);
            } else {
              try { t.term.write(decision.data || '\u0003'); } catch {}
              const msg = `\r\n\x1b[31m[approval required]\x1b[0m 危险命令已暂停：${decision.command}\r\napprovalId=${decision.approval?.id || 'unknown'}\r\n`;
              try { t.term.write(msg); } catch {}
              try {
                ws.send(JSON.stringify({
                  type: 'approval_required',
                  approval: decision.approval,
                  command: decision.command,
                  hits: decision.hits,
                  severity: decision.worstSeverity,
                }));
              } catch {}
            }
          } else if (obj.type === 'resize' && obj.cols && obj.rows) {
            t.term.resize(Math.max(20, Math.min(500, obj.cols | 0)), Math.max(5, Math.min(200, obj.rows | 0)));
          }
        } catch {}
      });
      ws.on('close', () => t.clients.delete(ws));
    });
    return;
  }
  // session chat WS：/ws/:sessionId
  const m = url.pathname.match(/^\/ws\/([0-9a-f-]{36})$/);
  if (!m) return socket.destroy();
  if (!_checkWsToken(url, socket, '/ws/session/')) return;
  const id = m[1];
  const session = sessions.get(id);
  if (!session) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    session.clients.add(ws);
    wsHeartbeat.track(ws);
    ws.send(JSON.stringify({ type: 'connected', sessionId: id }));
    if (session.messages.length) {
      ws.send(JSON.stringify({ type: 'history', messages: session.messages }));
    }
    ws.on('close', () => session.clients.delete(ws));
  });
});

const PORT = process.env.PORT || 51835;
// v0.49 N-01 fix: 默认只听 127.0.0.1，避免 PTY/WS 暴露给 LAN。
// 显式 PANEL_HOST=0.0.0.0 才开放全网卡（Electron 本机访问不受影响）。
const HOST = process.env.PANEL_HOST || '127.0.0.1';
// v0.51 T-20 fix: listen 错误处理（端口被占用 / 权限不足等），明确日志告诉用户怎么办
// 集群协同运维加固：不要在 listen error 内立刻 process.exit。
// pino/sonic-boom 刚初始化时直接 exit 可能触发二次 uncaughtException，导致用户看到误导性崩溃。
server.on('error', (err) => {
  handleServerListenError(err, { port: PORT, flushLogs: flushLoggerSync });
});
server.listen(PORT, HOST, () => {
  // Round 5：owner-token bootstrap via URL query —— stdout 打印带 ?t= 的入口 URL，
  // 前端读 query 存 sessionStorage，之后所有 fetch+WS 自动带 token。
  // 攻击者裸 curl `/` 拿不到 token（HTML 静态文件不 inject），用户主动复制 URL 才能拿。
  const ownerToken = getOrCreateOwnerToken();
  // 安全：守护态（launchd）的 stdout 会落进 /tmp 的 0644 共享日志，本机其他 UID 可读，
  // 若打印明文 token 等于自毁 owner-token 的 UID 隔离（该 token 门控 PTY/plugins/WS 等写端点）。
  // 因此默认仅交互式 TTY（owner 本地终端、需手动复制带 token 的 URL）才打印明文；守护态一律 [redacted]。
  // 显式 NOE_PRINT_OWNER_TOKEN=1 可强制打印；=0 可强制隐藏。
  const printOwnerToken = process.env.NOE_PRINT_OWNER_TOKEN === '1'
    || (Boolean(process.stdin.isTTY) && process.env.NOE_PRINT_OWNER_TOKEN !== '0');
  const entryUrl = ownerToken
    ? `http://${HOST}:${PORT}/?t=${printOwnerToken ? ownerToken : '[redacted]'}`
    : `http://${HOST}:${PORT}`;
  console.log(`🚀 Noe @ ${entryUrl}`);
  if (!ownerToken) {
    console.log(`   ⚠️  owner-token 生成失败（~/.noe-panel/owner-token.txt 写不进），UI 写端点会全部 401`);
  }
  console.log(`   Using claude bin: ${CLAUDE_BIN}`);
  if (HOST !== '127.0.0.1') {
    console.log(`   ⚠️  监听 ${HOST}（非本地），PTY 终端将暴露给该接口，请确认网络安全`);
  }
  // 2026-05：interactive 启动时自动用默认浏览器打开带 token 的入口 URL，
  //   避免用户直接访问 `/` 拿不到 token → sessionStorage 空 → 全部 401 → 按钮点不动。
  //   仅在 TTY 启动（npm start）+ darwin + 有 token + 未禁用 时打开；守护进程/CI/PANEL_NO_OPEN=1 跳过。
  if (ownerToken && process.platform === 'darwin' && process.stdin.isTTY && !process.env.PANEL_NO_OPEN) {
    import('node:child_process').then(({ spawn: _spawnOpen }) => {
      const child = _spawnOpen('open', [entryUrl], { stdio: 'ignore', detached: true });
      child.on('error', () => {});
      child.unref();
    }).catch(() => {});
  }
  // v0.53 Sprint 3 阶段 3：启动后异步跑一次健康巡检
  setTimeout(() => runHealthSweep().catch(() => {}), 5000);
  // VCP 吸收 H2：若启动自检发生坏库自动回滚，broadcast health_warning（sticky，新连接补发提醒 owner）。
  try {
    const dbRec = getDbAutoRecoveryEvent();
    if (dbRec && dbRec.recovered) {
      broadcastGlobal({
        type: 'health_warning',
        kind: 'db_auto_recovered',
        text: `panel.db 启动自检发现损坏，已从备份 ${String(dbRec.from || '').split('/').pop()} 自动恢复（损坏库隔离在 ${dbRec.corruptPath}）`,
      });
    }
  } catch {}
});

// v0.53 Sprint 3 阶段 3：周期性健康巡检（每 30 分钟一次，发现告警就 broadcastGlobal）
let _lastHealthWarnings = '';
async function runHealthSweep() {
  try {
    const PANEL_DIR = join(homedir(), '.noe-panel');
    const fileSizeMB = (name) => {
      try { return Math.round((statSync(join(PANEL_DIR, name)).size / 1024 / 1024) * 100) / 100; }
      catch { return 0; }
    };
    let metricsMB = 0;
    try {
      const files = readdirSync(PANEL_DIR).filter((f) => /^metrics-\d{4}-\d{2}\.jsonl/.test(f));
      for (const f of files) metricsMB += statSync(join(PANEL_DIR, f)).size;
      metricsMB = Math.round((metricsMB / 1024 / 1024) * 100) / 100;
    } catch {}
    const rssMB = Math.round((process.memoryUsage().rss / 1024 / 1024) * 100) / 100;
    const warnings = [];
    if (rssMB > 1024) warnings.push(`panel 内存占用偏高：${rssMB} MB`);
    if (fileSizeMB('data.json') > 200) warnings.push(`data.json > 200MB（当前 ${fileSizeMB('data.json')}MB）`);
    if (fileSizeMB('rooms.json') > 100) warnings.push(`rooms.json > 100MB（当前 ${fileSizeMB('rooms.json')}MB）`);
    if (metricsMB > 500) warnings.push(`metrics 文件总量 > 500MB（当前 ${metricsMB}MB）`);
    const sig = warnings.join('|');
    if (warnings.length > 0 && sig !== _lastHealthWarnings) {
      _lastHealthWarnings = sig;
      console.warn('[health] warnings:', warnings);
      try { broadcastGlobal({ type: 'health_warning', warnings, at: new Date().toISOString() }); } catch {}
    } else if (warnings.length === 0) {
      _lastHealthWarnings = '';
    }
  } catch (e) {
    console.warn('[health] sweep failed:', e.message);
  }
}
setInterval(() => { runHealthSweep().catch(() => {}); }, 30 * 60 * 1000);
// VCP 吸收 H1：启动 WS 心跳周期清扫（默认 30s sweep）。
wsHeartbeat.start();

function abortAndFlushPanelRoomDispatchers() {
  return abortAndFlushActiveRoomDispatchers({
    roomStore,
    dispatchers: [
      { name: 'debate', dispatcher: debateDispatcher },
      { name: 'squad', dispatcher: squadDispatcher },
      { name: 'arena', dispatcher: arenaDispatcher },
      { name: 'soloChat', dispatcher: soloChatDispatcher },
      { name: 'crossVerify', dispatcher: crossVerifyDispatcher },
    ],
  });
}

async function gracefulShutdown(signal) {
  console.log(`收到 ${signal}，force save data + 关 child...`);
  // P0-8a: 兜底 timer,任何一步卡住 5s 后强制退出(launchd SIGKILL 会丢落盘)
  const shutdownTimeout = setTimeout(() => {
    console.error('[shutdown] timeout after 5s, force exit');
    process.exit(1);
  }, 5000).unref();
  try {
    try { if (clusterRuntimeWatchdog) clearInterval(clusterRuntimeWatchdog); } catch {}
    try { wsHeartbeat.stop(); } catch {}
  try { noeHeartbeat?.stop?.({ reason: `shutdown:${signal}`, interruptRunning: true }); } catch {}
  try { noeLoop.stop({ reason: 'shutdown' }); } catch {}
  try { saveData(); } catch (e) { console.error('save fail:', e.message); }
  // v0.51 A-01 fix + 集群协同加固:先 abort dispatchers,再 flush roomStore,
  // 确保 abort 写入的 paused 状态能落盘,避免重启后假 running。
  try {
    const shutdownAbort = abortAndFlushPanelRoomDispatchers();
    if (shutdownAbort.flushError) console.error('roomStore flush fail:', shutdownAbort.flushError);
  } catch (e) {
    console.error('dispatcher abort/roomStore flush fail:', e?.message || e);
    try { roomStore.flush(); } catch (flushErr) { console.error('roomStore flush fail:', flushErr.message); }
  }
  for (const s of sessions.values()) {
    if (s.child) try { s.child.kill(); } catch {}
  }
  for (const [, t] of terminals) {
    try { t.term.kill(); } catch {}
  }
  // 强健（2026-06-10）：停机关 WS——让前端收到正常关闭帧，避免重启窗口内前端进入 WebSocket 重连死循环
  try { for (const s of sessions.values()) { for (const ws of (s.clients || [])) { try { ws.close(); } catch {} } } } catch {}
  try { for (const ws of globalWsClients) { try { ws.close(); } catch {} } } catch {}
  try { for (const set of roomWsClients.values()) { for (const ws of set) { try { ws.close(); } catch {} } } } catch {}
  // 强健（2026-06-10）：MCP 优雅断开改 await——旧版 fire-and-forget 紧跟 exit，子进程（playwright/
  // memory/filesystem）来不及收 SIGTERM 就被孤立成孤儿（owner 痛点同源）。1.5s 是停机清理上限：关本地
  // stdio 是毫秒级，个别卡住不拖垮整个停机，后续落盘/flush 仍能执行（停机 bound，非模型调用超时）。
  try { await Promise.race([mcpClientManager.disconnectAll(), new Promise((r) => setTimeout(r, 1500))]); } catch {}
  // 强健⑥（2026-06-10 优雅停机补全）：干净关 SQLite——WAL checkpoint 回主库，
  // 备份/拷库拿到的单文件即完整态；再同步 flush 日志缓冲，停机前最后的输出不丢。
  try { closeSqliteStore(); } catch {}
  try { flushLoggerSync(); } catch {}
  } finally {
    clearTimeout(shutdownTimeout);
  }
  process.exit(0);
}
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
// v0.45 P0-2: 未捕获异常也强制落盘 + 退出
// v0.51 T-01 fix: uncaughtException 必须 exit
// Node 默认 unhandled exception 会 exit；注册 handler 后默认不 exit → 进程在不一致状态继续跑
// 正确做法：记日志 + 救命落盘 + exit(1)，让 Electron/launchctl/手动重启恢复
// v1.0 Task 1.1：异步引入 Sentry 兼容 ErrorReporter（用户填 DSN 才启用，默认关）
// P0-8b: 静态 import + 显式 catch 日志(原 fire-and-forget 静默,Sentry 启动失败 owner 看不到)
let _reporter = null;
try {
  _reporter = ErrorReporter;
} catch (e) {
  console.error('[error-reporter] init failed:', e?.message || e);
}

process.on('uncaughtException', (e) => {
  console.error('[uncaughtException]', e?.stack || e);
  try { _reporter?.captureException(e, { level: 'fatal', tags: { kind: 'uncaught' } }); } catch {}
  // 进程即将 exit；先摘掉所有 child stdout 监听，避免 500ms 退出窗口内继续写入 session.messages
  // 导致已落盘的快照与最终状态不一致（崩溃时尽量保住完整对话）
  try { sessions.forEach(s => { try { s.child?.stdout?.removeAllListeners('data'); } catch {} }); } catch {}
  // 强健工程：显式 kill 子进程（上一版注释声称"提前发 SIGTERM"但从未实现——崩溃后 claude/PTY 子进程会变孤儿）
  try { sessions.forEach(s => { try { s.child?.kill?.(); } catch {} }); } catch {}
  try { for (const [, t] of terminals) { try { t.term.kill(); } catch {} } } catch {}
  try { saveData(); } catch {}
  try {
    const fatalAbort = abortAndFlushPanelRoomDispatchers();
    if (fatalAbort.flushError) console.error('roomStore flush fail:', fatalAbort.flushError);
  } catch {
    try { roomStore.flush(); } catch {}
  }
  // S21 B6：100ms 不够 PTY 子进程清理；改 500ms + 提前发 SIGTERM 给子进程
  try { mcpClientManager.disconnectAll().catch(() => {}); } catch {}
  try { noeLoop.stop({ reason: 'fatal' }); } catch {}
  setTimeout(() => process.exit(1), 500);
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
  try { _reporter?.captureException(reason, { level: 'error', tags: { kind: 'unhandled-rejection' } }); } catch {}
  try {
    const recovery = recoverClusterRuntimeAfterNonFatalError({
      roomStore,
      dispatcher: crossVerifyDispatcher,
      broadcastRoom,
      broadcastGlobal,
      source: 'unhandledRejection',
    });
    if (recovery.recoveryError) console.error('[unhandledRejection] cluster runtime recovery failed:', recovery.recoveryError);
    if (recovery.flushError) console.error('[unhandledRejection] roomStore flush failed:', recovery.flushError);
  } catch {
    try { roomStore.flush(); } catch {}
  }
  // unhandledRejection 在 Node 15+ 默认行为是 terminate，但很多 host 仍会容忍；
  // 这里只记日志不 exit，避免 promise 失败误杀整个 panel（可调）
});
