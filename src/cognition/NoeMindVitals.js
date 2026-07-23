// @ts-check
// NoeMindVitals — 心智体征计量：语义级多样性 / 接地度（长期规划 M1 断路器 + M5 自审仪表共用）。
//
// 自审实证（2026-06-11 生产取证）：12 条念头全是"频率/共振/静默"的修辞变奏——字符级相似度
// 防得住字面重复，防不住"同一个调子的十二种写法"（Echo Trap）。治它的测量端必须是语义向量：
//   多样性 = 1 - 念头两两余弦相似度均值；接地度 = 念头与真实经历的最大相似度。
// embedText 注入（EmbeddingProvider.embed 的 ollama 档，qwen3-embedding 本地零付费）；
// 带 LRU 缓存（按情景 id 键，避免同一批念头反复嵌入）；全程 fail-open（嵌入炸了返回 null，
// 调用方降级回字符级判定，绝不阻断反刍）。
import { cosineSim } from '../embeddings/EmbeddingProvider.js';
import { round3 } from './_mathUtils.js';

export function createMindVitals({ embedText, cacheMax = 300 } = {}) {
  if (typeof embedText !== 'function') throw new Error('createMindVitals: embedText required');
  /** @type {Map<string, any>} */
  const cache = new Map();

  async function vec(key, text) {
    if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
    const v = await embedText(String(text || '').slice(0, 500));
    if (!v) return null;
    cache.set(key, v);
    if (cache.size > cacheMax) cache.delete(cache.keys().next().value);
    return v;
  }

  /** 两段文本语义相似度（0..1 近似；失败 null）。 */
  async function similarity(aKey, aText, bKey, bText) {
    try {
      const [a, b] = await Promise.all([vec(aKey, aText), vec(bKey, bText)]);
      if (!a || !b) return null;
      return round3(cosineSim(a, b));
    } catch { return null; }
  }

  /** 一组文本的两两平均相似度 → 多样性 = 1-avg。items: [{key,text}]。 */
  async function diversity(items = []) {
    try {
      const vs = await Promise.all(items.map((i) => vec(i.key, i.text)));
      const ok = vs.filter(Boolean);
      if (ok.length < 2) return { n: ok.length, avgSim: null, diversity: null };
      let s = 0; let p = 0;
      for (let i = 0; i < ok.length; i++) {
        for (let j = i + 1; j < ok.length; j++) { s += cosineSim(ok[i], ok[j]); p++; }
      }
      const avg = s / p;
      return { n: ok.length, avgSim: round3(avg), diversity: round3(1 - avg) };
    } catch { return { n: 0, avgSim: null, diversity: null }; }
  }

  /** 接地度：念头与一组真实经历的最大相似度（它到底在想"生活"还是在空转）。 */
  async function groundedness(thoughtKey, thoughtText, experiences = []) {
    try {
      const tv = await vec(thoughtKey, thoughtText);
      if (!tv || !experiences.length) return null;
      // 性能：经历向量并行嵌入（与 diversity() 同款 Promise.all），替代原逐条 await 串行——
      // 内心透视/接地重写每个 reflect tick 可达 ~8 条经历 × 多次调用，串行嵌入是热路径主延迟来源。
      // 结果逐字等价：vec() 仍带 LRU 缓存按 key 去重；下面按 experiences 原序取 evs[i] 配对，
      // 保留 `s > best` 的严格大于（并列保留先出现者）与 `!ev` 跳过逻辑，最大值与 refKey 完全不变。
      const evs = await Promise.all(experiences.map((e) => vec(e.key, e.text)));
      let best = -1; let bestKey = null;
      for (let i = 0; i < experiences.length; i++) {
        const ev = evs[i];
        if (!ev) continue;
        const s = cosineSim(tv, ev);
        if (s > best) { best = s; bestKey = experiences[i].key; }
      }
      return best < 0 ? null : { score: round3(best), refKey: bestKey };
    } catch { return null; }
  }

  return { similarity, diversity, groundedness };
}
