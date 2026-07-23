// @ts-check
// NoeIntegrationSampler — 把整合度代理读数（NoeIntegrationMetric / 多信息 Total Correlation，
//   非完整 IIT Φ）接进运行时（路线图阶段 A 头号任务：让「写了测了从未接线」的整合度机制真活）。
//
// 问题：integrationMetric 算的是「跨时间多样本」的 TC（要求 samples>=2），单拍心跳只给一行。
// 设计：每拍采 8 个宏节点（GWT 焦点 / 情感 VAD 偏离 / 期望到期 / 驱力 / 感知 / 目标步 / 自语 / 梦）
//   二值化向量 → push 进持久滚动窗口（kv）→ 对窗口跑 integrationMetric → 读数写 kv 供 mind 消费。
//   TC 高 = 子系统高度耦合同步（联合熵 ≪ 边际熵和）= 全局工作区把多源整合成统一内容。
// 纪律：注入式（signals 8 个 getter + kv + now + windowSize 全注入，可确定性测）；探针 fail-open
//   （抛错/缺失 → 该节点 0，不阻断心跳）；纯增量、只读各子系统、只写自己的 kv 键。

import { integrationMetric, integrationLabel } from './NoeIntegrationMetric.js';

// 8 宏节点固定顺序（窗口里每行向量按此排列；nodeOrder 随读数一起暴露，供透视页对齐解读）。
export const INTEGRATION_NODE_ORDER = Object.freeze([
  'gwt_focus', 'vad_deviation', 'expectation_due', 'drive',
  'percept', 'goal_step', 'self_talk', 'dream',
]);

const KV_WINDOW = 'noe.integration.window';
const KV_READING = 'noe.integration.reading';

/**
 * @param {object} opts
 * @param {Record<string, () => any>} opts.signals 8 宏节点探针（键见 INTEGRATION_NODE_ORDER；真值→1）
 * @param {{get:(k:string)=>any, set:(k:string,v:any)=>any}} opts.kv 读数 / 滚动窗口落点
 * @param {() => number} [opts.now]
 * @param {number} [opts.windowSize] 滚动窗口最多保留多少拍（2..200，默认 24）
 */
export function createIntegrationSampler({
  signals,
  kv,
  now = Date.now,
  windowSize = 24,
} = {}) {
  if (!signals || typeof signals !== 'object') throw new Error('createIntegrationSampler: signals(注入式信号探针) required');
  if (!kv || typeof kv.get !== 'function' || typeof kv.set !== 'function') throw new Error('createIntegrationSampler: kv{get,set} required');
  const size = Math.max(2, Math.min(200, Number(windowSize) || 24));

  // 单探针：缺失 / 抛错 → 0（fail-open，不阻断心跳，也不污染窗口为 NaN）。
  function probe(name) {
    const fn = signals[name];
    if (typeof fn !== 'function') return 0;
    try { return fn() ? 1 : 0; } catch { return 0; }
  }

  function sampleVector() {
    return INTEGRATION_NODE_ORDER.map((name) => probe(name));
  }

  // 读回窗口并剔除脏行（长度不符的旧/坏数据），防止跨版本节点数变化时算崩。
  function readWindow() {
    const raw = kv.get(KV_WINDOW);
    if (!Array.isArray(raw)) return [];
    return raw.filter((r) => Array.isArray(r) && r.length === INTEGRATION_NODE_ORDER.length);
  }

  /** 采一拍：append 向量 → 裁窗 → 算 TC → 写读数。返回本拍读数。 */
  function sample() {
    const t = now();
    const vec = sampleVector();
    const win = readWindow();
    win.push(vec);
    while (win.length > size) win.shift();
    kv.set(KV_WINDOW, win);

    const m = integrationMetric(win);
    const reading = {
      ts: t,
      ok: m.ok,
      integration: Math.round((m.integration || 0) * 1000) / 1000,
      totalCorrelation: Math.round((m.totalCorrelation || 0) * 1000) / 1000,
      label: m.ok ? integrationLabel(m.integration) : '无数据',
      nodes: INTEGRATION_NODE_ORDER.length,
      samples: m.samples || win.length,
      lastVector: vec,
      nodeOrder: INTEGRATION_NODE_ORDER,
    };
    kv.set(KV_READING, reading);
    return reading;
  }

  /** 读回最近读数（mind/overview 走 kv 直读；此方法供测试 / 其他消费方）。 */
  function latest() {
    const r = kv.get(KV_READING);
    return r && typeof r === 'object' ? r : null;
  }

  return { sample, latest, sampleVector };
}
