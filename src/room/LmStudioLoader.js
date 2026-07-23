// LmStudioLoader — LM Studio 模型自助加载层。
// 解决根因:Noe 把"目标模型已在 LM Studio 内存里"当成前提，但这个前提会被
//   ① Noe 自己的视觉功能(LocalVlmClient 会 load/unload 模型，挤掉大脑模型)
//   ② 用户在 LM Studio 端换/卸模型
// 打破，导致对未加载模型发 chat 请求 → 400「Model has not started loading / unloaded」。
// 这里让 Noe "选哪个 LM Studio 模型，就先把它加载成大脑"，与视觉模块的 lms unload 对称。
//
// 只读状态走 LM Studio REST(/api/v0/models 带 state)；加载走 lms CLI(REST 无 load 端点)。
// 加载是模型操作，遵循 feedback_no_model_timeout：不对 lms load 设超时；仅状态探测给短超时。

import { spawn } from 'node:child_process';
import {
  NOE_MAIN_BRAIN_MODEL,
  isMainBrainModel,
  isNoeBrainModelAlias,
  normalizeNoeAutoModel,
  resolveNoeBrainByModel,
  resolveNoeModelLoadPlan,
} from '../model/NoeLocalModelPolicy.js';

// baseUrl 形如 http://127.0.0.1:1234/v1 → REST origin http://127.0.0.1:1234
function toOrigin(baseUrl = '') {
  return String(baseUrl).replace(/\/v1\/?$/, '').replace(/\/+$/, '') || 'http://127.0.0.1:1234';
}

// 查 LM Studio 当前"已加载"的模型 id 列表；查不到返回 null(让调用方保守地直接尝试加载)。
export async function listLoadedLmStudioModels(baseUrl, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const origin = toOrigin(baseUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${origin}/api/v0/models`, { signal: ctrl.signal, headers: { Authorization: 'Bearer lm-studio' } });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data?.data || []).filter((m) => m?.state === 'loaded').map((m) => m.id);
  } catch {
    return null; // REST 不可用/超时 → 交给 lms load 幂等兜底
  } finally {
    clearTimeout(t);
  }
}

// LM Studio 当前已加载的、可聊天的模型 id（排除 embeddings）。
// 仅用于诊断/显式工具；自动聊天入口不应默认跟随当前 loaded 模型，避免漂到手动实验模型。
export async function currentLoadedChatModel(baseUrl, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const origin = toOrigin(baseUrl);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(`${origin}/api/v0/models`, { signal: ctrl.signal, headers: { Authorization: 'Bearer lm-studio' } });
    if (!resp.ok) return null;
    const data = await resp.json();
    const loaded = (data?.data || []).filter((m) => m?.state === 'loaded' && m?.type !== 'embeddings');
    return loaded[0]?.id || null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function defaultLoadParamsFor(model) {
  const id = normalizeNoeAutoModel(model, { allowEmpty: true });
  const plan = resolveNoeModelLoadPlan(id);
  if (plan.role) {
    return {
      loadModel: plan.loadModel,
      fallbackLoadModels: plan.fallbackLoadModels || [],
      identifier: plan.identifier,
      contextLength: plan.contextLength,
      parallel: plan.parallel,
      ttlSeconds: plan.ttlSeconds,
    };
  }
  if (/qwen3\.6-35b|qwen\/qwen3\.6-35b/i.test(id)) return { contextLength: 262144, parallel: 2 };
  if (/gemma-4-26b/i.test(id)) return { contextLength: 262144, parallel: 4 };
  return {};
}

function lmsLoad(model, { ttlSeconds, contextLength, parallel, identifier, spawnImpl = spawn } = {}) {
  const targetModel = normalizeNoeAutoModel(model, { allowEmpty: true });
  const defaults = defaultLoadParamsFor(targetModel);
  const loadModels = [String(defaults.loadModel || targetModel), ...(defaults.fallbackLoadModels || [])].filter(Boolean);
  const context = positiveInt(contextLength) || positiveInt(defaults.contextLength);
  const parallelCount = positiveInt(parallel) || positiveInt(defaults.parallel);
  const loadIdentifier = identifier || defaults.identifier;
  const ttl = Number(ttlSeconds) > 0 ? Number(ttlSeconds) : Number(defaults.ttlSeconds);
  const buildArgs = (loadModel) => {
    const args = ['load', loadModel, '-y'];
    if (context) args.push('--context-length', String(context));
    if (parallelCount) args.push('--parallel', String(parallelCount));
    if (ttl > 0) args.push('--ttl', String(Math.floor(ttl)));
    if (loadIdentifier) args.push('--identifier', String(loadIdentifier));
    return args;
  };
  const tryBin = (bin, args) => new Promise((resolve) => {
    try {
      const p = spawnImpl(bin, args, { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('exit', (code) => resolve(code === 0));
    } catch { resolve(false); }
  });
  // 与 LocalVlmClient.unload 同款双路径探测:PATH 找不到 lms 则退 ~/.lmstudio/bin/lms
  return (async () => {
    for (const loadModel of loadModels) {
      const args = buildArgs(loadModel);
      const ok = await tryBin('lms', args) || await tryBin(`${process.env.HOME || ''}/.lmstudio/bin/lms`, args);
      if (ok) return true;
    }
    return false;
  })();
}

const inflight = new Map(); // 同一 model 并发只加载一次

// 确保目标 model 在 LM Studio 已加载。已加载→直接返回；未加载→lms load。
// 返回 { ok, already?, loaded?, error? }；失败不抛(由调用方决定是否继续/回退)。
export async function ensureLmStudioModel(model, {
  baseUrl = 'http://127.0.0.1:1234/v1',
  ttlSeconds,
  contextLength,
  parallel,
  identifier,
  fetchImpl,
  spawnImpl,
} = {}) {
  const targetModel = normalizeNoeAutoModel(model, { allowEmpty: true });
  if (!targetModel) return { ok: true, already: true };
  const loaded = await listLoadedLmStudioModels(baseUrl, fetchImpl ? { fetchImpl } : {});
  const targetBrain = resolveNoeBrainByModel(targetModel);
  if (loaded && (
    loaded.includes(targetModel)
    || (isMainBrainModel(targetModel) && loaded.includes(NOE_MAIN_BRAIN_MODEL))
    || (targetBrain && loaded.some((loadedId) => isNoeBrainModelAlias(loadedId, targetBrain)))
  )) {
    return { ok: true, already: true };
  }
  if (inflight.has(targetModel)) return inflight.get(targetModel);
  const p = (async () => {
    const ok = await lmsLoad(targetModel, { ttlSeconds, contextLength, parallel, identifier, spawnImpl });
    return ok ? { ok: true, loaded: true } : { ok: false, error: `lms load ${targetModel} 失败(LM Studio 未装 lms CLI / 模型 key 不存在 / 内存不足)` };
  })().finally(() => inflight.delete(targetModel));
  inflight.set(targetModel, p);
  return p;
}
