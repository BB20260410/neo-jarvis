// Noe — Rooms routes (S18-2e2 + P3 compact list)
// Route registration stays here; heavy room/cluster helpers live in services/rooms-core.js.

import { statSync } from 'fs';
import { homedir } from 'os';
import { hasFeature, getCurrentTier } from '../../license/LicenseManager.js';
import { sanitizeLineage, sanitizeObjective } from '../../room/RoomLineage.js';
import { finalizeTurn } from '../../autopilot/NoeTurnFinalizer.js';
// 后台复盘（孤儿接线 · proposal-only）：对话收尾时把整段对话喂给 NoeBackgroundReview 产可审计提案，
// 下游 NoeProposalInbox 自动收（source=background_review）。注入式：hook 由 deps.backgroundReview 传入，
// env NOE_BACKGROUND_REVIEW 默认 OFF（server.js 不注入 → null）则整条 rotate 路径零回归。绝不接 heartbeat。
import { buildRoleCardsForMembers } from '../../room/roleCards.js';
import { activityLog as defaultActivityLog } from '../../audit/ActivityLog.js';
import { agentRunStore as defaultAgentRunStore } from '../../agents/AgentRunStore.js';
import { requireOwnerToken } from '../auth/owner-token.js';
import { registerRoomsClusterDeliveryRoutes } from './roomsClusterDeliveryRoutes.js';
import {
  createClusterProjectScaffold,
  normalizeAgentProfileId,
  normalizeRoomSkillNames,
  roomListResponse,
  roomWithFreshClusterRuntimeState,
  searchRooms,
} from '../services/rooms-core.js';

export {
  buildClusterExecutionBudgetEstimate,
  buildClusterPreflight,
  fullListRoomPayload,
  roomListResponse,
  roomWithFreshClusterRuntimeState,
  runClusterAdapterLiveChecks,
  summarizeRoom,
} from '../services/rooms-core.js';

