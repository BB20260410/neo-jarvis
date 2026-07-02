// @ts-check

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent, close, getDb, initSqlite } from '../storage/SqliteStore.js';
import { MemoryCore } from './MemoryCore.js';
import { NoeMemoryAuditLog } from './NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from './NoeMemoryWriteGate.js';
import { NoeMemoryRetriever } from './NoeMemoryRetriever.js';
import { buildNoeMemoryStatus } from './NoeMemoryStatus.js';
import { runNoeMemoryRecallBenchmark } from './NoeMemoryRecallBenchmark.js';
import { runNoeMemoryMaintenanceDryRun } from './NoeMemoryMaintenanceDryRun.js';
import { planNoeMemoryProvenanceBackfill } from './NoeMemoryProvenanceBackfill.js';
import { collectNoeMemoryRuntimeStatus } from './NoeMemoryRuntimeStatus.js';

function makeStack(now) {
  const memory = new MemoryCore({
    conflictPolicy: { enabled: true, scanLimit: 20 },
    dedupe: { enabled: false },
    logger: { warn: () => {}, info: () => {} },
  });
  const auditLog = new NoeMemoryAuditLog({ db: () => getDb(), now });
  const writeGate = new NoeMemoryWriteGate({ memory, auditLog, now, logger: { warn: () => {} } });
  const retriever = new NoeMemoryRetriever({ memory, auditLog, now, logger: { warn: () => {} } });
  return { memory, auditLog, writeGate, retriever };
}

function check(id, passed, details = {}) {
  return { id, passed: passed === true, details };
}

export function latestJsonReport(dir, prefix, { predicate = null } = {}) {
  try {
    if (!existsSync(dir)) return null;
    const files = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort()
      .reverse();
    for (const file of files) {
      const path = join(dir, file);
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (typeof predicate === 'function' && !predicate(parsed, path)) continue;
      return { path, report: parsed };
    }
    return null;
  } catch {
    return null;
  }
}

export async function runNoeMemoryLifecycleCanary({ projectId = 'noe', now = () => 1781345000000 } = {}) {
  const { memory, auditLog, writeGate, retriever } = makeStack(now);
  const episodeEventId = appendEvent({
    kind: 'noe_episode',
    tag: 'memory_roadmap_canary',
    entityType: 'noe_memory_canary',
    projectId,
    episodeType: 'interaction',
    summary: '主人确认长期记忆 canary 偏好：保留来源链、召回、编辑、隐藏和恢复证据。',
    detail: 'memory roadmap canary',
  });
  const sourceEpisodeId = `events:${episodeEventId}`;
  const created = writeGate.commit({
    targetMemoryId: 'roadmap-canary-pref',
    kind: 'preference',
    projectId,
    body: '主人长期记忆 canary 偏好是保留来源链和可恢复删除证据。',
    sourceType: 'roadmap_canary',
    sourceEpisodeId,
    sourceEventIds: [String(episodeEventId)],
    evidenceRefs: [`events:${episodeEventId}.payload.summary`],
    confidence: 0.91,
    tags: ['memory', 'canary'],
  });
  const links = auditLog.linksForMemory(created.memory?.id);
  const retrieved = await retriever.retrieve({
    transcript: '来源链',
    projectId,
    routeType: 'chat',
    limit: 5,
    memoryPolicy: { recallLimit: 5, injectLimit: 5 },
    turnId: 'memory-roadmap-canary',
  });
  const edited = writeGate.commit({
    targetMemoryId: created.memory?.id,
    kind: 'preference',
    projectId,
    body: '主人长期记忆 canary 偏好是保留来源链、召回、编辑、隐藏和恢复证据。',
    sourceType: 'roadmap_canary_edit',
    sourceEpisodeId,
    evidenceRefs: [`episode:${sourceEpisodeId}`],
    confidence: 0.92,
    writeMode: 'owner_confirmed',
    actor: 'owner',
  });
  const hideOk = memory.hide(created.memory?.id, { projectId, reason: 'roadmap_canary_hide' });
  const hiddenGone = memory.get(created.memory?.id) === null;
  const unhideOk = memory.unhide(created.memory?.id, { projectId });
  const restored = memory.get(created.memory?.id) !== null;
  const deleteOk = memory.hide(created.memory?.id, { projectId, reason: 'roadmap_canary_delete' });
  const deletedGone = memory.get(created.memory?.id) === null;
  const replay = auditLog.replayCandidate(created.candidate?.id);
  const status = buildNoeMemoryStatus({ db: getDb(), now });
  const checks = [
    check('episode_recorded', Number(episodeEventId) > 0, { episodeRef: sourceEpisodeId }),
    check('gate_write_accepted', created.ok === true, { decision: created.decision, memoryId: created.memory?.id || null }),
    check('strong_source_links', links.some((l) => l.type === 'source_episode') && links.some((l) => l.type === 'evidence_ref'), { linkCount: links.length }),
    check('retrieval_selects_canary', (retrieved.selectedIds || []).includes(created.memory?.id), { selectedIds: retrieved.selectedIds || [] }),
    check('owner_confirmed_edit', edited.ok === true && /编辑/.test(memory.get(created.memory?.id, { includeHidden: true })?.body || ''), { decision: edited.decision }),
    check('hide_unhide_reversible', hideOk && hiddenGone && unhideOk && restored, { hideOk, unhideOk }),
    check('delete_is_reversible_hide', deleteOk && deletedGone, { deleteOk, reversible: true }),
    check('candidate_replay', replay.ok === true && replay.targetMemoryId === created.memory?.id, { candidateId: created.candidate?.id || null }),
    check('no_unreviewed_orphan_from_canary', status.sourceLinked.unreviewedOrphanFacts === 0, status.sourceLinked),
  ];
  return {
    ok: checks.every((item) => item.passed),
    checks,
    status: {
      counts: status.counts,
      sourceLinked: status.sourceLinked,
      retrieval: status.retrieval,
    },
    policy: {
      isolatedDbOnly: true,
      noMemoryBodyOutput: true,
      noSecretOutput: true,
    },
  };
}

