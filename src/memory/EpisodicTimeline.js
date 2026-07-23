// @ts-check
// EpisodicTimeline — Noe 的「自传体情景时间线」（连续记忆脊椎·第一节）。
//
// 问题：MemoryCore 存的是语义记忆（"owner 喜欢极客美学"，按相关性召回），给不出「连续感」。
// 连续感来自情景记忆——按时间顺序串起来的一条经历流：我昨天和你聊了意识、今早修了 bug、
// 那之前你给我改名"伴影"。新会话注入的不该只是"相关事实"，而是"最近这条线上发生了什么"。
//
// 设计：基于 events 表（kind='noe_episode'）——复用 SQLite 迁移/备份/保留期（pruneEvents 180 天）。
// 久远情景褪色后由梦境升华成语义记忆沉淀进 MemoryCore（模拟人类情景记忆→语义记忆的规律）。
// 每个情景带「当时的自我状态快照」（selfState，第二节 NoeSelfModel 填），回放时能重建"当时的我"。
// 注入式：append/list/count/now 全可注入 → 单测可控。

import { appendEvent, listEvents, countEvents } from '../storage/SqliteStore.js';

export const EPISODE_KIND = 'noe_episode';
// 情景类型：交互/主动观察/梦境整理/内心独白/里程碑/挫败/纠正。第三节 inner_monologue 写回本时间线形成递归。
// setback/correction = 负向情景（阶段0）：接 affect 负反馈通道，让真实失败/owner 纠正能把 v 拉下来——
// 不在白名单里就会被回退成 'interaction'（正向），导致"失败反而更暖"的失真，故必须登记。
export const EPISODE_TYPES = ['interaction', 'observation', 'dream', 'inner_monologue', 'milestone', 'setback', 'correction'];

const MAX_SUMMARY = 500;
const MAX_DETAIL = 4000;

/**
 * 相对时间表达——连续感的关键：人记得的是"刚刚/今早/三天前"而非时间戳。纯函数。
 * @param {number} ts
 * @param {number} [now]
 */
export function relativeTime(ts, now = Date.now()) {
  // 强健:ts 非有限(缺失/脏字符串/NaN)时不抛 RangeError(new Date(NaN).toISOString() 会崩,
  // 而消费方 narrative() 无 try/catch、又喂系统提示注入路径)——降级占位,合法数值 ts 逐字不变。
  // Number([])===0(空数组转 0 会误当 epoch)、Number(Symbol) 抛——故按 typeof 守卫:
  // 仅 number/数字字符串走 Number；null 兼容旧 epoch 行为；其余(数组/对象/Symbol/undefined)→ NaN → 降级。
  const t = ts === null ? 0 : ((typeof ts === 'number' || typeof ts === 'string') ? Number(ts) : NaN);
  if (!Number.isFinite(t)) return '某时';
  const n = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const diff = n - t;
  if (diff < 60000) return '刚刚';
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day === 1) return '昨天';
  if (day < 7) return `${day} 天前`;
  if (day < 30) return `${Math.floor(day / 7)} 周前`;
  return new Date(t).toISOString().slice(0, 10);
}

function clampSalience(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 3;
  return Math.max(0, Math.min(10, Math.round(n)));
}

// events 行 → 情景对象（recent/aged 共用的字段映射；payload 缺失时回落具名列）。
function toEpisode(r) {
  return {
    id: r.id,
    ts: r.ts,
    type: r.payload?.episodeType || r.tag || 'interaction',
    summary: r.payload?.summary || '',
    detail: r.payload?.detail || '',
    selfState: r.payload?.selfState || null,
    salience: r.payload?.salience ?? 3,
    meta: r.payload?.meta || null, // 意识流 v2（意识方案 §5.1）：streamType/affect 印记/echoRefs 等扩展元数据；旧情景无此字段为 null
  };
}

export class EpisodicTimeline {
  constructor({
    append = appendEvent,
    list = listEvents,
    count = countEvents,
    now = Date.now,
    projectId = 'noe',
  } = {}) {
    this.append = append;
    this.list = list;
    this.countFn = count;
    this.now = now;
    this.projectId = projectId;
  }

