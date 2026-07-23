#!/usr/bin/env node
// @ts-check
/**
 * CLI: fail-closed acceptance matrix runner + capability manifest snapshot.
 * Usage:
 *   node scripts/noe-acceptance-gate-runner.mjs \
 *     --matrix /path/to/acceptance_matrix.json \
 *     --out /path/to/gate-report.json \
 *     [--metrics /path/to/metrics.json] \
 *     [--source-digest sha256:...] \
 *     [--runtime-config-digest sha256:...]
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const root = resolve(__dirname, '..');
const { runAcceptanceGates, readAcceptanceMatrixFile } = await import(
  pathToFileURL(join(root, 'src/runtime/NoeAcceptanceGateRunner.js')).href
);
const { buildCapabilityManifest, formatCapabilityManifestMarkdown } = await import(
  pathToFileURL(join(root, 'src/runtime/NoeCapabilityManifest.js')).href
);
const { computeSourceDigest } = await import(
  pathToFileURL(join(root, 'src/runtime/NoeSourceDigest.js')).href
);

function parseArgs(argv) {
  /** @type {Record<string, string|boolean>} */
  const out = {};
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) out[key] = true;
      else {
        out[key] = next;
        i += 1;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv);
if (args.help) {
  console.log(`noe-acceptance-gate-runner.mjs — fail-closed gate audit
  --matrix <path>   acceptance_matrix.json
  --out <path>      write JSON report
  --metrics <path>  optional metrics JSON (metric→value)
  --source-digest <sha256:...>
  --runtime-config-digest <sha256:...>
  --compute-digest  compute sourceDigest from repo root
  --capability-out <path>  write capability manifest JSON
`);
  process.exit(0);
}

const matrixPath = resolve(String(args.matrix || ''));
if (!args.matrix || !existsSync(matrixPath)) {
  console.error('error: --matrix path required and must exist');
  process.exit(2);
}

const loaded = readAcceptanceMatrixFile(matrixPath);
if (!loaded.ok) {
  console.error('error: cannot read matrix', loaded.error);
  process.exit(2);
}

let sourceDigest = args['source-digest'] ? String(args['source-digest']) : loaded.matrix.candidate?.sourceDigest;
let runtimeConfigDigest = args['runtime-config-digest']
  ? String(args['runtime-config-digest'])
  : loaded.matrix.candidate?.runtimeConfigDigest;

if (args['compute-digest']) {
  const dig = await computeSourceDigest({ rootDir: root, sync: false });
  sourceDigest = dig.sourceDigest;
  runtimeConfigDigest = dig.runtimeConfigDigest;
  console.error(`computed sourceDigest=${sourceDigest}`);
  console.error(`computed runtimeConfigDigest=${runtimeConfigDigest}`);
}

/** @type {Record<string, unknown>} */
let metrics = {};
if (args.metrics) {
  metrics = JSON.parse(readFileSync(String(args.metrics), 'utf8'));
}

const report = runAcceptanceGates(loaded.matrix, {
  metrics,
  sourceDigest,
  runtimeConfigDigest,
  platform: process.platform,
  arch: process.arch,
  allowReadyForCodexValidation: false,
});

const capability = buildCapabilityManifest({ rootDir: root });

const bundle = {
  gateReport: report,
  capabilitySummary: capability.summary,
  matrixPath,
  matrixSha256: loaded.rawSha256,
};

if (args.out) {
  const outPath = resolve(String(args.out));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`);
  console.error(`wrote ${outPath}`);
}

if (args['capability-out']) {
  const capPath = resolve(String(args['capability-out']));
  mkdirSync(dirname(capPath), { recursive: true });
  writeFileSync(capPath, `${JSON.stringify(capability, null, 2)}\n`);
  if (String(args['capability-out']).endsWith('.md')) {
    writeFileSync(capPath, formatCapabilityManifestMarkdown(capability));
  }
  console.error(`wrote capability ${capPath}`);
}

console.log(JSON.stringify({
  ok: report.ok,
  overallStatus: report.overallStatus,
  readyForCodexValidation: report.readyForCodexValidation,
  summary: report.summary,
  allAbsolutePass: report.allAbsolutePass,
  capabilityVerified: capability.summary.verifiedCount,
  rule: report.rule,
}, null, 2));

// Exit 0 for successful audit run even when gates pending (audit tool, not CI greenwash)
process.exit(report.ok ? 0 : 1);
