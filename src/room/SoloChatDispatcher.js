// SoloChatDispatcher — 1v1 持续对话编排
//
// 跟 Debate / Squad 不同：
// - 只 1 个 AI 成员
// - 用户主导，每次 sendMessage 触发 adapter.chat()
// - conversation = 完整历史（按时间），AI 每次能看到所有上下文
//
// 数据：room.conversation = [{ at, from:'user'|'<adapterId>', content, error? }]

import { ROOM_LIMITS, CONTENT_LIMITS } from './squad-limits.js';
import { finalizeTurn } from '../autopilot/NoeTurnFinalizer.js';
import { estimateMessageTokens } from '../context/NoeTrajectoryCompactor.js';
import { metricsStore as defaultMetricsStore } from '../metrics/MetricsStore.js';
import { buildRoomAgentContext, injectSkillsToMessages, appendSystemContext } from './skillInjector.js';
import { summarizeAgentRuntimeContext } from '../agents/AgentSkillRegistry.js';
import { firstAvailableChatAdapter, isLocalChatAdapter, resolveForegroundChatChain } from './ForegroundChatRouting.js';
import { orchestrateTextToolTurn } from '../voice/NoeTextToolExecutor.js';
import { buildTextToolProtocolPrompt } from '../voice/NoeTextToolProtocol.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

const AUTO_PAUSE_THRESHOLD = 5;  // v0.53 Sprint 3.5
// 卡⑤ session rotate：对话粗估 token 超此阈值 → 标 rotateSuggested（前端亮"轮换交接"按钮，不自动轮换）
const ROTATE_SUGGEST_TOKENS = Number(process.env.NOE_ROTATE_TOKENS) || 24000;

function attachmentModelContext(attachments = []) {
  if (!Array.isArray(attachments) || attachments.length === 0) return '';
  const blocks = attachments.map((a, idx) => {
    const kind = a.kind || (String(a.mime || '').startsWith('video/') ? 'video' : 'image');
    return [
      `附件 ${idx + 1}: ${a.name || a.id || 'media'}`,
      `- kind: ${kind}`,
      `- mime: ${a.mime || ''}`,
      `- size: ${a.size || 0} bytes`,
      `- local_path: ${a.path || ''}`,
      `- sha256: ${a.sha256 || ''}`,
      kind === 'video'
        ? '- instruction: 请用你自己的原生 CLI/文件能力读取该视频；如无法直接理解视频，请先用可用工具抽帧/读取元数据，再基于真实结果回答。'
        : '- instruction: 请用你自己的原生多模态/文件能力打开并观察该图片，再基于真实视觉内容回答。',
    ].join('\n');
  }).join('\n\n');
  return `\n\n[用户上传了本机可读取媒体附件]\n${blocks}\n\n必须要求：不要假装看过附件；如果当前适配器确实无法读取某种媒体，请明确说明限制，并给出你实际能完成的替代读取方式。`;
}

function messageContentForModel(m) {
  const content = String(m?.content || '');
  if (m?.from !== 'user') return content;
  return content + attachmentModelContext(m.attachments || []);
}

function isIncompleteChatResult(result = {}) {
  const finishReason = String(result.finishReason || result.finish_reason || '').trim().toLowerCase();
  const completionStatus = String(result.completionStatus || '').trim().toLowerCase();
  return result.incomplete === true
    || result.truncated === true
    || result.continuationRequired === true
    || completionStatus === 'incomplete_length'
    || finishReason === 'length'
    || finishReason === 'max_tokens';
}

function incompleteChatError(result = {}) {
  const finishReason = String(result.finishReason || result.finish_reason || 'length').trim() || 'length';
  const err = new Error(`模型输出被截断（finish_reason=${finishReason}），已标记 incomplete，未保存半截回复。`);
  err.code = 'BRAIN_INCOMPLETE';
  err.finishReason = finishReason;
  err.tokensIn = result.tokensIn || 0;
  err.tokensOut = result.tokensOut || 0;
  return err;
}

