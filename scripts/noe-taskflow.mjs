#!/usr/bin/env node
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoeTaskFlowStore } from '../src/runtime/NoeTaskFlowStore.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { command: argv[0] || 'help', steps: [], evidenceRefs: [] };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] || '';
    if (arg === '--flow-id') out.flowId = next();
    else if (arg.startsWith('--flow-id=')) out.flowId = arg.slice(10);
    else if (arg === '--kind') out.kind = next();
    else if (arg.startsWith('--kind=')) out.kind = arg.slice(7);
    else if (arg === '--goal') out.goal = next();
    else if (arg.startsWith('--goal=')) out.goal = arg.slice(7);
    else if (arg === '--step') out.step = next();
    else if (arg.startsWith('--step=')) out.step = arg.slice(7);
    else if (arg === '--status') out.status = next();
    else if (arg.startsWith('--status=')) out.status = arg.slice(9);
    else if (arg === '--evidence') out.evidenceRefs.push(next());
    else if (arg.startsWith('--evidence=')) out.evidenceRefs.push(arg.slice(11));
    else if (arg === '--custom-step') out.steps.push(next());
    else if (arg.startsWith('--custom-step=')) out.steps.push(arg.slice(14));
    else if (arg === '--reason') out.reason = next();
    else if (arg.startsWith('--reason=')) out.reason = arg.slice(9);
  }
  return out;
}

function usage() {
  return {
    ok: false,
    usage: [
      'node scripts/noe-taskflow.mjs create --flow-id id --kind self-evolution --goal "...".',
      'node scripts/noe-taskflow.mjs transition --flow-id id --step verify --status passed --evidence output/report.json',
      'node scripts/noe-taskflow.mjs validate --flow-id id',
      'node scripts/noe-taskflow.mjs cancel --flow-id id --reason "..."',
    ],
  };
}

const args = parseArgs(process.argv.slice(2));
const store = new NoeTaskFlowStore({ root: ROOT });
let result;

try {
  if (args.command === 'create') {
    result = { ok: true, flow: store.createFlow({ flowId: args.flowId, kind: args.kind || 'self-evolution', goal: args.goal || '', steps: args.steps }) };
  } else if (args.command === 'transition') {
    if (!args.flowId || !args.step || !args.status) throw new Error('transition requires --flow-id, --step, --status');
    result = { ok: true, flow: store.transition(args.flowId, args.step, args.status, { evidenceRefs: args.evidenceRefs }) };
  } else if (args.command === 'validate') {
    if (!args.flowId) throw new Error('validate requires --flow-id');
    const flow = store.load(args.flowId);
    if (!flow) throw new Error(`taskflow not found: ${args.flowId}`);
    result = { ok: true, validation: store.validate(flow), flow };
  } else if (args.command === 'cancel') {
    if (!args.flowId) throw new Error('cancel requires --flow-id');
    result = { ok: true, flow: store.requestCancel(args.flowId, args.reason || 'cli_cancel') };
  } else {
    result = usage();
    process.exitCode = 1;
  }
} catch (e) {
  result = { ok: false, error: e.message };
  process.exitCode = 1;
}

console.log(JSON.stringify(result, null, 2));

