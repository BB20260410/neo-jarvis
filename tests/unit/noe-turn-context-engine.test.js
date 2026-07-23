import { describe, expect, it, vi } from 'vitest';
import {
  NoeTurnContextEngine,
  buildPeopleBrief,
  createTurnContextProviderGuard,
} from '../../src/context/NoeTurnContextEngine.js';
import { createContextComposer } from '../../src/context/NoeContextBudgeter.js';

// 方向二（ContextEngine 通电）：供给逻辑从 VoiceSession 抽进引擎后的独立契约测试。
// 经 VoiceSession 的端到端注入行为另由 tests/unit/noe-voice-context-injection.test.js 钉死。

function makeEngine(deps = {}) {
  return new NoeTurnContextEngine({ logger: { warn: () => {} }, ...deps });
}

describe('NoeTurnContextEngine 供给段契约', () => {
  it('零依赖：默认仍注入自我能力认知（self-knowledge）', async () => {
    const r = await makeEngine().supplyTurnContext({ transcript: '在吗' });
    expect(r.text).toContain('<noe-self-knowledge>');
    expect(r.dropped).toEqual([]);
  });

  it('systemPrompt 已含 self-knowledge 标签则不重复注入（幂等）', async () => {
    const r = await makeEngine().supplyTurnContext({ transcript: '在吗', systemPrompt: 'x <noe-self-knowledge> y' });
    expect(r.text).not.toContain('<noe-self-knowledge>');
  });

  it('人物库简表注入', async () => {
    const personStore = { list: () => [{ displayName: '老王', relation: '老友', notes: '爱钓鱼', aliases: ['王哥'] }] };
    const r = await makeEngine({ personStore }).supplyTurnContext({ transcript: '在吗' });
    expect(r.text).toContain('主人的人物库');
    expect(r.text).toContain('老王（老友）');
    expect(r.text).toContain('别名：王哥');
  });

  it('到期承诺注入：最多 5 条、单条截 160、空列表不注入、抛错 fail-open', async () => {
    const due = Array.from({ length: 9 }, (_, i) => ({ text: `承诺${i}-` + 'x'.repeat(300) }));
    const r1 = await makeEngine({ commitmentStore: { due: () => due } }).supplyTurnContext({ transcript: '在吗' });
    expect(r1.text).toContain('到期承诺');
    expect(r1.text).toContain('承诺4-');
    expect(r1.text).not.toContain('承诺5-');
    const r2 = await makeEngine({ commitmentStore: { due: () => [] } }).supplyTurnContext({ transcript: '在吗' });
    expect(r2.text).not.toContain('到期承诺');
    const r3 = await makeEngine({ commitmentStore: { due: () => { throw new Error('db down'); } } }).supplyTurnContext({ transcript: '在吗' });
    expect(r3.text).toContain('<noe-self-knowledge>'); // 其余段照常
  });

  it('到期承诺/预取用注入时钟 now（不偷用真实 Date.now）', async () => {
    const seen = [];
    const eng = makeEngine({
      now: () => 12345,
      commitmentStore: { due: (t) => { seen.push(t); return []; } },
      prefetchStore: { toContextBlock: (t) => { seen.push(t); return ''; } },
    });
    await eng.supplyTurnContext({ transcript: '在吗' });
    expect(seen).toEqual([12345, 12345]);
  });

  it('provider guard 隔离坏上下文段并在冷却后恢复注入', async () => {
    let now = 1000;
    let calls = 0;
    const warn = vi.fn();
    const commitmentStore = {
      due: () => {
        calls += 1;
        throw new Error('XIAOMI_API_KEY=tp-unit-test-redaction-key-00000000000000000000 offline');
      },
    };
    const eng = makeEngine({
      commitmentStore,
      logger: { warn },
      providerGuard: createTurnContextProviderGuard({
        failureThreshold: 1,
        cooldownMs: 30_000,
        now: () => now,
      }),
    });

    const first = await eng.supplyTurnContext({ transcript: '在吗' });
    const second = await eng.supplyTurnContext({ transcript: '在吗' });
    now += 30_001;
    commitmentStore.due = () => {
      calls += 1;
      return [{ text: '上下文段冷却后恢复' }];
    };
    const third = await eng.supplyTurnContext({ transcript: '在吗' });

    expect(first.text).toContain('<noe-self-knowledge>');
    expect(first.providerFailures[0]).toMatchObject({ id: 'commitments', reason: 'context_provider_failed' });
    expect(first.providerFailures[0].error).not.toContain('tp-unit-test-redaction-key');
    expect(first.providerFailures[0].circuit.open).toBe(true);
    expect(second.providerFailures[0]).toMatchObject({ id: 'commitments', reason: 'context_provider_quarantined' });
    expect(calls).toBe(2);
    expect(warn.mock.calls.flat().join('\n')).not.toContain('tp-unit-test-redaction-key');
    expect(third.providerFailures).toEqual([]);
    expect(third.text).toContain('上下文段冷却后恢复');
  });

  it('预取池注入与空块不注入', async () => {
    const r1 = await makeEngine({ prefetchStore: { toContextBlock: () => '<prefetch>北京晴 25 度</prefetch>' } }).supplyTurnContext({ transcript: '在吗' });
    expect(r1.text).toContain('北京晴 25 度');
    const r2 = await makeEngine({ prefetchStore: { toContextBlock: () => '' } }).supplyTurnContext({ transcript: '在吗' });
    expect(r2.text).not.toContain('<prefetch>');
  });

  it('人物关系卡：识别出对话者才查；未识别不查', async () => {
    let asked = 0;
    const personCardStore = {
      getByAlias: (a) => { asked += 1; return a === '老王' ? { id: 'p1', name: '老王' } : null; },
      toContextHint: (c) => (c ? `【人物卡】正在和${c.name}对话` : ''),
    };
    const eng = makeEngine({ personCardStore });
    const r1 = await eng.supplyTurnContext({ transcript: '你好', identity: { personVoice: { ok: true, person: { displayName: '老王' } } } });
    expect(r1.text).toContain('【人物卡】正在和老王对话');
    asked = 0;
    const r2 = await eng.supplyTurnContext({ transcript: '你好' });
    expect(asked).toBe(0);
    expect(r2.text).not.toContain('人物卡');
  });

  it('工具桥：toolRegistry 注入且 runner 返回结果块才注入；runner 抛错 fail-open', async () => {
    const eng = makeEngine({ toolRegistry: { invoke: async () => ({}) }, queryToolsRunner: async (t, { projectId }) => `【真实查询结果(${projectId})】命中A` });
    const r = await eng.supplyTurnContext({ transcript: '查一下', projectId: 'demo' });
    expect(r.text).toContain('【真实查询结果(demo)】命中A');
    const eng2 = makeEngine({ toolRegistry: {}, queryToolsRunner: async () => { throw new Error('x'); } });
    const r2 = await eng2.supplyTurnContext({ transcript: '查一下' });
    expect(r2.text).toContain('<noe-self-knowledge>');
  });

  it('动作桥：已执行/需授权两种动作结果文案；detect 抛错 fail-open', async () => {
    const eng = makeEngine({ actionDetect: () => ({ type: 'remember', text: 'x' }), actionRun: async () => ({ ok: true, executed: true, reply: '已经真的记到记忆库了' }) });
    const r1 = await eng.supplyTurnContext({ transcript: '记住x' });
    expect(r1.text).toContain('已经真的执行完了');
    expect(r1.text).toContain('已经真的记到记忆库了');
    const eng2 = makeEngine({ actionDetect: () => ({ type: 'danger', kind: '发送消息' }), actionRun: async () => ({ ok: false, executed: false, reply: '需要主人授权' }) });
    const r2 = await eng2.supplyTurnContext({ transcript: '发消息' });
    expect(r2.text).toContain('未执行/需主人授权');
    const eng3 = makeEngine({ actionDetect: () => { throw new Error('boom'); } });
    const r3 = await eng3.supplyTurnContext({ transcript: '记住x' });
    expect(r3.text).toContain('<noe-self-knowledge>');
  });

  it('身份验证注释：声纹/人脸/软通过/人物库候选四种形态', async () => {
    const eng = makeEngine();
    const r1 = await eng.supplyTurnContext({ transcript: '在', identity: { voice: { ok: true, score: 0.9, threshold: 0.8 }, face: { ok: true, score: 0.7, threshold: 0.55 }, ownerTrust: 'voice_face' } });
    expect(r1.text).toContain('【身份验证】');
    expect(r1.text).toContain('声纹验证通过，分数 0.9，阈值 0.8。');
    expect(r1.text).toContain('当前摄像头人脸验证通过，分数 0.7，阈值 0.55。');
    expect(r1.text).toContain('本轮可以视为主人本人正在说话。');
    const r2 = await eng.supplyTurnContext({ transcript: '在', identity: { voice: { ok: true, softPassedByFace: true, score: 0.7, threshold: 0.8 } } });
    expect(r2.text).toContain('人脸辅助通过底线');
    const r3 = await eng.supplyTurnContext({ transcript: '在', identity: { personVoice: { ok: false, person: { displayName: '甲' }, score: 0.5, reason: 'low_confidence' } } });
    expect(r3.text).toContain('相近候选 甲');
    expect(r3.text).toContain('不要当成确定身份');
  });

  it('认人结果：识别到/没识别到两种规则文案', async () => {
    const eng = makeEngine();
    const r1 = await eng.supplyTurnContext({ transcript: '这是谁', whoResult: { recognized: true, say: '这是老王', person: { displayName: '老王' }, score: 0.83 } });
    expect(r1.text).toContain('【人脸认人结果（以此为准）】这是老王');
    expect(r1.text).toContain('人物库 1:N 匹配：老王');
    const r2 = await eng.supplyTurnContext({ transcript: '这是谁', whoResult: { recognized: false, say: '不认识' } });
    expect(r2.text).toContain('没匹配到就如实说不认识');
  });

  it('视觉规则：有证据/无证据/认人豁免/非视觉问题的 hint 四种形态', async () => {
    const eng = makeEngine();
    const r1 = await eng.supplyTurnContext({ transcript: '我在干嘛', visionQuestion: true, vis: { summary: '主人在喝咖啡', mode: 'camera', situation: { activity: 'chatting', attention: 'relaxed', possibleNeed: 'conversation_support', shouldInterrupt: false, confidence: 0.72 } } });
    expect(r1.text).toContain('当前视觉来源：camera');
    expect(r1.text).toContain('主人在喝咖啡');
    expect(r1.text).toContain('activity=chatting');
    expect(r1.text).toContain('possibleNeed=conversation_support');
    const r2 = await eng.supplyTurnContext({ transcript: '我在干嘛', visionQuestion: true, vis: null, visionMode: 'camera' });
    expect(r2.text).toContain('没有可用视觉证据');
    const r3 = await eng.supplyTurnContext({ transcript: '镜头里是谁', visionQuestion: true, vis: { summary: '一个人' }, whoResult: { recognized: true, say: '是老王', person: { displayName: '老王' }, score: 0.8 }, visionMode: 'camera' });
    expect(r3.text).toContain('人名以认人结果为准');
    const r4 = await eng.supplyTurnContext({ transcript: '在吗', vis: { summary: '主人在打字' } });
    expect(r4.text).toContain('最近视觉证据：主人在打字');
  });

  it('vis.mode 缺失时回落 visionMode 再回落 unknown', async () => {
    const eng = makeEngine();
    const r1 = await eng.supplyTurnContext({ transcript: 'x', visionQuestion: true, vis: { summary: 's' }, visionMode: 'screen' });
    expect(r1.text).toContain('当前视觉来源：screen');
    const r2 = await eng.supplyTurnContext({ transcript: 'x', visionQuestion: true, vis: { summary: 's' } });
    expect(r2.text).toContain('当前视觉来源：unknown');
  });

  it('纠错规则注入', async () => {
    const r = await makeEngine().supplyTurnContext({ transcript: '你说的是谁', correctionQuestion: true });
    expect(r.text).toContain('【纠错规则】');
  });

  it('记忆召回：过滤 voice scope、injectLimit 截断、单条截 200；视觉/纠错问题跳过；缺 memoryPolicy 跳过', async () => {
    const memory = { recall: () => [
      { body: '主人喜欢美式', scope: 'fact' },
      { body: '语音闲聊', scope: 'voice' },
      { body: 'B'.repeat(300), scope: 'fact' },
      { body: '第三条', scope: 'fact' },
    ] };
    const policy = { id: 'default', mode: 'general', recallLimit: 5, injectLimit: 2 };
    const r1 = await makeEngine({ memory }).supplyTurnContext({ transcript: '咖啡', memoryPolicy: policy });
    expect(r1.text).toContain('主人喜欢美式');
    expect(r1.text).not.toContain('语音闲聊');
    expect(r1.text).toContain('B'.repeat(200));
    expect(r1.text).not.toContain('B'.repeat(201));
    expect(r1.text).not.toContain('第三条'); // injectLimit=2
    const r2 = await makeEngine({ memory }).supplyTurnContext({ transcript: '咖啡', memoryPolicy: policy, visionQuestion: true });
    expect(r2.text).not.toContain('主人喜欢美式');
    const r3 = await makeEngine({ memory }).supplyTurnContext({ transcript: '咖啡' });
    expect(r3.text).not.toContain('主人喜欢美式');
  });

  it('记忆召回优先走 recallFused（双路融合），无 fused 走 recall；召回抛错 fail-open', async () => {
    const policy = { id: 'default', mode: 'general', recallLimit: 5, injectLimit: 2 };
    let fusedCalled = 0;
    const memory = { recall: () => { throw new Error('不该走这'); }, recallFused: async () => { fusedCalled += 1; return [{ body: '融合命中', scope: 'fact' }]; } };
    const r1 = await makeEngine({ memory }).supplyTurnContext({ transcript: 'x', memoryPolicy: policy });
    expect(fusedCalled).toBe(1);
    expect(r1.text).toContain('融合命中');
    const r2 = await makeEngine({ memory: { recall: () => { throw new Error('down'); } } }).supplyTurnContext({ transcript: 'x', memoryPolicy: policy });
    expect(r2.text).toContain('<noe-self-knowledge>');
  });

  it('身份验证：声纹识别成功措辞分支 + personFace 先于 personVoice 的注释顺序', async () => {
    const eng = makeEngine();
    const r = await eng.supplyTurnContext({ transcript: '在', identity: {
      personVoice: { ok: true, source: 'voice', person: { displayName: '乙', relation: '同事' }, score: 0.91 },
      personFace: { ok: true, source: 'face', person: { displayName: '甲' }, score: 0.88 },
    } });
    expect(r.text).toContain('本地人物库通过声纹识别到：乙，分数 0.91。关系：同事');
    expect(r.text).toContain('本地人物库通过人脸识别到：甲，分数 0.88。');
    expect(r.text.indexOf('识别到：甲')).toBeLessThan(r.text.indexOf('识别到：乙')); // personFace 注释在前
  });

  it('视觉规则第三态：无视觉证据但有认人结果 → 人名以认人结果为准的文案', async () => {
    const r = await makeEngine().supplyTurnContext({
      transcript: '镜头里是谁', visionQuestion: true, vis: null,
      whoResult: { recognized: true, say: '是老王', person: { displayName: '老王' }, score: 0.8 },
    });
    expect(r.text).toContain('没有可用视觉证据');
    expect(r.text).toContain('人名以【人脸认人结果】为准；其他');
  });

  it('记忆召回入参契约：q/projectId/limit/bumpHits:false 原样传给 recall', async () => {
    let seenArgs = null;
    const memory = { recall: (args) => { seenArgs = args; return []; } };
    await makeEngine({ memory }).supplyTurnContext({ transcript: '咖啡', projectId: 'demo', memoryPolicy: { id: 'default', mode: 'general', recallLimit: 7, injectLimit: 2 } });
    expect(seenArgs).toEqual({ q: '咖啡', projectId: 'demo', limit: 7, bumpHits: false });
  });

  it('动作桥依赖透传契约：actionRun 收到引擎的 memory/commitmentStore 与本轮 projectId', async () => {
    const memory = { recall: null };
    const memoryWriteGate = {};
    const commitmentStore = {};
    let seenDeps = null;
    const eng = makeEngine({ memory, memoryWriteGate, commitmentStore, actionDetect: () => ({ type: 'remember', text: 'x' }), actionRun: async (_a, deps) => { seenDeps = deps; return null; } });
    await eng.supplyTurnContext({ transcript: '记住x', projectId: 'demo' });
    expect(seenDeps.memory).toBe(memory);
    expect(seenDeps.memoryWriteGate).toBe(memoryWriteGate);
    expect(seenDeps.commitmentStore).toBe(commitmentStore);
    expect(seenDeps.projectId).toBe('demo');
  });

  it('动作桥来源链：显式记忆动作先落 episode，再把 sourceEpisodeId/evidenceRefs 传给 actionRun', async () => {
    let seenEpisode = null;
    let seenDeps = null;
    const episodicTimeline = {
      record: (event) => {
        seenEpisode = event;
        return 7788;
      },
    };
    const eng = makeEngine({
      episodicTimeline,
      actionDetect: () => ({ type: 'remember', text: 'x' }),
      actionRun: async (_action, deps) => {
        seenDeps = deps;
        return { ok: true, executed: true, reply: '动作OK' };
      },
    });
    await eng.supplyTurnContext({ transcript: '记住x' });

    expect(seenEpisode).toMatchObject({
      type: 'interaction',
      salience: 4,
      meta: { source: 'turn_context_action_bridge', actionType: 'remember' },
    });
    expect(seenEpisode.summary).toContain('显式记忆动作');
    expect(seenEpisode.summary).not.toContain('记住x');
    expect(seenDeps.sourceEpisodeId).toBe('7788');
    expect(seenDeps.evidenceRefs).toEqual(['episode:7788']);
  });

  it('全 13 段 id/keep/顺序总契约（记录式 composer 钉死，防无声回归）', async () => {
    const makeRecorder = (calls) => () => {
      const real = createContextComposer();
      return { add: (id, text, opts) => { calls.push([id, opts?.keep]); real.add(id, text, opts); }, compose: () => real.compose() };
    };
    const deps = {
      personStore: { list: () => [{ displayName: '老王' }] },
      commitmentStore: { due: () => [{ text: '提醒吃药' }] },
      prefetchStore: { toContextBlock: () => 'PF' },
      personCardStore: { getByAlias: () => ({ id: 'p1' }), toContextHint: () => '卡' },
      toolRegistry: { invoke: async () => ({}) },
      queryToolsRunner: async () => '工具结果',
      actionDetect: () => ({ type: 'remember', text: 'x' }),
      actionRun: async () => ({ executed: true, reply: '动作OK' }),
      memory: { recall: () => [{ body: '记忆条', scope: 'fact' }] },
    };
    const base = {
      transcript: 'x',
      memoryPolicy: { id: 'default', mode: 'general', recallLimit: 5, injectLimit: 2 },
      identity: { voice: { ok: true, score: 1, threshold: 1 }, personVoice: { ok: true, person: { displayName: '老王' } } },
    };
    // 场景A 视觉+纠错轮：who/vision-rule/correction 上、recall 跳过
    const callsA = [];
    await makeEngine({ ...deps, createComposer: makeRecorder(callsA) }).supplyTurnContext({
      ...base, whoResult: { recognized: false, say: '不认识' }, vis: { summary: 's', mode: 'camera' }, visionQuestion: true, correctionQuestion: true,
    });
    expect(callsA).toEqual([
      ['self-knowledge', 6], ['people', 4], ['commitments', 4], ['prefetch', 3], ['person-card', 3],
      ['tool-bridge', 6], ['action', 7], ['identity', 7], ['who', 8], ['vision-rule', 8], ['correction', 8],
    ]);
    // 场景B 普通轮：vision-hint + recall 收尾
    const callsB = [];
    await makeEngine({ ...deps, createComposer: makeRecorder(callsB) }).supplyTurnContext({ ...base, vis: { summary: 's' } });
    expect(callsB).toEqual([
      ['self-knowledge', 6], ['people', 4], ['commitments', 4], ['prefetch', 3], ['person-card', 3],
      ['tool-bridge', 6], ['action', 7], ['identity', 7], ['vision-hint', 5], ['recall', 2],
    ]);
  });

  it('段顺序与 VoiceSession 旧内联一致：people→commitments→prefetch→action→identity→recall', async () => {
    const eng = makeEngine({
      personStore: { list: () => [{ displayName: '老王' }] },
      commitmentStore: { due: () => [{ text: '提醒吃药' }] },
      prefetchStore: { toContextBlock: () => 'PREFETCH块' },
      memory: { recall: () => [{ body: '记忆条', scope: 'fact' }] },
      actionDetect: () => ({ type: 'remember', text: 'x' }),
      actionRun: async () => ({ executed: true, reply: '动作OK' }),
    });
    const { text } = await eng.supplyTurnContext({
      transcript: 'x',
      memoryPolicy: { id: 'default', mode: 'general', recallLimit: 5, injectLimit: 2 },
      identity: { voice: { ok: true, score: 1, threshold: 1 } },
    });
    const order = ['主人的人物库', '到期承诺', 'PREFETCH块', '动作OK', '【身份验证】', '记忆条']
      .map((s) => text.indexOf(s));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('sections 段级白名单：只跑列出的段，白名单外副作用不执行（方向一聊天室入口用）', async () => {
    let actionDetected = 0;
    let commitmentAsked = 0;
    const eng = makeEngine({
      personStore: { list: () => [{ displayName: '老王' }] },
      commitmentStore: { due: () => { commitmentAsked += 1; return [{ text: '提醒吃药' }]; } },
      toolRegistry: { invoke: async () => ({}) },
      queryToolsRunner: async () => '工具结果块',
      actionDetect: () => { actionDetected += 1; return { type: 'remember', text: 'x' }; },
      memory: { recall: () => [{ body: '记忆条', scope: 'fact' }] },
    });
    const r = await eng.supplyTurnContext({
      transcript: '记住x',
      memoryPolicy: { id: 'default', mode: 'general', recallLimit: 5, injectLimit: 2 },
      sections: ['people', 'tool-bridge', 'recall'],
    });
    expect(r.text).toContain('主人的人物库');
    expect(r.text).toContain('工具结果块');
    expect(r.text).toContain('记忆条');
    expect(r.text).not.toContain('<noe-self-knowledge>'); // Noe 人格段被关
    expect(r.text).not.toContain('到期承诺');
    expect(actionDetected).toBe(0);  // 动作桥连检测都不跑（不会写记忆库）
    expect(commitmentAsked).toBe(0); // 白名单外的 store 调用也不发生
  });

  it('sections 缺省 null = 全开（VoiceSession 旧行为不变）', async () => {
    const r = await makeEngine({ commitmentStore: { due: () => [{ text: '提醒吃药' }] } }).supplyTurnContext({ transcript: '在吗' });
    expect(r.text).toContain('<noe-self-knowledge>');
    expect(r.text).toContain('到期承诺');
  });

  it('超预算时按 keep 等级裁剪（recall keep=2 先丢）并 logger.warn 留观测', async () => {
    const warn = vi.fn();
    const eng = makeEngine({
      logger: { warn },
      createComposer: () => createContextComposer({ budgetTokens: 30 }),
      memory: { recall: () => [{ body: '可丢的记忆'.repeat(30), scope: 'fact' }] },
    });
    const r = await eng.supplyTurnContext({
      transcript: 'x',
      systemPrompt: '<noe-self-knowledge>', // 屏蔽 self-knowledge 段，让预算只在 identity(keep7) vs recall(keep2) 之间取舍
      memoryPolicy: { id: 'default', mode: 'general', recallLimit: 5, injectLimit: 2 },
      identity: { voice: { ok: true, score: 1, threshold: 1 } },
    });
    expect(r.dropped).toContain('recall');
    expect(r.text).not.toContain('可丢的记忆');
    expect(r.text).toContain('【身份验证】'); // keep=7 的段保留
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0][0]).toContain('[noe-context]');
  });
});

