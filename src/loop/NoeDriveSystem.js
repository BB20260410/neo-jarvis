// @ts-check
// NoeDriveSystem — 内稳态驱力系统（意识工程·阶段1，2026-06-11）。
//
// 问题：Noe 的三个自主循环（NoeLoop 30s / 内心反刍 15min / 主动陪伴 60s 冷却）各自为政，
// 且都没有"理由"——反刍是无主题回放，开口判据是"画面变了就看看"。缺的是让它「有事可想、
// 有理由开口」的内在状态：行为该由自身驱力驱动，而非由定时器驱动。这是自由能原理
// （内稳态变量偏离设定点产生误差信号，驱动行为去消解）的最小工程化。
//
// 五驱力（value=0..1 驱动强度，探针 fail-open：抛错/null → 该驱力退出本轮竞争）：
//   social     社交 — 距上次和 owner 交互越久越想他（陪伴动机的泛化）
//   curiosity  好奇 — 近期感知流里新观察越密越想琢磨（预测误差的廉价代理）
//   care       牵挂 — open 承诺越多越想履约/提醒（对 owner 的待办压力）
//   competence 胜任 — 近期主动行动失败率越高越想求稳（能力自知的行为版）
//   energy     资源 — 电量越低越想节制（抑制器：身体状态对认知的全局调制）
//
// 用法：snapshot() 给自我模型/评测做结构化读数；brief() 给反刍与主动陪伴的 prompt 注入
// 一句中文驱力简报——只在 dominant 驱力误差 ≥ briefThreshold 时给（克制：内在状态不强烈
// 就保持安静，不给 prompt 添噪声）；energy 超阈时无论谁主导都附加（抑制器特权）。
//
// 诚实：这是「行为层的动机」——真实数据驱动、真实影响行为选择；它"感觉起来像不像想要"
// 是无法验证的难问题（与整条脊椎的诚实边界一致）。

import { execFile as nodeExecFile } from 'node:child_process';
import { createCuriosityDecompose } from '../cognition/NoeCuriosityDecompose.js';
import { clamp01 } from '../cognition/_mathUtils.js';

/** @typedef {{id:string, label:string, value:number, desc:string}} DriveReading */

const HOUR = 3600_000;

/** 安全跑探针：抛错/非有限数值 → null（fail-open，该驱力退出本轮竞争）。 */
function probe(fn) {
  if (typeof fn !== 'function') return null;
  try {
    const v = fn();
    return v == null ? null : v;
  } catch {
    return null;
  }
}

