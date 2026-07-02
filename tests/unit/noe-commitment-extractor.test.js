import { describe, expect, it } from 'vitest';
import { commitmentDedupeKey, extractCommitments, createCommitmentExtractionHook } from '../../src/runtime/NoeCommitmentExtractor.js';
import { createCommitmentStore } from '../../src/runtime/NoeCommitmentStore.js';
import { VoiceSession } from '../../src/voice/VoiceSession.js';

const NOW = 1_700_000_000_000;

describe('extractCommitments（T7：只抽 Noe 自我承诺）', () => {
  it('「我会X」抽出承诺，dueWindow=10min 后起 24h 窗', () => {
    const out = extractCommitments('好的，我会帮你查明天的航班信息', { now: NOW });
    expect(out).toHaveLength(1);
    expect(out[0].text).toContain('我会帮你查明天的航班信息');
    expect(out[0].confidence).toBeGreaterThanOrEqual(0.85);
    expect(out[0].dueWindow.earliestMs).toBe(NOW + 10 * 60000);
    expect(out[0].dueWindow.latestMs).toBe(NOW + 24 * 3600000);
  });

  it('「我答应/保证」「回头/稍后」也抽', () => {
    expect(extractCommitments('我答应你周末整理好相册', { now: NOW })[0].confidence).toBe(0.9);
    expect(extractCommitments('回头我帮你把报告排版好', { now: NOW })).toHaveLength(1);
  });

  it('否定句不抽（我不会/没法）', () => {
    expect(extractCommitments('抱歉这个我不会操作支付', { now: NOW })).toEqual([]);
    expect(extractCommitments('我没法直接访问你的银行账户', { now: NOW })).toEqual([]);
  });

  it('普通回复不抽', () => {
    expect(extractCommitments('今天天气晴 25 度，适合出门散步', { now: NOW })).toEqual([]);
  });
});

describe('createCommitmentExtractionHook（去重+真入库）', () => {
  it('真 store 入库 + 同承诺第二次跳过', () => {
    const store = createCommitmentStore();
    const ingest = createCommitmentExtractionHook({ store, now: () => NOW });
    expect(ingest('我会帮你订周五的餐厅')).toEqual({ added: 1, skipped: 0 });
    expect(ingest('我会帮你订周五的餐厅')).toEqual({ added: 0, skipped: 1 });   // dedupe
    const open = store.list({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].text).toContain('订周五的餐厅');
  });

  it('置信度门槛过滤（minConfidence 高于模式置信度则不入）', () => {
    const store = createCommitmentStore();
    const ingest = createCommitmentExtractionHook({ store, minConfidence: 0.95, now: () => NOW });
    expect(ingest('我会帮你查资料').added).toBe(0);
  });

  it('缺 store 抛 TypeError', () => {
    expect(() => createCommitmentExtractionHook({})).toThrow(TypeError);
  });
});

describe('VoiceSession 集成：回复含承诺 → 自动入 CommitmentStore', () => {
  it('Noe 回复「我会X」后 store 出现 open 承诺', async () => {
    const store = createCommitmentStore();
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'mp3' }) },
      brainRouter: { route: () => ({ adapterId: 'fake', fallbacks: [], tier: 'local' }) },
      getAdapter: (id) => ((id === 'fake' || id === 'lmstudio') ? { chat: async () => ({ reply: '好的，我会帮你盯着这个构建任务' }) } : null),  // default 锁 lmstudio（f0911a8）后也认
      ownerGate: { check: () => ({ ok: true }) },
      commitmentStore: store,
    });
    const r = await vs.chatText('帮我盯一下构建', { noTts: true });
    expect(r.ok).toBe(true);
    const open = store.list({ status: 'open' });
    expect(open).toHaveLength(1);
    expect(open[0].text).toContain('盯着这个构建任务');
  });
});

describe('commitmentDedupeKey', () => {
  it('空白/标点差异归一', () => {
    expect(commitmentDedupeKey('我会 帮你，查资料。')).toBe(commitmentDedupeKey('我会帮你查资料'));
  });
});
