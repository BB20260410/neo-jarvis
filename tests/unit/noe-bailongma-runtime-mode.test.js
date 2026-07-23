// @ts-check
import { describe, expect, it } from 'vitest';
import {
  BAILONGMA_STYLE_MODE_ID,
  BAILONGMA_STYLE_PROACTIVE_TICK_MS,
  BAILONGMA_TOPOLOGY_BASELINE,
  applyRuntimeModeFromEnv,
  buildBaiLongmaGapMatrix,
  describeRuntimeMode,
  enableBaiLongmaStyleMode,
  isBaiLongmaStyleMode,
  resolveRuntimeModeId,
  validateGapMatrix,
} from '../../src/runtime/NoeBaiLongmaRuntimeMode.js';

/** Mirrors server.js NOE_AUTONOMY free-profile fill (only undefined keys). */
function applyAutonomyDefaultsLikeServer(env) {
  const defaults = {
    NOE_HEARTBEAT: '1',
    NOE_PROACTIVE_TICK_MS: '10000',
    NOE_PROACTIVE_COOLDOWN_MS: '120000',
  };
  for (const [k, v] of Object.entries(defaults)) {
    if (env[k] === undefined) env[k] = v;
  }
  return env;
}

describe('NoeBaiLongmaRuntimeMode', () => {
  it('declares hybrid topology not fully cloud (baseline fact)', () => {
    expect(BAILONGMA_TOPOLOGY_BASELINE.isFullyCloud).toBe(false);
    expect(BAILONGMA_TOPOLOGY_BASELINE.topologyClass).toContain('hybrid');
    expect(BAILONGMA_TOPOLOGY_BASELINE.packageMain).toBe('electron/main.cjs');
  });

  it('resolves bailongma_style from env aliases', () => {
    expect(resolveRuntimeModeId({ NOE_RUNTIME_MODE: 'bailongma_style' })).toBe(BAILONGMA_STYLE_MODE_ID);
    expect(resolveRuntimeModeId({ NOE_RUNTIME_MODE: 'bailongma' })).toBe(BAILONGMA_STYLE_MODE_ID);
    expect(resolveRuntimeModeId({ NOE_OPERATING_MODE: 'bl' })).toBe(BAILONGMA_STYLE_MODE_ID);
    expect(resolveRuntimeModeId({})).toBe('neo_default');
    expect(isBaiLongmaStyleMode({ NOE_RUNTIME_MODE: 'bailongma_style' })).toBe(true);
  });

  it('describeRuntimeMode exposes probe fields for smoke', () => {
    const d = describeRuntimeMode({
      NOE_RUNTIME_MODE: 'bailongma_style',
      NOE_PROACTIVE_TICK_MS: BAILONGMA_STYLE_PROACTIVE_TICK_MS,
    });
    expect(d.kind).toBe('neo.runtime-mode.v1');
    expect(d.bailongmaStyle).toBe(true);
    expect(d.topologyClaim.isFullyCloud).toBe(false);
    expect(d.principles).toContain('silence_first_heartbeat');
    expect(d.envHints.NOE_HEARTBEAT).toBe('1');
    expect(d.landedBorrow?.dimension).toBe('main_loop_heartbeat');
    expect(d.isolationRequired).toBe(true);
  });

  it('enableBaiLongmaStyleMode applies env hints without wiping explicit values', () => {
    const env = { NOE_PROACTIVE_TICK_MS: '999000' };
    const mode = enableBaiLongmaStyleMode(env);
    expect(mode.modeId).toBe(BAILONGMA_STYLE_MODE_ID);
    expect(env.NOE_RUNTIME_MODE).toBe(BAILONGMA_STYLE_MODE_ID);
    expect(env.NOE_PROACTIVE_TICK_MS).toBe('999000');
    expect(env.NOE_HEARTBEAT).toBe('1');
  });

  it('applyRuntimeModeFromEnv wins over free-profile 10s autonomy default (real bootstrap order)', () => {
    const env = { NOE_RUNTIME_MODE: 'bailongma_style' };
    const applied = applyRuntimeModeFromEnv(env);
    expect(applied.applied).toBe(true);
    expect(applied.proactiveTickMs).toBe(BAILONGMA_STYLE_PROACTIVE_TICK_MS);
    applyAutonomyDefaultsLikeServer(env);
    // After autonomy defaults (undefined-only fill), silence-first 120s must remain
    expect(env.NOE_PROACTIVE_TICK_MS).toBe(BAILONGMA_STYLE_PROACTIVE_TICK_MS);
    expect(env.NOE_PROACTIVE_TICK_MS).not.toBe('10000');
  });

  it('applyRuntimeModeFromEnv is no-op for neo_default (autonomy free 10s can land)', () => {
    const env = {};
    const applied = applyRuntimeModeFromEnv(env);
    expect(applied.applied).toBe(false);
    applyAutonomyDefaultsLikeServer(env);
    expect(env.NOE_PROACTIVE_TICK_MS).toBe('10000');
  });

  it('gap matrix covers required dimensions; main_loop is borrow; front_door not false replicate', () => {
    const matrix = buildBaiLongmaGapMatrix();
    const v = validateGapMatrix(matrix);
    expect(v.ok).toBe(true);
    expect(v.errors).toEqual([]);
    expect(matrix.some((r) => r.decision === 'replicate' || r.decision === 'borrow')).toBe(true);
    expect(matrix.some((r) => r.decision === 'refuse')).toBe(true);
    expect(matrix.find((r) => r.dimension === 'tool_exec_permissions')?.decision).toBe('refuse');
    expect(matrix.find((r) => r.dimension === 'main_loop_heartbeat')?.decision).toBe('borrow');
    expect(matrix.find((r) => r.dimension === 'unified_front_door')?.decision).not.toBe('replicate');
  });

  it('validateGapMatrix fails closed on empty matrix', () => {
    const v = validateGapMatrix([]);
    expect(v.ok).toBe(false);
    expect(v.errors).toContain('matrix_empty');
  });
});
