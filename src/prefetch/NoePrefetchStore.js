// NoePrefetchStore — 后台预取缓存池，让高频环境数据（天气/新闻等）秒回。
//
// 问题：天气、新闻热榜这类「问得多、变得慢」的环境数据，每次都现抓网络会拖慢回复，
//   用户感知为「卡顿」。但这些数据有天然新鲜度窗口（如天气 60min、新闻 30min），
//   在窗口内可直接复用上次抓取的结果。
// 方案：一个带 TTL 的内存缓存池。后台 runner 抓到数据后 set(key, value, ttlMs)；
//   注入主 prompt 前用 toContextBlock(now) 拼出仅含「未过期项」的 <prefetched-items> 文本，
//   主 LLM 直接引用、无需等网络。过期项被透明过滤，不会污染上下文。
//
// 纯逻辑、无 I/O、无副作用：本模块只管缓存与拼装，不真抓网络；时间通过注入式
//   now 参数传入（不调 Date.now()），可独立、确定性单测。
// Adapted from BaiLongma (MIT) src/prefetch/runner.js + src/memory/injector.js
//   formatPrefetchedItems — 预取缓存与 <prefetched-items> 注入约定。

const DEFAULT_TTL_MS = 30 * 60 * 1000; // 默认 30 分钟新鲜度
const BLOCK_OPEN = '<prefetched-items>';
const BLOCK_CLOSE = '</prefetched-items>';

function asKey(key) {
  if (key === undefined || key === null) return '';
  return String(key).trim();
}

// 把任意值压成可注入 prompt 的字符串：对象走 JSON，其余 String() 后去尾空白。
function clean(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.replace(/\s+$/, '');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value).replace(/\s+$/, '');
}

function isExpired(entry, nowMs) {
  // ttlMs <= 0 视为永不过期（与上游「无窗口即长期有效」一致）。
  if (!entry || !(entry.ttlMs > 0)) return false;
  return nowMs >= entry.fetchedAt + entry.ttlMs;
}

/**
 * 创建一个预取缓存池实例。
 *
 * 所有读时间的 API 都接收注入式 nowMs（毫秒时间戳）；不传则回退到 Date.now()，
 * 仅为生产便利，单测一律显式传入以保持确定性。
 *
 * @param {object} [opts]
 * @param {number} [opts.defaultTtlMs] set 未给 ttlMs 时的默认 TTL（毫秒）
 * @returns {{
 *   set: (key:string, value:any, ttlMs?:number, fetchedAtMs?:number) => boolean,
 *   get: (key:string, nowMs?:number) => any,
 *   has: (key:string, nowMs?:number) => boolean,
 *   freshItems: (nowMs?:number) => Array<{key:string,value:any,fetchedAt:number,ttlMs:number,expiresAt:number|null}>,
 *   toContextBlock: (nowMs?:number) => string,
 *   prune: (nowMs?:number) => number,
 *   delete: (key:string) => boolean,
 *   size: () => number,
 *   clear: () => void,
 * }}
 */
export function createPrefetchStore(opts = {}) {
  const defaultTtlMs = Number.isFinite(opts.defaultTtlMs) && opts.defaultTtlMs >= 0
    ? opts.defaultTtlMs
    : DEFAULT_TTL_MS;
  // maxEntries：条数上限（LRU 淘汰最旧）。默认 0 = 无上限，向后兼容天气/新闻预取池；
  //   开放 key 的池（如 fetchContent 缓存 fetch:<maxChars>:<url>）应设上限防无界增长（Codex 审发现7）。
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? Math.floor(opts.maxEntries) : 0;

  /** @type {Map<string, {value:any, fetchedAt:number, ttlMs:number}>} */
  const store = new Map();

  function now(nowMs) {
    return Number.isFinite(nowMs) ? nowMs : Date.now();
  }

  return {
    /**
     * 写入/覆盖一项缓存。key 为空则忽略并返回 false。
     * @param ttlMs 新鲜度窗口（毫秒）；省略用 defaultTtlMs；<=0 表示永不过期。
     * @param fetchedAtMs 抓取时刻；省略用当前时间（生产用 Date.now，测试应显式传）。
     */
    set(key, value, ttlMs, fetchedAtMs) {
      const k = asKey(key);
      if (!k) return false;
      const ttl = Number.isFinite(ttlMs) ? ttlMs : defaultTtlMs;
      const fetchedAt = Number.isFinite(fetchedAtMs) ? fetchedAtMs : now();
      if (maxEntries > 0) {
        // LRU 有界（仅限设了 maxEntries 的池）：touch 到尾 + 超限淘汰最旧。
        // maxEntries=0（天气/新闻预取）走原路径不动插入序，toContextBlock 顺序不变（零回归）。
        store.delete(k);
        if (store.size >= maxEntries) { const oldest = store.keys().next().value; if (oldest !== undefined) store.delete(oldest); }
      }
      store.set(k, { value, fetchedAt, ttlMs: ttl });
      return true;
    },

    /** 取一项；不存在或已过期返回 null（过期项顺手删除，惰性清理）。 */
    get(key, nowMs) {
      const k = asKey(key);
      if (!k) return null;
      const entry = store.get(k);
      if (!entry) return null;
      if (isExpired(entry, now(nowMs))) {
        store.delete(k);
        return null;
      }
      // 真 LRU：命中刷新 recency 到尾（热 key 不被后续新写挤掉，Codex 复审 Finding 3）。仅有界池启用；
      //   maxEntries=0（天气/新闻）不动插入序 → toContextBlock 顺序不变、零回归。
      if (maxEntries > 0) { store.delete(k); store.set(k, entry); }
      return entry.value;
    },

    /** 是否存在且未过期。 */
    has(key, nowMs) {
      const k = asKey(key);
      if (!k) return false;
      const entry = store.get(k);
      if (!entry) return false;
      return !isExpired(entry, now(nowMs));
    },

    /**
     * 返回所有未过期项的快照数组（不修改池子，便于注入/诊断）。
     * 每项含 expiresAt（永不过期项为 null），按插入顺序。
     */
    freshItems(nowMs) {
      const t = now(nowMs);
      const items = [];
      for (const [key, entry] of store) {
        if (isExpired(entry, t)) continue;
        items.push({
          key,
          value: entry.value,
          fetchedAt: entry.fetchedAt,
          ttlMs: entry.ttlMs,
          expiresAt: entry.ttlMs > 0 ? entry.fetchedAt + entry.ttlMs : null,
        });
      }
      return items;
    },

    /**
     * 拼成可注入 prompt 的 <prefetched-items> 文本块，仅含未过期项。
     * 空池或全过期返回空串（调用方据此决定是否注入）。
     */
    toContextBlock(nowMs) {
      const items = this.freshItems(nowMs);
      if (items.length === 0) return '';
      const body = items
        .map((item) => `[${item.key}]\n${clean(item.value)}`)
        .join('\n\n');
      return `${BLOCK_OPEN}\n${body}\n${BLOCK_CLOSE}`;
    },

    /** 物理删除所有过期项，返回删除条数。 */
    prune(nowMs) {
      const t = now(nowMs);
      let removed = 0;
      for (const [key, entry] of store) {
        if (isExpired(entry, t)) {
          store.delete(key);
          removed += 1;
        }
      }
      return removed;
    },

    /** 删除指定 key，返回是否删到。 */
    delete(key) {
      const k = asKey(key);
      if (!k) return false;
      return store.delete(k);
    },

    /** 当前池内总条数（含过期未清理项，诊断用）。 */
    size() {
      return store.size;
    },

    /** 清空整个池。 */
    clear() {
      store.clear();
    },
  };
}
