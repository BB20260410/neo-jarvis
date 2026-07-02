// NoeActiveJobGuard — 活跃任务并发守卫，防长跑任务被重复触发后并发跑两轮。
//
// 问题：self-evolution（自我进化）、core-consensus（三方核心共识轮）等任务，
//   既能被 cron 周期触发、又能被用户 / 接口手动触发。前一轮还没跑完时第二路叠加进来 →
//   同一逻辑并发跑两份：白烧模型配额、写盘互踩、产出错乱、ledger 双写。
// 方案：按 jobKey 维护一份「正在跑」表。进入前 acquire——已活跃则直接跳过（不跑 fn），
//   未活跃则标记活跃 → 跑 fn → 无论成功 / 抛错都在 finally 释放。
//
// 释放正确性（关键）：每次 acquire 生成一个唯一 token（Symbol）写入 表[key]。finally 只在
//   表[key] 仍是「自己这一代」的 token 时才删除。这样即便中途有人 release(key) 强制释放、
//   随后第二路重新 acquire 了同一 key，旧那一代的 finally 也不会误删新持有者的标记
//   （Symbol 全局唯一，跨 guard 实例不碰撞）。
//
// 注入式：活跃表可注入（默认用 globalThis 上 Symbol.for('noe.activeJobs') 的进程级单例 Map，
//   使分散在不同模块的 import 共享同一份「谁在跑」视图；不注入时惰性取全局，避免缓存旧引用脱钩）；
//   测试注入独立 Map 保确定性、互不污染。自包含、无外部 I/O。
//
// 实现自 Mavis `withActiveGuard` 思路（read-only 借鉴并发去重原语，非代码移植）。

const ACTIVE_JOBS_SYMBOL = Symbol.for('noe.activeJobs');

/**
 * 取进程级共享的活跃任务表（懒建）。键是 jobKey，值是当前持有者的唯一 token（Symbol）。
 * 不同模块各自 import 本文件时，都拿到同一个 globalThis 上的 Map，对「谁在跑」有一致视图。
 * @returns {Map<string, symbol>}
 */
export function getGlobalActiveJobStore() {
  if (!(globalThis[ACTIVE_JOBS_SYMBOL] instanceof Map)) {
    globalThis[ACTIVE_JOBS_SYMBOL] = new Map();
  }
  return globalThis[ACTIVE_JOBS_SYMBOL];
}

/**
 * 创建一个活跃任务守卫实例。
 *
 * @param {object} [deps]
 * @param {Map<string, symbol>} [deps.store] 活跃表，注入式（默认进程级全局单例）。测试请注入独立 Map。
 * @returns {{
 *   run: (key: string, fn: () => any, opts?: {onSkip?: (key:string)=>void, throwOnConflict?: boolean}) => Promise<object>,
 *   isActive: (key: string) => boolean,
 *   activeKeys: () => string[],
 *   size: () => number,
 *   release: (key: string) => boolean,
 *   reset: () => void,
 * }}
 */
export function createActiveJobGuard(deps = {}) {
  // 注入则固定用注入表；否则每次惰性取全局单例（不缓存引用，避免全局被替换后脱钩）。
  const injected = deps.store instanceof Map ? deps.store : null;
  const store = () => injected || getGlobalActiveJobStore();

  function normKey(key) {
    return typeof key === 'string' ? key.trim() : '';
  }

  function isActive(key) {
    const k = normKey(key);
    return k !== '' && store().has(k);
  }

  /**
   * 在守卫下执行 fn。
   * - 无有效 key → 无法守卫，直接执行（放行，不计入活跃表，`guarded:false`）。
   * - key 已活跃 → 不执行 fn；先调 onSkip（若有），再按 throwOnConflict 决定抛错或返回 `skipped:true`。
   * - 否则用唯一 token 标记活跃 → await fn() → finally 仅在标记仍是自己这一代时释放。
   *
   * fn 抛错时异常照常向调用方透传（与放行路径一致）；finally 只负责释放标记。
   *
   * @returns {Promise<{key:string, started:boolean, skipped:boolean, guarded:boolean, result?:any, reason?:string}>}
   */
  async function run(key, fn, opts = {}) {
    if (typeof fn !== 'function') {
      throw new TypeError('createActiveJobGuard.run: fn 必须是函数');
    }
    const k = normKey(key);

    // 无 key：没有可去重的身份维度，按放行执行处理（不进表）。
    if (!k) {
      const result = await fn();
      return { key: '', started: true, skipped: false, guarded: false, result };
    }

    const s = store();
    if (s.has(k)) {
      // 先通知（无论是否 throwOnConflict 都会调用 onSkip，避免「抛错时漏掉通知」的坑）。
      if (typeof opts.onSkip === 'function') {
        try {
          opts.onSkip(k);
        } catch {
          /* onSkip 仅作通知；其异常不应改变守卫语义，吞掉。 */
        }
      }
      if (opts.throwOnConflict) {
        throw new Error(`active job already running: ${k}`);
      }
      return { key: k, started: false, skipped: true, guarded: true, reason: 'already-active' };
    }

    const token = Symbol('noe.job'); // 本次 acquire 的唯一身份，全局不碰撞。
    s.set(k, token);
    try {
      const result = await fn();
      return { key: k, started: true, skipped: false, guarded: true, result };
    } finally {
      // 仅当表里仍是「自己这一代」的 token 才释放——否则说明中途已被 release/reset 后被他人重新 acquire，
      // 此时绝不能删，否则会误放他人持有的标记导致守卫失效。
      if (s.get(k) === token) s.delete(k);
    }
  }

  return {
    run,
    isActive,
    activeKeys() {
      return [...store().keys()];
    },
    size() {
      return store().size;
    },
    /** 强制释放某 key（仅作卡死兜底；正常路径由 run 的 finally 自动释放）。 */
    release(key) {
      const k = normKey(key);
      if (!k) return false;
      return store().delete(k);
    },
    /**
     * 清空守卫表。
     * ⚠️ 注入独立 store（测试）时安全；用默认全局单例时会清掉全进程的活跃标记，生产勿调。
     *   （在跑的 run() 因 token 比对失败不会误删他人，但 isActive 视图会被清空。）
     */
    reset() {
      store().clear();
    },
  };
}

// 进程级默认守卫单例：跨模块 import 共享同一全局表。
let _globalGuard = null;

/**
 * 便捷入口：用进程级全局守卫执行 fn（最常用）。
 * 适合直接包住 self-evolution / consensus 等长跑入口：
 *   `await withActiveGuard('self-evolution', () => runSelfEvolution())`
 */
export function withActiveGuard(key, fn, opts) {
  if (!_globalGuard) _globalGuard = createActiveJobGuard();
  return _globalGuard.run(key, fn, opts);
}
