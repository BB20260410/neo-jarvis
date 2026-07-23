// @ts-check
// NoeEvolutionOutcome — P0 进化价值度量（外部尺子）。
//
// 问题：自我进化的 complete 是「走完闭环 + 复核盖章」=仪式，不等于「真的变好了」。Neo 栽过 reward hacking
//   （围绕无意义目标空转、内心独白把失败当成功）。在扩大自改范围（P1+）之前，必须先有一把外部客观尺子。
// 做什么：apply 前后采集 touchedFiles 的客观指标（总行数 / 代码行数 / 缺 JSDoc 数），diff 出「改了有没有变好」。
//   关键判据 codeLinesDelta：补 JSDoc 只加注释 → 代码行不变(=0) + 缺 JSDoc 降 → verdict 'doc_only'（纯文档进化=浅）；
//   真改逻辑 → 代码行变(≠0) → 'logic_changed'。shadow 记账（不拦），积累「现在的进化到底改善了什么」的真相。
// flag NOE_EVOLUTION_OUTCOME 默认 OFF（分量动作）。纯 DI(scanner/fsReadFile/recordOutcome) + 全程 fail-open。

import { isAbsolute, join } from 'node:path';

/** 一行是否「代码行」（非空、非纯注释/JSDoc 行）。 */
function isCodeLine(line) {
  const t = String(line).trim();
  if (!t) return false;
  return !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*') && !t.startsWith('*/');
}

/**
 * @param {object} [deps]
 * @param {{ scan: Function }} [deps.scanner] 复用 NoeCodeQualitySignalScanner 数缺 JSDoc
 * @param {(absPath: string) => string} [deps.fsReadFile]
 * @param {string} [deps.projectRoot]
 * @param {(summary: object) => void} [deps.recordOutcome] shadow 落账回调（写表/事件）
 * @param {() => number} [deps.now]
 */
export function createEvolutionOutcome({
  scanner,
  fsReadFile,
  projectRoot = process.cwd(),
  recordOutcome = null,
  now = () => Date.now(),
} = {}) {
  // 采集单文件客观指标。读失败 → null（fail-open）。
  function measureFile(relPath) {
    const abs = isAbsolute(relPath) ? relPath : join(projectRoot, relPath);
    let code;
    try { code = String(fsReadFile(abs)); } catch { return null; }
    const lines = code.split('\n');
    const codeLines = lines.filter(isCodeLine).length;
    let missingJsdoc = 0;
    try { missingJsdoc = (scanner?.scan?.({ files: [abs], limit: 999 })?.signals || []).length; } catch { missingJsdoc = 0; }
    return { lines: lines.length, codeLines, missingJsdoc };
  }

  // 采集一批文件指标 → { [relPath]: metrics }（读失败的文件跳过）。
  function measure(paths) {
    const out = {};
    for (const p of (Array.isArray(paths) ? paths : [])) {
      const m = measureFile(p);
      if (m) out[p] = m;
    }
    return out;
  }

  // before→after 逐文件 diff。delta 约定：missingJsdocDelta 正=补了 JSDoc；codeLinesDelta 0=纯注释、非0=改逻辑。
  // P2 修正（2026-07-02）：文件在 before 缺席 = 新建文件，以 0 行为基线（旧逻辑兜底 a.codeLines 使 delta 恒 0，
  //   新建 src 模块被误判 neutral → P4/P5 低估真进化；新建测试文件不受影响，verdict 按路径优先分流 test_only）。
  function diff(before, after) {
    const files = {};
    for (const p of Object.keys(after || {})) {
      const a = after[p];
      if (!a) continue;
      const b = (before || {})[p] || {};
      files[p] = {
        missingJsdocDelta: (Number(b.missingJsdoc) || 0) - a.missingJsdoc,
        codeLinesDelta: a.codeLines - (Number.isFinite(Number(b.codeLines)) ? Number(b.codeLines) : 0),
        linesDelta: a.lines - (Number.isFinite(Number(b.lines)) ? Number(b.lines) : 0),
      };
    }
    return files;
  }

  // 纯计算 verdict + 汇总，不落账（gate 判分流用，避免「为了拿 verdict 而提前落账」）。
  function summarize({ before = {}, after = {} } = {}) {
    const d = diff(before, after);
    const pairs = Object.entries(d);
    const entries = pairs.map(([, x]) => x);
    const jsdocImproved = entries.reduce((s, x) => s + Math.max(0, x.missingJsdocDelta), 0);
    const codeChanged = entries.reduce((s, x) => s + Math.abs(x.codeLinesDelta), 0);
    // verdict 分流（让 P3 门 + P4/P5 度量正确对待各类进化）：
    //   logic_changed = 非测试文件有代码行变化（改 src 行为，优先，走双绿门）；
    //   test_only = 改动只涉及测试文件（飞轮自主补/改测试，真覆盖增量=有价值，绝非 neutral 空转——
    //     新增测试 apply 前不存在使 codeLinesDelta 兜底为 0，旧逻辑误落 neutral 致 P4/P5 误判浅层）；
    //   doc_only = 纯补 JSDoc（注释进化=浅）；neutral = 啥实质都没动。
    const isTestPath = (p) => /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(p);
    const nonTestCodeChanged = pairs.some(([p, x]) => !isTestPath(p) && Math.abs(x.codeLinesDelta) > 0);
    const onlyTouchesTest = pairs.length > 0 && pairs.every(([p]) => isTestPath(p));
    let verdict;
    if (nonTestCodeChanged) verdict = 'logic_changed';
    else if (onlyTouchesTest) verdict = 'test_only';
    else if (jsdocImproved > 0) verdict = 'doc_only';
    else verdict = 'neutral';
    return { filesChanged: entries.length, jsdocImproved, codeChanged, verdict };
  }

  // shadow 记账：summarize + 标记 applied（**最终是否保留**）后调 recordOutcome 落账。不拦、不抛。
  //   关键（根因修复）：verdict 记「尝试改了什么」，applied 记「改动最终留没留」。被 P3 门拦/verify 失败/回滚的
  //   尝试 applied=false——P4/P5 据此区分「真保留的成功」与「被回滚的失败尝试」，不再把失败当成功（防度量层自欺）。
  // P2（2026-07-02）：reason 记「结局归因」——kept / verify_not_green / logic_gate_post:baseline_not_green /
  //   added_test_not_effective / protected_file_mutated_post_apply 等。此前 66% 的回滚在 evolution_outcome 里
  //   无法区分拦截点（6-30 全天 93% 回滚的故障日无法归因），先看得见才能对症。
  function record({ patchPlanId = '', before = {}, after = {}, applied = true, reason = '' } = {}) {
    const s = summarize({ before, after });
    const summary = { patchPlanId, at: now(), applied: applied !== false, reason: String(reason || '').slice(0, 200), ...s };
    if (typeof recordOutcome === 'function') { try { recordOutcome(summary); } catch { /* fail-open：落账失败不阻断进化 */ } }
    return summary;
  }

  return { measureFile, measure, diff, summarize, record };
}
