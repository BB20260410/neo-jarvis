// @ts-check
/**
 * C01 canary unit harness — drives shipped AgentRuntime + UnifiedTaskSqlite.
 * Asserts: report on disk, same Task ID, restart recovery, zero false completion (3 rounds for unit speed).
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/noe-c01-unified-task-canary.mjs');

describe('C01 unified task canary (shipped entrypoint)', () => {
  it('runs real canary script: report disk + same id + restart + zero false complete', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'c01-unit-'));
    const outPath = join(workDir, 'summary.json');
    try {
      const r = spawnSync(
        process.execPath,
        [script, '--out', outPath, '--rounds', '3', '--work-dir', workDir, '--keep'],
        { encoding: 'utf8', cwd: root, timeout: 60_000 },
      );
      expect(r.status, r.stderr || r.stdout).toBe(0);
      expect(existsSync(outPath)).toBe(true);
      const summary = JSON.parse(readFileSync(outPath, 'utf8'));
      expect(summary.ok).toBe(true);
      expect(summary.zeroFalseCompletion).toBe(true);
      expect(summary.allSameTaskId).toBe(true);
      expect(summary.allReportsOnDisk).toBe(true);
      expect(summary.restartRecoveryOk).toBe(true);
      expect(summary.falseCompleteCount).toBe(0);
      expect(summary.architecture.producerMayWriteTaskFinalState).toBe(false);
      expect(summary.architecture.agentRuntimeSideEffects.shell).toBe(false);
      // drive real report files
      for (const row of summary.results) {
        expect(existsSync(row.reportPath)).toBe(true);
        const body = readFileSync(row.reportPath, 'utf8');
        expect(body).toContain(row.taskId);
      }
    } finally {
      try { rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
