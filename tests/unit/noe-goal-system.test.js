import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initSqlite, close } from '../../src/storage/SqliteStore.js';
import { createGoalSystem } from '../../src/cognition/NoeGoalSystem.js';

let dir;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-goals-'));
  initSqlite(join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_780_000_000_000;
const DAY = 86_400_000;

describe('NoeGoalSystem 目标系统', () => {
  it('立项 + 同名未关目标去重 + 步骤裁剪', () => {
    const gs = createGoalSystem({ now: () => T0 });
    const id = gs.add({ title: '学会用期望账本', source: 'self', steps: ['读文档', '试一条预测'] });
    expect(id).toBeTruthy();
    expect(gs.add({ title: '学会用期望账本' })).toBe(null); // 去重
    const g = gs.get(id);
    expect(g.plan.length).toBe(2);
    expect(g.plan[0].status).toBe('open');
  });

  it('仲裁：owner 目标压过自生目标；active≤2；两周不动的自生目标自动 paused', () => {
    let t = T0;
    const gs = createGoalSystem({ now: () => t, maxActive: 2 });
    gs.add({ title: '自生甲', source: 'self', steps: ['a'] });
    gs.add({ title: '自生乙', source: 'surprise', steps: ['a'] });
    const owner = gs.add({ title: '主人交办的事', source: 'owner', steps: ['a'] });
    gs.arbitrate(t);
    const active = gs.list({ status: 'active' });
    expect(active.length).toBe(2);
    expect(active[0].id).toBe(owner); // owner 永远第一
    expect(gs.list({ status: 'open' }).length).toBe(1);

    // 自生目标 15 天不动 → paused；owner 目标不受 stale 影响
    t += 15 * DAY;
    gs.arbitrate(t);
    expect(gs.get(owner).status).toBe('active');
    expect(gs.list({ status: 'paused' }).every((g) => g.source !== 'owner')).toBe(true);
  });

  it('仲裁：system_repair 自修复目标压过普通自主学习，且不受 backlog 上限挤掉', () => {
    const gs = createGoalSystem({ now: () => T0, maxActive: 2, maxBacklog: 1 });
    expect(gs.add({ title: '普通反思积压', source: 'reflection', steps: ['先想想'] })).toBeTruthy();
    const repairId = gs.add({ title: '系统自修复：语音链路', source: 'system_repair', steps: ['只读诊断'] });
    expect(repairId).toBeTruthy();

    gs.arbitrate(T0);

    const active = gs.list({ status: 'active' });
    expect(active[0].id).toBe(repairId);
    expect(active[0].source).toBe('system_repair');
  });

  it('好奇 surprise 目标不受普通 backlog 上限挤掉', () => {
    const gs = createGoalSystem({ now: () => T0, maxBacklog: 1 });
    expect(gs.add({ title: '普通反思积压', source: 'reflection', steps: ['先想想'] })).toBeTruthy();
    expect(gs.add({ title: '第二个普通反思', source: 'reflection', steps: ['再想想'] })).toBe(null);

    const curiosityId = gs.harvestSurprise({ claim: '真实行动失败应该生成研究目标', surprise: 3, origin: 'action_failure' });

    expect(curiosityId).toBeTruthy();
    expect(gs.get(curiosityId).source).toBe('surprise');
  });

  it('nextStep：返回最高优先活跃目标的第一个未完成步骤；无计划目标自动长出保守计划', () => {
    const gs = createGoalSystem({ now: () => T0 });
    const plannedId = gs.add({ title: '有计划的', source: 'owner', steps: ['第一步', '第二步'] });
    gs.arbitrate(T0);
    const s = gs.nextStep();
    expect(s.step).toBe('第一步');
    expect(s.stepIndex).toBe(0);

    gs.setStatus(plannedId, 'paused');
    const noPlanId = gs.add({ title: '没计划的目标', source: 'owner' });
    gs.setStatus(noPlanId, 'active');
    const s2 = gs.nextStep();
    const g2 = gs.get(noPlanId);
    expect(s2.goalId).toBe(noPlanId);
    expect(s2.stepIndex).toBe(0);
    expect(s2.step).toContain('成功判据');
    expect(g2.plan).toHaveLength(4);
    expect(g2.plan.every((step) => step.kind === 'think')).toBe(true);
    expect(gs.checkpoints({ goalId: noPlanId }).some((cp) => cp.phase === 'plan_created' && cp.payload?.newStepCount === 4)).toBe(true);
  });

  it('nextStep：自主/AGI 空目标会自动拆成 research + browser + shell + note 行动链', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true });
    const id = gs.add({
      title: '我希望你能成为一个能自我思考，会主动学习，自己优化，自我迭代的AGi。',
      source: 'owner',
      why: '主人要求 Noe 主动学习、上网、动手改进自己。',
    });
    gs.setStatus(id, 'active');

    const first = gs.nextStep();
    const g = gs.get(id);

    expect(first.goalId).toBe(id);
    expect(first.stepIndex).toBe(0);
    expect(first.kind).toBe('research');
    expect(first.step).toContain('上网搜索并学习');
    expect(g.plan.map((s) => s.kind)).toEqual(['research', 'act', 'act', 'act', 'act', 'act', 'act', 'think']);
    expect(g.plan.some((s) => s.action === 'macos.app.activate')).toBe(true);
    expect(g.plan.some((s) => s.action === 'browser.open_url')).toBe(true);
    expect(g.plan.some((s) => s.action === 'browser.state_probe')).toBe(true);
    expect(g.plan.some((s) => s.action === 'browser.observe_page')).toBe(true);
    const observeStep = g.plan.find((s) => s.action === 'browser.observe_page');
    expect(observeStep.payload.url).toMatch(/^https:\/\//);
    expect(observeStep.payload.expectedHosts).toEqual([observeStep.payload.expectedHost]);
    expect(g.plan.some((s) => s.action === 'shell.exec')).toBe(true);
    expect(g.plan.some((s) => s.action === 'noe.note.write')).toBe(true);
    expect(gs.checkpoints({ goalId: id }).some((cp) => cp.phase === 'plan_created' && cp.payload?.newStepCount === 8)).toBe(true);
  });

  it('nextStep：普通反思空目标不会因为 why 里有“自己立的项”误长出电脑行动链', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true });
    const id = gs.add({
      title: '现在立刻拿出一张纸，按下手机上的 10 分钟倒计时。',
      source: 'reflection',
      why: '深思「推进目标」时自己立的项',
    });
    gs.setStatus(id, 'active');

    const first = gs.nextStep();
    const g = gs.get(id);

    expect(first.goalId).toBe(id);
    expect(first.stepIndex).toBe(0);
    expect(first.kind).toBe('think');
    expect(first.step).toContain('成功判据');
    expect(g.plan).toHaveLength(4);
    expect(g.plan.every((s) => s.kind === 'think')).toBe(true);
    expect(g.plan.some((s) => s.kind === 'act' || s.kind === 'research')).toBe(false);
  });

  it('P1[1]（修三方审查 serious）：owner 交办的普通学习目标(title 含「学习」)不被强加上网 act 链，走 generic think', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true });
    const id = gs.add({ title: '学习英语', source: 'owner', why: '主人在透视页直接交办' });
    gs.setStatus(id, 'active');
    const first = gs.nextStep();
    const g = gs.get(id);
    expect(first.kind).toBe('think'); // owner 普通交办不走 autonomy 上网链
    expect(g.plan.every((s) => s.kind === 'think')).toBe(true);
    expect(g.plan.some((s) => s.kind === 'research' || (s.step || '').includes('上网搜索'))).toBe(false); // 不发起无关联网研究
  });

  it('P1[1]：owner 明确授权自主(why 含授权+自主上网)仍走 autonomy 上网链(逃生通道保留，零回归)', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true });
    const id = gs.add({ title: '提升能力', source: 'owner', why: '主人授权你自主上网学习改进自己' });
    gs.setStatus(id, 'active');
    const first = gs.nextStep();
    expect(first.step).toContain('上网搜索并学习'); // owner 明确授权 → 走 autonomy
  });

  it('recordStepResult：笔记落步骤、done 标完成、全完成→目标 done、-1 长出新计划', () => {
    const gs = createGoalSystem({ now: () => T0 });
    const id = gs.add({ title: '两步目标', source: 'owner', steps: ['一', '二'] });
    expect(gs.recordStepResult(id, 0, { note: '想清楚了', done: true }).ok).toBe(true);
    expect(gs.get(id).plan[0].status).toBe('done');
    expect(gs.get(id).status).toBe('open'); // 还有第二步
    const fin = gs.recordStepResult(id, 1, { done: true });
    expect(gs.get(id).status).toBe('done'); // 全完成
    expect(fin.goalDone).toBe(true); // M7 技能蒸馏挂点信号
    expect(fin.goal.title).toBe('两步目标');

    const empty = gs.add({ title: '空计划目标' });
    gs.recordStepResult(empty, -1, { newSteps: ['先查资料', '再动手'] });
    expect(gs.get(empty).plan.map((s) => s.step)).toEqual(['先查资料', '再动手']);
    expect(gs.recordStepResult(id, 99, {}).ok).toBe(false); // 越界
  });

  it('nextStep 会带上已完成步骤笔记，给后续步骤使用真实进展', () => {
    const gs = createGoalSystem({ now: () => T0 });
    const id = gs.add({ title: '本地排查', source: 'owner', steps: ['只读检查', '归纳原因'] });
    gs.recordStepResult(id, 0, { note: 'exit=0；stdout:VoiceSession.js 命中 tts fallback', done: true });
    gs.arbitrate(T0);
    const s = gs.nextStep();
    expect(s.step).toBe('归纳原因');
    expect(s.priorNotes[0]).toContain('VoiceSession.js');
  });

  it('step 状态机：awaiting_approval 阻塞重复推进，blocked/failed 不伪装完成并允许后续归因步', () => {
    const gs = createGoalSystem({ now: () => T0 });
    const waiting = gs.add({ title: '等审批目标', source: 'owner', steps: ['申请动作', '审批后再做'] });
    gs.recordStepResult(waiting, 0, { status: 'awaiting_approval', note: 'ap-1' });
    gs.arbitrate(T0);
    expect(gs.nextStep()).toBe(null);
    expect(gs.get(waiting).plan[0].status).toBe('awaiting_approval');
    expect(gs.get(waiting).status).not.toBe('done');

    const blocked = gs.add({ title: '阻断后归因', source: 'owner', steps: ['只读诊断', '归因说明'] });
    gs.recordStepResult(blocked, 0, { status: 'blocked', note: 'blocked_safety' });
    gs.setStatus(waiting, 'paused');
    gs.arbitrate(T0);
    const s = gs.nextStep();
    expect(s.goalId).toBe(blocked);
    expect(s.step).toBe('归因说明');
    expect(gs.get(blocked).plan[0].status).toBe('blocked');
  });

  it('doing 超过阈值会恢复为 recovered，避免永久卡住且不自动重放', () => {
    let t = T0;
    const gs = createGoalSystem({ now: () => t, staleStepMs: 1000 });
    const id = gs.add({ title: '卡住的目标', source: 'owner', steps: ['后台诊断', '归因'] });
    gs.recordStepResult(id, 0, { doing: true, note: '行动执行中' });
    t += 2000;
    gs.arbitrate(t);
    const g = gs.get(id);
    expect(g.plan[0].status).toBe('recovered');
    expect(g.plan[0].note).toContain('不会自动重放');
    expect(gs.nextStep().step).toBe('归因');
  });

  it('所有步骤进入 done/recovered 终态后目标收成 done', () => {
    const gs = createGoalSystem({ now: () => T0 });
    const id = gs.add({ title: '可恢复闭环', source: 'owner', steps: ['丢失的后台步骤', '收口'] });
    gs.recordStepResult(id, 0, { status: 'recovered', note: '后台 promise 丢失，已释放' });
    const res = gs.recordStepResult(id, 1, { done: true, note: '自动收口' });

    expect(res.goalDone).toBe(true);
    expect(gs.get(id).status).toBe('done');
  });

  it('仲裁会收拾历史遗留：步骤已终态但目标仍 active 的记录', () => {
    const gs = createGoalSystem({ now: () => T0 });
    const id = gs.add({ title: '历史遗留终态', source: 'owner', steps: ['丢失的后台步骤', '收口'] });
    gs.recordStepResult(id, 0, { status: 'recovered', note: '后台 promise 丢失，已释放' });
    gs.recordStepResult(id, 1, { done: true, note: '自动收口' });
    gs.setStatus(id, 'active');

    gs.arbitrate(T0 + 1000);

    expect(gs.get(id).status).toBe('done');
  });

  it('research/act doing 使用更短恢复窗，避免后台 promise 丢失后长时间堵住自主行动', () => {
    let t = T0;
    const gs = createGoalSystem({ now: () => t, allowActKind: true, staleStepMs: 6 * 3600_000, staleResearchStepMs: 1000, staleActStepMs: 2000 });
    const researchId = gs.add({ title: '研究卡住', source: 'owner', steps: [{ step: '上网研究', kind: 'research' }, '继续行动'] });
    const actId = gs.add({ title: '行动卡住', source: 'owner', steps: [{ step: '打开浏览器', kind: 'act', action: 'browser.open_url' }, '复盘'] });
    gs.recordStepResult(researchId, 0, { doing: true, note: '研究执行中' });
    gs.recordStepResult(actId, 0, { doing: true, note: '行动执行中' });
    t += 1500;
    gs.arbitrate(t);
    expect(gs.get(researchId).plan[0].status).toBe('recovered');
    expect(gs.get(actId).plan[0].status).toBe('doing');
    t += 1000;
    gs.arbitrate(t);
    expect(gs.get(actId).plan[0].status).toBe('recovered');
  });

  it('默认 research doing 约 90 秒后释放，避免自主学习长期挡住后续电脑动作', () => {
    let t = T0;
    const gs = createGoalSystem({ now: () => t, allowActKind: true });
    const id = gs.add({ title: '自主学习研究卡住', source: 'self_learning', steps: [{ step: '上网研究', kind: 'research' }, { step: '切浏览器', kind: 'act', action: 'macos.app.activate' }] });
    gs.recordStepResult(id, 0, { doing: true, note: '研究执行中' });
    t += 91_000;

    gs.arbitrate(t);

    expect(gs.get(id).plan[0].status).toBe('recovered');
    expect(gs.nextStep()).toMatchObject({ goalId: id, stepIndex: 1, actionSpec: { action: 'macos.app.activate' } });
  });

  it('browser.observe_page host mismatch blocked 会继承前序 URL 并最多自动重试两次', () => {
    let t = T0;
    const gs = createGoalSystem({ now: () => t, allowActKind: true });
    const id = gs.add({
      title: '浏览器观察自恢复',
      source: 'owner',
      steps: [
        { step: '打开目标页', kind: 'act', action: 'browser.open_url', payload: { url: 'https://example.test/docs' } },
        { step: '观察目标页', kind: 'act', action: 'browser.observe_page', payload: { browserApp: 'Google Chrome', expectedHost: 'example.test' } },
      ],
    });
    gs.setStatus(id, 'active');
    gs.recordStepResult(id, 0, { done: true, note: '已打开' });
    gs.recordStepResult(id, 1, { status: 'blocked', note: '行动未放行：browser_dom_host_mismatch' });
    t += 1000;

    gs.arbitrate(t);
    const g = gs.get(id);

    expect(g.plan[1].status).toBe('open');
    expect(g.plan[1].retryCount).toBe(1);
    expect(g.plan[1].payload.url).toBe('https://example.test/docs');
    expect(g.plan[1].payload.expectedHosts).toEqual(['example.test']);
    expect(gs.nextStep()).toMatchObject({ goalId: id, stepIndex: 1, actionSpec: { action: 'browser.observe_page' } });

    gs.recordStepResult(id, 1, { status: 'blocked', note: '行动未放行：browser_dom_host_mismatch' });
    t += 1000;
    gs.arbitrate(t);
    expect(gs.get(id).plan[1].status).toBe('open');
    expect(gs.get(id).plan[1].retryCount).toBe(2);

    gs.recordStepResult(id, 1, { status: 'blocked', note: '行动未放行：browser_dom_host_mismatch' });
    t += 1000;
    gs.arbitrate(t);
    expect(gs.get(id).plan[1].status).toBe('recovered');
    expect(gs.get(id).plan[1].note).toContain('没有伪装为完成');
  });

  it('好奇回路：惊奇 ≥2 bit 才立研究目标，自带三步计划', () => {
    const gs = createGoalSystem({ now: () => T0 });
    expect(gs.harvestSurprise({ claim: '小落空', surprise: 0.7 })).toBe(null);
    const id = gs.harvestSurprise({ claim: '主人今晚会重启面板', surprise: 3.3 });
    expect(id).toBeTruthy();
    const g = gs.get(id);
    expect(g.source).toBe('surprise');
    expect(g.title).toContain('搞明白为什么没料到');
    expect(g.plan.length).toBe(3);
    expect(g.why).toContain('bit 惊奇');
  });

  it('自主学习循环：显式开启后会周期性生成 research + 只读 act 目标，且不重复刷屏', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true, autonomousLearning: true, learningIntervalMs: 1000 });
    const id = gs.maybeSeedAutonomousLearning(T0);
    expect(id).toBeTruthy();
    const g = gs.get(id);
    expect(g.source).toBe('self_learning');
    expect(g.title).toContain('自主学习');
    expect(g.plan.map((s) => s.kind)).toEqual(['research', 'act', 'act', 'act', 'act', 'act', 'act', 'act', 'think']);
    expect(g.plan[1].action).toBe('macos.app.activate');
    expect(g.plan[1].payload.app).toBe('Google Chrome');
    expect(g.plan[2].action).toBe('browser.open_url');
    expect(g.plan[2].payload.url).toMatch(/^https:\/\//);
    expect(g.plan[3].action).toBe('browser.state_probe');
    expect(g.plan[4].action).toBe('browser.observe_page');
    expect(g.plan[4].payload.url).toMatch(/^https:\/\//);
    expect(g.plan[4].payload.expectedHosts).toEqual([g.plan[4].payload.expectedHost]);
    expect(g.plan[4].payload.actions).toEqual([{ type: 'read_title' }, { type: 'read_body' }]); // L3：真读正文不只读标题（治浏览器空转）
    expect(g.plan[5].action).toBe('visual.action.plan');
    expect(g.plan[6].action).toBe('shell.exec');
    expect(g.plan[6].payload.readonly).toBe(true);
    expect(g.plan[6].payload.args).toContain('!**/.env*');
    expect(g.plan[7].action).toBe('noe.note.write');
    expect(g.plan[7].payload.path).toBe('output/noe-autonomy/learning.md');
    expect(gs.maybeSeedAutonomousLearning(T0 + 500)).toBe(null);
    for (let i = 0; i < g.plan.length; i += 1) gs.recordStepResult(id, i, { done: true });
    expect(gs.maybeSeedAutonomousLearning(T0 + 1500)).toBeTruthy();
  });

  it('连续自主学习：上一轮完成后不再被创建时间间隔卡住，立即滚到下一主题', () => {
    const gs = createGoalSystem({
      now: () => T0,
      allowActKind: true,
      autonomousLearning: true,
      continuousLearning: true,
      learningIntervalMs: 60_000,
    });
    const firstId = gs.maybeSeedAutonomousLearning(T0);
    expect(firstId).toBeTruthy();
    const first = gs.get(firstId);
    for (let i = 0; i < first.plan.length; i += 1) gs.recordStepResult(firstId, i, { done: true });

    const secondId = gs.maybeSeedAutonomousLearning(T0 + 500);
    expect(secondId).toBeTruthy();
    expect(gs.get(secondId).title).not.toBe(first.title);
  });

  it('连续自主学习：第六个轮换主题是 capability_discovery 工具能力发现', () => {
    const gs = createGoalSystem({
      now: () => T0,
      allowActKind: true,
      autonomousLearning: true,
      continuousLearning: true,
      learningIntervalMs: 60_000,
    });
    let id = null;
    for (let round = 0; round < 6; round += 1) {
      id = gs.maybeSeedAutonomousLearning(T0 + round * 1000);
      expect(id).toBeTruthy();
      if (round < 5) {
        const goal = gs.get(id);
        for (let i = 0; i < goal.plan.length; i += 1) gs.recordStepResult(id, i, { done: true });
      }
    }

    const sixth = gs.get(id);
    expect(sixth.title).toContain('capability_discovery');
    expect(sixth.plan[0].step).toContain('capability discovery');
    expect(sixth.plan[6].payload.args).toContain('capability_discovery|SkillStore|ToolMarketplace|ActionCatalog|NoeToolRouter|MCP|mcp|plugin|adapter|tool manifest|NoeFreedomAdapters');
    expect(sixth.plan[6].payload.args).toContain('src/skills');
    expect(sixth.plan[6].payload.args).toContain('src/mcp');
  });

  it('自主学习循环不被普通反思 backlog 挤掉', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true, autonomousLearning: true, learningIntervalMs: 1000, maxBacklog: 1 });
    expect(gs.add({ title: '普通反思积压', source: 'reflection', steps: ['先想想'] })).toBeTruthy();
    const id = gs.maybeSeedAutonomousLearning(T0);
    expect(id).toBeTruthy();
    expect(gs.get(id).source).toBe('self_learning');
  });

  it('自主学习循环默认关闭，保持旧目标系统零自发种子行为', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true });
    expect(gs.maybeSeedAutonomousLearning(T0)).toBe(null);
    expect(gs.list()).toHaveLength(0);
  });

  it('stats 分组统计', () => {
    const gs = createGoalSystem({ now: () => T0 });
    gs.add({ title: 'a' });
    const b = gs.add({ title: 'b' });
    gs.setStatus(b, 'done');
    const st = gs.stats();
    expect(st.open).toBe(1);
    expect(st.done).toBe(1);
  });
});

