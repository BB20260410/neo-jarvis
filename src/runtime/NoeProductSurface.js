// @ts-check
/**
 * Product surface API builders: voice readiness + status chips for primary UI.
 */
import { describeRuntimeMode } from './NoeBaiLongmaRuntimeMode.js';
import { buildVoiceReadiness } from './NoeVoiceReadiness.js';
import { buildHomeStatusChips, buildHomeShellNavigation } from './NoeHomeShell.js';
import { buildMemoryVisualModel } from './NoeMemoryVisual.js';

/**
 * @param {object} [opts]
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} [opts.env]
 * @param {Array<object>} [opts.doctorFindings]
 * @param {boolean|null} [opts.sttOk]
 * @param {Array<object>} [opts.memories]
 */
export function buildProductSurfaceSnapshot(opts = {}) {
  const env = opts.env || process.env;
  const runtimeMode = describeRuntimeMode(env);
  const voice = buildVoiceReadiness({
    findings: opts.doctorFindings || [],
    sttOk: opts.sttOk === undefined ? null : opts.sttOk,
  });
  const chips = buildHomeStatusChips({
    runtimeMode: {
      modeId: runtimeMode.modeId,
      label: runtimeMode.label,
      bailongmaStyle: runtimeMode.bailongmaStyle,
      isFullyCloud: runtimeMode.topologyClaim?.isFullyCloud ?? false,
      effectiveEnv: runtimeMode.effectiveEnv,
      landedBorrow: runtimeMode.landedBorrow,
    },
    voice,
  });
  const nav = buildHomeShellNavigation();
  const memoryVisual = buildMemoryVisualModel(opts.memories || []);
  return {
    schemaVersion: 1,
    kind: 'neo.product.surface.v1',
    runtimeMode: chips.runtimeMode,
    voice,
    chips,
    navigation: nav,
    memoryVisual,
  };
}