  /**
   * 记一个情景。summary = 注入用的一句话概括；selfState = 当时的自我状态快照（第二节填）。
   * @returns {number} eventId
   */
  record({ type, summary, detail = '', selfState = null, salience, ts, sessionId = null, roomId = null, meta = null } = {}) {
    const t = EPISODE_TYPES.includes(type) ? type : 'interaction';
    const sum = String(summary || '').trim().slice(0, MAX_SUMMARY);
    if (!sum) throw new Error('episode summary required');
    return this.append({
      kind: EPISODE_KIND,
      ts: ts ?? this.now(),
      tag: t,
      sessionId,
      roomId,
      entityType: 'noe_episode',
      // 以下进 payload（appendEvent 的 ...payload）：
      projectId: this.projectId,
      episodeType: t,
      summary: sum,
      detail: String(detail || '').slice(0, MAX_DETAIL),
      selfState: selfState && typeof selfState === 'object' ? selfState : null,
      salience: clampSalience(salience),
      meta: meta && typeof meta === 'object' ? meta : null, // 意识流 v2 扩展元数据（不传=旧行为逐字一致）
    });
  }

  /** 取最近的情景流（时序倒序，最近在前）。types 可过滤类型。 */
  recent({ limit = 20, sinceTs, types } = {}) {
    const rows = this.list({ kind: EPISODE_KIND, sinceTs, limit: Math.max(1, limit), order: 'DESC' });
    const wanted = Array.isArray(types) && types.length ? new Set(types) : null;
    return rows.map(toEpisode).filter((e) => e.summary && (!wanted || wanted.has(e.type)));
  }

  /**
   * 取「久远」情景（ts <= untilTs），时序正序（最老在前）——梦境升华（支柱②）按周分组消费。
   * 底层 SqliteStore.listEvents 原生支持 untilTs（ts <= ?），纯透传；sinceTs 配合水位线增量消费。
   * @returns {Array<{id:number,ts:number,type:string,summary:string,detail:string,selfState:object|null,salience:number}>} 与 recent() 同形状（最老在前）
   */
  aged({ untilTs, sinceTs, limit = 200, minSalience = 0, types } = {}) {
    const rows = this.list({ kind: EPISODE_KIND, sinceTs, untilTs, limit: Math.max(1, limit), order: 'ASC' });
    const wanted = Array.isArray(types) && types.length ? new Set(types) : null;
    return rows
      .map(toEpisode)
      .filter((e) => e.summary && e.salience >= minSalience && (!wanted || wanted.has(e.type)));
  }

  /**
   * 把最近情景编织成自传体叙事文本（注入 system prompt 的核心产物）。
   * 不是事实列表，是"我记得我们一路走来"的时间线——连续记忆的注入形态。
   * @returns {string} <noe-recent-timeline> 块，空时返回 ''
   */
  narrative({ limit = 12, maxChars = 1200, minSalience = 0, now } = {}) {
    const t = now ?? this.now();
    const eps = this.recent({ limit: limit * 2 })
      .filter((e) => e.salience >= minSalience)
      .slice(0, limit);
    if (!eps.length) return '';
    const lines = [];
    let chars = 0;
    for (const e of eps) {
      const line = `- ${relativeTime(e.ts, t)}：${e.summary}`;
      if (chars + line.length > maxChars) break;
      lines.push(line);
      chars += line.length;
    }
    if (!lines.length) return '';
    return [
      '<noe-recent-timeline>',
      '我（Noe）记得我们最近一路走来发生的事（最近在前）。被问到"上次/之前/我们聊过…"时据此连贯接续，不要假装第一次见面：',
      ...lines,
      '</noe-recent-timeline>',
    ].join('\n');
  }

  /** 情景总数（含所有时间）。 */
  total() {
    return this.countFn ? this.countFn({ kind: EPISODE_KIND }) : 0;
  }
}

export const defaultEpisodicTimeline = new EpisodicTimeline();
