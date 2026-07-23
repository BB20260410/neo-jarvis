import { describe, it, expect } from 'vitest';
import { VoiceSession } from '../../src/voice/VoiceSession.js';
import { MiniMaxTtsClient } from '../../src/voice/MiniMaxTtsClient.js';
import { OwnerGate } from '../../src/voice/OwnerGate.js';

const mockAdapter = (reply) => ({ chat: async () => ({ reply }) });
// f0911a8 起 default profile 可由持久化配置锁 adapterChain=['lmstudio']；2026-06-12 后
// 旧 Gemma 主脑配置会迁移为 Q35 主脑，default 仍可能因持久化 forcedChain 不走 brainRouter 路由。
// 要测 brainRouter 智能路由/本地兜底机制（对非锁定 profile 仍有效），用这个 adapterChain=null 的测试 profile。
const VOICE_TEST_PROFILE = { id: 'voice-test', systemPrompt: '', personaName: '宝贝', mode: 'companion', adapterChain: null, model: null, noAbort: true, thinkingMode: 'default', temperature: 0.4, maxCompletionTokens: 0 };

describe('VoiceSession 语音对话编排', () => {
  it('听→想→说全链路：STT→大脑→TTS→记忆', async () => {
    const stt = { transcribe: async () => '今天好累' };
    const tts = { synthesize: async () => ({ audioBuffer: Buffer.from('audio'), format: 'mp3' }) };
    const brainRouter = { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) };
    let seenOpts;
    // default 锁本地 lmstudio（f0911a8），brainRouter 的 ollama 被 forcedChain 绕过 → adapter 认 lmstudio
    const getAdapter = (id) => (id === 'lmstudio' ? { chat: async (_messages, opts) => { seenOpts = opts; return { reply: '好好休息' }; } } : null);
    const memWrites = [];
    const memory = { write: (x) => memWrites.push(x) };
    const vs = new VoiceSession({ sttClient: stt, ttsClient: tts, brainRouter, getAdapter, memory });
    const r = await vs.chat(Buffer.from('wav'));
    expect(r.ok).toBe(true);
    expect(r.transcript).toBe('今天好累');
    expect(r.reply).toBe('好好休息');
    expect(r.usedAdapter).toBe('lmstudio'); // default 持久化配置可锁本地主脑
    expect(seenOpts).toMatchObject({ noAbort: true });
    expect(r.audioBase64).toBeTruthy();
    expect(memWrites.length).toBe(1); // 对话沉淀进记忆
    expect(memWrites[0].tags).toEqual(expect.arrayContaining(['profile:default', 'mode:companion']));
  });

  it('连续记忆：注入 episodicTimeline 时这轮对话记进时间线（type=interaction，含问答）', async () => {
    const recorded = [];
    const stt = { transcribe: async () => '今天好累' };
    const tts = { synthesize: async () => ({ audioBuffer: Buffer.from('a'), format: 'mp3' }) };
    const brainRouter = { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) };
    const getAdapter = (id) => (id === 'lmstudio' ? mockAdapter('好好休息') : null);
    const vs = new VoiceSession({ sttClient: stt, ttsClient: tts, brainRouter, getAdapter, episodicTimeline: { record: (e) => recorded.push(e) } });
    await vs.chat(Buffer.from('wav'));
    expect(recorded).toHaveLength(1);
    expect(recorded[0].type).toBe('interaction');
    expect(recorded[0].summary).toContain('今天好累');
    expect(recorded[0].summary).toContain('好好休息');
  });

  it('事实提炼使用结构化 records 时保留 temporal/source 字段写入记忆', async () => {
    const memWrites = [];
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: (id) => (id === 'lmstudio' ? mockAdapter('记住了。') : null),
      memory: { write: (x) => memWrites.push(x) },
      factExtractor: {
        extractRecords: async () => [{ body: '用户现在改喝拿铁', validFrom: 1234, validTo: null, sourceEpisodeId: 'ep-1', confidence: 0.82 }],
      },
    });
    const r = await vs.chatText('我现在改喝拿铁', { noTts: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.ok).toBe(true);
    expect(memWrites.find((x) => x.scope === 'fact')).toMatchObject({
      body: '用户现在改喝拿铁',
      validFrom: 1234,
      validTo: null,
      sourceEpisodeId: 'ep-1',
      confidence: 0.82,
    });
  });

  it('finish_reason=length 时丢弃半截回复，不写历史/长期记忆/时间线', async () => {
    const memWrites = [];
    const recorded = [];
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: (id) => (id === 'lmstudio'
        ? { chat: async () => ({ reply: '半截回答不应该落账', incomplete: true, finishReason: 'length', continuationRequired: true }) }
        : null),
      memory: { write: (x) => memWrites.push(x) },
      episodicTimeline: { record: (e) => recorded.push(e) },
      factExtractor: { extractRecords: async () => [{ body: '不应写入的事实' }] },
    });

    const r = await vs.chatText('请长篇总结当前项目', { noTts: true });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('截断');
    expect(memWrites).toHaveLength(0);
    expect(recorded).toHaveLength(0);
    expect(vs.history).toHaveLength(0);
  });

  it('连续记忆：未注入 episodicTimeline 时不记录、不崩（env OFF 零影响）', async () => {
    const stt = { transcribe: async () => 'hi' };
    const tts = { synthesize: async () => ({ audioBuffer: Buffer.from('a'), format: 'mp3' }) };
    const brainRouter = { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) };
    const getAdapter = (id) => (id === 'lmstudio' ? mockAdapter('你好') : null);
    const vs = new VoiceSession({ sttClient: stt, ttsClient: tts, brainRouter, getAdapter });
    const r = await vs.chat(Buffer.from('wav'));
    expect(r.ok).toBe(true);   // 无 episodicTimeline 不影响对话
  });

  it('本地兜底：主 adapter 不可用时自动退 lmstudio 主脑，对话不中断（owner 2026-06-17：abliterated 卸载去 ollama）', async () => {
    const stt = { transcribe: async () => '介绍杭州' };
    const tts = { synthesize: async () => ({ audioBuffer: Buffer.from('a'), format: 'mp3' }) };
    const brainRouter = { route: () => ({ tier: 'mid', adapterId: 'minimax', fallbacks: [] }) };
    const getAdapter = (id) => (id === 'lmstudio' ? mockAdapter('杭州很美') : null); // minimax 不可用 → 退 lmstudio 主脑
    // 用 adapterChain=null 的测试 profile（非 default）保留 brainRouter 兜底机制覆盖——default 已锁本地不走兜底
    const vs = new VoiceSession({ sttClient: stt, ttsClient: tts, brainRouter, getAdapter, chatProfileStore: { resolve: () => VOICE_TEST_PROFILE } });
    const r = await vs.chat(Buffer.from('wav'));
    expect(r.ok).toBe(true);
    expect(r.usedAdapter).toBe('lmstudio'); // 兜底退 lmstudio 主脑
    expect(r.reply).toBe('杭州很美');
  });

  it('前台聊天云端模式会覆盖本地 profile，不占用 ollama/lmstudio', async () => {
    const calls = [];
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: ['lmstudio'] }) },
      getAdapter: (id) => ({
        chat: async () => { calls.push(id); return { reply: id === 'minimax' ? '云端回复' : '不应使用本地' }; },
      }),
      chatProfileStore: { resolve: () => ({ ...VOICE_TEST_PROFILE, adapterChain: ['lmstudio'] }) },
      foregroundChatRouting: { cloudOnly: true, cloudAdapterChain: ['minimax'], localAdapterIds: ['ollama', 'lmstudio'] },
    });
    const r = await vs.chatText('随便聊聊', { noTts: true });
    expect(r.ok).toBe(true);
    expect(r.usedAdapter).toBe('minimax');
    expect(calls).toEqual(['minimax']);
  });

  it('STT 空转写返回错误', async () => {
    const vs = new VoiceSession({ sttClient: { transcribe: async () => '' }, brainRouter: {}, getAdapter: () => null });
    const r = await vs.chat(Buffer.from('wav'));
    expect(r.ok).toBe(false);
  });

  it('TTS 失败仍返回文字（不阻断对话）', async () => {
    const stt = { transcribe: async () => '你好' };
    const tts = { synthesize: async () => { throw new Error('tts down'); } };
    const brainRouter = { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) };
    const vs = new VoiceSession({ sttClient: stt, ttsClient: tts, brainRouter, getAdapter: () => mockAdapter('嗨') });
    const r = await vs.chat(Buffer.from('wav'));
    expect(r.ok).toBe(true);
    expect(r.reply).toBe('嗨');
    expect(r.audioBase64).toBe(null);
    expect(r.ttsError).toBeTruthy();
  });

  it('主人门禁启用后，未命中唤醒词就忽略且不调用大脑', async () => {
    const brainRouter = { route: () => { throw new Error('should not route'); } };
    const vs = new VoiceSession({ sttClient: {}, brainRouter, getAdapter: () => mockAdapter('不应回复'), ownerGate: new OwnerGate({ enabled: true, wakeWords: ['主人口令'] }) });
    const r = await vs.chatText('旁边的人随便问一句', { noTts: true });
    expect(r).toMatchObject({ ok: false, intent: 'owner_gate', ignored: true });
  });

  it('主人门禁命中唤醒词后才进入大脑', async () => {
    let called = false;
    const brainRouter = { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) };
    const adapter = { chat: async () => { called = true; return { reply: '主人，我在。' }; } };
    const vs = new VoiceSession({ sttClient: {}, brainRouter, getAdapter: () => adapter, ownerGate: new OwnerGate({ enabled: true, wakeWords: ['主人口令'] }) });
    const r = await vs.chatText('主人口令 帮我看一下', { noTts: true });
    expect(r.ok).toBe(true);
    expect(called).toBe(true);
    expect(r.reply).toContain('主人');
  });

  it('对话委托命中后把 taskReceipt 带回前端，避免“答应了但看不到执行状态”', async () => {
    const brainRouter = { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter,
      getAdapter: (id) => (id === 'lmstudio' ? mockAdapter('我已经接下，会持续回报进展。') : null),
      delegationHook: () => ({
        goalId: 'g-voice',
        taskId: 'g-voice',
        title: '主人委托：排查语音',
        status: 'accepted',
        nextStep: '只读诊断语音链路',
        summary: '已接单，正在执行。',
      }),
    });

    const r = await vs.chatText('现在语音系统又出问题了，你去找找什么原因', { noTts: true });

    expect(r.ok).toBe(true);
    expect(r.taskReceipt).toMatchObject({
      goalId: 'g-voice',
      taskId: 'g-voice',
      status: 'accepted',
      title: '主人委托：排查语音',
    });
    expect(r.taskReceipt.summary).toContain('已接单');
  });

  it('闲聊大脑全挂时 owner 委托仍立目标（交办不丢，brain 失败也带回 taskReceipt）', async () => {
    const brainRouter = { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter,
      getAdapter: () => ({ chat: async () => { throw new Error('brain down'); } }), // 大脑全挂
      delegationHook: () => ({ goalId: 'g-down', taskId: 'g-down', title: '主人委托：排查语音', status: 'accepted', summary: '已接单，正在执行。' }),
    });
    const r = await vs.chatText('语音又没声了，你去查查什么原因', { noTts: true });
    expect(r.ok).toBe(false); // 大脑挂了对话没成
    expect(r.error).toContain('大脑不可用');
    expect(r.taskReceipt).toMatchObject({ goalId: 'g-down', status: 'accepted' }); // 但交办已立目标
  });

  it('模型自己承诺去查时自动补建任务，避免口头承诺悬空', async () => {
    const hookInputs = [];
    const brainRouter = { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter,
      getAdapter: (id) => (id === 'lmstudio' ? mockAdapter('我先排查一下语音链路，查完告诉你。') : null),
      delegationHook: (text) => {
        hookInputs.push(text);
        if (!String(text).startsWith('帮我排查一下：')) return null;
        return {
          goalId: 'g-promised',
          taskId: 'g-promised',
          title: '主人委托：排查语音',
          status: 'accepted',
          summary: '已接单，正在执行。',
        };
      },
    });

    const r = await vs.chatText('为什么又没有声音了', { noTts: true });

    expect(r.ok).toBe(true);
    expect(hookInputs).toEqual(['为什么又没有声音了', '帮我排查一下：为什么又没有声音了']);
    expect(r.taskReceipt).toMatchObject({ goalId: 'g-promised', status: 'accepted' });
    expect(r.reply).toContain('状态栏会持续显示执行结果');
  });

  it('主人门禁接受 STT 把 Noe 听成独立 NO 的唤醒别名', async () => {
    const gate = new OwnerGate({ enabled: true, wakeWords: ['noe', 'neo'] });
    expect(gate.check('幫我搜索NO語音自動演示測試').ok).toBe(true);
    expect(gate.check('帮我搜索notebook资料').ok).toBe(false);
  });

  it('剥掉 reasoning 泄漏的英文括号自检句', async () => {
    let calls = 0;
    const leaked = "(This looks good. It's warm, uses Master, no markdown/emojis, and responds to the user's exhaustion).主人，听你这么说我真的好心疼啊。";
    const brainRouter = { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) };
    const vs = new VoiceSession({ sttClient: {}, brainRouter, getAdapter: () => ({ chat: async () => { calls++; return { reply: leaked }; } }) });
    const r = await vs.chatText('今天很累', { noTts: true });
    expect(r.ok).toBe(true);
    expect(r.reply).toBe('主人，听你这么说我真的好心疼啊。');
    expect(r.reply).not.toContain('This looks good');
    expect(calls).toBe(1);
  });

  it('中文输出质检严重不合格时自动重试一次', async () => {
    const calls = [];
    const adapter = {
      chat: async (messages) => {
        calls.push(messages);
        return { reply: calls.length === 1 ? 'Final answer: This looks good. No markdown. No emojis.' : '主人，我已经改成中文回答了。' };
      },
    };
    const brainRouter = { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) };
    const vs = new VoiceSession({ sttClient: {}, brainRouter, getAdapter: () => adapter });
    const r = await vs.chatText('今天很累', { noTts: true });
    expect(r.ok).toBe(true);
    expect(r.reply).toBe('主人，我已经改成中文回答了。');
    expect(calls).toHaveLength(2);
    expect(calls[1][0].content).toContain('输出质检重试');
  });

  it('语音派活只返回确认式计划，不直接启动外部 CLI', async () => {
    const tts = { synthesize: async () => ({ audioBuffer: Buffer.from('task-audio'), format: 'mp3' }) };
    const brainRouter = { route: () => ({ tier: 'code', adapterId: 'codex', fallbacks: [] }) };
    const vs = new VoiceSession({ sttClient: {}, ttsClient: tts, brainRouter, getAdapter: () => mockAdapter('不应调用普通大脑') });
    const r = await vs.chatText('让 Codex 帮我修复登录页 bug', { noTts: false });
    expect(r.ok).toBe(true);
    expect(r.intent).toBe('delegate_task');
    expect(r.plan).toMatchObject({ targetAdapter: 'codex', approvalRequired: true, dryRunOnly: true });
    expect(r.confirmEndpoint).toBe('/api/noe/delegate/confirm');
    expect(r.reply).toContain('未启动 CLI');
    expect(r.audioBase64).toBeTruthy();
  });

  // codex post-review: direct delegate_task 分支也要在 fence 守卫窗口内立委托目标并带回 taskReceipt
  // （Task 0.5 延迟改造曾把本分支 taskReceipt 弄成恒 null = 回归；:274 测试只查 plan/audio 没抓到）
  it('direct delegate_task 立 fenced 委托目标并带回 taskReceipt（非恒 null）', async () => {
    const brainRouter = { route: () => ({ tier: 'code', adapterId: 'codex', fallbacks: [] }) };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter,
      getAdapter: () => mockAdapter('不应调用普通大脑'),
      delegationHook: () => ({ goalId: 'g-deleg', taskId: 'g-deleg', title: '主人委托：修登录页', status: 'accepted', summary: '已接单。' }),
    });
    const r = await vs.chatText('让 Codex 帮我修复登录页 bug', { noTts: true });
    expect(r.ok).toBe(true);
    expect(r.intent).toBe('delegate_task');
    expect(r.taskReceipt).toMatchObject({ goalId: 'g-deleg', status: 'accepted' });
  });

  it('语音搜索 transcript 走 webSearch，不进入普通大脑', async () => {
    const webSearch = {
      searchWithMeta: async (query) => ({
        source: 'minimax',
        viaModel: 'MiniMax Search API',
        results: [{ title: 'AI News', url: 'https://example.com/news', snippet: `fresh ${query}`, source: 'minimax' }],
      }),
    };
    const vs = new VoiceSession({
      sttClient: {},
      ttsClient: { synthesize: async () => { throw new Error('should not synthesize'); } },
      brainRouter: { route: () => { throw new Error('should not route brain'); } },
      getAdapter: () => mockAdapter('不应调用普通大脑'),
      webSearch,
      searchSummarizer: async () => ({ reply: '主人，结论是：AI 新闻有更新，我会先讲重点。' }),
    });
    const r = await vs.chatText('帮我查最新 AI 新闻', { noTts: true });
    expect(r.ok).toBe(true);
    expect(r.intent).toBe('research');
    expect(r.mode).toBe('search');
    expect(r.source).toBe('minimax');
    expect(r.viaModel).toBe('MiniMax Search API');
    expect(r.reply).toContain('结论是');
    expect(r.reply).not.toContain('fresh');
    expect(r.audioBase64).toBe(null);
  });

  it('语音搜索只走后台 webSearch，不触发可见电脑演示', async () => {
    const vs = new VoiceSession({
      sttClient: {},
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('voice'), format: 'mp3' }) },
      brainRouter: { route: () => { throw new Error('should not route brain'); } },
      getAdapter: () => mockAdapter('不应调用普通大脑'),
      webSearch: { searchWithMeta: async () => ({ source: 'minimax', results: [{ title: 'Noe 搜索', url: 'https://example.com/noe', snippet: 'demo' }] }) },
    });
    const r = await vs.chatText('帮我搜索 Noe 语音自动演示', { noTts: false, closeAfterMs: 900 });
    expect(r.ok).toBe(true);
    expect(r.intent).toBe('research');
    expect(r.mode).toBe('search');
    expect(r.visible).toBeUndefined();
    expect(r.returnToNoe).toBeUndefined();
    expect(r.closeAfterMs).toBeUndefined();
    expect(r.audioBase64).toBeTruthy();
  });

  it('语音深度研究 transcript 走 researcher', async () => {
    const researcher = {
      research: async (query, opts) => ({
        query,
        report: `# 报告 ${query}`,
        rounds: opts.maxRounds,
        sources: [{ title: 'S', url: 'https://example.com/s' }],
      }),
    };
    const vs = new VoiceSession({
      sttClient: {},
      ttsClient: { synthesize: async () => { throw new Error('should not synthesize'); } },
      brainRouter: { route: () => { throw new Error('should not route brain'); } },
      getAdapter: () => mockAdapter('不应调用普通大脑'),
      webSearch: { search: async () => [] },
      researcher,
    });
    const r = await vs.chatText('研究一下 Noe 上网搜索', { noTts: true, maxRounds: 1 });
    expect(r.ok).toBe(true);
    expect(r.intent).toBe('research');
    expect(r.mode).toBe('deep');
    expect(r.rounds).toBe(1);
    expect(r.report).toContain('Noe 上网搜索');
    expect(r.reply).toContain('报告');
  });

  // Task 0.5 Step1（VoiceSession 层）：search 总结被 finish_reason=length 截断时，写进记忆的是完整规则兜底而非半截
  it('语音搜索总结被截断时不把半截总结写进记忆', async () => {
    const memWrites = [];
    const vs = new VoiceSession({
      sttClient: {},
      ttsClient: { synthesize: async () => { throw new Error('should not synthesize'); } },
      brainRouter: { route: () => { throw new Error('should not route brain'); } },
      getAdapter: () => mockAdapter('不应调用普通大脑'),
      memory: { write: (x) => memWrites.push(x) },
      webSearch: { searchWithMeta: async () => ({ source: 'minimax', results: [
        { title: '全球十大最强大模型', snippet: 'GPT、Claude、Gemini 排名变化很快', source: 'minimax' },
        { title: 'AI 模型榜单更新', snippet: '不同评测口径不同', source: 'minimax' },
      ] }) },
      // searchSummarizer 即 research chat：返回半截总结 + finish_reason=length
      searchSummarizer: async () => ({ reply: '主人，结论是：综合榜单常见 GPT、Claude，但排名会随着评测口径不同而', finish_reason: 'length' }),
    });
    const r = await vs.chatText('帮我查最新 AI 模型排名', { noTts: true });
    expect(r.ok).toBe(true);
    expect(r.intent).toBe('research');
    // 回复不能是半截模型总结
    expect(r.reply).not.toContain('排名会随着评测口径不同而');
    expect(r.reply).toContain('主人，我先给你结论');
    // 记忆里写的也只能是完整规则兜底，绝不含半截总结
    const dialogueWrite = memWrites.find((x) => x.tags?.includes('research'));
    expect(dialogueWrite).toBeTruthy();
    expect(dialogueWrite.body).not.toContain('排名会随着评测口径不同而');
  });

  // Task 0.5 Step2（research 分支）：被 superseded 的旧 research 回复不写 history / 记忆
  it('被压制的旧 research 回复不写 history / 记忆', async () => {
    const memWrites = [];
    let releaseFirst;
    const gate = new Promise((r) => { releaseFirst = r; });
    const vs = new VoiceSession({
      sttClient: {},
      ttsClient: { synthesize: async () => ({ audioBuffer: Buffer.from('x'), format: 'mp3' }) },
      brainRouter: { route: () => { throw new Error('should not route brain'); } },
      getAdapter: () => mockAdapter('不应调用普通大脑'),
      memory: { write: (x) => memWrites.push(x) },
      webSearch: {
        searchWithMeta: async (query) => {
          if (query.includes('第一条')) { await gate; return { source: 'minimax', results: [{ title: 'OLD', snippet: 'old', source: 'minimax' }] }; }
          return { source: 'minimax', results: [{ title: 'NEW', snippet: 'new', source: 'minimax' }] };
        },
      },
      searchSummarizer: async (_msgs) => ({ reply: '主人，结论是：这是一条完整的搜索总结回复，包含足够的不确定性与复核建议。' }),
    });
    const p1 = vs.chatText('帮我查第一条新闻', { noTts: true });
    const p2 = vs.chatText('帮我查第二条新闻', { noTts: true });
    const r2 = await p2;
    releaseFirst();
    const r1 = await p1;
    expect(r2.ok).toBe(true);
    expect(r1.suppressed).toBe(true);
    expect(r1.intent).toBe('superseded');
    // 只有新一代 research 落账：记忆只写一次，history 只剩新一代一问一答
    expect(memWrites).toHaveLength(1);
    expect(vs.history.filter((m) => m.role === 'assistant')).toHaveLength(1);
  });

  it('语言分档 _pickTts：含中文走 MiniMax，纯英文走 Kokoro', () => {
    const tts = { synthesize: async () => ({}) };
    const kokoroTts = { synthesize: async () => ({}) };
    const vs = new VoiceSession({ sttClient: {}, ttsClient: tts, kokoroTts });
    expect(vs._pickTts('今天天气不错')).toBe(tts);          // 含中文 → MiniMax 主音色
    expect(vs._pickTts('Hello there friend')).toBe(kokoroTts); // 纯英文 → 本地 Kokoro
    expect(vs._pickTts('Hello 你好')).toBe(tts);             // 混中文 → MiniMax
  });

  it('没配 Kokoro 时 _pickTts 永远走 MiniMax', () => {
    const tts = { synthesize: async () => ({}) };
    const vs = new VoiceSession({ sttClient: {}, ttsClient: tts });
    expect(vs._pickTts('Hello there')).toBe(tts);
    expect(vs._pickTts('你好')).toBe(tts);
  });

  it('工作模式 profile 只走 MiniMax 并传入模型与 noAbort', async () => {
    let seen;
    const adapter = { model: 'MiniMax-M2.7', chat: async (messages, opts) => { seen = { messages, opts }; return { reply: '结论：可以。' }; } };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: ['lmstudio'] }) },
      getAdapter: (id) => (id === 'minimax' ? adapter : null),
    });
    const r = await vs.chatText('解释一下这个功能', { noTts: true, profileId: 'm3_assistant' });
    expect(r.ok).toBe(true);
    expect(r.tier).toBe('profile');
    expect(r.usedAdapter).toBe('minimax');
    expect(r.usedModel).toBe('MiniMax-M3');
    expect(seen.opts).toMatchObject({ model: 'MiniMax-M3', noAbort: true, thinkingMode: 'default', temperature: 0.25, maxCompletionTokens: 16384, maxTokens: 16384 });
    expect(seen.messages[0].content).toContain('正式 AI 助理');
  });

  it('快速 M3 profile 独立走 MiniMax 无思考，不受工作模式自定义影响', async () => {
    let seenOpts;
    const adapter = { chat: async (_messages, opts) => { seenOpts = opts; return { reply: '可用' }; } };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: (id) => (id === 'minimax' ? adapter : null),
    });
    const r = await vs.chatText('快速回答', { noTts: true, profileId: 'm3_fast' });
    expect(r.ok).toBe(true);
    expect(r.profileId).toBe('m3_fast');
    expect(r.profileName).toBe('快速模式');
    expect(r.usedAdapter).toBe('minimax');
    expect(r.usedModel).toBe('MiniMax-M3');
    expect(seenOpts).toMatchObject({ model: 'MiniMax-M3', thinkingMode: 'disabled', noAbort: true, temperature: 0.2, maxCompletionTokens: 8192, maxTokens: 8192 });
  });

  it('旧极速 M2.7 profile 会迁移到快速模式', async () => {
    let seenOpts;
    const adapter = { chat: async (_messages, opts) => { seenOpts = opts; return { reply: '收到。' }; } };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: (id) => (id === 'minimax' ? adapter : null),
    });
    const r = await vs.chatText('快速回答', { noTts: true, profileId: 'm27_highspeed' });
    expect(r.ok).toBe(true);
    expect(r.profileId).toBe('m3_fast');
    expect(r.profileName).toBe('快速模式');
    expect(r.usedAdapter).toBe('minimax');
    expect(r.usedModel).toBe('MiniMax-M3');
    expect(seenOpts).toMatchObject({ model: 'MiniMax-M3', thinkingMode: 'disabled', noAbort: true, temperature: 0.2, maxCompletionTokens: 8192, maxTokens: 8192 });
  });

  it('视觉问题只带最新视觉证据，不带旧聊天历史和长期记忆', async () => {
    let seenMessages;
    let glanceCalls = 0;
    const adapter = { chat: async (messages) => { seenMessages = messages; return { reply: '你在看当前聊天窗口。' }; } };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: () => adapter,
      memory: {
        recall: () => [{ scope: 'fact', body: '用户刚刚在和叔叔聊天' }],
        write: () => {},
      },
      visionSession: {
        mode: 'screen',
        glance: async () => { glanceCalls++; return { summary: '画面里是当前聊天窗口，没有其他人物。', at: 1, mode: 'screen' }; },
        latest: () => ({ summary: '画面里是当前聊天窗口，没有其他人物。', at: 1, mode: 'screen' }),
      },
    });
    vs.history = [
      { role: 'user', content: '你能看到叔叔吗' },
      { role: 'assistant', content: '你正在和叔叔聊天' },
    ];
    const r = await vs.chatText('你看屏幕里的我在干什么', { noTts: true });
    expect(r.ok).toBe(true);
    expect(glanceCalls).toBe(1);
    expect(seenMessages).toHaveLength(2);
    expect(seenMessages[0].content).toContain('只能依据这段视觉证据回答');
    expect(seenMessages.map((m) => m.content).join('\n')).not.toContain('叔叔');
  });

  it('没有视觉证据时必须提示看不到，不能猜用户在干什么', async () => {
    let seenSystem;
    const adapter = { chat: async (messages) => { seenSystem = messages[0].content; return { reply: '我现在没有拿到画面，看不出来。' }; } };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: () => adapter,
      visionSession: {
        mode: 'camera',
        glance: async () => ({ summary: '', at: null, mode: 'camera', skipped: 'no_camera_frame' }),
        latest: () => null,
      },
    });
    const r = await vs.chatText('是说你能看到摄像头里的我在干什么吗', { noTts: true });
    expect(r.ok).toBe(true);
    expect(seenSystem).toContain('当前没有可用视觉证据');
    expect(seenSystem).toContain('不能猜用户在干什么');
  });

  it('追问模型编出的人物时会切断历史并要求承认误说', async () => {
    let seenMessages;
    const adapter = { chat: async (messages) => { seenMessages = messages; return { reply: '刚才我误说了，并没有证据显示有这个人。' }; } };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: () => adapter,
      memory: { recall: () => [{ scope: 'fact', body: '旧记忆：叔叔' }], write: () => {} },
    });
    vs.history = [{ role: 'assistant', content: '主人正在和叔叔聊天。' }];
    const r = await vs.chatText('叔叔聊天叔叔是谁啊', { noTts: true });
    expect(r.ok).toBe(true);
    expect(seenMessages).toHaveLength(2);
    expect(seenMessages[0].content).toContain('刚才我没有可靠依据');
    expect(seenMessages.some((m) => m.role === 'assistant')).toBe(false);
  });

  it('MiniMax input-sensitive 错误会丢短期历史重试', async () => {
    const calls = [];
    const adapter = {
      chat: async (messages) => {
        calls.push(messages);
        if (messages.length > 2) {
          const err = new Error('MiniMax 422: input new_sensitive (1026)');
          err.code = 'PROVIDER_INPUT_REJECTED';
          throw err;
        }
        return { reply: '可用' };
      },
    };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: (id) => (id === 'minimax' ? adapter : null),
    });
    vs.history = [{ role: 'user', content: '旧上下文' }, { role: 'assistant', content: '旧回复' }];
    const r = await vs.chatText('你好', { noTts: true, profileId: 'm3_fast' });
    expect(r.ok).toBe(true);
    expect(r.reply).toBe('可用');
    expect(calls).toHaveLength(2);
    expect(calls[0].length).toBeGreaterThan(2);
    expect(calls[1]).toHaveLength(2);
  });

  it('M3 profile 不在 MiniMax 不可用时回退本地模型', async () => {
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: (id) => (id === 'ollama' ? mockAdapter('不该用本地') : null),
    });
    const r = await vs.chatText('你好', { noTts: true, profileId: 'm3_companion' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('minimax');
    expect(r.error).not.toContain('ollama');
  });

  it('正式助理 profile 少记闲聊：不写普通对话，也不做事实提炼', async () => {
    const memWrites = [];
    let extractCalls = 0;
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: (id) => (id === 'minimax' ? mockAdapter('收到。') : null),
      memory: { write: (x) => memWrites.push(x) },
      factExtractor: { extract: async () => { extractCalls++; return ['用户喜欢简洁']; } },
    });
    const r = await vs.chatText('今天先随便聊两句', { noTts: true, profileId: 'm3_assistant' });
    expect(r.ok).toBe(true);
    expect(memWrites).toHaveLength(0);
    expect(extractCalls).toBe(0);
  });

  it('不同 profile 使用不同记忆权重，并优先注入同 profile 记忆', async () => {
    let recallArgs;
    let seenSystem;
    const memory = {
      recall: (args) => {
        recallArgs = args;
        return [
          { scope: 'fact', body: '通用记忆：用户喜欢直接结论', tags: [] },
          { scope: 'fact', body: '陪伴记忆：用户想被温柔安慰', tags: ['profile:default', 'mode:companion'] },
          { scope: 'fact', body: '正式助理记忆：用户要求先给结论', tags: ['profile:m3_assistant', 'mode:assistant'] },
        ];
      },
      write: () => {},
    };
    const adapter = { chat: async (messages) => { seenSystem = messages[0].content; return { reply: '结论：可以。' }; } };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: (id) => (id === 'minimax' ? adapter : null),
      memory,
    });
    const r = await vs.chatText('记得我的偏好吗', { noTts: true, profileId: 'm3_assistant' });
    expect(r.ok).toBe(true);
    expect(recallArgs.limit).toBe(2);
    expect(seenSystem).toContain('正式助理记忆：用户要求先给结论');
    expect(seenSystem).toContain('通用记忆：用户喜欢直接结论');
    expect(seenSystem).not.toContain('陪伴记忆：用户想被温柔安慰');
  });

  it('把本地人物库识别结果注入对话上下文', async () => {
    let seenSystem = '';
    const adapter = { chat: async (messages) => { seenSystem = messages[0].content; return { reply: '我识别到这是张三。' }; } };
    const vs = new VoiceSession({
      sttClient: {},
      brainRouter: { route: () => ({ tier: 'local', adapterId: 'ollama', fallbacks: [] }) },
      getAdapter: () => adapter,
      personStore: {
        identifyFace: () => ({ ok: true, source: 'face', score: 0.91, person: { displayName: '张三', relation: '朋友', notes: '喜欢咖啡，来过工作室。', aliases: ['三哥'] } }),
      },
    });
    const r = await vs.chatText('镜头里这个人是谁', { noTts: true, faceEmbedding: Array.from({ length: 16 }, (_, i) => i / 16) });
    expect(r.ok).toBe(true);
    expect(seenSystem).toContain('本地人物库通过人脸识别到：张三');
    expect(seenSystem).toContain('关系：朋友');
    expect(seenSystem).toContain('喜欢咖啡');
    expect(r.people.face.person.displayName).toBe('张三');
  });
});

describe('MiniMaxTtsClient.cleanText', () => {
  it('剥 markdown 和 emoji，避免念出符号', () => {
    expect(MiniMaxTtsClient.cleanText('**你好** `code` ### 标题 😊')).toBe('你好 code 标题');
    expect(MiniMaxTtsClient.cleanText('看[链接](http://x.com)吧')).toBe('看链接吧');
  });

  it('TTS client falls back to the persistent MiniMax secret resolver without exposing the key', () => {
    const tts = new MiniMaxTtsClient({
      secretResolver: (provider) => ({ ok: provider === 'minimax', value: 'keychain-tts-key', source: 'keychain', sourceRef: 'MINIMAX_API_KEY' }),
    });

    expect(tts.configured()).toBe(true);
    expect(tts.secretStatus).toMatchObject({ ok: true, source: 'keychain', sourceRef: 'MINIMAX_API_KEY' });
    expect(JSON.stringify(tts.secretStatus)).not.toContain('keychain-tts-key');
  });
});
