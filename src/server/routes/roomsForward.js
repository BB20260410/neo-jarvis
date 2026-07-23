// @ts-check
// Noe — rooms-advanced 域 routes ②：forward / quick 起房 (S23)
// 从 server.js 提取 2 条路由（拆前行号 2502-2785 / 3277-3429），行为完全一致。
// roomStore/MAX_ROOMS/safeResolveFsPath/safeSlice/roomAdapterPool/各 dispatcher/prepareClusterRunGate/
// broadcastRoom/roomTemplatesStore/send500 走 deps 注入；MAX_ROOMS 与 rooms.js 注入的是 server.js 同一 const，勿硬编码。
// 2 个 register 函数：server.js 在各原位置分别调用，保持 Express 注册顺序与拆前逐条一致。

import { statSync } from 'node:fs';
import { homedir } from 'os';
import { requireOwnerToken } from '../auth/owner-token.js';

// v0.52 Sprint1-F：把当前房的 finalConsensus 作为 topic 转给新房
// ① POST /api/rooms/forward（server.js 原 2502-2785 位置调用）
export function registerRoomsForwardRoutes(app, deps) {
  const {
    roomStore, MAX_ROOMS, safeResolveFsPath, safeSlice, roomAdapterPool,
    debateDispatcher, squadDispatcher, arenaDispatcher, crossVerifyDispatcher,
    prepareClusterRunGate, broadcastRoom,
  } = deps;

  app.post('/api/rooms/forward', requireOwnerToken, async (req, res) => {
    if (roomStore.list().length >= MAX_ROOMS) {
      return res.status(429).json({ error: `已达房间总数上限（${MAX_ROOMS}）。先删/归档一些旧房` });
    }
    const { sourceRoomId, targetMode, autoStart, name, seedScope } = req.body || {};
    if (!sourceRoomId) return res.status(400).json({ error: 'sourceRoomId required' });
    const src = roomStore.get(sourceRoomId);
    if (!src) return res.status(404).json({ error: 'source room not found' });
    const finalContent = src.finalConsensus;
    if (!finalContent) return res.status(400).json({ error: '源房尚无最终输出（finalConsensus 空）' });
    if (finalContent.length > 1048576) return res.status(413).json({ error: '源房输出过长（>1MB），无法 forward' });

    const allowedTargets = new Set(['debate', 'squad', 'arena', 'chat']);
    const tm = allowedTargets.has(targetMode) ? targetMode : 'squad';
    let defaultMembers;
    if (tm === 'squad') {
      defaultMembers = [
        { adapterId: 'claude', displayName: '🟣 Claude · PM',  role: 'pm',  enabled: true },
        { adapterId: 'claude', displayName: '🟣 Claude · Dev', role: 'dev', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT · Dev',     role: 'dev', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT · QA',      role: 'qa',  enabled: true },
      ];
    } else if (tm === 'arena') {
      defaultMembers = [
        { adapterId: 'claude', displayName: '🟣 Claude（含 Judge）', role: 'judge', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT', enabled: true },
        { adapterId: 'gemini-cli', displayName: '🔷 Gemini CLI', enabled: roomAdapterPool.has('gemini-cli') },
        { adapterId: 'minimax', displayName: '🟡 MiniMax', enabled: roomAdapterPool.has('minimax') },
      ].filter(m => roomAdapterPool.has(m.adapterId));
    } else if (tm === 'chat') {
      const partner = 'claude';
      defaultMembers = [{ adapterId: partner, displayName: '🟣 Claude', enabled: true }];
    } else { // debate
      defaultMembers = [
        { adapterId: 'claude', displayName: '🟣 Claude', enabled: true },
        { adapterId: 'codex',  displayName: '🟢 GPT',     enabled: true },
        { adapterId: 'ollama', displayName: '🔵 Ollama', enabled: true },
      ];
    }

    // v0.56 U10：seedScope='all' 时把完整 transcript 拼到 topic，让 squad/debate/arena 新房也能看到原讨论过程
    // chat 模式走自己的 conversation seed 路径（line 2556 处），不需要在这里拼 topic
    let topicContent = finalContent;
    if (seedScope === 'all' && tm !== 'chat') {
      const CAP = 950000;  // 95万字符 cap，给 finalConsensus 余 5万空间
      const parts = [];
      let used = 0;
      const push = (s) => {
        if (used >= CAP || !s) return;
        const t = String(s);
        if (used + t.length > CAP) { parts.push(t.slice(0, CAP - used)); used = CAP; }
        else { parts.push(t); used += t.length; }
      };
      if (src.topic) push(`## 📝 源房原始 topic\n${src.topic}\n\n`);
      if (Array.isArray(src.rounds) && src.rounds.length > 0) {
        push(`## 🗨 各轮发言（${src.rounds.length} 轮）\n\n`);
        for (const r of src.rounds) {
          push(`### ${r.kind}\n`);
          for (const t of (r.turns || [])) {
            push(`#### ${t.error ? '❌ ' : ''}${t.displayName || t.speaker}\n${t.content || ''}\n\n`);
            if (used >= CAP) break;
          }
          if (used >= CAP) break;
        }
      }
      if (Array.isArray(src.conversation) && src.conversation.length > 0) {
        push(`## 💬 对话历史（${src.conversation.length} 条）\n`);
        for (const c of src.conversation) {
          if (c.thinking) continue;
          const who = c.from === 'user' ? '【用户】' : `【${c.displayName || c.from}】`;
          push(`### ${who}\n${c.content || ''}\n\n`);
          if (used >= CAP) break;
        }
      }
      if (Array.isArray(src.taskList) && src.taskList.length > 0) {
        push(`## 📋 squad 任务清单（${src.taskList.length}）\n`);
        for (const t of src.taskList) {
          push(`### ${t.id} ${t.title || ''}（status=${t.status}）\n`);
          if (t.desc) push(`描述：${(t.desc || '').replace(/\n/g, ' ')}\n`);
          const lastGood = [...(t.attempts || [])].reverse().find((a) => !a.error);
          if (lastGood) push(`**Dev 最终交付**：\n${lastGood.content || ''}\n\n`);
          if (used >= CAP) break;
        }
      }
      const transcript = parts.join('');
      topicContent = `${transcript}${used >= CAP ? '\n\n…（transcript 已截断到 950KB）' : ''}\n\n---\n\n## 🎯 最终结论 / 共识\n\n${finalContent}`;
      if (topicContent.length > 1048576) {
        topicContent = topicContent.slice(0, 1048000) + '\n\n…（topic 已截断到 1MB 上限）';
      }

      // v0.70 W3 集成：token 估算 + 警告（学自 LibreChat historyTrimmer）
      // 不强行截断（用户选 'all' 是知情决定），仅记录估算 token 数到 broadcastGlobal warning
      try {
        const { estimateTokens, DEFAULT_MAX_CONTEXT } = await import('../../room/historyTrimmer.js');
        const estTokens = estimateTokens(topicContent);
        // 取目标房任一成员最小 maxContext 作上限（保守）
        const memberMax = (defaultMembers || []).reduce((min, m) => {
          const cap = DEFAULT_MAX_CONTEXT[m.adapterId] || 100000;
          return Math.min(min, cap);
        }, Infinity);
        if (Number.isFinite(memberMax) && estTokens > memberMax * 0.7) {
          console.warn(`[forward] topicContent ~${estTokens} tokens > ${memberMax * 0.7} (70% of min member context). 可能爆 context。`);
        }
      } catch {}
    }

    // 防御：复用源房 cwd 时校一遍沙箱（万一沙箱白名单后来收紧）
    let forwardCwd = src.cwd;
    if (forwardCwd) {
      const safe = safeResolveFsPath(forwardCwd);
      if (!safe) forwardCwd = homedir();
      else forwardCwd = safe;
    } else {
      forwardCwd = homedir();
    }

    // 复用现有 createRoom 路径：构造一个内部 POST /api/rooms 风格的调用
    const safeName = (typeof name === 'string' && name.trim()) ? safeSlice(name.trim(), 200) : `（来自 ${src.name || '未命名'}）${tm}`;
    const newRoom = roomStore.create({ name: safeName, cwd: forwardCwd, members: defaultMembers, mode: tm });
    // 记录链路
    const updatePatch = {
      topic: topicContent,
      parentRoomId: sourceRoomId,
    };
    // v0.54 Sprint 5.5 + Sprint 11：forward 到 chat 房时 seed 完整对话历史 + 最终结论
    // 之前 bug：只 seed finalConsensus 一条 → AI 看不到原房 R1/R2/R3 的详细讨论
    // 现在：把整个 rounds[].turns / conversation / taskList 拍平 → 跟 finalConsensus 一起 seed
    if (tm === 'chat') {
      const TRANSCRIPT_CAP = 60000;     // 完整 transcript cap 60KB
      const FINAL_CAP = 20000;          // finalConsensus 单独 cap 20KB
      const modeLabel = ({ debate: '辩论', squad: '小组', arena: '对决', chat: '闲聊' })[src.mode] || src.mode;

      // 拍平源房完整聊天记录
      let transcriptParts = [];
      let used = 0;
      const push = (s) => {
        if (used >= TRANSCRIPT_CAP || !s) return;
        const trimmed = String(s);
        if (used + trimmed.length > TRANSCRIPT_CAP) {
          transcriptParts.push(trimmed.slice(0, TRANSCRIPT_CAP - used));
          used = TRANSCRIPT_CAP;
        } else {
          transcriptParts.push(trimmed);
          used += trimmed.length;
        }
      };
      if (src.topic) push(`## 原始任务 / topic\n${src.topic}\n\n`);
      if (src.mode === 'chat' && Array.isArray(src.conversation)) {
        push(`## 完整对话（${src.conversation.length} 条）\n`);
        for (const c of src.conversation) {
          if (c.thinking) continue;
          const who = c.from === 'user' ? '【用户】' : `【${c.displayName || c.from}】`;
          push(`### ${who}\n${c.content || ''}\n\n`);
          if (used >= TRANSCRIPT_CAP) break;
        }
      }
      if (Array.isArray(src.rounds) && src.rounds.length > 0) {
        push(`## 各轮发言（${src.rounds.length} 轮）\n`);
        for (const r of src.rounds) {
          push(`### ${r.kind}\n`);
          for (const t of (r.turns || [])) {
            const tag = t.error ? '❌ ' : '';
            push(`#### ${tag}${t.displayName || t.speaker}\n${t.content || ''}\n\n`);
            if (used >= TRANSCRIPT_CAP) break;
          }
          if (used >= TRANSCRIPT_CAP) break;
        }
      }
      if (Array.isArray(src.taskList) && src.taskList.length > 0) {
        push(`## squad 任务清单（${src.taskList.length} 个）\n`);
        for (const t of src.taskList) {
          push(`### ${t.id} ${t.title || ''}（status=${t.status}）\n`);
          if (t.desc) push(`描述：${(t.desc || '').replace(/\n/g, ' ')}\n`);
          const lastGood = [...(t.attempts || [])].reverse().find((a) => !a.error);
          if (lastGood) push(`**Dev 最终交付**：\n${lastGood.content || ''}\n\n`);
          if (used >= TRANSCRIPT_CAP) break;
        }
      }
      const transcript = transcriptParts.join('');
      const transcriptTruncated = used >= TRANSCRIPT_CAP;
      const finalCapped = finalContent.length > FINAL_CAP
        ? finalContent.slice(0, FINAL_CAP) + `\n\n…（最终结论已截断，原 ${finalContent.length} 字符）`
        : finalContent;

      // 把 transcript + finalConsensus 拼成一条 assistant 消息（AI 读到自己"刚说完这些"）
      const seedAssistant = `# 📌 源房《${src.name || '未命名'}》(${modeLabel}房) 完整记录

${transcript}${transcriptTruncated ? '\n\n…（完整 transcript 已截断到 60KB，剩余内容请参考源房）' : ''}

---

# 🎯 最终结论 / 共识

${finalCapped}`;

      const now = new Date().toISOString();
      updatePatch.conversation = [
        {
          at: now,
          from: 'user',
          content: `我刚在「${src.name || '未命名'}」（${modeLabel}房）跑完一轮完整讨论，下面是**完整聊天历史 + 最终结论**。请基于这些全部上下文和我继续讨论后续问题（不只是结论，过程中的细节也算数）。`,
        },
        {
          at: now,
          from: 'forward-context',     // 非 'user' → flatten 时算 assistant 角色
          displayName: `📌 源房《${src.name || '未命名'}》完整历史 + 结论`,
          content: seedAssistant,
          fromForward: true,
          sourceRoomId,
          sourceMode: src.mode,
          transcriptLen: transcript.length,
          transcriptTruncated,
        },
      ];
    }
    roomStore.update(newRoom.id, updatePatch);

    // 自动启动（chat 房没有自启动概念）
    let started = false;
    let startError = null;
    let startConcurrencyBudget = null;
    let startLiveCheck = null;
    if (autoStart === true && tm !== 'chat') {
      const dispatcher = tm === 'squad' ? squadDispatcher
                       : tm === 'arena' ? arenaDispatcher
                       : tm === 'cross_verify' ? crossVerifyDispatcher
                       : debateDispatcher;
      if (tm === 'cross_verify') {
        const startGate = await prepareClusterRunGate(newRoom, {
          roomStore,
          dispatcher: crossVerifyDispatcher,
          roomAdapterPool,
          broadcastRoom,
          topic: topicContent,
        });
        startConcurrencyBudget = startGate.concurrencyBudget || null;
        startLiveCheck = startGate.liveCheck || null;
        if (!startGate.ok) {
          startError = startGate.error || 'cluster_run_gate_blocked';
        } else {
          let runPromise;
          try {
            runPromise = dispatcher.start(newRoom.id, topicContent);
          } catch (e) {
            runPromise = Promise.reject(e);
          } finally {
            startGate.reservation?.release?.();
          }
          Promise.resolve(runPromise).catch(e => {
            console.warn(`forward auto-start ${tm} failed:`, e.message);
            try {
              broadcastRoom(newRoom.id, {
                type: 'cross_verify_error',
                error: e.message || 'forward auto-start failed',
              });
              roomStore.setStatus(newRoom.id, 'error');
            } catch {}
          });
          started = true;
        }
      } else {
        dispatcher.start(newRoom.id, topicContent).catch(e => {
          console.warn(`forward auto-start ${tm} failed:`, e.message);
          try {
            broadcastRoom(newRoom.id, {
              type: tm === 'squad' ? 'squad_error' : tm === 'arena' ? 'arena_error' : 'debate_error',
              error: e.message || 'forward auto-start failed',
            });
            roomStore.setStatus(newRoom.id, 'error');
          } catch {}
        });
        started = true;
      }
    }
    res.json({
      ok: true,
      newRoomId: newRoom.id,
      started,
      ...(startError ? { startError } : {}),
      ...(startConcurrencyBudget ? { concurrencyBudget: startConcurrencyBudget } : {}),
      ...(startLiveCheck ? { liveCheck: startLiveCheck } : {}),
    });
  });
}

// v0.54 Sprint 4 — CLI 一键起房：建房 + （可选）应用模板 + （可选）启动
// body: { mode, name?, members?, topic, templateId?, debateRounds?, qaStrictness?, startNow?, cwd? }
// 一次性完成：roomStore.create + PATCH 字段 + 启动 dispatcher
// ② POST /api/rooms/quick（server.js 原 3277-3429 位置调用）
export function registerRoomsQuickRoutes(app, deps) {
  const {
    roomStore, MAX_ROOMS, roomTemplatesStore, safeResolveFsPath,
    debateDispatcher, squadDispatcher, arenaDispatcher, soloChatDispatcher, crossVerifyDispatcher,
    prepareClusterRunGate, roomAdapterPool, broadcastRoom, send500,
  } = deps;

  app.post('/api/rooms/quick', requireOwnerToken, async (req, res) => {
    try {
      if (roomStore.list().length >= MAX_ROOMS) {
        return res.status(429).json({ error: `已达房间总数上限（${MAX_ROOMS}）` });
      }
      const body = req.body || {};
      const topic = String(body.topic || '').trim();
      if (!topic) return res.status(400).json({ error: 'topic required' });
      if (topic.length > 1048576) return res.status(400).json({ error: 'topic 过长（>1MB）' });

      // 1) 取模板（可选）
      let template = null;
      if (body.templateId) {
        template = roomTemplatesStore.get(String(body.templateId));
        if (!template) return res.status(404).json({ error: '模板不存在: ' + body.templateId });
      }

      // 2) mode：template > body > 默认 debate
      const mode = template?.mode || body.mode || 'debate';
      if (!['debate', 'squad', 'arena', 'chat', 'cross_verify'].includes(mode)) {
        return res.status(400).json({ error: 'mode 必须是 debate/squad/arena/chat/cross_verify' });
      }

      // 3) members：template > body > server 默认（POST /api/rooms 流程兜底）
      const members = template?.preset?.members || (Array.isArray(body.members) ? body.members : undefined);

      // 4) cwd 沙箱
      let safeCwd = homedir();
      if (body.cwd && typeof body.cwd === 'string' && body.cwd.trim()) {
        if (body.cwd.length > 1024) return res.status(400).json({ error: 'cwd 过长' });
        const safe = safeResolveFsPath(body.cwd.trim());
        if (!safe) return res.status(403).json({ error: 'cwd 越权或敏感目录' });
        try {
          const st = statSync(safe);
          if (!st.isDirectory()) return res.status(400).json({ error: 'cwd 不是目录' });
          safeCwd = safe;
        } catch { return res.status(400).json({ error: 'cwd 不存在' }); }
      }

      // 5) name
      const name = String(body.name || template?.name || ('快速 ' + mode + ' 房')).slice(0, 200);

      // 6) create room（复用 roomStore.create 而不是再走 POST /api/rooms，因为 quick 跳过默认 members fallback）
      let finalMembers = members;
      if (!finalMembers) {
        // 用 POST /api/rooms 一样的默认 fallback
        if (mode === 'squad') {
          finalMembers = [
            { adapterId: 'claude', displayName: '🟣 Claude · PM',  role: 'pm',  enabled: true },
            { adapterId: 'claude', displayName: '🟣 Claude · Dev', role: 'dev', enabled: true },
            { adapterId: 'codex',  displayName: '🟢 GPT · Dev',     role: 'dev', enabled: true },
            { adapterId: 'codex',  displayName: '🟢 GPT · QA',      role: 'qa',  enabled: true },
          ];
        } else if (mode === 'arena') {
          finalMembers = [
            { adapterId: 'claude', displayName: '🟣 Claude（提案 + Judge）', role: 'judge', enabled: true },
            { adapterId: 'codex',  displayName: '🟢 GPT', enabled: true },
          ];
        } else if (mode === 'chat') {
          finalMembers = [{ adapterId: 'codex', displayName: '🟢 GPT', enabled: true }];
        } else if (mode === 'cross_verify') {
          // 集群协同:2+ 个对等成员,默认 claude + codex
          finalMembers = [
            { adapterId: 'claude', displayName: '🟣 Claude', enabled: true },
            { adapterId: 'codex',  displayName: '🟢 GPT',     enabled: true },
          ];
        } else {
          finalMembers = [
            { adapterId: 'claude', displayName: '🟣 Claude', enabled: true },
            { adapterId: 'codex',  displayName: '🟢 GPT',     enabled: true },
          ];
        }
      }
      const room = roomStore.create({ name, cwd: safeCwd, members: finalMembers, mode });

      // 7) PATCH 模板/body 提供的额外字段
      const patch = {};
      const debateRounds = template?.preset?.debateRounds ?? body.debateRounds;
      if (mode === 'debate' && Number.isFinite(Number(debateRounds))) {
        const n = Math.max(1, Math.min(10, Math.trunc(Number(debateRounds))));
        patch.debateRounds = n;
      }
      const qaStrictness = template?.preset?.qaStrictness ?? body.qaStrictness;
      if (mode === 'squad' && ['loose', 'standard', 'strict'].includes(qaStrictness)) {
        patch.qaStrictness = qaStrictness;
      }
      if (Object.keys(patch).length > 0) roomStore.update(room.id, patch);

      // 8) 启动（可选）
      let started = false;
      if (body.startNow === true || body.startNow === 'true' || body.startNow === 1) {
        try {
          if (mode === 'debate') {
            debateDispatcher.start(room.id, topic, { debateRounds: patch.debateRounds }).catch(() => {});
            started = true;
          } else if (mode === 'squad') {
            squadDispatcher.start(room.id, topic).catch(() => {});
            started = true;
          } else if (mode === 'arena') {
            arenaDispatcher.start(room.id, topic).catch(() => {});
            started = true;
          } else if (mode === 'chat') {
            // chat 没有 start，只有 sendMessage
            roomStore.update(room.id, { topic });
            soloChatDispatcher.sendMessage(room.id, topic).catch(() => {});
            started = true;
          } else if (mode === 'cross_verify') {
            const startGate = await prepareClusterRunGate(room, {
              roomStore,
              dispatcher: crossVerifyDispatcher,
              roomAdapterPool,
              broadcastRoom,
              topic,
            });
            if (!startGate.ok) {
              return res.json({
                ok: true,
                room,
                started: false,
                startError: startGate.error || 'cluster_run_gate_blocked',
                ...(startGate.concurrencyBudget ? { concurrencyBudget: startGate.concurrencyBudget } : {}),
                ...(startGate.preflight ? { preflight: startGate.preflight } : {}),
                ...(startGate.runtimeReconciliation ? { runtimeReconciliation: startGate.runtimeReconciliation } : {}),
                ...(startGate.liveCheck ? { liveCheck: startGate.liveCheck } : {}),
              });
            }
            let runPromise;
            try {
              runPromise = crossVerifyDispatcher.start(room.id, topic);
            } catch (e) {
              runPromise = Promise.reject(e);
            } finally {
              startGate.reservation?.release?.();
            }
            Promise.resolve(runPromise).catch(() => {});
            started = true;
          }
        } catch (e) {
          return res.json({ ok: true, room, started: false, startError: e.message });
        }
      } else if (topic) {
        // 不启动也保存 topic 到房（让 UI 看到）
        roomStore.update(room.id, { topic });
      }

      res.json({ ok: true, room: roomStore.get(room.id), started });
    } catch (e) {
      send500(res, e);
    }
  });
}