export function registerRoomsRoutes(app, deps) {
  const {
    roomStore, safeResolveFsPath, safeSlice, roomAdapterPool,
    debateDispatcher, squadDispatcher, arenaDispatcher, soloChatDispatcher,
    roomWsClients,
    skillStore = null,
    // 后台复盘 hook（注入式，env NOE_BACKGROUND_REVIEW 门控）：默认 null = OFF = rotate 路径逐字零回归。
    // 非 null 时仅在 rotate 成功后 fire-and-forget 触发 proposal-only 复盘，不影响响应延迟/成功。
    backgroundReview = null,
    activityLog = defaultActivityLog,
    agentRunStore = defaultAgentRunStore,
    MAX_ROOMS = 500,
  } = deps;
  const emitRoomEvent = (roomId, msg) => {
    const clients = roomWsClients?.get?.(roomId);
    if (!clients || typeof clients[Symbol.iterator] !== 'function') return;
    const payload = JSON.stringify(msg);
    for (const ws of clients) {
      try { ws.send(payload); } catch {}
    }
  };

  // 房间列表
  // A1 安全修复：conversation 含完整聊天内容，读也必须 owner-token（Origin 白名单只防浏览器跨域，
  // 不防本机其他进程 curl——owner-token.js 的威胁模型对读端点同样成立）。前端 fetch 已全局注入 token，零影响。
  app.get('/api/rooms', requireOwnerToken, (req, res) => {
    // v0.52 ?archived=1 返已归档列表；默认返活跃
    if (req.query?.archived === '1') {
      return res.json(roomListResponse(roomStore.listArchived(), req.query));
    }
    res.json(roomListResponse(roomStore.list(), req.query));
  });

  // 创建房间
  app.post('/api/rooms', requireOwnerToken, (req, res) => {
    if (roomStore.list().length >= MAX_ROOMS) {
      return res.status(429).json({ error: `已达房间总数上限（${MAX_ROOMS}）。先删除一些旧房间` });
    }
    const { name, cwd, members, mode, defaultPartner, objective, lineage, projectScaffold } = req.body || {};
    // v0.49 N-07 fix: cwd 必须在沙箱内
    let roomCwd = homedir();
    if (cwd && typeof cwd === 'string' && cwd.trim()) {
      if (cwd.length > 1024) return res.status(400).json({ error: 'cwd 过长' });
      const safe = safeResolveFsPath(cwd.trim());
      if (!safe) return res.status(403).json({ error: 'cwd 越权或敏感目录' });
      try {
        const st = statSync(safe);
        if (!st.isDirectory()) return res.status(400).json({ error: 'cwd 不是目录' });
        roomCwd = safe;
      } catch {
        return res.status(400).json({ error: 'cwd 不存在' });
      }
    }
    if (typeof name === 'string' && name.length > 200) return res.status(400).json({ error: 'name 过长' });
    let roomMode;
    if (mode === 'squad') roomMode = 'squad';
    else if (mode === 'chat') roomMode = 'chat';
    else if (mode === 'arena') roomMode = 'arena';
    else if (mode === 'cross_verify') roomMode = 'cross_verify';
    else roomMode = 'debate';

    let scaffoldInfo = null;
    const shouldCreateClusterProject = roomMode === 'cross_verify'
      && projectScaffold !== false
      && !(projectScaffold && typeof projectScaffold === 'object' && projectScaffold.enabled === false);
    if (shouldCreateClusterProject) {
      try {
        scaffoldInfo = createClusterProjectScaffold({
          scaffold: projectScaffold,
          roomName: typeof name === 'string' ? name : '',
          safeResolveFsPath,
        });
        roomCwd = scaffoldInfo.projectDir;
      } catch (e) {
        return res.status(e.statusCode || 400).json({ ok: false, error: e.message || '项目目录创建失败' });
      }
    }

    // v1.5 Task 3.2 — Pro tier gate for squad/arena
    if ((roomMode === 'squad' || roomMode === 'arena') && !hasFeature(roomMode)) {
      return res.status(402).json({
        error: `${roomMode === 'squad' ? 'AI 团队拆活（squad）' : '多模型联网核对（arena）'} 模式需要 Pro license`,
        tier: getCurrentTier(),
        feature: roomMode,
        upgradeUrl: 'https://panel.app/pricing',
      });
    }

    let defaultMembers;
    if (roomMode === 'squad') {
      defaultMembers = members || [
        { adapterId: 'claude', displayName: '🟣 Claude · PM',  role: 'pm',  enabled: true },
        { adapterId: 'claude', displayName: '🟣 Claude · Dev', role: 'dev', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT · Dev',     role: 'dev', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT · QA',      role: 'qa',  enabled: true },
      ];
    } else if (roomMode === 'arena') {
      defaultMembers = members || [
        { adapterId: 'claude', displayName: '🟣 Claude（提案 + Judge）', role: 'judge', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT', enabled: true },
        { adapterId: 'gemini-cli', displayName: '🔷 Gemini CLI', enabled: roomAdapterPool.has('gemini-cli') },
        { adapterId: 'minimax', displayName: '🟡 MiniMax', enabled: roomAdapterPool.has('minimax') },
      ].filter(m => roomAdapterPool.has(m.adapterId));
    } else if (roomMode === 'chat') {
      const partner = (defaultPartner && roomAdapterPool.has(defaultPartner)) ? defaultPartner : 'codex';
      const partnerNames = { claude: '🟣 Claude', codex: '🟢 GPT', ollama: '🔵 Ollama', minimax: '🟡 MiniMax', ccr: '🔄 Claude Router' };
      const partnerDisplay = partnerNames[partner] || roomAdapterPool.get(partner)?.displayName || partner;
      defaultMembers = members || [
        { adapterId: partner, displayName: partnerDisplay, enabled: true },
      ];
    } else if (roomMode === 'cross_verify') {
      // 集群协同:2+ 个对等成员,默认 claude + codex,用户可继续加 gemini/minimax/ollama/custom
      defaultMembers = members || [
        { adapterId: 'claude', displayName: '🟣 Claude', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT',    enabled: true },
      ];
    } else {
      defaultMembers = members || [
        { adapterId: 'claude', displayName: '🟣 Claude', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT',     enabled: true },
        { adapterId: 'ollama', displayName: '🔵 Ollama（顶位 MiniMax）', enabled: true },
      ];
    }
    const room = roomStore.create({
      name,
      cwd: roomCwd,
      members: defaultMembers,
      mode: roomMode,
      objective: sanitizeObjective(objective, { fallbackTitle: typeof name === 'string' ? name : '' }),
      lineage: sanitizeLineage(lineage, { projectId: roomCwd }),
      projectScaffold: scaffoldInfo,
    });
    res.json({ ok: true, room: roomWithFreshClusterRuntimeState(room, 'api_create_response') });
  });

  // v0.53 Sprint 3.5：跨房搜索（必须注册在 /api/rooms/:id 前，避免 search 被当成房间 id）
  app.get('/api/rooms/search', requireOwnerToken, (req, res) => {
    const result = searchRooms({ roomStore, query: req.query || {} });
    res.status(result.status).json(result.body);
  });

  registerRoomsClusterDeliveryRoutes(app, {
    roomStore,
    roomAdapterPool,
    agentRunStore,
    activityLog,
    emitRoomEvent,
  });

  // 获取单房间（A1：含 conversation 全文，读必须 owner-token，同上）
  app.get('/api/rooms/:id', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true, room: roomWithFreshClusterRuntimeState(r) });
  });

  // 卡⑤ session rotate：聊天房手动轮换——finalizeTurn 把对话凝成交接 → 建新房注入为第一条消息 → 旧房标 rotatedTo。
  // 确定性降级摘要（不烧 LLM）；只动 chat 模式房；新房继承成员/cwd/objective。
  app.post('/api/rooms/:id/rotate', requireOwnerToken, async (req, res) => {
    try {
      const room = roomStore.get(req.params.id);
      if (!room) return res.status(404).json({ ok: false, error: 'not found' });
      if (room.mode !== 'chat') return res.status(400).json({ ok: false, error: '只有 chat 聊天房支持轮换交接' });
      const conv = Array.isArray(room.conversation) ? room.conversation : [];
      if (!conv.length) return res.status(400).json({ ok: false, error: '对话为空，无需轮换' });
      if (roomStore.list().length >= MAX_ROOMS) return res.status(429).json({ ok: false, error: `已达房间总数上限（${MAX_ROOMS}）` });
      const fin = await finalizeTurn(
        conv.filter((m) => !m.error).map((m) => ({ role: m.from === 'user' ? 'user' : 'assistant', content: m.content })),
        { reason: 'manual_rotate', keepTail: 10 },
      );
      const baseName = String(room.name || '聊天房').replace(/·续\d*$/, '').trim();
      const seq = (Number(room.rotateSeq) || 1) + 1;
      const newRoom = roomStore.create({
        name: `${baseName}·续${seq}`.slice(0, 200),
        cwd: room.cwd,
        members: room.members,
        mode: 'chat',
        objective: room.objective,
      });
      const handoffMsg = {
        at: new Date().toISOString(),
        from: 'system',
        displayName: '系统',
        content: `【轮换交接 · 来自「${room.name}」】\n${fin.summary}`,
        finalizer: true,
      };
      roomStore.update(newRoom.id, { conversation: [handoffMsg], rotateSeq: seq, rotatedFrom: room.id });
      // rotateSeq 同步写回旧房：同一旧房再次轮换时序号继续递增，不会撞出两个同名"·续N"
      roomStore.update(room.id, { rotateSuggested: false, rotatedTo: newRoom.id, rotateSeq: seq });
      emitRoomEvent(room.id, { type: 'chat_rotated', newRoomId: newRoom.id });
      // 对话收尾钩子（proposal-only · fire-and-forget）：OFF（backgroundReview=null）时整段不执行 = 零回归。
      // 不 await、独立 try/catch：后台复盘失败绝不影响 rotate 响应——对话收尾是主路径，复盘是旁路。
      // 用 finalizeTurn 已过滤的同一份 conv 作输入；只产可审计提案进 NoeProposalInbox，绝不直接执行副作用。
      if (backgroundReview && typeof backgroundReview.afterConversation === 'function') {
        const reviewMessages = conv.filter((m) => !m.error)
          .map((m) => ({ role: m.from === 'user' ? 'user' : 'assistant', content: m.content }));
        Promise.resolve()
          .then(() => backgroundReview.afterConversation({
            messages: reviewMessages,
            context: { projectId: 'noe', reason: 'room_rotate', roomId: room.id },
          }))
          .catch(() => { /* 后台复盘失败不影响对话收尾（已在 hook 内吞错，此处兜底防 unhandled rejection） */ });
      }
      return res.json({ ok: true, newRoomId: newRoom.id, summary: fin.summary, messageCount: fin.messageCount });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  });

  // 删除房间
  app.delete('/api/rooms/:id', requireOwnerToken, (req, res) => {
    const id = req.params.id;
    // v0.49 N-20 fix: 删房间前先 abort dispatcher + 关 ws clients，避免泄漏
    // v0.53 fix: 之前漏 arenaDispatcher
    try { debateDispatcher.abort(id); } catch {}
    try { squadDispatcher.abort(id); } catch {}
    try { arenaDispatcher.abort(id); } catch {}
    try { soloChatDispatcher.abort(id); } catch {}
    const set = roomWsClients.get(id);
    if (set) {
      for (const ws of set) { try { ws.close(); } catch {} }
      roomWsClients.delete(id);
    }
    const ok = roomStore.delete(id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });

  // 更新成员 / 名字 / cwd / qaStrictness
  app.patch('/api/rooms/:id', requireOwnerToken, (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'not found' });
    const patch = {};
    if (typeof req.body?.name === 'string') patch.name = safeSlice(String(req.body.name), 200);
    // v0.49 N-07 fix: PATCH cwd 也走沙箱
    if (typeof req.body?.cwd === 'string' && req.body.cwd.trim()) {
      if (req.body.cwd.length > 1024) return res.status(400).json({ error: 'cwd 过长' });
      const safe = safeResolveFsPath(req.body.cwd.trim());
      if (!safe) return res.status(403).json({ error: 'cwd 越权或敏感目录' });
      try {
        const st = statSync(safe);
        if (!st.isDirectory()) return res.status(400).json({ error: 'cwd 不是目录' });
        patch.cwd = safe;
      } catch { return res.status(400).json({ error: 'cwd 不存在' }); }
    }
    // v0.43 P1 #8: members 校验
    if (Array.isArray(req.body?.members)) {
      const validRoles = new Set(['pm', 'dev', 'qa', 'observer']);
      const validArenaRoles = new Set(['judge', 'observer']);
      const isSquad = r.mode === 'squad';
      const isArena = r.mode === 'arena';
      if (isSquad) {
        for (const [i, m] of req.body.members.entries()) {
          if (m?.role && !validRoles.has(m.role)) {
            return res.status(422).json({ error: `members[${i}].role 不合法（必须是 pm/dev/qa/observer），收到: ${m.role}` });
          }
        }
      } else if (isArena) {
        for (const [i, m] of req.body.members.entries()) {
          if (m?.role && !validArenaRoles.has(m.role)) {
            return res.status(422).json({ error: `members[${i}].role 不合法（arena 房仅支持 judge/observer 或留空），收到: ${m.role}` });
          }
        }
      }
      for (const [i, m] of req.body.members.entries()) {
        const agentProfileId = normalizeAgentProfileId(m?.agentProfileId ?? m?.profileId ?? m?.agentId);
        if (agentProfileId === null) {
          return res.status(422).json({ error: `members[${i}].agentProfileId 不合法或不存在` });
        }
      }
      const members = req.body.members.slice(0, 30).map(m => ({
        adapterId: roomAdapterPool.has(m?.adapterId) ? m.adapterId : 'claude',
        displayName: safeSlice(String(m?.displayName || m?.adapterId || '成员'), 80),
        model: typeof m?.model === 'string' ? safeSlice(m.model, 80) : '',
        role: (isSquad && validRoles.has(m?.role)) ? m.role
            : (isArena && validArenaRoles.has(m?.role)) ? m.role
            : (isSquad ? 'dev' : undefined),
        agentProfileId: normalizeAgentProfileId(m?.agentProfileId ?? m?.profileId ?? m?.agentId) || undefined,
        enabled: m?.enabled !== false,
      }));
      patch.members = members;
      patch.roleCards = buildRoleCardsForMembers(members, { mode: r.mode, existing: r.roleCards });
    }
    if (Array.isArray(req.body?.roleCards)) {
      patch.roleCards = buildRoleCardsForMembers(r.members || [], { mode: r.mode, existing: req.body.roleCards });
    }
    if (typeof req.body?.qaStrictness === 'string' && ['loose', 'standard', 'strict'].includes(req.body.qaStrictness)) {
      patch.qaStrictness = req.body.qaStrictness;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'objective')) {
      patch.objective = sanitizeObjective(req.body.objective, { fallbackTitle: r.name || '' });
      const nextLineage = sanitizeLineage(r.lineage, { projectId: r.cwd || homedir() });
      nextLineage.objectiveId = patch.objective?.id || null;
      patch.lineage = nextLineage;
    }
    if (Object.prototype.hasOwnProperty.call(req.body || {}, 'lineage')) {
      patch.lineage = sanitizeLineage(req.body.lineage, { projectId: r.cwd || homedir() });
      if (r.objective && !patch.lineage.objectiveId) patch.lineage.objectiveId = r.objective.id;
    }
    if (typeof req.body?.archived === 'boolean') {
      patch.archived = req.body.archived;
      patch.archivedAt = req.body.archived ? new Date().toISOString() : null;
    }
    if (req.body?.debateRounds !== undefined) {
      const n = Number(req.body.debateRounds);
      if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 10) {
        return res.status(422).json({ error: 'debateRounds 必须是 1-10 的整数' });
      }
      patch.debateRounds = n;
    }
    if (Array.isArray(req.body?.skills)) {
      const skills = normalizeRoomSkillNames(req.body.skills, skillStore);
      if (!skills) return res.status(422).json({ error: 'skills 包含未安装或已禁用的 skill' });
      patch.skills = skills;
    }
    if (typeof req.body?.exportPath === 'string') {
      const p = req.body.exportPath.trim();
      if (p === '') {
        patch.exportPath = '';
      } else {
        if (p.length > 1024) return res.status(400).json({ error: 'exportPath 过长' });
        const safe = safeResolveFsPath(p);
        if (!safe) return res.status(403).json({ error: 'exportPath 越权或敏感目录' });
        patch.exportPath = safe;
      }
    }
    const updated = roomStore.update(req.params.id, patch);
    res.json({ ok: true, room: roomWithFreshClusterRuntimeState(updated, 'api_patch_response') });
  });
}