// 行动步 kind:'act'（意识工程 Phase3，2026-06-11）：显式声明才认、默认关回落 think、规格透传。
describe('NoeGoalSystem 行动步 act', () => {
  it('allowActKind=true：显式 {kind:act} 带规格入计划，nextStep 透传 actionSpec', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true });
    const id = gs.add({
      title: '演武：目标长手',
      source: 'owner',
      steps: [{ step: '把演武结果写进笔记', kind: 'act', action: 'noe.note.write', payload: { path: 'demo.md' } }],
    });
    const g = gs.get(id);
    expect(g.plan[0].kind).toBe('act');
    expect(g.plan[0].action).toBe('noe.note.write');
    expect(g.plan[0].payload).toEqual({ path: 'demo.md' });
    gs.arbitrate(T0);
    const step = gs.nextStep();
    expect(step.kind).toBe('act');
    expect(step.actionSpec).toEqual({ action: 'noe.note.write', payload: { path: 'demo.md' } });
  });

  it('默认关（allowActKind=false）：act 回落 think 且不存规格——行为零差异', () => {
    const gs = createGoalSystem({ now: () => T0 });
    const id = gs.add({ title: '默认关', source: 'owner', steps: [{ step: '试图动手', kind: 'act', action: 'x.y' }] });
    const g = gs.get(id);
    expect(g.plan[0].kind).toBe('think');
    expect(g.plan[0].action).toBeUndefined();
  });

  it('文本步骤永不推断成 act（自然语言不该意外变成执行）', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true });
    const id = gs.add({ title: '文本安全', source: 'owner', steps: ['执行删除旧文件的动作', '跑一遍命令行脚本'] });
    const g = gs.get(id);
    expect(g.plan.every((s) => s.kind === 'think')).toBe(true);
  });

  it('act 步无 action 规格也合法（装配方给默认动作名）', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true });
    gs.add({ title: '无规格', source: 'owner', steps: [{ step: '做一次演练', kind: 'act' }] });
    gs.arbitrate(T0);
    const step = gs.nextStep();
    expect(step.kind).toBe('act');
    expect(step.actionSpec).toEqual({ action: null, payload: null });
  });
});

