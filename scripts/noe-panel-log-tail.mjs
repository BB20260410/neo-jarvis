#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  collectNoePanelLogTail,
  compactPanelLogTail,
  defaultNoePanelLogPath,
} from '../src/runtime/NoePanelLogTail.js';

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
const port = Number(argValue('--port', process.env.PORT || '51835'));
const file = resolve(argValue('--file', defaultNoePanelLogPath({ port })));
const cursorText = argValue('--cursor', '');
const limit = Number(argValue('--limit', '200'));
const maxBytes = Number(argValue('--max-bytes', String(64 * 1024)));
const writeReport = hasArg('--write-report');

const report = collectNoePanelLogTail({
  file,
  cursor: cursorText === '' ? undefined : Number(cursorText),
  limit,
  maxBytes,
});

let reportPath = '';
if (writeReport) {
  const outDir = join(root, 'output', 'noe-panel-log-tail');
  mkdirSync(outDir, { recursive: true });
  reportPath = join(outDir, `panel-log-tail-${Date.now()}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
}

const panelLogTail = compactPanelLogTail(report);
console.log(JSON.stringify({
  ok: report.ok === true,
  reportPath,
  panelLogTail,
  policy: report.policy,
}, null, 2));

process.exitCode = report.ok ? 0 : 1;
