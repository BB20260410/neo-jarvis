// @ts-check
// Noe — rooms-advanced 域 routes ①：report / runtime-processes / task-ops / lifecycle (S23)
// 从 server.js 提取 9 条路由（拆前行号 2109-2309 / 2439-2453 / 2461-2500 / 2787-2955），行为完全一致。
// roomStore / roomAdapterPool / 各 dispatcher / broadcastRoom / broadcastGlobal / prepareClusterRunGate /
// runClusterRuntimeWatchdogOnce / send500 / collectPanelRuntimeProcesses 是 server.js 核心闭包/共享单例，
// 走 deps 注入（拆分时均为已赋值 const，直接传值，无需 getter）；reportJobs（ReportJobStore 实例）随迁本模块，
// POST /api/rooms/:id/report 与 GET /api/reports/:jobId 共享同一实例。
// 分 4 个 register 函数：server.js 在各原位置分别调用，保持 Express 注册顺序与拆前逐条一致。
// 同域其余 5 条：forward/quick 在 roomsForward.js，media×2+chat 在 roomsMedia.js（守 <500 行规则分文件）。

import { randomUUID } from 'crypto';
import { requireOwnerToken } from '../auth/owner-token.js';
import { ReportJobStore } from '../../report/ReportJobStore.js';

