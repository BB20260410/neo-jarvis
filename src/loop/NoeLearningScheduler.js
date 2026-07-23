// @ts-check
// NoeLearningScheduler — 定时学习调度编排（P4）。复刻 OpenClaw timer.ts 的"取到点任务→跑→算下次"，
//   但【串行】跑(尊重 NoeHeartbeat 串行链特性；学习多调本地脑，并发会撞 LM Studio——不照搬 OpenClaw worker 池)。
//   下次时间/失败退避/成效自适应全用 NoeLearningSchedule 纯函数。注入式：store/runLearnOnce/circadian。
import { computeNextRunAtMs, errorBackoffMs, adaptiveCadenceMs } from './NoeLearningSchedule.js';

const DEFAULT_MAX_ATTEMPTS = 3;

function clamp01(x) { return Math.min(1, Math.max(0, Number(x) || 0)); }
function safe(fn) { try { return fn(); } catch { return null; } }

export function createLearningScheduler({
  store = null,
  runLearnOnce = null,   // async (job) => { learned:bool, lesson?:string } | { error:string }；并发跳过返回 {skipped:true}
  circadian = null,      // { isQuiet(now):bool } 夜间降频（可选）
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  backoffTable = undefined,
  now = Date.now,
} = {}) {
  const maxAtt = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);

  /** 成功后算下次时间 + 更新成效(mastery 学会了↑/idle 学不动↑)。 */
  function planNextOnSuccess(job, learned, t) {
    const mastery = clamp01((Number(job.mastery) || 0) + (learned ? 0.1 : -0.02));
    const idle = learned ? 0 : (Number(job.consecutive_idle) || 0) + 1;
    const quiet = circadian && typeof circadian.isQuiet === 'function' ? Boolean(safe(() => circadian.isQuiet(t))) : false;
    const baseEvery = Number(job.every_ms) || 3600_000;
    // mastery 只记录成效(可观测)，【不】喂 cadence——M3 红队 serious#3：mastery 仅"立项成功次数"代理，与"是否
    //   产出可召回知识"无关，用它拉长间隔=惩罚成功(学会反而少学)。节奏只按 idle 退避+夜间(回 OpenClaw 失败退避原语义)。
    const adaptiveEvery = adaptiveCadenceMs(baseEvery, { mastery: 0, consecutiveIdle: idle, quiet });
    const next = job.kind === 'at'
      ? null  // 一次性学完 → disable
      : computeNextRunAtMs({ kind: job.kind, everyMs: adaptiveEvery, anchorMs: Number(job.anchor_ms) || t, cronExpr: job.cron_expr, tz: job.tz }, t);
    return { mastery, idle, next };
  }

  function applyOutcome(job, outcome, t) {
    if (!outcome || outcome.skipped) return; // 并发跳过：不动游标
    if (outcome.error) {                      // 失败 → 退避（OpenClaw）
      const ce = (Number(job.consecutive_errors) || 0) + 1;
      const next = t + errorBackoffMs(ce, backoffTable);
      store.failRun(job.id, outcome.error, next, ce, t);
      if (ce >= maxAtt) store.setEnabled(job.id, 0, t); // 反复失败 auto-disable
      return;
    }
    const learned = outcome.learned === true;
    const { mastery, idle, next } = planNextOnSuccess(job, learned, t);
    store.finishRun(job.id, { learned, mastery, consecutiveIdle: idle, nextRunAtMs: next }, t);
  }

  /** 心跳驱动一跳：恢复死锁 → 取到点任务 → 串行跑（beginRun CAS 锁 + runLearnOnce + applyOutcome）。 */
  async function tick(t = now()) {
    if (!store?.dueJobs) return { ran: 0, recovered: 0, due: 0 };
    let recovered = 0;
    try { recovered = store.recoverStuck(t); } catch { /* 恢复失败不阻断 */ }
    const due = safe(() => store.dueJobs(t)) || [];
    let ran = 0;
    for (const job of due) {
      if (!store.beginRun(job.id, t)) continue; // 已被锁（并发）跳过
      let outcome = { skipped: false };
      try {
        outcome = typeof runLearnOnce === 'function' ? ((await runLearnOnce(job)) || { learned: false }) : { error: 'no_runner' };
      } catch (e) { outcome = { error: String((e && e.message) || e || 'learn_error').slice(0, 200) }; }
      try { applyOutcome(job, outcome, t); } catch { /* 落账失败不阻断本跳其余任务 */ }
      ran += 1;
    }
    return { ran, recovered, due: due.length };
  }

  /** 运行时动态加学习任务（算首次 next 后入库）。是 maybeSeedAutonomousLearning 的升级替代。 */
  function addLearningJob(spec = {}) {
    if (!store?.addJob) return null;
    const t = now();
    // firstDelayMs：首次运行延迟(让点火后较快跑第一次,而非等满一个 every 周期)；否则按 schedule 算下一个间隔点。
    const next = spec.firstDelayMs != null
      ? t + Math.max(0, Number(spec.firstDelayMs) || 0)
      : computeNextRunAtMs({ kind: spec.kind || 'every', everyMs: spec.everyMs, anchorMs: spec.anchorMs != null ? spec.anchorMs : t, atMs: spec.atMs, cronExpr: spec.cronExpr, tz: spec.tz }, t);
    return store.addJob({ ...spec, nextRunAtMs: next }, t);
  }

  return { tick, addLearningJob, applyOutcome, planNextOnSuccess };
}
