// NoeCommitmentStore — 承诺/待办的结构化跟踪。
//
// 问题：用户随口说「明天提醒我买菜」「下周三前把报销交了」这类承诺/开放回路，
//   若只当普通对话过一遍就丢了，Noe 既无法在合适时机主动跟进，也无法去重/收口。
// 方案：把每条承诺存为结构化记录（含到期时间窗 dueWindow），到点时由心跳/巡检
//   调 due(nowMs) 取出「该提的」open 项，处理完用 resolve/cancel 收口。
//
// 纯逻辑、自包含、无 I/O 副作用：now 与 idGen 全部注入，不读时钟、不落盘、不发网络。
// Adapted from OpenClaw (MIT) src/commitments/store.ts CommitmentRecord + dueWindow
//   — github.com/openclaw/openclaw
//
// 持久化（2026-06-10 强健工程）：默认仍纯内存（不给 file 时行为完全不变，测试照旧）；
//   生产注入 file 后，每次 add/resolve/cancel 落盘（原子写+损坏兜底，复用 atomicJsonFile），
//   重启不丢用户"提醒我…"承诺（旧版纯内存重启即丢，proactiveTick 再也提不起）。

import { atomicWriteJson, readJsonWithCorruptBackup } from '../state/atomicJsonFile.js';

const CATEGORIES = new Set(['event_check_in', 'open_loop', 'task', 'reminder']);
const SENSITIVITIES = new Set(['routine', 'care']);
const STATUSES = new Set(['open', 'done', 'cancelled']);

const DEFAULT_CATEGORY = 'reminder';
const DEFAULT_SENSITIVITY = 'routine';
// 到期兜底窗：未显式给 latest 时，从 earliest 起多久内仍算「该提」。
// 24h 与 OpenClaw 的 rolling-day 同量级——避免错过一次心跳就永久漏提。
const DEFAULT_DUE_SPAN_MS = 24 * 60 * 60 * 1000;

/** 去掉首尾空白并截断；非字符串归一为空串。 */
function clean(value, max = 2000) {
  if (value === undefined || value === null) return '';
  return String(value).trim().slice(0, max);
}

/** 仅接受有限非负数，否则返回 undefined（用于时间戳/时间窗兜底判定）。 */
function finiteNonNeg(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function normalizeCategory(value) {
  const text = clean(value, 40);
  return CATEGORIES.has(text) ? text : DEFAULT_CATEGORY;
}

function normalizeSensitivity(value) {
  const text = clean(value, 40);
  return SENSITIVITIES.has(text) ? text : DEFAULT_SENSITIVITY;
}

/**
 * 归一化到期时间窗。
 * - earliest 缺失/非法 → 用 createdAt 兜底（即「立刻可提」）。
 * - latest 缺失/非法/早于 earliest → earliest + DEFAULT_DUE_SPAN_MS 兜底，
 *   保证 latest >= earliest（时间窗永不倒挂）。
 */
function normalizeDueWindow(raw, createdAt) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const earliest = finiteNonNeg(src.earliestMs) ?? createdAt;
  const latestCandidate = finiteNonNeg(src.latestMs);
  const latest =
    latestCandidate !== undefined && latestCandidate >= earliest
      ? latestCandidate
      : earliest + DEFAULT_DUE_SPAN_MS;
  return { earliestMs: earliest, latestMs: latest };
}

/**
 * 创建一个承诺存储实例。
 * @param {object} [deps]
 * @param {() => number} [deps.now] 注入时钟，返回毫秒时间戳；默认 Date.now。
 * @param {() => string} [deps.idGen] 注入 id 生成器；默认基于 createdAt 的伪随机。
 * @returns {{
 *   add: (input: object) => object,
 *   list: (filter?: {status?: string}) => object[],
 *   due: (nowMs?: number) => object[],
 *   get: (id: string) => object|null,
 *   resolve: (id: string) => object|null,
 *   cancel: (id: string) => object|null,
 *   size: () => number,
 *   reset: () => void,
 * }}
 */
