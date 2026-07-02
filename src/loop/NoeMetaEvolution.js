// @ts-check
// NoeMetaEvolution — P5 元进化（自调进化策略）。
//
// 顶层反思：P0 度量「单次进化好不好」，P4 复盘「把结果回流」，P5 再上一层——反思「进化策略本身对不对」：
//   看 P0 outcome 的总体分布（doc_only/neutral/logic_changed 占比），诊断飞轮「该改什么/怎么改」的策略健康度，
//   产出策略建议（如「进化长期停留浅层，建议开启 NOE_EVOLUTION_LOGIC」「信号源缺真改逻辑机会」「进化健康」）。
//
// 硬约束（owner 钦定的安全边界，不可逾越）：**advisory-only**。
//   P5 只产「给 owner 的文字建议」（writeAdvisory），绝不自动改任何 flag / 配置 / 安全机制。
//   安全机制（NoePolicyFileGuard / P3 双绿门 / standing grant / kickstart flag）永远在 Neo 控制之外——
//   这在代码层面由「P5 模块接口里根本没有任何 mutate flag/gate/config 的依赖」物理保证：它只有
//   read（outcomeStats/flagSnapshot）+ writeAdvisory（写建议）。即便诊断出「该开 logic」，也只能写一句建议给 owner。
//
// flag NOE_META_EVOLUTION 默认 OFF（分量动作）。纯 DI + 全程 fail-open。

const SHALLOW_RATIO_THRESHOLD = 0.8;

/**
 * @param {object} [deps]
 * @param {() => {total: number, docOnly: number, neutral: number, logicChanged: number}} [deps.outcomeStats] P0 outcome 总体统计（只读）
 * @param {() => {logicEnabled?: boolean}} [deps.flagSnapshot] 当前进化 flag 状态（只读）
 * @param {(advisory: {title: string, body: string, severity: string, tags: string[], recommendation: string}) => any} [deps.writeAdvisory] 写策略建议（advisory-only）
 * @param {number} [deps.minSample] 少于此样本不产建议（数据不足）
 */
export function createMetaEvolution({
  outcomeStats,
  flagSnapshot = () => ({}),
  writeAdvisory = () => {},
  minSample = 3,
} = {}) {
  function runOnce() {
    if (process.env.NOE_META_EVOLUTION !== '1') return { ok: false, skipped: 'flag_off' };
    if (typeof outcomeStats !== 'function') return { ok: false, skipped: 'no_source' };

    let stats;
    try { stats = outcomeStats() || null; } catch { return { ok: false, reason: 'stats_failed' }; }
    const total = Number(stats && stats.total) || 0;
    if (total < minSample) return { ok: false, reason: 'insufficient_sample' };

    let flags = {};
    try { flags = flagSnapshot() || {}; } catch { flags = {}; }
    const logicEnabled = flags.logicEnabled === true;

    const docOnly = Number(stats.docOnly) || 0;
    const neutral = Number(stats.neutral) || 0;
    const logicChanged = Number(stats.logicChanged) || 0; // 只含真保留的（applied:true）
    const testOnly = Number(stats.testOnly) || 0; // 自主补测试覆盖（test_only，加能力方向的真价值产出）
    const logicAttempted = Number(stats.logicAttempted) || logicChanged; // 含被回滚的尝试
    const shallowRatio = total > 0 ? (docOnly + neutral) / total : 0;

    // 诊断 → 建议（recommendation 永远是给 owner 的文字，不是可执行动作）。
    let advisory;
    if (logicChanged > 0 || testOnly > 0) {
      // 健康 = 有真价值产出：受控改逻辑(logic_changed applied) 或 自主补测试覆盖(test_only)。补测试是加能力方向的真进化，不是空转。
      advisory = {
        title: '元进化诊断：进化健康（在产出真价值）',
        body: `近 ${total} 次进化中 ${logicChanged} 次真保留改逻辑（过 P3 双绿门）+ ${testOnly} 次自主补测试覆盖（test_only，加能力方向），浅层(doc_only/neutral) ${docOnly + neutral} 次。飞轮在产出真价值。`,
        severity: 'info',
        tags: ['meta_evolution', 'advisory', 'healthy'],
        recommendation: `保持现状；持续观察真价值产出（改逻辑+补测试）占比（当前 ${Math.round(((logicChanged + testOnly) / total) * 100)}%）是否稳定，必要时由 owner 微调信号源优先级。`,
      };
    } else if (logicAttempted > 0) {
      // 在尝试改逻辑但一次都没保留（全被拦/回滚）——既不是"健康"也不是"浅层"，是空转。
      advisory = {
        title: '元进化诊断：改逻辑反复失败，零保留（飞轮空转）',
        body: `近 ${total} 次进化里有 ${logicAttempted} 次尝试改逻辑，但 applied 保留数=0——全被 P3 双绿门拦或 verify 失败回滚。飞轮在改不动的目标上空转。`,
        severity: 'warn',
        tags: ['meta_evolution', 'advisory', 'logic_churn'],
        recommendation: '本地 implement 对当前重构目标能力不足或目标过难/过大。建议 owner：①提高 high_complexity 阈值让飞轮去试改得动的小目标；②或对反复失败的同一目标加冷却，别锁死空转；③检查双绿门 baseline 是否因工作树不洁而误拦。',
      };
    } else if (shallowRatio >= SHALLOW_RATIO_THRESHOLD) {
      advisory = {
        title: '元进化诊断：进化长期停留浅层（零真改逻辑）',
        body: `近 ${total} 次进化全为浅层：doc_only/neutral 占比 ${Math.round(shallowRatio * 100)}%，logic_changed=0。飞轮在「补注释/无实质改善」上空转，未触及真逻辑改进。`,
        severity: 'warn',
        tags: ['meta_evolution', 'advisory', 'too_shallow'],
        recommendation: logicEnabled
          ? '受控改逻辑已开（NOE_EVOLUTION_LOGIC=1）但仍无 logic_changed → 信号源缺真改逻辑机会，建议 owner 检查 high_complexity 信号供给/质量，或本地 implement 对重构的能力。'
          : '建议 owner 评估开启 NOE_EVOLUTION_LOGIC=1，让 high_complexity 重构信号能落地（过 P3 双绿门）——这是从浅层进化走向真进化的关键开关。注意：此开关只能由 owner 决定，P5 不自动开。',
      };
    } else {
      advisory = {
        title: '元进化诊断：进化产出待观察',
        body: `近 ${total} 次进化：doc_only/neutral ${docOnly + neutral}、logic_changed 0，浅层占比 ${Math.round(shallowRatio * 100)}%（未达停滞阈值）。样本仍少，趋势不明。`,
        severity: 'info',
        tags: ['meta_evolution', 'advisory', 'observing'],
        recommendation: '继续积累进化样本，下轮复盘再评估策略。',
      };
    }

    let written = false;
    try { const w = writeAdvisory(advisory); written = !(w && w.ok === false); } catch { written = false; } // fail-open
    return { ok: true, written, advisory };
  }

  return { runOnce };
}