describe('ui-signals / acui-cards 注入段（ACUI 收口，NOE_CHAT_UISIGNALS 装配点门控）', () => {
  const uiBlock = '<noe-ui-signals trust="local-untrusted" intent="context-only">\n- user acted on card (LocalCouncilPanel): open-ledger\n</noe-ui-signals>';
  const cardBlock = '<noe-acui-cards trust="local-untrusted" intent="context-only">\n- [task/running] 整理证据: 进行中\n</noe-acui-cards>';

  it('注入了 store：两段都进上下文，且 uiSignals 走非消费式 peek（绝不调 consume）', async () => {
    const calls = [];
    const uiSignalStore = {
      peekContextBlock: () => { calls.push('peek'); return uiBlock; },
      consume: () => { calls.push('consume'); return { contextBlock: uiBlock }; },
    };
    const acuiCardStore = { contextBlock: () => cardBlock };
    const r = await makeEngine({ uiSignalStore, acuiCardStore }).supplyTurnContext({ transcript: '我刚点了什么' });
    expect(r.text).toContain('open-ledger');
    expect(r.text).toContain('整理证据');
    expect(calls).toEqual(['peek']); // 议会路径的 consume() 一次都没被碰
  });

  it('未注入 store（默认 OFF 装配形态）：两段不出现', async () => {
    const r = await makeEngine().supplyTurnContext({ transcript: '我刚点了什么' });
    expect(r.text).not.toContain('<noe-ui-signals');
    expect(r.text).not.toContain('<noe-acui-cards');
  });

  it('sections 白名单外：store 连读都不读（副作用不发生）', async () => {
    let uiAsked = 0;
    let cardAsked = 0;
    const eng = makeEngine({
      uiSignalStore: { peekContextBlock: () => { uiAsked += 1; return uiBlock; } },
      acuiCardStore: { contextBlock: () => { cardAsked += 1; return cardBlock; } },
    });
    const r = await eng.supplyTurnContext({ transcript: 'x', sections: ['people', 'recall'] });
    expect(uiAsked).toBe(0);
    expect(cardAsked).toBe(0);
    expect(r.text).not.toContain('noe-ui-signals');
  });

  it('空块不注入；store 抛错 fail-open 其余段照常', async () => {
    const r1 = await makeEngine({
      uiSignalStore: { peekContextBlock: () => '' },
      acuiCardStore: { contextBlock: () => '' },
    }).supplyTurnContext({ transcript: '在吗' });
    expect(r1.text).not.toContain('noe-ui-signals');
    expect(r1.text).not.toContain('noe-acui-cards');
    const r2 = await makeEngine({
      uiSignalStore: { peekContextBlock: () => { throw new Error('store down'); } },
      acuiCardStore: { contextBlock: () => { throw new Error('store down'); } },
    }).supplyTurnContext({ transcript: '在吗' });
    expect(r2.text).toContain('<noe-self-knowledge>'); // 其余段照常
  });

  it('段顺序：ui-signals/acui-cards 紧随 prefetch 之后、person-card 之前（keep=3 同档）', async () => {
    const calls = [];
    const makeRecorder = () => {
      const real = createContextComposer();
      return { add: (id, text, opts) => { calls.push([id, opts?.keep]); real.add(id, text, opts); }, compose: () => real.compose() };
    };
    await makeEngine({
      prefetchStore: { toContextBlock: () => 'PF' },
      uiSignalStore: { peekContextBlock: () => uiBlock },
      acuiCardStore: { contextBlock: () => cardBlock },
      personCardStore: { getByAlias: () => ({ id: 'p1' }), toContextHint: () => '卡' },
      createComposer: makeRecorder,
    }).supplyTurnContext({ transcript: 'x', identity: { personVoice: { ok: true, person: { displayName: '老王' } } } });
    expect(calls).toEqual([
      ['self-knowledge', 6], ['prefetch', 3], ['ui-signals', 3], ['acui-cards', 3], ['person-card', 3], ['identity', 7],
    ]);
  });
});

