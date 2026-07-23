// @ts-check
// noeMind — 内心透视页路由（owner 委托：改动和新增"要能被人类看到"，有专门页面可查
// 他具体想了什么、做了什么）。页面在 public/mind.html，本文件是它的数据层。
//
// 暴露的全部是"认知内核"的留痕数据：意识流念头（含深思）/ 注意力意识日志 / 心跳台账 /
// 情感曲线 / 期望账本（含人工裁决入口——主人裁决预测应验与否，是校准回路的现实接口）/
// 目标库（主人可直接立 owner 目标）。全部端点 owner-token 把门；各特性未通电时返回
// enabled:false 而非报错（fail-open 给前端渲染"未通电"态）。
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { requireOwnerToken } from '../auth/owner-token.js';
import { NoeHeartbeatStore } from '../../cognition/NoeHeartbeatStore.js';
import { appendEvent, getDb, kvGet } from '../../storage/SqliteStore.js';
import { NoeSelfEvolutionCycleStore } from '../../room/NoeSelfEvolutionCycleStore.js';
import { buildNoeMemoryStatus } from '../../memory/NoeMemoryStatus.js';
import { NoeMemoryAuditLog } from '../../memory/NoeMemoryAuditLog.js';
import { compactFailureModes } from '../services/noe-mind-failure-modes.js';
import { discoverLocalModelProviders } from '../../room/NoeLocalModelCouncil.js';
import { createModelHealthProbe } from '../services/NoeModelHealthProbe.js';
import { createIntegrationHistory } from '../../cognition/NoeIntegrationHistory.js';
import { detectWallSignals } from '../../cognition/NoeWallSignal.js';
import { sampleAwakening } from '../../cognition/NoeAwakeningSignals.js';
import { buildSelfEvolutionSlo } from '../../loop/NoeSelfEvolutionSlo.js';
import { createCandidatePool } from '../../cognition/NoeCandidatePool.js';
import { NoeGoalCandidateStore } from '../../storage/NoeGoalCandidateStore.js';

