import { spawnSync } from 'node:child_process';
import {
  describeNoeProviderSecretFailure,
  resolveNoeProviderSecret,
} from '../secrets/NoeProviderSecrets.js';

const MINIMAX_MODEL = 'MiniMax-M3';
const MINIMAX_MODELS = ['MiniMax-M3', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.7'];
const DEFAULT_CODEX_MODELS = ['', 'gpt-5', 'gpt-5-codex'];
const DEFAULT_CLAUDE_MODELS = ['', 'opus', 'sonnet'];

function splitEnv(value, fallback) {
  const items = String(value || '').split(/[,\n，、]/).map((s) => s.trim()).filter(Boolean);
  return items.length ? ['', ...items] : fallback;
}

function uniqModels(items = []) {
  const seen = new Set();
  return items.map((id) => String(id || '').trim()).filter((id) => {
    const key = id || '__default__';
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((id) => ({ id, label: id || '账号默认模型', available: true }));
}

function disabledModels(env = process.env) {
  return new Set(String(env.NOE_DISABLED_CHAT_MODELS || '').split(/[,\n，、]/).map((s) => s.trim()).filter(Boolean));
}

function looksChatCapableModel(id, capabilities = null) {
  const name = String(id || '').trim();
  if (!name || /(^|[-_:/@])(?:text-)?(?:embed|embedding)(?:[-_:/@]|$)/i.test(name)) return false;
  return Array.isArray(capabilities) && capabilities.length ? capabilities.includes('completion') : true;
}

async function fetchJson(url, { headers = {}, timeoutMs = 1600 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { headers, signal: controller.signal });
    const text = await resp.text().catch(() => '');
    let json = {};
    try { json = text ? JSON.parse(text) : {}; } catch {}
    return { ok: resp.ok, status: resp.status, json, text };
  } catch (e) {
    return { ok: false, status: 0, error: e?.name === 'AbortError' ? '探测超时' : (e?.message || '连接失败') };
  } finally {
    clearTimeout(timer);
  }
}

function commandReady(bin, args = ['--version']) {
  const name = String(bin || '').trim();
  if (!name) return { ok: false, status: '未配置 CLI' };
  try {
    const r = spawnSync(name, args, {
      encoding: 'utf-8',
      timeout: 1800,
      env: { PATH: process.env.PATH || '', HOME: process.env.HOME || '', LANG: 'C', LC_ALL: 'C' },
    });
    const text = `${r.stdout || ''}${r.stderr || ''}`.replace(/\s+/g, ' ').trim();
    if (r.status === 0) return { ok: true, status: text ? `CLI 可用 · ${text.slice(0, 80)}` : 'CLI 可用' };
    return { ok: false, status: text ? `CLI 不可用 · ${text.slice(0, 80)}` : `CLI exit ${r.status}` };
  } catch (e) {
    return { ok: false, status: `CLI 不可用 · ${e?.message || 'unknown'}` };
  }
}

async function discoverLmStudio(env, adapter = null) {
  const baseUrl = adapter?.baseUrl || env.NOE_LMSTUDIO_URL || 'http://127.0.0.1:1234/v1';
  const out = await fetchJson(`${baseUrl.replace(/\/$/, '')}/models`);
  const rows = Array.isArray(out.json?.data) ? out.json.data : [];
  const disabled = disabledModels(env);
  const models = rows.map((m) => String(m.id || '').trim()).filter((id) => looksChatCapableModel(id) && !disabled.has(id)).map((id) => ({ id, label: id, available: true }));
  if (adapter?.model && looksChatCapableModel(adapter.model) && !disabled.has(adapter.model) && !models.some((m) => m.id === adapter.model)) models.unshift({ id: adapter.model, label: `${adapter.model}（配置默认）`, available: true });
  return {
    id: 'lmstudio',
    label: 'LM Studio',
    kind: 'local',
    available: out.ok && models.length > 0,
    status: out.ok ? `已连接 · ${models.length} 个模型` : (out.error || `HTTP ${out.status}`),
    models,
  };
}

async function discoverOllama(env, adapter = null) {
  const baseUrl = env.NOE_OLLAMA_URL || 'http://localhost:11434';
  const out = await fetchJson(`${baseUrl.replace(/\/$/, '')}/api/tags`);
  const rows = Array.isArray(out.json?.models) ? out.json.models : [];
  const disabled = disabledModels(env);
  const models = rows.map((m) => ({ id: String(m.name || '').trim(), capabilities: m.capabilities })).filter((m) => looksChatCapableModel(m.id, m.capabilities) && !disabled.has(m.id)).map((m) => ({ id: m.id, label: m.id, available: true }));
  if (adapter?.model && looksChatCapableModel(adapter.model) && !disabled.has(adapter.model) && !models.some((m) => m.id === adapter.model)) models.unshift({ id: adapter.model, label: `${adapter.model}（配置默认）`, available: true });
  return {
    id: 'ollama',
    label: 'Ollama',
    kind: 'local',
    available: out.ok && models.length > 0,
    status: out.ok ? `已连接 · ${models.length} 个模型` : (out.error || `HTTP ${out.status}`),
    models,
  };
}

async function discoverMiniMax(env, adapter = null, secretResolver = resolveNoeProviderSecret) {
  const resolution = adapter?.apiKey
    ? { ok: true, value: adapter.apiKey, source: 'adapter', sourceRef: 'minimax' }
    : secretResolver('minimax', { env });
  const apiKey = resolution?.value || '';
  const baseUrl = adapter?.baseUrl || env.MINIMAX_BASE_URL || 'https://api.minimax.chat/v1';
  const model = adapter?.model || MINIMAX_MODEL;
  const models = uniqModels([model, ...MINIMAX_MODELS]);
  if (!apiKey) return { id: 'minimax', label: 'MiniMax', kind: 'online', available: false, status: describeNoeProviderSecretFailure('minimax', resolution), models: models.map((m) => ({ ...m, available: false })), secretStatus: { configured: false, source: resolution?.source || 'unconfigured', sourceRef: resolution?.sourceRef || null } };
  const out = await fetchJson(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, timeoutMs: 3000 });
  const ok = out.ok || out.status === 404 || out.status === 405;
  return {
    id: 'minimax',
    label: 'MiniMax',
    kind: 'online',
    available: ok,
    status: out.ok ? '已连接' : (ok ? '已配置，模型列表接口不可用' : (out.error || `HTTP ${out.status}`)),
    models: models.map((m) => ({ ...m, available: ok })),
    secretStatus: { configured: true, source: resolution.source, sourceRef: resolution.sourceRef },
  };
}

function cliProvider(id, label, adapter, models, kind = 'online') {
  const ready = adapter ? commandReady(adapter.bin || id) : { ok: false, status: '未注册' };
  const available = !!adapter && ready.ok;
  return {
    id,
    label,
    kind,
    available,
    status: adapter ? `${ready.status}（不发起模型对话）` : '未注册',
    models: uniqModels(models).map((m) => ({ ...m, available })),
  };
}

async function openAICompatProvider(id, label, adapter, kind = 'online') {
  if (!adapter) return null;
  const baseUrl = adapter.baseUrl || '';
  const model = adapter.model || '';
  if (!baseUrl || !adapter.apiKey) return { id, label, kind, available: false, status: '缺少 baseUrl/apiKey', models: uniqModels([model]).map((m) => ({ ...m, available: false })) };
  const out = await fetchJson(`${baseUrl.replace(/\/$/, '')}/models`, { headers: { Authorization: `Bearer ${adapter.apiKey}` }, timeoutMs: 2200 });
  const rows = Array.isArray(out.json?.data) ? out.json.data : [];
  const models = rows.map((m) => String(m.id || '').trim()).filter(Boolean);
  if (model && !models.includes(model)) models.unshift(model);
  const ok = out.ok && models.length > 0;
  return { id, label, kind, available: ok, status: ok ? `已连接 · ${models.length} 个模型` : (out.error || `HTTP ${out.status}`), models: uniqModels(models).map((m) => ({ ...m, available: ok })) };
}

export async function discoverChatModels({ getAdapter = null, env = process.env, secretResolver = resolveNoeProviderSecret } = {}) {
  const adapter = (id) => (typeof getAdapter === 'function' ? getAdapter(id) : null);
  const [lmstudio, ollama, minimax, litellm, geminiOpenai] = await Promise.all([
    discoverLmStudio(env, adapter('lmstudio')),
    discoverOllama(env, adapter('ollama')),
    discoverMiniMax(env, adapter('minimax'), secretResolver),
    openAICompatProvider('litellm', 'LiteLLM', adapter('litellm')),
    openAICompatProvider('gemini-openai', 'Gemini OpenAI', adapter('gemini-openai')),
  ]);
  const ollama9b = adapter('ollama-9b');
  const optional = [litellm, geminiOpenai].filter(Boolean);
  return {
    ok: true,
    providers: [
      { id: 'auto', label: '自动路由', kind: 'router', available: true, status: '按任务自动选择', models: [{ id: '', label: '自动选择', available: true }] },
      cliProvider('claude', 'Claude Code', adapter('claude'), splitEnv(env.NOE_CLAUDE_MODELS, DEFAULT_CLAUDE_MODELS)),
      cliProvider('codex', 'Codex / GPT', adapter('codex'), splitEnv(env.NOE_CODEX_MODELS, DEFAULT_CODEX_MODELS)),
      minimax,
      ...optional,
      lmstudio,
      ollama,
      { id: 'ollama-9b', label: 'Ollama 9B', kind: 'local', available: !!ollama9b, status: ollama9b ? '已注册' : '未注册', models: uniqModels([ollama9b?.model || env.NOE_OLLAMA_9B_MODEL || 'huihui_ai/qwen3.5-abliterated:9b']) },
    ],
  };
}