export function createCommitmentStore(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  // 给 file 才落盘；默认 null = 纯内存（向后兼容，测试与纯逻辑用法完全不变）
  const file = typeof deps.file === 'string' && deps.file ? deps.file : null;
  let seq = 0;
  const fallbackIdGen = () => `cm_${now().toString(36)}_${(seq += 1).toString(36)}`;
  const idGen = typeof deps.idGen === 'function' ? deps.idGen : fallbackIdGen;

  /** @type {Map<string, object>} 按 id 索引，保留插入顺序。 */
  const byId = new Map();

  /** 落盘当前全部承诺（仅注入 file 时；原子写，失败静默不污染内存态）。 */
  function persist() {
    if (!file) return;
    try { atomicWriteJson(file, { version: 1, commitments: Array.from(byId.values()) }); } catch {}
  }

  /** 启动从磁盘恢复（仅注入 file；损坏自动备份并空载，逐条基本校验防脏数据进内存）。 */
  function loadFromDisk() {
    if (!file) return;
    const data = readJsonWithCorruptBackup(file, { label: 'noe-commitments' });
    const rows = Array.isArray(data?.commitments) ? data.commitments : [];
    for (const r of rows) {
      const id = clean(r?.id, 120);
      const text = clean(r?.text);
      if (!id || !text || byId.has(id)) continue;
      const createdAt = finiteNonNeg(r?.createdAt) ?? now();
      const status = clean(r?.status, 40);
      byId.set(id, {
        id,
        text,
        category: normalizeCategory(r?.category),
        sensitivity: normalizeSensitivity(r?.sensitivity),
        dueWindow: normalizeDueWindow(r?.dueWindow, createdAt),
        createdAt,
        updatedAt: finiteNonNeg(r?.updatedAt) ?? createdAt,
        status: STATUSES.has(status) ? status : 'open',
        ...(finiteNonNeg(r?.resolvedAt) !== undefined ? { resolvedAt: r.resolvedAt } : {}),
        ...(finiteNonNeg(r?.cancelledAt) !== undefined ? { cancelledAt: r.cancelledAt } : {}),
      });
    }
    seq = byId.size;
  }
  loadFromDisk();

  /** 生成唯一 id：注入的 idGen 撞号时追加序号兜底，绝不覆盖已有记录。 */
  function freshId() {
    let id = clean(idGen(), 120);
    if (!id) id = fallbackIdGen();
    while (byId.has(id)) {
      id = `${id}_${(seq += 1).toString(36)}`;
    }
    return id;
  }

  /** 返回对外快照（深拷贝 dueWindow），避免调用方改到内部状态。 */
  function snapshot(record) {
    return {
      ...record,
      dueWindow: { ...record.dueWindow },
    };
  }

  function transition(id, status, stampKey) {
    const record = byId.get(clean(id, 120));
    if (!record) return null;
    // 仅 open 可流转；已收口（done/cancelled）的记录幂等返回当前快照，不二次改时间戳。
    if (record.status !== 'open') return snapshot(record);
    record.status = status;
    record.updatedAt = now();
    record[stampKey] = record.updatedAt;
    persist();
    return snapshot(record);
  }

  return {
    /**
     * 新增一条承诺。text 必填（缺失抛错——空承诺无意义）；其余字段缺失走兜底。
     */
    add(input) {
      const src = input && typeof input === 'object' ? input : {};
      const text = clean(src.text);
      if (!text) {
        throw new Error('NoeCommitmentStore.add: text 不能为空');
      }
      const createdAt = now();
      const record = {
        id: freshId(),
        text,
        category: normalizeCategory(src.category),
        sensitivity: normalizeSensitivity(src.sensitivity),
        dueWindow: normalizeDueWindow(src.dueWindow, createdAt),
        createdAt,
        updatedAt: createdAt,
        status: 'open',
      };
      byId.set(record.id, record);
      persist();
      return snapshot(record);
    },

    /** 列出记录（可按 status 过滤）；非法 status 过滤值返回空列表。 */
    list(filter = {}) {
      const wanted = filter && filter.status !== undefined ? clean(filter.status, 40) : '';
      if (wanted && !STATUSES.has(wanted)) return [];
      const out = [];
      for (const record of byId.values()) {
        if (wanted && record.status !== wanted) continue;
        out.push(snapshot(record));
      }
      return out;
    },

    /**
     * 取出此刻「该提」的 open 项：nowMs 落在 [earliestMs, latestMs] 窗内，
     * 或已晚于 latestMs（兜底——错过窗口仍提，避免永久漏提；早于 earliestMs 才不提）。
     * 按 earliestMs 升序、同窗按 createdAt 升序排序，便于稳定优先级。
     */
    due(nowMs) {
      const t = finiteNonNeg(nowMs) ?? now();
      const out = [];
      for (const record of byId.values()) {
        if (record.status !== 'open') continue;
        if (t < record.dueWindow.earliestMs) continue; // 早于最早触发时刻，未到点。
        out.push(record);
      }
      out.sort(
        (a, b) =>
          a.dueWindow.earliestMs - b.dueWindow.earliestMs || a.createdAt - b.createdAt,
      );
      return out.map(snapshot);
    },

    /** 按 id 取单条快照；不存在返回 null。 */
    get(id) {
      const record = byId.get(clean(id, 120));
      return record ? snapshot(record) : null;
    },

    /** 标记完成：open → done。不存在返回 null；已收口幂等。 */
    resolve(id) {
      return transition(id, 'done', 'resolvedAt');
    },

    /** 取消：open → cancelled。不存在返回 null；已收口幂等。 */
    cancel(id) {
      return transition(id, 'cancelled', 'cancelledAt');
    },

    size() {
      return byId.size;
    },

    reset() {
      byId.clear();
      seq = 0;
      persist();
    },
  };
}
