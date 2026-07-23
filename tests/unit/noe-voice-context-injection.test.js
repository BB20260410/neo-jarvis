import { describe, expect, it, vi } from 'vitest';
import { VoiceSession } from '../../src/voice/VoiceSession.js';
import { NoeTurnContextEngine } from '../../src/context/NoeTurnContextEngine.js';

// T1 接线测试：Commitment/Prefetch/PersonCard 三 store 注入 VoiceSession 回复上下文。
// fake 契约与真 store 对齐（due(nowMs)/toContextBlock(nowMs)/getByAlias+toContextHint，
// 即 NoeContextEngine 同款 API；真 store 行为由各自单测覆盖）。

function makeSession(extra = {}) {
  let capturedSys = '';
  const adapter = { chat: async (messages) => { capturedSys = messages[0].content; return { reply: '好' }; } };
  const vs = new VoiceSession({
    sttClient: { transcribe: async () => '' },
    ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'mp3' }) },
    brainRouter: { route: () => ({ adapterId: 'fake', fallbacks: [], tier: 'local' }) },
    // default 锁 adapterChain=['lmstudio']（f0911a8，owner 指定）会绕过 brainRouter→认 lmstudio 才拿得到 adapter
    getAdapter: (id) => ((id === 'fake' || id === 'lmstudio') ? adapter : null),
    ownerGate: { check: () => ({ ok: true }) },
    ...extra,
  });
  return { vs, sys: () => capturedSys };
}

describe('T1 注入消费点：Commitment / Prefetch / PersonCard → VoiceSession sys', () => {
  it('到期承诺注入【到期承诺】块', async () => {
    const { vs, sys } = makeSession({ commitmentStore: { due: () => [{ text: '答应主人今晚提醒吃药' }] } });
    const r = await vs.chatText('在吗', { noTts: true });
    expect(r.ok).toBe(true);
    expect(sys()).toContain('到期承诺');
    expect(sys()).toContain('提醒吃药');
  });

  it('无到期承诺不注入', async () => {
    const { vs, sys } = makeSession({ commitmentStore: { due: () => [] } });
    await vs.chatText('在吗', { noTts: true });
    expect(sys()).not.toContain('到期承诺');
  });

  it('到期承诺最多注入 5 条且单条截断', async () => {
    const due = Array.from({ length: 9 }, (_, i) => ({ text: `承诺${i}-` + 'x'.repeat(300) }));
    const { vs, sys } = makeSession({ commitmentStore: { due: () => due } });
    await vs.chatText('在吗', { noTts: true });
    expect(sys()).toContain('承诺4-');
    expect(sys()).not.toContain('承诺5-');   // 第 6 条起不注入
  });

  it('预取池 toContextBlock 注入', async () => {
    const { vs, sys } = makeSession({ prefetchStore: { toContextBlock: () => '<prefetch>北京晴 25 度</prefetch>' } });
    await vs.chatText('在吗', { noTts: true });
    expect(sys()).toContain('北京晴 25 度');
  });

  it('预取池空块不注入', async () => {
    const { vs, sys } = makeSession({ prefetchStore: { toContextBlock: () => '' } });
    await vs.chatText('在吗', { noTts: true });
    expect(sys()).not.toContain('<prefetch>');
  });

  it('声纹识别出对话者 → 人物关系卡注入', async () => {
    const personCardStore = {
      getByAlias: (a) => (a === '老王' ? { id: 'p1', name: '老王' } : null),
      toContextHint: (c) => (c ? `【人物卡】正在和${c.name}对话，关系：老友。` : ''),
    };
    const { vs, sys } = makeSession({ personCardStore });
    await vs.chatText('你好', { noTts: true, personVoice: { ok: true, person: { displayName: '老王' }, score: 0.9 } });
    expect(sys()).toContain('人物卡');
    expect(sys()).toContain('老王');
  });

  it('未识别出人 → 不查人物卡', async () => {
    let asked = 0;
    const personCardStore = { getByAlias: () => { asked += 1; return null; }, toContextHint: () => '' };
    const { vs } = makeSession({ personCardStore });
    await vs.chatText('你好', { noTts: true });
    expect(asked).toBe(0);
  });

  it('T3 性质锁定：易变注入(承诺/预取)永远在稳定前缀之后，两轮 sys 共享相同稳定头（prompt 前缀缓存友好）', async () => {
    let due = [{ text: '第一轮承诺' }];
    const { vs, sys } = makeSession({ commitmentStore: { due: () => due } });
    await vs.chatText('在吗', { noTts: true });
    const sys1 = sys();
    due = [{ text: '第二轮完全不同的承诺' }];
    await vs.chatText('在吗', { noTts: true });
    const sys2 = sys();
    // 稳定头 = profile.systemPrompt（含 self-knowledge/host-context 等进程内稳定块）；两轮逐字一致
    const stableEnd = sys1.indexOf('第一轮承诺');
    expect(stableEnd).toBeGreaterThan(100);
    expect(sys2.slice(0, stableEnd - 20)).toBe(sys1.slice(0, stableEnd - 20));
  });

  it('防回归：chatText 问"这是谁"且视觉开启不崩（modelSettings 原只在 chat() 定义的 ReferenceError 已修）', async () => {
    const { vs } = makeSession({
      visionSession: { recognizeWho: async () => ({ recognized: false, say: '不认识' }), faceRecog: 'ask', mode: 'off', latest: () => null, glance: async () => {} },
    });
    const r = await vs.chatText('这是谁', { noTts: true });
    expect(r.ok).toBe(true);   // 修复前此处 ReferenceError: modelSettings is not defined
  });

  it('store 抛错不阻断对话（fail-open）', async () => {
    const { vs } = makeSession({
      commitmentStore: { due: () => { throw new Error('db down'); } },
      prefetchStore: { toContextBlock: () => { throw new Error('x'); } },
      personCardStore: { getByAlias: () => { throw new Error('y'); }, toContextHint: () => '' },
    });
    const r = await vs.chatText('在吗', { noTts: true, personVoice: { ok: true, person: { displayName: '甲' }, score: 0.9 } });
    expect(r.ok).toBe(true);
    expect(r.reply).toBe('好');
  });
});

