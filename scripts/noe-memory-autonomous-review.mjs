#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSqlite, close } from '../src/storage/SqliteStore.js';
import { buildNoeMemoryStatus } from '../src/memory/NoeMemoryStatus.js';
import {
  runNoeMemoryAutonomousReview,
  writeAutonomousReviewMarkdown,
} from '../src/memory/NoeMemoryAutonomousReview.js';
import { discoverVaults } from './obsidian-mcp-readiness.mjs';

function flag(name) {
  return process.argv.includes(name);
}

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function summarize(report) {
  return {
    ok: report.ok,
    mode: report.mode,
    projectId: report.projectId,
    scanned: report.scanned,
    reviewed: report.reviewed,
    hidden: report.hidden,
    summary: report.summary,
    candidatesRecorded: report.candidatesRecorded,
    linksRecorded: report.linksRecorded,
    policy: report.policy,
  };
}

function firstVaultPath() {
  const vaults = discoverVaults();
  const selected = vaults.find((v) => v.open && v.exists && v.hasObsidianDir)
    || vaults.find((v) => v.exists && v.hasObsidianDir);
  return selected?.path || '';
}

const apply = flag('--apply');
const mirrorObsidian = flag('--mirror-obsidian');
const noHideUnsafe = flag('--no-hide-unsafe');
const projectId = argValue('--project-id', 'noe') || 'noe';
const limit = Number(argValue('--limit', '500')) || 500;
const outDir = join(process.cwd(), 'output', 'noe-memory-autonomous-review');
mkdirSync(outDir, { recursive: true });

let report;
let statusBefore;
let statusAfter;
let markdownPath = '';
let obsidianPath = '';

try {
  const db = initSqlite();
  statusBefore = buildNoeMemoryStatus({ db });
  report = runNoeMemoryAutonomousReview({
    db,
    apply,
    hideUnsafe: !noHideUnsafe,
    projectId,
    limit,
    now: () => Date.now(),
  });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  markdownPath = writeAutonomousReviewMarkdown({
    report,
    dir: outDir,
    filename: `${stamp}-review.md`,
  });
  if (mirrorObsidian) {
    const vault = firstVaultPath();
    if (vault) {
      obsidianPath = writeAutonomousReviewMarkdown({
        report,
        dir: join(vault, 'Noe', 'Memory Governance'),
        filename: `${stamp}-review.md`,
      });
    }
  }
  statusAfter = buildNoeMemoryStatus({ db });
} finally {
  close();
}

const fullReport = {
  ok: true,
  generatedAt: new Date().toISOString(),
  mode: apply ? 'apply' : 'dry_run',
  before: {
    sourceLinked: statusBefore.sourceLinked,
    writeGate: statusBefore.writeGate,
  },
  review: {
    ...summarize(report),
    items: report.reviews.map((item) => ({
      memoryId: item.memoryId,
      decision: item.decision,
      reason: item.reason,
      trust: item.trust,
      action: item.action,
      confidence: item.confidence,
      salience: item.salience,
      sourceType: item.sourceType,
      bodySnippet: item.bodySnippet,
    })),
  },
  after: {
    sourceLinked: statusAfter.sourceLinked,
    writeGate: statusAfter.writeGate,
  },
  artifacts: {
    reportPath: '',
    markdownPath,
    obsidianPath,
  },
};

const reportPath = join(outDir, `noe-memory-autonomous-review-${Date.now()}.json`);
fullReport.artifacts.reportPath = reportPath;
writeFileSync(reportPath, `${JSON.stringify(fullReport, null, 2)}\n`, { mode: 0o600 });

console.log(JSON.stringify({
  ok: true,
  mode: fullReport.mode,
  before: fullReport.before,
  review: summarize(report),
  after: fullReport.after,
  artifacts: fullReport.artifacts,
}, null, 2));
