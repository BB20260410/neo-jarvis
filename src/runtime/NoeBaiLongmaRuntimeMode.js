// @ts-check
/**
 * Neo「白龙马式运行模式」— 语义对齐白龙马成功方法，不复制白龙马源码。
 *
 * 白龙马拓扑（固定基线 v2.1.549 审计结论）：
 *   hybrid_local_desktop_plus_cloud_llm
 *   — Electron + 本地 HTTP/WS + better-sqlite3 常驻本机；
 *   — LLM 经 OpenAI 兼容协议 BYOK 走云端；
 *   — 意识主循环 / heartbeat / tick-policy 本地调度。
 *
 * Neo 侧：复用 proactiveTick、Doctor、统一任务、工具权限、BYOK 适配器；
 * 本模块只提供可探测的 mode 选择器 + 环境提示（不平行造第二套 Agent 内核）。
 */

export const BAILONGMA_STYLE_MODE_ID = 'bailongma_style';
export const NEO_DEFAULT_MODE_ID = 'neo_default';
export const RUNTIME_MODE_SCHEMA = 'neo.runtime-mode.v1';

/** Fixed BaiLongma baseline used for topology claims (read-only audit root). */
export const BAILONGMA_TOPOLOGY_BASELINE = Object.freeze({
  release: 'v2.1.549',
  packageMain: 'electron/main.cjs',
  auditRootHint:
    'Documents/Neo 2/.planning/2026-07-22-neo-bailongma-surpass-goal/evidence/S0/bailongma-v2.1.549',
  topologyClass: 'hybrid_local_desktop_plus_cloud_llm',
  isFullyCloud: false,
});

/**
 * @typedef {'neo_has'|'neo_weaker'|'neo_missing'} GapStatus
 * @typedef {'replicate'|'borrow'|'invent'|'refuse'} GapDecision
 *
 * @typedef {Object} GapRow
 * @property {string} dimension
 * @property {string} bailongma
 * @property {string} neo
 * @property {GapStatus} status
 * @property {GapDecision} decision
 * @property {string} rationale
 */

/**
 * Canonical gap matrix (acceptance criterion 3).
 * @returns {GapRow[]}
 */
export function buildBaiLongmaGapMatrix() {
  return [
    {
      dimension: 'main_loop_heartbeat',
      bailongma: 'consciousness-loop + heartbeat tick-policy (local scheduler)',
      neo: 'proactiveTick + autonomy env + mind ticks; no 1:1 consciousness-loop port',
      status: 'neo_weaker',
      decision: 'borrow',
      rationale: 'Borrow silence-default / interval profile via bailongma_style mode; keep Neo tick stack.',
    },
    {
      dimension: 'memory_state_visibility',
      bailongma: 'local sqlite + UI mind/memory surfaces',
      neo: 'UnifiedTask + mind + front-door runtimeVisibility (mode/digest prefix)',
      status: 'neo_has',
      decision: 'invent',
      rationale: 'Landed: buildFrontDoorManifest.runtimeVisibility exposes modeId/tick/digest prefix without secrets.',
    },
    {
      dimension: 'tool_exec_permissions',
      bailongma: 'tool schemas + executor; some dynamic tool loading',
      neo: 'ToolRegistry + FreedomManifest + exec policy fail-closed',
      status: 'neo_has',
      decision: 'refuse',
      rationale: 'Refuse string shell / regex pseudo-sandbox / new Function tool market from BL patterns.',
    },
    {
      dimension: 'voice',
      bailongma: 'wake-word + continuous voice + mic entitlements',
      neo: 'voice task loop + whisper optional services',
      status: 'neo_weaker',
      decision: 'borrow',
      rationale: 'Borrow continuous PTT/wake UX ideas; keep Neo isolation paths.',
    },
    {
      dimension: 'browser',
      bailongma: 'playwright packaging + browser-core tools',
      neo: 'browser capability loops; missing playwright → external_blocked (no fake green)',
      status: 'neo_weaker',
      decision: 'borrow',
      rationale: 'Landed: runBrowserStandardLoop marks executor/playwright absence as external_blocked, never silent PASS.',
    },
    {
      dimension: 'distribution_update',
      bailongma: 'electron-updater + dmg targets',
      neo: 'dist-signed + update drain + real update executor',
      status: 'neo_has',
      decision: 'invent',
      rationale: 'Neo update truth gates are product SSOT; invent beyond BL autoUpdater.',
    },
    {
      dimension: 'security_boundary',
      bailongma: 'local owner activation + config keys; weaker sandbox narrative',
      neo: 'owner-token, isolation DB on non-default ports, dual-writer guards',
      status: 'neo_has',
      decision: 'refuse',
      rationale: 'Refuse weakening Neo owner-token / isolation for BL-like open LAN defaults.',
    },
    {
      dimension: 'unified_front_door',
      bailongma: 'single desktop agent + chat/tool surface',
      neo: 'front-door manifest + ordinary entries + receipts (already present; not rewired by this mode)',
      status: 'neo_has',
      decision: 'invent',
      rationale: 'Neo front door already exists; mode does not rewire it. Landed work is main_loop_heartbeat borrow instead.',
    },
  ];
}