// v0.54 Sprint 9 + v0.55 Sprint 14 F1：改异步 job（修 Load failed —— Safari fetch >60s 超时报"Load failed"）
// body: { adapterId?, model?, outputPath?, autoPath?: boolean }
// 立即返 { ok, jobId, status:'queued' }，后台跑 generateReport，完成 broadcastGlobal report_done / report_error
// ① 报告异步 job 2 条（server.js 原 2109-2309 位置调用）
export function registerRoomsReportRoutes(app, deps) {
  const {
    roomStore, roomAdapterPool, safeResolveFsPathForWrite, archiveStore,
    defaultReportPath, generateReport, permissionGovernance, permissionApprovalIdFromRequest,
    permissionHttpStatus, permissionHttpBody, activityLog, metricsStore, broadcastGlobal,
  } = deps;

  const reportJobs = new ReportJobStore({ ttlMs: 60 * 60 * 1000, maxJobs: 50 });

  app.post('/api/rooms/:id/report', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'room not found' });
    const { adapterId = 'claude', model = '', outputPath: rawPath, autoPath } = req.body || {};
    const adapter = roomAdapterPool.get(adapterId);
    if (!adapter) return res.status(400).json({ error: `adapter ${adapterId} 未注册或未启用` });

    // outputPath：优先 body.outputPath；其次 autoPath=true 时用 archive rootPath 自动生成；否则不写盘
    let outputPath = null;
    if (typeof rawPath === 'string' && rawPath.trim()) {
      if (rawPath.length > 1024) return res.status(400).json({ error: 'outputPath 过长' });
      // 报告通常写新文件 → 用 ForWrite 变体（允许文件不存在，父目录必须合法）
      const safe = safeResolveFsPathForWrite(rawPath.trim());
      if (!safe) return res.status(403).json({ error: 'outputPath 越权或敏感目录' });
      outputPath = safe;
    } else if (autoPath === true) {
      const archiveCfg = archiveStore.getConfig();
      outputPath = defaultReportPath(r, archiveCfg.rootPath);
    }
    if (outputPath) {
      const permission = permissionGovernance.evaluatePermission({
        actorType: 'owner',
        actorId: 'local-owner',
        roomId: r.id,
        approvalId: permissionApprovalIdFromRequest(req),
        action: 'file.write',
        cwd: r.cwd || process.cwd(),
        risk: 'high',
        target: { section: 'reports', operation: 'write_report', path: outputPath },
      });
      if (permission && permission.decision !== 'allow') {
        return res.status(permissionHttpStatus(permission)).json(permissionHttpBody(permission));
      }
    }

    // 立返 jobId（202 Accepted），后台跑
    const jobId = 'rpt-' + randomUUID().slice(0, 12);
    reportJobs.create({ jobId, roomId: r.id, adapterId, model, outputPath });
    activityLog.recordSafe({
      action: 'report.queued',
      actorType: 'user',
      roomId: r.id,
      entityType: 'report_job',
      entityId: jobId,
      status: 'queued',
      details: { adapterId, model: model || '', outputPath: outputPath || null, roomName: r.name, roomMode: r.mode },
    });
    res.status(202).json({ ok: true, jobId, status: 'queued' });

    // fire-and-forget
    (async () => {
      const startedAt = Date.now();
      reportJobs.update(jobId, { status: 'running', startedAt: new Date(startedAt).toISOString() });
      activityLog.recordSafe({
        action: 'report.running',
        actorType: 'system',
        roomId: r.id,
        entityType: 'report_job',
        entityId: jobId,
        status: 'running',
        details: { adapterId, model: model || '' },
      });
      try {
        const result = await generateReport({ room: r, adapter, model, outputPath });
        if (!result.ok) {
          const job = reportJobs.update(jobId, {
            status: 'error',
            error: result.error,
            elapsedMs: result.elapsedMs || (Date.now() - startedAt),
          });
          activityLog.recordSafe({
            action: 'report.error',
            actorType: 'system',
            roomId: r.id,
            entityType: 'report_job',
            entityId: jobId,
            status: 'error',
            severity: 'error',
            details: {
              error: result.error,
              elapsedMs: result.elapsedMs || (Date.now() - startedAt),
              adapterId,
              model: model || '',
            },
          });
          broadcastGlobal({
            type: 'report_error',
            jobId,
            roomId: r.id,
            error: job?.error || result.error,
            elapsedMs: job?.elapsedMs || result.elapsedMs || (Date.now() - startedAt),
          });
          return;
        }
        try {
          metricsStore.record({
            roomId: r.id, roomMode: 'report', roomName: r.name,
            projectId: r.cwd,
            turn: 'report:' + r.mode,
            adapter: adapter.id || adapterId, model: model || '',
            latencyMs: result.elapsedMs,
            tokensIn: result.tokensIn, tokensOut: result.tokensOut,
            success: true, errorKind: null,
          });
        } catch {}
        const job = reportJobs.update(jobId, {
          status: 'done',
          content: result.content,
          path: result.path,
          tokensIn: result.tokensIn,
          tokensOut: result.tokensOut,
          elapsedMs: result.elapsedMs,
          truncated: result.truncated,
          sourceContentChars: result.sourceContentChars,
          sourceContentLimit: result.sourceContentLimit,
          reportStrategy: result.reportStrategy,
          chunkCount: result.chunkCount,
          omittedChars: result.omittedChars,
          retryReason: result.retryReason,
          assertionFailed: result.assertionFailed || [],
        });
        activityLog.recordSafe({
          action: 'report.done',
          actorType: 'system',
          roomId: r.id,
          entityType: 'report_job',
          entityId: jobId,
          status: 'done',
          details: {
            adapterId,
            model: model || '',
            path: result.path || null,
            tokensIn: result.tokensIn || 0,
            tokensOut: result.tokensOut || 0,
            elapsedMs: result.elapsedMs || 0,
            reportStrategy: result.reportStrategy || null,
            chunkCount: result.chunkCount || 0,
          },
        });
        broadcastGlobal({
          type: 'report_done',
          jobId,
          roomId: r.id,
          content: job?.content || result.content,
          path: job?.path || result.path,
          tokensIn: job?.tokensIn || result.tokensIn,
          tokensOut: job?.tokensOut || result.tokensOut,
          elapsedMs: job?.elapsedMs || result.elapsedMs,
          truncated: job?.truncated ?? result.truncated,
          sourceContentChars: job?.sourceContentChars ?? result.sourceContentChars,
          sourceContentLimit: job?.sourceContentLimit ?? result.sourceContentLimit,
          reportStrategy: job?.reportStrategy ?? result.reportStrategy,
          chunkCount: job?.chunkCount ?? result.chunkCount,
          omittedChars: job?.omittedChars ?? result.omittedChars,
          retryReason: job?.retryReason ?? result.retryReason,
          assertionFailed: job?.assertionFailed || result.assertionFailed || [],   // v0.70.2-t2
        });
      } catch (e) {
        const job = reportJobs.update(jobId, {
          status: 'error',
          error: e.message || String(e),
          elapsedMs: Date.now() - startedAt,
        });
        activityLog.recordSafe({
          action: 'report.error',
          actorType: 'system',
          roomId: r.id,
          entityType: 'report_job',
          entityId: jobId,
          status: 'error',
          severity: 'error',
          details: {
            error: e.message || String(e),
            elapsedMs: Date.now() - startedAt,
            adapterId,
            model: model || '',
          },
        });
        broadcastGlobal({
          type: 'report_error',
          jobId,
          roomId: r.id,
          error: job?.error || e.message || String(e),
          elapsedMs: job?.elapsedMs || (Date.now() - startedAt),
        });
      }
    })();
  });

  app.get('/api/reports/:jobId', requireOwnerToken, (req, res) => {
    const jobId = String(req.params.jobId || '');
    if (!/^rpt-[a-f0-9-]{8,40}$/i.test(jobId)) return res.status(400).json({ ok: false, error: 'jobId 非法' });
    const job = reportJobs.get(jobId);
    if (!job) return res.status(404).json({ ok: false, error: 'report job not found' });
    res.json({ ok: true, job });
  });
}

