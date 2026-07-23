import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, openSync, unlink, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireOwnerToken } from '../auth/owner-token.js';
import { runM3SuggestionTask } from '../../room/MiniMaxSuggestionPipeline.js';
import { fileIndex as defaultFileIndex } from '../../memory/FileIndex.js';
import { VoiceSession } from '../../voice/VoiceSession.js';
import { LocalSttClient } from '../../voice/LocalSttClient.js';
import { makeNoeSttClient } from '../../voice/SherpaSttClient.js';
import { makeSileroVad } from '../../voice/SileroVadClient.js';
import { VisionSession } from '../../vision/VisionSession.js';
import { EpisodicTimeline } from '../../memory/EpisodicTimeline.js';
import { createNoeScreenChronicle } from '../../vision/NoeScreenChronicle.js';
import { MiniMaxTtsClient } from '../../voice/MiniMaxTtsClient.js';
import { createProactiveTickHandler } from '../../loop/proactiveTick.js';
import { isQuiet as circadianIsQuiet } from '../../loop/NoeCircadian.js';
import { kvGet, kvSet } from '../../storage/SqliteStore.js';
import { NoeMemoryExtractor } from '../../memory/NoeMemoryExtractor.js';
import { createDelegationHook } from '../../runtime/NoeDelegationExtractor.js';
import { KokoroTtsClient } from '../../voice/KokoroTtsClient.js';
import { CosyVoiceTtsClient } from '../../voice/CosyVoiceTtsClient.js';
import { QwenVoiceDesignTtsClient } from '../../voice/QwenVoiceDesignTtsClient.js';
import { OpenAICompatibleVoiceGatewayClient } from '../../voice/OpenAICompatibleVoiceGatewayClient.js';
import { recommend as hwfitRecommend } from '../../hwfit/HardwareFit.js';
import { createAISearch } from '../../research/AISearch.js';
import { createWebSearch } from '../../research/WebSearch.js';
import { createPrefetchStore } from '../../prefetch/NoePrefetchStore.js';
import { createDeepResearcher } from '../../research/DeepResearcher.js';
import { createBrainChat } from '../../room/brainChat.js';
import { registerNoeDoRoute } from './noeDo.js';
import { registerNoeEmergencyStopRoutes } from './noeEmergencyStop.js';
import { resolveHeavyReflectBrain } from '../../cognition/NoeReflectBrain.js';
import { registerNoeDelegationRoutes } from './noeDelegation.js';
import { registerNoeVisionAttachmentRoute } from './noeVisionAttachment.js';
import { registerNoeVisionAmbientRoutes } from './noeVisionAmbient.js';
import { defaultChatProfileStore } from '../../voice/ChatProfileStore.js';
import { defaultOwnerGateStore } from '../../voice/OwnerGateStore.js';
import { defaultOwnerIdentityStore } from '../../identity/OwnerIdentityStore.js';
import { defaultPersonKnowledgeStore } from '../../identity/PersonKnowledgeStore.js';
import { defaultIdentityModelSettingsStore } from '../../identity/IdentityModelSettingsStore.js';
import { registerNoeChatProfileRoutes } from './noeChatProfiles.js';
import { registerNoeOwnerGateRoutes } from './noeOwnerGate.js';
import { registerNoeIdentityRoutes } from './noeIdentity.js';
import { registerNoePeopleRoutes } from './noePeople.js';
import { registerNoeComputerSearchRoutes } from './noeComputerSearch.js';
import { registerNoeLocalCouncilRoutes } from './noeLocalCouncil.js'; import { registerNoeTaskflowRoutes } from './noeTaskflows.js';
import { registerNoeDoctorRoutes } from './noeDoctor.js'; import { registerNoeAcuiCardRoutes } from './noeAcuiCards.js';
import { registerNoeUiSignalRoutes } from './noeUiSignals.js';
import { registerNoeCoreRoutes } from './noeCoreRoutes.js';
import { registerNoeFreedomRoutes } from './noeFreedom.js';
import { registerNoeMissionRoutes } from './noeMission.js';
import { registerNoeProposalRoutes } from './noeProposals.js';
import { registerNoeSocialInboundRoutes } from './noeSocialInbound.js';
import { registerNoeBootSelfCheckRoutes } from './noeBootSelfCheck.js';
import { registerNoePanelLogTailRoutes } from './noePanelLogTail.js';
import { registerNoeProductSettingsRoutes } from './noeProductSettings.js';
import { createTelegramInbound } from '../../channels/TelegramInbound.js';
import { MiniMaxImageClient } from '../../media/MiniMaxImageClient.js';
import { MiniMaxVideoClient } from '../../media/MiniMaxVideoClient.js';
import { MiniMaxMusicClient } from '../../media/MiniMaxMusicClient.js';
import { NoeMediaStudio } from '../../media/NoeMediaStudio.js';
import { registerNoeMediaRoutes } from './noeMedia.js';
import { selectFreshReportableGoal } from '../../loop/NoeProactiveSelfopsFilter.js';

function sendError(res, e) {
  const msg = e?.message || String(e);
  if (/required|invalid|must be|missing|outside allowed roots/i.test(msg)) return res.status(400).json({ ok: false, error: msg });
  return res.status(500).json({ ok: false, error: msg });
}

const SPEECH_FALLBACK_SECRET_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;

