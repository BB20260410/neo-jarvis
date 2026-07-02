#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClusterDiagnosticsDrillReport,
  writeClusterDiagnosticsDrillReport,
} from '../src/server/services/cluster-diagnostics-drill.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LATEST_PATH = process.env.PANEL_CLUSTER_DRILL_REPORT_PATH || join(ROOT, 'logs', 'cluster-diagnostics-drill.latest.json');
const HISTORY_PATH = process.env.PANEL_CLUSTER_DRILL_HISTORY_PATH || join(ROOT, 'logs', 'cluster-diagnostics-drill.history.jsonl');
const MAX_HISTORY_LINES = Number(process.env.PANEL_CLUSTER_DRILL_HISTORY_MAX_LINES || 200);

const report = buildClusterDiagnosticsDrillReport();
const writeResult = writeClusterDiagnosticsDrillReport(report, {
  latestPath: LATEST_PATH,
  historyPath: HISTORY_PATH,
  maxHistoryLines: MAX_HISTORY_LINES,
});

const output = {
  ...report,
  latestPath: writeResult.latestPath,
  historyPath: writeResult.historyPath,
  retention: writeResult.retention,
  report: writeResult,
};
console.log(JSON.stringify(output, null, 2));
if (!report.ok || writeResult.written !== true) process.exit(1);
