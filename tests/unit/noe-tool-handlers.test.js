import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolRegistry } from '../../src/capabilities/ToolRegistry.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { FileIndex } from '../../src/memory/FileIndex.js';
import { NoeKnowledgeGraph } from '../../src/memory/NoeKnowledgeGraph.js';
import { createReadonlyToolHandlers, registerBuiltinReadonlyTools } from '../../src/capabilities/builtinReadonlyTools.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-tool-handlers-'));
  initSqlite(path.join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('builtin readonly tool handlers', () => {
  it('lets ToolRegistry.invoke return real results instead of 501', async () => {
    const memory = new MemoryCore();
    memory.write({ id: 'm1', projectId: 'noe', body: 'alpha beta gamma keyword payload' });

    const fileRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'noe-tool-fi-')));
    const note = `# note\nalpha keyword payload here\n${'x'.repeat(2048)}\n`;
    fs.writeFileSync(path.join(fileRoot, 'note.md'), note);
    fs.mkdirSync(path.join(fileRoot, 'backup'));
    fs.writeFileSync(path.join(fileRoot, 'backup', 'note.md'), note);
    const fileIndex = new FileIndex({ allowedRoots: [fileRoot] });
    fileIndex.indexPath({ root: fileRoot, projectId: 'noe' });
    const knowledgeGraph = new NoeKnowledgeGraph();

    const handlers = createReadonlyToolHandlers({ fileIndex, memory, knowledgeGraph });
    const registry = new ToolRegistry({ handlers });
    const reg = registerBuiltinReadonlyTools(registry, { handlers });
    expect(reg.registered).toContain('noe.fs.search');
    expect(reg.registered).toContain('noe.memory.recall');
    expect(reg.registered).toContain('noe.fs.stats');
    expect(reg.registered).toContain('noe.fs.organize_plan');
    expect(reg.registered).toContain('noe.fs.hybrid_search');
    expect(reg.registered).toContain('noe.kg.ingest_file_index');
    expect(reg.registered).toContain('noe.kg.search');
    expect(reg.registered).toContain('noe.kg.one_hop');
    expect(reg.registered).toContain('noe.kg.stats');

    // 记忆检索：low risk → permission allow → 真实 handler 执行，返回 200
    const recall = await registry.invoke('noe.memory.recall', { args: { q: 'keyword', projectId: 'noe' } });
    expect(recall.ok).toBe(true);
    expect(recall.status).toBe(200);
    expect(recall.result.count).toBeGreaterThanOrEqual(1);

    // 文件检索
    const fsSearch = await registry.invoke('noe.fs.search', { args: { q: 'keyword', projectId: 'noe' } });
    expect(fsSearch.ok).toBe(true);
    expect(fsSearch.status).toBe(200);
    expect(fsSearch.result.count).toBeGreaterThanOrEqual(1);

    const fsStats = await registry.invoke('noe.fs.stats', { args: { projectId: 'noe' } });
    expect(fsStats.ok).toBe(true);
    expect(fsStats.result.byType.some((item) => item.typeClass === 'doc')).toBe(true);

    const organizePlan = await registry.invoke('noe.fs.organize_plan', { args: { projectId: 'noe' } });
    expect(organizePlan.ok).toBe(true);
    expect(organizePlan.result.readOnly).toBe(true);
    expect(organizePlan.result.dryRun).toBe(true);
    expect(organizePlan.result.summary.duplicateGroups).toBe(1);

    const hybridSearch = await registry.invoke('noe.fs.hybrid_search', { args: { q: 'note keyword', projectId: 'noe' } });
    expect(hybridSearch.ok).toBe(true);
    expect(hybridSearch.result.count).toBeGreaterThanOrEqual(1);
    expect(hybridSearch.result.results[0].why).toBeTruthy();

    const kgIngest = await registry.invoke('noe.kg.ingest_file_index', { args: { projectId: 'noe' } });
    expect(kgIngest.ok).toBe(true);
    expect(kgIngest.result.files).toBeGreaterThanOrEqual(2);

    const kgSearch = await registry.invoke('noe.kg.search', { args: { q: 'note.md', projectId: 'noe' } });
    expect(kgSearch.ok).toBe(true);
    expect(kgSearch.result.count).toBeGreaterThanOrEqual(1);

    const kgHop = await registry.invoke('noe.kg.one_hop', { args: { name: 'note.md', projectId: 'noe' } });
    expect(kgHop.ok).toBe(true);
    expect(kgHop.result.found).toBe(true);

    const kgStats = await registry.invoke('noe.kg.stats', { args: { projectId: 'noe' } });
    expect(kgStats.ok).toBe(true);
    expect(kgStats.result.relations).toBeGreaterThan(0);
  });

  it('still returns 501 for an enabled tool that has no handler (gap is real)', async () => {
    const registry = new ToolRegistry({ handlers: {} });
    registry.register({ id: 'noe.nope', name: 'x', risk_level: 'low' });
    registry.setEnabled('noe.nope', true);
    const r = await registry.invoke('noe.nope', { args: {} });
    expect(r.status).toBe(501);
  });
});