function speechFallbackText(value, max = 160) {
  return String(value || '')
    .replace(SPEECH_FALLBACK_SECRET_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function speechFallbackAudioPath(format = 'mp3') {
  const safeFormat = String(format || 'mp3').toLowerCase() === 'wav' ? 'wav' : 'mp3';
  const dir = join(homedir(), '.noe-panel', 'tmp', 'task-reportbacks');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return join(dir, `reportback-${Date.now()}-${process.pid}-${randomUUID()}.${safeFormat}`);
}

async function taskReportbackSystemSpeechFallback(item = {}, { error = '', ttsClient = null } = {}) {
  const mode = String(process.env.NOE_TASK_REPORTBACK_SYSTEM_TTS || '0').trim().toLowerCase();
  if (['0', 'false', 'off'].includes(mode) || process.env.VITEST === 'true' || process.env.NODE_ENV === 'test') return { attempted: false, reason: 'disabled' };
  const title = speechFallbackText(item.title || 'Noe 任务', 80);
  const summary = speechFallbackText(item.summary || '', 180);
  const why = speechFallbackText(error || item.speechError || 'browser_audio_failed', 80);
  const text = `主人，浏览器任务语音播放失败，原因是 ${why}。我用系统语音兜底汇报：${title}。${summary}`.slice(0, 360);

  let minimaxFallbackReason = null;
  const minimaxMode = String(process.env.NOE_TASK_REPORTBACK_MINIMAX_TTS || '1').trim().toLowerCase();
  if (!['0', 'false', 'off'].includes(minimaxMode)) {
    const client = ttsClient || new MiniMaxTtsClient();
    if (client?.configured?.()) {
      try {
        const { audioBuffer, format } = await client.synthesize(text);
        if (process.platform !== 'darwin' || !existsSync('/usr/bin/afplay')) {
          minimaxFallbackReason = 'afplay_unavailable';
        } else {
          const audioFile = speechFallbackAudioPath(format);
          writeFileSync(audioFile, audioBuffer, { mode: 0o600 });
          const cleanup = () => unlink(audioFile, () => {});
          const child = spawn('/usr/bin/afplay', [audioFile], { stdio: 'ignore' });
          child.once('exit', cleanup);
          child.once('error', cleanup);
          child.unref?.();
          return { attempted: true, command: 'afplay', provider: 'minimax' };
        }
      } catch (e) {
        minimaxFallbackReason = speechFallbackText(e?.message || String(e), 120);
      }
    } else {
      minimaxFallbackReason = 'minimax_unconfigured';
    }
  } else {
    minimaxFallbackReason = 'minimax_disabled';
  }

  if (process.platform !== 'darwin' || !existsSync('/usr/bin/say')) return { attempted: false, reason: minimaxFallbackReason || 'say_unavailable', provider: 'none' };
  const child = spawn('/usr/bin/say', [text], { stdio: 'ignore', detached: true });
  child.unref?.();
  return { attempted: true, command: 'say', provider: 'macos', reason: minimaxFallbackReason };
}

export function registerNoeRoutes(app, {
  loop,
  memory,
  memoryWriteGate = null,
  memoryRetriever = null,
  commitmentStore = null,
  driveBrief = null, // 内稳态驱力简报（意识工程·阶段1，NOE_DRIVES=1 才注入）：() => string|null，透传 proactiveTick
  feelingBrief = null, // 感受词元（意识方案 §4 P1，NOE_AFFECT=1 才注入）：() => string|null，透传 proactiveTick
  personCardStore = null,
  prefetchStore = null,
  focus,
  toolRegistry,
  approvalStore,
  actStore,
  actPipeline,
  m3SuggestionRunner,
  fileIndex = defaultFileIndex,
  brainRouter = null, getAdapter = null, foregroundChatRouting = null, chatProfileStore = defaultChatProfileStore, ownerGateStore = defaultOwnerGateStore, ownerIdentityStore = defaultOwnerIdentityStore, personStore = defaultPersonKnowledgeStore, modelSettings = personStore?.modelSettings || defaultIdentityModelSettingsStore,
  getMcpClient = null,
  permissionGovernance = null,
  roomStore = null, getRoomAdapterPool = null,
  scheduleStore = null,
  agentRunStore = null,
  safeResolveFsPath = null,
  selfTalkEvidence = null,
  taskReportbacks = null,
  taskReportbackSystemSpeech = taskReportbackSystemSpeechFallback,
  onCommitmentDelivery = null,
  getGoalSystem = null, // 对话委托桥（NOE_DELEGATION）：goalSystem 在 server.js 后文才装配，getter 惰性求值
  innerStateProvider = null, // P4：当下认知态内容 provider（() => string）；透传 VoiceSession 内置 ContextEngine，让语音回复也带"此刻心情+焦点"。未注入则 inner-state 段 no-op。
  personaPinProvider = null, // P8(总验收三方一致)：稳定人设下沉 provider（() => string），透传 VoiceSession 内置 ContextEngine，让语音回复也下沉 persona-pin。未注入则 no-op（NOE_MEMORY_PERSONA_PIN 默认 OFF）。
} = {}) {
  if (!loop) throw new Error('registerNoeRoutes: deps.loop required');
  if (!memory) throw new Error('registerNoeRoutes: deps.memory required');
  if (!focus) throw new Error('registerNoeRoutes: deps.focus required');
  if (!toolRegistry) throw new Error('registerNoeRoutes: deps.toolRegistry required');
  function buildReadiness(projectId) {
    const loopStatus = loop.status();
    const memoryStats = memory.stats({ projectId });
    const focusDepth = focus.depth({ projectId });
    const tools = toolRegistry.list();
    const pendingApprovals = approvalStore?.listApprovals?.({ status: 'pending', limit: 50 }) || [];
    const actSummary = actStore?.summary?.({ projectId: projectId || 'noe' }) || { byStatus: {}, pending: 0, current: null };
    const fileIndexStats = fileIndex.stats();
    const selfTalkSummary = (() => { try { return selfTalkEvidence?.summary?.() || null; } catch { return null; } })();
    const blockers = [];
    if (!loopStatus || typeof loopStatus !== 'object') blockers.push('loop_status_unavailable');
    if (!memoryStats || typeof memoryStats !== 'object') blockers.push('memory_stats_unavailable');
    if (!fileIndexStats || typeof fileIndexStats !== 'object') blockers.push('file_index_unavailable');
    return {
      ok: blockers.length === 0,
      readiness: {
        status: blockers.length ? 'blocked' : 'passed',
        blockers,
        warnings: [],
      },
      checks: {
        loop: blockers.includes('loop_status_unavailable') ? 'blocked' : 'passed',
        memory: blockers.includes('memory_stats_unavailable') ? 'blocked' : 'passed',
        fileIndex: blockers.includes('file_index_unavailable') ? 'blocked' : 'passed',
      },
      counts: {
        memoryVisible: Number(memoryStats?.visible ?? 0),
        focusDepth: Number(focusDepth || 0),
        total: tools.length,
        enabled: tools.filter((tool) => tool.enabled).length,
        disabled: tools.filter((tool) => !tool.enabled).length,
        pendingApprovals: pendingApprovals.length,
        pendingActs: Number(actSummary?.pending || 0),
        ...(selfTalkSummary ? {
          p6SelfTalkOutcomes: Number(selfTalkSummary.selfTalkOutcomes || 0),
          p6GuardRecords: Number(selfTalkSummary.guardRecords || 0),
          p6ConfirmedDelivery: Number(selfTalkSummary.confirmedDelivery || 0),
        } : {}),
      },
      ...(selfTalkSummary ? {
        p6: {
          mode: process.env.NOE_INNER_MODE || 'audit',
          selfTalkOutcomes: selfTalkSummary.selfTalkOutcomes,
          guardRecords: selfTalkSummary.guardRecords,
          confirmedDelivery: selfTalkSummary.confirmedDelivery,
          confirmedSelfTalkLandingRate: selfTalkSummary.confirmedSelfTalkLandingRate,
          ruminationGuardTripRate: selfTalkSummary.ruminationGuardTripRate,
          llmContextAllowed: selfTalkSummary.llmContextAllowed,
        },
      } : {}),
      at: new Date().toISOString(),
    };
  }
  // ③A fetch 缓存（NOE_FETCH_CACHE=1 默认 OFF）：给 research 网页抓取注入 TTL 缓存，治自主学习同 URL 跨次重抓。
  //   OFF 时 fetchCache=null → fetchContent 直通、零回归。
  const webSearch = createAISearch({ webSearch: createWebSearch({ fetchCache: process.env.NOE_FETCH_CACHE === '1' ? createPrefetchStore({ maxEntries: 300 }) : null }) });
  const researchChat = createBrainChat({ getAdapter, brainRouter, taskId: 'noe-research' });
  const deepResearcher = createDeepResearcher({ webSearch, chat: researchChat });
  registerNoeCoreRoutes(app, {
    loop,
    memory,
    focus,
    toolRegistry,
    approvalStore,
    actStore,
    actPipeline,
    sendError,
  });
  registerNoeProductSettingsRoutes(app, {
    approvalStore,
    actStore,
    memory,
    sendError,
  });
  registerNoeProposalRoutes(app, { sendError });
  registerNoeSocialInboundRoutes(app, { memory });
  registerNoeBootSelfCheckRoutes(app, { sendError });
  registerNoePanelLogTailRoutes(app, { sendError });

  app.post('/api/noe/m3/suggest', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      const context = String(body.context ?? body.content ?? '').trim();
      if (!context) return res.status(400).json({ ok: false, error: 'context required' });
      const result = await runM3SuggestionTask({
        taskType: body.taskType || body.task_type || 'general',
        title: body.title || 'Noe internal M3 suggestion request',
        context,
        constraints: body.constraints,
        expectedOutput: body.expectedOutput || body.expected_output,
      }, {
        runner: m3SuggestionRunner,
      });
      const task = result.task ? {
        id: result.task.id,
        taskType: result.task.taskType,
        title: result.task.title,
        route: result.task.route,
        allowLocalTools: result.task.allowLocalTools,
      } : null;
      return res.status(result.ok ? 200 : 202).json({
        ok: result.ok,
        status: result.status,
        plan: result.plan,
        task,
        error: result.error,
      });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/files/index', requireOwnerToken, (_req, res) => {
    try {
      return res.json({ ok: true, index: fileIndex.stats() });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/files/index', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      const index = fileIndex.indexPath({
        root: body.root || process.cwd(),
        projectId: body.projectId || body.project_id || 'noe',
        maxFiles: body.maxFiles || body.max_files,
        maxBytesPerFile: body.maxBytesPerFile || body.max_bytes_per_file,
        allowOutsideWorkspace: Boolean(body.allowOutsideWorkspace),
        extensions: Array.isArray(body.extensions) ? body.extensions : undefined,
      });
      return res.json({ ok: true, index });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.get('/api/noe/files/search', requireOwnerToken, (req, res) => {
    try {
      return res.json({
        ok: true,
        results: fileIndex.search({
          q: req.query.q || req.query.query || '',
          projectId: req.query.project || req.query.projectId,
          limit: req.query.limit,
        }),
      });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/tasks/reportbacks', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      if (!taskReportbacks) return res.json({ ok: true, items: [], current: [] });
      const limit = Math.max(1, Math.min(100, Number(body.limit) || 30));
      const currentLimit = Math.max(1, Math.min(50, Number(body.currentLimit) || 20));
      const items = body.consume === false ? taskReportbacks.list({ limit, delivered: false }) : taskReportbacks.consume({ limit });
      const current = body.current === false ? [] : taskReportbacks.current({ limit: currentLimit });
      return res.json({ ok: true, items, current });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/tasks/reportbacks/speech-ack', requireOwnerToken, async (req, res) => {
    try {
      if (!taskReportbacks?.markSpoken) return res.status(501).json({ ok: false, error: 'task reportbacks not configured' });
      const body = req.body || {};
      const item = taskReportbacks.markSpoken(String(body.id || ''), { ok: body.ok !== false, error: body.error || null });
      if (!item) return res.status(404).json({ ok: false, error: 'reportback not found' });
      let systemSpeechFallback = null;
      if (body.ok === false) {
        if (item.systemSpeechFallbackAt && item.systemSpeechFallback) {
          return res.json({ ok: true, item, systemSpeechFallback: item.systemSpeechFallback, deduped: true });
        }
        try { systemSpeechFallback = await (taskReportbackSystemSpeech?.(item, { error: body.error || item.speechError || null }) || null); } catch (e) { systemSpeechFallback = { attempted: false, error: speechFallbackText(e?.message || String(e), 120) }; }
        if (systemSpeechFallback) {
          const marked = taskReportbacks.markSpoken(String(body.id || ''), { ok: false, error: body.error || null, systemSpeechFallback });
          if (marked) Object.assign(item, marked);
        }
      }
      return res.json({ ok: true, item, systemSpeechFallback });
    } catch (e) { return sendError(res, e); }
  });

  // 多模型「大脑/手脚」难度路由：返回该用哪个档位的模型（L1 本地 / L2 MiniMax / L3 Claude），省 token。
  // 默认只返回路由决策；execute 时本地 L1 直接执行（免配额），付费档 L2/L3 需 allowPaid 显式确认（守红线 4）。
  app.post('/api/noe/route', requireOwnerToken, async (req, res) => {
    try {
      if (!brainRouter) return res.status(501).json({ ok: false, error: 'brain router not configured' });
      const body = req.body || {};
      const inputText = String(body.text ?? body.query ?? body.content ?? '').trim();
      if (!inputText) return res.status(400).json({ ok: false, error: 'text required' });
      const decision = brainRouter.route({
        text: inputText,
        requiresTools: body.requiresTools,
        requiresShell: body.requiresShell,
        requiresFileSystem: body.requiresFileSystem,
      });
      if (!body.execute) return res.json({ ok: true, decision, executed: false });
      // 守红线 4：付费档默认不擅自执行，需 allowPaid 显式确认才烧配额
      if (decision.paid && !body.allowPaid) {
        return res.json({ ok: true, decision, executed: false, reason: '付费档（mid/code/deep）需 allowPaid:true 显式确认才执行，避免擅自消耗配额' });
      }
      // 本地档优先主 adapter（ollama），失败依次 fallback（LM Studio）
      const chain = [decision.adapterId, ...(Array.isArray(decision.fallbacks) ? decision.fallbacks : [])];
      let result = null;
      let usedAdapter = null;
      let lastErr = null;
      for (const aid of chain) {
        const adapter = getAdapter ? getAdapter(aid) : null;
        if (!adapter || typeof adapter.chat !== 'function') continue;
        try {
          result = await adapter.chat([{ role: 'user', content: inputText }], { budgetContext: { projectId: 'noe', taskId: 'noe-route' } });
          usedAdapter = aid;
          break;
        } catch (e) { lastErr = e; } // 主 adapter 失败 → 试下一个 fallback
      }
      if (!result) {
        return res.status(503).json({ ok: false, decision, error: `候选 adapter 都不可用（${chain.join('→')}）: ${lastErr?.message || ''}` });
      }
      return res.json({ ok: true, decision, executed: true, usedAdapter, fellBack: usedAdapter !== decision.adapterId, reply: result?.reply || '', tokensIn: result?.tokensIn || 0, tokensOut: result?.tokensOut || 0 });
    } catch (e) {
      return sendError(res, e);
    }
  });

  app.post('/api/noe/brain', requireOwnerToken, (req, res) => {
    try {
      const localId = (brainRouter ? brainRouter.route({ text: 'hi' })?.tierMap?.local : null) || 'lmstudio'; // owner 2026-06-17：兜底退 lmstudio 主脑，不再 abliterated
      const a = getAdapter ? getAdapter(localId) : null;
      return res.json({ ok: true, adapterId: localId, model: a?.model || null, displayName: a?.displayName || null });
    } catch (e) { return sendError(res, e); }
  });

  app.get('/api/noe/chat/routing', requireOwnerToken, (_req, res) => {
    try {
      const cloudOnly = foregroundChatRouting?.cloudOnly === true;
      const cloudAdapterChain = Array.isArray(foregroundChatRouting?.cloudAdapterChain) ? foregroundChatRouting.cloudAdapterChain : [];
      const localAdapterIds = Array.isArray(foregroundChatRouting?.localAdapterIds) ? foregroundChatRouting.localAdapterIds : ['lmstudio']; // owner 2026-06-17：去 abliterated 兜底，本地 chat 只剩 lmstudio 主脑
      const adapterStatus = (id) => {
        const adapter = getAdapter ? getAdapter(id) : null;
        return { id, available: Boolean(adapter), model: adapter?.model || null, displayName: adapter?.displayName || null };
      };
      const foregroundAdapters = cloudAdapterChain.map(adapterStatus);
      const localId = (brainRouter ? brainRouter.route({ text: 'hi' })?.tierMap?.local : null) || localAdapterIds[0] || 'lmstudio';
      return res.json({
        ok: true,
        foreground: {
          mode: cloudOnly ? 'cloud_only' : 'profile_or_router',
          cloudOnly,
          cloudAdapterChain,
          availableCloudAdapters: foregroundAdapters.filter((item) => item.available).map((item) => item.id),
          adapters: foregroundAdapters,
          localAdapterIds,
          localAdaptersExcluded: cloudOnly,
        },
        background: {
          unchanged: true,
          localAdapterId: localId,
          adapter: adapterStatus(localId),
        },
      });
    } catch (e) { return sendError(res, e); }
  });

  app.get('/api/noe/hwfit/recommend', requireOwnerToken, async (_req, res) => {
    try { return res.json({ ok: true, ...(await hwfitRecommend()) }); } catch (e) { return sendError(res, e); }
  });

  // 连续记忆脊椎（第四节）：env NOE_CONTINUITY=1 才注入时间线，对话经 VoiceSession 记进自传体经历流
  // （连真实 SQLite events 表，与 server.js 的反刍/注入实例共享同一 kind=noe_episode 数据）。
  // 构造提前到派活路由注册之前：内在世界（记录覆盖扩展）让 delegation confirm 复用同一实例。
  const voiceEpisodicTimeline = process.env.NOE_CONTINUITY === '1' ? new EpisodicTimeline() : null;

  registerNoeOwnerGateRoutes(app, { ownerGateStore, sendError }); registerNoeIdentityRoutes(app, { ownerIdentityStore, personStore, modelSettings, sendError }); registerNoePeopleRoutes(app, { personStore, modelSettings, sendError }); registerNoeComputerSearchRoutes(app, { webSearch, summarizeSearch: researchChat, sendError }); registerNoeLocalCouncilRoutes(app, { sendError }); registerNoeTaskflowRoutes(app, { sendError });
  registerNoeDoctorRoutes(app, { sendError }); registerNoeUiSignalRoutes(app, { sendError }); registerNoeAcuiCardRoutes(app, { sendError }); registerNoeFreedomRoutes(app, { sendError, getAdapter }); registerNoeMissionRoutes(app); registerNoeDoRoute(app, { getMcpClient, permissionGovernance, brainRouter, getAdapter, webSearch, researcher: deepResearcher, sendError }); registerNoeDelegationRoutes(app, { roomStore, getRoomAdapterPool, approvalStore, scheduleStore, agentRunStore, safeResolveFsPath, sendError, episodicTimeline: voiceEpisodicTimeline }); registerNoeChatProfileRoutes(app, { chatProfileStore, getAdapter, sendError }); registerNoeEmergencyStopRoutes(app, { sendError });

  const visionSession = new VisionSession({ memory, personStore, faceRecog: process.env.NOE_FACE_RECOG || 'ask' }); registerNoeVisionAttachmentRoute(app, { visionSession, sendError }); registerNoeVisionAmbientRoutes(app, { visionSession, modelSettings, sendError });
  // 本地屏幕活动编年史（Codex Chronicle 的全本地替代，2026-06-15）：env NOE_SCREEN_CHRONICLE=1 默认 OFF。
  // 开启则把 vision 切 screen 模式，定时截屏→本地 VLM 摘要→沉淀 EpisodicTimeline observation（全本地、不出本机、不存原始帧）。
  const screenChronicleTimeline = new EpisodicTimeline();
  const screenChronicle = createNoeScreenChronicle({
    observe: () => visionSession.glance({}),
    recordObservation: (summary, meta) => { try { screenChronicleTimeline.record({ type: 'observation', summary, salience: 0.3, meta }); } catch { /* 沉淀失败不阻断主流程 */ } },
    logger: (m) => { try { console.log(m); } catch { /* ignore */ } },
  });
  if (screenChronicle.enabled) { try { visionSession.setMode('screen', { source: 'screen_chronicle' }); } catch { /* setMode 失败不阻断 */ } }
  screenChronicle.start();

  // P1 媒体生成接线：三 client 共用 minimax key，image 先 resolve 一次，video/music 复用（resolver 无缓存，省两次 Keychain）。
  const mediaImageClient = new MiniMaxImageClient();
  registerNoeMediaRoutes(app, {
    studio: new NoeMediaStudio({
      imageClient: mediaImageClient,
      videoClient: new MiniMaxVideoClient(mediaImageClient.apiKey ? { apiKey: mediaImageClient.apiKey } : {}),
      musicClient: new MiniMaxMusicClient(mediaImageClient.apiKey ? { apiKey: mediaImageClient.apiKey } : {}),
    }),
    sendError,
  });

  // 卡① STT 实时化：NOE_STT=auto(默认)/sherpa/whisper。sherpa 模型就位即用本地流式（5s 音频 ~110ms，
  // 治 whisper 3-7s 断顿），whisper 作运行时兜底；模型未下则 null → VoiceSession 走默认 whisper，零影响。
  const noeSttClient = makeNoeSttClient({ whisper: new LocalSttClient(), log: (...a) => console.warn(...a) });
  if (noeSttClient) console.log('[noe-stt] 本地流式 STT(sherpa-onnx zipformer 中英) 已启用，whisper 兜底');
  else console.log('[noe-stt] 使用 whisper STT（sherpa 未就绪或 NOE_STT=whisper）');
  // whisper 兜底服务自启（默认 ON；NOE_WHISPER_AUTOSTART=0 可关）。
  // 此前仅 Electron 会拉起 8123，纯 npm start:noe 时 sherpa 失败会哑听。端口已被占则绑定失败退出，无害。
  {
    const whisperAutostartOff = ['0', 'false', 'off', 'no'].includes(String(process.env.NOE_WHISPER_AUTOSTART || '1').trim().toLowerCase());
    if (!whisperAutostartOff) {
      try {
        const whisperPy = process.env.NOE_WHISPER_PYTHON || join(homedir(), '.noe-voice', 'bin', 'python');
        const whisperScript = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/noe-whisper-server.py');
        const whisperPort = String(process.env.NOE_WHISPER_PORT || '8123').trim() || '8123';
        const whisperModel = process.env.NOE_WHISPER_MODEL || '';
        if (existsSync(whisperPy) && existsSync(whisperScript)) {
          const whisperLog = openSync('/tmp/noe-whisper.autostart.log', 'a');
          const args = [whisperScript, whisperPort];
          if (whisperModel) args.push(whisperModel);
          const child = spawn(whisperPy, args, { stdio: ['ignore', whisperLog, whisperLog] });
          child.on('error', () => { /* 起失败红灯会提醒 */ });
          child.unref?.();
          console.log(`[noe-voice-services] whisper STT 自启已发起（${whisperPort}，日志 /tmp/noe-whisper.autostart.log）`);
        } else {
          console.warn(`[noe-voice-services] whisper 自启跳过：缺 python 或脚本（py=${whisperPy} script=${whisperScript}）`);
        }
      } catch { /* 自启失败不影响主服务 */ }
    }
  }
  // 神经网络 VAD 精筛（接本地 silero 模型，借鉴 ricky0123/vad）：NOE_SILERO_VAD=1 启用，STT 前判真人声丢噪声段
  const noeSileroVad = makeSileroVad({});
  if (noeSileroVad) console.log('[noe-vad] 神经网络 VAD(silero) 精筛已启用：噪声段不再触发 STT/大脑/TTS');
  // 伴生服务自启（NOE_COSYVOICE_AUTOSTART=1）：CosyVoice 是中文 TTS 线上抖动/断网的兜底，
  // 手动起的进程重启即丢（LM Studio 脑死亡教训同款）→ 兜底常年是死的。spawn 随 server 生命周期；
  // 端口已被占（已有实例）时新进程自己绑定失败退出，无害；起失败不影响主服务（下方探活红灯仍提醒）。
  // 默认使用 CosyVoice-300M-SFT；仅显式 NOE_COSYVOICE_ENGINE=cosyvoice3-mlx 时切到 CosyVoice3 MLX。
  if (process.env.NOE_COSYVOICE_AUTOSTART === '1' && process.env.NOE_COSYVOICE !== '0') {
    try {
      const cosy3Model = process.env.NOE_COSYVOICE3_MLX_MODEL || join(homedir(), '.noe-voice', 'cosyvoice3-mlx', 'Fun-CosyVoice3-0.5B-2512-fp16');
      const cosy3Py = process.env.NOE_COSYVOICE3_MLX_PYTHON || join(homedir(), '.noe-voice', 'mlx-audio-plus', 'bin', 'python');
      const cosy3Script = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/noe-cosyvoice3-mlx-server.py');
      const wantCosy3 = process.env.NOE_COSYVOICE_ENGINE === 'cosyvoice3-mlx';
      const canUseCosy3 = wantCosy3 && existsSync(join(cosy3Model, 'model.safetensors')) && existsSync(cosy3Py) && existsSync(cosy3Script);
      const cosyPy = canUseCosy3 ? cosy3Py : homedir() + '/.noe-voice/cosyvoice/.venv/bin/python';
      const cosyScript = canUseCosy3 ? cosy3Script : pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/noe-cosyvoice-server.py');
      const args = canUseCosy3 ? [cosyScript, '8125', cosy3Model] : [cosyScript, '8125'];
      if (existsSync(cosyPy) && existsSync(cosyScript)) {
        const cosyLog = openSync('/tmp/noe-cosyvoice.autostart.log', 'a');
        const child = spawn(cosyPy, args, { stdio: ['ignore', cosyLog, cosyLog] });
        child.on('error', () => { /* 起失败红灯会提醒 */ });
        child.unref?.();
        console.log(`[noe-voice-services] ${canUseCosy3 ? 'CosyVoice3 MLX fp16' : 'CosyVoice'} 自启已发起（8125，模型加载约 30s，日志 /tmp/noe-cosyvoice.autostart.log）`);
      }
    } catch { /* 自启失败不影响主服务 */ }
  }
  // 志玲 VoiceDesign 本地档自启（NOE_QWEN_TTS=1）：Qwen3-TTS 1.7B-VoiceDesign + seed 锁定音色，MLX 快、有情感。
  // 取代 CosyVoice-300M-SFT 作本地中文 TTS 档；端口 8126，主 venv ~/.noe-voice/bin/python。
  if (process.env.NOE_QWEN_TTS === '1') {
    try {
      const qwenPy = process.env.NOE_QWEN_TTS_PYTHON || join(homedir(), '.noe-voice', 'bin', 'python');
      const qwenScript = pathResolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/noe-qwen-tts-server.py');
      if (existsSync(qwenPy) && existsSync(qwenScript)) {
        const qwenLog = openSync('/tmp/noe-qwen-tts.autostart.log', 'a');
        const child = spawn(qwenPy, [qwenScript, '8126'], { stdio: ['ignore', qwenLog, qwenLog] });
        child.on('error', () => { /* 起失败红灯会提醒 */ });
        child.unref?.();
        console.log('[noe-voice-services] Qwen 志玲 VoiceDesign TTS 自启已发起（8126，模型加载约 15s，日志 /tmp/noe-qwen-tts.autostart.log）');
      }
    } catch { /* 自启失败不影响主服务 */ }
  }
  // C11 伴生服务红灯：启动 3s 后异步探活（不阻塞、不自动 spawn），当前配置会用到却没起的服务打一行提醒
  setTimeout(async () => {
    try {
      const { checkVoiceCompanionServices } = await import('../../runtime/NoeDoctor.js');
      const f = await checkVoiceCompanionServices({});
      if (f.severity === 'warn') console.warn(`[noe-voice-services] ${f.message}\n  启动方法: ${f.fixHint}`);
    } catch { /* 探活失败不影响启动 */ }
  }, 3000).unref?.();
  // voiceEpisodicTimeline 构造已上移到派活路由注册之前（内在世界·记录覆盖扩展），此处直接复用。
  const delegationEnabled = !['0', 'false', 'off'].includes(String(process.env.NOE_DELEGATION || '1').trim().toLowerCase());
  const voiceSession = (brainRouter && getAdapter)
    ? new VoiceSession({ sttClient: noeSttClient || undefined, sileroVad: noeSileroVad, brainRouter, getAdapter, foregroundChatRouting, memory, memoryWriteGate, memoryRetriever, episodicTimeline: voiceEpisodicTimeline, visionSession, webSearch, searchSummarizer: researchChat, researcher: deepResearcher, chatProfileStore, ownerGate: ownerGateStore, identityStore: ownerIdentityStore, personStore, toolRegistry, commitmentStore, personCardStore, prefetchStore, factExtractor: process.env.NOE_FACT_EXTRACT === '0' ? null : new NoeMemoryExtractor({ getAdapter, adapterId: process.env.NOE_FACT_BRAIN || process.env.NOE_REFLECT_BRAIN || 'lmstudio' }), kokoroTts: process.env.NOE_KOKORO === '1' ? new KokoroTtsClient() : null, voiceGatewayTts: process.env.NOE_VOICE_GATEWAY === '1' ? new OpenAICompatibleVoiceGatewayClient() : null, cosyVoiceTts: process.env.NOE_QWEN_TTS === '1' ? new QwenVoiceDesignTtsClient() : (process.env.NOE_COSYVOICE === '0' ? null : new CosyVoiceTtsClient()), preferLocalChinese: process.env.NOE_QWEN_TTS === '1', innerStateProvider, personaPinProvider,
      // 对话委托桥（NOE_DELEGATION=1）：主人对话里的交办 → owner 目标 → 工作区真推进（research 真上网）
      ...(delegationEnabled && typeof getGoalSystem === 'function' ? {
        delegationHook: createDelegationHook({
          goalSystem: { add: (args) => { try { return getGoalSystem()?.add?.(args) ?? null; } catch { return null; } } },
          recordEpisode: (e) => { try { voiceEpisodicTimeline?.record(e); } catch { /* 留痕失败不阻断 */ } },
          returnReceipt: true,
          taskReportbacks,
        }),
      } : {}) })
    : null;
  if (voiceSession) console.log(`[noe-voice] 对话委托桥${delegationEnabled && typeof getGoalSystem === 'function' ? '已启用' : '未启用'}（NOE_DELEGATION 默认开启，0/false/off 才关闭）`);
  // T34 Telegram 入站试点（波次2/6 接线）：配 TELEGRAM_BOT_TOKEN 才通电，默认零影响。
  // 链路 = 长轮询 → mention-gating(TELEGRAM_ALLOW_FROM 白名单) → 防连击栅栏 → voiceSession.chatText(同款大脑/记忆) → 回 Telegram。
  if (process.env.TELEGRAM_BOT_TOKEN && voiceSession) {
    try {
      const tg = createTelegramInbound({
        token: process.env.TELEGRAM_BOT_TOKEN,
        botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
        allowFrom: (process.env.TELEGRAM_ALLOW_FROM || '').split(',').map((s) => s.trim()).filter(Boolean),
        chatBrain: (text, opts) => voiceSession.chatText(text, opts),
        log: (...a) => console.warn('[noe-telegram]', ...a),
      });
      tg.start();
      console.log('[noe-telegram] Telegram 入站已启动（长轮询 + mention-gating + 防连击栅栏）');
    } catch (e) { console.warn('[noe-telegram] 启动失败(不影响其他功能):', e?.message); }
  }
  app.post('/api/noe/voice/chat', requireOwnerToken, async (req, res) => {
    try {
      if (!voiceSession) return res.status(501).json({ ok: false, error: 'voice session not configured（缺 brainRouter/adapter）' });
      const body = req.body || {};
      // 文字分支：{text} 且无音频 → 跳过 STT，纯文本对话（默认不出声省配额；voice:true 才合成语音）
      if (body.text && !body.audio && !body.wav) {
        if (typeof body.text !== 'string' || body.text.length > 4000) return res.status(400).json({ ok: false, error: 'text 非法或过长' });
        const result = await voiceSession.chatText(body.text, { tts: body.tts, noTts: body.voice !== true, profileId: body.profileId || body.profile, faceEmbedding: body.faceEmbedding, faceEmbeddingEngine: body.faceEmbeddingEngine });
        return res.json(result);
      }
      const wavB64 = body.audio || body.wav;
      if (!wavB64) return res.status(400).json({ ok: false, error: 'audio (base64 wav) required' });
      if (typeof wavB64 !== 'string' || wavB64.length > 15_000_000) return res.status(413).json({ ok: false, error: 'audio 过大（base64 ≤ 15MB）' });
      const result = await voiceSession.chat(Buffer.from(wavB64, 'base64'), { tts: body.tts, profileId: body.profileId || body.profile, faceEmbedding: body.faceEmbedding, faceEmbeddingEngine: body.faceEmbeddingEngine });
      return res.json(result);
    } catch (e) { return sendError(res, e); }
  });

  // C9 流式语音续播：纯文本转语音（chat 响应只带首句音频+restTtsText，前端拿剩余文本来这合成续播）。
  // 也可独立作通用 TTS 端点。走 VoiceSession 同一回退链（主选→MiniMax→CosyVoice 中文兜底）。
  app.post('/api/noe/voice/tts', requireOwnerToken, async (req, res) => {
    try {
      if (!voiceSession) return res.status(501).json({ ok: false, error: 'voice session not configured（缺 brainRouter/adapter）' });
      const body = req.body || {};
      if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 4000) {
        return res.status(400).json({ ok: false, error: 'text 必填且 ≤4000 字' });
      }
      const r = await voiceSession.synthesizeText(body.text, body.tts || {});
      if (!r.audioBase64) return res.status(502).json({ ok: false, error: r.ttsErr?.message || 'TTS 失败' });
      return res.json({ ok: true, audioBase64: r.audioBase64, audioFormat: r.audioFormat });
    } catch (e) { return sendError(res, e); }
  });

  // 卡① 唤醒词检测（sherpa KWS "嘿 Noe"）：连续监听场景先打这里，spotted=true 才走完整对话链（省大脑/TTS 开销）。
  const sherpaForWakeword = noeSttClient ? (noeSttClient.sherpa || (typeof noeSttClient.detectWakeword === 'function' ? noeSttClient : null)) : null;
  app.post('/api/noe/voice/wakeword', requireOwnerToken, async (req, res) => {
    try {
      if (!sherpaForWakeword?.kwsReady?.()) return res.status(501).json({ ok: false, error: '唤醒词模型未就位（sherpa KWS）' });
      const wavB64 = (req.body || {}).audio || (req.body || {}).wav;
      if (!wavB64 || typeof wavB64 !== 'string' || wavB64.length > 4_000_000) return res.status(400).json({ ok: false, error: 'audio (base64 wav, ≤4MB) required' });
      const result = await sherpaForWakeword.detectWakeword(Buffer.from(wavB64, 'base64'));
      return res.json({ ok: true, ...result });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/vision/glance', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await visionSession.glance({ prompt: body.prompt, force: body.force });
      return res.json({ ok: true, ...result });
    } catch (e) { return sendError(res, e); }
  });
  app.get('/api/noe/vision/latest', requireOwnerToken, (req, res) => {
    return res.json({ ok: true, latest: visionSession.latest() });
  });
  // 卡③ 屏幕读字：不带 image 现截屏 OCR；带 image(base64) 读指定图。逐行精确文字（VLM 语义之外的硬读字）。
  app.post('/api/noe/vision/ocr', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      if (body.image && (typeof body.image !== 'string' || body.image.length > 30_000_000)) {
        return res.status(400).json({ ok: false, error: 'image 非法或过大（base64 ≤ 30MB）' });
      }
      const result = await visionSession.ocr({ image: body.image || undefined });
      return res.json(result);
    } catch (e) { return sendError(res, e); }
  });
  app.post('/api/noe/vision/mode', requireOwnerToken, (req, res) => {
    const m = visionSession.setMode((req.body || {}).mode);
    modelSettings.setFaceEnabled?.(m !== 'off');
    return res.json({ ok: true, mode: m });
  });
  app.post('/api/noe/vision/frame', requireOwnerToken, (req, res) => {
    try {
      const body = req.body || {};
      if (!body.frame || typeof body.frame !== 'string') return res.status(400).json({ ok: false, error: 'missing frame' });
      if (body.frame.length > 3_000_000) return res.status(413).json({ ok: false, error: 'frame too large' }); // 防 DoS：单帧 base64 上限 ~3MB
      visionSession.pushFrame(Buffer.from(body.frame, 'base64'), body.format === 'png' ? 'png' : 'jpeg');
      return res.json({ ok: true });
    } catch (e) { return sendError(res, e); }
  });
  // "这是谁"：摄像头帧 → InsightFace 提脸 → identifyFace 1:N 搜 → 命中报人物信息 / 没命中引导录入。
  app.post('/api/noe/vision/identify', requireOwnerToken, async (req, res) => {
    try {
      // 用户在面板关了人脸模型就不跑 InsightFace（与 /people/face-embedding 的 409 口径一致）
      if (modelSettings.faceEnabled?.() === false) return res.status(409).json({ ok: false, error: '人脸模型已关闭' });
      const body = req.body || {};
      if (typeof body.frame === 'string' && body.frame.length) {
        if (body.frame.length > 3_000_000) return res.status(413).json({ ok: false, error: 'frame too large' });
        visionSession.pushFrame(Buffer.from(body.frame, 'base64'), body.format === 'png' ? 'png' : 'jpeg');
      }
      const result = await visionSession.recognizeWho({ threshold: Number(body.threshold) || undefined });
      return res.json({ ok: result.ok !== false, result });
    } catch (e) { return sendError(res, e); }
  });
  // 认人模式开关（可选功能）：off 不认 / ask 问"这是谁"才认 / auto glance 时自动认。
  app.post('/api/noe/vision/face-recog', requireOwnerToken, (req, res) => {
    const mode = visionSession.setFaceRecog((req.body || {}).mode);
    return res.json({ ok: true, faceRecog: mode });
  });

  // BaiLongma 式克制：默认沉默 + 冷却；force=true 仅用于手动/调试。
  // 时间节律（支柱⑦，NOE_CIRCADIAN=1 默认 OFF）：注入夜深判定 → 静默时段不开口、到期提醒不消费顺延到出静后；OFF 时 null 零影响。
  // 持久状态（意识方案 §3.4，NOE_HEARTBEAT=1 才注入）：冷却/见过谁存 kv 表，跨重启不归零；OFF 时纯内存与原版逐字一致。
  const proactiveStateStore = process.env.NOE_HEARTBEAT === '1'
    ? {
        get: () => { try { return kvGet('noe.proactive.state'); } catch { return null; } },
        set: (s) => { try { kvSet('noe.proactive.state', s); } catch { /* 持久化失败不影响主动陪伴 */ } },
      }
    : null;
  const proactiveTick = getAdapter
    ? createProactiveTickHandler({ visionSession, ttsClient: new MiniMaxTtsClient(), getAdapter, memory, commitmentStore, driveBrief, feelingBrief, onCommitmentDelivery, brainAdapterId: process.env.NOE_PROACTIVE_BRAIN || resolveHeavyReflectBrain().adapterId, cooldownMs: Number(process.env.NOE_PROACTIVE_COOLDOWN_MS) || (30 * 60 * 1000), isQuiet: process.env.NOE_CIRCADIAN === '1' ? circadianIsQuiet : null, ...(proactiveStateStore ? { stateStore: proactiveStateStore } : {}),
      // 内在素材（NOE_PROACTIVE_INNER=1）：刚完成的目标（含主人对话委托）→ 开口回报。乐观标记防重复念叨；
      // 即便这轮没开口，结果在透视页目标卡仍可见，丢一次口头回报代价低。
      ...(process.env.NOE_PROACTIVE_INNER === '1' ? {
        innerBrief: () => {
          try {
            const gs = typeof getGoalSystem === 'function' ? getGoalSystem() : null;
            if (!gs?.list) return null;
            const done = gs.list({ status: 'done', limit: 50 }) || []; // 多模型审 P1-2：limit 放大到 50——过滤 selfops 后仍能选到 rank 6+ 的 owner 交办/真陪伴（实测 89% 是 selfops，limit:5 过滤后常空、漏 owner）
            const last = kvGet('noe.proactive.lastReportedGoalId');
            // #16 子改动2：过滤 system_repair/self_learning 完成（flag NOE_PROACTIVE_FILTER_SELFOPS 默认 OFF），停把自修复/自学习完成当陪伴素材自我表扬刷量；保留 owner 交办/真陪伴源。
            const fresh = selectFreshReportableGoal(done, { lastReportedId: last, filterSelfops: process.env.NOE_PROACTIVE_FILTER_SELFOPS === '1' });
            if (!fresh) return null;
            kvSet('noe.proactive.lastReportedGoalId', fresh.id);
            const note = (fresh.plan || []).map((s) => s.note).filter(Boolean).join('；').replace(/\s+/g, ' ').slice(0, 160);
            return `你刚完成了${fresh.source === 'owner' ? '主人交办的' : '自己立的'}「${String(fresh.title).slice(0, 50)}」${note ? `，要点：${note}` : ''}`;
          } catch { return null; }
        },
      } : {}) })
    : null;
  // 服务端可调的主动 tick（心跳 NOE_HEARTBEAT 收编出口；与 HTTP 端点同一条路径——先看一眼再判断开不开口）
  async function runProactiveTick({ force = false } = {}) {
    if (!proactiveTick) return { ok: false, error: 'proactive not configured（缺 adapter）' };
    const visionProbe = visionSession.ambientTick
      ? await visionSession.ambientTick({ force })
      : await visionSession.glance({ force }).then((result) => ({ sampled: true, result })).catch((e) => ({ sampled: false, skipped: 'ambient_error', error: e?.message || String(e) }));
    const result = await proactiveTick({ force });
    return { ok: true, visionProbe, ...result };
  }
  app.post('/api/noe/proactive/tick', requireOwnerToken, async (req, res) => {
    try {
      const r = await runProactiveTick({ force: (req.body || {}).force === true });
      if (r.ok === false) return res.status(501).json(r);
      return res.json(r);
    } catch (e) { return sendError(res, e); }
  });

  app.get('/api/noe/p6/rumination/status', requireOwnerToken, (_req, res) => {
    try {
      if (!selfTalkEvidence?.summary) return res.status(501).json({ ok: false, error: 'self-talk evidence not configured' });
      return res.json({
        ok: true,
        mode: process.env.NOE_INNER_MODE || 'audit',
        auditFile: selfTalkEvidence.auditFile || null,
        summary: selfTalkEvidence.summary(),
        dbSummary: selfTalkEvidence.dbSummary?.() || null,
      });
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/p6/self-talk/delivery-ack', requireOwnerToken, (req, res) => {
    try {
      if (!selfTalkEvidence?.recordDeliveryAck) return res.status(501).json({ ok: false, error: 'self-talk evidence not configured' });
      const result = selfTalkEvidence.recordDeliveryAck(req.body || {});
      return res.json({
        ok: true,
        proposalId: result.ack.proposalId,
        status: result.ack.status,
        confirmationSource: result.ack.confirmationSource,
        summary: selfTalkEvidence.summary(),
      });
    } catch (e) { return sendError(res, e); }
  });

  app.get('/api/noe/health', requireOwnerToken, (req, res) => {
    try {
      const projectId = req.query.project || req.query.projectId;
      const memoryStats = memory.stats({ projectId });
      const focusDepth = focus.depth({ projectId });
      const tools = toolRegistry.list();
      const pendingApprovals = approvalStore?.listApprovals?.({ status: 'pending', limit: 50 }) || [];
      res.json({
        ok: true,
        loop: loop.status(),
        memory: memoryStats,
        focus: { depth: focusDepth },
        tools: {
          total: tools.length,
          enabled: tools.filter((tool) => tool.enabled).length,
          disabled: tools.filter((tool) => !tool.enabled).length,
        },
        approvals: { pending: pendingApprovals.length },
        acts: actStore?.summary?.({ projectId: projectId || 'noe' }) || { byStatus: {}, pending: 0, current: null },
        fileIndex: fileIndex.stats(),
        health: { status: 'ok' },
      });
    } catch (e) { sendError(res, e); }
  });

  app.get('/api/noe/readiness', (req, res) => {
    try {
      const projectId = req.query.project || req.query.projectId;
      res.json(buildReadiness(projectId));
    } catch (e) { sendError(res, e); }
  });

  // 心跳收编出口（意识方案 §3.4，NOE_HEARTBEAT）：server 侧持久心跳直接驱动主动 tick，
  // 主动性不再依赖前端轮询才"活着"；HTTP 端点与心跳走同一条 runProactiveTick 路径。
  return {
    runProactiveTick,
    // 工作区感知窥视（意识方案 §6 P3）：只读 latest 视觉摘要，不触发新截屏
    peekVision: () => { try { return visionSession?.latest?.() || null; } catch { return null; } },
    // 目标研究执行器（长期规划 M6 的"手"）：research 步走深度研究——BrainRouter 默认压本地，
    // 节制轮数（3 轮）防长跑；失败返回空报告不抛（调用方 fail-open）。
    runResearch: async (question) => {
      try { return await deepResearcher.research(String(question || '').slice(0, 200), { maxRounds: 3, perQuery: 4, fetchTop: 4 }); }
      catch (e) { return { question, report: '', rounds: 0, sources: [], error: e?.message }; }
    },
  };
}
