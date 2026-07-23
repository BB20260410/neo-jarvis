// @ts-check
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';

// P4 根因A：merge() 把 source 记忆 hidden 后漏删向量 → 指向 hidden 行的孤儿向量占满召回 top-K、
//   把真 insight 卡挤出召回池（实测 465/1070=43% 孤儿，insight 通道仅 1.9% 可用）。本测试钉死 merge 后向量被清理。
describe('MemoryCore.merge 向量清理（P4 根因A 修复：止血孤儿再生）', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-merge-vec-')); initSqlite(join(dir, 'panel.db')); });
  afterEach(() => { try { close(); } catch { /* ignore */ } rmSync(dir, { recursive: true, force: true }); });

  function spySemantic() {
    const removed = [];
    return { removed, remove: (id) => { removed.push(id); }, upsert: () => {}, add: () => {}, search: () => [] };
  }

  it('merge 后 source 记忆的向量被 semanticIndex.remove 清理（不留孤儿）', () => {
    const si = spySemantic();
    const memory = new MemoryCore({ semanticIndex: si });
    memory.write({ id: 'keep', projectId: 'neo', scope: 'insight', body: '保留的目标记忆' });
    memory.write({ id: 'src1', projectId: 'neo', scope: 'insight', body: '被合并来源1' });
    memory.write({ id: 'src2', projectId: 'neo', scope: 'insight', body: '被合并来源2' });
    si.removed.length = 0; // 清掉 write 期间可能的 remove 噪声，只测 merge 行为
    memory.merge({ targetId: 'keep', sourceIds: ['src1', 'src2'], reason: 'dedupe' });
    expect(si.removed).toContain('src1');
    expect(si.removed).toContain('src2');
  });

  it('merge 只删 source 向量、不误删 target 自己', () => {
    const si = spySemantic();
    const memory = new MemoryCore({ semanticIndex: si });
    memory.write({ id: 'keep', projectId: 'neo', scope: 'insight', body: '目标' });
    memory.write({ id: 'src1', projectId: 'neo', scope: 'insight', body: '来源' });
    si.removed.length = 0;
    memory.merge({ targetId: 'keep', sourceIds: ['src1'], reason: 'dedupe' });
    expect(si.removed).not.toContain('keep');
    expect(si.removed).toContain('src1');
  });

  it('向量清理失败不阻断 merge（fail-open）：source 仍被 hidden 落库', () => {
    const memory = new MemoryCore({ semanticIndex: { remove: () => { throw new Error('vector store down'); }, upsert: () => {}, add: () => {}, search: () => [] } });
    memory.write({ id: 'keep', projectId: 'neo', scope: 'insight', body: '目标' });
    memory.write({ id: 'src1', projectId: 'neo', scope: 'insight', body: '来源' });
    const merged = memory.merge({ targetId: 'keep', sourceIds: ['src1'], reason: 'dedupe' });
    expect(merged).toBeTruthy();
    expect(memory.get('src1', { includeHidden: true }).hidden).toBe(true);
    expect(memory.get('src1', { includeHidden: true }).hiddenReason).toBe('merged_into:keep');
  });
});
