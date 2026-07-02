// NoePersonCards — 结构化「人物关系卡」记忆。
//
// 区别说明：src/voice/ChatProfiles.js 是「语音人格 / 说话风格」(宝贝/Noe 怎么说话)，
//   不是「记住对面是谁、关系如何、聊过什么」。本模块补的是后者——以人为单位的关系记忆：
//   每个人一张卡 { id, aliases[], relationship, keyEvents[], preferences{}, lastSeenAt }，
//   供主动陪伴/对话前拼出「你正在和 X 对话，关系…，偏好…」的上下文提示。
//
// 纯逻辑、自包含、无 I/O 副作用：时间(now)与 id 生成(idGen)全部注入式参数，
//   不读写文件、不碰数据库、不依赖全局时钟，可独立单测。
// Adapted from BaiLongma (MIT) src/person-cards.js
//   — 借鉴其「人物卡 + 别名映射 + 内容合并」的结构，去掉所有 fs/db/全局状态，改为注入式纯逻辑。

import { createHash } from 'node:crypto';

/**
 * 把任意输入归一为去空白小写文本，用于别名匹配（保留中文/字母/数字）。
 * 返回 '' 表示无有效内容。
 */
export function normalizePersonKey(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{Script=Han}a-z0-9]+/gu, '');
}

/**
 * 由名字派生「确定性稳定主键」：同一名字（归一后）永远映射到同一 id。
 *
 * 用途：默认 idGen 是随机的，进程重启 / 换 store 实例后同名实体会得到新 id，无法复用历史卡。
 *   canonicalPersonId 用归一文本的 SHA1 做主键，让「同名 → 同一稳定 id」跨重启可复现：
 *   `store.upsert({ id: canonicalPersonId('王总'), aliases: ['王总'] })`。
 * 与别名映射分工：本函数解决「同名 → 稳定主键」，aliasIndex 负责「不同别名（王总/老王/Wang）→ 同一卡」。
 *   注意「王总」与「老王」字面不同 → 归一 key 不同 → canonicalPersonId 不同；把它们聚一卡要靠别名合并。
 *
 * @param {string} name 人名 / 主别名。
 * @param {object} [opts]
 * @param {string} [opts.prefix] id 前缀（默认 'person'；仅接受 [A-Za-z0-9_-]，非法则回落默认）。
 * @param {number} [opts.length] 取 SHA1 hex 前多少位（默认 16，上限 40——SHA1 hex 总长，超出按 40 计）。
 * @returns {string} 形如 'person_<sha1hex>'；name 无有效内容时返回 ''。
 */
export function canonicalPersonId(name, opts = {}) {
  // prefix 必须是合法 id 片段，否则回落默认（防止空串 / 特殊字符破坏 'prefix_hash' 约定格式）。
  const prefix = typeof opts.prefix === 'string' && /^[A-Za-z0-9_-]+$/.test(opts.prefix)
    ? opts.prefix
    : 'person';
  // SHA1 hex 固定 40 位；length 超过即 clamp 到 40，避免静默截断让调用方误以为拿到更高熵。
  const length = Number.isInteger(opts.length) && opts.length > 0
    ? Math.min(opts.length, 40)
    : 16;
  const key = normalizePersonKey(name);
  if (!key) return '';
  const hash = createHash('sha1').update(key, 'utf8').digest('hex').slice(0, length);
  return `${prefix}_${hash}`;
}

/** 把字符串或数组归一为去重、去空白的字符串数组。 */
function normalizeAliasList(value) {
  let list = [];
  if (Array.isArray(value)) {
    list = value.map((v) => String(v ?? '').trim());
  } else if (typeof value === 'string') {
    list = value.split(/[,，、;；\n]/).map((v) => v.trim());
  }
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item) continue;
    const key = normalizePersonKey(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item.slice(0, MAX_ALIAS));
  }
  return out;
}

function clampString(value, max = 2000) {
  return String(value ?? '').trim().slice(0, max);
}

const MAX_EVENTS = 50;
const MAX_EVENT_TEXT = 2000;
const MAX_ALIAS = 120;
const MAX_PREF_VALUE = 2000;

