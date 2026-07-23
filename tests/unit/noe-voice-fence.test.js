import { describe, expect, it } from 'vitest';
import { VoiceSession } from '../../src/voice/VoiceSession.js';

// T1 接线测试：GenerationFence 进 VoiceSession 回复链路——连发时旧回复被压制、只让最新一代可见。
// 全部用注入 fake（不真调 STT/TTS/LLM/网络）。

function makeSession(adapter, { ttsClient } = {}) {
  return new VoiceSession({
    sttClient: { transcribe: async () => '' },
    ttsClient: ttsClient || { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'mp3' }) },
    brainRouter: { route: () => ({ adapterId: 'fake', fallbacks: [], tier: 'local' }) },
    // f0911a8 起 default profile 可由持久化配置锁 adapterChain=['lmstudio']（当前迁移为 Q35 主脑），
    // 会绕过 brainRouter 的 'fake' → 测试 adapter 也认 lmstudio 才拿得到（本测试只验 fence 逻辑，不关心 adapter id）
    getAdapter: (id) => ((id === 'fake' || id === 'lmstudio') ? adapter : null),
    ownerGate: { check: () => ({ ok: true }) },
  });
}

/** 第一条卡住（模拟慢 LLM）、其余秒回的 fake adapter。 */
function makeRacingAdapter() {
  let releaseFirst;
  const gate = new Promise((r) => { releaseFirst = r; });
  const adapter = {
    chat: async (messages) => {
      const user = messages[messages.length - 1].content;
      if (user.includes('第一条')) { await gate; return { reply: '旧回复' }; }
      return { reply: '新回复' };
    },
  };
  return { adapter, releaseFirst: () => releaseFirst() };
}

describe('VoiceSession × GenerationFence（T1 接线）', () => {
  it('同会话连发两条：旧回复被压制(suppressed)，新回复正常返回', async () => {
    const { adapter, releaseFirst } = makeRacingAdapter();
    const vs = makeSession(adapter);
    const p1 = vs.chatText('第一条', { noTts: true });
    const p2 = vs.chatText('第二条', { noTts: true });
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(r2.reply).toBe('新回复');
    releaseFirst();
    const r1 = await p1;
    expect(r1.ok).toBe(false);
    expect(r1.suppressed).toBe(true);
    expect(r1.intent).toBe('superseded');
  });

  it('不同 sessionKey 互不压制', async () => {
    const { adapter, releaseFirst } = makeRacingAdapter();
    const vs = makeSession(adapter);
    const p1 = vs.chatText('第一条', { noTts: true, sessionKey: 'room-a' });
    const p2 = vs.chatText('第二条', { noTts: true, sessionKey: 'room-b' });
    const r2 = await p2;
    releaseFirst();
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(r1.reply).toBe('旧回复');
    expect(r2.ok).toBe(true);
  });

  it('opts.fence === false 旁路：连发也不压制', async () => {
    const { adapter, releaseFirst } = makeRacingAdapter();
    const vs = makeSession(adapter);
    const p1 = vs.chatText('第一条', { noTts: true, fence: false });
    const p2 = vs.chatText('第二条', { noTts: true, fence: false });
    const r2 = await p2;
    releaseFirst();
    const r1 = await p1;
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });

  it('被压制的旧代跳过 TTS（省 MiniMax 配额）', async () => {
    let ttsCalls = 0;
    const { adapter, releaseFirst } = makeRacingAdapter();
    const vs = makeSession(adapter, {
      ttsClient: { synthesize: async () => { ttsCalls += 1; return { audioBuffer: Buffer.from('x'), format: 'mp3' }; } },
    });
    const p1 = vs.chatText('第一条', {});   // 不关 TTS
    const p2 = vs.chatText('第二条', {});
    const r2 = await p2;
    releaseFirst();
    const r1 = await p1;
    expect(r2.ok).toBe(true);
    expect(r1.suppressed).toBe(true);
    expect(ttsCalls).toBe(1);   // 只有最新一代真合成了语音
  });

  it('单条消息正常通过（栅栏不影响平时对话）', async () => {
    const vs = makeSession({ chat: async () => ({ reply: '你好' }) });
    const r = await vs.chatText('在吗', { noTts: true });
    expect(r.ok).toBe(true);
    expect(r.reply).toBe('你好');
  });

  // Task 0.5 Step2：被代际栅栏 superseded 的旧回复不写 history / 长期记忆 / 时间线 / 事实
  it('被压制的旧代不写 history / memory / 时间线 / 事实抽取', async () => {
    const { adapter, releaseFirst } = makeRacingAdapter();
    const memWrites = [];
    const recorded = [];
    const facts = [];
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'mp3' }) },
      brainRouter: { route: () => ({ adapterId: 'fake', fallbacks: [], tier: 'local' }) },
      getAdapter: (id) => ((id === 'fake' || id === 'lmstudio') ? adapter : null),
      ownerGate: { check: () => ({ ok: true }) },
      memory: { write: (x) => memWrites.push(x) },
      episodicTimeline: { record: (e) => { recorded.push(e); return `ep-${recorded.length}`; } },
      factExtractor: { extractRecords: async () => { facts.push('extract'); return [{ body: '不该落账的事实' }]; } },
    });
    const p1 = vs.chatText('第一条', { noTts: true });
    const p2 = vs.chatText('第二条', { noTts: true });
    const r2 = await p2;
    releaseFirst();
    const r1 = await p1;
    await new Promise((resolve) => setTimeout(resolve, 0)); // 等异步事实抽取（若错误地被触发）跑一拍
    expect(r2.ok).toBe(true);
    expect(r1.suppressed).toBe(true);
    expect(r1.intent).toBe('superseded');
    // 关键：旧代零落账——timeline/fact 各只被新代触发一次，dialogue 记忆只写新代一条
    expect(recorded).toHaveLength(1);
    expect(facts).toHaveLength(1); // factExtractor 只被新代调用一次（旧代被守卫跳过）
    const dialogueWrites = memWrites.filter((x) => x.scope === 'voice');
    expect(dialogueWrites).toHaveLength(1);
    // 任何写入都不得携带旧代痕迹（'第一条'/'旧回复'）
    expect(memWrites.some((x) => String(x.body || '').includes('第一条') || String(x.body || '').includes('旧回复'))).toBe(false);
    // 会话历史只保留新一代的一问一答（旧代不进 history）
    expect(vs.history.filter((m) => m.role === 'assistant')).toHaveLength(1);
    expect(vs.history.find((m) => m.role === 'assistant').content).toBe('新回复');
  });

  // Task 0.5 Step3：动作桥（委托/记忆写库）在 turn superseded 时不执行真实写库副作用
  it('被压制的旧代不触发 delegationHook 真实写库副作用', async () => {
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    // 旧代慢、新代快；delegationHook 在旧代里被早调时新代已 begin（连击场景），应被压制不写库
    const adapter = {
      chat: async (messages) => {
        const user = messages[messages.length - 1].content;
        if (user.includes('第一条')) { await gate; return { reply: '旧回复' }; }
        return { reply: '新回复' };
      },
    };
    const delegateCalls = [];
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'mp3' }) },
      brainRouter: { route: () => ({ adapterId: 'fake', fallbacks: [], tier: 'local' }) },
      getAdapter: (id) => ((id === 'fake' || id === 'lmstudio') ? adapter : null),
      ownerGate: { check: () => ({ ok: true }) },
      // 真实写库副作用模拟：每次调用都"写库"一次
      delegationHook: (text) => { delegateCalls.push(text); return { goalId: `g-${delegateCalls.length}`, status: 'accepted' }; },
    });
    const p1 = vs.chatText('第一条 帮我去查个东西', { noTts: true });
    // 确保旧代已进入并越过早期 delegationHook 点之前，新代先 begin 占据最新代
    const p2 = vs.chatText('第二条 帮我去查个东西', { noTts: true });
    const r2 = await p2;
    releaseFirst();
    const r1 = await p1;
    expect(r2.ok).toBe(true);
    expect(r1.suppressed).toBe(true);
    // 关键：被压制的旧代不得真实写库。delegationHook 总调用次数 = 仅新代 1 次
    expect(delegateCalls).toHaveLength(1);
  });
});