// 方向一（文字聊天拉齐）：聊天室 1v1 注入哪些上下文段——只取与"记得你/查得到"相关的段，
// 不带 self-knowledge（Noe 人格，聊天室成员是任意 AI）/action（会真写记忆库）/视觉身份等语音专属段。
// ui-signals/acui-cards 两段在白名单内，但对应 store 仅当装配点 NOE_CHAT_UISIGNALS=1（默认 OFF）
// 才注入引擎；未注入时这两段完全 no-op（门控在 server.js 装配点，注入式可 fake）。
// P0.5 注入契约：inner-state（P4 认知态）/ persona-pin（P8 人设下沉）加入聊天白名单，使聊天入口也能注入这两段
//   （语音入口 sections=null 全开本就包含；二者 provider 未注入前完全 no-op）。
const CHAT_CONTEXT_SECTIONS = ['people', 'tool-bridge', 'recall', 'ui-signals', 'acui-cards', 'owner-profile', 'inner-state', 'persona-pin'];
// 聊天室记忆策略：召回 3 取 2，与语音 general 档同口径（仅 recall 段用到这两个值）。
const CHAT_MEMORY_POLICY = { id: 'chat', mode: 'general', recallLimit: 3, injectLimit: 2 };

export class SoloChatDispatcher {
  constructor({ store, adapters, broadcast, metrics, rotateSuggestTokens = ROTATE_SUGGEST_TOKENS, contextEngine = null, episodicTimeline = null, foregroundChatRouting = null, textToolRuntime = null }) {
    this.store = store;
    this.adapters = adapters;
    this.broadcast = broadcast || (() => {});
    this.metrics = metrics || defaultMetricsStore;  // v0.53 Sprint 3
    this.rotateSuggestTokens = rotateSuggestTokens; // 卡⑤：可注入便于测试；生产默认 NOE_ROTATE_TOKENS 或 24k
    // 方向一：NoeTurnContextEngine 注入后聊天室也能召回记忆/查人物库/跑工具桥；未注入完全旧行为（env 门控在装配点）。
    this.contextEngine = contextEngine;
    this.episodicTimeline = episodicTimeline; // 内在世界（记录覆盖扩展）：注入才把聊天室见闻记进自传体时间线
    this.foregroundChatRouting = foregroundChatRouting || null;
    // H3 本地模型文本工具协议（装配点 flag NOE_TEXT_TOOL_PROTOCOL 门控，注入才启用；null=现状零回归）：
    //   {allowedToolIds, invokeTool, maxCalls, maxRounds, realExecute} — 模型回复含 <<<NOE_TOOL>>> 标记时解析→执行只读工具→回灌续答。
    this.textToolRuntime = textToolRuntime;
    this.activeAborts = new Map(); // roomId → AbortController
    this._fails = new Map();  // v0.53 Sprint 3.5
  }

  _bumpFailure(roomId, isUserAbort) {
    if (isUserAbort) return;
    const n = (this._fails.get(roomId) || 0) + 1;
    this._fails.set(roomId, n);
    if (n >= AUTO_PAUSE_THRESHOLD) {
      this._fails.delete(roomId);
      const a = this.activeAborts.get(roomId);
      if (a) { try { a.abort(); } catch {} this.activeAborts.delete(roomId); }
      try { this.store.setStatus(roomId, 'auto_paused'); } catch {}
      try { this.broadcast(roomId, { type: 'room_auto_paused', reason: `连续 ${AUTO_PAUSE_THRESHOLD} 次 chat 失败/超时` }); } catch {}
    }
  }
  _resetFailure(roomId) { this._fails.delete(roomId); }

  abort(roomId) {
    const a = this.activeAborts.get(roomId);
    if (a) {
      a.abort();
      this.activeAborts.delete(roomId);
      this.broadcast(roomId, { type: 'chat_aborted' });
      return true;
    }
    return false;
  }