/** 字符串型事件截断防撑爆 prompt；非字符串原样保留。 */
function clampEvent(ev) {
  return typeof ev === 'string' ? ev.slice(0, MAX_EVENT_TEXT) : ev;
}

/** 追加事件并按上限保留最近 MAX_EVENTS 条（防无限增长撑爆上下文）。 */
function pushEvent(card, ev) {
  card.keyEvents.push(clampEvent(ev));
  if (card.keyEvents.length > MAX_EVENTS) {
    card.keyEvents.splice(0, card.keyEvents.length - MAX_EVENTS);
  }
}

/** 偏好值：字符串截断防撑爆 prompt，非字符串原样。 */
function clampPrefValue(v) {
  return typeof v === 'string' ? v.slice(0, MAX_PREF_VALUE) : v;
}

function defaultIdGen() {
  // 注入缺省时的兜底 id（仅在调用方未传 idGen 时使用），保证全局唯一、稳定可读。
  return `person_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建一个人物关系卡存储实例。
 *
 * @param {object} [deps]
 * @param {() => number} [deps.now]   返回当前毫秒时间戳，注入式（默认 Date.now）。
 * @param {() => string} [deps.idGen] 为新卡生成 id，注入式（默认时间+随机）。
 * @returns {{
 *   upsert: (input: object) => object,
 *   getById: (id: string) => object|null,
 *   getByAlias: (alias: string) => object|null,
 *   recordEvent: (id: string, event: any) => object|null,
 *   setPreference: (id: string, key: string, value: any) => object|null,
 *   touch: (id: string, nowMs?: number) => object|null,
 *   toContextHint: (card: object|null) => string,
 *   list: () => object[],
 *   size: () => number,
 *   remove: (id: string) => boolean,
 *   reset: () => void,
 * }}
 */
export function createPersonCardStore(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const idGen = typeof deps.idGen === 'function' ? deps.idGen : defaultIdGen;

  /** @type {Map<string, object>} id -> card */
  const byId = new Map();
  /** @type {Map<string, string>} normalizedAlias -> id（别名映射，多别名指向同一卡） */
  const aliasIndex = new Map();

  function indexAliases(card) {
    for (const alias of card.aliases) {
      const key = normalizePersonKey(alias);
      if (key) aliasIndex.set(key, card.id);
    }
  }

  function dropAliases(card) {
    for (const [key, id] of aliasIndex) {
      if (id === card.id) aliasIndex.delete(key);
    }
  }

  function snapshot(card) {
    if (!card) return null;
    // 返回真·深拷贝（含嵌套对象），避免外部改快照穿透污染内部状态。
    return {
      id: card.id,
      aliases: [...card.aliases],
      relationship: card.relationship,
      keyEvents: card.keyEvents.map((e) => (e && typeof e === 'object' ? structuredClone(e) : e)),
      preferences: structuredClone(card.preferences),
      lastSeenAt: card.lastSeenAt,
    };
  }

  /**
   * 新建或更新一张卡。
   * - 传 id 命中已有卡 → 更新；
   * - 否则按别名（aliases / name）匹配已有卡 → 合并别名后更新；
   * - 都不命中 → 新建（用注入 idGen 生成 id）。
   * aliases 累加去重；relationship/preferences 增量覆盖；keyEvents 保留已有。
   * ⚠️ 别名即身份：调用方须保证别名能唯一标识一个人。歧义别名（"老板"/"老师"）会让
   *   不同的人命中同一张卡而被合并——别名映射的固有取舍，传入前请消歧。
   */
  function upsert(input = {}) {
    const incomingAliases = normalizeAliasList(
      input.aliases ?? (input.name ? [input.name] : []),
    );

    let card = null;
    if (input.id && byId.has(input.id)) {
      card = byId.get(input.id);
    } else {
      for (const alias of incomingAliases) {
        const key = normalizePersonKey(alias);
        const hitId = key ? aliasIndex.get(key) : null;
        if (hitId && byId.has(hitId)) {
          card = byId.get(hitId);
          break;
        }
      }
    }

    if (!card) {
      const id = input.id ? String(input.id) : idGen();
      card = {
        id,
        aliases: [],
        relationship: '',
        keyEvents: [],
        preferences: {},
        lastSeenAt: null,
      };
      byId.set(id, card);
    } else {
      // 重建别名索引前先撤掉旧的，防止删除别名后仍残留映射。
      dropAliases(card);
    }

    const mergedAliases = normalizeAliasList([...card.aliases, ...incomingAliases]);
    card.aliases = mergedAliases;

    if (input.relationship !== undefined) {
      card.relationship = clampString(input.relationship, 500);
    }
    if (input.preferences && typeof input.preferences === 'object') {
      for (const [k, v] of Object.entries(input.preferences)) {
        const key = clampString(k, 120);
        if (key) card.preferences[key] = clampPrefValue(v);
      }
    }
    if (Array.isArray(input.keyEvents)) {
      for (const ev of input.keyEvents) pushEvent(card, ev);
    }
    if (input.lastSeenAt !== undefined && input.lastSeenAt !== null) {
      const ts = Number(input.lastSeenAt);
      if (Number.isFinite(ts)) card.lastSeenAt = ts;
    }

    indexAliases(card);
    return snapshot(card);
  }

  function getById(id) {
    if (!id) return null;
    return snapshot(byId.get(id) || null);
  }

  function getByAlias(alias) {
    const key = normalizePersonKey(alias);
    if (!key) return null;
    const id = aliasIndex.get(key);
    if (!id) return null;
    return snapshot(byId.get(id) || null);
  }

  /** 给某人追加一条关键事件（保留时间顺序）。命中则返回更新后快照，否则 null。 */
  function recordEvent(id, event) {
    const card = byId.get(id);
    if (!card) return null;
    if (event === undefined) return snapshot(card);
    pushEvent(card, event);
    return snapshot(card);
  }

  /** 读写某人的偏好键值。命中则返回更新后快照，否则 null。 */
  function setPreference(id, key, value) {
    const card = byId.get(id);
    if (!card) return null;
    const k = clampString(key, 120);
    if (!k) return snapshot(card);
    card.preferences[k] = clampPrefValue(value);
    return snapshot(card);
  }

  /** 更新 lastSeenAt（未传 nowMs 用注入 now()）。命中则返回更新后快照，否则 null。 */
  function touch(id, nowMs) {
    const card = byId.get(id);
    if (!card) return null;
    const ts = Number.isFinite(Number(nowMs)) ? Number(nowMs) : now();
    card.lastSeenAt = ts;
    return snapshot(card);
  }

  /**
   * 把一张卡拼成给对话模型看的中文上下文提示文本。
   * 形如：「你正在和 X 对话，关系：…，偏好：a=1、b=2。最近关键事件：…」
   * card 为空或无有效身份时返回 ''。
   */
  function toContextHint(card) {
    if (!card || typeof card !== 'object') return '';
    const aliases = Array.isArray(card.aliases) ? card.aliases.filter(Boolean) : [];
    const name = aliases[0] || '';
    if (!name) return '';

    const parts = [`你正在和${name}对话`];
    const otherAliases = aliases.slice(1);
    if (otherAliases.length) parts.push(`又称${otherAliases.join('、')}`);

    const relationship = clampString(card.relationship, 500);
    if (relationship) parts.push(`关系：${relationship}`);

    const prefs = card.preferences && typeof card.preferences === 'object'
      ? Object.entries(card.preferences)
      : [];
    if (prefs.length) {
      const rendered = prefs
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join('、');
      parts.push(`偏好：${rendered}`);
    }

    const events = Array.isArray(card.keyEvents) ? card.keyEvents.filter((e) => e !== undefined && e !== null) : [];
    if (events.length) {
      const recent = events.slice(-3).map((e) =>
        typeof e === 'object' ? (e.summary || e.text || JSON.stringify(e)) : String(e),
      );
      parts.push(`最近关键事件：${recent.join('；')}`);
    }

    return `${parts.join('，')}。`;
  }

  return {
    upsert,
    getById,
    getByAlias,
    recordEvent,
    setPreference,
    touch,
    toContextHint,
    list() {
      return [...byId.values()].map(snapshot);
    },
    size() {
      return byId.size;
    },
    remove(id) {
      const card = byId.get(id);
      if (!card) return false;
      dropAliases(card);
      byId.delete(id);
      return true;
    },
    reset() {
      byId.clear();
      aliasIndex.clear();
    },
  };
}
