// MemoryCore 审计 §3.3 性能/可靠性修复测试
// 覆盖：P0-1 hide/unhide 向量索引同步、P0-2 ftsAvailable 缓存、P0-3 bumpHitMany 批量、P0-8 runGc 窄列
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-audit-perf-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('P0-1 hide/unhide 同步向量索引', () => {
  it('hide 调 semanticIndex.remove(id)', () => {
    const semanticIndex = { remove: vi.fn(), upsert: vi.fn() };
    const core = new MemoryCore({ semanticIndex });
    core.write({ id: 'm1', body: '一条会被隐藏的记忆' });
    semanticIndex.upsert.mockClear(); // 忽略 write 时的 upsert
    const ok = core.hide('m1');
    expect(ok).toBe(true);
    expect(semanticIndex.remove).toHaveBeenCalledWith('m1');
  });

  it('unhide 调 semanticIndex.upsert 重建（含 title+body 文本）', () => {
    const semanticIndex = { remove: vi.fn(), upsert: vi.fn() };
    const core = new MemoryCore({ semanticIndex });
    core.write({ id: 'm2', title: '标题', body: '正文内容' });
    core.hide('m2');
    semanticIndex.upsert.mockClear();
    const ok = core.unhide('m2');
    expect(ok).toBe(true);
    expect(semanticIndex.upsert).toHaveBeenCalledTimes(1);
    const arg = semanticIndex.upsert.mock.calls[0][0];
    expect(arg.refId).toBe('m2');
    expect(arg.text).toContain('正文内容');
  });

  it('runGc apply 隐藏候选时也清向量（经 hide 落地）', () => {
    const semanticIndex = { remove: vi.fn(), upsert: vi.fn() };
    const core = new MemoryCore({ semanticIndex });
    core.write({ id: 'exp', body: '过期记忆', expiresAt: Date.now() - 100000 });
    semanticIndex.remove.mockClear();
    core.runGc({ apply: true });
    expect(semanticIndex.remove).toHaveBeenCalledWith('exp');
  });

  it('未注入 semanticIndex 时 hide/unhide 不报错', () => {
    const core = new MemoryCore();
    core.write({ id: 'm3', body: '无向量索引' });
    expect(() => core.hide('m3')).not.toThrow();
    expect(() => core.unhide('m3')).not.toThrow();
  });
});

describe('P0-2 ftsAvailable 缓存', () => {
  it('二次调用命中缓存，不重复跑 sqlite 探测查询', () => {
    const core = new MemoryCore();
    const db = core.db();
    expect(core.ftsAvailable()).toBe(true); // 预热
    const spy = vi.spyOn(db, 'prepare');
    core.ftsAvailable();
    core.ftsAvailable();
    expect(spy).not.toHaveBeenCalled(); // 缓存命中，零 prepare
    spy.mockRestore();
  });

  it('切库后（db 实例变化）重新探测', () => {
    const core = new MemoryCore();
    expect(core.ftsAvailable()).toBe(true);
    // 换一个新库（新 db 实例）→ 缓存应失效
    close();
    const tmp2 = mkdtempSync(join(tmpdir(), 'noe-audit-perf2-'));
    initSqlite(join(tmp2, 'panel.db'));
    expect(core.ftsAvailable()).toBe(true); // 新库也有 FTS，重新探测得 true
    close();
    rmSync(tmp2, { recursive: true, force: true });
    // 复原主库供 afterEach close
    initSqlite(join(tmp, 'panel.db'));
  });
});

describe('P0-3 bumpHitMany 批量记命中', () => {
  it('单次更新多条 hit_count，hidden 的不计', () => {
    const core = new MemoryCore();
    core.write({ id: 'a', body: 'A' });
    core.write({ id: 'b', body: 'B' });
    core.write({ id: 'c', body: 'C' });
    core.hide('c');
    const changed = core.bumpHitMany(['a', 'b', 'c']);
    expect(changed).toBe(2); // c 已 hidden 不更新
    expect(core.get('a').hitCount).toBe(1);
    expect(core.get('b').hitCount).toBe(1);
    expect(core.get('c', { includeHidden: true }).hitCount).toBe(0);
  });

  it('空/重复 id 安全', () => {
    const core = new MemoryCore();
    core.write({ id: 'x', body: 'X' });
    expect(core.bumpHitMany([])).toBe(0);
    expect(core.bumpHitMany(['x', 'x', '', null])).toBe(1); // 去重后只 x 一条
    expect(core.get('x').hitCount).toBe(1);
  });

  it('recall 默认 bumpHits 仍正确累加命中', () => {
    const core = new MemoryCore();
    core.write({ id: 'r1', body: '可召回内容关键词' });
    core.recall({ q: '关键词' });
    expect(core.get('r1').hitCount).toBe(1);
    core.recall({ q: '关键词', bumpHits: false });
    expect(core.get('r1').hitCount).toBe(1); // bumpHits:false 不增
  });
});

describe('P0-8 runGc 窄列 SELECT 行为等价', () => {
  it('大 body 记忆过期仍被正确分类为 GC 候选（窄列没丢 expires_at）', () => {
    const core = new MemoryCore();
    const huge = 'x'.repeat(50000);
    core.write({ id: 'big-exp', body: huge, expiresAt: Date.now() - 100000 });
    core.write({ id: 'big-ok', body: huge, salience: 3 });
    const r = core.runGc();
    expect(r.plan.gcCandidates).toContain('big-exp');
    expect(r.plan.gcCandidates).not.toContain('big-ok');
  });

  it('窄列下 salience5 身份级仍受保护', () => {
    const core = new MemoryCore();
    core.write({ id: 'vip', body: '身份级', salience: 5, expiresAt: Date.now() - 100000 });
    const r = core.runGc({ apply: true });
    expect(r.hidden).not.toContain('vip');
    expect(core.get('vip')).not.toBeNull();
  });
});
