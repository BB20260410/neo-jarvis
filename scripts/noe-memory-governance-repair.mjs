#!/usr/bin/env node
// @ts-check

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initSqlite, close } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryRetriever } from '../src/memory/NoeMemoryRetriever.js';
import { buildNoeMemoryStatus } from '../src/memory/NoeMemoryStatus.js';
import { applyNoeMemoryGovernanceRepair } from '../src/memory/NoeMemoryGovernanceRepair.js';

function argValue(name, fallback = '') {
  const prefix = `${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : fallback;
}

function flag(name) {
  return process.argv.includes(name);
}

function summarizeRepair(repair) {
  return {
    ok: repair.ok,
    projectId: repair.projectId,
    scanned: repair.scanned,
    truncated: repair.truncated,
    plannedInsertCount: repair.insertCount,
    plannedStrongInsertCount: repair.strongInsertCount,
    plannedWeakInsertCount: repair.weakInsertCount,
    applied: repair.applied,
    inserted: repair.inserted,
  };
}

const apply = flag('--apply');
const includeHidden = flag('--include-hidden');
const probeRetrieval = flag('--probe-retrieval');
const projectId = argValue('--project-id', 'noe') || 'noe';
const query = argValue('--query', '长期记忆 来源证据 用户偏好') || '长期记忆 来源证据 用户偏好';
const turnId = `memory-governance-repair-${Date.now()}`;
const outDir = join(process.cwd(), 'output', 'noe-memory-governance-repair');
mkdirSync(outDir, { recursive: true });

let report;
try {
  const db = initSqlite();
  const before = buildNoeMemoryStatus({ db });
  const repair = applyNoeMemoryGovernanceRepair({
    db,
    projectId,
    includeHidden,
    apply,
    now: () => Date.now(),
  });
  let retrievalProbe = null;
  if (probeRetrieval) {
    const memory = new MemoryCore({ logger: { warn: () => {} } });
    const auditLog = new NoeMemoryAuditLog({ db: () => memory.db() });
    const retriever = new NoeMemoryRetriever({ memory, auditLog, logger: { warn: () => {} } });
    const result = await retriever.retrieve({
      transcript: query,
      projectId,
      routeType: 'maintenance',
      turnId,
      memoryPolicy: { recallLimit: 8, injectLimit: 5 },
    });
    retrievalProbe = {
      ok: result.ok,
      turnId,
      selectedCount: Array.isArray(result.selectedIds) ? result.selectedIds.length : 0,
      hitCount: Array.isArray(result.hitIds) ? result.hitIds.length : 0,
      droppedReasons: result.droppedReasons || [],
    };
  }
  const after = buildNoeMemoryStatus({ db });
  report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    mode: apply ? 'apply' : 'dry_run',
    policy: {
      noMemoryBodyOutput: true,
      noSecretOutput: true,
      strongLinksAreNotFaked: true,
      weakLegacyLinksDoNotClearOrphanFacts: true,
      livePanelTouched: false,
    },
    before: {
      sourceLinked: before.sourceLinked,
      retrieval: before.retrieval,
      semanticProvider: before.semanticProvider,
    },
    repair: summarizeRepair(repair),
    retrievalProbe,
    after: {
      sourceLinked: after.sourceLinked,
      retrieval: after.retrieval,
      semanticProvider: after.semanticProvider,
    },
  };
} finally {
  close();
}

const file = join(outDir, `noe-memory-governance-repair-${Date.now()}.json`);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify({
  ok: report.ok,
  mode: report.mode,
  reportPath: file,
  repair: report.repair,
  before: report.before,
  after: report.after,
  retrievalProbe: report.retrievalProbe,
}, null, 2));
