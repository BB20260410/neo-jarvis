import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import {
  buildActionSemanticTraceSnapshot,
  writeActionSemanticTraceSnapshot,
} from '../../scripts/noe-action-semantic-trace-snapshot.mjs';

const T0 = Date.parse('2026-06-13T05:10:00+08:00');

function createDb(dbPath) {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE noe_acts (
      id TEXT,
      action TEXT,
      status TEXT,
      updated_at INTEGER,
      payload TEXT
    );
    CREATE TABLE noe_goal_checkpoints (
      id TEXT,
      ts INTEGER,
      phase TEXT,
      status TEXT,
      kind TEXT,
      action TEXT,
      payload TEXT
    );
    CREATE TABLE noe_ticks (
      id INTEGER,
      kind TEXT,
      status TEXT,
      finished_at INTEGER,
      outcome TEXT
    );
  `);
  return db;
}

describe('noe-action-semantic-trace-snapshot', () => {
  it('counts semanticTrace coverage without exporting semantic values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-action-semantic-trace-'));
    const dbPath = join(dir, 'panel.db');
    const outDir = join(dir, 'out');
    const db = createDb(dbPath);
    try {
      db.prepare('INSERT INTO noe_acts VALUES (?, ?, ?, ?, ?)').run(
        'act-1',
        'noe.focus.review',
        'completed',
        T0 - 1000,
        JSON.stringify({
          actionEvidence: {
            semanticTrace: {
              summary: ['owner expects confirmed delivery sample'],
              goal: ['produce visible delivery'],
              expectation: ['owner expects confirmed delivery sample'],
              checkpoint: ['write readiness audit'],
              fingerprint: 'a'.repeat(24),
            },
          },
        }),
      );
      db.prepare('INSERT INTO noe_goal_checkpoints VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'cp-1',
        T0 - 900,
        'evidence',
        'done',
        'act',
        'noe.focus.review',
        JSON.stringify({
          actionEvidenceSummary: {
            semanticTrace: {
              action: ['noe.focus.review'],
              checkpoint: ['write readiness audit'],
              fingerprint: 'b'.repeat(24),
            },
          },
        }),
      );
      db.prepare('INSERT INTO noe_ticks VALUES (?, ?, ?, ?, ?)').run(
        10,
        'expectation',
        'done',
        T0,
        JSON.stringify({
          previousResult: {
            checked: 1,
            resolved: 0,
            judged: [{
              id: 1,
              reason: 'llm_unknown',
              evidenceClaimAlignment: {
                semanticLinkedActionEvents: 2,
                semanticActionMaxCoverage: 0.25,
                semanticTraceActionEvents: 1,
                semanticTraceLinkedActionEvents: 1,
                semanticTraceMaxCoverage: 0.2,
              },
            }],
          },
        }),
      );

      const report = buildActionSemanticTraceSnapshot(db, {
        now: T0,
        sinceMs: T0 - 60_000,
        dbPath,
      });
      const paths = writeActionSemanticTraceSnapshot(report, { outDir, now: T0 });
      const body = readFileSync(join(outDir, 'latest.json'), 'utf8');

      expect(report.status.actionSemanticTraceReady).toBe(true);
      expect(report.status.checkpointSemanticTraceReady).toBe(true);
      expect(report.actionCoverage.withSemanticTrace).toBe(1);
      expect(report.actionCoverage.withExpectation).toBe(1);
      expect(report.checkpointCoverage.withSemanticTrace).toBe(1);
      expect(report.expectationTicks.judgedWithAlignment).toBe(1);
      expect(report.expectationTicks.judgedWithTraceAlignment).toBe(1);
      expect(report.expectationTicks.semanticLinkedActionEvents).toBe(2);
      expect(report.expectationTicks.semanticTraceActionEvents).toBe(1);
      expect(report.expectationTicks.semanticTraceLinkedActionEvents).toBe(1);
      expect(report.expectationTicks.semanticTraceMaxCoverage).toBe(0.2);
      expect(paths.latestPath).toBe(join(outDir, 'latest.json'));
      expect(body).not.toContain('owner expects confirmed delivery sample');
      expect(body).not.toContain('write readiness audit');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
