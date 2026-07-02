import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

function createEmptyCheckpointDb(dbPath) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE noe_goal_checkpoints (
        id TEXT PRIMARY KEY,
        goal_id TEXT,
        step_index INTEGER,
        phase TEXT,
        status TEXT,
        kind TEXT,
        action TEXT,
        step TEXT,
        note TEXT,
        evidence_ref TEXT,
        payload TEXT,
        replay_safe INTEGER,
        ts INTEGER,
        created_at TEXT
      );
      CREATE TABLE noe_acts (
        id TEXT PRIMARY KEY,
        status TEXT,
        risk_level TEXT,
        log_ref TEXT,
        payload TEXT
      );
    `);
  } finally {
    db.close();
  }
}

describe('noe-goal-checkpoint-workflow-backfill report writer', () => {
  it('writes timestamped and latest reports in preview mode against an isolated DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-goal-workflow-'));
    const dbPath = join(dir, 'panel.db');
    const outDir = join(dir, 'out');
    try {
      createEmptyCheckpointDb(dbPath);
      const stdout = execFileSync(
        process.execPath,
        ['scripts/noe-goal-checkpoint-workflow-backfill.mjs'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PANEL_DB_PATH: dbPath,
            NOE_GOAL_CHECKPOINT_WORKFLOW_OUT_DIR: outDir,
          },
        },
      );
      const report = JSON.parse(stdout);

      expect(report.ok).toBe(true);
      expect(report.applied).toBe(false);
      expect(report.scanned).toBe(0);
      expect(report.updates).toBe(0);
      expect(report.reportPath).toMatch(/goal-checkpoint-workflow-backfill-\d+\.json$/);
      expect(report.latestPath).toBe(join(outDir, 'latest.json'));
      expect(existsSync(report.reportPath)).toBe(true);
      expect(existsSync(report.latestPath)).toBe(true);
      expect(JSON.parse(readFileSync(report.latestPath, 'utf8'))).toEqual(JSON.parse(readFileSync(report.reportPath, 'utf8')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves semantic trace when compacting action evidence from acts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-goal-workflow-semantic-'));
    const dbPath = join(dir, 'panel.db');
    const outDir = join(dir, 'out');
    try {
      createEmptyCheckpointDb(dbPath);
      const db = new Database(dbPath);
      try {
        db.prepare(`
          INSERT INTO noe_acts(id, status, risk_level, log_ref, payload)
          VALUES (?, ?, ?, ?, ?)
        `).run('act-1', 'completed', 'low', 'sqlite:events/7', JSON.stringify({
          actionEvidence: {
            schemaVersion: 1,
            actionId: 'act-1',
            action: 'noe.note.write',
            riskLevel: 'low',
            dryRunOnly: false,
            evidenceEventId: 7,
            logRef: 'sqlite:events/7',
            sha256: 'a'.repeat(64),
            refs: { rollback: ['output/rollback.md'] },
            semanticTrace: {
              summary: ['owner expects confirmed delivery sample'],
              action: ['noe.note.write'],
              token: 'secret-value',
              fingerprint: 'b'.repeat(24),
            },
          },
        }));
        db.prepare(`
          INSERT INTO noe_goal_checkpoints(id, goal_id, step_index, phase, status, kind, action, step, note, evidence_ref, payload, replay_safe, ts, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          'cp-1',
          'goal-1',
          0,
          'evidence',
          'done',
          'act',
          'noe.note.write',
          'write readiness audit',
          'done',
          'sqlite:events/7',
          JSON.stringify({ actId: 'act-1', ok: true }),
          0,
          1_780_000_000_000,
          '1780000000000',
        );
      } finally {
        db.close();
      }

      const stdout = execFileSync(
        process.execPath,
        ['scripts/noe-goal-checkpoint-workflow-backfill.mjs', '--apply'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PANEL_DB_PATH: dbPath,
            NOE_GOAL_CHECKPOINT_WORKFLOW_OUT_DIR: outDir,
          },
        },
      );
      const report = JSON.parse(stdout);
      expect(report.applied).toBe(true);
      expect(report.updates).toBe(1);

      const after = new Database(dbPath, { readonly: true });
      try {
        const row = after.prepare('SELECT payload FROM noe_goal_checkpoints WHERE id = ?').get('cp-1');
        const payload = JSON.parse(row.payload);
        expect(payload.actionEvidenceSummary.semanticTrace.summary).toEqual(['owner expects confirmed delivery sample']);
        expect(payload.actionEvidenceSummary.semanticTrace.action).toEqual(['noe.note.write']);
        expect(JSON.stringify(payload.actionEvidenceSummary.semanticTrace)).not.toContain('secret-value');
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
