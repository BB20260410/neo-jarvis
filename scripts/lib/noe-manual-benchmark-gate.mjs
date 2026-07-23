import { NOE_MAIN_BRAIN_MODEL } from '../../src/model/NoeLocalModelPolicy.js';

export const MANUAL_BENCHMARK_ACK_FLAG = '--ack-manual-benchmark';
export const MANUAL_BENCHMARK_ACK_ENV = 'NOE_ACK_MANUAL_BENCHMARK';

export function requireManualBenchmarkAck({
  argv = process.argv,
  env = process.env,
  scriptName = 'benchmark script',
  residentModel = NOE_MAIN_BRAIN_MODEL,
  mayChangeLoadedModels = true,
} = {}) {
  if (argv.includes(MANUAL_BENCHMARK_ACK_FLAG) || env[MANUAL_BENCHMARK_ACK_ENV] === '1') return;
  const loadedModelNotice = mayChangeLoadedModels
    ? 'This script may unload/load LM Studio models and change the current loaded-model set.'
    : 'This script is reserved for explicit benchmark use.';
  console.error([
    `${scriptName} is manual benchmark / explicit experiment only.`,
    loadedModelNotice,
    `Re-run with ${MANUAL_BENCHMARK_ACK_FLAG} or ${MANUAL_BENCHMARK_ACK_ENV}=1 only after confirming this is intended.`,
    'It must not be used by automatic loops, background heartbeats, workspace, reflect tier, or expectation resolver.',
    `Resident default remains ${residentModel}; benchmark results never write back to Noe defaults automatically.`,
  ].join('\n'));
  process.exit(2);
}
