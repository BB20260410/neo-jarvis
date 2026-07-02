import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../src/memory/NoeMemoryAuditLog.js';
import { buildNoeMemoryUtilityLiteReport } from '../../src/memory/NoeMemoryUtilityLite.js';
import { main as runMemoryUtilityCli } from '../../scripts/noe-memory-utility-lite.mjs';

const REPO_ROOT = process.cwd();
const NOW = 1781835000000;

let tempDir = null;

function setup() {
  tempDir = mkdtempSync(join(tmpdir(), 'noe-memory-utility-lite-'));
  const dbPath = join(tempDir, 'panel.db');
  initSqlite(dbPath);
  const memory = new MemoryCore({ logger: { warn: () => {} } });
  const auditLog = new NoeMemoryAuditLog({ db: () => getDb(), now: () => NOW });
  return { dbPath, db: getDb(), memory, auditLog };
}

function writeMemory(memory, input) {
  const row = memory.write({
    projectId: 'noe',
    scope: 'fact',
    sourceType: 'unit',
    confidence: 0.8,
    salience: 3,
    ...input,
  });
  return row.id;
}

afterEach(() => {
  close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

describe('NoeMemoryUtilityLite', () => {
  it('builds read-only utility candidates without memory bodies or writes', () => {
    const { db, memory, auditLog } = setup();
    const promote = writeMemory(memory, { id: 'mem-promote', body: '主人喜欢只用冷启动证据判断功能是否活着。' });
    const demote = writeMemory(memory, { id: 'mem-demote', body: '这条会反复命中但不会被选择。' });
    const hidden = writeMemory(memory, { id: 'mem-hidden', body: '隐藏记忆不应该被直接强化。' });
    const expired = writeMemory(memory, { id: 'mem-expired', body: '过期记忆不应该被直接强化。' });
    const cold = writeMemory(memory, { id: 'mem-cold', body: '长期零命中的可回收候选。' });
    const protectedHigh = writeMemory(memory, { id: 'mem-protected-high', body: '身份级高显著记忆只能复核不能自动晋升。', salience: 5 });
    db.prepare("UPDATE noe_memory SET hidden=1, hidden_reason='unit_hidden' WHERE id=?").run(hidden);
    db.prepare('UPDATE noe_memory SET expires_at=? WHERE id=?').run(NOW - 1000, expired);
    db.prepare('UPDATE noe_memory SET created_at=?, updated_at=? WHERE id=?').run(NOW - 90 * 24 * 60 * 60 * 1000, NOW - 90 * 24 * 60 * 60 * 1000, cold);

    for (let i = 0; i < 4; i += 1) {
      auditLog.recordRetrieval({
        projectId: 'noe',
        routeType: 'chat',
        query: `probe ${i}`,
        hitIds: [promote, demote],
        selectedIds: [promote],
        droppedReasons: [{ reason: 'over_budget' }],
      });
    }
    auditLog.recordRetrieval({
      projectId: 'noe',
      routeType: 'chat',
      query: 'hidden expired',
      hitIds: [hidden, expired, protectedHigh],
      selectedIds: [hidden, expired, protectedHigh],
      droppedReasons: [],
    });
    for (let i = 0; i < 3; i += 1) {
      auditLog.recordRetrieval({
        projectId: 'noe',
        routeType: 'chat',
        query: `protected ${i}`,
        hitIds: [protectedHigh],
        selectedIds: [protectedHigh],
        droppedReasons: [],
      });
    }

    const report = buildNoeMemoryUtilityLiteReport({ db, now: NOW, maxCandidates: 20 });
    const byId = new Map(report.candidates.items.map((item) => [item.memoryId, item]));

    expect(report.ok).toBe(true);
    expect(report.policy).toMatchObject({
      readOnlyDb: true,
      candidateOnly: true,
      writesMemoryCore: false,
      writesMemoryV2: false,
      changesSalience: false,
      privateHoldoutRead: false,
    });
    expect(byId.get(promote)).toMatchObject({ action: 'promote_candidate', selectedMentions: 4 });
    expect(byId.get(demote)).toMatchObject({ action: 'demote_candidate', inferredDroppedMentions: 4 });
    expect(byId.get(hidden)).toMatchObject({ action: 'gc_review_candidate' });
    expect(byId.get(expired)).toMatchObject({ action: 'gc_review_candidate' });
    expect(byId.get(cold)).toMatchObject({ action: 'gc_review_candidate', source: 'cold_zero_hit_scan' });
    expect(byId.get(protectedHigh)).toMatchObject({
      action: 'needs_review',
      reasons: ['protected_high_salience_strong_signal'],
    });
    expect(report.correctionSignals).toMatchObject({ attribution: 'unavailable_in_lite', action: 'needs_review_only' });
    expect(JSON.stringify(report)).not.toContain('冷启动证据');
    expect(JSON.stringify(report)).not.toContain('反复命中');
    expect(JSON.stringify(report)).not.toContain('隐藏记忆');
    expect(JSON.stringify(report)).not.toContain('过期记忆');
    expect(JSON.stringify(report)).not.toContain('身份级高显著');
  });

  it('CLI writes output under repo output and rejects non-output report dirs', () => {
    const { dbPath, memory, auditLog } = setup();
    const id = writeMemory(memory, { id: 'mem-cli', body: 'CLI 测试正文不应进入报告。' });
    auditLog.recordRetrieval({
      projectId: 'noe',
      routeType: 'chat',
      query: 'cli',
      hitIds: [id],
      selectedIds: [id],
      droppedReasons: [],
    });
    const outRef = `output/noe-memory-utility-lite-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const outDir = join(REPO_ROOT, outRef);
    const prevCwd = process.cwd();
    try {
      process.chdir(REPO_ROOT);
      runMemoryUtilityCli(['--db-path', dbPath, '--out-dir', outRef, '--max-candidates', '10']);
      const latest = join(outDir, 'latest.json');
      expect(existsSync(latest)).toBe(true);
      const report = JSON.parse(readFileSync(latest, 'utf8'));
      expect(report.ok).toBe(true);
      expect(JSON.stringify(report)).not.toContain('CLI 测试正文');
      expect(() => runMemoryUtilityCli(['--db-path', dbPath, '--out-dir', 'docs/noe-memory-utility-lite']))
        .toThrow(/out-dir must stay under output/);
      expect(() => runMemoryUtilityCli(['--db-path', '.env.local', '--out-dir', outRef]))
        .toThrow(/db-path references forbidden sensitive path/);
    } finally {
      process.chdir(prevCwd);
      rmSync(outDir, { recursive: true, force: true });
    }
  });
});
