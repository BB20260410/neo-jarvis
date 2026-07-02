import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { buildNoeMemoryStatus } from '../../src/memory/NoeMemoryStatus.js';
import {
  runNoeMemoryAutonomousReview,
  writeAutonomousReviewMarkdown,
} from '../../src/memory/NoeMemoryAutonomousReview.js';

let dir = null;

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-autonomous-review-test-'));
  initSqlite(join(dir, 'panel.db'));
  return new MemoryCore({ logger: { warn: () => {} } });
}

afterEach(() => {
  close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('NoeMemoryAutonomousReview', () => {
  it('reviews orphan facts without promoting weak provenance to strong source evidence', () => {
    const memory = setup();
    memory.write({ id: 'safe-orphan', projectId: 'noe', scope: 'fact', body: '用户偏好用系统语音汇报任务失败。', sourceType: 'fact_extract', confidence: 0.9, salience: 3 });
    memory.write({ id: 'secret-orphan', projectId: 'noe', scope: 'fact', body: 'api_key=unitsecret000000000000000000', sourceType: 'fact_extract', confidence: 0.9, salience: 3 });
    memory.write({ id: 'ephemeral-orphan', projectId: 'noe', scope: 'fact', body: '刚刚用户点击了当前页面的刷新按钮。', sourceType: 'fact_extract', confidence: 0.9, salience: 3 });
    memory.write({ id: 'strong-fact', projectId: 'noe', scope: 'fact', body: '主人确认的强来源事实。', sourceType: 'fact_extract', sourceEpisodeId: 'ep-strong', confidence: 0.9, salience: 3 });

    const dry = runNoeMemoryAutonomousReview({ db: getDb(), apply: false, now: () => 1000 });
    expect(dry.summary).toMatchObject({
      auto_accepted_weak: 1,
      auto_quarantined_sensitive: 1,
      auto_rejected_ephemeral: 1,
    });
    expect(getDb().prepare('SELECT COUNT(*) AS c FROM noe_memory_candidate').get().c).toBe(0);

    const applied = runNoeMemoryAutonomousReview({ db: getDb(), apply: true, now: () => 1000 });
    expect(applied).toMatchObject({ reviewed: 3, candidatesRecorded: 3, hidden: 2 });
    const candidateRows = getDb().prepare('SELECT decision, target_memory_id FROM noe_memory_candidate ORDER BY target_memory_id').all();
    expect(candidateRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ decision: 'auto_accepted_weak', target_memory_id: 'safe-orphan' }),
      expect.objectContaining({ decision: 'auto_quarantined_sensitive', target_memory_id: 'secret-orphan' }),
      expect.objectContaining({ decision: 'auto_rejected_ephemeral', target_memory_id: 'ephemeral-orphan' }),
    ]));
    expect(memory.get('safe-orphan')).toBeTruthy();
    expect(memory.get('secret-orphan')).toBeNull();
    expect(memory.get('ephemeral-orphan')).toBeNull();

    const status = buildNoeMemoryStatus({ db: getDb(), now: () => 2000 });
    expect(status.sourceLinked).toMatchObject({
      factTotal: 2,
      linkedFacts: 1,
      orphanFacts: 1,
      reviewedOrphanFacts: 1,
      unreviewedOrphanFacts: 0,
    });
  });

  it('writes a redacted markdown mirror', () => {
    const memory = setup();
    memory.write({ id: 'secret-orphan', projectId: 'noe', scope: 'fact', body: 'api_key=unitsecret000000000000000000', sourceType: 'fact_extract', confidence: 0.9, salience: 3 });
    const report = runNoeMemoryAutonomousReview({ db: getDb(), apply: true, now: () => 1000 });
    const mirrorDir = join(dir, 'vault', 'Noe', 'Memory Governance');
    const file = writeAutonomousReviewMarkdown({ report, dir: mirrorDir, filename: 'review.md' });
    expect(existsSync(file)).toBe(true);
    const md = readFileSync(file, 'utf8');
    expect(md).toContain('Noe Memory Autonomous Review');
    expect(md).toContain('auto_quarantined_sensitive');
    expect(md).not.toContain('unitsecret');
  });
});
