import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

// recall eval：用一组固定记忆 + 多组查询，评估召回质量
// （内容相关性 / project 隔离 / 过期处理 / 短查询 / hidden 排除）。
// 对应 NEXT_PLAN P1-01 验收口径里的「recall eval」。

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-recall-eval-'));
  initSqlite(path.join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

function seed(memory) {
  memory.write({ id: 'auth', projectId: 'noe', body: 'authentication login flow uses owner token', tags: ['security'] });
  memory.write({ id: 'sqlite', projectId: 'noe', body: 'sqlite storage with better-sqlite3 and FTS5', tags: ['storage'] });
  memory.write({ id: 'cluster', projectId: 'noe', body: 'cross_verify cluster collaboration claude codex gemini', tags: ['cluster'] });
  memory.write({ id: 'other', projectId: 'alpha', body: 'unrelated project memory about authentication', tags: ['security'] });
  memory.write({ id: 'stale', projectId: 'noe', body: 'stale authentication note', expiresAt: Date.now() - 1000 });
}

describe('MemoryCore recall eval', () => {
  it('returns relevant memories for a content query, scoped + non-expired', () => {
    const memory = new MemoryCore();
    seed(memory);
    const ids = memory.recall({ projectId: 'noe', q: 'authentication' }).map((m) => m.id);
    expect(ids).toContain('auth');      // 内容相关
    expect(ids).not.toContain('other'); // 跨 project 隔离
    expect(ids).not.toContain('stale'); // 过期默认排除
  });

  it('isolates recall by project', () => {
    const memory = new MemoryCore();
    seed(memory);
    const alpha = memory.recall({ projectId: 'alpha', q: 'authentication' }).map((m) => m.id);
    expect(alpha).toEqual(['other']);
  });

  it('includes expired memories only when asked', () => {
    const memory = new MemoryCore();
    seed(memory);
    const ids = memory.recall({ projectId: 'noe', q: 'authentication', includeExpired: true }).map((m) => m.id);
    expect(ids).toContain('stale');
  });

  it('recalls short (<3 char) queries via LIKE fallback', () => {
    const memory = new MemoryCore();
    memory.write({ id: 'm1tag', projectId: 'noe', body: 'M1 metadata pipeline' });
    const ids = memory.recall({ projectId: 'noe', q: 'M1' }).map((m) => m.id);
    expect(ids).toContain('m1tag');
  });

  it('excludes hidden memories by default', () => {
    const memory = new MemoryCore();
    seed(memory);
    memory.hide('auth', { projectId: 'noe' });
    const ids = memory.recall({ projectId: 'noe', q: 'authentication' }).map((m) => m.id);
    expect(ids).not.toContain('auth');
  });

  it('surfaces M1 metadata (confidence/source/expired) on recalled items', () => {
    const memory = new MemoryCore();
    memory.write({ id: 'c1', projectId: 'noe', body: 'confidence carrying memory entry', confidence: 0.66, sourceType: 'unit' });
    const [item] = memory.recall({ projectId: 'noe', q: 'confidence' });
    expect(item.confidence).toBe(0.66);
    expect(item.sourceType).toBe('unit');
    expect(item.expired).toBe(false);
  });
});