/**
 * @param {unknown} matrix
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateGapMatrix(matrix) {
  /** @type {string[]} */
  const errors = [];
  if (!Array.isArray(matrix) || matrix.length === 0) {
    return { ok: false, errors: ['matrix_empty'] };
  }
  const requiredDims = new Set([
    'main_loop_heartbeat',
    'memory_state_visibility',
    'tool_exec_permissions',
    'voice',
    'browser',
    'distribution_update',
    'security_boundary',
  ]);
  const seen = new Set();
  let hasActionable = false;
  for (const row of matrix) {
    if (!row || typeof row !== 'object') {
      errors.push('row_not_object');
      continue;
    }
    const r = /** @type {Record<string, unknown>} */ (row);
    if (typeof r.dimension !== 'string' || !r.dimension) errors.push('dimension_missing');
    else seen.add(r.dimension);
    if (!['neo_has', 'neo_weaker', 'neo_missing'].includes(String(r.status))) {
      errors.push(`bad_status:${r.dimension}`);
    }
    if (!['replicate', 'borrow', 'invent', 'refuse'].includes(String(r.decision))) {
      errors.push(`bad_decision:${r.dimension}`);
    }
    if (r.decision === 'replicate' || r.decision === 'borrow') hasActionable = true;
    if (typeof r.rationale !== 'string' || !String(r.rationale).trim()) {
      errors.push(`rationale_missing:${r.dimension}`);
    }
  }
  for (const d of requiredDims) {
    if (!seen.has(d)) errors.push(`missing_dimension:${d}`);
  }
  if (!hasActionable) errors.push('no_replicate_or_borrow_row');
  // refuse must include dangerous BL patterns at least once
  const refuseRows = matrix.filter((r) => r && r.decision === 'refuse');
  if (refuseRows.length === 0) errors.push('missing_refuse_row');
  return { ok: errors.length === 0, errors };
}

/**
 * Normalize mode id from env/config.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 */
export function resolveRuntimeModeId(env = process.env) {
  const raw = String(env.NOE_RUNTIME_MODE || env.NOE_OPERATING_MODE || NEO_DEFAULT_MODE_ID)
    .trim()
    .toLowerCase();
  if (
    raw === 'bailongma' ||
    raw === 'bailongma_style' ||
    raw === 'bl_style' ||
    raw === 'bl' ||
    raw === '白龙马' ||
    raw === '白龙马式'
  ) {
    return BAILONGMA_STYLE_MODE_ID;
  }
  if (raw === 'neo' || raw === 'neo_default' || raw === 'default' || raw === '') {
    return NEO_DEFAULT_MODE_ID;
  }
  // unknown → neo_default (fail-closed to known modes)
  return NEO_DEFAULT_MODE_ID;
}

/**
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 */
export function isBaiLongmaStyleMode(env = process.env) {
  return resolveRuntimeModeId(env) === BAILONGMA_STYLE_MODE_ID;
}

/** Default silence-first proactive interval (ms) borrowed from BL tick-policy spirit. */
export const BAILONGMA_STYLE_PROACTIVE_TICK_MS = '120000';

/**
 * Env hints applied when bailongma_style is selected (borrow BL silence-first heartbeat).
 * Does not mutate process.env unless apply=true.
 * Must run BEFORE server.js NOE_AUTONOMY_DEFAULTS fill so free profile does not pin 10s tick.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @param {{ apply?: boolean }} [opts]
 */
export function resolveBaiLongmaStyleEnvHints(env = process.env, opts = {}) {
  const base = {
    // silence-first proactive (BL tick-policy spirit) — longer than free-profile 10s default
    NOE_PROACTIVE_TICK_MS: env.NOE_PROACTIVE_TICK_MS || BAILONGMA_STYLE_PROACTIVE_TICK_MS,
    // autonomy free but not spammy
    NOE_AUTONOMY_PROFILE: env.NOE_AUTONOMY_PROFILE || 'free',
    // heart-like companion loop enabled when mode active
    NOE_HEARTBEAT: env.NOE_HEARTBEAT || '1',
    // longer cooldown aligns with silence-first (free default is 120s; keep explicit)
    NOE_PROACTIVE_COOLDOWN_MS: env.NOE_PROACTIVE_COOLDOWN_MS || '120000',
  };
  if (opts.apply === true) {
    for (const [k, v] of Object.entries(base)) {
      if (env[k] === undefined || env[k] === '') {
        // @ts-ignore
        env[k] = v;
      }
    }
  }
  return { ...base };
}

