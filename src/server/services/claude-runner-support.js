// @ts-check
// 第三波手术 第31批：claude-runner 子系统自 server.js 迁出（支撑层，原文迁移行为零差）
// 本文件 = sendMessageToClaude 之外的全部支撑件：
//   - naiveDiff/formatEditDiff/formatMultiEditDiff/formatWritePreview — v0.26 tool_use → markdown diff（纯函数，模块级导出）
//   - createClaudeRunnerSupport 工厂（注入 approvalStore/permissionGovernance/debouncedSave）返回：
//       sharedDetector/terminalApprovalGate — v0.5 思维镜融合实例（detector 无状态可共享）
//       ensureGuard/recordDanger/recordLoopGuard/ensureStateMachine/ensureCostTracker — per-session 机制实例
//       pushMessage/broadcastSession — v0.51 R-17 集中 push + cap；v0.49 B-03 中断后丢残余 stdout
//       evaluateClaudeToolPermission/blockClaudeToolUseByPermission — 权限治理评估/拦截
//       killChildAndUnbusy — SIGTERM + SIGKILL 看门狗 + busy 复位广播
// sendMessageToClaude 本体在 ./claude-runner.js（同批拆出，文件 <500 行硬规则）。
import { LoopGuard } from '../../safety/LoopGuard.js';
import { DangerousPatternDetector } from '../../safety/DangerousPatternDetector.js';
import { AgentStateMachine } from '../../state/AgentStateMachine.js';
import { CostTracker } from '../../cost/CostTracker.js';
import { TerminalApprovalGate } from '../../approval/CommandApprovalGate.js';

// ============ v0.26 tool_use Edit/Write/MultiEdit → markdown diff ============
export function naiveDiff(oldStr, newStr) {
  const oldLines = String(oldStr || '').split('\n');
  const newLines = String(newStr || '').split('\n');
  // 朴素 diff：先全删旧 + 再全加新（不做 LCS，避免引入 diff lib 依赖）
  const out = [];
  for (const ln of oldLines) out.push('- ' + ln);
  for (const ln of newLines) out.push('+ ' + ln);
  return out.join('\n');
}
export function formatEditDiff(input) {
  const path = input.file_path || '?';
  const diff = naiveDiff(input.old_string, input.new_string);
  return `🔧 **Edit** \`${path}\`\n\n\`\`\`diff\n${diff}\n\`\`\``;
}
export function formatMultiEditDiff(input) {
  const path = input.file_path || '?';
  const blocks = (input.edits || []).slice(0, 10).map((ed, i) => {
    return `**Edit ${i + 1}/${input.edits.length}**\n\`\`\`diff\n${naiveDiff(ed.old_string, ed.new_string)}\n\`\`\``;
  });
  const more = input.edits.length > 10 ? `\n\n_（还有 ${input.edits.length - 10} 个 edit 省略）_` : '';
  return `🔧 **MultiEdit** \`${path}\` (${input.edits.length} 处)\n\n${blocks.join('\n\n')}${more}`;
}
export function formatWritePreview(input) {
  const path = input.file_path || '?';
  const content = String(input.content || '');
  const truncated = content.length > 2000 ? content.slice(0, 2000) + '\n…（截断 ' + (content.length - 2000) + ' 字符）' : content;
  // 用 diff fence 全 + 着色，凸显"新写入"
  const diffStyle = truncated.split('\n').map(l => '+ ' + l).join('\n');
  return `🔧 **Write** \`${path}\` (${content.length} 字符)\n\n\`\`\`diff\n${diffStyle}\n\`\`\``;
}