describe('动作桥代际栅栏端到端（连击不重复写库）', () => {
  // Task 0.5 同源补洞：被压制的旧代不经 supplyTurnContext 的动作桥重复真写记忆/提醒承诺
  it('被压制的旧代不触发动作桥真实写库（commitmentStore.add 仅新代一次）', async () => {
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    // 旧代慢、新代快：两条都命中「提醒我…」→ 动作桥 remind → commitmentStore.add（真建提醒承诺）
    const adapter = {
      chat: async (messages) => {
        const user = messages[messages.length - 1].content;
        if (user.includes('第一条')) { await gate; return { reply: '旧回复' }; }
        return { reply: '新回复' };
      },
    };
    const addCalls = [];
    const vs = new VoiceSession({
      sttClient: { transcribe: async () => '' },
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'mp3' }) },
      brainRouter: { route: () => ({ adapterId: 'fake', fallbacks: [], tier: 'local' }) },
      getAdapter: (id) => ((id === 'fake' || id === 'lmstudio') ? adapter : null),
      ownerGate: { check: () => ({ ok: true }) },
      // commitmentStore 注入会流进自动构建的 NoeTurnContextEngine（VoiceSession 构造器透传），
      // 动作桥 remind 命中即调 add —— 这是被连击放大的真实写库副作用。
      commitmentStore: { add: (c) => { addCalls.push(c); } },
    });
    const p1 = vs.chatText('提醒我喝水 第一条', { noTts: true });
    const p2 = vs.chatText('提醒我喝水 第二条', { noTts: true });
    const r2 = await p2;
    releaseFirst();
    const r1 = await p1;
    expect(r2.ok).toBe(true);
    expect(r1.suppressed).toBe(true);
    expect(r1.intent).toBe('superseded');
    // 关键：被压制的旧代不得重复建提醒。add 总次数 = 仅新代 1 次（修复前为 2）。
    expect(addCalls).toHaveLength(1);
  });
});
