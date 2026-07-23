import { describe, expect, it } from 'vitest';
import { createDelegationHook, detectAssistantTaskPromise, extractDelegation, taskTextFromAssistantPromise } from '../../src/runtime/NoeDelegationExtractor.js';

// 对话委托桥（2026-06-11）：owner 话里的交办 → owner 目标。零 LLM 宁缺勿滥。

describe('extractDelegation', () => {
  it('识别典型委托语（owner 实痛句式）', () => {
    expect(extractDelegation('现在语音系统又出问题了，你去找找什么原因')).toEqual({ task: '现在语音系统又出问题了，你去找找什么原因' });
    expect(extractDelegation('帮我查一下今天的心跳台账正不正常')).toBeTruthy();
    expect(extractDelegation('麻烦你排查一下内存为什么涨')).toBeTruthy();
    expect(extractDelegation('去研究一下本地模型怎么提速')).toBeTruthy();
  });

  it('识别省略主语的口语交办：找一下是什么原因/问题', () => {
    expect(extractDelegation('没有语音说话呢找一下是什么原因')).toBeTruthy();
    expect(extractDelegation('是不是没有声音呢再找一下是什么问题')).toBeTruthy();
    expect(extractDelegation('语音又断了，排查一下怎么回事')).toBeTruthy();
  });

  it('纯疑问/闲聊/否定不算委托（宁缺勿滥）', () => {
    expect(extractDelegation('为什么语音会这样？')).toBe(null);
    expect(extractDelegation('今天天气怎么样')).toBe(null);
    expect(extractDelegation('不用查了，没事')).toBe(null);
    expect(extractDelegation('你刚才查过了吗')).toBe(null);
    expect(extractDelegation('如果出问题你就去查')).toBe(null);
    expect(extractDelegation('我查一下是什么原因')).toBe(null);
    expect(extractDelegation('短句')).toBe(null);
  });
});

describe('detectAssistantTaskPromise', () => {
  it('识别 Noe 自己说出的异步执行承诺', () => {
    expect(detectAssistantTaskPromise('我先排查一下语音链路，查完告诉你。')).toBe(true);
    expect(detectAssistantTaskPromise('我马上去检查一下服务状态，有结果回报你。')).toBe(true);
    expect(taskTextFromAssistantPromise('没有声音了')).toContain('帮我排查一下');
  });

  it('只表达可以帮忙时不算已经承诺执行', () => {
    expect(detectAssistantTaskPromise('如果需要的话，我可以帮你查。')).toBe(false);
    expect(detectAssistantTaskPromise('我可以帮你看看，但需要你确认。')).toBe(false);
  });
});

describe('createDelegationHook', () => {
  function captureGoal(text) {
    const adds = [];
    const hook = createDelegationHook({
      goalSystem: { add: (g) => { adds.push(g); return 'g-local'; } },
    });
    return { gid: hook(text), goal: adds[0] };
  }

  it('外部资料型委托 → 立 owner 目标带 research 步并留经历', () => {
    const adds = [];
    const eps = [];
    const hook = createDelegationHook({
      goalSystem: { add: (g) => { adds.push(g); return 'g-1'; } },
      recordEpisode: (e) => eps.push(e),
    });
    const gid = hook('帮我查一下最新 AI 新闻');
    expect(gid).toBe('g-1');
    expect(adds[0].source).toBe('owner');
    expect(adds[0].title).toContain('主人委托');
    expect(adds[0].steps[0].kind).toBe('research');
    expect(eps[0].type).toBe('interaction');
  });

  it('本地排查型委托 → 先生成只读 shell.exec 诊断步，再归因思考', () => {
    const { gid, goal } = captureGoal('现在语音系统又出问题了，你去找找什么原因');
    expect(gid).toBe('g-local');
    expect(goal.steps[0]).toMatchObject({
      kind: 'act',
      action: 'shell.exec',
      payload: { command: 'rg', readonly: true, diagnosticDomains: ['voice'] },
    });
    expect(goal.steps[0].payload.args).toEqual(expect.arrayContaining(['src/voice', 'public/src/web/noe-voice.js', 'tests/unit']));
    expect(goal.steps[0].payload.args.join(' ')).toMatch(/VoiceSession|tts|stt/i);
    expect(goal.steps[0].payload.args.join(' ')).toContain('!games/cartoon-apocalypse/**');
    expect(goal.steps[0].payload.args.join(' ')).toContain('!**/.env*');
    expect(goal.steps[0].payload.args.join(' ')).toContain('!**/room-adapters.json');
    expect(goal.steps[1].kind).toBe('think');
  });

  it('本地排查模板按领域细分 model/memory/goal/panel', () => {
    expect(captureGoal('帮我排查一下本地模型没反应').goal.steps[0].payload.diagnosticDomains).toEqual(['model']);
    expect(captureGoal('帮我看看记忆为什么没保存').goal.steps[0].payload.diagnosticDomains).toEqual(['memory']);
    expect(captureGoal('麻烦你检查一下目标卡住的原因').goal.steps[0].payload.diagnosticDomains).toEqual(['goal']);
    expect(captureGoal('你去排查一下面板 500').goal.steps[0].payload.diagnosticDomains).toEqual(['panel']);
  });

  it('returnReceipt=true 时返回可展示的接单回执并写任务回报队列', () => {
    const queued = [];
    const hook = createDelegationHook({
      goalSystem: { add: () => 'g-receipt' },
      taskReportbacks: { add: (item) => queued.push(item) },
      returnReceipt: true,
    });

    const receipt = hook('现在语音系统又出问题了，你去找找什么原因');

    expect(receipt).toMatchObject({
      goalId: 'g-receipt',
      taskId: 'g-receipt',
      status: 'accepted',
      source: 'owner',
      kind: 'act',
    });
    expect(receipt.title).toContain('主人委托');
    expect(receipt.nextStep).toContain('只读诊断');
    expect(queued[0]).toMatchObject({ goalId: 'g-receipt', status: 'accepted', speak: false });
  });

  it('未命中/无 goalSystem/add 抛错均安全返回 null', () => {
    const hook = createDelegationHook({ goalSystem: { add: () => { throw new Error('库崩'); } } });
    expect(hook('帮我查一下这个')).toBe(null);
    expect(createDelegationHook({})('帮我查一下这个')).toBe(null);
    expect(createDelegationHook({ goalSystem: { add: () => 'x' } })('随便聊聊天')).toBe(null);
  });
});
