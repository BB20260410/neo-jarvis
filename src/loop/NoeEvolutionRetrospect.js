// @ts-check
// NoeEvolutionRetrospect — P4 学改闭环（复盘→回流）。
//
// 闭环：P0 度量每次 apply 记 evolution_outcome（verdict=doc_only/neutral/logic_changed）。P4 定期复盘这些 outcome，
//   把「结果」反馈成「下一轮输入」：
//   - logic_changed（真改逻辑且过 P3 双绿门）→ 蒸馏「成功模式」learning_lesson（记下哪类受控重构成功，供未来参考）。
//   - 连续 doc_only/neutral（浅层进化，P0 早已暴露的「只补 JSDoc / 啥都没改善」）且本批无真改逻辑 →
//     蒸馏「太浅」learning_lesson 回流 P1（P1 读 learning_lesson → 立改进目标 → 推动飞轮走向真改逻辑）。
//   这把「进化太浅」从一个静态观察，变成自动驱动力：复盘 → 教训 → P1 目标 → 飞轮 → 新 outcome → 再复盘。
//
// 游标(cursor)防重复复盘：只处理 ts > cursor 的新 outcome，复盘后推进游标到本批 max(at)。
// flag NOE_EVOLUTION_RETROSPECT 默认 OFF（分量动作）。纯 DI（listNewOutcomes/getCursor/setCursor/writeLesson）+ 全程 fail-open。

const SHALLOW_VERDICTS = new Set(['doc_only', 'neutral']);

/**
 * @param {object} [deps]
 * @param {(arg: {since: number}) => Array<{patchPlanId?: string, verdict: string, at: number, file?: string}>} [deps.listNewOutcomes]
 * @param {() => number} [deps.getCursor] 上次复盘到的 at（游标）
 * @param {(at: number) => void} [deps.setCursor]
 * @param {(lesson: {title: string, body: string, tags: string[], evidence?: string[]}) => any} [deps.writeLesson] 写 learning_lesson
 * @param {number} [deps.shallowThreshold] 连续浅层达到此数 → 触发「太浅」教训
 */
