import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { buildNoeMemoryStatus } from '../../src/memory/NoeMemoryStatus.js';
import {
  applyNoeMemoryGovernanceRepair,
  buildMemoryGovernanceLinksForRow,
} from '../../src/memory/NoeMemoryGovernanceRepair.js';

let dir = null;

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-governance-repair-test-'));
  initSqlite(join(dir, 'panel.db'));
  return new MemoryCore({ logger: { warn: () => {} } });
}

afterEach(() => {
  close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('NoeMemoryGovernanceRepair', () => {
  it('builds strong source links only from explicit source evidence', () => {
    const links = buildMemoryGovernanceLinksForRow({
      id: 'mem-1',
      source_type: 'fact_extract',
      source_id: 'event-1',
      source_episode_id: 'ep-1',
      created_at: Date.UTC(2026, 5, 13),
      merge_trace: JSON.stringify([{ sourceIds: ['mem-old'] }]),
    });
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'source_episode', ref: 'ep-1', strength: 'strong' }),
      expect.objectContaining({ type: 'source_id', ref: 'event-1', strength: 'strong' }),
      expect.objectContaining({ type: 'legacy_source_type', ref: 'fact_extract', strength: 'weak' }),
      expect.objectContaining({ type: 'merged_from_memory', ref: 'mem-old', strength: 'weak' }),
    ]));
  });

  it('backfills weak legacy links without clearing orphan fact budget', () => {
    const memory = setup();
    memory.write({
      id: 'fact-strong',
      projectId: 'noe',
      scope: 'fact',
      body: '主人长期偏好黑咖啡。',
      sourceType: 'fact_extract',
      sourceEpisodeId: 'ep-strong',
    });
    memory.write({
      id: 'fact-legacy',
      projectId: 'noe',
      scope: 'fact',
      body: '历史事实缺少精确来源。',
      sourceType: 'fact_extract',
    });

    const dry = applyNoeMemoryGovernanceRepair({ db: getDb(), apply: false, now: () => 1000 });
    expect(dry).toMatchObject({ applied: false, inserted: 0 });
    expect(dry.insertCount).toBeGreaterThanOrEqual(3);
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM noe_memory_link').get().c).toBe(0);

    const applied = applyNoeMemoryGovernanceRepair({ db: getDb(), apply: true, now: () => 1000 });
    expect(applied.applied).toBe(true);
    expect(applied.inserted).toBeGreaterThanOrEqual(3);
    const again = applyNoeMemoryGovernanceRepair({ db: getDb(), apply: true, now: () => 1000 });
    expect(again).toMatchObject({ applied: true, inserted: 0, insertCount: 0 });
    const status = buildNoeMemoryStatus({ db: getDb(), now: () => 2000 });
    expect(status.sourceLinked).toMatchObject({
      factTotal: 2,
      linkedFacts: 1,
      orphanFacts: 1,
    });
    expect(status.sourceLinked.anyLinkedFacts).toBe(2);
    expect(status.sourceLinked.weakLinkedFacts).toBe(1);
  });
});
