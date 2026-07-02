// @ts-check
// 第三波手术 第32批：房间 adapter 工厂（detectCCR/buildRoomAdapters/applyRoomAdaptersConfig/
// rebuildRoomAdapters，~146 行）从 server.js 原文迁出。
// 注入约定：
//   - claudeBin：server.js 启动期 resolve 的 claude 绝对路径（const，传值）。
//   - getWatcherConfig：watcherConfig 是 server.js 的 let（watcher 路由 setter 可改写），
//     必须 getter 注入按调用时求值（先例：registerWatcherRoutes 同款）。
// roomAdaptersConfig 的属主随迁进本工厂闭包，server.js 不再持有该 let；
// 路由层读写走返回的 getRoomAdaptersConfig/setRoomAdaptersConfig。
import { spawnSync } from 'node:child_process';
import { ClaudeSpawnAdapter } from '../../room/ClaudeSpawnAdapter.js';
import { CodexSpawnAdapter } from '../../room/CodexSpawnAdapter.js';
import { OllamaChatAdapter } from '../../room/OllamaChatAdapter.js';
import { GeminiSpawnAdapter, isGeminiCliAvailable } from '../../room/GeminiSpawnAdapter.js';
import { GeminiChatAdapter } from '../../room/GeminiChatAdapter.js';
import { OpenAICompatChatAdapter } from '../../room/OpenAICompatChatAdapter.js';
import { LmStudioChatAdapter } from '../../room/LmStudioChatAdapter.js';
import { MiniMaxChatAdapter } from '../../room/MiniMaxChatAdapter.js';
import { MiniMaxSpawnAdapter } from '../../room/MiniMaxSpawnAdapter.js';
import { CCRSpawnAdapter } from '../../room/CCRSpawnAdapter.js';
import { loadRoomAdaptersConfig } from '../../room/RoomAdaptersConfig.js';
import { NOE_MAIN_BRAIN, NOE_MAIN_BRAIN_MODEL } from '../../model/NoeLocalModelPolicy.js';

// v0.47 阶段 2：检测 ccr (claude-code-router) 是否在 PATH（不强制依赖）
export function detectCCR() {
  try {
    const r = spawnSync('which', ['ccr'], { encoding: 'utf-8' });
    return r.status === 0 && (r.stdout || '').trim().length > 0;
  } catch { return false; }
}

/**
 * 房间 adapter 池工厂：构建内置池 + 按 room-adapters.json 注册可变条目 + 原地重建。
 * @param {{ claudeBin: string, getWatcherConfig: () => any }} deps
 */