/**
 * Real entry hook: if NOE_RUNTIME_MODE selects bailongma_style, apply env hints in place.
 * Call from load-env / server bootstrap BEFORE NOE_AUTONOMY_DEFAULTS.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @returns {{ applied: boolean, modeId: string, envHints: Record<string, string>, proactiveTickMs: string|undefined }}
 */
export function applyRuntimeModeFromEnv(env = process.env) {
  const modeId = resolveRuntimeModeId(env);
  if (modeId !== BAILONGMA_STYLE_MODE_ID) {
    return {
      applied: false,
      modeId,
      envHints: {},
      proactiveTickMs: env.NOE_PROACTIVE_TICK_MS,
    };
  }
  const envHints = resolveBaiLongmaStyleEnvHints(env, { apply: true });
  return {
    applied: true,
    modeId,
    envHints,
    proactiveTickMs: env.NOE_PROACTIVE_TICK_MS,
  };
}

/**
 * Full mode descriptor for /api/version, CLI, and smoke probes.
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 */
export function describeRuntimeMode(env = process.env) {
  const modeId = resolveRuntimeModeId(env);
  const blStyle = modeId === BAILONGMA_STYLE_MODE_ID;
  const matrix = buildBaiLongmaGapMatrix();
  const validation = validateGapMatrix(matrix);
  return {
    schemaVersion: 1,
    kind: RUNTIME_MODE_SCHEMA,
    modeId,
    label: blStyle ? '白龙马式运行模式' : 'Neo 默认运行模式',
    active: true,
    bailongmaStyle: blStyle,
    topologyClaim: {
      ...BAILONGMA_TOPOLOGY_BASELINE,
      summary: blStyle
        ? 'Align Neo local panel + BYOK cloud brain + silence-first tick with BL hybrid topology (not pure cloud).'
        : 'Neo default stack; set NOE_RUNTIME_MODE=bailongma_style to enable BL-aligned profile.',
    },
    principles: blStyle
      ? [
          'local_panel_always_on',
          'byok_cloud_llm',
          'silence_first_heartbeat',
          'unified_front_door',
          'fail_closed_permissions',
        ]
      : ['neo_default_stack'],
    envHints: blStyle ? resolveBaiLongmaStyleEnvHints(env) : {},
    /** Live process values after bootstrap apply (for smoke probes). */
    effectiveEnv: {
      NOE_RUNTIME_MODE: env.NOE_RUNTIME_MODE || null,
      NOE_PROACTIVE_TICK_MS: env.NOE_PROACTIVE_TICK_MS || null,
      NOE_PROACTIVE_COOLDOWN_MS: env.NOE_PROACTIVE_COOLDOWN_MS || null,
      NOE_HEARTBEAT: env.NOE_HEARTBEAT || null,
      NOE_AUTONOMY_PROFILE: env.NOE_AUTONOMY_PROFILE || null,
    },
    landedBorrow: blStyle
      ? {
          dimension: 'main_loop_heartbeat',
          decision: 'borrow',
          proactiveTickMs: env.NOE_PROACTIVE_TICK_MS || BAILONGMA_STYLE_PROACTIVE_TICK_MS,
        }
      : null,
    gapMatrixValid: validation.ok,
    gapActionableCount: matrix.filter((r) => r.decision === 'replicate' || r.decision === 'borrow').length,
    refuses: matrix.filter((r) => r.decision === 'refuse').map((r) => r.dimension),
    livePanelPortDefault: 51835,
    isolationRequired: true,
    note: 'Does not copy BaiLongma sources; does not claim full product surpass.',
  };
}

/**
 * Programmatic enable for tests/CLI (mutates the provided env object in place).
 * @param {NodeJS.ProcessEnv|Record<string, string|undefined>} [env]
 * @param {{ applyToProcess?: boolean }} [opts]
 */
export function enableBaiLongmaStyleMode(env = {}, opts = {}) {
  const target = env && typeof env === 'object' ? env : {};
  target.NOE_RUNTIME_MODE = BAILONGMA_STYLE_MODE_ID;
  resolveBaiLongmaStyleEnvHints(target, { apply: true });
  if (opts.applyToProcess === true) {
    process.env.NOE_RUNTIME_MODE = BAILONGMA_STYLE_MODE_ID;
    for (const [k, v] of Object.entries(resolveBaiLongmaStyleEnvHints(process.env))) {
      if (process.env[k] === undefined || process.env[k] === '') process.env[k] = v;
    }
  }
  return describeRuntimeMode(target);
}
