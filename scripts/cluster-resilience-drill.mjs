#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildClusterResilienceDrillReport,
  writeClusterResilienceDrillReport,
} from '../src/server/services/cluster-resilience-drill.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LATEST_PATH = process.env.PANEL_CLUSTER_RESILIENCE_DRILL_REPORT_PATH || join(ROOT, 'logs', 'cluster-resilience-drill.latest.json');
const HISTORY_PATH = process.env.PANEL_CLUSTER_RESILIENCE_DRILL_HISTORY_PATH || join(ROOT, 'logs', 'cluster-resilience-drill.history.jsonl');
const MAX_HISTORY_LINES = Number(process.env.PANEL_CLUSTER_RESILIENCE_DRILL_HISTORY_MAX_LINES || 200);

const report = buildClusterResilienceDrillReport();
const writeResult = writeClusterResilienceDrillReport(report, {
  latestPath: LATEST_PATH,
  historyPath: HISTORY_PATH,
  maxHistoryLines: MAX_HISTORY_LINES,
});

console.log(JSON.stringify({
  ...report,
  latestPath: writeResult.latestPath,
  historyPath: writeResult.historyPath,
  retention: writeResult.retention,
  report: writeResult,
}, null, 2));

if (!report.ok || writeResult.written !== true) process.exit(1);
