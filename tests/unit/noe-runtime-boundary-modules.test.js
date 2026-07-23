import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { recoverRetriableBlockedGoalSteps, recoverStaleGoalSteps } from '../../src/cognition/NoeGoalStepRecovery.js';
import { normalizeNoeTaskOutput } from '../../src/cloud/NoeTaskOutput.js';
import { ensureNoeMemoryV2Schema } from '../../src/storage/NoeMemoryV2Schema.js';
import { summarizeReportbacks } from '../../src/runtime/NoeWorkMapReportbacks.js';
import {
  buildNoeFreedomReadinessAuditDryRun,
  runNoeFreedomReadinessAudit,
} from '../../src/runtime/NoeFreedomReadinessAudit.js';

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function goalDb(rows = []) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE noe_goals (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      plan TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const insert = db.prepare('INSERT INTO noe_goals(id, status, plan, updated_at) VALUES (?, ?, ?, ?)');
  for (const row of rows) {
    insert.run(row.id, row.status || 'open', JSON.stringify(row.plan || []), row.updated_at || 0);
  }
  return db;
}

function rowOut(row) {
  return { ...row, plan: JSON.parse(row.plan || '[]') };
}

describe('NoeGoalStepRecovery', () => {
  it('recovers stale doing steps without replaying active act steps', () => {
    const now = 1_000_000;
    const db = goalDb([{
      id: 'goal-1',
      status: 'open',
      updated_at: now - 200_000,
      plan: [
        { step: 'research facts', kind: 'research', status: 'doing', updatedAt: now - 100_000 },
        { step: 'click button', kind: 'act', action: 'browser.click', status: 'doing', updatedAt: now - 10_000 },
      ],
    }]);
    try {
      const changed = recoverStaleGoalSteps({
        getdb: () => db,
        rowOut,
        t: now,
        staleResearchStepMs: 90_000,
        staleActStepMs: 300_000,
      });
      const goal = rowOut(db.prepare('SELECT * FROM noe_goals WHERE id = ?').get('goal-1'));
      const checkpoints = db.prepare('SELECT phase, status, replay_safe FROM noe_goal_checkpoints').all();

      expect(changed).toBe(1);
      expect(goal.plan[0].status).toBe('recovered');
      expect(goal.plan[0].note).toContain('自动恢复');
      expect(goal.plan[1].status).toBe('doing');
      expect(checkpoints).toEqual([{ phase: 'step_recovered', status: 'recovered', replay_safe: 0 }]);
    } finally {
      db.close();
    }
  });

  it('requeues retriable browser host mismatches and stops after bounded retries', () => {
    const now = 2_000_000;
    const db = goalDb([{
      id: 'goal-2',
      status: 'active',
      updated_at: now - 1,
      plan: [
        {
          step: 'open target',
          kind: 'act',
          status: 'done',
          action: 'browser.open_url',
          payload: { url: 'https://example.com/page?token=secret' },
        },
        {
          step: 'observe target',
          kind: 'act',
          status: 'blocked',
          action: 'browser.observe_page',
          note: 'browser_dom_host_mismatch: wrong foreground tab',
          payload: {},
        },
        {
          step: 'observe exhausted target',
          kind: 'act',
          status: 'blocked',
          action: 'browser.observe_page',
          note: 'browser_dom_host_mismatch: still wrong tab',
          retryCount: 2,
          payload: { url: 'https://example.org/final' },
        },
      ],
    }]);
    try {
      const changed = recoverRetriableBlockedGoalSteps({ getdb: () => db, rowOut, t: now });
      const goal = rowOut(db.prepare('SELECT * FROM noe_goals WHERE id = ?').get('goal-2'));
      const phases = db.prepare('SELECT phase, status FROM noe_goal_checkpoints ORDER BY ts, created_at').all();

      expect(changed).toBe(1);
      expect(goal.plan[1]).toMatchObject({
        status: 'open',
        retryCount: 1,
        payload: {
          url: 'https://example.com/page?token=secret',
          expectedHost: 'example.com',
          expectedHosts: ['example.com'],
        },
      });
      expect(goal.plan[2].status).toBe('recovered');
      expect(goal.plan[2].note).toContain('这一步没有伪装为完成');
      expect(phases).toEqual([
        { phase: 'step_recovered', status: 'open' },
        { phase: 'step_recovered', status: 'recovered' },
      ]);
    } finally {
      db.close();
    }
  });
});

