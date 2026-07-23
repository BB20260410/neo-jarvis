#!/usr/bin/env node
// @ts-check
/**
 * Probe / enable description of Neo 白龙马式运行模式 (no live 51835, no secrets).
 *
 *   node scripts/noe-bailongma-runtime-mode.mjs --json
 *   NOE_RUNTIME_MODE=bailongma_style node scripts/noe-bailongma-runtime-mode.mjs --json
 */
import {
  buildBaiLongmaGapMatrix,
  describeRuntimeMode,
  enableBaiLongmaStyleMode,
  validateGapMatrix,
} from '../src/runtime/NoeBaiLongmaRuntimeMode.js';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const forceBl = args.includes('--bailongma-style');

const env = { ...process.env };
if (forceBl) env.NOE_RUNTIME_MODE = 'bailongma_style';

const matrix = buildBaiLongmaGapMatrix();
const validation = validateGapMatrix(matrix);
const mode = forceBl ? enableBaiLongmaStyleMode(env) : describeRuntimeMode(env);

const payload = {
  ok: validation.ok && mode.kind === 'neo.runtime-mode.v1',
  mode,
  gapMatrix: matrix,
  gapValidation: validation,
};

if (asJson) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
} else {
  console.log(`runtime-mode: ${mode.modeId} (${mode.label})`);
  console.log(`  fullyCloud=${mode.topologyClaim.isFullyCloud} class=${mode.topologyClaim.topologyClass}`);
  console.log(`  gapMatrixValid=${validation.ok} actionable=${mode.gapActionableCount}`);
  console.log(`  refuses=${(mode.refuses || []).join(',')}`);
}

process.exit(payload.ok ? 0 : 2);
