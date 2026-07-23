#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  collectNoePanelRuntimePreflight,
  compactPanelRuntimePreflight,
} from '../src/runtime/NoePanelRuntimePreflight.js';

function argValue(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

const root = resolve(argValue('--root', process.cwd()));
const port = Number(argValue('--port', '51835'));
const observeOnlyPort = Number(argValue('--observe-only-port', '51735'));
const writeReport = !hasArg('--no-write');
const requireOwned = hasArg('--require-owned');

const report = collectNoePanelRuntimePreflight({ root, port, observeOnlyPort });
let reportPath = '';
if (writeReport) {
  const outDir = join(root, 'output', 'noe-panel-runtime-preflight');
  mkdirSync(outDir, { recursive: true });
  reportPath = join(outDir, `panel-runtime-preflight-${Date.now()}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

const compact = compactPanelRuntimePreflight(report);
console.log(JSON.stringify({
  ok: requireOwned ? compact.safeToRestart : report.ok,
  reportPath,
  panel: compact,
  policy: report.policy,
}, null, 2));

if (requireOwned && !compact.safeToRestart) process.exitCode = 1;
else if (!report.ok) process.exitCode = 1;
