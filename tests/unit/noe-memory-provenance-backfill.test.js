import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendEvent, close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import {
  applyNoeMemoryProvenanceBackfill,
  planNoeMemoryProvenanceBackfill,
} from '../../src/memory/NoeMemoryProvenanceBackfill.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-backfill-test-'));
  initSqlite(join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

describe('NoeMemoryProvenanceBackfill', () => {
  it('plans only real episode matches and applies them only when requested', () => {
    const memory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
    memory.write({ id: 'orphan', projectId: 'noe', scope: 'fact', body: '主人喜欢黑咖啡并且不加糖。', sourceType: 'fact_extract' });
    const episodeId = appendEvent({
      kind: 'noe_episode',
      projectId: 'noe',
      summary: '主人喜欢黑咖啡并且不加糖。',
      detail: 'unit provenance fixture',
    });

    const dry = planNoeMemoryProvenanceBackfill({ db: getDb(), projectId: 'noe', minScore: 0.1 });
    expect(dry.matchCount).toBe(1);
    expect(dry.matches[0]).toMatchObject({ memoryId: 'orphan', sourceEpisodeId: `events:${episodeId}` });
    expect(memory.get('orphan', { includeHidden: true }).sourceEpisodeId).toBeNull();

    const applied = applyNoeMemoryProvenanceBackfill({ db: getDb(), projectId: 'noe', minScore: 0.1, apply: true });
    expect(applied.applied).toBe(true);
    expect(applied.updated).toBe(1);
    expect(memory.get('orphan', { includeHidden: true }).sourceEpisodeId).toBe(`events:${episodeId}`);
    expect(JSON.stringify(applied)).not.toContain('主人喜欢黑咖啡');
  });

  // 因果方向过滤（B1.6②）：情景若发生在记忆创建之后（超过小容差），它不可能是这条记忆的来源，
  // 不该靠 abs(time) 的时间邻近 boost 把"晚于记忆"的情景误配为来源。
  // 边界用例：lexical=0.72，+0.05 boost=0.77；minScore=0.73 卡在中间——只有错误地加了 boost 才会匹配。
  const DAY = 86_400_000;
  const MEM_BODY = '主人喜欢黑咖啡不加糖很安静';
  const EPI_BODY = '主人喜欢黑咖啡不加糖配点心';

  it('未来情景（晚于记忆创建）不获得时间 boost，不被误配为来源', () => {
    const memory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
    const created = memory.write({ id: 'orphan-future', projectId: 'noe', scope: 'fact', body: MEM_BODY, sourceType: 'fact_extract' });
    const memCreatedAt = Number(memory.get('orphan-future', { includeHidden: true }).createdAt) || Date.now();
    // 情景发生在记忆创建之后 2 天（abs 窗口内，但因果上不可能是来源）
    appendEvent({ kind: 'noe_episode', projectId: 'noe', summary: EPI_BODY, detail: '', ts: memCreatedAt + 2 * DAY });

    const dry = planNoeMemoryProvenanceBackfill({ db: getDb(), projectId: 'noe', minScore: 0.73 });
    // 修复前：abs 窗口内 → +0.05 boost → 0.77 ≥ 0.73 → 误配；修复后：方向过滤 → 无 boost → 0.72 < 0.73 → 不匹配
    expect(dry.matchCount).toBe(0);
    expect(created.id).toBe('orphan-future'); // sanity：写入成功
  });

  it('过去情景（早于记忆创建、在容差窗口内）仍获得时间 boost、正常匹配为来源', () => {
    const memory = new MemoryCore({ logger: { warn: () => {}, info: () => {} } });
    memory.write({ id: 'orphan-past', projectId: 'noe', scope: 'fact', body: MEM_BODY, sourceType: 'fact_extract' });
    const memCreatedAt = Number(memory.get('orphan-past', { includeHidden: true }).createdAt) || Date.now();
    // 情景发生在记忆创建之前 2 天：合法来源方向，时间邻近 → 应保留 boost
    const pastEpisodeId = appendEvent({ kind: 'noe_episode', projectId: 'noe', summary: EPI_BODY, detail: '', ts: memCreatedAt - 2 * DAY });

    const dry = planNoeMemoryProvenanceBackfill({ db: getDb(), projectId: 'noe', minScore: 0.73 });
    expect(dry.matchCount).toBe(1);
    expect(dry.matches[0]).toMatchObject({ memoryId: 'orphan-past', sourceEpisodeId: `events:${pastEpisodeId}` });
  });
});
