import { describe, expect, it } from 'vitest';
import { createProactiveTickHandler } from '../../src/loop/proactiveTick.js';

const wang = { faces: [{ recognized: true, person: { id: 'p1', displayName: '老王', relation: '同事' } }] };

function makeHandler({ faceRecog = 'auto', who = wang, summary = '主人在写代码', say = 'SILENT', brainThrows = false, tNow = 1_000_000 } = {}) {
  let t = tNow;
  let recogCalls = 0;
  const visionSession = {
    faceRecog,
    latest: () => ({ summary, at: t, mode: 'camera' }),
    recognizeWho: async () => { recogCalls += 1; return who; },
  };
  const getAdapter = () => ({ chat: async () => { if (brainThrows) throw new Error('ollama down'); return { reply: say }; } });
  const handler = createProactiveTickHandler({ visionSession, getAdapter, ttsClient: null, brainAdapterId: 'x', now: () => t });
  return { handler, setT: (v) => { t = v; }, getT: () => t, recog: () => recogCalls };
}

describe('proactiveTick 自动认人(auto)', () => {
  it('auto 认出新熟人 + 大脑沉默 → 兜底主动招呼', async () => {
    const { handler } = makeHandler({ say: 'SILENT' });
    const r = await handler({ force: true });
    expect(r.spoke).toBe(true);
    expect(r.text).toContain('老王');
    expect(r.recognized).toContain('老王(同事)');
  });

  it('auto 认出新熟人 + 大脑给了招呼 → 用大脑话术', async () => {
    const { handler } = makeHandler({ say: '老王来啦，喝口水~' });
    const r = await handler({ force: true });
    expect(r.spoke).toBe(true);
    expect(r.text).toBe('老王来啦，喝口水~');
  });

  it('auto 认出人 + 大脑挂(chat 抛错) → 仍兜底招呼，不被大脑可用性卡住', async () => {
    const { handler } = makeHandler({ brainThrows: true });
    const r = await handler({ force: true });
    expect(r.spoke).toBe(true);
    expect(r.text).toContain('老王');
  });

  it('没认出人 + 大脑挂 → 才算 brain_error(不硬撑)', async () => {
    const { handler } = makeHandler({ who: { faces: [] }, brainThrows: true });
    const r = await handler({ force: true });
    expect(r.spoke).toBe(false);
    expect(r.reason).toBe('brain_error');
  });

  it('到点提醒：commitmentStore 到期项 → 绕过冷却主动叫 + resolve 收口防重复', async () => {
    const t = 9_000_000;
    const resolved = [];
    const commitmentStore = { due: () => [{ id: 'c1', text: '喝水' }], resolve: (id) => resolved.push(id) };
    const visionSession = { faceRecog: 'off', latest: () => null, recognizeWho: async () => ({ faces: [] }) };
    const getAdapter = () => ({ chat: async () => ({ reply: 'SILENT' }) }); // 大脑沉默 → 走兜底
    const handler = createProactiveTickHandler({ visionSession, getAdapter, ttsClient: null, commitmentStore, brainAdapterId: 'x', now: () => t });
    const r = await handler({}); // 非 force，但到点提醒应绕过冷却开口
    expect(r.spoke).toBe(true);
    expect(r.text).toContain('喝水');
    expect(resolved).toContain('c1');
  });

  it('到点提醒可把 P6 self-talk delivery 摘要交给前端确认播放', async () => {
    const t = 9_000_000;
    const deliveries = [];
    const commitmentStore = { due: () => [{ id: 'c-p6', text: 'Noe 心声：该提醒主人喝水' }], resolve: () => {} };
    const visionSession = { faceRecog: 'off', latest: () => null, recognizeWho: async () => ({ faces: [] }) };
    const getAdapter = () => ({ chat: async () => ({ reply: 'SILENT' }) });
    const ttsClient = { synthesize: async () => ({ audioBuffer: Buffer.from('audio'), format: 'mp3' }) };
    const handler = createProactiveTickHandler({
      visionSession,
      getAdapter,
      ttsClient,
      commitmentStore,
      brainAdapterId: 'x',
      now: () => t,
      onCommitmentDelivery: ({ commitment, status, at }) => {
        deliveries.push({ commitment, status, at });
        return { proposalId: 'p6-proposal', targetId: commitment.id, status };
      },
    });

    const r = await handler({});
    expect(r.spoke).toBe(true);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'synthesized', at: t });
    expect(r.selfTalkDeliveries).toEqual([{ proposalId: 'p6-proposal', targetId: 'c-p6', status: 'synthesized' }]);
  });

  it('faceRecog=off → 根本不认人(不调 recognizeWho)，仍走普通陪伴', async () => {
    const { handler, recog } = makeHandler({ faceRecog: 'off', say: '专注呢，加油' });
    const r = await handler({ force: true });
    expect(recog()).toBe(0);
    expect(r.spoke).toBe(true);
    expect(r.text).toBe('专注呢，加油');
  });

  it('认人限流 + 同人不重复念叨：第二次紧接的 tick 不再认人也不重报', async () => {
    const { handler, recog } = makeHandler({ say: 'SILENT', tNow: 5_000_000 });
    const r1 = await handler({}); // 非 force：首次认出老王 → 兜底招呼
    expect(r1.spoke).toBe(true);
    expect(recog()).toBe(1);
    const r2 = await handler({}); // 同一时刻紧接：recogInterval 限流不再认人 + 冷却内 → 不开口
    expect(recog()).toBe(1); // 没有第二次 InsightFace 调用
    expect(r2.spoke).toBe(false);
  });
});
