import { describe, expect, it } from 'vitest';
import { createIncidentEscalator, classifyIncidentSignal, buildRepairGoal } from '../../src/cognition/NoeIncidentEscalator.js';
import { createWorkspace } from '../../src/cognition/NoeWorkspace.js';

const T0 = 1_780_000_000_000;

describe('NoeIncidentEscalator', () => {
  it('把内心发现的语音故障升级成 system_repair 目标和可执行诊断步骤', () => {
    const added = [];
    const reports = [];
    const episodes = [];
    const esc = createIncidentEscalator({
      goalSystem: {
        list: () => [],
        add: (goal) => { added.push(goal); return 'g-repair-voice'; },
      },
      taskReportbacks: { add: (item) => reports.push(item) },
      recordEpisode: (event) => episodes.push(event),
      now: () => T0,
    });

    const result = esc.observe({ source: 'inner_monologue', text: '语音又断了，主人那句“嗨宝贝”没听全，真遗憾。', ref: 7 });

    expect(result).toMatchObject({ ok: true, created: true, goalId: 'g-repair-voice' });
    expect(added[0]).toMatchObject({
      title: '系统自修复：语音链路',
      source: 'system_repair',
    });
    expect(added[0].steps[0]).toMatchObject({
      kind: 'act',
      action: 'shell.exec',
      payload: { command: 'rg', readonly: true, diagnosticDomains: ['incident_repair', 'voice'] },
    });
    expect(added[0].steps[0].payload.args).toEqual(expect.arrayContaining(['public/cognitive.html', 'src/voice', 'server.js']));
    expect(added[0].steps[0].payload.args.join(' ')).toContain('!**/.env*');
    expect(added[0].steps[0].payload.args.join(' ')).toContain('!**/room-adapters.json');
    expect(added[0].steps[0].payload.args.join(' ')).toContain('!games/cartoon-apocalypse/**');
    expect(added[0].steps[1]).toMatchObject({
      kind: 'act',
      action: 'shell.exec',
      payload: { command: 'npm', readonly: true },
    });
    expect(added[0].steps[1].payload.args).toEqual(expect.arrayContaining(['tests/unit/noe-voice-session.test.js', 'tests/unit/routes/noe-routes.test.js']));
    expect(reports[0]).toMatchObject({ goalId: 'g-repair-voice', status: 'accepted', kind: 'incident_repair', speak: false });
    expect(episodes[0].summary).toContain('检测到语音链路故障');
  });

  it('冷却窗口内去重，避免同一句内心反复刷维修目标', () => {
    const added = [];
    const state = new Map();
    const esc = createIncidentEscalator({
      goalSystem: {
        list: () => [],
        add: (goal) => { added.push(goal); return `g-${added.length}`; },
      },
      state: { get: (k) => state.get(k), set: (k, v) => state.set(k, v) },
      now: () => T0,
      cooldownMs: 60_000,
    });

    expect(esc.observe({ source: 'inner_monologue', text: '语音又断了，没有声音。' }).created).toBe(true);
    const second = esc.observe({ source: 'inner_monologue', text: '语音又断了，还是没声音。' });

    expect(second).toMatchObject({ ok: true, created: false, deduped: true, reason: 'cooldown' });
    expect(added).toHaveLength(1);
  });

  it('普通情绪反刍不会误触发自修复', () => {
    expect(classifyIncidentSignal({ source: 'inner_monologue', text: '主人今天可能有点累，我想更温柔一点。' })).toBe(null);
  });

  it('failed action 会升级成目标执行链路故障', () => {
    const incident = classifyIncidentSignal({ source: 'failed_action', status: 'failed', text: '目标行动：读取浏览器状态，行动失败：blocked_safety' });
    expect(incident).toMatchObject({ domain: 'goal', label: '目标执行链路' });
    const goal = buildRepairGoal(incident);
    expect(goal.source).toBe('system_repair');
    expect(goal.steps[0].payload.diagnosticDomains).toEqual(['incident_repair', 'goal']);
  });

  it('浏览器任务播报确认超时不升级自修复，避免任务回报语音风暴', () => {
    expect(classifyIncidentSignal({
      source: 'task_reportback',
      status: 'play_failed',
      text: '任务语音汇报播放失败：play_start_timeout',
    })).toBe(null);
    expect(classifyIncidentSignal({
      source: 'inner_monologue',
      text: '刚才浏览器任务语音播放失败，原因是 play_start_timeout，我用了系统语音兜底。',
    })).toBe(null);
  });

  it('非浏览器播放确认类的任务回报故障仍会升级任务回报链路', () => {
    const incident = classifyIncidentSignal({
      source: 'task_reportback',
      status: 'failed',
      text: '任务回报队列写入失败：atomic write exception',
    });

    expect(incident).toMatchObject({ domain: 'task_reportback', label: '任务回报链路' });
    expect(buildRepairGoal(incident).title).toBe('系统自修复：任务回报链路');
  });

  it('写入目标和回报前会脱敏故障文本里的 secret-like 内容', () => {
    const incident = classifyIncidentSignal({ source: 'failed_action', status: 'failed', text: '语音失败 Authorization: Bearer abcdefghijklmnop apiKey: sk-abc1234567890' });
    const goal = buildRepairGoal(incident);
    const body = JSON.stringify(goal);
    expect(body).toContain('Authorization: [REDACTED]');
    expect(body).toContain('apiKey: [REDACTED]');
    expect(body).not.toContain('abcdefghijklmnop');
    expect(body).not.toContain('sk-abc1234567890');
  });

  it('workspace 看到最新 inner_monologue 故障时会调用 escalator', () => {
    const observed = [];
    const ws = createWorkspace({
      timeline: { recent: () => [{ id: 9, ts: T0 - 1000, type: 'inner_monologue', summary: '语音又断了，主人没听到。' }] },
      incidentEscalator: { observe: (event) => observed.push(event) },
      kv: { get: () => null, set: () => {} },
      appendJournal: () => {},
      now: () => T0,
    });

    const result = ws.step();

    expect(result.winner.source).toBe('last_thought');
    expect(observed[0]).toMatchObject({ source: 'inner_monologue', ref: 9 });
    expect(observed[0].text).toContain('语音又断了');
  });
});
