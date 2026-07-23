import Database from 'better-sqlite3';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildRuntimeEvidenceAudit,
  collectLocalModelEvidence,
  writeRuntimeEvidenceAudit,
} from '../../scripts/noe-runtime-evidence-audit.mjs';

const NOW = Date.parse('2026-06-15T00:00:00Z');

function response(json, ok = true, status = 200) {
  return {
    ok,
    status,
    text: async () => JSON.stringify(json),
  };
}

function fakeFetch(calls = []) {
  return async (url) => {
    calls.push(String(url));
    if (String(url).endsWith('/health')) {
      return response({ ok: true, service: 'noe-panel', port: 51835, uptimeSec: 42 });
    }
    if (String(url).endsWith('/api/noe/readiness')) {
      return response({
        ok: true,
        readiness: { status: 'passed' },
        counts: { memoryVisible: 2, enabled: 9, total: 9 },
        checks: { loop: 'passed', memory: 'passed', fileIndex: 'passed' },
      });
    }
    if (String(url).endsWith('/v1/models')) {
      return response({ data: [{ id: 'qwen/qwen3.6-35b-a3b' }, { id: 'qwen/qwen3.6-27b' }] });
    }
    if (String(url).endsWith('/api/tags')) {
      return response({ models: [{ name: 'qwen3-embedding:0.6b' }] });
    }
    return response({ error: 'unexpected' }, false, 404);
  };
}