// ② GET /api/rooms/:id/runtime-processes（server.js 原 2439-2453 位置调用）
export function registerRoomsRuntimeProcessesRoutes(app, deps) {
  const { roomStore, collectPanelRuntimeProcesses } = deps;

  app.get('/api/rooms/:id/runtime-processes', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ ok: false, error: 'room not found' });
    const snapshot = collectPanelRuntimeProcesses();
    res.json({
      ok: snapshot.ok,
      error: snapshot.error || null,
      generatedAt: new Date().toISOString(),
      roomId: r.id,
      roomStatus: r.status,
      roomCwd: r.cwd || '',
      panelPid: process.pid,
      processes: snapshot.processes || [],
    });
  });
}

// v0.42 用户中途注入提示给某个 task（squad 模式专用）
const INJECT_MAX_LEN = 32000;      // v0.52 极限 32000：长 prompt 也能塞
const INJECT_MAX_COUNT = 50;       // v0.52 20→50
// ③ task 注入 + attempts diff 2 条（server.js 原 2461-2500 位置调用）
export function registerRoomsTaskOpsRoutes(app, deps) {
  const { roomStore, broadcastRoom, send500 } = deps;

  app.post('/api/rooms/:id/tasks/:tid/inject', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'room not found' });
    const content = String(req.body?.content || '').trim();
    if (!content) return res.status(400).json({ error: 'content required' });
    if (content.length > INJECT_MAX_LEN) return res.status(413).json({ error: `content too long (max ${INJECT_MAX_LEN})` });
    const t = (r.taskList || []).find(x => x.id === req.params.tid);
    if (!t) return res.status(404).json({ error: 'task not found' });
    if (!Array.isArray(t.userInjections)) t.userInjections = [];
    if (t.userInjections.length >= INJECT_MAX_COUNT) return res.status(429).json({ error: `too many injections (max ${INJECT_MAX_COUNT})` });
    const inj = { at: new Date().toISOString(), content };
    t.userInjections.push(inj);
    roomStore.save();
    broadcastRoom(r.id, { type: 'task_injection_added', taskId: t.id, injection: inj });
    res.json({ ok: true, injection: inj });
  });

  // v0.70 W8 集成：squad task 多次 attempt 之间的 diff（学自 aider/Cline）
  // GET /api/rooms/:id/tasks/:tid/diff?from=N&to=M  → unified diff + added/removed 行数
  app.get('/api/rooms/:id/tasks/:tid/diff', requireOwnerToken, async (req, res) => {
    try {
      const r = roomStore.get(req.params.id);
      if (!r) return res.status(404).json({ error: 'room not found' });
      const t = (r.taskList || []).find(x => x.id === req.params.tid);
      if (!t) return res.status(404).json({ error: 'task not found' });
      const attempts = t.attempts || [];
      if (attempts.length < 2) return res.json({ ok: true, diff: null, reason: 'need ≥2 attempts' });
      const from = parseInt(req.query.from, 10);
      const to = parseInt(req.query.to, 10);
      const a = Number.isFinite(from) ? attempts[from] : attempts[attempts.length - 2];
      const b = Number.isFinite(to) ? attempts[to] : attempts[attempts.length - 1];
      if (!a || !b) return res.status(400).json({ error: 'invalid from/to' });
      const { diffAttempts } = await import('../../room/learned/squad-diff-preview.js');
      const d = diffAttempts(a, b);
      res.json({ ok: true, diff: d, fromIdx: attempts.indexOf(a), toIdx: attempts.indexOf(b) });
    } catch (e) { send500(res, e); }
  });
}

