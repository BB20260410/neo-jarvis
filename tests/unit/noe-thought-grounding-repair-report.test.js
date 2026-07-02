import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

function createEmptyEventsDb(dbPath) {
  const db = new Database(dbPath);
  try {
    db.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        ts INTEGER,
        kind TEXT,
        tag TEXT,
        payload TEXT
      );
    `);
  } finally {
    db.close();
  }
}

describe('noe-thought-grounding-repair report writer', () => {
  it('writes timestamped and latest reports in preview mode against an isolated DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-thought-grounding-'));
    const dbPath = join(dir, 'panel.db');
    const outDir = join(dir, 'out');
    try {
      createEmptyEventsDb(dbPath);
      const stdout = execFileSync(
        process.execPath,
        ['scripts/noe-thought-grounding-repair.mjs'],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            PANEL_DB_PATH: dbPath,
            NOE_THOUGHT_GROUNDING_REPAIR_OUT_DIR: outDir,
          },
        },
      );
      const report = JSON.parse(stdout);

      expect(report.ok).toBe(true);
      expect(report.applied).toBe(false);
      expect(report.scanned).toBe(0);
      expect(report.repaired).toBe(0);
      expect(report.reportPath).toMatch(/thought-grounding-repair-\d+\.json$/);
      expect(report.latestPath).toBe(join(outDir, 'latest.json'));
      expect(existsSync(report.reportPath)).toBe(true);
      expect(existsSync(report.latestPath)).toBe(true);
      expect(JSON.parse(readFileSync(report.latestPath, 'utf8'))).toEqual(JSON.parse(readFileSync(report.reportPath, 'utf8')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
