// @ts-check
// NoeIntegrationHistory — 整合度 TC 读数的有限历史留存（P2 觉醒看板趋势线）。
//
// 为什么：NoeIntegrationSampler 只在 kv 存「最新读数」（noe.integration.reading），看不出趋势；
//   P2 看板要画整合度随时间的曲线。本模块把每拍读数 append 进有限长度历史。
//
// 纪律：注入式（kv + maxPoints + now）；只写自己的 kv 键（不碰 sampler 的 reading/window，零回归）；
//   有限长度（防无限增长）；record fail-open（坏 reading 静默跳过不抛、不污染历史）。

const KV_HISTORY = 'noe.integration.history.v1';

/**
 * @param {object} opts
 * @param {{get:(k:string)=>any, set:(k:string,v:any)=>any}} opts.kv
 * @param {number} [opts.maxPoints]  历史上限（2..2000，默认 288 ≈ 24h@5min）
 * @param {() => number} [opts.now]
 */
export function createIntegrationHistory({ kv, maxPoints = 288, now = Date.now } = {}) {
  if (!kv || typeof kv.get !== 'function') {
    throw new Error('createIntegrationHistory: kv.get required');
  }
  const canWrite = typeof kv.set === 'function'; // 只读 kv（如 mind route 的 {get} deps）可 read 不可 record
  const cap = Math.max(2, Math.min(2000, Math.round(Number(maxPoints)) || 288));

  function readRaw() {
    const raw = kv.get(KV_HISTORY);
    return Array.isArray(raw) ? raw.filter((p) => p && Number.isFinite(p.ts) && Number.isFinite(p.integration)) : [];
  }

  /**
   * append 一拍读数（来自 sampler.sample()）。无效读数（缺 integration）静默跳过。
   * @param {{ts?:number, integration:number, totalCorrelation?:number, samples?:number}} reading
   */
  function record(reading) {
    if (!canWrite) return null; // 只读 kv 不留存（read-only 消费方安全降级）
    if (!reading || typeof reading !== 'object') return null;
    if (!Number.isFinite(reading.integration)) return null;
    const ts = Number.isFinite(reading.ts) ? reading.ts : now();
    const point = {
      ts,
      integration: Math.round(Number(reading.integration) * 1000) / 1000,
      totalCorrelation: Math.round(Number(reading.totalCorrelation || 0) * 1000) / 1000,
      samples: Math.max(0, Math.round(Number(reading.samples) || 0)),
    };
    const hist = readRaw();
    hist.push(point);
    while (hist.length > cap) hist.shift();
    kv.set(KV_HISTORY, hist);
    return point;
  }

  /**
   * 读历史趋势（mind 趋势线数据源）。
   * @param {{limit?:number, sinceTs?:number}} [opts]
   */
  function read({ limit = 288, sinceTs = 0 } = {}) {
    const lim = Math.max(1, Math.min(2000, Math.round(Number(limit)) || 288));
    return readRaw().filter((p) => p.ts >= sinceTs).slice(-lim);
  }

  return { record, read };
}
