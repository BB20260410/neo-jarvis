// panel v2.0 Task 4.2 — embedding provider
// 双轨：
//   - hash (默认)：零依赖，128 维 character n-gram feature hashing
//   - ollama：opt-in，需要用户跑 `ollama pull nomic-embed-text`

import crypto from 'node:crypto';

const HASH_DIM = 128;

// ===== Ollama keep_alive 解析（治本：embedding 模型常驻，根治按需唤醒间歇失效）=====
// reference_ollama_ondemand_embedding_failure：Ollama 默认 5min idle 卸载模型，离线期 embed 退回
// hash-128 与库内 1024 维 mismatch → 语义召回零命中只剩 FTS。在 embedding 请求 body 里透传 keep_alive
// 让模型常驻，免改系统环境/launchctl（只影响 Neo 自己的 embedding 调用，不碰别的用 Ollama 的程序）。
//   - NOE_OLLAMA_KEEP_ALIVE 未设 → 默认 '-1'（永久常驻，治本；这是已确认的真 bug 修复，非"新功能"，
//     且现状代码本就硬编码 -1，默认 -1 保持行为连续）。
//   - 设为 '0' / 'off' / 'false' / 'none' / 'default' → 不传 keep_alive（回退 Ollama 默认 5min，保守）。
//   - 其余值（如 '5m' / '10m' / '-1' / 数字秒）→ 原样透传给 Ollama。
const DEFAULT_OLLAMA_KEEP_ALIVE = '-1';
const KEEP_ALIVE_OMIT = new Set(['0', 'off', 'false', 'no', 'none', 'disabled', 'default', 'unset']);

/**
 * 解析 keep_alive 值。返回 undefined 表示「不传该字段」（用 Ollama 默认行为）。
 * 显式传入的 keepAlive 优先于 env；都没有时回落默认 '-1'。
 */
export function resolveOllamaKeepAlive(keepAlive, env = process.env) {
  let raw = keepAlive;
  if (raw === undefined || raw === null) raw = env?.NOE_OLLAMA_KEEP_ALIVE;
  if (raw === undefined || raw === null || String(raw).trim() === '') raw = DEFAULT_OLLAMA_KEEP_ALIVE;
  const s = String(raw).trim();
  if (KEEP_ALIVE_OMIT.has(s.toLowerCase())) return undefined;
  // 纯整数字符串归一成 number（Ollama 同时接受 number 秒与 "-1"/"10m" 字符串；-1 两种都认）。
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

// ===== hash provider（默认，0 依赖）=====
export function hashEmbed(text, dim = HASH_DIM) {
  const vec = new Float32Array(dim);
  if (!text || typeof text !== 'string') return vec;
  const s = text.toLowerCase();
  const ngrams = [];
  for (let i = 0; i < s.length - 2; i++) ngrams.push(s.slice(i, i + 3));
  for (const ng of ngrams) {
    const h = crypto.createHash('sha256').update(ng).digest();
    const idx = h.readUInt32BE(0) % dim;
    const sign = (h[4] & 1) === 0 ? 1 : -1;
    vec[idx] += sign;
  }
  // L2 归一化
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

// ===== ollama provider（opt-in）=====
export async function ollamaEmbed(text, { model = 'nomic-embed-text', baseUrl = 'http://localhost:11434', keepAlive } = {}) {
  const ka = resolveOllamaKeepAlive(keepAlive); // 默认 '-1' 常驻；NOE_OLLAMA_KEEP_ALIVE 可调/可关
  const reqBody = { model, prompt: text };
  if (ka !== undefined) reqBody.keep_alive = ka; // 让 ollama embedding 模型常驻，根治按需唤醒间歇失效
  const resp = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
  });
  if (!resp.ok) throw new Error(`ollama embed failed ${resp.status}`);
  const j = await resp.json();
  if (!Array.isArray(j.embedding)) throw new Error('ollama embedding not array');
  const dim = j.embedding.length;
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vec[i] = j.embedding[i];
  // L2 归一化（ollama 已归一化但再保证一次）
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] /= norm;
  return vec;
}

// ===== 统一接口 =====
export async function embed(text, { provider = 'hash', model, baseUrl, keepAlive } = {}) {
  // 输入校验：拒绝脏数据（null/undefined、空数组、非字符串及非字符串条目），避免下发到下游 provider 触发 NaN/类型错误
  if (text == null) {
    throw new Error('embed: text must not be null or undefined');
  }
  if (Array.isArray(text)) {
    if (text.length === 0) {
      throw new Error('embed: text array must not be empty');
    }
    for (let i = 0; i < text.length; i++) {
      if (typeof text[i] !== 'string') {
        throw new Error(`embed: text[${i}] must be a string, got ${typeof text[i]}`);
      }
    }
    throw new Error(`embed: text must be a string, got array (length ${text.length})`);
  }
  if (typeof text !== 'string') {
    throw new Error(`embed: text must be a string, got ${typeof text}`);
  }
  if (provider === 'ollama') {
    try {
      return { vector: await ollamaEmbed(text, { model, baseUrl, keepAlive }), provider: 'ollama', model: model || 'nomic-embed-text' };
    } catch (e) {
      // ollama 失败 → 退到 hash
      return { vector: hashEmbed(text), provider: 'hash-fallback', model: `hash-${HASH_DIM}`, fallback: true, error: e.message };
    }
  }
  return { vector: hashEmbed(text), provider: 'hash', model: `hash-${HASH_DIM}` };
}

// ===== 余弦相似度 =====
export function cosineSim(a, b) {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i] * b[i];
  return dot; // 假设输入已 L2 归一化
}

export { HASH_DIM };