// 深思长计划产 act 步（C1 教学通路，2026-06-11）：newSteps 对象声明同 add() 规则。
describe('NoeGoalSystem newSteps 长出 act 步', () => {
  it('allowActKind=true：newSteps 对象 act 入计划带动作名；文本仍永不推断', () => {
    const gs = createGoalSystem({ now: () => T0, allowActKind: true });
    const id = gs.add({ title: '无计划目标', source: 'owner' });
    gs.recordStepResult(id, -1, { newSteps: [
      { step: '把结论写成笔记', kind: 'act', action: 'noe.note.write' },
      { step: '在搜索框输入关键词', kind: 'act', action: 'browser.type', payload: { role: 'search', hints: ['Search'], text: 'Noe autonomy' } },
      '继续执行调研',
    ] });
    const g = gs.get(id);
    expect(g.plan[0].kind).toBe('act');
    expect(g.plan[0].action).toBe('noe.note.write');
    expect(g.plan[1].kind).toBe('act');
    expect(g.plan[1].action).toBe('browser.type');
    expect(g.plan[1].payload).toEqual({ role: 'search', hints: ['Search'], text: 'Noe autonomy' });
    gs.arbitrate(T0);
    const first = gs.nextStep();
    gs.recordStepResult(id, first.stepIndex, { done: true });
    const second = gs.nextStep();
    expect(second.actionSpec).toEqual({ action: 'browser.type', payload: { role: 'search', hints: ['Search'], text: 'Noe autonomy' } });
    expect(g.plan[2].kind).toBe('research'); // 文本"调研"推断 research，永不 act
  });

  it('默认关：newSteps 对象 act 回落 think', () => {
    const gs = createGoalSystem({ now: () => T0 });
    const id = gs.add({ title: '默认关2', source: 'owner' });
    gs.recordStepResult(id, -1, { newSteps: [{ step: '想动手', kind: 'act', action: 'x.y' }] });
    expect(gs.get(id).plan[0].kind).toBe('think');
  });
});