describe('脱敏纪律（汇出口统一 redactSensitiveText，常开）', () => {
  it('注入段里的密钥模式被脱敏（sk-/Bearer/命名 key）', async () => {
    const eng = makeEngine({
      memory: { recall: () => [
        { body: '主人提过 OPENAI_API_KEY=sk-abcdefghij1234567890abcd 这件事', scope: 'fact' },
        { body: '日志含 Authorization: Bearer abcdef123456789', scope: 'fact' },
      ] },
    });
    const r = await eng.supplyTurnContext({ transcript: '密钥', memoryPolicy: { id: 'default', mode: 'general', recallLimit: 5, injectLimit: 2 } });
    expect(r.text).not.toContain('sk-abcdefghij1234567890abcd');
    expect(r.text).toContain('OPENAI_API_KEY=[redacted]');
    expect(r.text).not.toContain('Bearer abcdef123456789');
    expect(r.text).toContain('Bearer [redacted]');
  });

  it('对正常文本是恒等变换（既有注入文案零影响）', async () => {
    const eng = makeEngine({
      personStore: { list: () => [{ displayName: '老王', relation: '老友', notes: '爱钓鱼' }] },
      memory: { recall: () => [{ body: '主人喜欢美式，常去 tp-link 路由器论坛', scope: 'fact' }] },
    });
    const r = await eng.supplyTurnContext({ transcript: '在吗', memoryPolicy: { id: 'default', mode: 'general', recallLimit: 5, injectLimit: 2 } });
    expect(r.text).toContain('老王（老友）：爱钓鱼');
    expect(r.text).toContain('主人喜欢美式，常去 tp-link 路由器论坛'); // tp- 后不足 20 位字母数字不命中
    expect(r.text).not.toContain('[redacted');
  });
});

