import { describe, expect, it } from 'vitest';
import { NoeMemoryExtractor } from '../../src/memory/NoeMemoryExtractor.js';

describe('NoeMemoryExtractor', () => {
  it('parses JSON candidates into structured records with provenance', async () => {
    const extractor = new NoeMemoryExtractor({
      complete: async () => JSON.stringify([
        { kind: 'preference', body: '主人长期偏好黑咖啡。', confidence: 0.82, tags: ['coffee'], salience: 4 },
      ]),
      fallback: { extract: async () => { throw new Error('fallback should not run'); } },
      now: () => 1234,
    });
    const records = await extractor.extractRecords('用户：我长期喝黑咖啡', {
      projectId: 'noe',
      sourceEpisodeId: 'ep-json',
      evidenceRefs: ['episode:ep-json'],
    });
    expect(records).toEqual([
      expect.objectContaining({
        kind: 'preference',
        scope: 'fact',
        body: '主人长期偏好黑咖啡。',
        sourceEpisodeId: 'ep-json',
        evidenceRefs: ['episode:ep-json'],
        validFrom: 1234,
        confidence: 0.82,
        salience: 4,
      }),
    ]);
  });

  it('accepts object-wrapped candidates for adapters that require JSON objects', async () => {
    const extractor = new NoeMemoryExtractor({
      complete: async () => JSON.stringify({ candidates: [{ kind: 'insight', body: '我需要保留来源证据。' }] }),
      fallback: { extract: async () => [] },
      now: () => 5678,
    });
    const records = await extractor.extractRecords('对话', { sourceEpisodeId: 'ep-object', evidenceRefs: ['episode:ep-object'] });
    expect(records[0]).toMatchObject({ kind: 'insight', scope: 'insight', sourceEpisodeId: 'ep-object' });
  });

  it('parses local-model JSON wrapped in think blocks, prose, and markdown fences', async () => {
    let fallbackCalled = false;
    const extractor = new NoeMemoryExtractor({
      complete: async () => [
        '<think>先思考一下，但这里不是输出。</think>',
        '下面是结果：',
        '```json',
        '{"candidates":[{"kind":"skill","body":"以后改 UI 后要截图复查。","confidence":0.88,"tags":["ui"],"salience":4}]}',
        '```',
      ].join('\n'),
      fallback: { extract: async () => { fallbackCalled = true; return ['fallback']; } },
      now: () => 8888,
    });

    const records = await extractor.extractRecords('用户：以后改 UI 后要截图复查', {
      sourceEpisodeId: 'ep-fenced',
      evidenceRefs: ['episode:ep-fenced'],
    });

    expect(fallbackCalled).toBe(false);
    expect(records[0]).toMatchObject({
      kind: 'skill',
      scope: 'project',
      body: '以后改 UI 后要截图复查。',
      confidence: 0.88,
      salience: 4,
      sourceEpisodeId: 'ep-fenced',
    });
  });

  it('preserves no-write reasons as gate-rejectable records', async () => {
    const extractor = new NoeMemoryExtractor({
      complete: async () => JSON.stringify([{ kind: 'no_write', reason: 'ephemeral_instruction' }]),
      fallback: { extract: async () => ['fallback should not run'] },
      now: () => 9999,
    });
    const records = await extractor.extractRecords('用户：帮我临时点一下按钮', {
      sourceEpisodeId: 'ep-nowrite',
      evidenceRefs: ['episode:ep-nowrite'],
    });
    expect(records).toEqual([
      expect.objectContaining({
        body: 'no_write:ephemeral_instruction',
        noWriteReason: 'ephemeral_instruction',
        sourceEpisodeId: 'ep-nowrite',
      }),
    ]);
  });
});
