// @ts-check
// NoeFocusStack（P3-1 工作记忆栈）——当前任务的工作记忆有界、可压栈/弹栈，防上下文漂移。
//
// 设计：栈式工作记忆。push 进入子任务焦点、pop 回上层；栈深上限 maxDepth；溢出时**保住主线（栈底 root）+
//   最近若干帧**，把被挤掉的中段摘要进 overflowSummaries（不丢主线、不无界膨胀）。与 GWT 注意力联动：
//   current() 给 NoeWorkspace 当前焦点候选；returnToMainLine() 回主线。
// 纯内存、确定性、零付费依赖；DI（now/summarize）便于单测。

function clean(v, max = 280) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * @param {{ maxDepth?: number, now?: () => number, summarize?: (frames:Array)=>string }} deps
 */
export function createNoeFocusStack({ maxDepth = 8, now = () => Date.now(), summarize = null } = {}) {
  const cap = Math.max(2, Math.min(64, Math.trunc(Number(maxDepth) || 8)));
  const stack = [];               // [{ focus, context, ts }]，stack[0]=主线 root
  const overflowSummaries = [];   // 被挤掉中段的摘要（不丢主线）

  function push({ focus = '', context = '' } = {}) {
    const f = clean(focus, 280);
    if (!f) return { ok: false, reason: 'empty_focus' };
    const frame = { focus: f, context: clean(context, 500), ts: Number(typeof now === 'function' ? now() : now) || 0 };
    stack.push(frame);
    let overflowed = 0;
    if (stack.length > cap) {
      // 溢出：保住 root(stack[0]) + 最近 (cap-1) 帧；摘要被挤掉的中段。
      const removeCount = stack.length - cap;
      const removed = stack.splice(1, removeCount);
      const summary = typeof summarize === 'function'
        ? summarize(removed)
        : removed.map((x) => x.focus).join(' → ');
      overflowSummaries.push({ at: frame.ts, count: removed.length, summary: clean(summary, 500) });
      if (overflowSummaries.length > 50) overflowSummaries.splice(0, overflowSummaries.length - 50); // 内部数组有界（防长跑无界增长，红队修复）
      overflowed = removed.length;
    }
    return { ok: true, depth: stack.length, frame, overflowed };
  }

  // 弹出当前焦点，回到上层；返回 { popped, current }。
  function pop() {
    if (stack.length === 0) return { ok: false, reason: 'empty', popped: null, current: null };
    const popped = stack.pop();
    return { ok: true, popped, current: stack[stack.length - 1] || null, depth: stack.length };
  }

  function current() { return stack.length ? stack[stack.length - 1] : null; }
  function mainLine() { return stack.length ? stack[0] : null; } // 主线=栈底 root，溢出永不丢

  // 回主线：弹到只剩 root（子任务全部收起，焦点回到最初目标）。返回收起的帧数。
  function returnToMainLine() {
    if (stack.length <= 1) return { ok: true, collapsed: 0, current: stack[0] || null };
    const collapsed = stack.length - 1;
    stack.splice(1); // 保留 root
    return { ok: true, collapsed, current: stack[0] };
  }

  function snapshot() {
    return {
      depth: stack.length,
      maxDepth: cap,
      current: current(),
      mainLine: mainLine(),
      stack: stack.map((f) => ({ focus: f.focus, ts: f.ts })),
      overflowSummaries: overflowSummaries.slice(-10),
    };
  }

  function clear() { stack.length = 0; overflowSummaries.length = 0; }

  return { push, pop, current, mainLine, returnToMainLine, snapshot, clear };
}
