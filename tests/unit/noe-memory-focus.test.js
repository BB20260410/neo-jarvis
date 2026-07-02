import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { FocusStack } from '../../src/memory/FocusStack.js';

let tmp;
let memory;
let focus;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-core-'));
  initSqlite(join(tmp, 'panel.db'));
  memory = new MemoryCore({ logger: null });
  focus = new FocusStack({ memory });
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('MemoryCore', () => {
  it('writes, recalls, isolates by project, and soft hides memories', () => {
    const a = memory.write({
      projectId: 'noe',
      title: 'BaiLongma loop audit',
      body: 'Noe absorbs TICK loop ideas without copying BaiLongma wholesale.',
      tags: ['audit', 'loop'],
    });
    memory.write({
      projectId: 'other',
      title: 'Other project',
      body: 'BaiLongma should not leak into this project.',
    });

    const recalled = memory.recall({ projectId: 'noe', q: 'TICK loop', limit: 5, bumpHits: false });
    expect(recalled.map((item) => item.id)).toEqual([a.id]);
    expect(memory.stats({ projectId: 'noe' })).toMatchObject({ total: 1, visible: 1 });

    expect(memory.hide(a.id, { projectId: 'noe' })).toBe(true);
    expect(memory.recall({ projectId: 'noe', q: 'TICK loop', bumpHits: false })).toHaveLength(0);
    expect(memory.get(a.id)).toBe(null);
    expect(memory.get(a.id, { includeHidden: true })).toMatchObject({ hidden: true });
  });

  it('falls back to LIKE recall when FTS is disabled by caller', () => {
    memory.write({ projectId: 'noe', title: 'Memory Core', body: 'Focus stack and memory recall are project local.' });
    const recalled = memory.recall({ projectId: 'noe', q: 'project local', useFts: false, bumpHits: false });
    expect(recalled).toHaveLength(1);
    expect(recalled[0].title).toBe('Memory Core');
  });

  it('rejects empty memory bodies and keeps hide scoped to the requested project', () => {
    expect(() => memory.write({ projectId: 'noe', title: 'Empty', body: '   ' })).toThrow('memory body required');

    const item = memory.write({
      id: 'mem-boundary',
      projectId: 'noe',
      title: 'Scoped Memory',
      body: 'This memory belongs to Noe only.',
    });

    expect(memory.hide(item.id, { projectId: 'other' })).toBe(false);
    expect(memory.get(item.id)).toMatchObject({ hidden: false, projectId: 'noe' });

    expect(memory.hide(item.id, { projectId: 'noe' })).toBe(true);
    expect(memory.get(item.id)).toBe(null);

    const revived = memory.write({
      id: item.id,
      projectId: 'noe',
      title: 'Scoped Memory Revived',
      body: 'Upserting the same id should make the memory visible again.',
    });
    expect(revived).toMatchObject({ id: item.id, hidden: false, title: 'Scoped Memory Revived' });
  });

  it('redacts secret-shaped values before persisting long-term memories', () => {
    const item = memory.write({
      projectId: 'tp-projectsecretabcdef123456',
      scope: 'OPENAI_API_KEY=sk-scopesecret000000000000',
      title: 'OPENAI_API_KEY=sk-testmemorysecret000000000',
      body: [
        'Authorization: Bearer fakeBearerToken12345',
        'X-Panel-Owner-Token: abcdefabcdefabcdefabcdef',
        'url=https://local.test/path?t=abcdefabcdefabcdefabcdef',
      ].join('\n'),
      sourceType: 'Authorization: Bearer sourceTypeBearer12345',
      sourceId: 'tp-abcdef1234567890abcdef',
      sourceEpisodeId: 'tp-episodeabcdef1234567890',
      tags: ['tp-abcdef1234567890abcdef', 'safe-tag'],
      mergeTrace: [{ note: 'OPENAI_API_KEY=sk-tracesecret000000000000' }],
    });

    expect(item.projectId).toBe('[redacted-api-key]');
    expect(item.scope).toContain('OPENAI_API_KEY=[redacted]');
    expect(item.title).toContain('OPENAI_API_KEY=[redacted]');
    expect(item.title).not.toContain('sk-testmemorysecret000000000');
    expect(item.body).toContain('Authorization: Bearer [redacted]');
    expect(item.body).toContain('X-Panel-Owner-Token: [redacted]');
    expect(item.body).toContain('?t=[redacted]');
    expect(item.body).not.toContain('fakeBearerToken12345');
    expect(item.sourceType).toContain('Authorization: Bearer [redacted]');
    expect(item.sourceId).toBe('[redacted-api-key]');
    expect(item.sourceEpisodeId).toBe('[redacted-api-key]');
    expect(item.tags).toEqual(['[redacted-api-key]', 'safe-tag']);
    expect(item.mergeTrace[0]).toMatchObject({ note: 'OPENAI_API_KEY=[redacted]' });
  });

  it('clamps recall limits and preserves normalized tag arrays', () => {
    for (let i = 0; i < 3; i += 1) {
      memory.write({
        projectId: 'noe',
        title: `Limit Memory ${i}`,
        body: `shared recall boundary ${i}`,
        tags: ['alpha', '', 42, ' '.repeat(2), 'beta'],
      });
    }

    const one = memory.recall({ projectId: 'noe', q: 'shared recall boundary', limit: 0, useFts: false, bumpHits: false });
    expect(one).toHaveLength(1);
    expect(one[0].tags).toEqual(['alpha', '42', 'beta']);

    const many = memory.recall({ projectId: 'noe', q: 'shared recall boundary', limit: 999, useFts: false, bumpHits: false });
    expect(many).toHaveLength(3);
  });
});

describe('FocusStack', () => {
  it('pushes, refreshes duplicate focus, restores active stack, and absorbs popped focus into memory', () => {
    const first = focus.push({ projectId: 'noe', title: 'Ship Memory Core', summary: 'Implement schema and recall.' });
    const refreshed = focus.push({ projectId: 'noe', title: 'Ship Memory Core', summary: 'Refresh current focus.' });
    focus.push({ projectId: 'other', title: 'Other focus' });

    expect(refreshed.id).toBe(first.id);
    expect(refreshed.hitCount).toBe(2);
    expect(focus.restore({ projectId: 'noe' })).toHaveLength(1);
    expect(focus.restore({ projectId: 'other' })).toHaveLength(1);

    const popped = focus.pop(first.id, { summary: 'Memory Core finished.' });
    expect(popped).toMatchObject({ state: 'popped' });
    expect(popped.absorbedMemoryId).toBeTruthy();
    expect(memory.get(popped.absorbedMemoryId)).toMatchObject({
      projectId: 'noe',
      sourceType: 'focus_stack',
    });
    expect(focus.restore({ projectId: 'noe' })).toHaveLength(0);
  });

  it('rejects empty titles and can pop without absorbing into memory', () => {
    expect(() => focus.push({ projectId: 'noe', title: '   ', summary: 'missing title' })).toThrow('focus title required');

    const item = focus.push({ projectId: 'noe', title: 'Temporary focus', summary: 'Do not persist this focus.' });
    const popped = focus.pop(item.id, { absorb: false, summary: 'Done without memory absorption.' });

    expect(popped).toMatchObject({
      state: 'popped',
      absorbedMemoryId: null,
      compressedSummary: 'Done without memory absorption.',
    });
    expect(focus.pop(item.id)).toBe(null);
    expect(memory.stats({ projectId: 'noe' })).toMatchObject({ total: 0, visible: 0 });
  });
});