export function createClaudeRunnerSupport({ approvalStore, permissionGovernance, debouncedSave }) {
  // ============ v0.5 思维镜融合：每个 session 配 5 个机制实例 ============
  const sharedDetector = new DangerousPatternDetector(); // 无状态可共享
  const terminalApprovalGate = new TerminalApprovalGate({ detector: sharedDetector, approvalStore });

  function ensureGuard(s) {
    if (!s.guard) s.guard = new LoopGuard();
    return s.guard;
  }
  // v0.27 安全历史：danger + loopGuard 触发记录
  function recordDanger(session, entry) {
    if (!session.dangerHistory) session.dangerHistory = [];
    session.dangerHistory.push({ ts: new Date().toISOString(), ...entry });
    if (session.dangerHistory.length > 100) session.dangerHistory = session.dangerHistory.slice(-100);
  }
  function recordLoopGuard(session, reason) {
    if (!session.loopGuardHistory) session.loopGuardHistory = [];
    session.loopGuardHistory.push({ ts: new Date().toISOString(), ...reason });
    if (session.loopGuardHistory.length > 100) session.loopGuardHistory = session.loopGuardHistory.slice(-100);
  }
  function ensureStateMachine(s) {
    if (!s.stateMachine) s.stateMachine = new AgentStateMachine();
    return s.stateMachine;
  }
  function ensureCostTracker(s) {
    if (!s.costTracker) s.costTracker = new CostTracker();
    return s.costTracker;
  }

  // v0.51 R-17 fix: 集中 push messages + 立即 cap + 广播 cap 事件
  // 让前端能同步调整 DOM data-msg-idx 偏移，避免 toggleStar 边界 race
  const MESSAGES_CAP = 200;
  function pushMessage(session, m) {
    session.messages.push(m);
    if (session.messages.length > MESSAGES_CAP) {
      const removed = session.messages.length - MESSAGES_CAP;
      session.messages = session.messages.slice(-MESSAGES_CAP);
      if (Array.isArray(session.starredIndices)) {
        session.starredIndices = session.starredIndices
          .filter(i => i >= removed).map(i => i - removed);
      }
      broadcastSession(session, { type: 'messages_capped', removed, newLength: session.messages.length });
    }
  }

  function broadcastSession(session, msg) {
    // v0.49 B-03 fix: 中断后丢弃残余 stdout（assistant message / tool_use / partial），
    // 状态类（busy / turn_end / state_change / cost_update）保留，让前端能正确同步。
    if (session._dropOutput && msg && typeof msg.type === 'string') {
      if (msg.type === 'message' || msg.type === 'partial_delta' || msg.type === 'partial_start' || msg.type === 'partial_stop') {
        return;
      }
    }
    for (const ws of session.clients) {
      if (ws.readyState === 1) {
        try { ws.send(JSON.stringify(msg)); } catch {}
      }
    }
  }

  function evaluateClaudeToolPermission(session, toolUse) {
    const name = toolUse?.name;
    const input = toolUse?.input || {};
    const base = {
      actorType: 'session',
      actorId: session.id,
      sessionId: session.id,
      roomId: session.roomId || null,
      agentRunId: session.agentRunId || null,
      cwd: session.cwd,
      details: { source: 'claude_tool_use', claudeSessionId: session.claudeSessionId || null },
    };

    if (name === 'Bash' && input.command) {
      return permissionGovernance.evaluatePermission({
        ...base,
        action: 'shell.exec',
        risk: 'high',
        target: { toolName: name, command: input.command, guardLevel: session.guardLevel || 'standard' },
      });
    }

    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name) && input.file_path) {
      return permissionGovernance.evaluatePermission({
        ...base,
        action: 'file.write',
        risk: 'high',
        target: { toolName: name, path: input.file_path },
      });
    }

    if (['Read', 'LS', 'Glob', 'Grep'].includes(name)) {
      const path = input.file_path || input.path;
      if (path) {
        return permissionGovernance.evaluatePermission({
          ...base,
          action: 'external_directory.access',
          risk: 'medium',
          target: { toolName: name, path },
        });
      }
    }

    return null;
  }

  function blockClaudeToolUseByPermission(session, child, toolUse, permission) {
    try { child.kill('SIGTERM'); } catch {}
    const approval = permission.approval || null;
    const entry = {
      blocked: true,
      approvalId: approval?.id || null,
      severity: permission.risk || 'high',
      action: permission.action,
      toolName: toolUse.name,
      reason: permission.reason,
      target: permission.target,
      permissionDecisionId: permission.id,
    };
    recordDanger(session, entry);
    if (permission.decision === 'ask') {
      broadcastSession(session, { type: 'approval_required', approval, permissionDecision: permission, ...entry });
    }
    broadcastSession(session, { type: 'permission_blocked', permissionDecision: permission, ...entry });
    if (toolUse.name === 'Bash') broadcastSession(session, { type: 'danger_blocked', approval, ...entry });
    const approvalLine = approval?.id ? `\n审批 ID：${approval.id}` : '';
    const m = {
      role: 'tool_use',
      content: `🛑 权限治理已暂停工具执行（${permission.decision}）：${toolUse.name}\n原因：${permission.reason}${approvalLine}`,
      ts: new Date().toISOString(),
    };
    pushMessage(session, m);
    broadcastSession(session, { type: 'message', message: m });
    debouncedSave();
    session.busy = false;
    return true;
  }

  // SIGTERM 不一定杀得掉子进程（CLI 捕获信号 / 有孙进程）。stdout 溢出、成本激增等保护路径若只
  // 发 SIGTERM 就 return，一旦 child 不退、child.on('exit') 不触发，session.busy 会永久卡 true（前端
  // 输入框锁死，只能 reset-busy/重启）。统一：立即复位 busy + 广播，并加 SIGKILL 看门狗兜底。
  function killChildAndUnbusy(session, child) {
    try { child.kill('SIGTERM'); } catch {}
    setTimeout(() => { try { if (child && !child.killed) child.kill('SIGKILL'); } catch {} }, 2000);
    session.busy = false;
    try { broadcastSession(session, { type: 'busy', busy: false }); } catch {}
  }

  return {
    sharedDetector,
    terminalApprovalGate,
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
  };
}
