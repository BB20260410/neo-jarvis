// @ts-check
// 本地屏幕活动编年史 —— Codex Chronicle 的全本地替代。
//
// 背景：Codex 桌面 app 的 Chronicle 后台被动截屏 + 喂【云端】AI 生成「你在干什么」的记忆，
// 24/7 烧 OpenAI 额度且不可换本地模型（2026-06-15 owner 确认非本人设置、已关云版）。
// 本模块用 Neo 现成组件做等价能力，但全本地：
//   截屏(ScreenCapturer) → 本地 VLM 摘要(LocalVlmClient/LM Studio) → 沉淀(EpisodicTimeline observation)。
// 全本地、不出本机、不存原始帧（只留文本摘要）；喂 Neo 主动陪伴 + 预测 owner 行为这条主线。
//
// 设计：纯调度器，只管「定时 + 去重 + 沉淀」，截屏/VLM/变化检测全复用 VisionSession.glance
// （它已有帧 hash 变化检测做 no_change 去重 + 程序名消毒）。env NOE_SCREEN_CHRONICLE=1 默认 OFF。
// 注入式 + fail-open：observe/record/timer 全可注入；任一 tick 出错只 log 不崩、不阻断主进程。

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000; // 10 分钟，对齐 Codex Chronicle 节奏

/**
 * @param {object} deps
 * @param {() => Promise<{summary?:string, skipped?:string, at?:number, mode?:string}|null>} deps.observe
 *   观察一次（通常 = visionSession.glance）；返回 {summary, skipped?, at, mode}。
 * @param {(summary:string, meta:object) => void} deps.recordObservation
 *   沉淀一条观察记忆（通常包装 episodicTimeline.record({type:'observation',...})）。
 * @param {number} [deps.intervalMs]
 * @param {boolean} [deps.enabled] 默认读 env NOE_SCREEN_CHRONICLE==='1'（OFF）。
 * @param {((msg:string)=>void)|null} [deps.logger]
 * @param {Function} [deps.setTimer] 默认 setInterval（单测可注入假定时器）。
 * @param {Function} [deps.clearTimer] 默认 clearInterval。
 */
export function createNoeScreenChronicle({
  observe,
  recordObservation,
  intervalMs = DEFAULT_INTERVAL_MS,
  enabled = process.env.NOE_SCREEN_CHRONICLE === '1',
  logger = null,
  setTimer = setInterval,
  clearTimer = clearInterval,
} = {}) {
  let timer = null;
  let lastSummary = null;
  const log = (m) => { try { logger?.(m); } catch { /* logger 不该影响主流程 */ } };

  async function tick() {
    try {
      if (typeof observe !== 'function' || typeof recordObservation !== 'function') return;
      const r = await observe();
      if (!r || !r.summary) return;
      // 屏幕没变(no_change)/视觉关闭(vision_off) → 不沉淀，避免时间线灌水
      if (r.skipped === 'no_change' || r.skipped === 'vision_off') return;
      if (r.summary === lastSummary) return; // 二次去重：摘要文本完全相同也不重复记
      lastSummary = r.summary;
      recordObservation(r.summary, { source: 'screen_chronicle', at: r.at ?? null, mode: r.mode ?? 'screen' });
      log(`[screen-chronicle] 记录观察: ${String(r.summary).slice(0, 40)}`);
    } catch (e) {
      log(`[screen-chronicle] tick 出错(已忽略): ${e && e.message ? e.message : e}`);
    }
  }

  return {
    enabled,
    /** 启动定时观察；env OFF 或已在跑 → no-op 返回 false。 */
    start() {
      if (!enabled || timer) return false;
      timer = setTimer(() => { tick(); }, intervalMs);
      if (timer && typeof timer.unref === 'function') timer.unref(); // 不阻止进程退出
      log(`[screen-chronicle] 已启动，每 ${Math.round(intervalMs / 1000)}s 全本地观察一次`);
      return true;
    },
    /** 停止定时。 */
    stop() {
      if (timer) { clearTimer(timer); timer = null; return true; }
      return false;
    },
    /** 手动触发一次（最小试点 / 单测用）。 */
    tickOnce: tick,
    status() {
      return { enabled, running: timer !== null, intervalMs, lastSummary };
    },
  };
}