export async function runNoeMemoryRoadmapVerification({
  projectId = 'noe',
  includeRealDb = true,
  runtimeStatusProvider = collectNoeMemoryRuntimeStatus,
} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'noe-memory-roadmap-'));
  let canary;
  let recallBenchmark;
  try {
    initSqlite(join(dir, 'panel.db'));
    canary = await runNoeMemoryLifecycleCanary({ projectId });
    close();
    initSqlite(join(dir, 'recall.db'));
    const { writeGate, retriever } = makeStack(() => Date.now());
    recallBenchmark = await runNoeMemoryRecallBenchmark({ writeGate, retriever, projectId });
  } finally {
    close();
    rmSync(dir, { recursive: true, force: true });
  }

  let real = null;
  if (includeRealDb) {
    try {
      initSqlite();
      const memory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
      const db = getDb();
      const liveRuntime = runtimeStatusProvider();
      const status = buildNoeMemoryStatus({ db, env: liveRuntime?.env || {} });
      const maintenance = await runNoeMemoryMaintenanceDryRun({ memory, db, projectId });
      const provenanceBackfill = planNoeMemoryProvenanceBackfill({ db, projectId, memoryLimit: 200, episodeLimit: 5000 });
      const copyValidation = latestJsonReport(
        join(process.cwd(), 'output', 'noe-memory-copy-validation'),
        'noe-memory-copy-validation-'
      );
      const relevanceBenchmark = latestJsonReport(
        join(process.cwd(), 'output', 'noe-memory-relevance-benchmark'),
        'noe-memory-relevance-benchmark-',
        { predicate: (report) => report?.mode === 'real_db_read_only' }
      );
      real = {
        ok: true,
        liveRuntime,
        copyValidation: copyValidation ? {
          path: copyValidation.path,
          ok: copyValidation.report?.ok === true,
          generatedAt: copyValidation.report?.generatedAt || null,
          ollama: {
            ok: copyValidation.report?.ollama?.ok === true,
            model: copyValidation.report?.ollama?.model || '',
            dim: copyValidation.report?.ollama?.dim || null,
          },
          semanticBackfill: {
            ok: copyValidation.report?.semanticBackfill?.ok === true,
            upserted: Number(copyValidation.report?.semanticBackfill?.upserted || 0),
            fallbackCount: Number(copyValidation.report?.semanticBackfill?.fallbackCount || 0),
            models: copyValidation.report?.semanticBackfill?.models || {},
          },
          retrievalComparison: {
            ftsSelectedRows: Number(copyValidation.report?.retrievalComparison?.fts?.selectedRows || 0),
            fusedSelectedRows: Number(copyValidation.report?.retrievalComparison?.fused?.selectedRows || 0),
            selectedDelta: Number(copyValidation.report?.retrievalComparison?.selectedDelta || 0),
            semanticQualityOk: copyValidation.report?.retrievalComparison?.semanticQualityOk === true,
          },
          maintenanceApply: {
            ok: copyValidation.report?.maintenance?.apply?.ok === true,
            hiddenCount: Number(copyValidation.report?.maintenance?.apply?.gcApply?.hiddenCount || 0),
            protectedAffected: copyValidation.report?.maintenance?.apply?.gcApply?.protectedAffected || [],
          },
        } : null,
        relevanceBenchmark: relevanceBenchmark ? {
          path: relevanceBenchmark.path,
          ok: relevanceBenchmark.report?.ok === true,
          generatedAt: relevanceBenchmark.report?.generatedAt || null,
          mode: relevanceBenchmark.report?.mode || '',
          caseFile: relevanceBenchmark.report?.caseFile || null,
          semantic: relevanceBenchmark.report?.semantic || null,
          summary: relevanceBenchmark.report?.summary || {},
        } : null,
        status: {
          counts: status.counts,
          sourceLinked: status.sourceLinked,
          semanticProvider: status.semanticProvider,
          maintenance: status.maintenance,
          retrieval: status.retrieval,
          writeGate: status.writeGate,
        },
        maintenance,
        provenanceBackfill,
        readiness: {
          unreviewedOrphanFactsOk: status.sourceLinked.unreviewedOrphanFacts === 0,
          quarantineOk: status.writeGate.quarantineCount === 0,
          semanticRuntimeEnabled: liveRuntime?.ok === true && status.semanticProvider.enabled === true,
          retrievalEvidenceOk: Number(status.retrieval?.logs || 0) >= 20,
          maintenanceActive: liveRuntime?.ok === true && Boolean(status.maintenance?.dream?.enabled || status.maintenance?.episodeSublimation?.enabled || status.maintenance?.memoryGc?.enabled),
          semanticCopyValidated: copyValidation?.report?.ok === true && copyValidation?.report?.semanticBackfill?.ok === true,
          semanticCopyImprovesRetrieval: Number(copyValidation?.report?.retrievalComparison?.selectedDelta || 0) > 0
            && copyValidation?.report?.retrievalComparison?.semanticQualityOk === true,
          semanticRelevanceBenchmarkPassed: relevanceBenchmark?.report?.ok === true
            && relevanceBenchmark?.report?.mode === 'real_db_read_only'
            && Number(relevanceBenchmark?.report?.summary?.cases || 0) >= 2
            && relevanceBenchmark?.report?.summary?.semanticQualityOk === true,
          maintenanceCopyApplySafe: copyValidation?.report?.maintenance?.apply?.ok === true
            && (copyValidation?.report?.maintenance?.apply?.gcApply?.protectedAffected || []).length === 0,
        },
      };
    } finally {
      close();
    }
  }

  const requiredChecks = [
    check('isolated_lifecycle_canary', canary.ok === true, { failed: canary.checks.filter((c) => !c.passed).map((c) => c.id) }),
    check('recall_benchmark', recallBenchmark.ok === true, recallBenchmark.summary),
    check('real_db_status_readable', includeRealDb ? real?.ok === true : true, {}),
    check('real_db_no_unreviewed_orphans', includeRealDb ? real?.readiness?.unreviewedOrphanFactsOk === true : true, real?.status?.sourceLinked || {}),
    check('real_db_quarantine_clear', includeRealDb ? real?.readiness?.quarantineOk === true : true, real?.status?.writeGate || {}),
  ];
  const advisoryChecks = includeRealDb ? [
    check('semantic_runtime_enabled', real?.readiness?.semanticRuntimeEnabled === true, real?.status?.semanticProvider || {}),
    check('retrieval_evidence_sample_sufficient', real?.readiness?.retrievalEvidenceOk === true, real?.status?.retrieval || {}),
    check('maintenance_loop_active', real?.readiness?.maintenanceActive === true, real?.status?.maintenance || {}),
    check('semantic_copy_validation_passed', real?.readiness?.semanticCopyValidated === true, real?.copyValidation?.semanticBackfill || {}),
    check('semantic_copy_validation_improves_retrieval', real?.readiness?.semanticCopyImprovesRetrieval === true, real?.copyValidation?.retrievalComparison || {}),
    check('semantic_relevance_benchmark_passed', real?.readiness?.semanticRelevanceBenchmarkPassed === true, real?.relevanceBenchmark?.summary || {}),
    check('maintenance_copy_apply_safe', real?.readiness?.maintenanceCopyApplySafe === true, real?.copyValidation?.maintenanceApply || {}),
  ] : [];
  return {
    ok: requiredChecks.every((item) => item.passed),
    generatedAt: new Date().toISOString(),
    requiredChecks,
    advisoryChecks,
    canary,
    recallBenchmark,
    real,
    policy: {
      noLivePanelRestart: true,
      livePanelTouched: false,
      port51735Touched: false,
      noMemoryBodyOutput: true,
      noSecretOutput: true,
      realDbWrites: false,
    },
  };
}