describe('NoeGoalSystem 每日研究预算闸（阶段C 防 self_learning 失控）', () => {
  it('24h 内立满 NOE_LEARNING_DAILY_BUDGET 即停，窗口滚动 25h 后放行', () => {
    process.env.NOE_LEARNING_DAILY_BUDGET = '2';
    try {
      let t = 1_700_000_000_000;
      const gs = createGoalSystem({ now: () => t, autonomousLearning: true, continuousLearning: true });
      const id1 = gs.maybeSeedAutonomousLearning(t); expect(id1).toBeTruthy();
      gs.setStatus(id1, 'done'); t += 1000;
      const id2 = gs.maybeSeedAutonomousLearning(t); expect(id2).toBeTruthy();
      gs.setStatus(id2, 'done'); t += 1000;
      expect(gs.maybeSeedAutonomousLearning(t)).toBeNull(); // 24h 内已 2 个 self_learning ≥ budget 2 → 拦
      t += 25 * 3600 * 1000;
      expect(gs.maybeSeedAutonomousLearning(t)).toBeTruthy(); // 窗口滚动，放行
    } finally { delete process.env.NOE_LEARNING_DAILY_BUDGET; }
  });

  it('NOE_LEARNING_DAILY_BUDGET 未设(0) → 不限（零回归）', () => {
    let t = 1_700_000_000_000;
    const gs = createGoalSystem({ now: () => t, autonomousLearning: true, continuousLearning: true });
    const id1 = gs.maybeSeedAutonomousLearning(t); expect(id1).toBeTruthy();
    gs.setStatus(id1, 'done'); t += 1000;
    const id2 = gs.maybeSeedAutonomousLearning(t); expect(id2).toBeTruthy();
    gs.setStatus(id2, 'done'); t += 1000;
    expect(gs.maybeSeedAutonomousLearning(t)).toBeTruthy(); // 无预算闸，第 3 个继续立
  });
});

