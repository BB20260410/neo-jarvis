#!/usr/bin/env node
// @ts-check
// Replay P6 self-talk audit JSONL into redacted metrics.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseSelfTalkAuditJsonl,
  sanitizeSelfTalkAuditRecord,
  summarizeSelfTalkAudit,
} from '../src/cognition/SelfTalkAuditStore.js';

function parseWindows(value) {
  return String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
    .map((n) => Math.round(n * 1000) / 1000);
}

function isoOrNull(ts) {
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function compactTsRange(records) {
  const tsList = records
    .map((record) => Number(sanitizeSelfTalkAuditRecord(record).ts))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const firstTs = tsList[0] ?? null;
  const lastTs = tsList.at(-1) ?? null;
  return {
    firstTs,
    lastTs,
    firstAt: isoOrNull(firstTs),
    lastAt: isoOrNull(lastTs),
    spanHours: firstTs != null && lastTs != null
      ? Math.round(((lastTs - firstTs) / 3_600_000) * 1000) / 1000
      : 0,
  };
}

function thresholdReviewDecision({ coversFullWindow, guardRecords }) {
  if (!coversFullWindow) {
    return Object.freeze({
      thresholdTuningReady: false,
      reason: 'window_not_fully_covered',
      recommendedAction: 'continue_collecting_window',
    });
  }
  if (guardRecords <= 0) {
    return Object.freeze({
      thresholdTuningReady: false,
      reason: 'no_guard_records_in_window',
      recommendedAction: 'continue_collecting_guard_records',
    });
  }
  return Object.freeze({
    thresholdTuningReady: true,
    reason: 'window_ready_for_threshold_review',
    recommendedAction: 'review_guard_records_before_threshold_change',
  });
}

export function summarizeSelfTalkAuditReplay(records = [], {
  malformed = 0,
  now = Date.now(),
  windowsHours = [],
} = {}) {
  const full = summarizeSelfTalkAudit(records, { malformed });
  const allTs = records
    .map((record) => Number(sanitizeSelfTalkAuditRecord(record).ts))
    .filter(Number.isFinite);
  const windows = windowsHours.map((hours) => {
    const since = now - hours * 3_600_000;
    const windowRecords = records.filter((record) => {
      const ts = Number(sanitizeSelfTalkAuditRecord(record).ts);
      return Number.isFinite(ts) && ts >= since && ts <= now;
    });
    const summary = summarizeSelfTalkAudit(windowRecords, { malformed: 0 });
    const range = compactTsRange(windowRecords);
    const hasOlderBoundaryEvidence = allTs.some((ts) => ts <= since);
    const hasRecentEvidence = allTs.some((ts) => ts <= now && ts >= now - 15 * 60_000);
    const decision = thresholdReviewDecision({
      coversFullWindow: hasOlderBoundaryEvidence,
      guardRecords: Number(summary.guardRecords || 0),
    });
    return {
      hours,
      sinceTs: since,
      sinceAt: new Date(since).toISOString(),
      untilTs: now,
      untilAt: new Date(now).toISOString(),
      coversFullWindow: hasOlderBoundaryEvidence,
      hasRecentEvidence,
      coverageHours: range.spanHours,
      firstAt: range.firstAt,
      lastAt: range.lastAt,
      decision,
      summary,
    };
  });
  return {
    ...full,
    generatedAt: new Date(now).toISOString(),
    auditRange: compactTsRange(records),
    ...(windows.length ? { windows } : {}),
  };
}

export function buildReplayReportFromText(text, {
  file = '',
  now = Date.now(),
  windowsHours = [],
} = {}) {
  const parsed = parseSelfTalkAuditJsonl(text);
  return {
    ...summarizeSelfTalkAuditReplay(parsed.records, { malformed: parsed.malformed, now, windowsHours }),
    file,
  };
}

export function writeReplayReport(report, outFile) {
  if (!outFile) return null;
  const file = resolve(outFile);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function main(argv = process.argv.slice(2)) {
  const arg = (name, fallback = null) => {
    const idx = argv.indexOf(name);
    return idx >= 0 ? argv[idx + 1] || fallback : fallback;
  };
  const file = resolve(arg('--file', 'output/noe-self-talk-audit/self-talk-audit.jsonl'));
  if (!existsSync(file)) {
    console.log(JSON.stringify({
      ok: false,
      reason: 'audit_file_missing',
      file,
    }, null, 2));
    return 1;
  }
  const windowsHours = parseWindows(arg('--windows', ''));
  const report = buildReplayReportFromText(readFileSync(file, 'utf8'), {
    file,
    windowsHours,
  });
  const outFile = arg('--out', '');
  const written = outFile ? writeReplayReport(report, outFile) : null;
  console.log(JSON.stringify({
    ...report,
    ...(written ? { outFile: written } : {}),
  }, null, 2));
  return report.ok ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  process.exit(main());
}