describe('buildPeopleBrief（自 VoiceSession 迁入）', () => {
  it('空库/无 list 返回空串；list 抛错返回空串', () => {
    expect(buildPeopleBrief(null)).toBe('');
    expect(buildPeopleBrief({ list: () => [] })).toBe('');
    expect(buildPeopleBrief({ list: () => { throw new Error('x'); } })).toBe('');
  });

  it('max 截断人数、notesLen 截断资料', () => {
    const people = Array.from({ length: 50 }, (_, i) => ({ displayName: `人${i}`, notes: 'n'.repeat(500) }));
    const s = buildPeopleBrief({ list: () => people }, { max: 3, notesLen: 10 });
    expect(s).toContain('人2');
    expect(s).not.toContain('人3：');
    expect(s).toContain('n'.repeat(10));
    expect(s).not.toContain('n'.repeat(11));
  });
});


describe('动作桥代际栅栏守卫（suppressActions：防连击旧代重复写记忆/提醒）', () => {
  function makeEngine(deps = {}) {
    return new NoeTurnContextEngine({ logger: { warn: () => {} }, ...deps });
  }

  it('suppressActions=true：旧代不 detect、不 run 动作桥（杜绝重复记忆/提醒），只读上下文照常', async () => {
    let detectCalls = 0;
    let runCalls = 0;
    let episodeWrites = 0;
    const eng = makeEngine({
      personStore: { list: () => [{ displayName: '老王' }] }, // 只读段：应照常供给
      episodicTimeline: { record: () => { episodeWrites += 1; return 1; } },
      actionDetect: () => { detectCalls += 1; return { type: 'remind', text: '喝水' }; },
      actionRun: async () => { runCalls += 1; return { ok: true, executed: true, reply: '提醒已建好' }; },
    });
    const r = await eng.supplyTurnContext({ transcript: '提醒我喝水', suppressActions: true });
    expect(runCalls).toBe(0);       // 关键：真实写库副作用一次都没发生
    expect(detectCalls).toBe(0);    // 整段跳过（连检测都不跑）
    expect(episodeWrites).toBe(0);  // recordActionSourceEpisode 的时间线写入也被跳过
    expect(r.text).not.toContain('提醒已建好'); // 动作结果未注入
    expect(r.text).toContain('主人的人物库');   // 只读上下文照常供给（被压制代仍拿得到上下文）
  });

  it('suppressActions 惰性谓词为真：同样跳过动作桥', async () => {
    let runCalls = 0;
    const eng = makeEngine({
      actionDetect: () => ({ type: 'remember', text: 'x' }),
      actionRun: async () => { runCalls += 1; return { ok: true, executed: true, reply: '已记' }; },
    });
    const r = await eng.supplyTurnContext({ transcript: '记住x', suppressActions: () => true });
    expect(runCalls).toBe(0);
    expect(r.text).not.toContain('已记');
  });

  it('suppressActions=false/缺省：动作桥照常执行（不压制时行为不变）', async () => {
    let runCalls = 0;
    const eng = makeEngine({
      actionDetect: () => ({ type: 'remind', text: '喝水' }),
      actionRun: async () => { runCalls += 1; return { ok: true, executed: true, reply: '提醒已建好' }; },
    });
    const rDefault = await eng.supplyTurnContext({ transcript: '提醒我喝水' });
    expect(runCalls).toBe(1);
    expect(rDefault.text).toContain('提醒已建好');
    const rFalse = await eng.supplyTurnContext({ transcript: '提醒我喝水', suppressActions: false });
    expect(runCalls).toBe(2);
    expect(rFalse.text).toContain('提醒已建好');
  });

  it('谓词自身抛错：fail-open 放行执行动作桥（守卫绝不因自身故障吞掉用户的记忆/提醒动作）', async () => {
    let runCalls = 0;
    const eng = makeEngine({
      actionDetect: () => ({ type: 'remember', text: 'x' }),
      actionRun: async () => { runCalls += 1; return { ok: true, executed: true, reply: '已记' }; },
    });
    const r = await eng.supplyTurnContext({ transcript: '记住x', suppressActions: () => { throw new Error('fence probe boom'); } });
    expect(runCalls).toBe(1); // 谓词炸了 → 不压制 → 正常执行
    expect(r.text).toContain('已记');
  });
});