export function createRoomAdapterFactory({ claudeBin, getWatcherConfig }) {
  const HAS_CCR = detectCCR();
  if (HAS_CCR) console.log('✅ 检测到 claude-code-router (ccr)，已加入 adapter 池');

  // v0.52 房间 adapter 独立配置（minimax / gemini / 自定义）
  let roomAdaptersConfig = loadRoomAdaptersConfig();
  // 启动期探测 gemini CLI 是否可用（避免每次 spawn 都 which 一次）
  const HAS_GEMINI_CLI = isGeminiCliAvailable();

  // 内置 adapter 池（按 id 拿）
  function buildRoomAdapters() {
    const map = new Map();
    // v0.52 内置 adapter 接受 spawn_overrides.timeoutMs（0=用 adapter 默认 2h）
    const ov = roomAdaptersConfig?.spawn_overrides || {};
    const tm = (v) => (Number.isFinite(v) && v > 0) ? v : undefined;
    map.set('claude', new ClaudeSpawnAdapter({ bin: claudeBin, timeout: tm(ov.claudeTimeoutMs) }));
    map.set('codex', new CodexSpawnAdapter({ timeout: tm(ov.codexTimeoutMs) }));
    map.set('ollama', new OllamaChatAdapter({ id: 'ollama', displayName: '🔵 Ollama' }));
    // 主动判断专用：qwen3.5 去审查 9b（判断力强于语音用的 4b，主动 tick 异步不怕略慢）。可经 NOE_OLLAMA_9B_MODEL 覆盖回滚。
    map.set('ollama-9b', new OllamaChatAdapter({ id: 'ollama-9b', displayName: '🔵 Ollama Qwen3.5-9B 去审查', model: process.env.NOE_OLLAMA_9B_MODEL || 'huihui_ai/qwen3.5-abliterated:9b' }));
    // LM Studio 本地大脑（OpenAI 兼容，127.0.0.1:1234）；默认跟随 Noe 主脑，可经 NOE_LMSTUDIO_MODEL 覆盖。
    // 用 LmStudioChatAdapter：调用前自助 ensureLoaded(选哪个模型就先把它 load 进 LM Studio)，
    // 根治"目标模型没加载/被视觉功能挤掉 → 400 未加载"。NOE_LMSTUDIO_TTL 可设空闲自动卸载省内存。
    map.set('lmstudio', new LmStudioChatAdapter({
      id: 'lmstudio',
      displayName: '🟢 LM Studio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: 'lm-studio',
      model: process.env.NOE_LMSTUDIO_MODEL || NOE_MAIN_BRAIN_MODEL,
      maxTokens: Number(process.env.NOE_LMSTUDIO_MAX_TOKENS) || NOE_MAIN_BRAIN.generation.max_tokens,
      loadTtlSeconds: Number(process.env.NOE_LMSTUDIO_TTL) || undefined,
      loadContextLength: Number(process.env.NOE_LMSTUDIO_CONTEXT_LENGTH) || undefined,
      loadParallel: Number(process.env.NOE_LMSTUDIO_PARALLEL) || undefined,
    }));
    // LiteLLM proxy（可选）：起 litellm proxy 后配 NOE_LITELLM_URL，即可统一调 100+ provider + 自动 fallback + 成本追踪。
    // LiteLLM 本身是 OpenAI 兼容 endpoint，故复用 OpenAICompatChatAdapter（已被 lmstudio 验证），零新依赖。BrainRouter 可路由到它或 room 直选。
    if (process.env.NOE_LITELLM_URL) {
      map.set('litellm', new OpenAICompatChatAdapter({ id: 'litellm', displayName: '🚀 LiteLLM', baseUrl: process.env.NOE_LITELLM_URL, apiKey: process.env.NOE_LITELLM_KEY || 'litellm', model: process.env.NOE_LITELLM_MODEL || 'gpt-4o-mini' }));
    }
    map.set('minimax-spawn', new MiniMaxSpawnAdapter({ timeout: tm(ov.minimaxSpawnTimeoutMs) }));
    // v0.47 CCR 可选：仅当 `which ccr` 命中才注册
    if (HAS_CCR) {
      map.set('ccr', new CCRSpawnAdapter({ timeout: tm(ov.ccrTimeoutMs) }));
    }
    applyRoomAdaptersConfig(map);
    // MiniMax 大脑兜底：room-adapters.json 未配但 .env 有 MINIMAX_API_KEY 时，用 env key 注册（让 mid 档可用）
    if (!map.has('minimax') && process.env.MINIMAX_API_KEY) {
      map.set('minimax', new MiniMaxChatAdapter({ apiKey: process.env.MINIMAX_API_KEY, baseUrl: process.env.MINIMAX_BASE_URL }));
    }
    // 前台闲聊 highspeed 档（owner 2026-06-17：前台闲聊从本地 abliterated 改 MiniMax-M2.7-highspeed，秒回·已订阅不额外烧）。
    //   复用 minimax 同源 key/baseUrl，只换模型；BrainRouter 的 local 档指向它。
    const mmKey = process.env.MINIMAX_API_KEY || map.get('minimax')?.apiKey;
    if (!map.has('minimax-highspeed') && mmKey) {
      map.set('minimax-highspeed', new MiniMaxChatAdapter({ id: 'minimax-highspeed', displayName: '🟡 MiniMax 2.7 highspeed', apiKey: mmKey, baseUrl: process.env.MINIMAX_BASE_URL || map.get('minimax')?.baseUrl, model: 'MiniMax-M2.7-highspeed' }));
    }
    return map;
  }

  /**
   * v0.52 按 room-adapters.json 注册 minimax / gemini / gemini-openai / gemini-cli / custom:*
   * 每个 adapter 支持 timeoutMs 覆盖（0=用 adapter 默认；>0 覆盖）
   * 同时兼容老配置：若 minimax 在 room-adapters.json 未启用但 watcher 配了 minimax key，仍回退注册
   */
  function applyRoomAdaptersConfig(map) {
    // 先清理可变的 id（保留 4 个内置）
    for (const id of [...map.keys()]) {
      if (id === 'claude' || id === 'codex' || id === 'ollama' || id === 'ollama-9b' || id === 'lmstudio' || id === 'ccr' || id === 'minimax-spawn') continue;
      map.delete(id);
    }

    const tm = (v) => (Number.isFinite(v) && v > 0) ? v : undefined;
    // v0.52 maxTokens：用户填 0 时不传给 adapter，让 adapter 用自己默认；填正数则覆盖
    const mt = (v) => (Number.isFinite(v) && v >= 0) ? v : undefined;

    // MiniMax：优先用 room-adapters.json，回退 watcher
    const watcherConfig = getWatcherConfig();
    const mm = roomAdaptersConfig.minimax;
    if (mm?.enabled && mm.apiKey) {
      map.set('minimax', new MiniMaxChatAdapter({
        apiKey: mm.apiKey,
        model: mm.model || undefined,
        baseUrl: mm.baseUrl || undefined,
        timeout: tm(mm.timeoutMs),
        maxTokens: mt(mm.maxTokens),
      }));
    } else if (watcherConfig?.apiKey && watcherConfig.provider === 'minimax') {
      map.set('minimax', new MiniMaxChatAdapter({
        apiKey: watcherConfig.apiKey,
        model: watcherConfig.model || undefined,
        baseUrl: watcherConfig.baseUrl,
      }));
    }

    // Gemini 原生 API
    const g = roomAdaptersConfig.gemini;
    if (g?.enabled && g.apiKey) {
      map.set('gemini', new GeminiChatAdapter({
        apiKey: g.apiKey,
        model: g.model || undefined,
        baseUrl: g.baseUrl || undefined,
        timeout: tm(g.timeoutMs),
        maxTokens: mt(g.maxTokens),
      }));
    }

    // Gemini OpenAI 兼容
    const go = roomAdaptersConfig.gemini_openai;
    if (go?.enabled && go.apiKey && go.baseUrl) {
      map.set('gemini-openai', new OpenAICompatChatAdapter({
        id: 'gemini-openai',
        displayName: '🔷 Gemini (OpenAI 兼容)',
        apiKey: go.apiKey,
        baseUrl: go.baseUrl,
        model: go.model || undefined,
        timeout: tm(go.timeoutMs),
        maxTokens: mt(go.maxTokens),
      }));
    }

    // Gemini CLI（仅 which gemini 命中且配置 enabled 才注册）
    const gc = roomAdaptersConfig.gemini_cli;
    if (gc?.enabled && HAS_GEMINI_CLI) {
      map.set('gemini-cli', new GeminiSpawnAdapter({ model: gc.model || undefined, timeout: tm(gc.timeoutMs) }));
    }

    // 自定义 OpenAI 兼容条目（id 形如 custom:xxx）
    for (const c of (roomAdaptersConfig.customs || [])) {
      if (!c || c.enabled === false) continue;
      if (!c.id || !c.baseUrl || !c.apiKey || !c.model) continue;
      const fullId = `custom:${c.id}`;
      map.set(fullId, new OpenAICompatChatAdapter({
        id: fullId,
        displayName: c.displayName || `🧩 ${c.id}`,
        apiKey: c.apiKey,
        baseUrl: c.baseUrl,
        model: c.model,
        timeout: tm(c.timeoutMs),
        maxTokens: mt(c.maxTokens),
      }));
    }
  }

  const roomAdapterPool = buildRoomAdapters();

  /** v0.52 PUT /api/room-adapters 后原地重建 adapter 池（dispatcher 持有的 Map 引用不变） */
  function rebuildRoomAdapters() {
    applyRoomAdaptersConfig(roomAdapterPool);
  }

  return {
    roomAdapterPool,
    rebuildRoomAdapters,
    getRoomAdaptersConfig: () => roomAdaptersConfig,
    setRoomAdaptersConfig: (next) => { roomAdaptersConfig = next; },
    hasCCR: HAS_CCR,
    hasGeminiCli: HAS_GEMINI_CLI,
  };
}
