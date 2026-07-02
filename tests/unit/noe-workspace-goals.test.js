import { describe, it, expect } from 'vitest';
import { createWorkspace } from '../../src/cognition/NoeWorkspace.js';

// P5：目标步进工作区——goal_step 候选、必走深思、审议产出回写目标进展。
const T0 = 1_780_000_000_000;

function makeKv() {
  const m = new Map();
  return { get: (k) => m.get(k), set: (k, v) => m.set(k, v) };
}

describe('NoeWorkspace × NoeGoalSystem', () => {
  it('goal_step 进候选并可夺冠；每周期先 arbitrate', () => {
    let arbitrated = 0;
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: {
        arbitrate: () => { arbitrated++; },
        nextStep: () => ({ goalId: 'g1', title: '搞明白心跳', stepIndex: 0, step: '回看台账数据' }),
      },
      kv: makeKv(),
      appendJournal: () => {},
      now: () => T0,
      textSimilarity: (a, b) => a === b ? 1 : 0,
    });
    const r = ws.step();
    expect(arbitrated).toBe(1);
    expect(r.winner.source).toBe('goal_step');
    expect(r.winner.text).toContain('搞明白心跳');
  });

  it('重复 goal_step 不再吃 0.62 保底，避免同一句长期刷屏', () => {
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      systemStateProvider: () => '系统状态正常，等待新的具体焦点',
      driveBrief: () => '胜任：最近失败率偏高，想稳一点',
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ({ goalId: 'g-repeat', title: '重复目标', stepIndex: 0, step: '反复想同一句话', priority: 0.7 }),
      },
      kv: makeKv(),
      appendJournal: () => {},
      now: () => T0,
      textSimilarity: (a, b) => a === b ? 1 : 0,
    });

    const first = ws.step();
    const second = ws.step();

    expect(first.winner.source).toBe('goal_step');
    const repeatedGoal = second.candidates.find((c) => c.source === 'goal_step');
    expect(repeatedGoal.score).toBeLessThan(0.62);
    expect(second.winner.source).not.toBe('goal_step');
  });

  it('可执行 goal_step 不会被重复到期承诺长期压住', () => {
    let ready = false;
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      commitmentStore: { due: () => [{ text: 'Noe 承诺：我会一边复盘这些新知识' }] },
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ready ? ({
          goalId: 'g-act',
          title: '自主学习：电脑操控',
          stepIndex: 1,
          step: '把 Google Chrome 拉到前台',
          kind: 'act',
          priority: 0.725,
          actionSpec: { action: 'macos.app.activate', payload: { app: 'Google Chrome' } },
        }) : null,
      },
      kv: makeKv(),
      appendJournal: () => {},
      now: () => T0,
      textSimilarity: (a, b) => a === b ? 1 : 0,
    });

    expect(ws.step().winner.source).toBe('commitment_due');
    ready = true;
    const r = ws.step();

    expect(r.winner.source).toBe('goal_step');
    expect(r.winner.kind).toBe('act');
    expect(r.winner.score).toBeGreaterThan(0.61);
  });

  it('收口 think goal_step 也不会被重复到期承诺长期压住', () => {
    let ready = false;
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      commitmentStore: { due: () => [{ text: 'Noe 承诺：我会一边复盘这些新知识' }] },
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ready ? ({
          goalId: 'g-think',
          title: '自主学习：收口',
          stepIndex: 8,
          step: '结合外部学习和本地证据收口',
          kind: 'think',
          priority: 0.725,
        }) : null,
      },
      kv: makeKv(),
      appendJournal: () => {},
      now: () => T0,
      textSimilarity: (a, b) => a === b ? 1 : 0,
    });

    expect(ws.step().winner.source).toBe('commitment_due');
    ready = true;
    const r = ws.step();

    expect(r.winner.source).toBe('goal_step');
    expect(r.winner.kind).toBe('think');
    expect(r.winner.score).toBeGreaterThan(0.61);
  });

  it('goal_step 即使分数低也升深思（这是推进机制）；审议产出回写步骤进展', async () => {
    const progress = [];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ({ goalId: 'g1', title: '研究目标', stepIndex: 1, step: '列出可能解释' }),
        recordStepResult: (goalId, idx, payload) => { progress.push({ goalId, idx, ...payload }); return true; },
      },
      deliberate: async () => ({ deliberated: true, text: '【修订】解释找到了，步骤完成。' }),
      kv: makeKv(),
      appendJournal: () => {},
      now: () => T0,
      deepThreshold: 0.99, // 分数到不了也要升（goal_step 特权）
    });
    const r = ws.step();
    expect(r.escalated).toBe(true);
    await new Promise((res) => setTimeout(res, 0));
    expect(progress[0].goalId).toBe('g1');
    expect(progress[0].idx).toBe(1);
    expect(progress[0].done).toBe(true);
  });

  it('最后一个 think 步前序证据齐全时确定性自动收口，不再等待模型写完成口令', () => {
    const progress = [];
    const doneGoals = [];
    const reportbacks = [];
    let deliberated = 0;
    const plan = [
      { step: '研究', kind: 'research', status: 'recovered', note: '研究 promise 丢失但已释放' },
      { step: '打开网页', kind: 'act', action: 'browser.open_url', status: 'done', note: '行动完成：completed' },
      { step: '写笔记', kind: 'act', action: 'noe.note.write', status: 'done', note: '行动完成：completed' },
      { step: '收口', kind: 'think', status: 'open', note: '' },
    ];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ({ goalId: 'g-terminal', title: '主动学习闭环', stepIndex: 3, step: '结合外部学习和本地证据收口', kind: 'think', priority: 0.99 }),
        get: () => ({ id: 'g-terminal', plan }),
        recordStepResult: (goalId, idx, payload) => { progress.push({ goalId, idx, ...payload }); return { goalDone: true, goal: { id: goalId } }; },
      },
      deliberate: async () => { deliberated++; return { deliberated: true, text: '不该调用' }; },
      onGoalDone: (goal) => doneGoals.push(goal),
      onGoalReportback: (event) => reportbacks.push(event),
      kv: makeKv(),
      appendJournal: () => {},
      now: () => T0,
      deepThreshold: 0,
    });

    const r = ws.step();

    expect(r.winner.source).toBe('goal_step');
    expect(r.escalated).toBe(false);
    expect(deliberated).toBe(0);
    expect(progress[0]).toMatchObject({ goalId: 'g-terminal', idx: 3, done: true });
    expect(progress[0].note).toContain('自动收口');
    expect(doneGoals).toEqual([{ id: 'g-terminal' }]);
    expect(reportbacks[0]).toMatchObject({ goalId: 'g-terminal', status: 'done', kind: 'think', speak: true });
  });

  it('P0-1：NOE_THINK_DELIBERATE=1 时 think 末步调深思脑产真改进方案(非模板)、含本轮证据写进 note', async () => {
    const prev = process.env.NOE_THINK_DELIBERATE;
    process.env.NOE_THINK_DELIBERATE = '1';
    try {
      const progress = [];
      let calls = 0; let gotEvidence = '';
      const plan = [
        { step: '研究AI代理', kind: 'research', status: 'done', note: '研究报告：AI 代理需要 ReAct 循环' },
        { step: '写笔记', kind: 'act', action: 'noe.note.write', status: 'done', note: '行动完成：completed' },
        { step: '收口', kind: 'think', status: 'open', note: '' },
      ];
      const ws = createWorkspace({
        timeline: { recent: () => [] },
        goalSystem: {
          arbitrate: () => {},
          nextStep: () => ({ goalId: 'g-delib', title: '主动学习闭环', stepIndex: 2, step: '收口', kind: 'think', priority: 0.99 }),
          get: () => ({ id: 'g-delib', title: '主动学习闭环', plan }),
          recordStepResult: (goalId, idx, payload) => { progress.push({ goalId, idx, ...payload }); return { goalDone: true, goal: { id: goalId } }; },
        },
        deliberateThink: async (evidenceText, topic) => { calls++; gotEvidence = evidenceText; return `我原以为 AI 代理只要调 LLM，实际上「${topic}」需要 ReAct 循环+工具反馈；下次先搭 observe-act-reflect 再接工具。`; },
        deliberate: async () => ({ deliberated: true }),
        kv: makeKv(), appendJournal: () => {}, now: () => T0, deepThreshold: 0,
      });
      ws.step();
      await new Promise((r) => setTimeout(r, 30)); // 等异步深思盖章
      expect(calls).toBe(1); // 真调了深思脑（治"深思脑 0 次调用"）
      expect(gotEvidence).toContain('ReAct'); // 前序 research+act 证据被喂入
      expect(progress[0].note).not.toContain('自动收口'); // 不是模板
      expect(progress[0].note).toContain('ReAct'); // 改进方案含本轮证据具体内容
      expect(progress[0]).toMatchObject({ idx: 2, done: true });
    } finally { if (prev === undefined) delete process.env.NOE_THINK_DELIBERATE; else process.env.NOE_THINK_DELIBERATE = prev; }
  });

  it('P0-1：deliberateThink 返回 SKIP 时回退模板盖章(fail-open，think 末步不卡死)', async () => {
    const prev = process.env.NOE_THINK_DELIBERATE;
    process.env.NOE_THINK_DELIBERATE = '1';
    try {
      const progress = [];
      const plan = [
        { step: '研究', kind: 'research', status: 'done', note: '研究报告' },
        { step: '收口', kind: 'think', status: 'open', note: '' },
      ];
      const ws = createWorkspace({
        timeline: { recent: () => [] },
        goalSystem: {
          arbitrate: () => {},
          nextStep: () => ({ goalId: 'g-skip', title: 'X', stepIndex: 1, step: '收口', kind: 'think', priority: 0.99 }),
          get: () => ({ id: 'g-skip', title: 'X', plan }),
          recordStepResult: (goalId, idx, payload) => { progress.push({ goalId, idx, ...payload }); return { goalDone: true, goal: { id: goalId } }; },
        },
        deliberateThink: async () => 'SKIP', deliberate: async () => ({ deliberated: true }),
        kv: makeKv(), appendJournal: () => {}, now: () => T0, deepThreshold: 0,
      });
      ws.step();
      await new Promise((r) => setTimeout(r, 30));
      expect(progress[0].note).toContain('自动收口'); // SKIP → 回退模板
      expect(progress[0].done).toBe(true); // 仍盖章，绝不卡死
    } finally { if (prev === undefined) delete process.env.NOE_THINK_DELIBERATE; else process.env.NOE_THINK_DELIBERATE = prev; }
  });

  it('系统自修复目标终态保持可见但不语音播报', () => {
    const reportbacks = [];
    const plan = [
      { step: '只读诊断', kind: 'act', status: 'done', note: 'rg 命中已记录' },
      { step: '运行验证', kind: 'act', status: 'done', note: '测试通过' },
      { step: '收口', kind: 'think', status: 'open', note: '' },
    ];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ({ goalId: 'g-repair', title: '系统自修复：系统运行', stepIndex: 2, step: '结合诊断和验证输出收口', kind: 'think', priority: 0.99 }),
        get: () => ({ id: 'g-repair', plan }),
        recordStepResult: (goalId) => ({ goalDone: true, goal: { id: goalId } }),
      },
      onGoalReportback: (event) => reportbacks.push(event),
      kv: makeKv(),
      appendJournal: () => {},
      now: () => T0,
      deepThreshold: 0,
    });

    ws.step();

    expect(reportbacks[0]).toMatchObject({ goalId: 'g-repair', status: 'done', kind: 'think', speak: false });
  });

  it('无计划目标（stepIndex=-1）：审议输出的列表行长成新计划', async () => {
    const progress = [];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ({ goalId: 'g2', title: '空计划', stepIndex: -1, step: '想清楚第一步' }),
        recordStepResult: (goalId, idx, payload) => { progress.push({ goalId, idx, ...payload }); return true; },
      },
      deliberate: async () => ({ deliberated: true, text: '【修订】计划：\n- 先查记忆\n- 再做对比\n- 写下结论' }),
      kv: makeKv(),
      appendJournal: () => {},
      now: () => T0,
      deepThreshold: 0,
    });
    ws.step();
    await new Promise((res) => setTimeout(res, 0));
    expect(progress[0].idx).toBe(-1);
    expect(progress[0].newSteps.length).toBe(3);
    expect(progress[0].newSteps[0]).toBe('先查记忆');
  });
});

