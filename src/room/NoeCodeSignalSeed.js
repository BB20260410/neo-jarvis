// @ts-check
// NoeCodeSignalSeed — 路 2 真信号目标源的立项 wiring（叠加 inner thoughts，守 Neo 人格）。
//
// 把 NoeCodeQualitySignalScanner 扫出的真信号（缺 JSDoc 导出函数）→ 去重 → 立成 self_evolution goal。
// 设计要点（探索坐实）：
//   - 直接走 goalSystem.add（source='self_evolution' 已在 BACKLOG_EXEMPT_SOURCES，不受 maxBacklog 限），
//     绕过 observe 的严格单坑位 → 与诗性 inner thoughts goal 并存。observe 一行不动（守人格 + 克制）。
//   - 带 plan steps（feasible 杠杆）：arbitrate 算 priority = 0.5·源权重 + 0.2·新鲜 + 0.2·feasible(有steps=1/无=0.5) +
//     0.1·动量。真信号带 steps→feasible 1，诗性(buildSelfEvolutionGoal 无 steps)→feasible 0.5 → 真信号 priority 自然高、
//     被飞轮优先选。不改 add/arbitrate（priority 是 arbitrate 动态算，add 传 priority 会被覆盖，故用 feasible 杠杆）。
//   - 自带单坑位：已有「meta.signal 的 open/active 真信号 goal」则本轮不立（防真信号刷屏）；但只看 meta.signal，
//     诗性 goal（无 meta.signal）不挡真信号（守人格：真信号与诗性并存）。
//   - 去重：注入 recallRejectLessons（charDice≥0.85 近重复被拒 lesson）跳过注定被拒的；add 自带同名 open/active 去重。
//   - 纯 DI + fail-open：任何依赖抛错都不崩飞轮。

const SIGNAL_SOURCE = 'self_evolution'; // 必须 self_evolution 才被飞轮 openSelfEvolutionGoals 选中

export function createNoeCodeSignalSeed({
  scanner,
  goalSystem,
  listSourceFiles,
  recallRejectLessons = null,
  referenceProbe = null, // 引用性探针 (rel,root)=>{referenced}：跳过孤儿文件（给孤儿补 JSDoc 无价值会被 value gate 拦）。null=不过滤。
  root = process.cwd(),
  now = () => Date.now(),
} = {}) {
  // 单坑位：已有带 meta.signal 的 open/active 真信号 goal 在飞，本轮不立新（不挡无 meta.signal 的诗性 goal）。
  function hasInFlightSignalGoal() {
    try {
      const open = goalSystem.list({ status: 'open', limit: 200 }) || [];
      const active = goalSystem.list({ status: 'active', limit: 200 }) || [];
      return [...open, ...active].some((g) => g && g.source === SIGNAL_SOURCE && g.meta && g.meta.signal);
    } catch {
      return false; // fail-open：查不到当无在飞（宁可多立一个，不饿死真信号源）
    }
  }

  function runOnce({ limit = 20 } = {}) {
    if (hasInFlightSignalGoal()) return { ok: false, reason: 'signal_goal_in_flight' };
    let files;
    try { files = listSourceFiles() || []; } catch { return { ok: false, reason: 'list_files_failed' }; }
    let signals;
    try { ({ signals } = scanner.scan({ files, limit })); } catch { return { ok: false, reason: 'scan_failed' }; }
    if (!signals || !signals.length) return { ok: false, reason: 'no_signal' };

    // 选第一个「被引用 + 非近重复被拒」的信号
    let chosen = null;
    for (const sig of signals) {
      // 引用性过滤：跳过确认孤儿的文件（没被全仓 import）——给孤儿补 JSDoc 无价值、会被 value gate orphan_no_reference 拦，
      //   优先被引用文件（真嵌进系统的改进）。fail-open：探针异常不跳过（宁可试一把交 value gate 兜底，不饿死真信号源）。
      if (typeof referenceProbe === 'function') {
        let probe = null;
        try { probe = referenceProbe(sig.file, root); } catch { probe = null; }
        if (probe && probe.referenced === false) continue;
      }
      if (typeof recallRejectLessons === 'function') {
        let verdict = null;
        try { verdict = recallRejectLessons(sig.title); } catch { verdict = null; } // fail-open：记忆系统故障不挡飞轮
        if (verdict && verdict.similar === true) continue;
      }
      chosen = sig;
      break;
    }
    if (!chosen) return { ok: false, reason: 'all_near_duplicate' };

    // 文件级聚合：同文件所有缺 JSDoc 信号 → 一目标补多函数（别在同文件逐函数来回跑;qwen 隔离实测能一次产多 op·from 全准）。
    //   title 含紧凑多行 "X.js:75,208,283"→implementer readTargetFileContext 取覆盖所有函数的窗口。单函数则不聚合(title 不变)。
    const sameFile = signals.filter((s) => s.file === chosen.file);
    const title = sameFile.length > 1
      ? `为 ${sameFile.length} 个导出函数补 JSDoc：${chosen.file}:${sameFile.map((s) => s.line).join(',')}`
      : chosen.title;
    const goalId = goalSystem.add({
      title,
      source: SIGNAL_SOURCE,
      why: `代码质量真信号：${chosen.file} 有 ${sameFile.length} 个导出函数缺 JSDoc（含 src 路径+行号,readTargetFileContext 取覆盖窗口让 implementer 一次产多 op patch）`,
      // feasible 杠杆 + 给 cycle 一个明确动作锚（think 步,无执行副作用；真 implement 由 self-evolution cycle 据 title 产 patch）
      steps: [{ step: `为 ${chosen.file} 的 ${sameFile.length} 个函数补 JSDoc`, kind: 'think' }],
      meta: { signal: chosen.type, file: chosen.file, functions: sameFile.map((s) => ({ line: s.line, name: s.name })), discoveredAt: now() },
    });
    if (!goalId) return { ok: false, reason: 'add_rejected' };
    return { ok: true, goalId, signal: chosen, aggregated: sameFile.length };
  }

  return { runOnce };
}
