import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-memory-m1-'));
  initSqlite(path.join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('MemoryCore M1 metadata', () => {
  it('stores confidence, ttl, expiry, merge trace, and hide reason', () => {
    const memory = new MemoryCore();
    const keep = memory.write({
      id: 'keep',
      projectId: 'neo',
      body: 'persistent M1 memory',
      confidence: 0.72,
      tags: ['m1'],
    });
    const expired = memory.write({
      id: 'expired',
      projectId: 'neo',
      body: 'expired M1 memory',
      expiresAt: Date.now() - 1000,
    });

    expect(keep.confidence).toBe(0.72);
    expect(expired.expired).toBe(true);
    expect(memory.recall({ projectId: 'neo', q: 'M1' }).map((item) => item.id)).toEqual(['keep']);
    expect(memory.recall({ projectId: 'neo', q: 'M1', includeExpired: true }).map((item) => item.id)).toContain('expired');

    const source = memory.write({ id: 'source', projectId: 'neo', body: 'source memory' });
    const merged = memory.merge({ targetId: 'keep', sourceIds: [source.id], reason: 'dedupe' });
    const hiddenSource = memory.get(source.id, { includeHidden: true });

    expect(merged.mergeTrace.at(-1)).toMatchObject({ reason: 'dedupe', sourceIds: ['source'] });
    expect(hiddenSource.hidden).toBe(true);
    expect(hiddenSource.hiddenReason).toBe('merged_into:keep');
  });

  it('rejects cross-scope merges so facts cannot be hidden into voice memories', () => {
    const memory = new MemoryCore();
    memory.write({ id: 'voice-keep', projectId: 'neo', scope: 'voice', body: 'raw voice episode' });
    memory.write({ id: 'fact-source', projectId: 'neo', scope: 'fact', body: 'sourced extracted fact' });

    expect(() => memory.merge({
      targetId: 'voice-keep',
      sourceIds: ['fact-source'],
      projectId: 'neo',
      reason: 'semantic_conflict',
    })).toThrow(/scope mismatch/);
    expect(memory.get('fact-source')?.id).toBe('fact-source');
  });

  it('支持 salience + 梦境整合的 downgrade / unhide(一键恢复)', () => {
    const memory = new MemoryCore();
    const a = memory.write({ id: 'a', projectId: 'neo', body: '身份级记忆', salience: 5 });
    const b = memory.write({ id: 'b', projectId: 'neo', body: '普通记忆' }); // 默认 3
    expect(a.salience).toBe(5);
    expect(b.salience).toBe(3);

    expect(memory.downgrade('b').salience).toBe(2);     // 默认 -1
    expect(memory.setSalience('b', 9).salience).toBe(5); // 夹到 1-5

    memory.hide('b', { reason: 'test' });
    expect(memory.get('b')).toBeNull();                  // 软删后默认读不到
    expect(memory.unhide('b')).toBe(true);
    expect(memory.get('b')?.id).toBe('b');               // 复活

    expect(memory.downgrade('nope')).toBeNull();         // 不存在安全返回
    expect(memory.unhide('nope')).toBe(false);
  });

  it('stores temporal fact metadata and can supersede same-slot facts when policy is enabled', () => {
    const memory = new MemoryCore({ conflictPolicy: { enabled: true } });
    const old = memory.write({
      id: 'coffee-old',
      projectId: 'neo',
      scope: 'fact',
      body: '用户喜欢喝美式咖啡',
      sourceType: 'owner',
      confidence: 0.9,
      validFrom: 1000,
      sourceEpisodeId: 'ep-old',
    });
    expect(old).toMatchObject({ validFrom: 1000, validTo: null, sourceEpisodeId: 'ep-old' });

    const next = memory.write({
      projectId: 'neo',
      scope: 'fact',
      body: '用户现在改喝拿铁',
      sourceType: 'owner',
      confidence: 0.95,
      validFrom: 2000,
      sourceEpisodeId: 'ep-new',
    });
    const hiddenOld = memory.get('coffee-old', { includeHidden: true });

    expect(next.id).not.toBe('coffee-old');
    expect(next).toMatchObject({ body: '用户现在改喝拿铁', validFrom: 2000, sourceEpisodeId: 'ep-new' });
    expect(next.mergeTrace.at(-1)).toMatchObject({ action: 'supersede', reason: 'explicit_update', sourceIds: ['coffee-old'] });
    expect(hiddenOld.hidden).toBe(true);
    expect(hiddenOld.hiddenReason).toBe(`superseded_by:${next.id}`);
    expect(typeof hiddenOld.validTo).toBe('number');
    expect(memory.recall({ projectId: 'neo', scope: 'fact', q: '咖啡', includeHidden: true }).map((item) => item.id)).toContain('coffee-old');
    expect(memory.recall({ projectId: 'neo', scope: 'fact', q: '咖啡' }).map((item) => item.id)).not.toContain('coffee-old');
  });
});