// 行动步分流（意识工程 Phase3，2026-06-11）：act 步不走深思，交 runAct（ActPipeline 门控）。
describe('NoeWorkspace 行动步 act 分流', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  function actGoalSystem(progress) {
    return {
      arbitrate: () => {},
      nextStep: () => ({ goalId: 'g9', title: '目标长手', stepIndex: 0, step: '写演武笔记', kind: 'act', actionSpec: { action: 'noe.note.write', payload: { p: 1 } } }),
      recordStepResult: (goalId, idx, payload) => { progress.push({ goalId, idx, ...payload }); return { goalDone: false }; },
    };
  }

  it('act 赢家：标 doing → runAct 收到规格 → 完成回写 done，不走深思', async () => {
    const progress = [];
    const checkpoints = [];
    const calls = [];
    const reportbacks = [];
    let deliberated = 0;
    const goalSystem = actGoalSystem(progress);
    goalSystem.recordStepCheckpoint = (goalId, idx, payload) => checkpoints.push({ goalId, idx, ...payload });
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem,
      runAct: async (args) => {
        calls.push(args);
        return {
          ok: true,
          act: {
            id: 'act-semantic-1',
            status: 'completed',
            action: 'noe.note.write',
            logRef: 'sqlite:events/7',
            payload: {
              dryRunOnly: false,
              actionEvidence: {
                schemaVersion: 1,
                actionId: 'act-semantic-1',
                action: 'noe.note.write',
                riskLevel: 'low',
                dryRunOnly: false,
                evidenceEventId: 7,
                logRef: 'sqlite:events/7',
                sha256: 'a'.repeat(64),
                refs: {},
                semanticTrace: {
                  summary: ['owner expects confirmed delivery sample'],
                  action: ['noe.note.write'],
                  checkpoint: ['write readiness audit'],
                  fingerprint: 'b'.repeat(24),
                },
              },
            },
          },
          executorResult: { exitCode: 0, stdout: 'VoiceSession.js: delegationHook wired', stderr: '' },
        };
      },
      deliberate: async () => { deliberated++; return { deliberated: true, text: 'x' }; },
      onGoalReportback: (event) => reportbacks.push(event),
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    const r = ws.step();
    expect(r.winner.kind).toBe('act');
    await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0].actionSpec).toEqual({ action: 'noe.note.write', payload: { p: 1 } });
    expect(calls[0].goalRef).toEqual({ goalId: 'g9', stepIndex: 0 });
    expect(calls[0]).toMatchObject({
      goal: '目标长手',
      goalTitle: '目标长手',
      checkpoint: '写演武笔记',
      step: '写演武笔记',
    });
    expect(progress[0].doing).toBe(true);
    expect(progress[1].done).toBe(true);
    expect(progress[1].note).toContain('exit=0');
    expect(progress[1].note).toContain('VoiceSession.js');
    expect(deliberated).toBe(0);
    expect(reportbacks.map((event) => event.status)).toEqual(['running', 'running']);
    expect(reportbacks[0]).toMatchObject({ goalId: 'g9', kind: 'act', speak: false });
    expect(reportbacks[1].summary).toContain('行动完成');
    expect(checkpoints.find((cp) => cp.phase === 'evidence').payload.actionEvidenceSummary.semanticTrace.summary).toEqual(['owner expects confirmed delivery sample']);
  });

  it('真实失败记成 setback（NOE_AFFECT_NEGATIVE 开）；默认 OFF 仍记 observation 不变行为', async () => {
    const mk = (negative) => {
      const recorded = [];
      const ws = createWorkspace({
        timeline: { recent: () => [] },
        goalSystem: actGoalSystem([]),
        runAct: async () => ({ ok: false, error: 'blocked_safety' }),  // 没放行 = 被安全门拦下
        recordEpisode: (e) => recorded.push(e),
        affectNegativeEpisodes: negative,
        kv: makeKv(), appendJournal: () => {}, now: () => T0,
      });
      return { ws, recorded };
    };
    const on = mk(true);
    on.ws.step(); await flush();
    expect(on.recorded.find((e) => e.summary.includes('我为目标动了手'))?.type).toBe('setback');

    const off = mk(false);
    off.ws.step(); await flush();
    expect(off.recorded.find((e) => e.summary.includes('我为目标动了手'))?.type).toBe('observation');
  });

  it('reward-hack 整改（finding A）：dry-run 完成只记 observation，不记 milestone（不冒充成就推 dominance）', async () => {
    const recorded = [];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: actGoalSystem([]),
      // ActPipeline 默认 dry_run 路径：ok:true 但 payload.dryRunOnly:true
      runAct: async () => ({ ok: true, act: { status: 'completed', action: 'noe.note.write', payload: { dryRunOnly: true } } }),
      recordEpisode: (e) => recorded.push(e),
      affectNegativeEpisodes: true, // 即便负面开关开，dry-run 也不该掉进 setback
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    ws.step(); await flush();
    const ep = recorded.find((e) => e.summary.includes('我为目标动了手'));
    expect(ep).toBeTruthy();
    expect(ep.type).toBe('observation');
    expect(ep.type).not.toBe('milestone');
    expect(ep.summary).toContain('dry-run');
  });

  it('真完成（非 dry-run）仍记 milestone（真把事做成了才推 dominance）', async () => {
    const recorded = [];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: actGoalSystem([]),
      runAct: async () => ({ ok: true, act: { status: 'completed', action: 'noe.note.write', payload: { dryRunOnly: false } } }),
      recordEpisode: (e) => recorded.push(e),
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    ws.step(); await flush();
    const ep = recorded.find((e) => e.summary.includes('我为目标动了手'));
    expect(ep).toBeTruthy();
    expect(ep.type).toBe('milestone');
    expect(ep.summary).toContain('完成');
  });

  it('runAct 抛错（真失败）开关开 → 记 setback（让现实能扇 Noe 一巴掌）', async () => {
    const recorded = [];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: actGoalSystem([]),
      runAct: async () => { throw new Error('executor 炸了'); },
      recordEpisode: (e) => recorded.push(e),
      affectNegativeEpisodes: true,
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    ws.step(); await flush();
    expect(recorded.some((e) => e.type === 'setback')).toBe(true);
  });

  it('高优先级 goal act 会压过 drive/system 背景源，避免有手但抢不到注意力', () => {
    const progress = [];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      systemStateProvider: () => '桌面很热闹，但不是当前主目标',
      driveBrief: () => '好奇：最近冒出很多新鲜事，想琢磨琢磨',
      affectProbe: () => ({ v: 0.7, a: 0.9 }),
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ({
          goalId: 'g-owner',
          title: '主人要求我主动学习并操控电脑',
          stepIndex: 3,
          step: '读取浏览器前台 URL/title，确认外部学习页面已打开',
          kind: 'act',
          priority: 0.99,
          actionSpec: { action: 'browser.state_probe', payload: { includeAll: false } },
        }),
        recordStepResult: (goalId, idx, payload) => { progress.push({ goalId, idx, ...payload }); return { goalDone: false }; },
      },
      runAct: async () => ({ ok: true, act: { status: 'completed', action: 'browser.state_probe', payload: { dryRunOnly: false } }, executorResult: { exitCode: 0 } }),
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    const r = ws.step();
    expect(r.winner.source).toBe('goal_step');
    expect(r.winner.kind).toBe('act');
    expect(r.winner.score).toBeGreaterThan(r.candidates.find((c) => c.source === 'drive').score);
    expect(r.winner.score).toBeGreaterThan(r.candidates.find((c) => c.source === 'system_state').score);
  });

  it('act 完成后写入脱敏 Activity 摘要，不保存完整敏感输出', async () => {
    const progress = [];
    const events = [];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: actGoalSystem(progress),
      runAct: async () => ({
        ok: true,
        act: { status: 'completed', action: 'shell.exec', payload: { dryRunOnly: false } },
        executorResult: {
          exitCode: 0,
          stdout: 'VoiceSession.js: ok\napiKey: "sk-abc123456789"\n'.repeat(20),
          stderr: 'Bearer secret-token-value',
        },
      }),
      activityLog: { recordSafe: (event) => events.push(event) },
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    ws.step();
    await flush();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'noe.goal_step.act',
      actorType: 'noe',
      entityType: 'noe_goal',
      entityId: 'g9',
      status: 'done',
    });
    expect(events[0].details.goalId).toBe('g9');
    expect(events[0].details.stepIndex).toBe(0);
    expect(events[0].details.exitCode).toBe(0);
    expect(events[0].details.stdoutSummary.length).toBeLessThanOrEqual(600);
    expect(events[0].details.stdoutSummary).toContain('[REDACTED]');
    expect(events[0].details.stderrSummary).toContain('Bearer [REDACTED]');
    expect(JSON.stringify(events[0])).not.toContain('sk-abc123456789');
    expect(JSON.stringify(events[0])).not.toContain('secret-token-value');
  });

  it('goal_step 文本会带上 priorNotes，后续深思能看到前一步行动证据', () => {
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ({ goalId: 'g10', title: '排查语音', stepIndex: 1, step: '归纳原因', priorNotes: ['只读检查：stdout:VoiceSession.js 命中 delegationHook'] }),
      },
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    const r = ws.step();
    expect(r.winner.text).toContain('已知进展');
    expect(r.winner.text).toContain('VoiceSession.js');
  });

  it('approvalRequired：挂 doing 留审批痕，不标 done', async () => {
    const progress = [];
    const events = [];
    const reportbacks = [];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: actGoalSystem(progress),
      runAct: async () => ({ ok: true, approvalRequired: true, act: { status: 'awaiting_approval', approvalId: 'ap-7' } }),
      activityLog: { recordSafe: (event) => events.push(event) },
      onGoalReportback: (event) => reportbacks.push(event),
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    ws.step();
    await flush();
    expect(progress[1].status).toBe('awaiting_approval');
    expect(progress[1].done).toBeUndefined();
    expect(progress[1].note).toContain('ap-7');
    expect(events[0].status).toBe('awaiting_approval');
    expect(events[0].details.approvalId).toBe('ap-7');
    expect(reportbacks.at(-1)).toMatchObject({ status: 'awaiting_approval', speak: true });
  });

  it('被安全门拦下（ok:false）：留 note 不标 done', async () => {
    const progress = [];
    const events = [];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: actGoalSystem(progress),
      runAct: async () => ({ ok: false, error: 'blocked_safety', act: { status: 'blocked_safety' } }),
      activityLog: { recordSafe: (event) => events.push(event) },
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    ws.step();
    await flush();
    expect(progress[1].done).toBeUndefined();
    expect(progress[1].status).toBe('blocked');
    expect(progress[1].note).toContain('blocked_safety');
    expect(events[0].status).toBe('blocked');
  });

  it('runAct 未注入（默认）：act 步走深思兜底（防御路径，正常时数据层已挡）', async () => {
    const progress = [];
    let deliberated = 0;
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: actGoalSystem(progress),
      deliberate: async () => { deliberated++; return { deliberated: true, text: '想清楚了' }; },
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    ws.step();
    await flush();
    expect(deliberated).toBe(1);
  });
});