describe('NoeGoalSystem 动态 topic 立项（Codex P0 钉死：无 localPaths 不崩 + recordVisit 延后）', () => {
  it('动态 topic（{title,url,query} 无 localPaths）能立 self_learning goal、不 TypeError', () => {
    process.env.NOE_DYNAMIC_TOPICS = '1';
    try {
      const dynTopic = { title: 'AutoGPT', url: 'https://github.com/search?q=AutoGPT', query: 'AutoGPT explained' };
      const gs = createGoalSystem({ now: () => T0, autonomousLearning: true, topicCurator: { getNextTopic: () => ({ topic: dynTopic }), recordVisit: () => {} }, discoverDynamicTopics: () => [] });
      const gid = gs.maybeSeedAutonomousLearning(T0);
      expect(gid).toBeTruthy(); // 不因 `...topic.localPaths`(undefined) TypeError 静默失败
      expect(gs.get(gid).title).toContain('AutoGPT');
    } finally { delete process.env.NOE_DYNAMIC_TOPICS; }
  });

  it('recordVisit 延后到 add 成功后（不污染访问账本）', () => {
    process.env.NOE_DYNAMIC_TOPICS = '1';
    try {
      const visited = [];
      const dynTopic = { title: 'LangGraph', url: 'https://github.com/search?q=LangGraph', query: 'LangGraph durable' };
      const gs = createGoalSystem({ now: () => T0, autonomousLearning: true, topicCurator: { getNextTopic: () => ({ topic: dynTopic }), recordVisit: (tp) => visited.push(tp.title) }, discoverDynamicTopics: () => [] });
      const gid = gs.maybeSeedAutonomousLearning(T0);
      expect(gid).toBeTruthy();
      expect(visited).toEqual(['LangGraph']); // add 成功后才 recordVisit
    } finally { delete process.env.NOE_DYNAMIC_TOPICS; }
  });
});
