import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ingestWiki, lintWiki, searchWiki, LLMWikiInternals } from '../../src/knowledge/LLMWiki.js';

const execFileP = promisify(execFile);

async function tmpWiki() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'noe-llm-wiki-'));
  await fs.mkdir(path.join(root, 'raw'), { recursive: true });
  await fs.mkdir(path.join(root, 'wiki'), { recursive: true });
  await fs.writeFile(path.join(root, 'wiki/log.md'), '# Log\n');
  return root;
}

describe('LLMWiki deterministic ingest/lint', () => {
  it('compiles raw research notes into concept pages, index, and append-only log', async () => {
    const root = await tmpWiki();
    await fs.writeFile(path.join(root, 'raw/karpathy.md'), [
      '---',
      'concept: karpathy-method',
      'title: Karpathy LLM Wiki Pattern',
      'tags: [method, local-first]',
      'decision: replicate',
      'priority: P0',
      '---',
      '# Karpathy LLM Wiki Pattern',
      '',
      '## Summary',
      'Compile raw notes into persistent wiki pages.',
      '',
      '## Why It Helps Noe',
      '- Reduces repeated research.',
      '',
      '## Replication',
      '- Keep raw append-only.',
      '',
      '## Sources',
      '- [Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)',
    ].join('\n'));

    const out = await ingestWiki({ root, date: '2026-06-05' });
    expect(out).toMatchObject({ ok: true, rawCount: 1, pageCount: 1 });

    const page = await fs.readFile(path.join(root, 'wiki/karpathy-method.md'), 'utf8');
    expect(page).toContain('# Karpathy LLM Wiki Pattern');
    expect(page).toContain('[raw:raw/karpathy.md](../raw/karpathy.md)');
    expect(page).toContain('Karpathy gist');

    const index = await fs.readFile(path.join(root, 'wiki/index.md'), 'utf8');
    expect(index).toContain('[Karpathy LLM Wiki Pattern](./karpathy-method.md)');
    const log = await fs.readFile(path.join(root, 'wiki/log.md'), 'utf8');
    expect(log).toContain('ingested 1 raw notes into 1 wiki pages');

    await expect(lintWiki({ root })).resolves.toMatchObject({ ok: true, checked: 1, issues: [] });

    const search = await searchWiki({ root, query: 'repeated research', topK: 2 });
    expect(search.hits[0]).toMatchObject({ title: 'Karpathy LLM Wiki Pattern', file: 'wiki/karpathy-method.md' });
    expect(search.hits[0].snippet).toContain('Reduces repeated research');
  });

  it('reports broken local wiki links', async () => {
    const root = await tmpWiki();
    await fs.writeFile(path.join(root, 'wiki/index.md'), '# Index\n- [A](./a.md)\n');
    await fs.writeFile(path.join(root, 'wiki/a.md'), [
      '# A',
      '',
      '## Sources',
      '- [raw](../raw/missing.md)',
    ].join('\n'));
    const out = await lintWiki({ root });
    expect(out.ok).toBe(false);
    expect(out.issues.some((i) => i.type === 'broken_link')).toBe(true);
  });

  it('reports raw notes with missing required fields or duplicate bodies', async () => {
    const root = await tmpWiki();
    await fs.writeFile(path.join(root, 'raw/a.md'), [
      '---',
      'concept: dup',
      'title: Dup A',
      'decision: borrow',
      'priority: P2',
      '---',
      '# Dup A',
      '',
      'same durable source body',
    ].join('\n'));
    await fs.writeFile(path.join(root, 'raw/b.md'), [
      '---',
      'concept: dup-b',
      'title: Dup B',
      'decision: borrow',
      '---',
      '# Dup B',
      '',
      'same durable source body',
    ].join('\n'));

    const out = await lintWiki({ root });
    expect(out.ok).toBe(false);
    expect(out.rawChecked).toBe(2);
    expect(out.issues.some((i) => i.type === 'raw_missing_frontmatter' && i.message.includes('priority'))).toBe(true);
    expect(out.issues.some((i) => i.type === 'duplicate_raw_body')).toBe(true);
  });

  it('keeps frontmatter parsing simple and non-executing', () => {
    const parsed = LLMWikiInternals.parseFrontmatter('---\ntags: [a, b]\ntitle: T\n---\nBody');
    expect(parsed.data.tags).toEqual(['a', 'b']);
    expect(parsed.data.title).toBe('T');
    expect(parsed.body).toBe('Body');
    expect(LLMWikiInternals.normalizedRawBody('# T\n\n A\n\n B ')).toBe('A B');
  });

  it('supports a non-mutating CLI check mode for full-current verification', async () => {
    const root = await tmpWiki();
    await fs.writeFile(path.join(root, 'raw/karpathy.md'), [
      '---',
      'concept: karpathy-method',
      'title: Karpathy LLM Wiki Pattern',
      'tags: [method]',
      'decision: replicate',
      'priority: P0',
      '---',
      '# Karpathy LLM Wiki Pattern',
      '',
      '## Summary',
      'Compile raw notes into persistent wiki pages.',
      '',
      '## Sources',
      '- [Karpathy gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)',
    ].join('\n'));

    const before = await fs.readdir(path.join(root, 'wiki'));
    const logBefore = await fs.readFile(path.join(root, 'wiki/log.md'), 'utf8');
    const out = await execFileP(process.execPath, ['scripts/wiki-ingest.mjs', '--check', '--root', root]);
    expect(JSON.parse(out.stdout)).toMatchObject({ ok: true, check: true });
    const after = await fs.readdir(path.join(root, 'wiki'));
    const logAfter = await fs.readFile(path.join(root, 'wiki/log.md'), 'utf8');

    expect(after).toEqual(before);
    expect(logAfter).toBe(logBefore);
  });
});