describe('NoeMemoryV2Schema', () => {
  it('creates memory v2 tables and upgrades older link tables idempotently', () => {
    const db = new Database(':memory:');
    try {
      db.exec(`
        CREATE TABLE noe_memory_link (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          memory_id TEXT NOT NULL,
          link_type TEXT NOT NULL,
          link_ref TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE(memory_id, link_type, link_ref)
        );
      `);
      ensureNoeMemoryV2Schema(db);
      ensureNoeMemoryV2Schema(db);

      const candidateCols = db.prepare('PRAGMA table_info(noe_memory_candidate)').all().map((row) => row.name);
      const linkCols = db.prepare('PRAGMA table_info(noe_memory_link)').all().map((row) => row.name);
      const retrievalCols = db.prepare('PRAGMA table_info(noe_memory_retrieval_log)').all().map((row) => row.name);

      expect(candidateCols).toEqual(expect.arrayContaining(['privacy', 'evidence_refs', 'candidate_json', 'decided_at']));
      expect(linkCols).toContain('quote_hash');
      expect(retrievalCols).toEqual(expect.arrayContaining(['query_hash', 'selected_ids', 'dropped_reasons']));
      expect(() => ensureNoeMemoryV2Schema(null)).not.toThrow();
    } finally {
      db.close();
    }
  });
});