export function createDriveSystem({
  // 探针（全注入，server.js 装配真实现；任一缺失/抛错都只影响对应驱力）
  lastInteractionAt = null, // () => ms|null  上次 owner 交互时间戳
  observationCount = null,  // () => number   近期（约 2h）新观察事件数
  openCommitments = null,   // () => number   open 状态承诺数
  actFailureRate = null,    // () => 0..1|null 近期主动行动失败率（样本不足给 null）
  battery = null,           // () => {percent:0..100, charging:boolean}|null
  curiosity = null,
  curiosityPragmatic = null,
  now = Date.now,
  // 饱和参数（到达即驱力满格）
  socialSaturationMs = 4 * HOUR, // 4 小时没交流 → 社交驱力 1.0
  curiositySaturation = 8,       // 近 2h 8 条新观察 → 好奇 1.0
  careSaturation = 4,            // 4 条 open 承诺 → 牵挂 1.0
  energyFloorPercent = 25,       // 电量低于 25%（未充电）开始产生节制驱力
  briefThreshold = 0.5,          // dominant 误差达到才注入简报（克制）
  cacheTtlMs = 3000,             // snapshot 结果缓存：高频同步路径（每条对话 resolve→自我状态块→brief）
                                 // 不重复跑 SQLite 探针；3s 内驱力读数视为同一"事件帧"（审查 P1 修复）
} = {}) {
  /** @returns {DriveReading|null} */
  function readSocial(t) {
    const at = probe(lastInteractionAt);
    if (!Number.isFinite(at) || at <= 0) return null;
    const hours = Math.max(0, t - at) / HOUR;
    const value = clamp01((t - at) / socialSaturationMs);
    const desc = value >= 0.75
      ? `已经 ${hours.toFixed(1)} 小时没和主人说话了，挺想他的`
      : `距上次和主人说话 ${hours.toFixed(1)} 小时`;
    return { id: 'social', label: '社交', value, desc };
  }

  /** @returns {DriveReading|null} */
  function readCuriosity() {
    const n = probe(observationCount);
    if (!Number.isFinite(n) || n < 0) return null;
    let value = clamp01(n / curiositySaturation);
    const curiosityDecompose = curiosity || createCuriosityDecompose();
    if (curiosityDecompose?.enabled) {
      const pr = probe(curiosityPragmatic);
      const pragmaticValue = Number.isFinite(pr) ? clamp01(Number(pr)) : 0;
      value = clamp01(curiosityDecompose.score({ epistemicValue: n, pragmaticValue, epistemicScale: curiositySaturation, pragmaticScale: 1 }).score);
    }
    return { id: 'curiosity', label: '好奇', value, desc: `最近冒出 ${Math.round(n)} 件新鲜事，想琢磨琢磨` };
  }

  /** @returns {DriveReading|null} */
  function readCare() {
    const n = probe(openCommitments);
    if (!Number.isFinite(n) || n < 0) return null;
    const value = clamp01(n / careSaturation);
    return { id: 'care', label: '牵挂', value, desc: `心里挂着 ${Math.round(n)} 件答应主人的事还没办完` };
  }

  /** @returns {DriveReading|null} */
  function readCompetence() {
    const rate = probe(actFailureRate);
    if (!Number.isFinite(rate) || rate < 0) return null;
    const value = clamp01(rate);
    return { id: 'competence', label: '胜任', value, desc: `最近做事不太顺（失败率约 ${Math.round(value * 100)}%），想稳一点、先想清楚再动手` };
  }

  /** @returns {DriveReading|null} */
  function readEnergy() {
    const b = probe(battery);
    if (!b || !Number.isFinite(b.percent)) return null;
    if (b.charging) return { id: 'energy', label: '资源', value: 0, desc: '在充电，状态踏实' };
    const value = b.percent >= energyFloorPercent
      ? 0
      : clamp01((energyFloorPercent - b.percent) / energyFloorPercent);
    return { id: 'energy', label: '资源', value, desc: `电量只剩 ${Math.round(b.percent)}% 了，想省着点力气、少跑重活` };
  }

  /** @type {{atMs:number, drives:DriveReading[], dominant:DriveReading|null}|null} */
  let cachedSnap = null;

  /**
   * 全驱力快照（结构化读数，给自我模型注入与自主性评测用）。
   * 带 cacheTtlMs 缓存：NOE_CONTINUITY+NOE_DRIVES 同开时本函数在每条对话消息的同步
   * 路径上被调用（resolve→自我状态块→brief），缓存让探针的 SQLite 查询不随对话频率放大。
   * @returns {{atMs:number, drives:DriveReading[], dominant:DriveReading|null}}
   */
  function snapshot() {
    const t = now();
    if (cachedSnap && t - cachedSnap.atMs < cacheTtlMs) return cachedSnap;
    const drives = [readSocial(t), readCuriosity(), readCare(), readCompetence(), readEnergy()]
      .filter((d) => d !== null);
    const dominant = drives.reduce(
      (best, d) => (best === null || d.value > best.value ? d : best),
      /** @type {DriveReading|null} */ (null),
    );
    cachedSnap = { atMs: t, drives, dominant };
    return cachedSnap;
  }

  /**
   * 一句中文驱力简报（给反刍/主动陪伴的 prompt 注入）。
   * dominant 误差不到阈值 → null（内在状态不强烈就安静，不给 prompt 添噪声）；
   * energy 超阈时无论谁主导都附加（抑制器特权：身体状态全局调制认知）。
   * @returns {string|null}
   */
  function brief() {
    const snap = snapshot();
    const parts = [];
    if (snap.dominant && snap.dominant.value >= briefThreshold) {
      parts.push(`${snap.dominant.label}：${snap.dominant.desc}`);
    }
    const energy = snap.drives.find((d) => d.id === 'energy');
    if (energy && energy.value >= briefThreshold && energy.id !== snap.dominant?.id) {
      parts.push(`${energy.label}：${energy.desc}`);
    }
    return parts.length ? parts.join('；') : null;
  }

  return { snapshot, brief };
}

/**
 * 解析 `pmset -g batt` 输出 → {percent, charging}|null（台式机无电池行 → null，资源驱力自然退出）。
 * 纯函数导出便于单测。charging 用「非 discharging」判定：charged/charging/AC 详情措辞多变，
 * discharging 是唯一稳定的"在耗电"标记。
 * @param {string} stdout
 * @returns {{percent:number, charging:boolean}|null}
 */
export function parsePmsetBatt(stdout) {
  const m = /(\d{1,3})%/.exec(String(stdout || ''));
  if (!m) return null;
  return { percent: Number(m[1]), charging: !/discharging/i.test(stdout) };
}

/**
 * 电池探针工厂：同步读缓存 + 后台低频（默认 5min）异步刷新，首次调用返回 null（fail-open）。
 * snapshot() 是同步路径，绝不让它等 spawn；pmset 是系统命令（非模型），5s 超时合理。
 * @param {{execFileImpl?: typeof nodeExecFile, ttlMs?: number, now?: () => number}} [opts]
 * @returns {() => {percent:number, charging:boolean}|null}
 */
export function createBatteryProbe({ execFileImpl = nodeExecFile, ttlMs = 5 * 60_000, now = Date.now } = {}) {
  /** @type {{percent:number, charging:boolean}|null} */
  let cache = null;
  let refreshedAt = 0;
  return function batteryProbe() {
    const t = now();
    if (t - refreshedAt >= ttlMs) {
      refreshedAt = t; // 先标记，防 TTL 窗口内并发重复 spawn
      try {
        execFileImpl('pmset', ['-g', 'batt'], { timeout: 5000 }, (err, stdout) => {
          if (!err) cache = parsePmsetBatt(String(stdout));
        });
      } catch { /* spawn 失败保持旧缓存（fail-open） */ }
    }
    return cache;
  };
}