const SWITCHES = () => ({
  heartbeat: process.env.NOE_HEARTBEAT === '1',
  affect: process.env.NOE_AFFECT === '1',
  streamV2: process.env.NOE_STREAM_V2 === '1',
  workspace: process.env.NOE_WORKSPACE === '1',
  expectations: process.env.NOE_EXPECTATIONS === '1',
  goals: process.env.NOE_GOALS === '1',
  curiosity: process.env.NOE_CURIOSITY === '1',
  reflectBrain: process.env.NOE_REFLECT_TIER === '1',
  innerMonologue: process.env.NOE_INNER_MONOLOGUE === '1',
});

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function safeReadJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function latestJsonFile(dir, pred = () => true) {
  const files = walkFiles(dir)
    .filter(pred)
    .map((file) => {
      try { return { file, mtimeMs: statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of files) {
    const json = safeReadJson(item.file);
    if (json) return { file: item.file, json };
  }
  return { file: '', json: null };
}

function relPath(rootDir, file) {
  return file && file.startsWith(rootDir) ? file.slice(rootDir.length + 1) : file || '';
}

function compactDimensionSummary(dimensions) {
  return Object.entries(dimensions || {}).map(([id, d]) => ({
    id,
    title: d?.title || id,
    score: Number(d?.score) || 0,
    passed: Number(d?.passed) || 0,
    failed: Number(d?.failed) || 0,
    blockers: Array.isArray(d?.blockers) ? d.blockers.slice(0, 8) : [],
  }));
}

function one(db, sql, params = []) {
  if (!db?.prepare) return null;
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function compactAction(row) {
  if (!row) return null;
  return {
    id: row.id || null,
    title: row.title || '',
    action: row.action || '',
    status: row.status || '',
    riskLevel: row.risk_level || '',
    evidenceEventId: row.evidence_event_id || null,
    logRef: row.log_ref || '',
    failureReason: row.failure_reason || '',
    updatedAt: Number(row.updated_at) || null,
  };
}

function compactTick(row) {
  if (!row) return null;
  return {
    id: row.id || null,
    kind: row.kind || '',
    status: row.status || '',
    startedAt: Number(row.started_at) || null,
    finishedAt: Number(row.finished_at) || null,
    dueAt: Number(row.due_at) || null,
    error: row.error || '',
  };
}

function awarenessFocusKey(winner) {
  const text = String(winner?.text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!text) return '';
  return `${String(winner?.source || '').trim()}:${text}`;
}

function latestRecoveryReport(rootDir) {
  const candidates = [
    ['act_failure_approval_wait', ['output', 'noe-act-recovery-drill'], (j) => ({
      ok: j?.ok === true,
      summary: `failedAct ${j?.failedAct?.firstStatus || '?'}→${j?.failedAct?.recoveredStatus || '?'} · approval ${j?.approvalWait?.firstStatus || '?'}→${j?.approvalWait?.finalStatus || '?'}`,
      generatedAt: j?.generatedAt || '',
    })],
    ['runtime_restart', ['output', 'noe-runtime-restart-recovery-drill'], (j) => ({
      ok: j?.ok === true,
      summary: `pid ${j?.before?.port51835?.listeners?.[0]?.pid || '?'}→${j?.after?.port51835?.listeners?.[0]?.pid || '?'} · health ${j?.checks?.healthOk === true ? 'ok' : 'unknown'}`,
      generatedAt: j?.generatedAt || '',
    })],
    ['model_unloaded', ['output', 'noe-model-unload-recovery-drill'], (j) => ({
      ok: j?.ok === true,
      summary: `model_unloaded=${j?.modelUnloadedDetected === true} · backup=${j?.backupParticipantUsed === true} · lm=${j?.lmStudioLoadUnloadChanged === false ? 'unchanged' : 'changed_or_unknown'}`,
      generatedAt: j?.generatedAt || '',
    })],
    ['side_effect_rollback', ['output', 'noe-controlled-side-effect-drill'], (j) => ({
      ok: j?.ok === true,
      summary: `sideEffect=${j?.sideEffect?.writeVerified === true} · rollback=${j?.rollback?.verified === true}`,
      generatedAt: j?.generatedAt || '',
    })],
  ];
  return candidates.map(([kind, parts, summarize]) => {
    const hit = latestJsonFile(join(rootDir, ...parts), (f) => /\/report\.json$/.test(f));
    if (!hit.json) return null;
    const s = summarize(hit.json);
    return {
      kind,
      ok: s.ok,
      summary: s.summary,
      generatedAt: s.generatedAt,
      reportPath: relPath(rootDir, hit.file),
      mtimeMs: (() => { try { return statSync(hit.file).mtimeMs; } catch { return 0; } })(),
    };
  }).filter(Boolean).sort((a, b) => {
    const at = Date.parse(a.generatedAt || '') || a.mtimeMs || 0;
    const bt = Date.parse(b.generatedAt || '') || b.mtimeMs || 0;
    return bt - at;
  });
}

export function registerNoeMindRoutes(app, {
  timeline = null,
  affectEngine = null,
  expectationLedger = null,
  goalSystem = null,
  heartbeat = null,
  heartbeatStore = null,        // 注入测试桩；缺省惰性建真实 store（共享同一 SQLite）
  mindVitals = null,            // 心智体征（M5 自审仪表：语义多样性/接地率）
  memory = null,
  memoryWriteGate = null,
  dataDir = null,
  rootDir = DEFAULT_ROOT,
  proofDb = null,
  curiosityReport = null,
  selfEvolutionSlo = buildSelfEvolutionSlo, // P9：自进化 SLO 聚合器（纯只读产物 → 成功率/MTTR/失败分类）；可注入桩/临时 root 单测
  kv = { get: kvGet },
  sendError = (res, e) => res.status(500).json({ ok: false, error: e?.message || String(e) }),
  now = Date.now,
  goalCandidateStore = null, // P2 切片A：候选池 store（注入测试桩；缺省惰性建真实 NoeGoalCandidateStore）
} = {}) {
  const hbStore = () => {
    if (heartbeatStore) return heartbeatStore;
    try { return (heartbeatStore = new NoeHeartbeatStore()); } catch { return null; }
  };
  // P2 切片A：候选池 store 惰性建（与 hbStore 同模式）。NOE_CANDIDATE_POOL=1 时 owner-seed 走候选池。
  const gcStore = () => {
    if (goalCandidateStore) return goalCandidateStore;
    try { return (goalCandidateStore = new NoeGoalCandidateStore()); } catch { return null; }
  };

  let proofCache = { at: 0, data: null };
  function buildProofSummary() {
    const t = now();
    if (proofCache.data && t - proofCache.at < 30_000) return { ...proofCache.data, cached: true };
    const readinessHit = latestJsonFile(join(rootDir, 'output', 'noe-100-readiness'), (f) => /noe-100-readiness-\d+\.json$/.test(f));
    const readiness = readinessHit.json || null;
    const db = proofDb || (() => { try { return getDb(); } catch { return null; } })();
    const tick = heartbeatStore?.recentTicks
      ? heartbeatStore.recentTicks({ limit: 1 })?.[0] || null
      : one(db, 'SELECT id, kind, due_at, started_at, finished_at, status, error FROM noe_ticks ORDER BY COALESCE(finished_at, started_at, due_at, 0) DESC LIMIT 1');
    const thoughts = timeline?.recent ? timeline.recent({ limit: 1, types: ['inner_monologue', 'dream', 'milestone'] }) : [];
    const action = one(db, 'SELECT id, title, action, risk_level, status, failure_reason, evidence_event_id, log_ref, updated_at FROM noe_acts ORDER BY updated_at DESC LIMIT 1');
    const recoveryReports = latestRecoveryReport(rootDir);
    const failureModes = compactFailureModes(rootDir);
    const data = {
      ok: true,
      enabled: Boolean(readiness),
      ts: t,
      readiness: readiness ? {
        score: Number(readiness.score) || 0,
        passed: readiness.passed === true,
        readyFor100: readiness.readyFor100 === true,
        passedChecks: Number(readiness.passedChecks) || 0,
        failedChecks: Number(readiness.failedChecks) || 0,
        blockers: Array.isArray(readiness.blockers) ? readiness.blockers : [],
        dimensions: compactDimensionSummary(readiness.dimensions),
        evidenceRefCount: Array.isArray(readiness.evidenceRefs) ? readiness.evidenceRefs.length : 0,
        generatedAt: readiness.source?.generatedAt || '',
        policy: readiness.source?.policy || '',
        reportPath: relPath(rootDir, readinessHit.file),
      } : null,
      last: {
        tick: compactTick(tick),
        thought: thoughts?.[0] ? {
          id: thoughts[0].id || null,
          type: thoughts[0].type || '',
          ts: Number(thoughts[0].ts) || null,
          summary: thoughts[0].summary || '',
        } : null,
        action: compactAction(action),
        recovery: recoveryReports[0] || null,
      },
      recoveryReports: recoveryReports.slice(0, 4),
      failureModes,
    };
    proofCache = { at: t, data };
    return { ...data, cached: false };
  }
  const capLimit = (v, d, max) => Math.max(1, Math.min(max, Number(v) || d));
  const dateOf = (t) => new Date(t).toISOString().slice(0, 10);
  const journalFileFor = (date) => join(dataDir || '', 'consciousness', `${date}.jsonl`);
  const memoryProject = (req) => (typeof req.query.projectId === 'string' && req.query.projectId.trim()) ? req.query.projectId.trim().slice(0, 120) : 'noe';
  const bodyProject = (req) => String((req.body || {}).projectId || 'noe').slice(0, 120) || 'noe';
  const dbOrNull = () => { try { return getDb(); } catch { return null; } };
  let curiosityCache = { at: 0, data: null };
  function buildCuriosityFunnelSummary() {
    if (typeof curiosityReport !== 'function') return null;
    const t = now();
    if (curiosityCache.data && t - curiosityCache.at < 60_000) return { ...curiosityCache.data, cached: true };
    try {
      const db = dbOrNull();
      if (!db?.prepare) return null;
      const rep = curiosityReport(db, { sinceTs: 0, now: t });
      if (!rep || typeof rep !== 'object') return null;
      const data = {
        generatedAt: rep.generatedAt || '',
        settled: Number(rep.expectations?.settled) || 0,
        failed: Number(rep.expectations?.failed) || 0,
        surpriseGoals: Number(rep.research?.surpriseGoals) || 0,
        surpriseGoalsDone: Number(rep.research?.surpriseGoalsDone) || 0,
        funnel: Array.isArray(rep.funnel) ? rep.funnel.slice(0, 12) : [],
        diagnostics: Array.isArray(rep.diagnostics) ? rep.diagnostics.slice(0, 8) : [],
      };
      curiosityCache = { at: t, data };
      return { ...data, cached: false };
    } catch { return null; }
  }
  const auditMemoryUi = (tag, id, projectId = 'noe', extra = {}) => {
    try { appendEvent({ kind: 'noe_memory_ui', tag, entityType: 'noe_memory', entityId: id, projectId, ...extra }); } catch { /* audit fail-open */ }
  };
  const linksForMemoryId = (id) => {
    const db = dbOrNull();
    if (!db || !id) return [];
    try {
      return db.prepare('SELECT link_type AS type, link_ref AS ref, quote_hash AS quoteHash FROM noe_memory_link WHERE memory_id=? ORDER BY id ASC LIMIT 30').all(id);
    } catch { return []; }
  };
  const candidateForMemoryId = (id) => {
    const db = dbOrNull();
    if (!db || !id) return null;
    try {
      const row = db.prepare(`
        SELECT id, decision, decision_reason, created_at, decided_at FROM noe_memory_candidate
        WHERE target_memory_id=?
        ORDER BY COALESCE(decided_at, created_at) DESC LIMIT 1
      `).get(id);
      return row ? {
        id: row.id,
        decision: row.decision || '',
        reason: row.decision_reason || '',
        createdAt: Number(row.created_at) || null,
        decidedAt: Number(row.decided_at) || null,
      } : null;
    } catch { return null; }
  };
  const compactMemory = (m) => ({
    id: m.id,
    projectId: m.projectId,
    scope: m.scope,
    title: m.title || '',
    body: String(m.body || '').slice(0, 500),
    sourceType: m.sourceType || '',
    sourceEpisodeId: m.sourceEpisodeId || null,
    confidence: m.confidence,
    salience: m.salience,
    tags: Array.isArray(m.tags) ? m.tags.slice(0, 12) : [],
    hidden: m.hidden === true,
    hiddenReason: m.hiddenReason || null,
    updatedAt: m.updatedAt || null,
    links: linksForMemoryId(m.id),
    gate: candidateForMemoryId(m.id),
  });
  const readJournalTail = (date, limit) => {
    if (!dataDir) return [];
    const file = journalFileFor(date);
    if (!existsSync(file)) return [];
    const raw = readFileSync(file, 'utf8').trimEnd();
    if (!raw) return [];
    return raw.split('\n').slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };

  function awarenessPulses({ date, limit, intervalMs = 60_000 } = {}) {
    const rows = readJournalTail(date, Math.max(100, limit * 8)).reverse();
    const out = [];
    let lastTs = Infinity;
    const seenFocus = new Set();
    for (const row of rows) {
      if (row?.kind !== 'attend') continue;
      const ts = Number(row.ts) || 0;
      if (!ts || lastTs - ts < intervalMs) continue;
      lastTs = ts;
      const w = row.winner || null;
      const focusKey = awarenessFocusKey(w);
      if (focusKey && seenFocus.has(focusKey)) continue;
      if (focusKey) seenFocus.add(focusKey);
      out.push({
        id: `awareness:${ts}:${row.tickId || 0}`,
        ts,
        type: 'awareness_tick',
        summary: w?.text ? `轻醒：正把注意力放在「${String(w.text).slice(0, 120)}」` : '轻醒：本周期没有抓到高优先级焦点',
        detail: '',
        salience: 1,
        meta: {
          streamType: 'awareness',
          generated: false,
          tickId: row.tickId || 0,
          ...(w ? { focus: { source: w.source || null, text: String(w.text || '').slice(0, 160), score: w.score ?? null } } : {}),
        },
      });
      if (out.length >= limit) break;
    }
    return out;
  }

  // 总览：开关 / 心跳 / 情感 / 浮现预算 / 目标与期望统计 —— 页面顶部状态条
  app.get('/api/noe/mind/overview', requireOwnerToken, (req, res) => {
    try {
      let gate = null;
      try { const g = kv.get?.('noe.surfacing.gate'); if (g && typeof g === 'object') gate = { day: g.day, usedToday: Number(g.count) || 0, lastAt: Number(g.lastAt) || 0 }; } catch { /* 无记账 */ }
      let tickStats = null;
      try { tickStats = process.env.NOE_HEARTBEAT === '1' ? hbStore()?.stats() : null; } catch { tickStats = null; }
      // 成熟度补针（GPT5.5 评审 7 硬指标的两个缺口，2026-06-11）：主动开口回应率 + 目标完成率。
      // 口径对齐 noe-autonomy-report：开口=noe_memory source_type='noe_proactive'（30 天窗）；
      // 回应=开口后 10 分钟内 timeline 有 interaction（与 evaluateProactiveResponse 同款判定）。
      let integrationReading = null;
      try { integrationReading = kv.get?.('noe.integration.reading') || null; } catch { integrationReading = null; }
      let maturity = null;
      try {
        const since = now() - 30 * 24 * 3600_000;
        const db = getDb();
        const spoke = db.prepare("SELECT created_at FROM noe_memory WHERE source_type='noe_proactive' AND created_at >= ?").all(since);
        const probe = db.prepare("SELECT 1 FROM events WHERE kind='noe_episode' AND tag='interaction' AND ts > ? AND ts <= ? LIMIT 1");
        let responded = 0;
        for (const s of spoke) { if (probe.get(s.created_at, s.created_at + 600_000)) responded += 1; }
        const g = goalSystem ? goalSystem.stats() : {};
        const gDone = Number(g.done) || 0;
        const gTotal = ['open', 'active', 'done', 'paused'].reduce((a, k) => a + (Number(g[k]) || 0), 0);
        maturity = {
          proactiveSpoke30d: spoke.length,
          proactiveResponseRate: spoke.length ? Math.round((responded / spoke.length) * 100) / 100 : null,
          goalDoneRate: gTotal ? Math.round((gDone / gTotal) * 100) / 100 : null,
        };
      } catch { maturity = null; }
      res.json({
        ok: true,
        ts: now(),
        switches: SWITCHES(),
        heartbeat: heartbeat ? heartbeat.status() : null,
        tickStats,
        affect: affectEngine ? affectEngine.snapshot() : null,
        feeling: affectEngine ? affectEngine.renderFeelingTokens() : null,
        gate,
        goals: goalSystem ? goalSystem.stats() : null,
        expectations: expectationLedger
          ? { open: expectationLedger.open({ limit: 200 }).length, due: expectationLedger.due(now()).length, ...expectationLedger.brier() }
          : null,
        calibrationNote: expectationLedger ? expectationLedger.calibrationNote() : '',
        maturity,
        integration: integrationReading,
        curiosity: buildCuriosityFunnelSummary(),
      });
    } catch (e) { sendError(res, e); }
  });

  // Noe100 proof：把统一证明门最近报告 + 最近 tick/thought/action/recovery 放到内心面板。
  // 只读本地 JSON/SQLite，不触发模型调用、benchmark 或 LM Studio load/unload。
  app.get('/api/noe/mind/proof', requireOwnerToken, (req, res) => {
    try { res.json(buildProofSummary()); } catch (e) { sendError(res, e); }
  });

  // 长期记忆 v2：状态 / 搜索 / 忘记 / 恢复 / 编辑 / 导出 / 隔离区回放。
  // 状态端点不返回正文；搜索/导出返回已由 MemoryCore 脱敏的截断正文。
  app.get('/api/noe/mind/memory', requireOwnerToken, (req, res) => {
    try {
      const db = dbOrNull();
      if (!db) return res.json({ ok: true, enabled: false });
      res.json({ enabled: true, ...buildNoeMemoryStatus({ db, now }) });
    } catch (e) { sendError(res, e); }
  });
  app.get('/api/noe/mind/memory/search', requireOwnerToken, (req, res) => {
    try {
      if (!memory?.recall) return res.json({ ok: true, enabled: false, items: [] });
      const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 500) : '';
      const includeHidden = req.query.includeHidden === '1';
      const items = memory.recall({ q, projectId: memoryProject(req), limit: capLimit(req.query.limit, 20, 100), includeHidden, bumpHits: false })
        .map(compactMemory);
      res.json({ ok: true, enabled: true, items });
    } catch (e) { sendError(res, e); }
  });
  app.get('/api/noe/mind/memory/export', requireOwnerToken, (req, res) => {
    try {
      if (!memory?.recall) return res.json({ ok: true, enabled: false, items: [] });
      const includeHidden = req.query.includeHidden === '1';
      const items = memory.recall({ q: '', projectId: memoryProject(req), limit: capLimit(req.query.limit, 100, 500), includeHidden, bumpHits: false })
        .map(compactMemory);
      auditMemoryUi('export', 'memory-export', memoryProject(req), { exportedCount: items.length });
      res.json({ ok: true, enabled: true, exportedAt: now(), items });
    } catch (e) { sendError(res, e); }
  });
  app.get('/api/noe/mind/memory/quarantine', requireOwnerToken, (req, res) => {
    try {
      const db = dbOrNull();
      if (!db) return res.json({ ok: true, enabled: false, items: [] });
      const auditLog = new NoeMemoryAuditLog({ db });
      const decision = typeof req.query.decision === 'string' && req.query.decision ? req.query.decision.slice(0, 60) : 'quarantined';
      const items = auditLog.listCandidates({ projectId: memoryProject(req), decision, limit: capLimit(req.query.limit, 30, 200) })
        .map((item) => ({
          id: item.id,
          kind: item.kind,
          scope: item.scope,
          title: item.title,
          body: String(item.body || '').slice(0, 500),
          decision: item.decision,
          reason: item.decisionReason,
          sourceEpisodeId: item.sourceEpisodeId,
          evidenceRefs: item.evidenceRefs,
          targetMemoryId: item.targetMemoryId,
          createdAt: item.createdAt,
          decidedAt: item.decidedAt,
        }));
      res.json({ ok: true, enabled: true, decision, items });
    } catch (e) { sendError(res, e); }
  });
  app.get('/api/noe/mind/memory/candidates/:id/replay', requireOwnerToken, (req, res) => {
    try {
      const db = dbOrNull();
      if (!db) return res.json({ ok: false, enabled: false, reason: 'db_unavailable' });
      const auditLog = new NoeMemoryAuditLog({ db });
      const replay = auditLog.replayCandidate(req.params.id);
      res.status(replay.ok ? 200 : 404).json(replay);
    } catch (e) { sendError(res, e); }
  });
  app.post('/api/noe/mind/memory/hide', requireOwnerToken, (req, res) => {
    try {
      if (!memory?.hide) return res.status(409).json({ ok: false, error: '记忆库未通电' });
      const id = String((req.body || {}).id || '').slice(0, 180);
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const projectId = bodyProject(req);
      const ok = memory.hide(id, { projectId, reason: 'mind_ui_hide' });
      if (ok) auditMemoryUi('hide', id, projectId);
      res.status(ok ? 200 : 404).json({ ok, id });
    } catch (e) { sendError(res, e); }
  });
  app.post('/api/noe/mind/memory/unhide', requireOwnerToken, (req, res) => {
    try {
      if (!memory?.unhide) return res.status(409).json({ ok: false, error: '记忆库未通电' });
      const id = String((req.body || {}).id || '').slice(0, 180);
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const projectId = bodyProject(req);
      const ok = memory.unhide(id, { projectId });
      if (ok) auditMemoryUi('unhide', id, projectId);
      res.status(ok ? 200 : 404).json({ ok, id });
    } catch (e) { sendError(res, e); }
  });
  app.post('/api/noe/mind/memory/delete', requireOwnerToken, (req, res) => {
    try {
      if (!memory?.hide) return res.status(409).json({ ok: false, error: '记忆库未通电' });
      const id = String((req.body || {}).id || '').slice(0, 180);
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      const projectId = bodyProject(req);
      const ok = memory.hide(id, { projectId, reason: 'mind_ui_delete' });
      if (ok) auditMemoryUi('delete', id, projectId, { reversible: true });
      res.status(ok ? 200 : 404).json({ ok, id, reversible: true });
    } catch (e) { sendError(res, e); }
  });
  app.post('/api/noe/mind/memory/edit', requireOwnerToken, (req, res) => {
    try {
      if (!memory?.get || !memory?.write) return res.status(409).json({ ok: false, error: '记忆库未通电' });
      const body = req.body || {};
      const id = String(body.id || '').slice(0, 180);
      const nextBody = String(body.body || '').trim().slice(0, 20_000);
      if (!id) return res.status(400).json({ ok: false, error: 'id required' });
      if (nextBody.length < 2) return res.status(400).json({ ok: false, error: 'body required' });
      const existing = memory.get(id, { includeHidden: true });
      if (!existing) return res.status(404).json({ ok: false, error: '记忆不存在' });
      const projectId = String(body.projectId || existing.projectId || 'noe').slice(0, 120);
      const payload = {
        projectId,
        scope: String(body.scope || existing.scope || 'project').slice(0, 80),
        kind: String(body.kind || existing.kind || 'fact').slice(0, 80),
        title: String(body.title || existing.title || '').slice(0, 500),
        body: nextBody,
        sourceType: 'mind_ui_edit',
        sourceId: existing.sourceId,
        tags: Array.isArray(body.tags) ? body.tags : existing.tags,
        confidence: body.confidence ?? existing.confidence,
        salience: body.salience ?? existing.salience,
        validFrom: existing.validFrom,
        validTo: existing.validTo,
        sourceEpisodeId: existing.sourceEpisodeId,
        evidenceRefs: existing.sourceEpisodeId ? [`episode:${existing.sourceEpisodeId}`] : [`memory:${id}`],
        writeMode: 'owner_confirmed',
        actor: 'owner',
        targetMemoryId: id,
        mergeTrace: [...(existing.mergeTrace || []), { at: now(), reason: 'mind_ui_edit', prevSourceType: existing.sourceType }],
      };
      const r = memoryWriteGate?.commit ? memoryWriteGate.commit(payload) : { ok: true, memory: memory.write({ id, ...payload }) };
      if (r?.ok === false) return res.status(409).json({ ok: false, error: r.reason || 'memory_edit_rejected' });
      const updated = r.memory || memory.get(id, { includeHidden: true });
      auditMemoryUi('edit', id, projectId);
      res.json({ ok: true, item: compactMemory(updated) });
    } catch (e) { sendError(res, e); }
  });

  // 意识流：念头 + 深思 + 梦（最近在前，带 meta：焦点/回声/情感印记/螺旋断路）
  app.get('/api/noe/mind/thoughts', requireOwnerToken, (req, res) => {
    try {
      if (!timeline?.recent) return res.json({ ok: true, enabled: false, thoughts: [] });
      const limit = capLimit(req.query.limit, 60, 300);
      const rows = timeline.recent({ limit, types: ['inner_monologue', 'dream', 'milestone'] })
        .map((e) => ({ id: e.id, ts: e.ts, type: e.type, summary: e.summary, detail: e.detail || '', salience: e.salience, meta: e.meta || null }));
      const includeAwareness = req.query.awareness !== '0';
      const pulses = includeAwareness
        ? awarenessPulses({ date: dateOf(now()), limit: Math.min(80, limit), intervalMs: Math.max(30_000, Number(req.query.awarenessMs) || 60_000) })
        : [];
      const thoughts = [...rows, ...pulses].sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0)).slice(0, limit);
      res.json({ ok: true, enabled: true, thoughts });
    } catch (e) { sendError(res, e); }
  });

  // 心跳台账：每一跳干了什么 / 成败 / 欠账 / 崩溃恢复痕
  app.get('/api/noe/mind/ticks', requireOwnerToken, (req, res) => {
    try {
      if (process.env.NOE_HEARTBEAT !== '1') return res.json({ ok: true, enabled: false, ticks: [] });
      const s = hbStore();
      if (!s) return res.json({ ok: true, enabled: false, ticks: [] });
      const kind = typeof req.query.kind === 'string' && req.query.kind ? req.query.kind : null;
      res.json({ ok: true, enabled: true, ticks: s.recentTicks({ limit: capLimit(req.query.limit, 80, 300), kind }), cursors: s.allCursors() });
    } catch (e) { sendError(res, e); }
  });

  // 情感曲线：VAD 快照序列（默认 24h）
  app.get('/api/noe/mind/affect', requireOwnerToken, (req, res) => {
    try {
      if (!affectEngine) return res.json({ ok: true, enabled: false, history: [] });
      const hours = capLimit(req.query.hours, 24, 24 * 14);
      res.json({ ok: true, enabled: true, now: affectEngine.snapshot(), history: affectEngine.history({ limit: 1000, sinceTs: now() - hours * 3600_000 }) });
    } catch (e) { sendError(res, e); }
  });

  // 期望账本：未结算 / 到期待裁决 / 已结算（含 surprise）/ 校准
  app.get('/api/noe/mind/expectations', requireOwnerToken, (req, res) => {
    try {
      if (!expectationLedger) return res.json({ ok: true, enabled: false });
      res.json({
        ok: true,
        enabled: true,
        due: expectationLedger.due(now()),
        open: expectationLedger.open({ limit: 100 }),
        history: expectationLedger.history({ limit: 100 }).filter((r) => r.resolved_at),
        brier: expectationLedger.brier(),
        calibrationNote: expectationLedger.calibrationNote(),
      });
    } catch (e) { sendError(res, e); }
  });

  // 裁决一条预测：outcome=1 应验 / 0 落空 / null 判不了。高惊奇 → 好奇回路立研究目标 + 情感评估。
  app.post('/api/noe/mind/expectations/resolve', requireOwnerToken, (req, res) => {
    try {
      if (!expectationLedger) return res.status(409).json({ ok: false, error: '期望账本未通电（NOE_EXPECTATIONS）' });
      const body = req.body || {};
      const id = Number(body.id);
      if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ ok: false, error: 'id 非法' });
      const outcome = body.outcome === 1 || body.outcome === true ? 1 : body.outcome === 0 || body.outcome === false ? 0 : null;
      const r = expectationLedger.resolve(id, outcome, undefined, 'owner'); // P2-F2：owner 手动裁决 = holdout 旁证（非本地脑自评）
      if (!r) return res.status(404).json({ ok: false, error: '不存在或已结算' });
      let curiosityGoalId = null;
      if (outcome !== null && Number(r.surprise) >= 2 && goalSystem && process.env.NOE_CURIOSITY === '1') {
        try { curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise: r.surprise, origin: outcome === 0 ? 'owner_manual' : undefined }); } catch { /* 好奇失败不阻断裁决 */ } // P1-C 整改 F4+F4-REOPEN：仅 owner 手动判落空(outcome=0)标 owner_manual 非噪声；应验(outcome=1)的高惊奇不误计入门 b，与 resolver/predictor 的 outcome===0 闸一致
      }
      if (outcome !== null && affectEngine) {
        // 被裁决=一次现实反馈：应验微暖；落空保留 novelty→唤醒上扬（好奇/警觉，注意力信号，原设计精神）。
        // NOE_AFFECT_NEGATIVE 开时落空给中等 valence(-0.3)：owner 主动裁决「判错了」该有承认挫败的分量，但不重击
        // （act 失败的 setback=-0.5 才是 v 跌主力，预测落空是次要信号）；默认 OFF 保持原 -0.1。
        // P4 step0：被裁决也带 agency（复活 dominance）——应验=判对了的掌控感，落空=判错了使不上劲。
        // P4 改进（多模型审 finding B）：agency 随 surprise 分级，别让小应验和惊天应验掌控感一样满。
        //   应验=有掌控但越惊讶越小（0.7 起、下限 0.5）；落空=低掌控且越惊讶越低（0.3 起、上限 0.5）。
        const surprise = Number(r.surprise) || 0;
        const agency = outcome === 1 ? Math.max(0.5, 0.7 - 0.1 * surprise) : Math.min(0.5, 0.3 + 0.05 * surprise);
        try { affectEngine.appraise({ goalCongruence: outcome === 1 ? 0.3 : (process.env.NOE_AFFECT_NEGATIVE === '1' ? -0.3 : -0.1), novelty: Math.min(1, surprise / 4), agency }, { cause: `expectation:${id}` }); } catch { /* 评估失败忽略 */ }
      }
      // 主人裁决=明确"在理 Noe"的互动（A1 修复，2026-06-11）：回应判定/工作区 owner 信号的数据源。
      // 聊天室刻意不记 interaction（对象是任意 AI，见 SoloChatDispatcher 注释）→ 透视页操作是文字时代
      // owner-Noe 互动的主通道，必须记，否则开口回应永远 miss、冷却被放宽到 4h（实损：30 天回应率 0%）。
      try { timeline?.record?.({ type: 'interaction', summary: `主人裁决了我的预测「${String(r.claim || '').slice(0, 30)}」：${outcome === 1 ? '应验' : outcome === 0 ? '落空' : '判不了'}`, salience: 3 }); } catch { /* 留痕失败不阻断 */ }
      res.json({ ok: true, resolved: r, curiosityGoalId });
    } catch (e) { sendError(res, e); }
  });

  // 目标库：看 + 主人直接立 owner 目标 + 状态操作
  // ——— P2 觉醒看板：活性可观测只读数据源（纯只读、零写入） ———
  const sinceTsFromDays = (q) => { const d = Math.max(0, Number(q?.days) || 0); return d > 0 ? now() - d * 86400000 : 0; };

  // ① 期望校准曲线（Brier/ECE/MCE + n-bin reliability，与 sklearn 逐位一致）
  app.get('/api/noe/mind/calibration', requireOwnerToken, (req, res) => {
    try {
      if (!expectationLedger?.calibration) return res.json({ ok: true, enabled: false });
      const binCount = Math.max(2, Math.min(50, Number(req.query?.bins) || 10));
      res.json({ ok: true, enabled: true, ...expectationLedger.calibration({ sinceTs: sinceTsFromDays(req.query), binCount }) });
    } catch (e) { sendError(res, e); }
  });

  // ② curiosity-yield 漏斗（期望立 N→判证 M→落空 K→harvestSurprise→完成 J）
  app.get('/api/noe/mind/curiosity-funnel', requireOwnerToken, (req, res) => {
    try {
      const db = dbOrNull();
      if (!db || typeof curiosityReport !== 'function') return res.json({ ok: true, enabled: false });
      res.json({ ok: true, enabled: true, ...curiosityReport(db, { sinceTs: sinceTsFromDays(req.query), now: now() }) });
    } catch (e) { sendError(res, e); }
  });

  // ③ 整合度 TC 历史趋势线（最新读数 + 有限历史）
  app.get('/api/noe/mind/integration/history', requireOwnerToken, (req, res) => {
    try {
      const limit = Math.max(1, Math.min(2000, Number(req.query?.limit) || 288));
      const history = createIntegrationHistory({ kv, now }).read({ limit, sinceTs: sinceTsFromDays(req.query) });
      res.json({ ok: true, enabled: true, latest: kv.get?.('noe.integration.reading') || null, history });
    } catch (e) { sendError(res, e); }
  });

  // ④ 本地模型存活（ollama/LM Studio ping + 三脑就位 + embedding 后端）— 纯 GET ping，绝不 load/chat
  app.get('/api/noe/mind/model-health', requireOwnerToken, async (req, res) => {
    try {
      const probe = createModelHealthProbe({
        discover: () => discoverLocalModelProviders({}),
        dimHealth: () => {
          try {
            const db = dbOrNull();
            if (!db) return {};
            const sp = buildNoeMemoryStatus({ db, now })?.semanticProvider || {};
            const dh = sp.dimHealth || {};
            const dims = dh.dims && typeof dh.dims === 'object' ? Object.keys(dh.dims).map(Number).filter(Boolean) : [];
            return {
              provider: sp.enabled ? (sp.provider || 'ollama') : 'hash',
              dimension: dims.length ? Math.max(...dims) : null,
              degraded: typeof dh.queryDimOrphaned === 'boolean' ? dh.queryDimOrphaned : null,
              orphanEventCount: Number(dh.orphanEventCount) || 0,
            };
          } catch { return {}; }
        },
        now,
      });
      res.json({ ok: true, ...(await probe.probe()) });
    } catch (e) { sendError(res, e); }
  });

  // ⑤ 撞墙信号检测（P2-F1 防 Goodhart：整合度过度同步 / 独白空转）— 检测+告警始终活，回滚执行由 NOE_WALL_GUARD 门控
  app.get('/api/noe/mind/wall-signals', requireOwnerToken, (req, res) => {
    try {
      const history = createIntegrationHistory({ kv, now }).read({ limit: 10 });
      const db = dbOrNull();
      let monologue7d = 0;
      if (db) {
        try { monologue7d = Number(db.prepare("SELECT COUNT(*) n FROM events WHERE kind='noe_self_talk_audit' AND ts >= ?").get(now() - 7 * 86400000)?.n) || 0; } catch { /* fail-open */ }
      }
      // R2：目标系统不在场传 activeGoals=null（idle_rumination 不检测），避免假 0 报幻象告警（与心跳侧守卫一致）。
      const stats = goalSystem ? goalSystem.stats() : null;
      const activeGoals = stats ? (Number(stats.open) || 0) + (Number(stats.active) || 0) : null;
      const result = detectWallSignals({ integrationHistory: history, monologue7d, activeGoals });
      res.json({ ok: true, ...result, guardEnabled: process.env.NOE_WALL_GUARD === '1', inputs: { integrationSamples: history.length, monologue7d, activeGoals } });
    } catch (e) { sendError(res, e); }
  });

  // ⑥ 觉醒候选信号 4 维采样（D1 预测-学习 / D2 整合度 / D3 校准 / D4 自发性）——真 sampleAwakening（含独白/episode/自主目标），
  //   非其他面板拼凑；D4 自发性维度此前在前端整条丢失（三方审查 serious），此 endpoint 补真值 + 采样时间 + liveDbMutated:false。纯只读零写入。
  app.get('/api/noe/mind/awakening-signals', requireOwnerToken, (req, res) => {
    try {
      const db = dbOrNull();
      if (!db) return res.json({ ok: true, enabled: false });
      res.json({ ok: true, enabled: true, ...sampleAwakening(db, { now: now() }) });
    } catch (e) { sendError(res, e); }
  });

  // ⑦ 自进化健康 SLO（P9 觉醒可见性补缺）：把 NoeSelfEvolutionSlo 的纯只读聚合搬上看板——
  //   implementer/apply/runtime_verify 三阶段成功率 + 失败归因 topN + 显式 durationMs 百分位（无可靠耗时源时给 null+说明）。
  //   纯只读零写入；无产物目录时聚合器返回零值结构不抛（fail-open），故无数据=空聚合而非报错。
  app.get('/api/noe/mind/self-evolution', requireOwnerToken, (req, res) => {
    try {
      // P9-fix(Codex):传 root: rootDir——否则隔离 root/多 checkout/测试临时 root 会读默认真实仓库产物(与同文件其他 route 一致)。
      const slo = selfEvolutionSlo({ now: () => new Date(now()), root: rootDir });
      // P0.6 owner 实时可观测：open/active 的 self_evolution goal + 其当前 cycle stage（owner 一眼看到 Neo 此刻
      //   进化到哪步、有没有卡 stuck），不只 SLO 统计。best-effort：cycle 读失败不影响 slo（fail-open）。
      let cycles = [];
      try {
        const db = proofDb || (() => { try { return getDb(); } catch { return null; } })();
        if (db && goalSystem) {
          const store = new NoeSelfEvolutionCycleStore({ db, now: () => new Date(now()) });
          const goals = (goalSystem.list({ limit: 100 }) || []).filter((g) => g && g.source === 'self_evolution' && (g.status === 'open' || g.status === 'active'));
          cycles = goals.map((g) => {
            const c = store.getByGoal(g.id);
            return { goalId: g.id, title: String(g.title || '').slice(0, 120), goalStatus: g.status, stage: c ? c.stage : null, cycleId: c ? c.cycleId : null, updatedAt: c ? c.updatedAt : null };
          });
        }
      } catch { /* cycle 可观测 best-effort，不影响 slo */ }
      res.json({ ok: true, enabled: true, slo, cycles });
    } catch (e) { sendError(res, e); }
  });

  app.get('/api/noe/mind/goals', requireOwnerToken, (req, res) => {
    try {
      if (!goalSystem) return res.json({ ok: true, enabled: false, goals: [] });
      res.json({ ok: true, enabled: true, goals: goalSystem.list({ limit: 100 }), stats: goalSystem.stats() });
    } catch (e) { sendError(res, e); }
  });
  app.post('/api/noe/mind/goals', requireOwnerToken, (req, res) => {
    try {
      if (!goalSystem) return res.status(409).json({ ok: false, error: '目标系统未通电（NOE_GOALS）' });
      const body = req.body || {};
      if (JSON.stringify(body).length > 4000) return res.status(413).json({ ok: false, error: 'body 过大' });
      // owner 可 seed 的目标来源（白名单）：owner（默认，透视页交办）/ self_evolution（owner 给自进化飞轮喂高质量技术目标，
      //   v3 P2 owner-seed；selfEvolve 心跳取 source=self_evolution 的 open 目标推进 cycle）。其余来源拒（防误注入 surprise/drive 等内部源）。
      const ALLOWED_GOAL_SOURCES = new Set(['owner', 'self_evolution']);
      const source = ALLOWED_GOAL_SOURCES.has(String(body.source)) ? String(body.source) : 'owner';
      const why = body.why || (source === 'self_evolution' ? '主人 seed 的自我进化技术目标' : '主人在透视页直接交办');
      const steps = Array.isArray(body.steps) ? body.steps : [];
      const title = String(body.title || '').slice(0, 200); // 与 goal 表上限对齐：候选与升格目标 title 一致
      const title40 = title.slice(0, 40);
      // baseScore 规整：容忍字符串数字（owner 经 JSON 可能传 "0.9"），非数值回退 undefined（候选池用默认 0.6）。
      const baseScore = Number.isFinite(Number(body.baseScore)) ? Number(body.baseScore) : undefined;

      // P2 切片A（advisory frame）：NOE_CANDIDATE_POOL=1 时 owner-seed 先进候选池打分——owner 权重最高(1.0)
      //   几乎总过阈采纳（≈directive 体验），低权重源会被 Neo 拒并记理由（自主体），owner 可 override。
      //   OFF（默认）逐字走现状 directive，零回归。信任模型变更（directive→advisory）的点火权属 owner。
      if (process.env.NOE_CANDIDATE_POOL === '1') {
        const store = gcStore();
        if (!store) return res.status(409).json({ ok: false, error: '候选池存储不可用' });
        const pool = createCandidatePool({
          store,
          // promote：采纳时升格真目标（闭包捕获本次 steps；候选池本身不持久化 steps）。
          // 已知限制：promote 成功后若 store.update 抛错（磁盘满/库锁等极罕见），会 500 且目标已建、候选仍 pending
          //   （noe_goals 与 noe_goal_candidates 两表非原子）。概率极低、目标已达成、有 500 提示，本切片不引入跨模块事务。
          promote: (c) => goalSystem.add({ title: c.title, why: c.why, source: c.source, steps }),
          now,
        });
        // 每请求 new pool（seq 会重置），故传完整 randomUUID 显式 id 防跨请求撞 id（同毫秒高并发也唯一）。
        const cand = pool.submit({ id: `cand-${now()}-${randomUUID()}`, source, title, why, baseScore });
        const decided = pool.decide(cand.id);
        if (decided && decided.decision === 'accepted') {
          // promote 返回 null = title 非法/同名（goalSystem.add 拒）。把候选回滚为 rejected（记理由），避免候选表
          //   残留 accepted+goal_id=null 的孤儿行（mind.html 会误显示"已采纳"），HTTP 错误语义与现状一致。
          if (!decided.goal_id) {
            try { store.update(cand.id, { decision: 'rejected', reject_reason: 'title 非法或同名目标已存在（升格失败）' }); } catch { /* 回滚留痕失败不阻断 */ }
            return res.status(400).json({ ok: false, error: 'title 非法或同名目标已存在', candidate: cand.id });
          }
          try { goalSystem.arbitrate(); } catch { /* 下个周期会仲裁 */ }
          try { timeline?.record?.({ type: 'interaction', summary: `主人交办的目标「${title40}」我打分后采纳了`, salience: 3 }); } catch { /* 留痕失败不阻断 */ }
          return res.json({ ok: true, id: decided.goal_id, candidate: cand.id, decision: 'accepted', score: decided.score });
        }
        try { timeline?.record?.({ type: 'interaction', summary: `「${title40}」我打分后未采纳：${String(decided?.reject_reason || '').slice(0, 60)}`, salience: 3 }); } catch { /* 留痕失败不阻断 */ }
        return res.json({ ok: true, id: null, candidate: cand.id, decision: 'rejected', score: decided?.score, reject_reason: decided?.reject_reason || '' });
      }

      // 现状 directive（NOE_CANDIDATE_POOL 未开）：owner 的话直接升格目标。
      const id = goalSystem.add({ title, why, source, steps });
      if (!id) return res.status(400).json({ ok: false, error: 'title 非法或同名目标已存在' });
      try { goalSystem.arbitrate(); } catch { /* 下个周期会仲裁 */ }
      try { timeline?.record?.({ type: 'interaction', summary: `主人交办了目标「${title40}」`, salience: 3 }); } catch { /* 留痕失败不阻断 */ }
      res.json({ ok: true, id });
    } catch (e) { sendError(res, e); }
  });
  // P2 切片A：候选池视图（mind.html）。NOE_CANDIDATE_POOL 未开时 enabled:false（fail-open）。
  app.get('/api/noe/mind/goal-candidates', requireOwnerToken, (req, res) => {
    try {
      if (process.env.NOE_CANDIDATE_POOL !== '1') return res.json({ ok: true, enabled: false, candidates: [] });
      const store = gcStore();
      if (!store) return res.json({ ok: true, enabled: false, candidates: [] });
      const decision = ['pending', 'accepted', 'rejected'].includes(String(req.query.decision)) ? String(req.query.decision) : undefined;
      res.json({ ok: true, enabled: true, candidates: store.list({ decision, limit: 100 }) });
    } catch (e) { sendError(res, e); }
  });
  app.post('/api/noe/mind/goals/status', requireOwnerToken, (req, res) => {
    try {
      if (!goalSystem) return res.status(409).json({ ok: false, error: '目标系统未通电（NOE_GOALS）' });
      const { id, status } = req.body || {};
      if (!goalSystem.get(String(id))) return res.status(404).json({ ok: false, error: '目标不存在' });
      if (!goalSystem.setStatus(String(id), String(status))) return res.status(400).json({ ok: false, error: 'status 非法' });
      try { timeline?.record?.({ type: 'interaction', summary: `主人把我的一个目标调成了 ${String(status).slice(0, 20)}`, salience: 3 }); } catch { /* 留痕失败不阻断 */ }
      res.json({ ok: true });
    } catch (e) { sendError(res, e); }
  });

  // 手动踩一拍（实机操控/验证）：立即跑一个心跳作业（meso=轻量注意力 / innerReflect=重反刍 / maintenance=维护刷新）
  app.post('/api/noe/mind/tick', requireOwnerToken, async (req, res) => {
    try {
      if (!heartbeat?.runNow) return res.status(409).json({ ok: false, error: '心跳未通电（NOE_HEARTBEAT）' });
      const kind = String((req.body || {}).kind || 'meso');
      if (!['meso', 'innerReflect', 'maintenance', 'micro', 'proactive', 'expectation'].includes(kind)) return res.status(400).json({ ok: false, error: 'kind 须为 meso|innerReflect|maintenance|micro|proactive|expectation' });
      const r = await heartbeat.runNow(kind);
      return res.status(r.ok ? 200 : 500).json(r);
    } catch (e) { sendError(res, e); }
  });

  // 自审仪表（M5）：他今天"活得真不真"——念头语义多样性 / 接地率 / 今日认知活动统计。
  // 嵌入计算有成本 → 服务端缓存 5 分钟（?fresh=1 强刷）。
  let vitalsCache = { at: 0, data: null };
  app.get('/api/noe/mind/vitals', requireOwnerToken, async (req, res) => {
    try {
      if (!timeline?.recent || !mindVitals) return res.json({ ok: true, enabled: false });
      const t = now();
      if (vitalsCache.data && t - vitalsCache.at < 5 * 60_000 && req.query.fresh !== '1') {
        return res.json({ ok: true, enabled: true, cached: true, ...vitalsCache.data });
      }
      const thoughts = timeline.recent({ limit: 40, types: ['inner_monologue'] }).slice(0, 20);
      const div = await mindVitals.diversity(thoughts.map((e) => ({ key: `ep:${e.id}`, text: e.summary })));
      const withG = thoughts.filter((e) => e.meta?.grounding && Number.isFinite(e.meta.grounding.score));
      const groundedRate = withG.length
        ? Math.round((withG.filter((e) => e.meta.grounding.score >= 0.45).length / withG.length) * 100) / 100
        : null;
      const journal = { attend: 0, escalated: 0, surfacedPass: 0 };
      try {
        const date = new Date(t).toISOString().slice(0, 10);
        const file = join(dataDir || '', 'consciousness', `${date}.jsonl`);
        if (dataDir && existsSync(file)) {
          for (const l of readFileSync(file, 'utf8').trimEnd().split('\n')) {
            try {
              const j = JSON.parse(l);
              if (j.kind === 'attend') { journal.attend++; if (j.escalated) journal.escalated++; }
              else if (j.kind === 'surfacing' && j.pass) journal.surfacedPass++;
            } catch { /* 坏行跳过 */ }
          }
        }
      } catch { /* 日志统计失败不阻断 */ }
      const data = {
        ts: t,
        thoughtCount: thoughts.length,
        avgSim: div.avgSim,
        diversity: div.diversity,
        groundedRate,
        groundedSampled: withG.length,
        journal,
      };
      vitalsCache = { at: t, data };
      res.json({ ok: true, enabled: true, cached: false, ...data });
    } catch (e) { sendError(res, e); }
  });

  // 意识日志：工作区每周期"注意到什么/为什么/落选者"的 JSONL 尾部
  app.get('/api/noe/mind/journal', requireOwnerToken, (req, res) => {
    try {
      if (!dataDir) return res.json({ ok: true, enabled: false, lines: [] });
      const date = typeof req.query.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date)
        ? req.query.date
        : new Date(now()).toISOString().slice(0, 10);
      if (!existsSync(journalFileFor(date))) return res.json({ ok: true, enabled: process.env.NOE_WORKSPACE === '1', date, lines: [] });
      const limit = capLimit(req.query.limit, 200, 1000);
      const lines = readJournalTail(date, limit).reverse();
      res.json({ ok: true, enabled: true, date, lines });
    } catch (e) { sendError(res, e); }
  });
}
