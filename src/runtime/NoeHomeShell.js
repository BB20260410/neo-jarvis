// @ts-check
/**
 * Primary UX IA: one main shell + one settings surface.
 * Expert multi-panel entry points remain reachable via settings deep-links / commands,
 * not as peer top-level apps for ordinary users.
 */

export const HOME_SHELL_SCHEMA = 'neo.home.shell.v1';

/** @typedef {{ id: string, title: string, description: string, href?: string, action?: string, expert?: boolean }} ShellNavItem */

/**
 * @returns {{ main: ShellNavItem[], settings: ShellNavItem[], expertReachable: ShellNavItem[] }}
 */
export function buildHomeShellNavigation() {
  /** @type {ShellNavItem[]} */
  const main = [
    { id: 'chat', title: '对话', description: '打字或说话，一句话办事', action: 'focus_composer' },
    { id: 'memory', title: '记忆', description: '可视化记忆时间线', action: 'show_memory' },
    { id: 'status', title: '状态', description: '运行模式与语音就绪', action: 'show_status' },
  ];
  /** @type {ShellNavItem[]} */
  const settings = [
    { id: 'models', title: '模型（最少配置）', description: 'Base URL + 模型 ID · 不必手改 .env', action: 'focus_product_settings', expert: false },
    { id: 'voice', title: '语音', description: '主界面开关 + Whisper/TTS', action: 'focus_product_settings', expert: false },
    { id: 'runtime_mode', title: '运行模式', description: '白龙马式 / Neo 默认', action: 'toggle_runtime_mode_help' },
    { id: 'evolution', title: '进化 dry-run', description: '只读观测 · 真改默认 OFF', href: '/evolution.html', expert: false },
    { id: 'permissions', title: '权限与安全', description: 'owner token、执行策略', href: '/index.html#settings-security', expert: false },
  ];
  /** Expert panels — not top-level chrome; reachable from settings "高级" */
  /** @type {ShellNavItem[]} */
  const expertReachable = [
    { id: 'cognitive', title: '沉浸驾驶舱', description: '语音+视频+图', href: '/cognitive.html', expert: true },
    { id: 'mind', title: 'Mind 专家视图', description: '意识/心跳细节', href: '/mind.html', expert: true },
    { id: 'governance', title: '治理/审批', description: '危险操作确认', href: '/index.html#governance', expert: true },
    { id: 'rooms', title: '多模型房间', description: '辩论与协作', href: '/index.html#rooms', expert: true },
    { id: 'terminal', title: '终端', description: 'PTY 真终端', href: '/index.html#terminal', expert: true },
    { id: 'full_models', title: '完整模型/密钥', description: 'BYOK / adapter 池', href: '/index.html#settings-models', expert: true },
  ];
  return { main, settings, expertReachable };
}

/**
 * Validate shell IA invariants for tests.
 * @param {ReturnType<typeof buildHomeShellNavigation>} nav
 */
export function validateHomeShellNavigation(nav) {
  /** @type {string[]} */
  const errors = [];
  if (!nav?.main?.length) errors.push('main_empty');
  if (!nav?.settings?.length) errors.push('settings_empty');
  if (!nav.main.some((i) => i.id === 'chat')) errors.push('main_missing_chat');
  if (!nav.main.some((i) => i.id === 'memory')) errors.push('main_missing_memory');
  if (!nav.settings.some((i) => i.id === 'runtime_mode' || i.id === 'voice')) {
    errors.push('settings_missing_mode_or_voice');
  }
  // Ordinary main must not list expert-only panels as peers
  const expertIds = new Set((nav.expertReachable || []).map((i) => i.id));
  for (const m of nav.main) {
    if (expertIds.has(m.id)) errors.push(`main_leaks_expert:${m.id}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Chip model for primary status bar (runtimeMode + voice + self-evolution rings).
 * @param {object} opts
 * @param {object} [opts.runtimeMode] from /api/version.runtimeMode
 * @param {object} [opts.voice] from buildVoiceReadiness
 * @param {object} [opts.selfEvolution] from /api/version.selfEvolution (health rings; no secrets)
 */
export function buildHomeStatusChips(opts = {}) {
  const rm = opts.runtimeMode || {};
  const voice = opts.voice || {};
  const evo = opts.selfEvolution || {};
  const rings = evo.rings || {};
  const realApplyOn = evo.armed?.realApply === true || evo.realApply === true;
  // boundary: real rewrite armed → never claim boundary (even if rings.boundary was true/stale).
  // Otherwise prefer explicit rings.boundary; default dry-run → boundary true.
  let boundaryOk = true;
  if (realApplyOn) boundaryOk = false;
  else if (typeof rings.boundary === 'boolean') boundaryOk = rings.boundary === true;
  const ringCount = ['perception', 'memory', 'falsification']
    .filter((k) => rings[k] === true).length + (boundaryOk ? 1 : 0);
  const evoArmed = evo.armed?.rings === true || evo.profile === 'safe' || ringCount >= 3;
  return {
    schemaVersion: 1,
    kind: HOME_SHELL_SCHEMA,
    runtimeMode: {
      modeId: rm.modeId || 'neo_default',
      label: rm.label || 'Neo 默认',
      bailongmaStyle: rm.bailongmaStyle === true,
      proactiveTickMs: rm.effectiveEnv?.NOE_PROACTIVE_TICK_MS || rm.landedBorrow?.proactiveTickMs || null,
      isFullyCloud: rm.isFullyCloud === true,
    },
    voice: {
      status: voice.status || 'unknown',
      ready: voice.ready === true,
      uiHint: voice.uiHint || '语音状态未知',
    },
    selfEvolution: {
      profile: evo.profile || 'off',
      armed: evoArmed,
      ringCount,
      rings: {
        perception: rings.perception === true,
        memory: rings.memory === true,
        falsification: rings.falsification === true,
        boundary: boundaryOk,
      },
      realApply: realApplyOn,
      label: evoArmed
        ? (realApplyOn ? `进化 · 真改(${ringCount}/4)` : `进化 · dry-run(${ringCount}/4)`)
        : (realApplyOn ? '进化 · 真改未武装' : '进化 · 未武装'),
    },
  };
}
