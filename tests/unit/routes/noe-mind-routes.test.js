import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { registerNoeMindRoutes } from '../../../src/server/routes/noeMind.js';
import { buildSelfEvolutionSlo } from '../../../src/loop/NoeSelfEvolutionSlo.js';
import { close, initSqlite } from '../../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryWriteGate } from '../../../src/memory/NoeMemoryWriteGate.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  return { app, routes };
}
function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}
const call = (routes, method, path, req = {}) => {
  const r = routes.find((x) => x.method === method && x.path === path);
  const res = makeRes();
  r.handlers[r.handlers.length - 1]({ body: {}, query: {}, ...req }, res);
  return res;
};

describe('内心透视页路由', () => {
  it('全部端点注册且 owner-token 把门', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, {});
    expect(routes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'get /api/noe/mind/affect',
      'get /api/noe/mind/awakening-signals',
      'get /api/noe/mind/calibration',
      'get /api/noe/mind/curiosity-funnel',
      'get /api/noe/mind/expectations',
      'get /api/noe/mind/goal-candidates',
      'get /api/noe/mind/goals',
      'get /api/noe/mind/integration/history',
      'get /api/noe/mind/journal',
      'get /api/noe/mind/memory',
      'get /api/noe/mind/memory/candidates/:id/replay',
      'get /api/noe/mind/memory/export',
      'get /api/noe/mind/memory/quarantine',
      'get /api/noe/mind/memory/search',
      'get /api/noe/mind/model-health',
      'get /api/noe/mind/overview',
      'get /api/noe/mind/proof',
      'get /api/noe/mind/self-evolution',
      'get /api/noe/mind/thoughts',
      'get /api/noe/mind/ticks',
      'get /api/noe/mind/vitals',
      'get /api/noe/mind/wall-signals',
      'post /api/noe/mind/expectations/resolve',
      'post /api/noe/mind/goals',
      'post /api/noe/mind/goals/status',
      'post /api/noe/mind/memory/delete',
      'post /api/noe/mind/memory/edit',
      'post /api/noe/mind/memory/hide',
      'post /api/noe/mind/memory/unhide',
      'post /api/noe/mind/tick',
    ]);
    expect(routes.every((r) => r.handlers[0] === requireOwnerToken)).toBe(true);
  });

  it('P2 看板：未通电 fail-open（calibration enabled:false / integration 空历史）', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { kv: { get: () => null } }); // 无 ledger
    expect(call(routes, 'get', '/api/noe/mind/calibration').payload.enabled).toBe(false);
    const ih = call(routes, 'get', '/api/noe/mind/integration/history');
    expect(ih.payload).toMatchObject({ ok: true, enabled: true, history: [] });
  });

  it('P2 calibration：注入 ledger.calibration 透传 Brier/ECE 曲线', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, {
      expectationLedger: { calibration: () => ({ n: 5, brier: 0.1, ece: 0.05, mce: 0.2, bins: [{ lo: 0, hi: 0.1, count: 5, avgPredicted: 0.05, observedRate: 0.04, gap: 0.01 }] }) },
    });
    const r = call(routes, 'get', '/api/noe/mind/calibration');
    expect(r.payload).toMatchObject({ ok: true, enabled: true, n: 5, brier: 0.1, ece: 0.05 });
  });

  it('P2 integration/history：注入 kv 历史 → 透传趋势 + 最新读数', () => {
    const { app, routes } = makeApp();
    const hist = [{ ts: 1, integration: 0.4 }, { ts: 2, integration: 0.5 }];
    registerNoeMindRoutes(app, {
      kv: { get: (k) => (k === 'noe.integration.history.v1' ? hist : (k === 'noe.integration.reading' ? { integration: 0.5, label: '中度整合' } : null)) },
    });
    const r = call(routes, 'get', '/api/noe/mind/integration/history');
    expect(r.payload.history).toHaveLength(2);
    expect(r.payload.latest).toMatchObject({ integration: 0.5 });
  });

  it('P2-F1 wall-signals：撞墙检测 endpoint（guardEnabled 标回滚执行态，默认 OFF）', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, {
      kv: { get: () => null },
      goalSystem: { stats: () => ({ open: 0, active: 0 }), list: () => [], get: () => null, setStatus: () => false, add: () => null, arbitrate: () => {} },
    });
    const r = call(routes, 'get', '/api/noe/mind/wall-signals');
    expect(r.payload.ok).toBe(true);
    expect(typeof r.payload.hit).toBe('boolean');
    expect(r.payload.guardEnabled).toBe(false);
    expect(r.payload.inputs.activeGoals).toBe(0); // goalSystem 在场
  });

  it('P2-R2 wall-signals：goalSystem 不在场 → activeGoals=null（不报幻象 idle_rumination）', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { kv: { get: () => null } }); // 无 goalSystem
    const r = call(routes, 'get', '/api/noe/mind/wall-signals');
    expect(r.payload.ok).toBe(true);
    expect(r.payload.inputs.activeGoals).toBeNull();
    expect(r.payload.signals.some((s) => s.kind === 'idle_rumination')).toBe(false);
  });

  it('P2-B awakening-signals：endpoint 注册 + fail-open（无 db→enabled:false 不崩；真 4 维含 D4 由 sampleAwakening 单测覆盖）', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, {});
    const r = call(routes, 'get', '/api/noe/mind/awakening-signals');
    expect(r.payload.ok).toBe(true);
    if (r.payload.enabled) expect(r.payload.dimensions.d4_spontaneity).toBeDefined(); // D4 自发性此前整条丢失，现 endpoint 必透传真值
  });

  it('P9 self-evolution（happy）：注入聚合器 → 透传三阶段成功率/失败归因/耗时', () => {
    const { app, routes } = makeApp();
    const fakeSlo = {
      kind: 'noe_self_evolution_slo',
      generatedAt: '2026-06-22T00:00:00.000Z',
      sources: { applyReports: { parsed: 3, skipped: 0 }, runtimeVerify: { parsed: 2, skipped: 1 }, implementerFail: { parsed: 5, skipped: 0 } },
      stages: {
        implementer: { total: 5, success: 0, fail: 5, successRate: null, failureReasonsTopN: [{ reason: 'network', count: 4 }, { reason: 'other', count: 1 }], duration: { sampleCount: 0, p50Ms: null, p95Ms: null } },
        apply: { total: 3, success: 2, fail: 1, ratedTotal: 3, successRate: 0.6667, failureReasonsTopN: [{ reason: 'blocked', count: 1 }], duration: { sampleCount: 2, p50Ms: 120, p95Ms: 340 } },
        runtime_verify: { total: 2, success: 1, fail: 0, legacyUnknown: 1, successRate: 1, failureReasonsTopN: [], duration: { sampleCount: 0, p50Ms: null, p95Ms: null } },
      },
    };
    let receivedOpts = null;
    registerNoeMindRoutes(app, {
      now: () => Date.parse('2026-06-22T00:00:00.000Z'),
      selfEvolutionSlo: (opts) => { receivedOpts = opts; return fakeSlo; },
    });
    const r = call(routes, 'get', '/api/noe/mind/self-evolution');
    expect(r.payload).toMatchObject({ ok: true, enabled: true });
    expect(r.payload.slo.stages.apply.successRate).toBe(0.6667);
    expect(r.payload.slo.stages.implementer.successRate).toBeNull(); // 仅失败样本，不编造分母
    expect(r.payload.slo.stages.implementer.failureReasonsTopN[0]).toMatchObject({ reason: 'network', count: 4 });
    expect(r.payload.slo.stages.runtime_verify.legacyUnknown).toBe(1);
    expect(typeof receivedOpts.now).toBe('function'); // route 把固定时钟透传给聚合器
    expect(receivedOpts.root).toBeDefined(); // P9-fix(Codex):route 必须透传 root(隔离/多 checkout 正确)
  });

  it('P9-fix(Codex) self-evolution：route 把 rootDir 透传给聚合器(隔离 root,不读默认真实仓库产物)', () => {
    const { app, routes } = makeApp();
    let receivedOpts = null;
    registerNoeMindRoutes(app, {
      rootDir: '/tmp/p9-custom-root-xyz',
      selfEvolutionSlo: (opts) => { receivedOpts = opts; return { stages: {}, sources: {} }; },
    });
    call(routes, 'get', '/api/noe/mind/self-evolution');
    expect(receivedOpts.root).toBe('/tmp/p9-custom-root-xyz');
  });

  it('P9 self-evolution（空数据 fail-open）：默认真实聚合器指向空临时 root → 空聚合不崩', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-mind-se-empty-'));
    try {
      const { app, routes } = makeApp();
      // 走真实 buildSelfEvolutionSlo 但钉空临时 root（真实 IO 路径，只是目录为空）——
      // 证明无 applyReports/runtime/implementer 产物时返回空聚合不抛。
      registerNoeMindRoutes(app, { selfEvolutionSlo: (opts) => buildSelfEvolutionSlo({ ...opts, root }) });
      const r = call(routes, 'get', '/api/noe/mind/self-evolution');
      expect(r.payload.ok).toBe(true);
      expect(r.payload.slo.stages.implementer.total).toBe(0);
      expect(r.payload.slo.stages.apply.successRate).toBeNull(); // 无样本 → null 不编造
      expect(r.payload.slo.sources.applyReports.parsed).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('P9 self-evolution（聚合器抛错）：route try/catch → {ok:false,error} 不泄堆栈', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { selfEvolutionSlo: () => { throw new Error('boom'); } });
    const r = call(routes, 'get', '/api/noe/mind/self-evolution');
    expect(r.statusCode).toBe(500);
    expect(r.payload).toMatchObject({ ok: false });
  });

  it('特性未通电：GET 返回 enabled:false 不报错；POST 返回 409 带开关名', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { dataDir: null });
    expect(call(routes, 'get', '/api/noe/mind/thoughts').payload.enabled).toBe(false);
    expect(call(routes, 'get', '/api/noe/mind/affect').payload.enabled).toBe(false);
    expect(call(routes, 'get', '/api/noe/mind/goals').payload.enabled).toBe(false);
    const r = call(routes, 'post', '/api/noe/mind/expectations/resolve', { body: { id: 1, outcome: 1 } });
    expect(r.statusCode).toBe(409);
    expect(r.payload.error).toContain('NOE_EXPECTATIONS');
  });

  it('P0.2：POST goals 支持 source 白名单（owner 默认 / self_evolution 可 seed / 其余回落 owner）', () => {
    const { app, routes } = makeApp();
    const added = [];
    registerNoeMindRoutes(app, { goalSystem: { stats: () => ({}), list: () => [], get: () => null, setStatus: () => false, add: (g) => { added.push(g); return `g-${added.length}`; }, arbitrate: () => {} } });
    // self_evolution 被接受（owner 给自进化飞轮 seed 高质量技术目标，selfEvolve 心跳会取它推进 cycle）
    const r1 = call(routes, 'post', '/api/noe/mind/goals', { body: { title: '改进 src/util/x.js 的边界守卫', source: 'self_evolution' } });
    expect(r1.payload.ok).toBe(true);
    expect(added[0].source).toBe('self_evolution');
    // 不在白名单的内部源（surprise/drive 等）→ 回落 owner（防误注入内部源）
    const r2 = call(routes, 'post', '/api/noe/mind/goals', { body: { title: 't2', source: 'surprise' } });
    expect(r2.payload.ok).toBe(true);
    expect(added[1].source).toBe('owner');
    // 无 source → owner（向后兼容）
    call(routes, 'post', '/api/noe/mind/goals', { body: { title: 't3' } });
    expect(added[2].source).toBe('owner');
  });

  it('overview 汇总各引擎状态', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, {
      heartbeat: { status: () => ({ running: true, kinds: ['meso'], cursors: [] }) },
      heartbeatStore: { stats: () => ({ done: 5 }) },
      affectEngine: { snapshot: () => ({ v: 0.2, a: 0.4, d: 0.1, label: '平静' }), renderFeelingTokens: () => '心情平静', history: () => [] },
      goalSystem: { stats: () => ({ open: 1 }), list: () => [], get: () => null, setStatus: () => false, add: () => null, arbitrate: () => {} },
      expectationLedger: { open: () => [], due: () => [], brier: () => ({ n: 0, brier: null }), calibrationNote: () => '', history: () => [], resolve: () => null },
      kv: { get: () => ({ day: '2026-06-11', count: 2, lastAt: 1 }) },
    });
    const r = call(routes, 'get', '/api/noe/mind/overview');
    expect(r.payload.ok).toBe(true);
    expect(r.payload.heartbeat.running).toBe(true);
    expect(r.payload.affect.label).toBe('平静');
    expect(r.payload.gate.usedToday).toBe(2);
    expect(r.payload.switches).toHaveProperty('workspace');
  });

  it('overview 暴露 integration 读数（NoeIntegrationMetric 可见消费；kv 有 noe.integration.reading）', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, {
      kv: { get: (k) => (k === 'noe.integration.reading' ? { integration: 0.8, label: '高度整合', totalCorrelation: 5 } : null) },
    });
    const r = call(routes, 'get', '/api/noe/mind/overview');
    expect(r.payload.integration).toMatchObject({ integration: 0.8, label: '高度整合' });
  });

  it('overview integration/curiosity：kv 无读数 + 未注入 curiosityReport → null（OFF 零回归 fail-open）', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { kv: { get: () => null } });
    const r = call(routes, 'get', '/api/noe/mind/overview');
    expect(r.payload.integration).toBeNull();
    expect(r.payload.curiosity).toBeNull();
  });

  it('proof 汇总 Noe100 报告与最近 tick/thought/action/recovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-mind-proof-'));
    try {
      mkdirSync(join(root, 'output', 'noe-100-readiness'), { recursive: true });
      mkdirSync(join(root, 'output', 'noe-act-recovery-drill', '20260612T000000Z'), { recursive: true });
      mkdirSync(join(root, 'output', 'noe-failure-modes-attribution', '2026-06-13T01-34-40-390Z'), { recursive: true });
      writeFileSync(join(root, 'output', 'noe-100-readiness', 'noe-100-readiness-1000.json'), JSON.stringify({
        passed: false,
        readyFor100: false,
        score: 97,
        passedChecks: 36,
        failedChecks: 1,
        blockers: ['not_enough_soak_evidence'],
        evidenceRefs: [{ file: 'sqlite:events', note: 'active days' }],
        dimensions: {
          survival: { title: '生存', score: 80, passed: 4, failed: 1, blockers: ['not_enough_soak_evidence'] },
        },
        source: { generatedAt: '2026-06-12T02:00:00.000Z', policy: 'read-only' },
      }));
      writeFileSync(join(root, 'output', 'noe-act-recovery-drill', '20260612T000000Z', 'report.json'), JSON.stringify({
        ok: true,
        generatedAt: '2026-06-12T02:10:00.000Z',
        failedAct: { firstStatus: 'failed', recoveredStatus: 'completed' },
        approvalWait: { firstStatus: 'awaiting_approval', finalStatus: 'completed' },
      }));
      writeFileSync(join(root, 'output', 'noe-failure-modes-attribution', '2026-06-13T01-34-40-390Z', 'report.json'), JSON.stringify({
        ok: true,
        generatedAtIso: '2026-06-13T01:34:40.390Z',
        summary: { clusterCount: 5, j0LiteGapSeedCount: 5 },
        blockers: [],
        warnings: ['secret_like_source_detected_redacted'],
        failureModeClusters: [
          {
            cluster: 'goal_checkpoint:evidence_blocked',
            count: 37,
            severity: 'high',
            derived: true,
            origin: 'sqlite_goal_checkpoints',
            matchedEvidenceCount: 37,
            suggestedGapSeed: { seedId: 'p7h0_goal_checkpoint_evidence_blocked', readyForJ0Lite: true },
            recommendedNextAction: 'Add an evidence-contract checker.',
            replaySafety: { level: 'diagnostic_only' },
          },
        ],
      }));
      const { app, routes } = makeApp();
      registerNoeMindRoutes(app, {
        rootDir: root,
        now: () => Date.parse('2026-06-12T02:20:00.000Z'),
        heartbeatStore: { recentTicks: () => [{ id: 7, kind: 'meso', status: 'done', started_at: 1, finished_at: 2 }] },
        timeline: { recent: () => [{ id: 9, ts: 3, type: 'inner_monologue', summary: '我在检查证明门' }] },
        proofDb: {
          prepare: (sql) => ({
            get: () => sql.includes('FROM noe_acts') ? {
              id: 'act-1',
              title: '验证 action evidence',
              action: 'shell.exec',
              risk_level: 'low',
              status: 'completed',
              evidence_event_id: 11,
              log_ref: 'sqlite:events/11',
              updated_at: 4,
            } : null,
          }),
        },
      });
      const r = call(routes, 'get', '/api/noe/mind/proof');
      expect(r.payload.ok).toBe(true);
      expect(r.payload.readiness.score).toBe(97);
      expect(r.payload.readiness.blockers).toEqual(['not_enough_soak_evidence']);
      expect(r.payload.last.tick).toMatchObject({ id: 7, kind: 'meso', status: 'done' });
      expect(r.payload.last.thought.summary).toBe('我在检查证明门');
      expect(r.payload.last.action).toMatchObject({ id: 'act-1', status: 'completed', evidenceEventId: 11 });
      expect(r.payload.last.recovery).toMatchObject({ kind: 'act_failure_approval_wait', ok: true });
      expect(r.payload.failureModes).toMatchObject({
        enabled: true,
        ok: true,
        clusterCount: 5,
        j0LiteGapSeedCount: 5,
        warnings: ['secret_like_source_detected_redacted'],
      });
      expect(r.payload.failureModes.clusters[0]).toMatchObject({
        cluster: 'goal_checkpoint:evidence_blocked',
        derived: true,
        seedId: 'p7h0_goal_checkpoint_evidence_blocked',
        readyForJ0Lite: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('memory v2：状态、搜索、隐藏/恢复/编辑/删除/隔离区/回放均可审计', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-mind-memory-'));
    try {
      initSqlite(join(dir, 'panel.db'));
      const memory = new MemoryCore({ logger: { warn: () => {} } });
      const auditLog = new NoeMemoryAuditLog({ db: () => memory.db(), now: () => 1000 });
      const memoryWriteGate = new NoeMemoryWriteGate({ memory, auditLog, now: () => 2000, logger: { warn: () => {} } });
      memory.write({
        id: 'm1',
        projectId: 'noe',
        scope: 'fact',
        title: '咖啡偏好',
        body: '主人长期偏好黑咖啡。',
        sourceType: 'unit',
        sourceEpisodeId: 'ep-1',
        confidence: 0.8,
        salience: 4,
        tags: ['coffee'],
      });
      const quarantined = memoryWriteGate.commit({
        kind: 'fact',
        projectId: 'noe',
        body: 'api_key=sk-testSecretValue1234567890',
        sourceEpisodeId: 'ep-secret',
        evidenceRefs: ['episode:ep-secret'],
        confidence: 0.9,
      });
      expect(quarantined.decision).toBe('quarantined');
      const { app, routes } = makeApp();
      registerNoeMindRoutes(app, { memory, memoryWriteGate });
      const status = call(routes, 'get', '/api/noe/mind/memory');
      expect(status.payload.ok).toBe(true);
      expect(status.payload.enabled).toBe(true);
      expect(status.payload).toHaveProperty('sourceLinked');
      const search = call(routes, 'get', '/api/noe/mind/memory/search', { query: { q: '咖啡', limit: 5 } });
      expect(search.payload.items[0]).toMatchObject({ id: 'm1', sourceEpisodeId: 'ep-1' });
      expect(call(routes, 'post', '/api/noe/mind/memory/hide', { body: { id: 'm1' } }).payload.ok).toBe(true);
      expect(call(routes, 'post', '/api/noe/mind/memory/unhide', { body: { id: 'm1' } }).payload.ok).toBe(true);
      const edit = call(routes, 'post', '/api/noe/mind/memory/edit', { body: { id: 'm1', body: '主人长期偏好手冲黑咖啡。' } });
      expect(edit.payload.item.body).toContain('手冲黑咖啡');
      const replayEdit = auditLog.listCandidates({ projectId: 'noe', decision: 'accepted', limit: 10 })
        .find((candidate) => candidate.targetMemoryId === 'm1');
      expect(replayEdit).toBeTruthy();
      const quarantine = call(routes, 'get', '/api/noe/mind/memory/quarantine', { query: { limit: 10 } });
      expect(quarantine.payload.items[0]).toMatchObject({ decision: 'quarantined', sourceEpisodeId: 'ep-secret' });
      const replay = call(routes, 'get', '/api/noe/mind/memory/candidates/:id/replay', { params: { id: quarantine.payload.items[0].id } });
      expect(replay.payload).toMatchObject({ ok: true, decision: 'quarantined' });
      const deleted = call(routes, 'post', '/api/noe/mind/memory/delete', { body: { id: 'm1' } });
      expect(deleted.payload).toMatchObject({ ok: true, reversible: true });
    } finally {
      close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('thoughts 合并轻醒注意力脉冲，避免生成型念头失败时左侧误显停流', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-mind-'));
    try {
      const date = '2026-06-11';
      mkdirSync(join(dir, 'consciousness'), { recursive: true });
      writeFileSync(join(dir, 'consciousness', `${date}.jsonl`), [
        JSON.stringify({ ts: 1_000, kind: 'attend', tickId: 1, winner: { source: 'goal_step', score: 0.3, text: '推进目标 A' } }),
        JSON.stringify({ ts: 20_000, kind: 'attend', tickId: 2, winner: { source: 'goal_step', score: 0.3, text: '推进目标 B' } }),
        JSON.stringify({ ts: 70_000, kind: 'attend', tickId: 3, winner: { source: 'system_state', score: 0.37, text: '检查本机状态' } }),
      ].join('\n') + '\n');
      const { app, routes } = makeApp();
      registerNoeMindRoutes(app, {
        dataDir: dir,
        now: () => Date.parse(`${date}T12:00:00.000Z`),
        timeline: {
          recent: () => [{ id: 9, ts: 50_000, type: 'inner_monologue', summary: '我刚想到一件事', salience: 2 }],
        },
      });
      const r = call(routes, 'get', '/api/noe/mind/thoughts', { query: { limit: 10 } });
      expect(r.payload.thoughts.map((t) => t.type)).toEqual(['awareness_tick', 'inner_monologue', 'awareness_tick']);
      expect(r.payload.thoughts[0]).toMatchObject({
        summary: expect.stringContaining('检查本机状态'),
        meta: { streamType: 'awareness', generated: false, focus: { source: 'system_state', score: 0.37 } },
      });

      const off = call(routes, 'get', '/api/noe/mind/thoughts', { query: { limit: 10, awareness: '0' } });
      expect(off.payload.thoughts.map((t) => t.type)).toEqual(['inner_monologue']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('thoughts 对相同注意力焦点只保留最新轻醒，避免重复句子刷屏', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-mind-dedupe-'));
    try {
      const date = '2026-06-11';
      mkdirSync(join(dir, 'consciousness'), { recursive: true });
      writeFileSync(join(dir, 'consciousness', `${date}.jsonl`), [
        JSON.stringify({ ts: 1_000, kind: 'attend', tickId: 1, winner: { source: 'goal_step', score: 0.62, text: '推进目标「字段层级框架」：想清楚第一步' } }),
        JSON.stringify({ ts: 70_000, kind: 'attend', tickId: 2, winner: { source: 'goal_step', score: 0.62, text: '推进目标「字段层级框架」：想清楚第一步' } }),
        JSON.stringify({ ts: 130_000, kind: 'attend', tickId: 3, winner: { source: 'system_state', score: 0.38, text: '检查本机状态' } }),
      ].join('\n') + '\n');
      const { app, routes } = makeApp();
      registerNoeMindRoutes(app, {
        dataDir: dir,
        now: () => Date.parse(`${date}T12:00:00.000Z`),
        timeline: { recent: () => [] },
      });

      const r = call(routes, 'get', '/api/noe/mind/thoughts', { query: { limit: 10 } });
      const repeated = r.payload.thoughts.filter((t) => t.summary.includes('字段层级框架'));

      expect(repeated).toHaveLength(1);
      expect(repeated[0].id).toContain('70000');
      expect(r.payload.thoughts.map((t) => t.summary)).toEqual([
        expect.stringContaining('检查本机状态'),
        expect.stringContaining('字段层级框架'),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('裁决：合法 outcome 结算；高惊奇触发好奇回路（NOE_CURIOSITY=1 时）+ 情感评估', () => {
    const prevCur = process.env.NOE_CURIOSITY;
    process.env.NOE_CURIOSITY = '1';
    try {
      const appraised = [];
      const harvested = [];
      const { app, routes } = makeApp();
      registerNoeMindRoutes(app, {
        expectationLedger: { resolve: (id, outcome) => ({ id, claim: '预测X', outcome, surprise: 3.2 }), open: () => [], due: () => [], brier: () => ({}), calibrationNote: () => '', history: () => [] },
        goalSystem: { harvestSurprise: (x) => { harvested.push(x); return 'g1'; }, stats: () => ({}), list: () => [], get: () => null, setStatus: () => false, add: () => null, arbitrate: () => {} },
        affectEngine: { appraise: (s, m) => appraised.push({ s, m }), snapshot: () => ({}), renderFeelingTokens: () => '', history: () => [] },
      });
      const r = call(routes, 'post', '/api/noe/mind/expectations/resolve', { body: { id: 7, outcome: 0 } });
      expect(r.payload.ok).toBe(true);
      expect(r.payload.curiosityGoalId).toBe('g1');
      expect(harvested[0].surprise).toBe(3.2);
      expect(appraised.length).toBe(1);
      const bad = call(routes, 'post', '/api/noe/mind/expectations/resolve', { body: { id: 'x' } });
      expect(bad.statusCode).toBe(400);
    } finally {
      if (prevCur === undefined) delete process.env.NOE_CURIOSITY; else process.env.NOE_CURIOSITY = prevCur;
    }
  });

  it('裁决 agency 随 surprise 分级（finding B）：小应验掌控感高、惊天应验掌控感降；落空越惊讶越低', () => {
    const mk = (surprise) => {
      const appraised = [];
      const { app, routes } = makeApp();
      registerNoeMindRoutes(app, {
        expectationLedger: { resolve: (id, outcome) => ({ id, claim: 'P', outcome, surprise }), open: () => [], due: () => [], brier: () => ({}), calibrationNote: () => '', history: () => [] },
        affectEngine: { appraise: (s, m) => appraised.push({ s, m }), snapshot: () => ({}), renderFeelingTokens: () => '', history: () => [] },
      });
      return { routes, appraised };
    };
    // 应验：surprise 越大 agency 越小，下限 0.5；小 surprise 接近 0.7。
    const lowHit = mk(0.05); call(lowHit.routes, 'post', '/api/noe/mind/expectations/resolve', { body: { id: 1, outcome: 1 } });
    const highHit = mk(3.0); call(highHit.routes, 'post', '/api/noe/mind/expectations/resolve', { body: { id: 2, outcome: 1 } });
    expect(lowHit.appraised[0].s.agency).toBeCloseTo(0.695, 3);
    expect(highHit.appraised[0].s.agency).toBe(0.5); // max(0.5, 0.7-0.3)=0.5
    expect(highHit.appraised[0].s.agency).toBeLessThan(lowHit.appraised[0].s.agency);
    // 落空：surprise 越大 agency 越低，上限 0.5；小 surprise 接近 0.3。
    const lowMiss = mk(0.05); call(lowMiss.routes, 'post', '/api/noe/mind/expectations/resolve', { body: { id: 3, outcome: 0 } });
    const highMiss = mk(8.0); call(highMiss.routes, 'post', '/api/noe/mind/expectations/resolve', { body: { id: 4, outcome: 0 } });
    expect(lowMiss.appraised[0].s.agency).toBeCloseTo(0.3025, 4);
    expect(highMiss.appraised[0].s.agency).toBe(0.5); // min(0.5, 0.3+0.4)=0.5
    expect(highMiss.appraised[0].s.agency).toBeGreaterThan(lowMiss.appraised[0].s.agency);
  });

  it('主人立目标：成功返回 id；title 重复/非法返回 400', () => {
    const { app, routes } = makeApp();
    let added = null;
    registerNoeMindRoutes(app, {
      goalSystem: { add: (g) => { added = g; return g.title === '重复' ? null : 'gid'; }, arbitrate: () => {}, stats: () => ({}), list: () => [], get: () => null, setStatus: () => false },
    });
    const ok = call(routes, 'post', '/api/noe/mind/goals', { body: { title: '帮我盯一下基准', steps: ['先看台账'] } });
    expect(ok.payload.id).toBe('gid');
    expect(added.source).toBe('owner');
    expect(call(routes, 'post', '/api/noe/mind/goals', { body: { title: '重复' } }).statusCode).toBe(400);
  });

  it('journal：date 校验防路径注入，文件缺失返回空行', () => {
    const { app, routes } = makeApp();
    registerNoeMindRoutes(app, { dataDir: '/tmp/绝不存在的目录-noe-mind-test' });
    const r = call(routes, 'get', '/api/noe/mind/journal', { query: { date: '../../etc/passwd' } });
    expect(r.payload.ok).toBe(true);
    expect(r.payload.date).toMatch(/^\d{4}-\d{2}-\d{2}$/); // 非法 date 落回今天
    expect(r.payload.lines).toEqual([]);
  });

  it('memory/edit 省略 kind 时回退到原记忆 kind，绝不把 scope 误当 kind 落库', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-mind-kind-leak-'));
    try {
      initSqlite(join(dir, 'panel.db'));
      const memory = new MemoryCore({ logger: { warn: () => {} } });
      const auditLog = new NoeMemoryAuditLog({ db: () => memory.db(), now: () => 1000 });
      const memoryWriteGate = new NoeMemoryWriteGate({ memory, auditLog, now: () => 2000, logger: { warn: () => {} } });
      // scope='project'（合法 kind 值但语义不该当 kind）才能暴露 scope→kind 泄漏。
      memory.write({
        id: 'mk', projectId: 'noe', scope: 'project',
        title: '项目级记忆', body: '这条记忆的原始正文足够长。',
        sourceType: 'unit', sourceEpisodeId: 'ep-k', confidence: 0.8, salience: 3, tags: [],
      });
      const { app, routes } = makeApp();
      registerNoeMindRoutes(app, { memory, memoryWriteGate });
      const edit = call(routes, 'post', '/api/noe/mind/memory/edit', { body: { id: 'mk', body: '编辑后的正文同样足够长。' } });
      expect(edit.payload.ok).toBe(true);
      const cand = auditLog.listCandidates({ projectId: 'noe', decision: 'accepted', limit: 10 })
        .find((c) => c.targetMemoryId === 'mk');
      expect(cand).toBeTruthy();
      expect(cand.scope).toBe('project');      // scope 仍正确保留（481 行本就对）
      expect(cand.kind).toBe('fact');          // 修复后=中性默认 fact；修复前=漏成 'project'
      expect(cand.kind).not.toBe('project');   // 锁死 scope 不得泄漏进 kind
    } finally {
      close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
