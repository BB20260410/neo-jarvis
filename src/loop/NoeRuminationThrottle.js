// @ts-check
// NoeRuminationThrottle — 反刍节流器：防同一 research episode / topic 被反复选为内心反刍主题。
//
// 动机（实测 2026-06-23）：每次 research 后 InnerMonologue 反复"刚才研究 X 比空想更值"刷 episode
//   （2h 内 27 反刍 vs 10 真 research = 2.7 倍）。根因不是反刍总频率，是选择器无状态地反复抓同一 episode。
//
// 设计（综合 multimodel M3∥Codex + Claude 子代理）：在选择器前置一道闸门——不动"刚做完有价值"的判定，
//   只约束采样分布。三道闸：per-episode 计数上限 + per-episode 冷却 + per-topic 冷却。
//   topic 维度让"同一研究主题的反刍互相抑制、跨主题正常进行"，比全局限频不误伤。
//
// flag NOE_RUMINATION_THROTTLE=1 门控（OFF 时调用方不接入，零回归）。状态进程内（与 recentWinners 同档、非持久真相）。

const DEFAULT_MAX_PER_EPISODE = 2;
const DEFAULT_EPISODE_COOLDOWN_MS = 5 * 60 * 1000;   // 同一 episode 冷却 5min
const DEFAULT_TOPIC_COOLDOWN_MS = 15 * 60 * 1000;    // 同一 topic 冷却 15min
const DEFAULT_MAX_ENTRIES = 512;                     // LRU 上限防无界增长

function finitePositive(value, fallback, min) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.max(min, Math.floor(n));
}

export function resolveRuminationThrottleConfig(env = process.env) {
  const enabled = env?.NOE_RUMINATION_THROTTLE === '1';
  const maxPerEpisode = finitePositive(env?.NOE_RUMINATION_MAX_PER_EPISODE, DEFAULT_MAX_PER_EPISODE, 1);
  const episodeCooldownMs = finitePositive(env?.NOE_RUMINATION_EPISODE_COOLDOWN_MS, DEFAULT_EPISODE_COOLDOWN_MS, 1000);
  const topicCooldownMs = finitePositive(env?.NOE_RUMINATION_TOPIC_COOLDOWN_MS, DEFAULT_TOPIC_COOLDOWN_MS, 1000);
  return { enabled, maxPerEpisode, episodeCooldownMs, topicCooldownMs };
}

export class NoeRuminationThrottle {
  constructor({
    maxPerEpisode = DEFAULT_MAX_PER_EPISODE,
    episodeCooldownMs = DEFAULT_EPISODE_COOLDOWN_MS,
    topicCooldownMs = DEFAULT_TOPIC_COOLDOWN_MS,
    now = () => Date.now(),
    maxEntries = DEFAULT_MAX_ENTRIES,
  } = {}) {
    this.maxPerEpisode = finitePositive(maxPerEpisode, DEFAULT_MAX_PER_EPISODE, 1);
    this.episodeCooldownMs = finitePositive(episodeCooldownMs, DEFAULT_EPISODE_COOLDOWN_MS, 1);
    this.topicCooldownMs = finitePositive(topicCooldownMs, DEFAULT_TOPIC_COOLDOWN_MS, 1);
    this.maxEntries = finitePositive(maxEntries, DEFAULT_MAX_ENTRIES, 1);
    this.now = now;
    /** @type {Map<string,{count:number,lastAt:number,topicId:string|null}>} */
    this.episodes = new Map();
    /** @type {Map<string,number>} */
    this.topics = new Map();
  }

  // 是否允许反刍这个 candidate。**只读判定、不计数**——调用方决定反刍后另调 record() 计数。
  //   无 episodeId 不节流（放行）；同 episode 超计数/在冷却、或同 topic 在冷却 → 不允许。
  check({ episodeId, topicId } = {}) {
    if (!episodeId) return { allowed: true };
    const now = this.now();
    const st = this.episodes.get(String(episodeId));
    if (st) {
      if (st.count >= this.maxPerEpisode) return { allowed: false, reason: 'max_per_episode' };
      if (now - st.lastAt < this.episodeCooldownMs) return { allowed: false, reason: 'episode_cooldown' };
    }
    if (topicId != null) {
      const tLast = this.topics.get(String(topicId));
      if (tLast != null && now - tLast < this.topicCooldownMs) return { allowed: false, reason: 'topic_cooldown' };
    }
    return { allowed: true };
  }

  // 反刍真发生后计数（调用方确实围绕该 episode 反刍后调）。LRU touch + 上限淘汰冷 entry。
  record({ episodeId, topicId } = {}) {
    if (!episodeId) return;
    const now = this.now();
    const key = String(episodeId);
    let st = this.episodes.get(key);
    if (st) { this.episodes.delete(key); } else { st = { count: 0, lastAt: 0, topicId: topicId != null ? String(topicId) : null }; }
    st.count += 1;
    st.lastAt = now;
    if (topicId != null) st.topicId = String(topicId);
    if (this.episodes.size >= this.maxEntries) { const oldest = this.episodes.keys().next().value; if (oldest !== undefined) this.episodes.delete(oldest); }
    this.episodes.set(key, st);
    if (topicId != null) {
      // topics 同样 LRU 有界：topicId 来自开放 summary 文本，不淘汰会无界增长（对称 episodes 的淘汰）。
      const tk = String(topicId);
      this.topics.delete(tk); // touch：删后重插到尾部
      if (this.topics.size >= this.maxEntries) { const oldestT = this.topics.keys().next().value; if (oldestT !== undefined) this.topics.delete(oldestT); }
      this.topics.set(tk, now);
    }
  }

  status(episodeId) {
    const st = this.episodes.get(String(episodeId));
    return st ? { count: st.count, lastAt: st.lastAt, topicId: st.topicId } : { count: 0, lastAt: 0, topicId: null };
  }
}

// 进程级单例（InnerMonologue 每 tick 调用，状态跨 tick 共享）。
let _singleton = null;
export function getSharedRuminationThrottle() {
  if (!_singleton) {
    const cfg = resolveRuminationThrottleConfig();
    _singleton = new NoeRuminationThrottle({
      maxPerEpisode: cfg.maxPerEpisode,
      episodeCooldownMs: cfg.episodeCooldownMs,
      topicCooldownMs: cfg.topicCooldownMs,
    });
  }
  return _singleton;
}

export function __resetSharedRuminationThrottleForTest() {
  _singleton = null;
}