export function createEvolutionRetrospect({
  listNewOutcomes,
  getCursor = () => 0,
  setCursor = () => {},
  writeLesson = () => {},
  shallowThreshold = 3,
} = {}) {
  function runOnce({ limit = 5 } = {}) {
    if (process.env.NOE_EVOLUTION_RETROSPECT !== '1') return { ok: false, skipped: 'flag_off' };
    if (typeof listNewOutcomes !== 'function') return { ok: false, skipped: 'no_source' };

    let since = 0;
    try { since = Number(getCursor()) || 0; } catch { since = 0; } // fail-open：游标读失败从头复盘

    let outcomes;
    try { outcomes = listNewOutcomes({ since }) || []; } catch { return { ok: false, reason: 'list_failed' }; }
    if (!outcomes.length) return { ok: false, reason: 'no_new' };

    // 按 verdict + applied 三分（根因修复核心：被回滚的改逻辑 applied:false，绝不当成功）。
    const realLogic = outcomes.filter((o) => o && o.verdict === 'logic_changed' && o.applied === true);
    const failedLogic = outcomes.filter((o) => o && o.verdict === 'logic_changed' && o.applied === false);
    const shallow = outcomes.filter((o) => o && SHALLOW_VERDICTS.has(o.verdict));
    // 有价值的自主补测试（test_only 且 applied:true，真覆盖增量）——加能力方向的真进化，绝非浅层空转。
    const testOnly = outcomes.filter((o) => o && o.verdict === 'test_only' && o.applied === true);

    let lessons = 0;
    // 成功模式：真保留（applied:true，过 P3 双绿门）的受控重构 → 记下「哪类改成了」。
    for (const o of realLogic.slice(0, limit)) {
      try {
        writeLesson({
          title: `进化成功模式：受控改逻辑 ${o.patchPlanId || o.at}`.slice(0, 80),
          body: `受控逻辑改进成功通过 P3 双绿门并保留（patch ${o.patchPlanId || '?'}）。这类「改前绿+改后绿」的行为不变重构是可复制的真进化路径，未来 implement 同类改进可参考。`,
          tags: ['evolution', 'retrospect', 'success', 'logic_change'],
          evidence: [`evolution_outcome:${o.patchPlanId || o.at}`],
        });
        lessons += 1;
      } catch { /* fail-open：单条蒸馏失败不阻断游标推进 */ }
    }
    // 补测试成功模式：飞轮自主补/改测试并真保留（test_only applied:true）→ 记下「自主加测试覆盖」是可复制的真进化（加能力方向）。
    for (const o of testOnly.slice(0, limit)) {
      try {
        writeLesson({
          title: `进化成功模式：自主补测试覆盖 ${o.patchPlanId || o.at}`.slice(0, 80),
          body: `飞轮自主为无测试覆盖的模块补/改测试并通过 verify 保留（patch ${o.patchPlanId || '?'}）。这类「自主发现缺口→写出能过的测试→真增覆盖」是可复制的真进化路径（加能力方向），未来同类补测试可参考。`,
          tags: ['evolution', 'retrospect', 'success', 'test_increment'],
          evidence: [`evolution_outcome:${o.patchPlanId || o.at}`],
        });
        lessons += 1;
      } catch { /* fail-open */ }
    }
    // 失败教训：尝试改逻辑但被拦/回滚（applied:false）→ 回流 P1，学「这类改动为何做不成」。1 条总结（24h 去重在接线层）。
    if (failedLogic.length) {
      try {
        writeLesson({
          title: '进化复盘：受控改逻辑反复失败，需换策略',
          body: `近期 ${failedLogic.length} 次尝试改逻辑均被拦或回滚（applied:false：未过 P3 双绿门 / verify 失败 / 改逻辑未放行）。说明本地 implement 对这类重构能力不足或目标过难——应换更小粒度的改进目标，或检查双绿门/信号源质量，别反复撞同一个改不动的目标。`,
          tags: ['evolution', 'retrospect', 'failed', 'learning_lesson'],
          evidence: failedLogic.slice(0, 5).map((o) => `evolution_outcome:${o.patchPlanId || o.at}`),
        });
        lessons += 1;
      } catch { /* fail-open */ }
    }
    // 太浅教训：纯浅层（无任何改逻辑尝试 + 无补测试，成功/失败/补测试都没有）+ 达阈值 → 回流 P1 推动走向真改逻辑。
    //   有 test_only(补测试)就不算太浅——那是有价值的加能力进化，不该被催「推进真改逻辑」。
    if (!realLogic.length && !failedLogic.length && !testOnly.length && shallow.length >= shallowThreshold) {
      try {
        writeLesson({
          title: '进化复盘：连续浅层，需推进真改逻辑',
          body: `进化连续 ${shallow.length} 次停留在浅层（doc_only/neutral：只补注释或无实质改善），未触及真逻辑改进。需推动飞轮走向受控改逻辑——开启 NOE_EVOLUTION_LOGIC 让 high_complexity 重构信号能落地，或产出更有价值的改进目标。`,
          tags: ['evolution', 'retrospect', 'too_shallow', 'learning_lesson'],
          evidence: outcomes.slice(0, 5).map((o) => `evolution_outcome:${o.patchPlanId || o.at}`),
        });
        lessons += 1;
      } catch { /* fail-open */ }
    }

    // 推进游标到本批最大 at（即便没写教训也推进，已复盘过不重复）。
    const maxAt = outcomes.reduce((m, o) => Math.max(m, Number(o.at) || 0), since);
    try { setCursor(maxAt); } catch { /* fail-open */ }

    return { ok: true, lessons, realLogic: realLogic.length, failedLogic: failedLogic.length, testOnly: testOnly.length, shallow: shallow.length, cursor: maxAt };
  }

  return { runOnce };
}
