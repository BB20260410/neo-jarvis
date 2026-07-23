// @ts-check
// P3 自进化幂等事务 —— DB cycle ↔ apply-report 一致性检查（纯函数 + DI，便于单测）。
//
// 背景：self-evolution 一轮跨多个落点（DB 的 noe_self_evolution_cycles 记录 + apply-report JSON +
//   backup manifest + runtime-verify report）。任一落点写到一半（进程被 Ctrl-C / 崩溃 / rollback 没回写
//   cycle）就会留下「半截状态」：cycle 标 complete 但 apply-report 不是 applied、或 apply 真改了文件却
//   没有 backupManifestRef（无法回滚）。本模块把这类不一致显式检出，供 doctor / 审计读取——只诊断不修。
//
// 设计铁律：纯函数（不读 fs、不查 DB——cycle 与 apply-report 由调用方喂入），fail-open（缺字段不崩，
//   按「无法判定」处理而非误报），不含 secret。

/**
 * @typedef {Object} ConsistencyIssue
 * @property {string} code      机器可读的问题码
 * @property {string} detail    人类可读说明（已脱敏，不含 diff/secret）
 * @property {'error'|'warn'} severity
 */

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value) {
  return String(value ?? '').trim();
}

// implementation/apply 阶段「是否成功完成」的统一判据（对齐 NoeSelfEvolutionCycle.isDone 的语义子集）。
function implementationApplied(impl) {
  const o = asObject(impl);
  return o.applied === true || o.ok === true || o.done === true || o.status === 'done' || o.status === 'complete';
}

// cycle 是否声称「这一轮已收口」：stage==='complete' 或显式 complete 标记。
function cycleClaimsComplete(cycle) {
  const c = asObject(cycle);
  return text(c.stage) === 'complete' || c.complete === true || c.status === 'complete';
}

/**
 * 检测一条 cycle 记录与其对应 apply-report 之间的半截/不一致状态。
 * 两个入参都允许缺省/为空——缺省时按「无法判定」给出对应 issue，绝不抛错（fail-open）。
 *
 * @param {object} cycle        DB 里的 self-evolution cycle 记录（rowToCycle 形状：含 stage/implementation/runtimeVerification/...）
 * @param {object|null} applyReport  对应的 apply-report JSON（runNoePatchApply 落盘形状：含 status/applyId/backupManifestRef/changedFiles）
 * @param {{ requireApplyReport?: boolean }} [opts]  requireApplyReport=true 时，cycle 声称 complete 却没喂 apply-report 视为 error
 * @returns {{ consistent: boolean, issues: ConsistencyIssue[] }}
 */
export function checkNoeSelfEvolutionConsistency(cycle, applyReport, opts = {}) {
  /** @type {ConsistencyIssue[]} */
  const issues = [];
  /** @param {string} code @param {string} detail @param {'error'|'warn'} [severity] */
  const push = (code, detail, severity = 'error') => issues.push({ code, detail: text(detail).slice(0, 300), severity });

  const c = asObject(cycle);
  const impl = asObject(c.implementation);
  const runtime = asObject(c.runtimeVerification);
  const report = applyReport && typeof applyReport === 'object' && !Array.isArray(applyReport) ? applyReport : null;

  const claimsComplete = cycleClaimsComplete(c);
  const implApplied = implementationApplied(impl);
  const applyStatus = report ? text(report.status) : '';
  // apply-report「真的成功落地」的收紧判据（对齐 apply-report 实际字段 status/ok/dryRun）：
  //   status==='applied' 是基础；再要求 ok!==false 且 dryRun!==true，把畸形/半截 report
  //   （status 标 applied 却 ok:false，或本质是 dryRun 预演）排除在「已落地」之外。
  // fail-open：ok/dryRun 字段缺失时（undefined）不收紧——`undefined !== false` / `undefined !== true`
  //   都为 true，故旧产物（仅有 status，无 ok/dryRun）行为不变，缺字段按现有宽松处理不误报。
  const applyOk = applyStatus === 'applied' && report.ok !== false && report.dryRun !== true;

  // 1) cycle 声称 complete，但根本没喂对应 apply-report（实施阶段产物缺失）。
  if (!report) {
    if (claimsComplete && opts.requireApplyReport === true) {
      push('apply_report_missing_for_complete_cycle', 'cycle 标 complete 但缺对应 apply-report');
    }
    // 无 apply-report 时余下检查无法进行——直接返回（fail-open，不臆测）。
    return { consistent: issues.length === 0, issues };
  }

  // 2) cycle 声称 complete / implementation 标 applied，但 apply-report 状态不是 applied（典型半截）。
  if ((claimsComplete || implApplied) && !applyOk) {
    push('cycle_complete_but_apply_not_applied', `cycle 已收口/标 applied，但 apply-report status=${applyStatus || '(空)'}`);
  }

  // 3) apply-report 标 applied 且真改了文件，却没有 backupManifestRef → 无法回滚（事务不完整）。
  const changedCount = Array.isArray(report.changedFiles)
    ? report.changedFiles.length
    : Number((report.counts && report.counts.changedFiles) || 0);
  if (applyOk && changedCount > 0 && !text(report.backupManifestRef)) {
    push('applied_without_backup_manifest', 'apply-report status=applied 且改了文件，却无 backupManifestRef（无法回滚）');
  }

  // 3b) applied 且 changedFiles 是数组时，其长度应与 counts.changedFiles 守恒；不等 = 半截/畸形 report
  //   （明细数组与计数分属两个写入步骤，其中一步写到一半）。fail-open：仅在两者都存在时才交叉校验，
  //   counts 缺失（旧产物无 counts）不报。severity=warn（诊断信号，非致命事务破裂）。
  const countsChanged = report.counts && typeof report.counts === 'object' && !Array.isArray(report.counts)
    ? Number(report.counts.changedFiles)
    : NaN;
  if (
    applyOk
    && Array.isArray(report.changedFiles)
    && Number.isFinite(countsChanged)
    && report.changedFiles.length !== countsChanged
  ) {
    push(
      'changed_files_count_mismatch',
      `apply-report changedFiles 数组长度(${report.changedFiles.length}) ≠ counts.changedFiles(${countsChanged})`,
      'warn',
    );
  }

  // 4) apply 成功且 cycle 声称 complete，但 runtimeVerification 未通过（漏了 verify 或 verify 失败却仍标完成）。
  if (applyOk && claimsComplete && runtime.ok !== true) {
    push('complete_apply_without_passing_runtime_verify', 'apply 成功且 cycle 标 complete，但 runtimeVerification.ok≠true', 'warn');
  }

  // 5) 引用错配：cycle.implementation.applyReportRef 与喂入的 apply-report.reportRef 指向不同文件（喂错对子）。
  const cycleApplyRef = text(impl.applyReportRef);
  const reportRef = text(report.reportRef);
  if (cycleApplyRef && reportRef && cycleApplyRef !== reportRef) {
    push('apply_report_ref_mismatch', `cycle.implementation.applyReportRef(${cycleApplyRef}) ≠ apply-report.reportRef(${reportRef})`, 'warn');
  }

  return { consistent: issues.length === 0, issues };
}

export default checkNoeSelfEvolutionConsistency;