// ④ 房间生命周期 4 条：retry-turn / retry-task / resume / abort（server.js 原 2787-2955 位置调用）
export function registerRoomsLifecycleRoutes(app, deps) {
  const {
    roomStore, debateDispatcher, squadDispatcher, arenaDispatcher, soloChatDispatcher,
    crossVerifyDispatcher, runClusterRuntimeWatchdogOnce, prepareClusterRunGate,
    roomAdapterPool, broadcastRoom, send500,
  } = deps;

  // v0.52 Sprint1-D：局部重试单个 turn（仅辩论房）
  app.post('/api/rooms/:id/retry-turn', requireOwnerToken, async (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'room not found' });
    if (r.mode !== 'debate' && r.mode !== 'arena') {
      return res.status(400).json({ error: `${r.mode} 房暂不支持局部重试` });
    }
    const { kind, speaker } = req.body || {};
    if (!kind || !speaker) return res.status(400).json({ error: 'kind + speaker required' });
    if (!/^(r[123])_(propose|critique|final)(?:@\d+)?$|^proposals$|^arena_judge$/.test(kind)) {
      return res.status(400).json({ error: 'kind 格式不合法' });
    }
    if (!/^[a-z][a-z0-9:_-]{0,79}$/i.test(speaker)) {
      return res.status(400).json({ error: 'speaker 格式不合法' });
    }
    try {
      const dispatcher = r.mode === 'arena' ? arenaDispatcher : debateDispatcher;
      if (typeof dispatcher.retryTurn !== 'function') {
        return res.status(501).json({ error: `${r.mode} 房 dispatcher 暂未实现 retryTurn` });
      }
      const result = await dispatcher.retryTurn(req.params.id, kind, speaker);
      res.json({ ok: true, turn: result.turn });
    } catch (e) {
      send500(res, e);
    }
  });

  // v0.54 Sprint 6：squad 房单 task 重试（reset 该 task + 连带下游 + 触发 resume）
  // cross_verify 房也允许手动重试 task：用于清理路径污染/旧轮次/旧输出后重跑当前阶段。
  app.post('/api/rooms/:id/retry-task', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'room not found' });
    const { taskId } = req.body || {};
    if (!taskId || typeof taskId !== 'string') return res.status(400).json({ error: 'taskId required' });
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,40}$/.test(taskId)) return res.status(400).json({ error: 'taskId 格式不合法' });
    const mode = r.mode || 'debate';
    if (mode === 'squad') {
      if (r.status === 'running') return res.status(409).json({ error: '房间正在运行中，请先 ⏹ 暂停再重试 task' });
      // 先返 ok，dispatcher 在后台跑（retryTask 内部 await this.start，是长任务）
      res.json({ ok: true, mode });
      squadDispatcher.retryTask(req.params.id, taskId).catch((e) => {
        console.warn('squad retryTask failed:', e.message);
        try {
          broadcastRoom(req.params.id, { type: 'task_retry_error', taskId, error: e.message });
        } catch {}
      });
      return;
    }
    if (mode === 'cross_verify') {
      res.json({ ok: true, mode, taskId });
      crossVerifyDispatcher.retryTask(req.params.id, taskId, { resumeSource: 'manual_retry' }).catch((e) => {
        console.warn('cross_verify retryTask failed:', e.message);
        try {
          broadcastRoom(req.params.id, { type: 'task_retry_error', taskId, error: e.message });
        } catch {}
      });
      return;
    }
    res.status(400).json({ error: `${mode} 房不支持单 task 重试` });
  });

  // v0.52 续跑：从未完成阶段继续（保留已有 R1/R2/R3 / taskList 产出）
  // 支持 debate / squad
  app.post('/api/rooms/:id/resume', requireOwnerToken, async (req, res) => {
    let r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'room not found' });
    if ((r.mode || 'debate') === 'cross_verify') {
      const runtimeReconciliation = runClusterRuntimeWatchdogOnce({
        roomStore,
        dispatcher: crossVerifyDispatcher,
        broadcastRoom,
        flushOnRecovery: true,
      });
      if (runtimeReconciliation.recoveryErrorCount > 0 || runtimeReconciliation.flushError || runtimeReconciliation.runtimePersistPending?.ok === false) {
        return res.status(503).json({
          ok: false,
          error: runtimeReconciliation.flushError
            ? 'cluster_runtime_recovery_flush_failed'
            : runtimeReconciliation.runtimePersistPending?.error || 'cluster_runtime_recovery_failed',
          message: runtimeReconciliation.flushError
            || runtimeReconciliation.runtimePersistPending?.message
            || runtimeReconciliation.recoveryErrors?.[0]?.error
            || 'cluster runtime recovery failed',
          runtimeReconciliation,
        });
      }
      if (runtimeReconciliation.recoveredRooms.some((item) => item.roomId === r.id)) {
        r = roomStore.get(req.params.id) || { ...r, status: 'paused' };
      }
    }
    if (r.status === 'running') return res.status(409).json({ error: '房间已在运行中' });
    const mode = r.mode || 'debate';
    if (mode === 'chat' || mode === 'arena') {
      return res.status(400).json({ error: `${mode} 房暂不支持续跑（chat 房用重发上一条；arena 房用 🔄 重启）` });
    }
    const resumeOptions = {};
    if (req.body?.goalMode !== undefined) {
      if (![true, false, 'true', 'false', 1, 0].includes(req.body.goalMode)) {
        return res.status(422).json({ error: 'goalMode 必须是 boolean' });
      }
      resumeOptions.goalMode = req.body.goalMode === true || req.body.goalMode === 'true' || req.body.goalMode === 1;
    }
    const dispatcher = mode === 'squad' ? squadDispatcher
                     : mode === 'cross_verify' ? crossVerifyDispatcher
                     : debateDispatcher;
    let resumeGate = null;
    if (mode === 'cross_verify') {
      resumeGate = await prepareClusterRunGate(r, {
        roomStore,
        dispatcher: crossVerifyDispatcher,
        roomAdapterPool,
        broadcastRoom,
        topic: r.topic || '',
      });
      if (!resumeGate.ok) {
        return res.status(resumeGate.statusCode || 409).json({
          ok: false,
          error: resumeGate.error,
          ...(resumeGate.reason ? { reason: resumeGate.reason } : {}),
          ...(resumeGate.message ? { message: resumeGate.message } : {}),
          ...(resumeGate.preflight ? { preflight: resumeGate.preflight } : {}),
          ...(resumeGate.runtimeReconciliation ? { runtimeReconciliation: resumeGate.runtimeReconciliation } : {}),
          ...(resumeGate.concurrencyBudget ? { concurrencyBudget: resumeGate.concurrencyBudget } : {}),
          ...(resumeGate.liveCheck ? { liveCheck: resumeGate.liveCheck } : {}),
        });
      }
    }
    res.json({
      ok: true,
      resumed: true,
      ...(resumeGate?.concurrencyBudget ? { concurrencyBudget: resumeGate.concurrencyBudget } : {}),
      ...(resumeGate?.degradedMembers?.length ? {
        liveCheckDegraded: true,
        degradedMembers: resumeGate.degradedMembers,
        liveCheck: resumeGate.liveCheck,
      } : {}),
    });
    let resumePromise;
    try {
      resumePromise = dispatcher.resume(req.params.id, resumeOptions);
    } catch (e) {
      resumePromise = Promise.reject(e);
    } finally {
      resumeGate?.reservation?.release?.();
    }
    Promise.resolve(resumePromise).catch(e => {
      console.warn(`${mode} resume failed:`, e.message);
      try {
        broadcastRoom(req.params.id, {
          type: mode === 'squad' ? 'squad_error' : mode === 'cross_verify' ? 'cross_verify_error' : 'debate_error',
          error: e.message || 'resume failed',
        });
        roomStore.setStatus(req.params.id, 'error');
      } catch {}
    });
  });

  // 中断（三个 dispatcher 都尝试）
  app.post('/api/rooms/:id/abort', requireOwnerToken, (req, res) => {
    // v0.51 U-16 fix: room 不存在时返 404，避免 silent ok:true 误导
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'room not found' });
    const ok1 = debateDispatcher.abort(req.params.id);
    const ok2 = squadDispatcher.abort(req.params.id);
    const ok3 = soloChatDispatcher.abort(req.params.id);
    const ok4 = arenaDispatcher.abort(req.params.id);
    const ok5 = crossVerifyDispatcher.abort(req.params.id);
    res.json({ ok: true, aborted: ok1 || ok2 || ok3 || ok4 || ok5 });
  });
}