// 深思 [act:动作名] 标记解析（C1，2026-06-11）：无计划目标长计划时识别 act 步声明。
describe('NoeWorkspace 深思 [act:] 标记解析', () => {
  it('无计划目标：审议列表行带 [act:] 解析成 act 步对象，普通行保持字符串；context 含 act 教学', async () => {
    const progress = [];
    let seenContext = '';
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ({ goalId: 'g1', title: '演武目标', stepIndex: -1, step: '想清楚第一步', kind: 'think' }),
        recordStepResult: (goalId, idx, payload) => { progress.push({ goalId, idx, ...payload }); return { goalDone: false }; },
      },
      runAct: async () => ({ ok: true, act: { status: 'completed' } }),
      deliberate: async ({ context }) => {
        seenContext = context;
        return {
          deliberated: true,
          text: `计划如下：\n- [act:noe.note.write] 把演武结论写成笔记\n- [act:browser.type {"role":"search","hints":["Search"],"text":"Noe autonomy","token":"secret-value"}] 在搜索框输入关键词\n- 查一查同类项目资料\n${context.includes('[act:') ? '' : '（没收到教学）'}`,
        };
      },
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    ws.step();
    await new Promise((r) => setTimeout(r, 0));
    const rec = progress.find((p) => Array.isArray(p.newSteps));
    expect(rec.newSteps[0]).toEqual({ step: '把演武结论写成笔记', kind: 'act', action: 'noe.note.write' });
    expect(rec.newSteps[1]).toEqual({
      step: '在搜索框输入关键词',
      kind: 'act',
      action: 'browser.type',
      payload: { role: 'search', hints: ['Search'], text: 'Noe autonomy' },
    });
    expect(typeof rec.newSteps[2]).toBe('string');
    expect(seenContext).toContain('browser.open_url');
    expect(seenContext).toContain('browser.state_probe');
    expect(seenContext).toContain('browser.observe_page');
    expect(seenContext).toContain('browser.click');
    expect(seenContext).toContain('browser.type');
    expect(seenContext).toContain('macos.app.activate');
    expect(seenContext).toContain('macos.text.type');
    expect(seenContext).toContain('macos.key.press');
    expect(seenContext).toContain('macos.pointer.click');
    expect(seenContext).toContain('macos.applescript.run');
    expect(seenContext).toContain('macos.jxa.run');
    expect(seenContext).toContain('[act:browser.type');
    expect(seenContext).toContain('visual.action.plan');
    expect(seenContext).toContain('noe.note.write');
  });

  it('无计划目标：审议列表行能带 macOS app activate payload 生成行动步', async () => {
    const progress = [];
    const ws = createWorkspace({
      timeline: { recent: () => [] },
      goalSystem: {
        arbitrate: () => {},
        nextStep: () => ({ goalId: 'g2', title: '切到工具', stepIndex: -1, step: '先把浏览器拉到前台', kind: 'think' }),
        recordStepResult: (goalId, idx, payload) => { progress.push({ goalId, idx, ...payload }); return { goalDone: false }; },
      },
      runAct: async () => ({ ok: true, act: { status: 'completed' } }),
      deliberate: async () => ({
        deliberated: true,
        text: '计划如下：\n- [act:macos.app.activate {"app":"Google Chrome"}] 切到浏览器\n- [act:macos.applescript.run {"script":"return \\"ok\\""}] 跑 AppleScript\n- [act:macos.jxa.run {"script":"JSON.stringify({ok:true})"}] 跑 JXA\n- [act:macos.text.type {"app":"Google Chrome","text":"Noe autonomy","ackClipboardOverwrite":true}] 输入关键词\n- [act:macos.key.press {"app":"Google Chrome","key":"return","ackSubmitKey":true}] 确认后按回车\n- [act:macos.pointer.click {"app":"Google Chrome","x":120,"y":240,"ackCoordinateClick":true}] 确认后点击坐标\n- [act:browser.observe_page {"browserApp":"Google Chrome","actions":[{"type":"read_title"}]}] 观察当前网页标题',
      }),
      kv: makeKv(), appendJournal: () => {}, now: () => T0,
    });
    ws.step();
    await new Promise((r) => setTimeout(r, 0));
    const rec = progress.find((p) => Array.isArray(p.newSteps));
    expect(rec.newSteps[0]).toEqual({
      step: '切到浏览器',
      kind: 'act',
      action: 'macos.app.activate',
      payload: { app: 'Google Chrome' },
    });
    expect(rec.newSteps[1]).toEqual({
      step: '跑 AppleScript',
      kind: 'act',
      action: 'macos.applescript.run',
      payload: { script: 'return "ok"' },
    });
    expect(rec.newSteps[2]).toEqual({
      step: '跑 JXA',
      kind: 'act',
      action: 'macos.jxa.run',
      payload: { script: 'JSON.stringify({ok:true})' },
    });
    expect(rec.newSteps[3]).toEqual({
      step: '输入关键词',
      kind: 'act',
      action: 'macos.text.type',
      payload: { app: 'Google Chrome', text: 'Noe autonomy', ackClipboardOverwrite: true },
    });
    expect(rec.newSteps[4]).toEqual({
      step: '确认后按回车',
      kind: 'act',
      action: 'macos.key.press',
      payload: { app: 'Google Chrome', key: 'return', ackSubmitKey: true },
    });
    expect(rec.newSteps[5]).toEqual({
      step: '确认后点击坐标',
      kind: 'act',
      action: 'macos.pointer.click',
      payload: { app: 'Google Chrome', x: 120, y: 240, ackCoordinateClick: true },
    });
    expect(rec.newSteps[6]).toEqual({
      step: '观察当前网页标题',
      kind: 'act',
      action: 'browser.observe_page',
      payload: { browserApp: 'Google Chrome', actions: [{ type: 'read_title' }] },
    });
  });
});
