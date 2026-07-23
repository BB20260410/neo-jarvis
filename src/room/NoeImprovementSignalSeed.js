// @ts-check
// NoeImprovementSignalSeed — P2 多元真信号立项：把 NoeCodeImprovementScanner 的 stale_todo/high_complexity/test_gap
//   信号 → self_evolution goal（叠加 missing_jsdoc/诗性/失败教训，扩展飞轮「该改什么」的视野）。
// 设计仿 NoeCodeSignalSeed：单坑位（只看自己这三类信号，不挡 missing_jsdoc/诗性/failure_lesson）、引用性过滤跳孤儿、
//   近重复去重、feasible 杠杆（带 steps → arbitrate priority 高）、直接走 goalSystem.add（绕 observe 单坑位）。
// flag NOE_CODE_IMPROVEMENT_SIGNALS 默认 OFF。纯 DI + fail-open。立的目标价值由 P0 度量验证（哪类信号真带来改善）。

const SIGNAL_SOURCE = 'self_evolution';
const IMPROVEMENT_SIGNALS = new Set(['stale_todo', 'high_complexity', 'test_gap']);

export function createImprovementSignalSeed({
  scanner,
  goalSystem,
  listSourceFiles,
  signalTypes = ['stale_todo', 'high_complexity', 'test_gap'],
  recallRejectLessons = null,
  referenceProbe = null,
  recentlyAttempted = null, // (type, file) => bool：同信号同文件最近冷却窗内立过 → 跳过（防反复撞改不动的目标空转）
  root = process.cwd(),
  now = () => Date.now(),
} = {}) {
  // 单坑位：已有 meta.signal ∈ {stale_todo,high_complexity,test_gap} 的 open/active goal 在飞 → 本轮不立。
  //   只看这三类（不挡 missing_jsdoc 真信号 / 诗性 / failure_lesson，各信号源并行供给）。
  function hasInFlightSignalGoal() {
    try {
      const open = goalSystem.list({ status: 'open', limit: 200 }) || [];
      const active = goalSystem.list({ status: 'active', limit: 200 }) || [];
      return [...open, ...active].some((g) => g && g.source === SIGNAL_SOURCE && g.meta && IMPROVEMENT_SIGNALS.has(g.meta.signal));
    } catch { return false; } // fail-open
  }

  function runOnce({ limit = 100, maxComplexity = 25, signalPriority = [] } = {}) {
    if (process.env.NOE_CODE_IMPROVEMENT_SIGNALS !== '1') return { ok: false, skipped: 'flag_off' };
    if (!goalSystem || typeof goalSystem.add !== 'function') return { ok: false, skipped: 'no_goalsystem' };
    if (hasInFlightSignalGoal()) return { ok: false, reason: 'signal_goal_in_flight' };

    let files;
    try { files = listSourceFiles() || []; } catch { return { ok: false, reason: 'list_files_failed' }; }
    let signals;
    // priorityTypes 透传给 scanner：让「limit 截断」本身就按优先级取，否则稀缺信号（test_gap 全库仅几十个）
    //   会被排在前面文件的海量 high_complexity 占满 limit、永远扫不到——此时在结果上再排序也救不回被截掉的。
    try { ({ signals } = scanner.scan({ files, signalTypes, limit, priorityTypes: signalPriority })); } catch { return { ok: false, reason: 'scan_failed' }; }
    if (!signals || !signals.length) return { ok: false, reason: 'no_signal' };

    // 按信号类型优先级排序（signalPriority 在前的类型先选；同级保持扫描顺序，V8 sort 稳定）。
    //   让调用方可优先某类信号——如优先 test_gap 补测试覆盖（A2 放开新增测试后激活），而非总被 high_complexity 占满 limit。
    let ordered = signals;
    if (Array.isArray(signalPriority) && signalPriority.length) {
      const rank = (t) => { const i = signalPriority.indexOf(t); return i === -1 ? signalPriority.length : i; };
      ordered = [...signals].sort((a, b) => rank(a.type) - rank(b.type));
    }
    // 选第一个「被引用 + 非近重复被拒 + 非冷却」的信号。
    let chosen = null;
    for (const sig of ordered) {
      // 跳过复杂度过高的 high_complexity（cx>maxComplexity，M3/本地都难一次改对，留给人或更强模型）。
      //   P2 先摘 M3 改得动的低垂果实——供给「能成功的真目标」比供给「改不动的难目标」更有价值（防空转）。
      if (sig.type === 'high_complexity' && Number(sig.complexity) > maxComplexity) continue;
      if (typeof referenceProbe === 'function') {
        let probe = null;
        try { probe = referenceProbe(sig.file, root); } catch { probe = null; }
        if (probe && probe.referenced === false) continue; // 孤儿文件跳过（改它无价值）
      }
      if (typeof recallRejectLessons === 'function') {
        let verdict = null;
        try { verdict = recallRejectLessons(sig.title); } catch { verdict = null; }
        if (verdict && verdict.similar === true) continue;
      }
      // 同信号同文件冷却：最近立过同 (type, file) 的目标 → 跳过，避免反复撞同一个改不动/双绿门难过的目标空转。
      if (typeof recentlyAttempted === 'function') {
        let cooling = false;
        try { cooling = recentlyAttempted(sig.type, sig.file) === true; } catch { cooling = false; }
        if (cooling) continue;
      }
      chosen = sig;
      break;
    }
    if (!chosen) return { ok: false, reason: 'all_filtered' };

    const goalId = goalSystem.add({
      title: String(chosen.title || '').slice(0, 120),
      source: SIGNAL_SOURCE,
      why: `代码改进真信号（${chosen.type}）：${chosen.file}${chosen.line ? `:${chosen.line}` : ''}`,
      steps: [{ step: String(chosen.title || '').slice(0, 100), kind: 'think' }], // feasible 杠杆 + 动作锚
      meta: { signal: chosen.type, file: chosen.file, line: chosen.line || null, discoveredAt: now() },
    });
    if (!goalId) return { ok: false, reason: 'add_rejected' };
    return { ok: true, goalId, signal: chosen };
  }

  return { runOnce };
}