describe('NoeWorkMapReportbacks', () => {
  it('summarizes latest active reportbacks, stale items, and redacts secrets', () => {
    const dir = tempDir('noe-reportbacks-test-');
    const now = Date.parse('2026-06-15T00:00:00.000Z');
    try {
      writeFileSync(join(dir, 'task-reportbacks.json'), JSON.stringify({
        items: [
          {
            taskId: 'task-old',
            status: 'running',
            title: 'old copy',
            summary: 'older duplicate',
            updatedAt: now - 4 * 60 * 60 * 1000,
          },
          {
            taskId: 'task-old',
            status: 'running',
            title: 'Live task token=raw-secret-token-12345',
            summary: 'Need follow up with Authorization: Bearer abcdef1234567890',
            source: 'mission',
            evidenceRefs: ['e1', 'e2'],
            updatedAt: now - 2 * 60 * 60 * 1000,
          },
          {
            taskId: 'task-fresh',
            status: 'queued',
            title: 'fresh task',
            updatedAt: now - 5 * 60 * 1000,
          },
          {
            taskId: 'task-done',
            status: 'done',
            title: 'done task',
            updatedAt: now - 1,
          },
        ],
      }));

      const summary = summarizeReportbacks({ dataDir: dir, nowMs: now });

      expect(summary.total).toBe(4);
      expect(summary.current).toBe(3);
      expect(summary.active).toBe(2);
      expect(summary.staleActive).toBe(1);
      expect(summary.staleItems[0]).toMatchObject({
        id: 'task-old',
        status: 'running',
        nextAction: 'confirm_progress_or_mark_blocked',
      });
      expect(summary.items.map((item) => item.id)).toEqual(['task-old', 'task-fresh']);
      expect(summary.items[0].evidenceCount).toBe(2);
      expect(JSON.stringify(summary)).not.toContain('raw-secret-token-12345');
      expect(JSON.stringify(summary)).not.toContain('abcdef1234567890');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('NoeTaskOutput', () => {
  it('normalizes incomplete cloud task outputs without leaking obvious secrets', () => {
    const out = normalizeNoeTaskOutput({
      ok: true,
      reply: 'partial answer with api_key=unit-secret-1234567890',
      evidenceRefs: [' output/ref.json ', '', null],
      finish_reason: 'length',
      route: 'cloud-review',
      cost: { usd: 0.01 },
      durationMs: -10,
      provenance: 'provider',
      provider: 'minimax',
      model: 'MiniMax-M3',
      claimedSucceeded: true,
    });

    expect(out).toMatchObject({
      ok: true,
      finishReason: 'length',
      brainRoute: 'cloud-review',
      incomplete: true,
      truncated: true,
      durationMs: 0,
      provider: 'minimax',
      model: 'MiniMax-M3',
      claimedSucceeded: true,
    });
    expect(out.evidenceRefs).toEqual(['output/ref.json']);
    expect(out.text).not.toContain('unit-secret-1234567890');
  });
});

describe('NoeFreedomReadinessAudit direct surface', () => {
  it('dry-runs readiness without side effects or secret access', () => {
    const out = buildNoeFreedomReadinessAuditDryRun({
      tool: { id: 'noe.freedom.developer.readiness_audit' },
      args: {
        platforms: 'douyin,xiaohongshu',
        providerSecrets: 'minimax,openai',
        keychainRefs: [{ service: 'svc', account: 'acct' }],
        includeProviderHealth: true,
      },
      dryRunPlan: ({ adapter, extras }) => ({ ok: true, adapter, plannedOnly: true, ...extras }),
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'developer-readiness-audit',
      plannedOnly: true,
      platforms: ['douyin', 'xiaohongshu'],
      secretValuesReturned: false,
      externalSideEffectPerformed: false,
      publishPerformed: false,
      authority: {
        canReadSecrets: false,
        canPublishExternally: false,
        readinessOnly: true,
      },
    });
    expect(out.checks.providerSecrets).toEqual(['minimax', 'openai']);
    expect(out.checks.providerHealth).toEqual(['minimax', 'openai']);
    expect(out.checks.keychainRefs).toBe(1);
  });

  it('runs with injected probes and reports missing/unhealthy providers without secret values', async () => {
    const out = await runNoeFreedomReadinessAudit({
      args: {
        platforms: ['douyin'],
        includeBrowserState: false,
        includeSshInventory: false,
        includeMarketplace: false,
        includeDesktop: false,
        includeProviderSecrets: true,
        includeProviderHealth: true,
        providerSecrets: ['minimax', 'xiaomi', 'openai'],
        keychainRefs: [],
        env: { CODEX_BIN: 'codex', CLAUDE_BIN: 'claude', GEMINI_BIN: 'gemini' },
      },
      probes: {
        keychainRead: () => ({ ok: false, error: 'should not be called' }),
        providerSecrets: () => ({
          ok: true,
          providers: [
            { provider: 'minimax', configured: true, source: 'keychain', secretValuesReturned: false },
            { provider: 'xiaomi', configured: true, source: 'keychain', secretValuesReturned: false },
            { provider: 'openai', configured: false, source: 'missing', secretValuesReturned: false },
          ],
        }),
        providerHealth: async () => ({
          ok: true,
          reachableCount: 1,
          authOkCount: 1,
          unavailableProviders: ['xiaomi', 'openai'],
          providers: [
            { provider: 'minimax', configured: true, ok: true, model: 'MiniMax-M3', endpoint: 'https://api.example.test/v1/models', modelCount: 1 },
            { provider: 'xiaomi', configured: true, ok: false, status: 'unauthorized' },
            { provider: 'openai', configured: false, ok: false, status: 'missing_key' },
          ],
        }),
        commandResolver: (command) => (
          command === 'codex'
            ? { ok: true, command, path: '/usr/local/bin/codex', status: 'available' }
            : { ok: false, command, path: '', status: 'command_not_found' }
        ),
      },
    });

    expect(out.ok).toBe(true);
    expect(out.summary.providerSecretConfiguredCount).toBe(2);
    expect(out.summary.providerSecretMissingCount).toBe(1);
    expect(out.summary.providerHealthAuthOkCount).toBe(1);
    expect(out.summary.onlineModelAvailable).toEqual(['codex', 'm3']);
    expect(out.warnings).toEqual(expect.arrayContaining([
      'provider_secret_unconfigured:openai',
      'provider_health_unavailable:xiaomi:unauthorized',
      'provider_health_unavailable:openai:missing_key',
    ]));
    expect(out.nextFreedomActions.map((item) => item.stepId)).toEqual(expect.arrayContaining([
      'setup_missing_model_provider_keys',
      'recheck_unhealthy_model_providers',
    ]));
    expect(JSON.stringify(out)).not.toContain('unit-secret');
    expect(out.secretValuesReturned).toBe(false);
    expect(out.externalSideEffectPerformed).toBe(false);
  });
});

describe('WorkspaceManager destructive boundary', () => {
  it('keeps workspace create/delete constrained to a temporary HOME', () => {
    const home = tempDir('noe-workspace-home-');
    try {
      const moduleUrl = pathToFileURL(join(process.cwd(), 'src/workspace/WorkspaceManager.js')).href;
      const script = `
        import { existsSync } from 'node:fs';
        import { join } from 'node:path';
        import { homedir } from 'node:os';
        const m = await import(${JSON.stringify(moduleUrl)});
        const created = m.createWorkspace('team_a', { description: 'Team A' });
        const active = m.setActive('team_a');
        let invalidName = '';
        let defaultDelete = '';
        try { m.createWorkspace('../bad'); } catch (e) { invalidName = e.message; }
        try { m.deleteWorkspace('default'); } catch (e) { defaultDelete = e.message; }
        const deleted = m.deleteWorkspace('team_a');
        console.log(JSON.stringify({
          home: homedir(),
          created,
          active,
          afterDeleteActive: m.getActive(),
          deleted,
          workspaceDirExists: existsSync(join(homedir(), '.noe-panel', 'workspaces', 'team_a')),
          invalidName,
          defaultDelete,
          dbPath: m.getDbPath(),
        }));
      `;
      const raw = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(),
        env: { ...process.env, HOME: home },
        encoding: 'utf8',
      });
      const out = JSON.parse(raw);

      expect(out.home).toBe(home);
      expect(out.created).toMatchObject({ name: 'team_a', description: 'Team A' });
      expect(out.active).toBe('team_a');
      expect(out.afterDeleteActive).toBe('default');
      expect(out.deleted).toEqual({ deleted: 'team_a' });
      expect(out.workspaceDirExists).toBe(false);
      expect(out.invalidName).toContain('workspace 名只允许');
      expect(out.defaultDelete).toContain("'default' 不能删除");
      expect(out.dbPath).toBe(join(home, '.noe-panel', 'panel.db'));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