  /** 用户发一条消息，触发一次 AI 回应 */
  async sendMessage(roomId, userText, options = {}) {
    const room = this.store.get(roomId);
    if (!room) throw new Error('room not found');
    if (room.mode !== 'chat') throw new Error('room mode != chat');
    // v0.51 T-39 fix: 防并发 sendMessage（用户快速双击发送会让两个 adapter 并行 spawn）
    if (this.activeAborts.has(roomId)) {
      throw new Error('chat 房正在处理上一条消息，请等待回复或先 abort');
    }

    const enabled = (room.members || []).filter(m => m.enabled !== false);
    if (enabled.length === 0) throw new Error('chat 房需要 1 个启用成员');
    const member = enabled[0]; // 1v1 只取第一个
    let effectiveMember = member;
    let adapter = this.adapters.get(member.adapterId);
    if (this.foregroundChatRouting?.cloudOnly === true) {
      const chain = resolveForegroundChatChain({ profileChain: [member.adapterId], ...this.foregroundChatRouting });
      const cloudId = firstAvailableChatAdapter(chain, (id) => this.adapters.has(id));
      if (!cloudId) throw new Error(`chat 云端模型不可用（候选 ${chain.join('→')}），已禁止占用本地后台模型`);
      if (isLocalChatAdapter(member.adapterId, this.foregroundChatRouting.localAdapterIds) || cloudId !== member.adapterId) {
        const cloudAdapter = this.adapters.get(cloudId);
        effectiveMember = {
          ...member,
          adapterId: cloudId,
          displayName: cloudAdapter?.displayName || member.displayName || cloudId,
          model: cloudId === member.adapterId ? member.model : undefined,
        };
        adapter = cloudAdapter;
      }
    }
    if (!adapter) throw new Error('adapter not registered: ' + effectiveMember.adapterId);

    // 1. 追加用户消息到 conversation（v0.49 N-15: 持久化封顶）
    if (!Array.isArray(room.conversation)) room.conversation = [];
    const attachments = Array.isArray(options.attachments) ? options.attachments.slice(0, 8) : [];
    const userMsg = {
      at: new Date().toISOString(),
      from: 'user',
      content: String(userText || '').slice(0, 16000),
      ...(attachments.length ? { attachments } : {}),
    };
    room.conversation.push(userMsg);
    const maxKeep = ROOM_LIMITS.chatConversationMax || 200;
    if (room.conversation.length > maxKeep) {
      room.conversation = room.conversation.slice(-maxKeep);
    }
    this.store.update(roomId, { conversation: room.conversation });
    this.broadcast(roomId, { type: 'chat_user_msg', message: userMsg });

    // 2. 通知前端 AI 思考中
    this.broadcast(roomId, { type: 'chat_thinking', member: effectiveMember.adapterId, displayName: effectiveMember.displayName });

    // 3. 拍平 conversation → messages 数组给 adapter（v0.49 N-15: 发 LLM 时只取最近 N 条防 token 爆炸）
    const ctxMax = ROOM_LIMITS.chatContextMaxTurns || 40;
    const ctxSlice = room.conversation.slice(-ctxMax);
    let systemContent = `你是 ${effectiveMember.displayName}，正在和用户进行 1 对 1 对话。请用中文清晰回答。如有具体任务（写代码/查信息/做计算）请尽量真的去做。`;
    // 方向一（文字聊天拉齐）：注入了 ContextEngine 就让聊天室也"记得你/查得到"——
    // 记忆召回+人物库+工具桥三段（CHAT_CONTEXT_SECTIONS），projectId 固定 'noe'（记忆分区，
    // room.cwd 只是预算口径不是记忆域）；输入截 2000 与语音转写同口径。引擎失败不阻断聊天。
    if (this.contextEngine?.supplyTurnContext) {
      try {
        const supplied = await this.contextEngine.supplyTurnContext({
          transcript: String(userText || '').slice(0, 2000),
          projectId: 'noe',
          systemPrompt: systemContent,
          memoryPolicy: CHAT_MEMORY_POLICY,
          sections: CHAT_CONTEXT_SECTIONS,
        });
        if (supplied?.text) systemContent += supplied.text;
      } catch { /* 上下文供给失败不阻断聊天 */ }
    }
    const messages = [
      { role: 'system', content: systemContent },
      ...ctxSlice.map(m => ({
        role: m.from === 'user' ? 'user' : 'assistant',
        content: messageContentForModel(m),
      })),
    ];

    // M7 修复：L122 的早 check 与此处 set aborter 之间隔着 contextEngine 的 await，存在 TOCTOU 空窗，
    // 并发双击会双双越过早 check 并各自 spawn + 互相覆盖 aborter。在 set 紧前（无 await）再做一次原子
    // check，确保最终只有一个调用真正 spawn adapter。
    if (this.activeAborts.has(roomId)) {
      throw new Error('chat 房正在处理上一条消息，请等待回复或先 abort');
    }
    const aborter = new AbortController();
    this.activeAborts.set(roomId, aborter);
    const startedAt = Date.now();
    const agentContext = buildRoomAgentContext(room, { member: effectiveMember, objective: String(userText || '') + attachmentModelContext(attachments) });
    const agentMetrics = summarizeAgentRuntimeContext(agentContext);
    try {
      // H3：flag ON（注入 textToolRuntime）时把工具协议说明追加进 system 段，让本地模型知道怎么用 <<<NOE_TOOL>>> 标记。
      let outMessages = injectSkillsToMessages(messages, room, { agentContext });
      if (this.textToolRuntime) {
        const protoPrompt = buildTextToolProtocolPrompt(this.textToolRuntime.tools || []);
        if (protoPrompt) outMessages = appendSystemContext(outMessages, protoPrompt);
      }
      const result = await adapter.chat(outMessages, {
        cwd: room.cwd,
        abortSignal: aborter.signal,
        model: effectiveMember.model,
        budgetContext: { projectId: room.cwd, roomId: room.id, adapterId: effectiveMember.adapterId, agentProfileId: agentMetrics.agentProfileId },
      });
      if (isIncompleteChatResult(result)) throw incompleteChatError(result);
      // H3：模型回复含 <<<NOE_TOOL>>> 标记时，解析→执行只读工具→把结果回灌让模型续答（先编排再截断，
      //   防 256KB 截断切掉尾标记致漏配；续答复用同 aborter+budget+incomplete 检测，绝不绕过 abort/预算/截断红线）。
      let finalReply = result.reply;
      if (this.textToolRuntime) {
        try {
          let lastAssistantReply = result.reply; // 多轮：每轮带上模型刚产的含工具请求的 assistant 回复，保推理连贯（总验收 minor#2）
          const regenerate = async (feedbackText) => {
            const followup = [...outMessages, { role: 'assistant', content: String(lastAssistantReply || '') }, { role: 'user', content: String(feedbackText || '') }];
            const r2 = await adapter.chat(followup, {
              cwd: room.cwd,
              abortSignal: aborter.signal,
              model: effectiveMember.model,
              budgetContext: { projectId: room.cwd, roomId: room.id, adapterId: effectiveMember.adapterId, agentProfileId: agentMetrics.agentProfileId },
            });
            if (isIncompleteChatResult(r2)) throw incompleteChatError(r2);
            lastAssistantReply = r2.reply; // 下一轮（若有）带上本轮 assistant 回复
            return r2.reply;
          };
          const orch = await orchestrateTextToolTurn(result.reply, {
            allowedToolIds: this.textToolRuntime.allowedToolIds,
            invokeTool: this.textToolRuntime.invokeTool,
            regenerate,
            maxCalls: this.textToolRuntime.maxCalls || 3,
            maxRounds: this.textToolRuntime.maxRounds || 2,
            realExecute: this.textToolRuntime.realExecute !== false,
            redact: redactSensitiveText,
          });
          if (orch.used) finalReply = orch.reply;
        } catch (e) {
          // 编排失败（工具/续答异常）不阻断聊天：退回原始 reply。但【续答截断】必须抛（不落半截/带未消解标记的原文，
          //   与首答截断 L227 同口径）——incompleteChatError 设的是 e.code='BRAIN_INCOMPLETE'（L64），按此判。
          if (e && e.code === 'BRAIN_INCOMPLETE') throw e;
          finalReply = result.reply;
        }
      }
      // v0.51 ZZZZ-02 fix: AI reply 长度 cap，防极长输出撑爆 rooms.json
      const MAX_REPLY = CONTENT_LIMITS.maxReplyChars;  // v0.52 256KB
      const replyContent = (typeof finalReply === 'string' && finalReply.length > MAX_REPLY)
        ? finalReply.slice(0, MAX_REPLY) + `\n\n…（已截断，原 ${finalReply.length} 字符）`
        : finalReply;
      const aiMsg = {
        at: new Date().toISOString(),
        from: effectiveMember.adapterId,
        displayName: effectiveMember.displayName,
        content: replyContent,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
      };
      room.conversation.push(aiMsg);
      this.store.update(roomId, { conversation: room.conversation });
      try {
        this.metrics?.record?.({
          roomId: room.id, roomMode: 'chat', roomName: room.name,
          projectId: room.cwd,
          turn: 'chat', adapter: effectiveMember.adapterId, model: effectiveMember.model || '',
          latencyMs: Date.now() - startedAt,
          tokensIn: result.tokensIn || 0, tokensOut: result.tokensOut || 0,
          success: true, errorKind: null,
          agentRunId: result.agentRunId || '',
          ...agentMetrics,
        });
      } catch {}
      this._resetFailure(roomId);
      this.broadcast(roomId, { type: 'chat_ai_msg', message: aiMsg });
      // 卡⑤ session rotate：对话规模超阈值 → 标记建议轮换（只标一次；轮换动作由用户点按钮触发）
      if (!room.rotateSuggested) {
        const convTokens = estimateMessageTokens(room.conversation.map((m) => ({ content: m.content })));
        if (convTokens >= this.rotateSuggestTokens) {
          room.rotateSuggested = true;
          this.store.update(roomId, { rotateSuggested: true });
          this.broadcast(roomId, { type: 'chat_rotate_suggested', tokens: convTokens, threshold: this.rotateSuggestTokens });
        }
      }
      // 内在世界（记录覆盖扩展）：聊天室见闻记进自传体时间线。type 必须 'observation' 而非 'interaction'——
      // 聊天室成员是任意 AI 非 Noe 人格（见文件头注释），记 interaction 会污染 inferMood 的"和主人聊得正起劲"
      // 统计与"我和主人"主线叙事；salience 2 压低，不盖真实对话。写失败不阻断聊天返回。
      try {
        this.episodicTimeline?.record({
          type: 'observation',
          summary: `主人在聊天室和 ${effectiveMember.displayName} 聊"${String(userText || '').slice(0, 30)}"`,
          salience: 2,
        });
      } catch { /* 记录失败不阻断聊天 */ }
      return aiMsg;
    } catch (e) {
      const errMsg = {
        at: new Date().toISOString(),
        from: effectiveMember.adapterId,
        displayName: effectiveMember.displayName,
        content: '[失败] ' + e.message,
        error: true,
      };
      room.conversation.push(errMsg);
      this.store.update(roomId, { conversation: room.conversation });
      try {
        this.metrics?.record?.({
          roomId: room.id, roomMode: 'chat', roomName: room.name,
          projectId: room.cwd,
          turn: 'chat', adapter: effectiveMember.adapterId, model: effectiveMember.model || '',
          latencyMs: Date.now() - startedAt,
          tokensIn: 0, tokensOut: 0,
          success: false, errorKind: e?.code || e?.name || 'error',
          agentRunId: e.agentRunId || '',
          ...agentMetrics,
        });
      } catch {}
      // 预算硬停死前交接（波次6 接线 NoeTurnFinalizer）：把对话留痕成可接力交接写进 conversation
      // （确定性降级摘要，不再烧 LLM——预算已爆）。失败静默，不影响原错误处理。
      if (e?.code === 'BUDGET_LIMIT_EXCEEDED') {
        try {
          const fin = await finalizeTurn(
            room.conversation.map((m) => ({ role: m.from === 'user' ? 'user' : 'assistant', content: m.content })),
            { reason: 'budget_hard_stop', keepTail: 8 },
          );
          const finMsg = { at: new Date().toISOString(), from: 'system', displayName: '系统', content: fin.summary, finalizer: true };
          room.conversation.push(finMsg);
          this.store.update(roomId, { conversation: room.conversation });
          this.broadcast(roomId, { type: 'chat_finalizer', message: finMsg });
        } catch { /* 交接失败不影响错误处理 */ }
      }
      this._bumpFailure(roomId, aborter.signal.aborted);
      this.broadcast(roomId, { type: 'chat_error', error: e.message, message: errMsg });
      throw e;
    } finally {
      this.activeAborts.delete(roomId);
    }
  }
}
