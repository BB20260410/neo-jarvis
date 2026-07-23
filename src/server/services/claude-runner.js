// @ts-check
// 第三波手术 第31批：claude-runner 子系统自 server.js 迁出（主体层）
// sendMessageToClaude（401 行单函数）原文迁移、内部零重构、行为零差——
// 每条用户消息 = spawn 一次 claude --resume <sid> --input-format stream-json，pipe stdin/stdout：
//   LoopGuard 前置卫兵 → spawn → 项目上下文/接力/Focus Chain 注入 → 流式 stream_event 解析 →
//   AgentStateMachine/CostTracker → 权限治理 + DangerousPatternDetector 拦截 → exit 后 watcher 派发。
// 工厂注入（闭包依赖全注入，无模块级可变态）：
//   sessions — Map 本体留 server.js（单一属主），watcher 自动续发时重查存活用
//   claudeBin — CLAUDE_BIN 解析结果（env CLAUDE_BIN 优先，见 server.js resolveClaudeBin）
//   debouncedSave — sessions 持久化去抖（第30批 session-persistence 工厂产物）
//   approvalStore/permissionGovernance/activityLog — 安全治理/审计单例
//   getWatcherDispatcher — watcherDispatcher 是 server.js 的 let，经 getter 注入（S23 先例）
// 支撑件（broadcastSession/pushMessage/guard helpers/权限评估/killChildAndUnbusy）在
// ./claude-runner-support.js（同批拆出，文件 <500 行硬规则），随返回值一并透出给 server.js 接线。
import { spawn } from 'child_process';
import { focusChainHeader, buildDoneSummaries } from '../../planner/FocusChain.js';
import { estimateUsdFromUsage } from '../../cost/CostTracker.js';
import { createDangerousCommandApproval } from '../../approval/CommandApprovalGate.js';
import { buildProjectContextBundle, formatProjectContextBundle, summarizeProjectContextBundle } from '../../context/ProjectContextBundle.js';
import { applyClaudeOpus48RuntimeDefaults } from '../../room/ClaudeRuntimeDefaults.js';
import { createClaudeRunnerSupport, formatEditDiff, formatMultiEditDiff, formatWritePreview } from './claude-runner-support.js';

