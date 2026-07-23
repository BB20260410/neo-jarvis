// NoeHangAlert — 长跑任务心跳监控：无心跳超阈值「告警」而非「杀」，有心跳续命。
//
// 呼应 feedback_no_model_timeout（跑模型 / agent 不设硬超时——超时会误切断 / 误判失败；
//   一次运行多久不可预测）。正确姿势：长跑任务定期上报心跳，无心跳超 N 分钟才「告警」（提醒人看一眼），
//   有心跳则续命；绝不自动杀。把「是否真卡死」的判断权交还给人，而非定时器。
//
// 来自 Mavis hang_alert + extend-timeout。纯逻辑、注入式时间源，可独立单测。

/**
 * 创建心跳监控器。
 * @param {object} [opts]
 * @param {() => number} [opts.now] 时间源（默认 Date.now）。
 * @param {number} [opts.alertAfterMs] 无心跳多久后告警（默认 5 分钟）。
 */
export function createHangAlertMonitor({ now = () => Date.now(), alertAfterMs = 5 * 60 * 1000 } = {}) {
  /** @type {Map<string, {startedAt:number, lastBeat:number, meta:object, alerted:boolean}>} */
  const tasks = new Map();

  return {
    /** 登记一个长跑任务。 */
    start(taskId, meta = {}) {
      const id = String(taskId ?? '').trim();
      if (!id) return false;
      const t = now();
      tasks.set(id, { startedAt: t, lastBeat: t, meta: meta && typeof meta === 'object' ? meta : {}, alerted: false });
      return true;
    },
    /** 心跳续命：刷新最后心跳时间，清掉告警标记。 */
    beat(taskId) {
      const t = tasks.get(String(taskId ?? '').trim());
      if (!t) return false;
      t.lastBeat = now();
      t.alerted = false;
      return true;
    },
    /** 任务结束，移除监控。 */
    done(taskId) {
      return tasks.delete(String(taskId ?? '').trim());
    },
    /**
     * 检查所有任务，返回无心跳超阈值者（告警，绝不杀）。
     * firstAlert=true 表示本次是该任务首次告警（供调用方只在首次提醒，避免刷屏）。
     */
    check() {
      const stale = [];
      const t = now();
      for (const [id, task] of tasks) {
        const silentMs = t - task.lastBeat;
        if (silentMs > alertAfterMs) {
          stale.push({ taskId: id, silentMs, runningMs: t - task.startedAt, meta: task.meta, firstAlert: !task.alerted });
          task.alerted = true;
        }
      }
      return stale;
    },
    active() { return [...tasks.keys()]; },
    size() { return tasks.size; },
    reset() { tasks.clear(); },
  };
}