// finding C：注入 contextEngine 时 inner-state 的注入责任在调用方（契约文档化 + warn 提示）。
describe('finding C：注入 contextEngine 时 innerStateProvider 契约', () => {
  function makeSessionWithEngine(extra = {}) {
    let capturedSys = '';
    const adapter = { chat: async (messages) => { capturedSys = messages[0].content; return { reply: '好' }; } };
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'mp3' }) },
      brainRouter: { route: () => ({ adapterId: 'fake', fallbacks: [], tier: 'local' }) },
      getAdapter: (id) => ((id === 'fake' || id === 'lmstudio') ? adapter : null),
      ownerGate: { check: () => ({ ok: true }) },
      ...extra,
    });
    return { vs, sys: () => capturedSys };
  }

  it('调用方注入的 contextEngine 自带 innerStateProvider → inner-state 仍正常注入（契约成立：注入方自管）', async () => {
    const injectedEngine = new NoeTurnContextEngine({
      innerStateProvider: () => '【此刻】心情平静，正在留意主人需求',
    });
    const { vs, sys } = makeSessionWithEngine({ contextEngine: injectedEngine });
    const r = await vs.chatText('在吗', { noTts: true });
    expect(r.ok).toBe(true);
    expect(sys()).toContain('心情平静');
  });

  it('同时给 contextEngine 和 innerStateProvider → 用注入的 engine（顶层 provider 不接入），并 warn 提示', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // 注入的 engine 没有 inner-state；顶层 innerStateProvider 不应被本类替接进去。
      const injectedEngine = new NoeTurnContextEngine({});
      const topLevelProvider = vi.fn(() => '【此刻】不该出现的顶层内态');
      const { vs, sys } = makeSessionWithEngine({ contextEngine: injectedEngine, innerStateProvider: topLevelProvider });
      const r = await vs.chatText('在吗', { noTts: true });
      expect(r.ok).toBe(true);
      // 顶层 provider 没被调用，其内容也没进 sys（证明本类没替注入 engine 补挂）。
      expect(topLevelProvider).not.toHaveBeenCalled();
      expect(sys()).not.toContain('不该出现的顶层内态');
      // warn 已提示契约。
      expect(warnSpy).toHaveBeenCalled();
      expect(warnSpy.mock.calls.some((args) => String(args[0]).includes('VoiceSession'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('P8-fix(总验收三方一致)：自建 contextEngine 时 personaPinProvider 下沉语音 system prompt（NOE_MEMORY_PERSONA_PIN=1）', async () => {
    const prev = process.env.NOE_MEMORY_PERSONA_PIN;
    process.env.NOE_MEMORY_PERSONA_PIN = '1';
    try {
      const { vs, sys } = makeSessionWithEngine({ personaPinProvider: () => '〔人设〕沉稳可靠的 Jarvis' });
      const r = await vs.chatText('在吗', { noTts: true });
      expect(r.ok).toBe(true);
      expect(sys()).toContain('沉稳可靠的 Jarvis'); // persona-pin 接进语音自建 engine（漏接则语音永不注入稳定人设）
    } finally {
      if (prev === undefined) delete process.env.NOE_MEMORY_PERSONA_PIN; else process.env.NOE_MEMORY_PERSONA_PIN = prev;
    }
  });
});