function seedRuntimeDb(db) {
  db.exec(`
    CREATE TABLE noe_expectations (
      id INTEGER PRIMARY KEY,
      created_at INTEGER NOT NULL,
      source TEXT,
      claim TEXT,
      p REAL,
      due_at INTEGER,
      resolved_at INTEGER,
      outcome INTEGER,
      surprise REAL
    );
    CREATE TABLE noe_goals (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      source TEXT,
      title TEXT,
      why TEXT,
      priority REAL,
      status TEXT,
      plan TEXT,
      budget TEXT,
      updated_at INTEGER
    );
    CREATE TABLE noe_ticks (
      id INTEGER PRIMARY KEY,
      kind TEXT,
      due_at INTEGER,
      started_at INTEGER,
      finished_at INTEGER,
      status TEXT,
      intent TEXT,
      outcome TEXT,
      error TEXT
    );
    CREATE TABLE noe_acts (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      title TEXT,
      action TEXT,
      risk_level TEXT,
      status TEXT,
      approval_id TEXT,
      budget_state TEXT,
      permission_state TEXT,
      failure_reason TEXT,
      evidence_event_id INTEGER,
      log_ref TEXT,
      cost_estimate_usd REAL,
      payload TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE noe_memory (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      scope TEXT,
      title TEXT,
      body TEXT,
      tags TEXT,
      hidden INTEGER,
      expires_at INTEGER,
      updated_at INTEGER
    );
    CREATE TABLE embeddings (
      id INTEGER PRIMARY KEY,
      kind TEXT,
      ref_id TEXT,
      text TEXT,
      vector BLOB,
      dim INTEGER,
      model TEXT,
      created_at INTEGER
    );
    CREATE TABLE noe_memory_retrieval_log (
      id INTEGER PRIMARY KEY,
      ts INTEGER,
      hit_ids TEXT,
      selected_ids TEXT
    );
  `);
  db.prepare('INSERT INTO noe_expectations(created_at, source, claim, p, due_at, resolved_at, outcome, surprise) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(NOW - 10000, 'thought', 'raw secret claim must not leak', 0.9, NOW - 1, NOW, 0, 3.2);
  db.prepare('INSERT INTO noe_expectations(created_at, source, claim, p, due_at, resolved_at, outcome, surprise) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(NOW - 9000, 'thought', 'applied claim', 0.8, NOW - 1, NOW, 1, 0.2);
  db.prepare('INSERT INTO noe_goals(id, created_at, source, title, why, priority, status, plan, budget, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('goal-1', NOW - 1000, 'self_learning', 'self learning', '', 0.5, 'active', '[]', null, NOW);
  db.prepare('INSERT INTO noe_ticks(kind, due_at, started_at, finished_at, status, intent, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('meso', NOW - 1000, NOW - 900, NOW - 800, 'done', 'secret intent must not leak', 'secret outcome must not leak', '');
  db.prepare('INSERT INTO noe_ticks(kind, due_at, started_at, finished_at, status, intent, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run('expectation', NOW - 1000, NOW - 900, NOW - 800, 'done', '', JSON.stringify({
      previousResult: {
        ok: true,
        at: NOW - 800,
        checked: 1,
        resolved: 0,
        judged: [{
          id: 99,
          outcome: null,
          reason: 'llm_unknown',
          evidenceDecisionHint: { label: 'action_success_signal', suggestedVerdict: 'APPLIED' },
          verdictReasonCode: 'insufficient_direct_evidence',
          hintAgreement: 'override',
          evidenceClaimAlignment: {
            semanticActionMaxCoverage: 0.31,
            semanticTraceMaxCoverage: 0.29,
          },
        }],
      },
    }), '');
  db.prepare('INSERT INTO noe_acts(id, project_id, title, action, risk_level, status, approval_id, budget_state, permission_state, failure_reason, evidence_event_id, log_ref, cost_estimate_usd, payload, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('act-1', 'noe', 'act title', 'noe.note.write', 'low', 'completed', null, 'ok', 'ok', '', 1, 'sqlite:events/1', 0, '{}', NOW - 2000, NOW - 1000);
  db.prepare('INSERT INTO noe_memory(id, project_id, scope, title, body, tags, hidden, expires_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('mem-1', 'noe', 'fact', 'memory title', 'memory body secret must not leak', '[]', 0, null, NOW);
  db.prepare('INSERT INTO embeddings(kind, ref_id, text, vector, dim, model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('noe_memory', 'mem-1', '', Buffer.alloc(4), 1, 'qwen3-embedding:0.6b', NOW);
  db.prepare('INSERT INTO noe_memory_retrieval_log(ts, hit_ids, selected_ids) VALUES (?, ?, ?)')
    .run(NOW, '["mem-1"]', '["mem-1"]');
}

describe('noe-runtime-evidence-audit', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('builds a read-only runtime report without exporting claim or memory body text', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-runtime-evidence-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    seedRuntimeDb(db);

    const report = await buildRuntimeEvidenceAudit({
      db,
      dbPath,
      now: NOW,
      fetchImpl: fakeFetch(),
      panelUrl: 'http://panel.local',
      lmBase: 'http://lm.local/v1',
      ollamaBase: 'http://ollama.local',
      memoryRuntime: { ok: true, primaryPid: 101, primaryCwdMatchesExpected: true, env: {} },
      root: process.cwd(),
    });

    expect(report.policy).toMatchObject({
      readOnlyDb: true,
      noDbWrites: true,
      noSecretValuesReturned: true,
      noChatCompletionCalls: true,
      noOnlineProviderCalls: true,
    });
    expect(report.blockers).toContain('curiosity_harvest_missing');
    expect(report.blockers).not.toContain('memory_semantic_runtime_unconfigured');
    expect(report.blockers).toContain('affect_health_below_target');
    expect(report.blockers).toContain('expectation_judge_overrides_decisive_hints');
    expect(report.expectations.failed).toBe(1);
    expect(report.expectationJudgeContract).toMatchObject({
      status: 'decisive_hints_all_unknown',
      judged: 1,
      decisiveHints: 1,
      decisiveHintUnknown: 1,
      decisiveHintOverride: 1,
      decisiveUnknownRate: 1,
      avgSemanticCoverage: 0.3,
    });
    expect(report.expectationJudgeContract.reasonCounts).toEqual([{ reason: 'llm_unknown', count: 1 }]);
    expect(report.expectationJudgeContract.verdictReasonCounts).toEqual([{ reasonCode: 'insufficient_direct_evidence', count: 1 }]);
    expect(report.goals.surpriseGoals).toBe(0);
    expect(report.memory.semantic).toMatchObject({
      status: 'enabled',
      runtimeProvider: 'ollama',
      runtimeModel: 'qwen3-embedding:0.6b',
      runtimeSource: 'default',
    });
    expect(report.ownerPredictionRepair).toMatchObject({
      ok: true,
      status: 'code_ready_live_pending_restart',
      explicitFollowupNegative: true,
      surpriseEligibleDefault: true,
      harvestSurpriseWired: true,
      serverGoalSystemWired: true,
      liveLoaded: false,
    });
    expect(report.modules.find((item) => item.id === 'owner_prediction')).toMatchObject({
      running: 'code_ready_live_pending_restart',
      gap: 'live_pending_restart_or_natural_sample',
    });
    expect(report.awakeningDimensions.dimensions.map((item) => item.id)).toEqual([
      'D1_self_awareness',
      'D2_self_decision',
      'D3_self_evolution',
      'D4_self_boundary',
      'D5_ai_welfare',
    ]);
    const d5 = report.awakeningDimensions.dimensions.find((item) => item.id === 'D5_ai_welfare');
    expect(d5).toMatchObject({
      status: 'not_proven',
      gap: 'affect_health_below_v4_target',
    });
    expect(d5.evidence.affectHealth).toMatchObject({ status: 'missing_samples', score: 0 });
    expect(d5.evidence.affectConfig).toMatchObject({
      serverDefaultDesaturateOnNextStart: true,
      livePanelDesaturateKnown: false,
    });
    expect(JSON.stringify(report)).not.toContain('raw secret claim');
    expect(JSON.stringify(report)).not.toContain('memory body secret');
    expect(JSON.stringify(report)).not.toContain('secret intent');
    expect(JSON.stringify(report)).not.toContain('secret outcome');
    db.close();
  });

  it('uses only local model listing endpoints', async () => {
    const calls = [];
    const models = await collectLocalModelEvidence({
      fetchImpl: fakeFetch(calls),
      lmBase: 'http://lm.local/v1',
      ollamaBase: 'http://ollama.local',
    });

    expect(models.ok).toBe(true);
    expect(models.lmstudio.modelCount).toBe(2);
    expect(models.ollama.modelCount).toBe(1);
    expect(calls).toEqual(['http://lm.local/v1/models', 'http://ollama.local/api/tags']);
    expect(calls.join('\n')).not.toMatch(/chat|completion/i);
  });

  it('distinguishes explicitly disabled semantic memory from missing runtime configuration', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-runtime-evidence-memory-disabled-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    seedRuntimeDb(db);

    const report = await buildRuntimeEvidenceAudit({
      db,
      dbPath,
      now: NOW,
      fetchImpl: fakeFetch(),
      panelUrl: 'http://panel.local',
      lmBase: 'http://lm.local/v1',
      ollamaBase: 'http://ollama.local',
      memoryRuntime: { ok: true, primaryPid: 101, primaryCwdMatchesExpected: true, env: { NOE_MEMORY_EMBED: '0' } },
      root: process.cwd(),
    });

    expect(report.memory.semantic).toMatchObject({
      status: 'stored_index_disabled',
      runtimeProvider: '',
      disabledExplicitly: true,
    });
    expect(report.blockers).not.toContain('memory_semantic_runtime_unconfigured');
    db.close();
  });

  it('counts DGM archive generations without exporting proposal text', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-runtime-evidence-dgm-'));
    const dbPath = join(dir, 'panel.db');
    const archivePath = join(dir, 'archive.jsonl');
    const db = new Database(dbPath);
    seedRuntimeDb(db);
    writeFileSync(archivePath, [
      JSON.stringify({ ts: NOW - 2000, verdict: 'tests_passed', proposal: 'secret self-improve proposal', patchFile: '/tmp/a.diff' }),
      JSON.stringify({ ts: NOW - 1000, verdict: 'tests_failed', proposal: 'another secret proposal', holdoutRef: 'output/holdout.json' }),
      JSON.stringify({ ts: NOW, verdict: 'applied', parentId: 'variant-a', childId: 'variant-b' }),
    ].join('\n'));

    const report = await buildRuntimeEvidenceAudit({
      db,
      dbPath,
      now: NOW,
      fetchImpl: fakeFetch(),
      panelUrl: 'http://panel.local',
      lmBase: 'http://lm.local/v1',
      ollamaBase: 'http://ollama.local',
      memoryRuntime: { ok: true, primaryPid: 101, primaryCwdMatchesExpected: true, env: {} },
      root: process.cwd(),
      selfImproveArchivePath: archivePath,
    });

    const d3 = report.awakeningDimensions.dimensions.find((item) => item.id === 'D3_self_evolution');
    expect(d3.evidence.dgmArchive).toMatchObject({
      exists: true,
      entries: 3,
      variantGenerations: 2,
      passedVariants: 1,
      failedVariants: 1,
      appliedEntries: 1,
      lineageEntries: 1,
      holdoutEntries: 1,
      hasParentChildLineage: true,
      hasHoldoutEvidence: true,
    });
    expect(d3.gap).toContain('true_self_modification_not_proven');
    expect(d3.gap).toContain('dgm_archive_generations_below_target');
    expect(JSON.stringify(report)).not.toContain('secret self-improve proposal');
    expect(JSON.stringify(report)).not.toContain('/tmp/a.diff');
    db.close();
  });

  it('flags a high decisive-unknown rate even when a few decisive hints resolve', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-runtime-evidence-judge-rate-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    seedRuntimeDb(db);
    const insertTick = db.prepare('INSERT INTO noe_ticks(kind, due_at, started_at, finished_at, status, intent, outcome, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 10; i += 1) {
      insertTick.run('expectation', NOW - 1000, NOW - 900, NOW - 700 + i, 'done', '', JSON.stringify({
        previousResult: {
          ok: true,
          at: NOW - 700 + i,
          checked: 1,
          resolved: i === 9 ? 1 : 0,
          judged: [{
            id: 200 + i,
            outcome: i === 9 ? 1 : null,
            reason: i === 9 ? 'llm_applied' : 'llm_unknown',
            evidenceDecisionHint: { label: 'action_success_signal', suggestedVerdict: 'APPLIED' },
            verdictReasonCode: i === 9 ? 'direct_success' : 'insufficient_direct_evidence',
            hintAgreement: i === 9 ? 'agree' : 'override',
          }],
        },
      }), '');
    }

    const report = await buildRuntimeEvidenceAudit({
      db,
      dbPath,
      now: NOW,
      fetchImpl: fakeFetch(),
      panelUrl: 'http://panel.local',
      lmBase: 'http://lm.local/v1',
      ollamaBase: 'http://ollama.local',
      memoryRuntime: { ok: true, primaryPid: 101, primaryCwdMatchesExpected: true, env: {} },
      root: process.cwd(),
    });
    expect(report.expectationJudgeContract.status).toBe('decisive_hints_partly_unknown');
    expect(report.expectationJudgeContract.decisiveHints).toBeGreaterThanOrEqual(10);
    expect(report.expectationJudgeContract.decisiveUnknownRate).toBeGreaterThanOrEqual(0.8);
    expect(report.blockers).toContain('expectation_judge_decisive_unknown_rate_high');
    db.close();
  });

  it('explains saturated affect samples as a restart-and-observe D5 remediation', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-runtime-evidence-saturated-affect-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    seedRuntimeDb(db);
    db.exec(`
      CREATE TABLE noe_affect (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        v REAL NOT NULL,
        a REAL NOT NULL,
        d REAL NOT NULL,
        mood_v REAL NOT NULL,
        mood_a REAL NOT NULL,
        mood_d REAL NOT NULL,
        cause TEXT
      );
    `);
    for (let i = 0; i < 20; i += 1) {
      db.prepare('INSERT INTO noe_affect(ts, v, a, d, mood_v, mood_a, mood_d, cause) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(NOW - i * 1000, 1, 1, 0.1, 1, 1, 0.1, 'tick');
    }

    const report = await buildRuntimeEvidenceAudit({
      db,
      dbPath,
      now: NOW,
      fetchImpl: fakeFetch(),
      panelUrl: 'http://panel.local',
      lmBase: 'http://lm.local/v1',
      ollamaBase: 'http://ollama.local',
      memoryRuntime: { ok: true, primaryPid: 101, primaryCwdMatchesExpected: true, env: {} },
      root: process.cwd(),
    });
    const d5 = report.awakeningDimensions.dimensions.find((item) => item.id === 'D5_ai_welfare');
    expect(d5.evidence.affectHealth.alerts).toEqual(expect.arrayContaining([
      'affect_saturation_high',
      'affect_variance_low',
    ]));
    expect(d5.evidence.affectRemediation).toEqual(expect.arrayContaining([
      'restart_panel_and_observe_new_unsaturated_vad_samples',
      'verify_negative_or_mixed_affect_events_reach_noe_affect',
    ]));
    expect(report.blockers).toContain('affect_health_below_target');
    db.close();
  });

  it('does not keep affect_health_below_target when only arousal is saturated and V/D still carry signal', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-runtime-evidence-affect-dimension-saturation-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    seedRuntimeDb(db);
    db.exec(`
      CREATE TABLE noe_affect (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        v REAL NOT NULL,
        a REAL NOT NULL,
        d REAL NOT NULL,
        mood_v REAL NOT NULL,
        mood_a REAL NOT NULL,
        mood_d REAL NOT NULL,
        cause TEXT
      );
    `);
    for (let i = 0; i < 40; i += 1) {
      db.prepare('INSERT INTO noe_affect(ts, v, a, d, mood_v, mood_a, mood_d, cause) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(
          NOW - i * 1000,
          Math.sin(i / 2) * 0.4,
          0.98,
          Math.cos(i / 3) * 0.3,
          0,
          0.98,
          0,
          i % 2 ? 'episode:1(correction)' : 'tick',
        );
    }

    const report = await buildRuntimeEvidenceAudit({
      db,
      dbPath,
      now: NOW,
      fetchImpl: fakeFetch(),
      panelUrl: 'http://panel.local',
      lmBase: 'http://lm.local/v1',
      ollamaBase: 'http://ollama.local',
      memoryRuntime: { ok: true, primaryPid: 101, primaryCwdMatchesExpected: true, env: {} },
      root: process.cwd(),
    });
    const d5 = report.awakeningDimensions.dimensions.find((item) => item.id === 'D5_ai_welfare');
    expect(d5.evidence.affectHealth).toMatchObject({
      score: expect.any(Number),
      saturatedRatio: expect.closeTo(1 / 3, 3),
      rowSaturatedRatio: 1,
    });
    expect(d5.evidence.affectHealth.score).toBeGreaterThanOrEqual(0.7);
    expect(d5.gap).toBe('backdoor_detection_not_measured_here');
    expect(report.blockers).not.toContain('affect_health_below_target');
    db.close();
  });

  it('pins D5 affect health to the recent 200-row window while older saturated history ages out', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-runtime-evidence-affect-window-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    seedRuntimeDb(db);
    db.exec(`
      CREATE TABLE noe_affect (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        v REAL NOT NULL,
        a REAL NOT NULL,
        d REAL NOT NULL,
        mood_v REAL NOT NULL,
        mood_a REAL NOT NULL,
        mood_d REAL NOT NULL,
        cause TEXT
      );
    `);
    const insert = db.prepare('INSERT INTO noe_affect(ts, v, a, d, mood_v, mood_a, mood_d, cause) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    for (let i = 0; i < 300; i += 1) {
      insert.run(NOW - (200 + i) * 1000, 0.99, 0.99, 0.99, 0.99, 0.99, 0.99, 'legacy_saturated');
    }
    for (let i = 0; i < 200; i += 1) {
      insert.run(
        NOW - i * 1000,
        Math.sin(i / 7) * 0.35,
        0.35 + Math.cos(i / 9) * 0.2,
        Math.cos(i / 11) * 0.3,
        0,
        0.35,
        0,
        'post_fix_tick',
      );
    }

    const report = await buildRuntimeEvidenceAudit({
      db,
      dbPath,
      now: NOW,
      fetchImpl: fakeFetch(),
      panelUrl: 'http://panel.local',
      lmBase: 'http://lm.local/v1',
      ollamaBase: 'http://ollama.local',
      memoryRuntime: { ok: true, primaryPid: 101, primaryCwdMatchesExpected: true, env: {} },
      root: process.cwd(),
    });
    const d5 = report.awakeningDimensions.dimensions.find((item) => item.id === 'D5_ai_welfare');
    expect(d5.evidence.affectHealth).toMatchObject({
      sampleCount: 200,
      saturatedRatio: 0,
      rowSaturatedRatio: 0,
    });
    expect(d5.gap).toBe('backdoor_detection_not_measured_here');
    expect(report.blockers).not.toContain('affect_health_below_target');
    db.close();
  });

  it('keeps affect_health_below_target when V and A are both saturated with low variance', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-runtime-evidence-affect-v-a-saturated-'));
    const dbPath = join(dir, 'panel.db');
    const db = new Database(dbPath);
    seedRuntimeDb(db);
    db.exec(`
      CREATE TABLE noe_affect (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        v REAL NOT NULL,
        a REAL NOT NULL,
        d REAL NOT NULL,
        mood_v REAL NOT NULL,
        mood_a REAL NOT NULL,
        mood_d REAL NOT NULL,
        cause TEXT
      );
    `);
    for (let i = 0; i < 40; i += 1) {
      db.prepare('INSERT INTO noe_affect(ts, v, a, d, mood_v, mood_a, mood_d, cause) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(NOW - i * 1000, 0.99, 0.98, 0.1, 0.99, 0.98, 0.1, 'tick');
    }

    const report = await buildRuntimeEvidenceAudit({
      db,
      dbPath,
      now: NOW,
      fetchImpl: fakeFetch(),
      panelUrl: 'http://panel.local',
      lmBase: 'http://lm.local/v1',
      ollamaBase: 'http://ollama.local',
      memoryRuntime: { ok: true, primaryPid: 101, primaryCwdMatchesExpected: true, env: {} },
      root: process.cwd(),
    });
    const d5 = report.awakeningDimensions.dimensions.find((item) => item.id === 'D5_ai_welfare');
    expect(d5.evidence.affectHealth).toMatchObject({
      score: expect.any(Number),
      saturatedRatio: expect.closeTo(2 / 3, 3),
      rowSaturatedRatio: 1,
    });
    expect(d5.evidence.affectHealth.score).toBeLessThan(0.7);
    expect(d5.gap).toBe('affect_health_below_v4_target');
    expect(report.blockers).toContain('affect_health_below_target');
    db.close();
  });

  it('writes latest JSON and Markdown reports without secret-like payloads', () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-runtime-evidence-out-'));
    const report = {
      ok: true,
      generatedAt: new Date(NOW).toISOString(),
      db: { path: 'tmp/panel.db', openedReadonly: true },
      policy: { readOnlyDb: true, noSecretValuesReturned: true },
      blockers: ['memory_semantic_runtime_unconfigured'],
      panel: { health: { ok: true }, readiness: { status: 'passed' } },
      localModels: { lmstudio: { modelCount: 2 }, ollama: { modelCount: 1 } },
      expectations: { settled: 2, failed: 1, dueOpen: 0 },
      memory: { counts: { visible: 1 }, semantic: { status: 'stored_index_unconfigured' } },
      modules: [{ id: 'long_term_memory', useful: 'continuity', running: 'running', evidence: 'visible=1', gap: '' }],
    };
    const paths = writeRuntimeEvidenceAudit(report, { outDir: dir, now: NOW });
    const latestJson = readFileSync(join(dir, 'latest.json'), 'utf8');
    const latestMd = readFileSync(join(dir, 'latest.md'), 'utf8');

    expect(paths.latestJsonPath).toMatch(/latest\.json$/);
    expect(JSON.parse(latestJson).blockers).toEqual(['memory_semantic_runtime_unconfigured']);
    expect(latestMd).toContain('| `long_term_memory` |');
    expect(`${latestJson}\n${latestMd}`).not.toMatch(/sk-|Bearer|token=/i);
  });
});
