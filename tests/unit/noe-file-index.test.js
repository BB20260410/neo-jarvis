import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileIndex } from '../../src/memory/FileIndex.js';

describe('FileIndex', () => {
  it('indexes local text files and searches without writing project files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-file-index-'));
    fs.writeFileSync(path.join(root, 'README.md'), '# Neo\nM3 suggestion pipeline evidence\n');
    fs.mkdirSync(path.join(root, 'node_modules'));
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored.md'), 'should not index');

    const index = new FileIndex({ allowedRoots: [root], maxFiles: 20 });
    const stats = index.indexPath({ root, projectId: 'neo' });
    const results = index.search({ q: 'suggestion evidence' });

    expect(stats.readOnly).toBe(true);
    expect(stats.count).toBe(1);
    expect(results).toHaveLength(1);
    expect(results[0].relativePath).toBe('README.md');
    expect(results[0].preview).toContain('M3 suggestion pipeline');
    expect(results[0].typeClass).toBe('doc');
    expect(results[0].valueTier).toBe(3);
  });

  it('rejects roots outside the configured allowed roots by default', () => {
    const allowed = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-file-index-allowed-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-file-index-outside-'));
    const index = new FileIndex({ allowedRoots: [allowed] });

    expect(() => index.indexPath({ root: outside })).toThrow(/outside allowed roots/);
  });

  it('keeps sensitive files searchable by metadata without indexing secret content', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-file-index-sensitive-'));
    fs.writeFileSync(path.join(root, '.env'), 'API_KEY=real-secret-value');
    fs.writeFileSync(path.join(root, 'plan.md'), 'real-secret-value should not be required for this test');

    const index = new FileIndex({ allowedRoots: [root], extensions: ['.env', '.md'] });
    index.indexPath({ root, projectId: 'neo' });

    const stats = index.summarize({ projectId: 'neo' });
    const envResults = index.search({ q: '.env', projectId: 'neo' });
    const secretResults = index.search({ q: 'API_KEY', projectId: 'neo' });

    expect(stats.sensitiveCount).toBe(1);
    expect(envResults[0].relativePath).toBe('.env');
    expect(envResults[0].sensitive).toBe(true);
    expect(envResults[0].preview).toBe('');
    expect(secretResults.some((item) => item.relativePath === '.env')).toBe(false);
  });

  it('generates a read-only organize plan with duplicate and large file hints', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-file-index-organize-'));
    fs.mkdirSync(path.join(root, 'a'));
    fs.mkdirSync(path.join(root, 'b'));
    fs.writeFileSync(path.join(root, 'a', 'clip.txt'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(root, 'b', 'clip.txt'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(root, 'old.backup.txt'), 'archive candidate');

    const index = new FileIndex({ allowedRoots: [root], maxFiles: 20, maxBytesPerFile: 4096 });
    index.indexPath({ root, projectId: 'neo' });
    const plan = index.organizePlan({ projectId: 'neo' });

    expect(plan.readOnly).toBe(true);
    expect(plan.dryRun).toBe(true);
    expect(plan.summary.duplicateGroups).toBe(1);
    expect(plan.duplicates[0].paths).toHaveLength(2);
    expect(plan.largeFiles[0].path).toContain('clip.txt');
  });
});