export function createClaudeRunner({
  sessions,
  claudeBin,
  debouncedSave,
  approvalStore,
  permissionGovernance,
  activityLog,
  getWatcherDispatcher,
}) {
  const support = createClaudeRunnerSupport({ approvalStore, permissionGovernance, debouncedSave });
  const {
    sharedDetector,
    ensureGuard,
    recordDanger,
    recordLoopGuard,
    ensureStateMachine,
    ensureCostTracker,
    pushMessage,
    broadcastSession,
    evaluateClaudeToolPermission,
    blockClaudeToolUseByPermission,
    killChildAndUnbusy,
  } = support;

  function sendMessageToClaude(session, userText) {
    // v0.51 ZZ-08 fix: 深度防御 — archived session 任何路径都不该 spawn（T-46 在端点层，这里在函数层）
    if (session.archived) return { ok: false, error: 'archived', message: '会话已归档' };
    if (session.busy) return {
      ok: false,
      error: 'busy',
      message: '上一条消息 claude 还在处理。等流式输出完成，或点 ⏸ 中断按钮（双击强制释放）后再发。',
    };

    // v0.51 S-23 fix: 中断后旧 child 可能未 exit，_dropOutput 还是 true；新 turn 必须重置
    // 否则新 child 的 stdout 会被 broadcastSession 错误拦截（B-03 fix 的副作用）
    session._dropOutput = false;
    session._lastInterrupted = false;
    // 如果旧 child 还活着（exit handler 还没跑完），先 force kill 避免两个 child 撞
    if (session.child && !session.child.killed) {
      try { session.child.kill('SIGKILL'); } catch {}
      session.child = null;
    }

    // ===== LoopGuard 前置卫兵 =====
    const guard = ensureGuard(session);
    const breakReason = guard.recordInstruction(userText);
    if (breakReason) {
      recordLoopGuard(session, breakReason);
      broadcastSession(session, { type: 'loop_guard_break', reason: breakReason });
      return { ok: false, error: 'loop_guard_break', reason: breakReason };
    }

    session.busy = true;

    const args = [
      '--print', '--verbose',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-partial-messages',  // v0.13: 让 claude 输出 token-by-token stream_event
      '--dangerously-skip-permissions',
    ];
    if (session.claudeSessionId) {
      args.push('--resume', session.claudeSessionId);
    }
    if (session.model) {
      args.push('--model', session.model);
    }
    applyClaudeOpus48RuntimeDefaults(args, session.model);

    const child = spawn(claudeBin, args, {
      cwd: session.cwd,
      env: { ...process.env, TERM: 'xterm-256color', LANG: 'zh_CN.UTF-8' },
    });
    session.child = child;
    session.pid = child.pid;
    broadcastSession(session, { type: 'busy', busy: true });

    // 接力 session 首条消息：自动给 claude prepend HANDOFF 接手提示
    // 判定：claudeSessionId 还没落定（新生）+ messages 里有 role=system 的接力 banner
    let payloadText = userText;
    let primedThisTurn = false;
    if (!session.claudeSessionId && !session.projectContextPrimed) {
      try {
        const bundle = buildProjectContextBundle(session.cwd);
        const prompt = formatProjectContextBundle(bundle);
        if (prompt) {
          payloadText =
            `${prompt}\n\n--- 用户消息 ---\n${payloadText}`;
          session.projectContextPrimed = true;
          session.projectContextSummary = summarizeProjectContextBundle(bundle);
          activityLog.recordSafe({
            action: 'project_context.injected',
            actorType: 'system',
            sessionId: session.id,
            entityType: 'session',
            entityId: session.id,
            details: session.projectContextSummary,
          });
          broadcastSession(session, { type: 'project_context_injected', summary: session.projectContextSummary });
        } else {
          session.projectContextPrimed = true;
        }
      } catch (e) {
        console.warn('[project-context] session inject failed:', e.message);
        session.projectContextPrimed = true;
      }
    }
    if (!session.claudeSessionId && !session.handoffPrimed) {
      const hasHandoffBanner = session.messages.some(m => m.role === 'system' && m.content && m.content.startsWith('🔁'));
      if (hasHandoffBanner) {
        payloadText =
          '【接力上下文】你是从上个 Claude 会话接力过来的新 Claude。' +
          '请先 `cat ~/HANDOFF_LATEST.md` 读完事实快照（含 TaskList / Last activity / 项目状态文件 / Recent prompts 等），' +
          '理解上一会话做到哪了，然后接着回答用户下面的消息。不要先汇报"我读完了"，直接进入工作。\n\n' +
          '--- 用户消息 ---\n' +
          userText;
        primedThisTurn = true;
      }
    }

    // ===== Focus Chain 注入（每 5 个 user message 一次）=====
    if (session.mainGoal) {
      const userMsgCount = session.messages.filter(m => m.role === 'user').length + 1; // +1 for this turn
      const fc = focusChainHeader({
        mainGoal: session.mainGoal,
        doneSummaries: buildDoneSummaries(session.messages),
        userMsgCount,
        triggerInterval: 5,
      });
      if (fc) {
        payloadText = fc + payloadText;
        broadcastSession(session, { type: 'focus_chain_injected', step: userMsgCount });
      }
    }

    const userMsg = { role: 'user', content: userText, ts: new Date().toISOString() };
    pushMessage(session, userMsg);
    broadcastSession(session, { type: 'message', message: userMsg });
    debouncedSave();

    const sm = ensureStateMachine(session);
    const tracker = ensureCostTracker(session);

    // v0.13 流式：累积每个 content block 的 partial text，按 block_index 跟踪
    // 同一个 turn 内 message_start → 多个 content_block_start/delta/stop → message_delta → message_stop
    const partialBlocks = new Map(); // block_index → { type, text, toolName? }

    let stdoutBuf = '';
    // v0.51 S-13 fix: 单行无 \n 不能无限累积 buffer
    const STDOUT_BUF_MAX = 50 * 1024 * 1024; // 50MB 单行上限
    child.stdout.on('data', d => {
      // 旧 child（已被中断/新消息替换或置 null）的残留 stdout 直接丢弃，防污染新对话
      if (child !== session.child) return;
      stdoutBuf += d.toString();
      if (stdoutBuf.length > STDOUT_BUF_MAX) {
        console.warn(`[session ${session.id}] stdout 单行超 ${STDOUT_BUF_MAX} 字节，强制截断并 kill child`);
        stdoutBuf = '';
        killChildAndUnbusy(session, child);
        return;
      }
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.session_id && !session.claudeSessionId) {
            session.claudeSessionId = obj.session_id;
          }

          // ===== v0.13 流式事件解析（来自 --include-partial-messages）=====
          if (obj.type === 'stream_event' && obj.event) {
            const ev = obj.event;
            if (ev.type === 'content_block_start') {
              const idx = ev.index;
              const cb = ev.content_block || {};
              partialBlocks.set(idx, {
                type: cb.type,
                text: cb.text || '',
                toolName: cb.name,
                toolInput: cb.input || {},
              });
              broadcastSession(session, {
                type: 'partial_start',
                blockIndex: idx,
                blockType: cb.type,
                toolName: cb.name,
                ts: new Date().toISOString(),
              });
            } else if (ev.type === 'content_block_delta') {
              const idx = ev.index;
              const delta = ev.delta || {};
              const slot = partialBlocks.get(idx);
              if (slot) {
                if (delta.type === 'text_delta' && delta.text) {
                  slot.text += delta.text;
                  broadcastSession(session, {
                    type: 'partial_delta',
                    blockIndex: idx,
                    blockType: 'text',
                    textDelta: delta.text,
                  });
                } else if (delta.type === 'input_json_delta' && delta.partial_json) {
                  // tool input 累积（不主动广播每个字符，太碎）
                  slot._inputJsonBuf = (slot._inputJsonBuf || '') + delta.partial_json;
                } else if (delta.type === 'thinking_delta' && delta.thinking) {
                  slot.text += delta.thinking;
                  broadcastSession(session, {
                    type: 'partial_delta',
                    blockIndex: idx,
                    blockType: 'thinking',
                    textDelta: delta.thinking,
                  });
                }
              }
            } else if (ev.type === 'content_block_stop') {
              const idx = ev.index;
              const slot = partialBlocks.get(idx);
              broadcastSession(session, {
                type: 'partial_stop',
                blockIndex: idx,
                finalText: slot?.text || '',
              });
              // v0.51 X-03 fix: block 结束后释放 Map entry，避免长 turn 多 block 累积内存
              partialBlocks.delete(idx);
            }
            continue; // stream_event 不进后面的"完整 assistant message"处理
          }

          // ===== AgentStateMachine =====
          const transition = sm.ingest(obj);
          if (transition) {
            session.runState = transition.to;
            broadcastSession(session, { type: 'state_change', state: transition.to, from: transition.from, reason: transition.reason });
          }

          // ===== CostTracker（result 时 claude 给 usage）=====
          if (obj.type === 'result' && obj.usage) {
            const model = session.model || obj.modelUsage && Object.keys(obj.modelUsage)[0] || 'claude-opus-4-7';
            if (obj.modelUsage) {
              // 新版 claude --output-format stream-json result 给 modelUsage 分模型统计
              for (const [m, u] of Object.entries(obj.modelUsage)) {
                const usd = estimateUsdFromUsage(u, m);
                tracker.record(usd, (u.input_tokens || 0) + (u.output_tokens || 0), m);
              }
            } else {
              const usd = estimateUsdFromUsage(obj.usage, model);
              tracker.record(usd, (obj.usage.input_tokens || 0) + (obj.usage.output_tokens || 0), model);
            }
            // LoopGuard 成本激增检查
            const surgeBreak = guard.recordCost(tracker.windowUSD(5 * 60 * 1000));
            if (surgeBreak) {
              recordLoopGuard(session, surgeBreak);
              broadcastSession(session, { type: 'loop_guard_break', reason: surgeBreak });
              killChildAndUnbusy(session, child);
              return;
            }
            broadcastSession(session, { type: 'cost_update', snapshot: tracker.snapshot() });
          }

          if (obj.type === 'assistant' && obj.message?.content) {
            // 记录 model
            if (obj.message.model && !obj.message.model.startsWith('<')) {
              session.model = obj.message.model;
            }
            const content = obj.message.content;
            if (Array.isArray(content)) {
              for (const c of content) {
                if (c.type === 'text' && c.text) {
                  const m = { role: 'assistant', content: c.text, ts: new Date().toISOString() };
                  pushMessage(session, m);
                  broadcastSession(session, { type: 'message', message: m });
                  debouncedSave();
                } else if (c.type === 'tool_use') {
                  const permission = evaluateClaudeToolPermission(session, c);
                  if (permission && permission.decision !== 'allow') {
                    blockClaudeToolUseByPermission(session, child, c, permission);
                    return;
                  }
                  // ===== DangerousPatternDetector 扫描 Bash =====
                  if (c.name === 'Bash' && c.input?.command) {
                    const hits = sharedDetector.scan(c.input.command);
                    if (hits.length > 0) {
                      const worst = sharedDetector.worstSeverity(hits);
                      if (sharedDetector.shouldBlock(hits, session.guardLevel || 'standard')) {
                        const approvalResult = createDangerousCommandApproval({
                          command: c.input.command,
                          detector: sharedDetector,
                          approvalStore,
                          guardLevel: session.guardLevel || 'standard',
                          source: 'claude_bash',
                          cwd: session.cwd,
                          requesterType: 'session',
                          requesterId: session.id,
                          metadata: { claudeSessionId: session.claudeSessionId || null, sessionName: session.name || null },
                        });
                        // CRITICAL/HIGH：立刻 kill + 警告
                        try { child.kill('SIGTERM'); } catch {}
                        const dangerEntry = {
                          blocked: true,
                          approvalId: approvalResult.approval?.id || null,
                          severity: worst,
                          command: c.input.command.slice(0, 500),
                          hits: hits.map(h => ({ severity: h.rule.severity, category: h.rule.category, advice: h.rule.advice, snippet: h.snippet })),
                        };
                        recordDanger(session, dangerEntry);
                        broadcastSession(session, { type: 'approval_required', approval: approvalResult.approval, ...dangerEntry });
                        broadcastSession(session, { type: 'danger_blocked', ...dangerEntry });
                        const dmsg = {
                          role: 'tool_use',
                          content: `🛑 危险命令已暂停等待审批（${worst}）：${c.input.command.slice(0, 200)}\n` +
                                   `审批 ID：${approvalResult.approval?.id || 'unknown'}\n` +
                                   hits.map(h => `  • [${h.rule.severity}] ${h.rule.category}: ${h.rule.advice}`).join('\n'),
                          ts: new Date().toISOString(),
                        };
                        pushMessage(session, dmsg);
                        broadcastSession(session, { type: 'message', message: dmsg });
                        debouncedSave();
                        session.busy = false;
                        return;
                      } else {
                        // LOW：只警告不拦
                        const warnEntry = {
                          blocked: false,
                          severity: worst,
                          command: c.input.command.slice(0, 500),
                          hits: hits.map(h => ({ severity: h.rule.severity, category: h.rule.category, advice: h.rule.advice })),
                        };
                        recordDanger(session, warnEntry);
                        broadcastSession(session, { type: 'danger_warn', ...warnEntry });
                      }
                    }
                  }
                  // v0.26 Edit/Write/MultiEdit → markdown diff fence
                  let toolContent = `🔧 ${c.name}: ${JSON.stringify(c.input).substring(0, 300)}`;
                  try {
                    if (c.name === 'Edit' && c.input?.old_string != null && c.input?.new_string != null) {
                      toolContent = formatEditDiff(c.input);
                    } else if (c.name === 'MultiEdit' && Array.isArray(c.input?.edits)) {
                      toolContent = formatMultiEditDiff(c.input);
                    } else if (c.name === 'Write' && c.input?.file_path) {
                      toolContent = formatWritePreview(c.input);
                    }
                  } catch { /* fallback 用原 JSON 截断 */ }
                  const m = {
                    role: 'tool_use',
                    content: toolContent,
                    ts: new Date().toISOString()
                  };
                  pushMessage(session, m);
                  broadcastSession(session, { type: 'message', message: m });
                  debouncedSave();
                }
              }
            }
          }
        } catch {}
      }
    });

    child.stderr.on('data', d => {
      broadcastSession(session, { type: 'stderr', data: d.toString() });
    });
    // v0.51 W-08 fix: stdout/stderr 流 error 事件防御（pipe break / OS 错误时整个 panel 不崩）
    child.stdout.on('error', (e) => { console.warn(`[session ${session.id}] stdout error:`, e.message); });
    child.stderr.on('error', (e) => { console.warn(`[session ${session.id}] stderr error:`, e.message); });

    child.on('exit', async (code) => {
      session.busy = false;
      session.child = null;
      if (primedThisTurn) session.handoffPrimed = true;
      // v0.38 P0-B: 若是用户中断（SIGINT/reset-busy），exit code 可能仍是 0，但不应触发 watcher 判定
      const wasInterrupted = !!session._lastInterrupted;
      session._lastInterrupted = false; // 一次性标记，立即清
      // v0.49 B-03 fix: 清 dropOutput 之前先发完 turn_end，再恢复后续输出（其实 child 已退也没后续）
      const wasDroppingOutput = !!session._dropOutput;
      session._dropOutput = false;
      // v0.49 B-03 fix: 中断时 exit handler 是唯一的 busy=false 广播源，避免前端早早解锁却还在收 message
      if (wasInterrupted || wasDroppingOutput) {
        broadcastSession(session, { type: 'busy', busy: false, exitCode: code, interrupted: true });
        broadcastSession(session, { type: 'turn_end', exitCode: code, interrupted: true });
      } else {
        broadcastSession(session, { type: 'busy', busy: false, exitCode: code });
      }
      // v0.34 Watcher: turn 结束（exit code=0）触发 dispatcher；v0.38 跳过被中断的 turn
      // （watcherDispatcher 是 server.js 的 let，exit 时刻经 getter 取当下实例，语义同原模块级读取）
      const watcherDispatcher = getWatcherDispatcher();
      if (code === 0 && !wasInterrupted && watcherDispatcher && session.watcherEnabled) {
        try {
          const r = await watcherDispatcher.onResultEvent(session, { is_error: false });
          // 自动模式 + verdict.continue + 安全过 → 自动把 next_action.prompt 发回 claude
          if (r?.autoExecute && r.prompt) {
            // v0.45 P2-5: 1s 后 session 可能已被删，重查一次再发
            // v0.51 ZZ-07 fix: 1s 内可能被 archived，跳过避免对归档 session 强 spawn
            setTimeout(() => {
              const live = sessions.get(session.id);
              if (live && !live.archived) sendMessageToClaude(live, r.prompt);
            }, 1000);
          }
        } catch (e) {
          console.warn('watcher dispatch error:', e.message);
        }
      }
    });

    child.on('error', (e) => {
      session.busy = false;
      session.child = null;
      broadcastSession(session, { type: 'error', error: e.message });
    });

    const payload = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: payloadText }] }
    }) + '\n';
    // v0.51 T-35 fix: stdin EPIPE 防御（child 立即死 / binary 不存在时 write 会抛）
    child.stdin.on('error', (e) => {
      if (e.code === 'EPIPE') return;
      console.warn(`[session ${session.id}] stdin error:`, e.message);
    });
    try { child.stdin.write(payload); } catch (e) {
      if (e.code !== 'EPIPE') console.warn(`[session ${session.id}] stdin write:`, e.message);
    }
    try { child.stdin.end(); } catch {}

    return { ok: true };
  }

  return {
    sendMessageToClaude,
    ...support,
  };
}