describe('lesson-pin 经验教训常驻注入（NOE_LESSON_PIN，治 learning_lesson 产而不用）', () => {
  // 仿 owner-profile：绕开 query 语义召回，按 source_type+salience top-N 直接注入；flag 默认 OFF 零回归。
  const lessonDb = (rows) => ({ db: () => ({ prepare: () => ({ all: () => rows }) }) });
  const withFlag = async (val, fn) => {
    const prev = process.env.NOE_LESSON_PIN;
    if (val === undefined) delete process.env.NOE_LESSON_PIN; else process.env.NOE_LESSON_PIN = val;
    try { return await fn(); } finally {
      if (prev === undefined) delete process.env.NOE_LESSON_PIN; else process.env.NOE_LESSON_PIN = prev;
    }
  };

  it('flag ON + 有教训 → 注入 lesson-pin 段（top-N 教训进上下文）', async () => {
    await withFlag('1', async () => {
      const r = await makeEngine({ memory: lessonDb([{ title: '别窗已有 fail 会拖垮飞轮' }, { title: '探针失败要 fail-closed' }]) })
        .supplyTurnContext({ transcript: 'x' });
      expect(r.text).toContain('近期经验教训');
      expect(r.text).toContain('别窗已有 fail 会拖垮飞轮');
      expect(r.text).toContain('探针失败要 fail-closed');
    });
  });

  it('flag OFF → 不注入，且 flag 守卫短路在 db() 之前（零回归，连 db 都不读）', async () => {
    await withFlag(undefined, async () => {
      let read = 0;
      const r = await makeEngine({ memory: { db: () => { read += 1; return { prepare: () => ({ all: () => [{ title: 'x' }] }) }; } } })
        .supplyTurnContext({ transcript: 'x' });
      expect(r.text).not.toContain('近期经验教训');
      expect(read).toBe(0);
    });
  });

  it('flag ON 但无教训 → 不注入空块', async () => {
    await withFlag('1', async () => {
      const r = await makeEngine({ memory: lessonDb([]) }).supplyTurnContext({ transcript: 'x' });
      expect(r.text).not.toContain('近期经验教训');
    });
  });

  it('flag ON 但 db 抛错 → fail-open 不阻断其他段（self-knowledge 照常）', async () => {
    await withFlag('1', async () => {
      const r = await makeEngine({ memory: { db: () => { throw new Error('db down'); } } })
        .supplyTurnContext({ transcript: 'x' });
      expect(r.text).not.toContain('近期经验教训');
      expect(r.text).toContain('<noe-self-knowledge>');
    });
  });

  it('sections 白名单不含 lesson-pin → 即使 flag ON 也不注入（on() 短路在 db 前）', async () => {
    await withFlag('1', async () => {
      let read = 0;
      const r = await makeEngine({ memory: { db: () => { read += 1; return { prepare: () => ({ all: () => [{ title: 'x' }] }) }; }, recall: () => [] } })
        .supplyTurnContext({ transcript: 'x', sections: ['recall'] });
      expect(r.text).not.toContain('近期经验教训');
      expect(read).toBe(0);
    });
  });
});
