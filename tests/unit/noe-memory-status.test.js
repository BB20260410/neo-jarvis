import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../../src/memory/NoeMemoryWriteGate.js';
import { buildNoeMemoryStatus } from '../../src/memory/NoeMemoryStatus.js';

let dir = null;

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-status-test-'));
  initSqlite(join(dir, 'panel.db'));
  const memory = new MemoryCore({ logger: { warn: () => {} } });
  const auditLog = new NoeMemoryAuditLog({ db: () => getDb(), now: () => 3000 });
  const gate = new NoeMemoryWriteGate({ memory, auditLog, now: () => 3000, logger: { warn: () => {} } });
  return { memory, gate };
}

afterEach(() => {
  close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('buildNoeMemoryStatus', () => {
  it('reports counts/source linkage/provider without memory body text', () => {
    const { memory, gate } = setup();
    const accepted = gate.commit({
      kind: 'fact',
      projectId: 'noe',
      body: '主人长期偏好黑咖啡。',
      sourceType: 'fact_extract',
      sourceEpisodeId: 'ep-status',
      evidenceRefs: ['episode:ep-status'],
      confidence: 0.8,
    });
    expect(accepted.ok).toBe(true);
    memory.write({ projectId: 'noe', scope: 'fact', body: '这条是没有来源链接的孤儿事实。', sourceType: 'unit' });
    const status = buildNoeMemoryStatus({ db: getDb(), env: { NOE_MEMORY_EMBED: 'ollama', NOE_MEMORY_EMBED_MODEL: 'embed-test' }, now: () => 5000 });
    expect(status.counts.visible).toBe(2);
    expect(status.counts.byScope.fact).toBe(2);
    expect(status.sourceLinked).toMatchObject({ factTotal: 2, linkedFacts: 1, orphanFacts: 1 });
    expect(status.sourceLinked.anyLinkedFacts).toBe(1);
    expect(status.sourceLinked.weakLinkedFacts).toBe(0);
    expect(status.sourceLinked.reviewedOrphanFacts).toBe(0);
    expect(status.sourceLinked.unreviewedOrphanFacts).toBe(1);
    expect(status.semanticProvider).toMatchObject({ enabled: true, provider: 'ollama', model: 'embed-test' });
    expect(status.memory).toMatchObject({
      visible: 2,
      byScope: { fact: 2 },
      retrievalHitRate: null,
      quarantineCount: 0,
    });
    expect(status).toHaveProperty('lastConsolidation');
    expect(status).toHaveProperty('lastEpisodeSublimation');
    expect(status).toHaveProperty('retrievalHitRate');
    expect(status).toHaveProperty('quarantineCount');
    expect(JSON.stringify(status)).not.toContain('黑咖啡');
    expect(JSON.stringify(status)).not.toContain('孤儿事实');
  });

  it('reports stored semantic index with the default local semantic provider', () => {
    setup();
    getDb().prepare(`
      INSERT INTO embeddings(kind, ref_id, text, vector, dim, model)
      VALUES ('noe_memory', 'mem-1', '', ?, 1, 'qwen3-embedding:0.6b')
    `).run(Buffer.alloc(4));
    const status = buildNoeMemoryStatus({ db: getDb(), env: {}, now: () => 5000 });
    expect(status.semanticProvider).toMatchObject({
      enabled: true,
      status: 'enabled',
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      stored: {
        entries: 1,
        refs: 1,
        models: { 'qwen3-embedding:0.6b': 1 },
      },
    });
  });

  it('does not treat NOE_MEMORY_EMBED=0 as a semantic provider name', () => {
    setup();
    getDb().prepare(`
      INSERT INTO embeddings(kind, ref_id, text, vector, dim, model)
      VALUES ('noe_memory', 'mem-1', '', ?, 1, 'qwen3-embedding:0.6b')
    `).run(Buffer.alloc(4));
    const status = buildNoeMemoryStatus({ db: getDb(), env: { NOE_MEMORY_EMBED: '0' }, now: () => 5000 });

    expect(status.semanticProvider).toMatchObject({
      enabled: false,
      disabledExplicitly: true,
      status: 'stored_index_disabled',
      provider: '',
    });
  });

  it('recognizes the live server maintenance env names and legacy aliases', () => {
    setup();
    const serverNames = buildNoeMemoryStatus({
      db: getDb(),
      env: { NOE_DREAM: '1', NOE_DREAM_EPISODES: '1', NOE_MEMORY_GC: 'dry' },
      now: () => 5000,
    });
    expect(serverNames.maintenance.dream.enabled).toBe(true);
    expect(serverNames.maintenance.episodeSublimation.enabled).toBe(true);
    expect(serverNames.maintenance.memoryGc.enabled).toBe(true);
    expect(serverNames.maintenance.memoryGc.mode).toBe('dry');

    const legacyAliases = buildNoeMemoryStatus({
      db: getDb(),
      env: { NOE_DREAM_CONSOLIDATION: '1', NOE_EPISODE_SUBLIMATION: '1' },
      now: () => 5000,
    });
    expect(legacyAliases.maintenance.dream.enabled).toBe(true);
    expect(legacyAliases.maintenance.episodeSublimation.enabled).toBe(true);
  });

  it('P2 杠杆2：retrieval.recentLessons 列出最近召回的 lesson 类记忆(可追溯)，非 lesson 不列入', () => {
    const { memory } = setup();
    memory.write({ id: 'lesson1', projectId: 'noe', scope: 'insight', sourceType: 'learning_lesson', body: '认知修正：关于咖啡的经验', confidence: 0.72 });
    memory.write({ id: 'fact1', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', body: '咖啡偏好', confidence: 0.9 });
    memory.write({ id: 'lesson-hidden', projectId: 'noe', scope: 'insight', sourceType: 'learning_lesson', body: '已隐藏的认知修正', confidence: 0.72 });
    getDb().prepare("UPDATE noe_memory SET hidden = 1 WHERE id = 'lesson-hidden'").run();
    const auditLog = new NoeMemoryAuditLog({ db: () => getDb(), now: () => 4000 });
    auditLog.recordRetrieval({ turnId: 't1', projectId: 'noe', routeType: 'chat', query: '咖啡', channels: { insight: 2, fact: 1 }, hitIds: ['lesson1', 'fact1', 'lesson-hidden'], selectedIds: ['lesson1', 'fact1', 'lesson-hidden'], droppedReasons: [] });
    const status = buildNoeMemoryStatus({ db: getDb(), env: {}, now: () => 5000 });
    const lessons = status.retrieval.recentLessons || [];
    expect(lessons.some((l) => l.id === 'lesson1' && l.sourceType === 'learning_lesson')).toBe(true);
    expect(lessons.some((l) => l.id === 'fact1')).toBe(false); // fact 非 lesson 类不列入
    expect(lessons.some((l) => l.id === 'lesson-hidden')).toBe(false); // codex 互评回归：已隐藏 lesson 不列入(hidden=0 过滤)
  });
});
