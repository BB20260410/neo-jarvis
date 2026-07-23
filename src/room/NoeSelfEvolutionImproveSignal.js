// @ts-check
/**
 * Perception ring: normalize typecheck / verify / runtime failures into ImproveSignal
 * with technical anchors. Used by seeds and lesson flywheel — not a parallel evolution engine.
 */

export const IMPROVE_SIGNAL_SCHEMA = 'neo.self-evolution.improve-signal.v1';

/**
 * @typedef {object} ImproveSignal
 * @property {1} schemaVersion
 * @property {typeof IMPROVE_SIGNAL_SCHEMA} kind
 * @property {'type_error'|'verify_not_green'|'runtime_verify'|'code_quality'|'unknown'} signal
 * @property {string} objective
 * @property {string} [targetFile]
 * @property {number} [errorCount]
 * @property {Array<{line?:number,code?:string,message?:string}>} [errors]
 * @property {string} [errorClass]
 * @property {boolean} hasTechnicalAnchor
 */

/**
 * @param {object} [input]
 * @param {string} [input.signal]
 * @param {string} [input.targetFile]
 * @param {string} [input.file]
 * @param {number} [input.errorCount]
 * @param {Array<object>} [input.errors]
 * @param {string} [input.errorClass]
 * @param {string} [input.verifyReason]
 * @param {string} [input.objective]
 * @returns {ImproveSignal}
 */
export function buildImproveSignal(input = {}) {
  const signalRaw = String(input.signal || 'unknown').trim() || 'unknown';
  /** @type {ImproveSignal['signal']} */
  let signal = 'unknown';
  if (signalRaw === 'type_error') signal = 'type_error';
  else if (signalRaw === 'verify_not_green' || signalRaw === 'needsSelfRepair') signal = 'verify_not_green';
  else if (signalRaw === 'runtime_verify' || signalRaw === 'runtime_verification') signal = 'runtime_verify';
  else if (signalRaw === 'code_quality' || signalRaw === 'missing_jsdoc') signal = 'code_quality';

  const targetFile = String(input.targetFile || input.file || '').trim();
  // Cap 5 structured errors (type_error seed contract / implementer prompt size).
  const errors = Array.isArray(input.errors)
    ? input.errors.slice(0, 5).map((e) => ({
      line: Number(e?.line) || 0,
      code: String(e?.code || '').slice(0, 32),
      message: String(e?.message || '').slice(0, 200),
    }))
    : [];
  const errorCount = Number.isFinite(Number(input.errorCount))
    ? Number(input.errorCount)
    : errors.length;
  const errorClass = String(input.errorClass || errors[0]?.code || '').slice(0, 48);
  const verifyReason = String(input.verifyReason || '').trim().slice(0, 300);

  let objective = String(input.objective || '').trim();
  if (!objective) {
    if (signal === 'type_error' && targetFile) {
      const errList = errors.slice(0, 5).map((e) => `${e.line}:${e.code}`).join(', ');
      objective = `修 ${targetFile} 的 ${errorCount || errors.length || 1} 个结构性类型 error(${errList || errorClass || 'TS'})：加 JSDoc 或修真实类型问题，禁用 @ts-ignore/@ts-nocheck/any`;
    } else if ((signal === 'verify_not_green' || signal === 'runtime_verify') && targetFile) {
      objective = `修复验证未绿：${targetFile}${verifyReason ? `（${verifyReason.slice(0, 120)}）` : ''}`;
    } else if (signal === 'code_quality' && targetFile) {
      objective = `改进代码质量锚点：${targetFile}`;
    } else {
      objective = String(input.objective || '自我进化：需补充技术锚点（文件/错误类）').slice(0, 200);
    }
  }

  // Generic class labels alone are NOT anchors (e.g. default verify_not_green).
  const GENERIC_ERROR_CLASS = new Set([
    '', 'verify_not_green', 'unknown', 'needsSelfRepair', 'needs_self_repair', 'runtime_verify',
  ]);
  const specificErrorClass = errorClass && !GENERIC_ERROR_CLASS.has(errorClass);
  const hasTechnicalAnchor = Boolean(
    targetFile
    || specificErrorClass
    || errors.length
    || /src\/|tests\/|\.js\b|\.mjs\b|TS\d{3,5}/i.test(objective),
  );

  return {
    schemaVersion: 1,
    kind: IMPROVE_SIGNAL_SCHEMA,
    signal,
    objective: objective.slice(0, 400),
    targetFile: targetFile || undefined,
    errorCount: errorCount || undefined,
    errors: errors.length ? errors : undefined,
    errorClass: errorClass || undefined,
    hasTechnicalAnchor,
  };
}

/**
 * Shape a goalSystem.add payload from ImproveSignal (self_evolution source).
 * @param {ImproveSignal} signal
 * @param {{ now?: number|(()=>number), why?: string }} [opts]
 */
export function buildSelfEvolutionGoalFromImproveSignal(signal, opts = {}) {
  const s = signal && signal.kind === IMPROVE_SIGNAL_SCHEMA
    ? signal
    : buildImproveSignal(signal || {});
  const now = typeof opts.now === 'function' ? opts.now() : (Number(opts.now) || Date.now());
  const title = s.targetFile
    ? (s.signal === 'type_error'
      ? `修 ${s.targetFile} 的类型 error`
      : `改进 ${s.targetFile}`)
    : s.objective.slice(0, 120);
  return {
    title: String(title).slice(0, 120),
    source: 'self_evolution',
    why: opts.why || `improve_signal:${s.signal}`,
    steps: [{ step: s.objective.slice(0, 120), kind: 'think' }],
    meta: {
      signal: s.signal,
      file: s.targetFile || '',
      targetFile: s.targetFile || '',
      errorCount: s.errorCount || 0,
      errorClass: s.errorClass || '',
      errors: s.errors || [],
      hasTechnicalAnchor: s.hasTechnicalAnchor === true,
      expectedVerdict: s.signal === 'type_error' ? 'logic_changed' : 'improve',
      discoveredAt: now,
      improveSignalSchema: IMPROVE_SIGNAL_SCHEMA,
    },
  };
}

/**
 * From typecheck parse target (NoeTypeErrorScanner shape).
 * @param {{ file: string, errorCount?: number, errors?: Array<object> }} target
 */
export function improveSignalFromTypecheckTarget(target) {
  return buildImproveSignal({
    signal: 'type_error',
    targetFile: target?.file,
    errorCount: target?.errorCount,
    errors: target?.errors,
  });
}

/**
 * From executor verify failure (needsSelfRepair path).
 * @param {object} [info]
 */
export function improveSignalFromVerifyFailure(info = {}) {
  return buildImproveSignal({
    signal: 'verify_not_green',
    targetFile: info.targetFile || info.file,
    verifyReason: info.verifyReason || info.reason || info.error,
    objective: info.objective,
    errorClass: info.errorClass || 'verify_not_green',
  });
}
