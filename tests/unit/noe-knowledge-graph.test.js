import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { FileIndex } from '../../src/memory/FileIndex.js';
import { NoeKnowledgeGraph } from '../../src/memory/NoeKnowledgeGraph.js';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-kg-'));
  initSqlite(path.join(dir, 'panel.db'));
});

afterEach(() => {
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('NoeKnowledgeGraph', () => {
  it('ingests file index entities and one-hop relations without reading extra files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-kg-files-'));
    fs.writeFileSync(path.join(root, 'NoeLocalCouncil.md'), '# Local Council\nNoeLocalModelCouncil uses Gemini and Ollama for critique.\n');
    const fileIndex = new FileIndex({ allowedRoots: [root] });
    fileIndex.indexPath({ root, projectId: 'noe' });

    const graph = new NoeKnowledgeGraph();
    const ingest = graph.ingestFileIndex({ fileIndex, projectId: 'noe' });
    const stats = graph.stats({ projectId: 'noe' });
    const search = graph.search({ q: 'NoeLocalCouncil', projectId: 'noe' });
    const oneHop = graph.oneHop({ name: 'NoeLocalCouncil.md', projectId: 'noe' });

    expect(ingest.ok).toBe(true);
    expect(stats.entities).toBeGreaterThan(2);
    expect(stats.relations).toBeGreaterThan(1);
    expect(search.count).toBeGreaterThanOrEqual(1);
    expect(oneHop.found).toBe(true);
    expect(oneHop.edges.some((edge) => edge.name === 'noe')).toBe(true);
  });
});
