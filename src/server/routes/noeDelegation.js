import { requireOwnerToken } from '../auth/owner-token.js';
import { detectTaskIntent, formatTaskIntentReply } from '../../room/TaskIntentRouter.js';
import {
  createNoeDelegationRoom,
  createNoeDelegationStartApproval,
  formatNoeDelegationCreatedReply,
  normalizeTaskPlan,
  validateTaskDelegationPlan,
} from '../../room/TaskDelegationPlanner.js';

const MAX_BODY = 8000;

function tooBig(body) {
  return JSON.stringify(body || {}).length > MAX_BODY;
}

function textFromBody(body = {}) {
  return String(body.text || body.query || body.instructions || '').trim();
}

function planFromBody(body = {}) {
  return normalizeTaskPlan(body.plan || body.taskPlan || body.task_plan) || detectTaskIntent(textFromBody(body));
}

function resolveCwd(body = {}, safeResolveFsPath = null) {
  const raw = String(body.cwd || '').trim();
  if (!raw) return process.cwd();
  if (typeof safeResolveFsPath !== 'function') throw new Error('safeResolveFsPath required for cwd');
  return safeResolveFsPath(raw);
}

export function registerNoeDelegationRoutes(app, {
  roomStore = null,
  roomAdapterPool = null,
  getRoomAdapterPool = null,
  approvalStore = null,
  scheduleStore = null,
  agentRunStore = null,
  safeResolveFsPath = null,
  sendError = null,
  episodicTimeline = null,   // 内在世界（记录覆盖扩展）：注入才把派活确认记进自传体时间线（门控在装配点）
} = {}) {
  const adapters = () => (typeof getRoomAdapterPool === 'function' ? getRoomAdapterPool() : roomAdapterPool);

  app.post('/api/noe/delegate/plan', requireOwnerToken, (req, res) => {
    try {
      if (tooBig(req.body)) return res.status(413).json({ ok: false, error: 'body too large' });
      const plan = planFromBody(req.body || {});
      if (!plan) return res.json({ ok: true, matched: false, hint: '未识别成派活任务' });
      const checked = validateTaskDelegationPlan(plan, { roomAdapterPool: adapters() });
      return res.status(checked.ok ? 200 : checked.status || 400).json({
        ok: checked.ok,
        matched: true,
        intent: 'delegate_task',
        dryRunOnly: true,
        approvalRequired: true,
        confirmEndpoint: '/api/noe/delegate/confirm',
        plan: checked.plan || plan,
        reply: formatTaskIntentReply(checked.plan || plan),
        error: checked.ok ? undefined : checked.error,
        missingAdapters: checked.missingAdapters,
        tier: checked.tier,
        feature: checked.feature,
      });
    } catch (e) {
      return typeof sendError === 'function' ? sendError(res, e) : res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });

  app.post('/api/noe/delegate/confirm', requireOwnerToken, (req, res) => {
    try {
      if (tooBig(req.body)) return res.status(413).json({ ok: false, error: 'body too large' });
      if (!roomStore) return res.status(501).json({ ok: false, error: 'roomStore not configured' });
      const plan = planFromBody(req.body || {});
      if (!plan) return res.status(422).json({ ok: false, error: 'delegate task plan required' });
      if (req.body?.confirm !== true) {
        return res.status(409).json({
          ok: false,
          error: 'confirm:true required',
          matched: true,
          intent: 'delegate_task',
          dryRunOnly: true,
          approvalRequired: true,
          confirmEndpoint: '/api/noe/delegate/confirm',
          plan,
          reply: formatTaskIntentReply(plan),
        });
      }
      const requestStartApproval = req.body?.autoStart === true || req.body?.startAfterApproval === true;
      if (requestStartApproval && !approvalStore?.createApproval) {
        return res.status(501).json({ ok: false, error: 'approvalStore not configured' });
      }
      if (requestStartApproval && !scheduleStore?.enqueueJob) {
        return res.status(501).json({ ok: false, error: 'scheduleStore not configured' });
      }
      const { room, plan: normalizedPlan } = createNoeDelegationRoom({
        plan,
        roomStore,
        roomAdapterPool: adapters(),
        cwd: resolveCwd(req.body || {}, safeResolveFsPath),
      });
      const approval = requestStartApproval
        ? createNoeDelegationStartApproval({ approvalStore, room, plan: normalizedPlan })
        : null;
      const agentRunId = requestStartApproval ? `agent-run-noe-delegate-${room.id}` : null;
      const job = requestStartApproval
        ? scheduleStore.enqueueJob({
          action: 'start_noe_delegate',
          targetType: 'noe_delegate',
          targetId: room.id,
          roomId: room.id,
          taskId: `noe-delegate:${room.id}`,
          projectId: room.cwd || null,
          runAfter: req.body?.runAfter || Date.now(),
          maxAttempts: req.body?.maxAttempts || 500,
          retryBackoffMs: req.body?.retryBackoffMs || 30_000,
          dedupeKey: `noe-delegate-autostart:${room.id}`,
          payload: {
            roomId: room.id,
            plan: normalizedPlan,
            approvalId: approval?.id || null,
            agentRunId,
            requireApproval: true,
            autoStart: true,
            gatePollMs: req.body?.gatePollMs || 30_000,
            budgetEstimate: req.body?.budgetEstimate || req.body?.budget || {},
          },
        })
        : null;
      const agentRun = requestStartApproval && agentRunStore?.create
        ? agentRunStore.create({
          id: agentRunId,
          status: 'queued',
          roomId: room.id,
          taskId: `noe-delegate:${room.id}`,
          approvalId: approval?.id || null,
          agentProfileId: 'noe-delegate',
          agentProfileTitle: 'Noe Delegate',
          sourceType: 'noe_delegate_autostart',
          sourceId: room.id,
          dispatchTags: ['noe', 'governance'],
          details: { roomId: room.id, approvalId: approval?.id || null, jobId: job?.id || null, targetMode: normalizedPlan.targetMode },
        })
        : null;
      // 内在世界（记录覆盖扩展）：派活确认成立是一件"主人托付了事"的里程碑，记进自传体时间线。
      // 注入式（未注入 episodicTimeline 则跳过，零影响）；写失败不阻断 201 返回。
      try {
        episodicTimeline?.record({
          type: 'milestone',
          summary: `主人派活给我：${String(normalizedPlan?.title || normalizedPlan?.instructions || '').slice(0, 40)}`,
          salience: 4,
        });
      } catch { /* 记录失败不阻断派活返回 */ }
      return res.status(201).json({
        ok: true,
        matched: true,
        intent: 'delegate_task',
        room,
        plan: normalizedPlan,
        approvalRequired: Boolean(approval),
        approval,
        job,
        agentRun,
        started: false,
        queued: Boolean(job),
        reply: formatNoeDelegationCreatedReply({ room, plan: normalizedPlan, approval }),
      });
    } catch (e) {
      const status = e?.statusCode || e?.extra?.status;
      if (status) return res.status(status).json({ ok: false, error: e.message || String(e), ...(e.extra || {}) });
      return typeof sendError === 'function' ? sendError(res, e) : res.status(500).json({ ok: false, error: e?.message || String(e) });
    }
  });
}
