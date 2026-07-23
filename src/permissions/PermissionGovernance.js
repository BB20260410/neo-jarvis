import { createHash, randomUUID } from 'node:crypto';
import { resolve, dirname, basename, join, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { approvalStore as defaultApprovalStore } from '../approval/ApprovalStore.js';
import { activityLog as defaultActivityLog } from '../audit/ActivityLog.js';
import { agentRunStore as defaultAgentRunStore } from '../agents/AgentRunStore.js';
import { DangerousPatternDetector } from '../safety/DangerousPatternDetector.js';
import {
  compactNoePolicyFileGuardReport,
  evaluateNoePolicyFileWrite,
  evaluateNoePolicyShellMutation,
} from '../security/NoePolicyFileGuard.js';
// SSRF 私网判定统一走 SsrfGuard（删本文件弱版 isPrivateHost）。同步决策场景用 isPrivateHostSync：
//   IP 字面量走强版 isPrivateIp（识破 IPv4-mapped 等）、域名行为不变 → 零回归。
import { isPrivateHostSync } from '../security/SsrfGuard.js';

const DECISIONS = new Set(['allow', 'ask', 'deny']);
const MAX_TEXT = 1000;

function nowMs() {
  return Date.now();
}

function safeString(value, max = MAX_TEXT) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  try { return JSON.parse(JSON.stringify(value)); } catch { return {}; }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`);
  return `{${entries.join(',')}}`;
}

function hashParts(parts = []) {
  return createHash('sha256').update(parts.map(part => safeString(part, 2000)).join('\n---\n')).digest('hex').slice(0, 32);
}

function normalizePathLike(value) {
  const text = safeString(value, 2000);
  if (!text || text.includes('\0')) return '';
  return text;
}

// 解析 realpath；路径不存在时回退到「最近已存在父目录的 realpath + 剩余相对部分」，
// 以便对尚未创建的新文件也能做防 symlink 越界校验，且不因 ENOENT 误拒。
function realpathOrSelf(p) {
  try {
    return realpathSync(p);
  } catch {
    const parent = dirname(p);
    if (!parent || parent === p) return p;
    return join(realpathOrSelf(parent), basename(p));
  }
}

function pathInside(base, target) {
  if (!base || !target) return true;
  const root = realpathOrSelf(resolve(base));
  const next = realpathOrSelf(resolve(resolve(base), target));
  return next === root || next.startsWith(root + sep);
}

function hostnameFromUrl(value) {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function approvalMatchesActionTarget(approval, { action, target }) {
  const payload = approval?.payload || {};
  return safeString(payload.action, 160) === action && stableJson(safeJson(payload.target)) === stableJson(safeJson(target));
}

// 解析多 approvalId：接受数组或逗号分隔字符串，去重去空
function parseApprovalIds(v) {
  if (!v) return [];
  const arr = Array.isArray(v) ? v : String(v).split(',');
  const out = [];
  for (const s of arr) {
    const t = safeString(s, 160);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export class PermissionPolicy {
  constructor(input = {}) {
    this.shell = input.shell || 'ask_dangerous';
    this.fileWriteDelete = input.fileWriteDelete || 'ask_external_or_sensitive';
    this.externalDirectory = input.externalDirectory || 'ask';
    this.skillPlugin = input.skillPlugin || 'ask';
    this.providerModelConfig = input.providerModelConfig || 'ask';
    this.networkUpload = input.networkUpload || 'allow';
    this.autoAccept = input.autoAccept || 'low_risk_only';
    this.ownerTrust = input.ownerTrust === 'default' ? 'default' : 'full'; // owner 最新授权：默认完整开发者权限
  }
}

export class PermissionDecision {
  constructor(input = {}) {
    const decision = safeString(input.decision || 'allow', 20);
    if (!DECISIONS.has(decision)) throw new Error(`invalid permission decision: ${decision}`);
    this.id = input.id || `permission-${randomUUID().slice(0, 12)}`;
    this.decision = decision;
    this.reason = safeString(input.reason || decision, 500);
    this.action = safeString(input.action, 160);
    this.actorType = safeString(input.actorType || 'system', 80);
    this.actorId = safeString(input.actorId, 160) || null;
    this.agentRunId = safeString(input.agentRunId, 160) || null;
    this.roomId = safeString(input.roomId, 160) || null;
    this.sessionId = safeString(input.sessionId, 160) || null;
    this.cwd = safeString(input.cwd, 2000) || null;
    this.risk = safeString(input.risk || 'low', 40);
    this.target = safeJson(input.target);
    this.details = safeJson(input.details);
    this.approvalPayload = input.approvalPayload ? safeJson(input.approvalPayload) : null;
    this.approval = input.approval || null;
    this.createdAt = Number(input.createdAt) || nowMs();
  }
}

export class ToolInvocationRecord {
  constructor(input = {}) {
    this.id = input.id || `tool-invocation-${randomUUID().slice(0, 12)}`;
    this.action = safeString(input.action, 160);
    this.toolName = safeString(input.toolName || input.action, 160);
    this.actorType = safeString(input.actorType || 'system', 80);
    this.actorId = safeString(input.actorId, 160) || null;
    this.agentRunId = safeString(input.agentRunId, 160) || null;
    this.roomId = safeString(input.roomId, 160) || null;
    this.sessionId = safeString(input.sessionId, 160) || null;
    this.cwd = safeString(input.cwd, 2000) || null;
    this.target = safeJson(input.target);
    this.permissionDecisionId = safeString(input.permissionDecisionId, 160) || null;
    this.status = safeString(input.status || 'planned', 40);
    this.createdAt = Number(input.createdAt) || nowMs();
  }
}

export class PermissionGovernance {
  constructor({
    policy = new PermissionPolicy(),
    approvalStore = defaultApprovalStore,
    audit = defaultActivityLog,
    agentRuns = defaultAgentRunStore,
    detector = new DangerousPatternDetector(),
    now = () => Date.now(),
    env = process.env,
  } = {}) {
    this.policy = policy instanceof PermissionPolicy ? policy : new PermissionPolicy(policy);
    this.approvalStore = approvalStore;
    this.audit = audit;
    this.agentRuns = agentRuns;
    this.detector = detector;
    this.now = now;
    this.env = env;
    // A2 同指纹复用窗口：owner 刚批准过的"完全相同操作"（dedupeKey 含 actor/action/target/cwd 全量指纹）
    // 在 TTL 内自动放行，治"每个 MCP 调用都要批一次"的审批疲劳——疲劳的下场是 owner 关掉治理。
    // 默认 10 分钟；NOE_APPROVAL_REUSE_TTL_MS=0 关闭。复用同样全量进审计（reason/reusedApprovalId 留痕）。
    const ttl = Number(env?.NOE_APPROVAL_REUSE_TTL_MS);
    this.approvalReuseTtlMs = Number.isFinite(ttl) ? Math.max(0, ttl) : 10 * 60 * 1000;
  }

  evaluatePermission(input = {}) {
    const action = safeString(input.action, 160);
    const target = safeJson(input.target);
    const approvalId = safeString(input.approvalId || input.permissionApprovalId || input.resumeApprovalId, 160);
    const approvalIds = parseApprovalIds(input.approvalIds);
    const context = {
      actorType: safeString(input.actorType || 'system', 80),
      actorId: safeString(input.actorId || input.requesterId, 160),
      agentRunId: safeString(input.agentRunId, 160),
      roomId: safeString(input.roomId, 160),
      sessionId: safeString(input.sessionId, 160),
      taskId: safeString(input.taskId, 240),
      cwd: safeString(input.cwd, 2000),
      risk: safeString(input.risk || 'low', 40),
    };
    let decision = this.classify({ ...context, action, target, details: input.details || {} });
    if (decision.decision === 'ask' && approvalIds.length) {
      decision = this.resolveResumeApprovalMulti({ approvalIds, action, target, decision });
    } else if (decision.decision === 'ask' && approvalId) {
      decision = this.resolveResumeApproval({ approvalId, action, target, decision });
    }
    if (decision.decision === 'ask') {
      // A2：无 approvalId 时查同指纹近期已批准单，TTL 内自动复用（最新一条是 denied/pending 则不复用）
      const reused = this.resolveRecentApprovedDedupe({ ...context, action, target, decision });
      if (reused) decision = reused;
    }
    if (decision.decision === 'ask') {
      const approvalPayload = this.buildApprovalPayload({ ...context, action, target, decision, details: input.details || {} });
      const approval = decision.approval || this.createApproval({ ...context, action, target, decision, approvalPayload });
      decision = { ...decision, approvalPayload, approval };
    }
    const finalDecision = new PermissionDecision({ ...context, action, target, ...decision });
    const invocation = new ToolInvocationRecord({
      ...context,
      action,
      toolName: target.toolName || target.pluginId || target.type || action,
      target,
      permissionDecisionId: finalDecision.id,
      status: finalDecision.decision,
    });
    this.recordDecision(finalDecision, invocation);
    return { ...finalDecision, invocation };
  }

  resolveResumeApproval({ approvalId, action, target, decision }) {
    const approval = this.approvalStore?.getApproval?.(approvalId);
    if (!approval) {
      return {
        decision: 'deny',
        reason: 'approval not found for permission resume',
        risk: 'high',
        details: { resumeApprovalId: approvalId },
      };
    }
    if (!approvalMatchesActionTarget(approval, { action, target })) {
      return {
        decision: 'deny',
        reason: 'approval does not match permission action/target',
        risk: 'high',
        approval,
        approvalPayload: approval.payload || null,
        details: { resumeApprovalId: approvalId, approvalStatus: approval.status || null },
      };
    }
    if (approval.status === 'approved') {
      return {
        decision: 'allow',
        reason: 'approved permission resumed',
        risk: decision.risk || 'high',
        approval,
        approvalPayload: approval.payload || null,
        details: {
          ...(decision.details || {}),
          resumeApprovalId: approvalId,
          approvalStatus: approval.status,
          resumed: true,
        },
      };
    }
    if (approval.status === 'pending') {
      return {
        ...decision,
        approval,
        approvalPayload: approval.payload || null,
        reason: 'approval is still pending',
        details: {
          ...(decision.details || {}),
          resumeApprovalId: approvalId,
          approvalStatus: approval.status,
        },
      };
    }
    return {
      decision: 'deny',
      reason: `approval ${approval.status || 'closed'}; permission resume denied`,
      risk: 'high',
      approval,
      approvalPayload: approval.payload || null,
      details: { resumeApprovalId: approvalId, approvalStatus: approval.status || null },
    };
  }

  // 多 approvalId 解析（用于 watcher 这类同一请求内多个独立权限检查的双重/多重审批入口）：
  // 从列表中找到与「当前 action/target」匹配的那个 approval，按其状态决定。
  // 与单 approvalId 不同：若列表中没有任何 id 匹配本 action/target，保持原 ask（让本 action 另建审批），
  // 而非 deny —— 因为这些 id 可能属于同请求的其它权限检查，误 deny 会卡住链式批准。
  resolveResumeApprovalMulti({ approvalIds, action, target, decision }) {
    for (const id of approvalIds) {
      const approval = this.approvalStore?.getApproval?.(id);
      if (!approval) continue;
      if (!approvalMatchesActionTarget(approval, { action, target })) continue;
      if (approval.status === 'approved') {
        return {
          decision: 'allow',
          reason: 'approved permission resumed',
          risk: decision.risk || 'high',
          approval,
          approvalPayload: approval.payload || null,
          details: { ...(decision.details || {}), resumeApprovalId: id, approvalStatus: approval.status, resumed: true },
        };
      }
      if (approval.status === 'pending') {
        return {
          ...decision,
          approval,
          approvalPayload: approval.payload || null,
          reason: 'approval is still pending',
          details: { ...(decision.details || {}), resumeApprovalId: id, approvalStatus: approval.status },
        };
      }
      return {
        decision: 'deny',
        reason: `approval ${approval.status || 'closed'}; permission resume denied`,
        risk: 'high',
        approval,
        approvalPayload: approval.payload || null,
        details: { resumeApprovalId: id, approvalStatus: approval.status || null },
      };
    }
    return decision; // 无匹配：保持 ask，由本 action 另建/复用审批
  }

  classify({ action, target, cwd, risk }) {
    if (action.startsWith('shell.')) {
      const command = safeString(target.command, 4000);
      const policyGuard = evaluateNoePolicyShellMutation({
        command,
        args: Array.isArray(target.args) ? target.args : [],
        cwd: cwd || process.cwd(),
        root: process.cwd(),
        env: this.env,
      });
      if (policyGuard.blocked) {
        return {
          decision: 'deny',
          reason: 'noe_policy_file_mutation_denied',
          risk: 'critical',
          details: { noePolicyFileGuard: compactNoePolicyFileGuardReport(policyGuard) },
        };
      }
      const hits = this.detector.scan(command);
      const worstSeverity = this.detector.worstSeverity(hits);
      if (this.policy.ownerTrust === 'full') {
        return { decision: 'allow', reason: hits.length ? 'shell command allowed by owner full developer trust with warnings' : 'shell command allowed by owner full developer trust', risk: worstSeverity || risk || 'low', details: { hits } };
      }
      // owner 偏好（2026-06-11 回滚 guardLevel 收紧）：尊重调用方/session 传入的 guardLevel，
      // loose 可跳过 HIGH 规则——开发者要 freedom 最大权限，不强制服务端固定 standard。
      if (this.detector.shouldBlock(hits, target.guardLevel || 'standard')) {
        return {
          decision: 'ask',
          reason: `shell command requires approval: ${worstSeverity || 'dangerous'}`,
          risk: worstSeverity || 'high',
          details: { hits },
        };
      }
      return { decision: 'allow', reason: hits.length ? 'shell command has low-risk warnings' : 'shell command allowed', risk: worstSeverity || risk || 'low' };
    }

    if (action === 'file.write' || action === 'file.delete') {
      const path = normalizePathLike(target.path || target.filePath);
      if (!path) return { decision: 'deny', reason: 'file target path missing', risk: 'high' };
      const policyGuard = evaluateNoePolicyFileWrite({
        path,
        operation: action,
        cwd: cwd || process.cwd(),
        root: process.cwd(),
        env: this.env,
      });
      if (policyGuard.blocked) {
        return {
          decision: 'deny',
          reason: 'noe_policy_file_mutation_denied',
          risk: 'critical',
          details: { noePolicyFileGuard: compactNoePolicyFileGuardReport(policyGuard) },
        };
      }
      if (this.policy.ownerTrust === 'full') {
        return { decision: 'allow', reason: 'file operation allowed by owner full developer trust', risk: risk || 'medium' };
      }
      if (target.requiresApproval || target.approvalRequired) {
        return { decision: 'ask', reason: 'file operation requested explicit approval', risk: risk || 'high' };
      }
      if (/(^|\/)(\.ssh|\.aws|\.gnupg|\.docker|\.kube)(\/|$)/.test(path) || /(^|\/)\.env(\.|$|\/)?/.test(path)) {
        return { decision: 'ask', reason: 'sensitive file write/delete requires approval', risk: 'high' };
      }
      if (cwd && !pathInside(cwd, path)) {
        return { decision: 'ask', reason: 'external directory file write/delete requires approval', risk: 'high' };
      }
      return { decision: 'allow', reason: 'project-local file operation allowed', risk: risk || 'medium' };
    }

    if (action === 'external_directory.access') {
      const path = normalizePathLike(target.path || target.cwd);
      if (!path) return { decision: 'deny', reason: 'external directory path missing', risk: 'high' };
      if (this.policy.ownerTrust === 'full') {
        return { decision: 'allow', reason: 'external directory allowed by owner full developer trust', risk: risk || 'high' };
      }
      // default 档保留旧收紧逻辑，供测试/临时降权使用。
      if (/(^|\/)(\.aws|\.gnupg)(\/|$)/.test(path)) return { decision: 'deny', reason: 'credential directory denied', risk: 'critical' };
      if (/(^|\/)(\.ssh|\.docker|\.kube)(\/|$)/.test(path)) {
        return this.policy.ownerTrust === 'full'
          ? { decision: 'ask', reason: 'sensitive directory access requires approval (owner-trusted)', risk: 'high' }
          : { decision: 'deny', reason: 'sensitive directory denied', risk: 'critical' };
      }
      if (/(^|\/)\.env(\.|$|\/)?/.test(path)) return { decision: 'ask', reason: 'sensitive file access requires approval', risk: 'high' };
      if (cwd && !pathInside(cwd, path)) return { decision: 'ask', reason: 'external directory requires approval', risk: 'high' };
      return { decision: 'allow', reason: 'directory is within cwd', risk: risk || 'low' };
    }

    if (action === 'skill.plugin.execute' || action === 'skill.plugin.configure') {
      if (this.policy.ownerTrust === 'full') {
        return { decision: 'allow', reason: `${action} allowed by owner full developer trust`, risk: risk || 'high' };
      }
      // 受信任的本地 MCP server（owner 已配置、127.0.0.1、自带沙箱）：放行其连接/列表/调用，
      // 免去每次调工具都审批（否则大脑无法自主用工具——Noe 的设计目标是不打扰人类、自由发挥）。
      // 默认含：unified-kb（统一知识库）+ 三个官方 server（filesystem 限 allowed-dirs / memory / playwright）。
      // 仍受双重保护：① 白名单只放行 execute（调用/列表），改 spawn 规格（configure）永远审批 →
      // 信任「调用」≠ 信任「改启动命令」（改 command 即 RCE）；② 危险写操作有目标 server 第二道防线
      // （知识库 fs_organize_execute 需 confirm=true + 删进废纸篓 + 可 undo + 路径白名单）。
      // 想再收紧/放开用 NOE_TRUSTED_MCP 覆盖（逗号分隔，覆盖默认全集）。
      const TRUSTED_LOCAL_MCP = new Set((process.env.NOE_TRUSTED_MCP || 'unified-kb,filesystem,memory,playwright').split(',').map((s) => s.trim()).filter(Boolean));
      // 白名单只放行「调用/列表/连接」(execute)；「改配置/启动命令」(configure) 仍须审批——
      // 信任调用 unified-kb ≠ 信任改它的 spawn 启动规格（改 command 即任意命令执行 RCE）。
      if (action === 'skill.plugin.execute' && target && target.section === 'mcp' && TRUSTED_LOCAL_MCP.has(safeString(target.serverName, 120))) {
        return { decision: 'allow', reason: `trusted local mcp: ${target.serverName} (${safeString(target.operation, 40)})`, risk: 'low' };
      }
      return { decision: 'ask', reason: `${action} requires owner approval`, risk: risk || 'high' };
    }

    if (action === 'provider.model_config.write' || action === 'provider.model_config.access') {
      if (this.policy.ownerTrust === 'full') {
        return { decision: 'allow', reason: 'provider/model configuration allowed by owner full developer trust', risk: risk || 'high' };
      }
      return { decision: 'ask', reason: 'provider/model configuration requires approval', risk: risk || 'high' };
    }

    if (action === 'network.upload') {
      const url = safeString(target.url, 2000);
      const host = hostnameFromUrl(url);
      if (!/^https?:\/\//i.test(url)) return { decision: 'deny', reason: 'network upload URL must be http(s)', risk: 'high' };
      if (this.policy.ownerTrust === 'full') {
        return { decision: 'allow', reason: 'network upload allowed by owner full developer trust', risk: risk || 'high', details: { host } };
      }
      if (isPrivateHostSync(host)) return { decision: 'deny', reason: 'network upload to private/loopback host denied', risk: 'critical' };
      return { decision: 'ask', reason: 'network upload requires approval', risk: risk || 'high' };
    }

    if (action === 'auto_accept.scope') {
      if (this.policy.ownerTrust === 'full') {
        return { decision: 'allow', reason: 'auto-accept scope allowed by owner full developer trust', risk: risk || 'high' };
      }
      return risk === 'low'
        ? { decision: 'allow', reason: 'low-risk auto-accept scope allowed', risk }
        : { decision: 'ask', reason: 'auto-accept scope requires approval', risk: risk || 'high' };
    }

    if (this.policy.ownerTrust === 'full') {
      return { decision: 'allow', reason: `${action || 'action'} allowed by owner full developer trust`, risk: risk || 'low' };
    }

    return risk === 'high' || risk === 'critical'
      ? { decision: 'ask', reason: `${action || 'action'} requires approval by risk`, risk }
      : { decision: 'allow', reason: `${action || 'action'} allowed`, risk: risk || 'low' };
  }

  buildApprovalPayload({ action, target, actorType, actorId, agentRunId, roomId, sessionId, cwd, decision, details }) {
    return {
      title: `Permission approval: ${action}`,
      action,
      target,
      actorType,
      actorId: actorId || null,
      agentRunId: agentRunId || null,
      roomId: roomId || null,
      sessionId: sessionId || null,
      cwd: cwd || null,
      risk: decision.risk || 'high',
      reason: decision.reason,
      details: {
        request: safeJson(details),
        classification: safeJson(decision.details),
      },
    };
  }

  permissionDedupeKey({ action, target, actorType, actorId, agentRunId, roomId, sessionId, cwd }) {
    // 审计 §3.2 M②：除 stableJson(target) 外显式把命令文本纳入指纹——防 stableJson 对不同 target
    // 偶发产生相同序列化时跨命令复用批准（命令是最敏感维度，多一层独立区分更稳）。
    const commandPreview = safeString(target?.command, 1000);
    return hashParts(['permission', action, actorType, actorId, agentRunId, roomId, sessionId, cwd, commandPreview, stableJson(target)]);
  }

  // A2 同指纹复用：完全相同操作（指纹含 actor/action/target/cwd 全量）刚被 owner 批准过 → TTL 内放行。
  // 只认 status=approved 且 decidedAt 在窗口内；getLatestByDedupeKey 取最新一条，若最新是 denied/pending
  // 则返回 null 走原 ask 流程（拒绝后的同操作必须重新人审）。复用决策带 reusedApprovalId 进审计。
  resolveRecentApprovedDedupe({ action, target, actorType, actorId, agentRunId, roomId, sessionId, cwd, decision }) {
    if (!this.approvalReuseTtlMs) return null;
    if (typeof this.approvalStore?.getLatestByDedupeKey !== 'function') return null;
    const dedupeKey = this.permissionDedupeKey({ action, target, actorType, actorId, agentRunId, roomId, sessionId, cwd });
    let latest = null;
    try { latest = this.approvalStore.getLatestByDedupeKey(dedupeKey); } catch { return null; }
    if (!latest || latest.status !== 'approved') return null;
    const decidedAt = Number(latest.decidedAt);
    if (!Number.isFinite(decidedAt) || decidedAt <= 0) return null;
    const age = this.now() - decidedAt;
    if (age < 0 || age > this.approvalReuseTtlMs) return null;
    return {
      decision: 'allow',
      reason: 'approved permission reused (same fingerprint within TTL)',
      risk: decision.risk || 'high',
      approval: latest,
      approvalPayload: latest.payload || null,
      details: {
        ...(decision.details || {}),
        reusedApprovalId: latest.id,
        reusedDecidedAt: decidedAt,
        reuseTtlMs: this.approvalReuseTtlMs,
        resumed: true,
      },
    };
  }

  createApproval({ action, target, actorType, actorId, agentRunId, roomId, sessionId, cwd, approvalPayload }) {
    const dedupeKey = this.permissionDedupeKey({ action, target, actorType, actorId, agentRunId, roomId, sessionId, cwd });
    return this.approvalStore?.createApproval?.({
      type: 'manual',
      requesterType: actorType || 'system',
      requesterId: actorId || agentRunId || roomId || sessionId || action,
      dedupeKey,
      payload: approvalPayload,
    }) || null;
  }

  recordDecision(decision, invocation) {
    const severity = decision.decision === 'deny' ? 'error' : decision.decision === 'ask' ? 'warn' : 'info';
    this.audit?.recordSafe?.({
      action: 'permission.decision',
      actorType: decision.actorType,
      actorId: decision.actorId,
      roomId: decision.roomId,
      sessionId: decision.sessionId,
      entityType: 'permission_decision',
      entityId: decision.id,
      status: decision.decision,
      severity,
      details: {
        decision,
        invocation,
        approvalId: decision.approval?.id || null,
        agentRunId: decision.agentRunId || null,
      },
    });
    if (decision.agentRunId && this.agentRuns?.appendMessage) {
      try {
        this.agentRuns.appendMessage(decision.agentRunId, {
          kind: 'decision',
          role: 'system',
          status: decision.decision,
          summary: `permission ${decision.decision}: ${decision.action}`,
          payload: {
            permissionDecisionId: decision.id,
            reason: decision.reason,
            approvalId: decision.approval?.id || null,
            invocation,
          },
        });
      } catch {}
    }
  }
}

export const permissionGovernance = new PermissionGovernance();

export function evaluatePermission(input = {}, deps = {}) {
  return new PermissionGovernance(deps).evaluatePermission(input);
}

export function permissionHttpStatus(decision) {
  return decision?.decision === 'deny' ? 403 : 202;
}

export function permissionHttpError(decision) {
  return decision?.decision === 'deny' ? 'permission_denied' : 'approval_required';
}

export function permissionHttpBody(decision) {
  return {
    ok: false,
    error: permissionHttpError(decision),
    approval: decision?.approval || null,
    approvalId: decision?.approval?.id || null,
    permissionDecision: decision || null,
  };
}

export function permissionApprovalIdFromRequest(req) {
  const header = req?.get?.('X-Panel-Approval-Id') || req?.headers?.['x-panel-approval-id'];
  return safeString(
    req?.body?.approvalId ||
      req?.body?.permissionApprovalId ||
      req?.query?.approvalId ||
      req?.query?.permissionApprovalId ||
      header,
    160
  );
}

// 多 approvalId 版本：header X-Panel-Approval-Id 可逗号分隔，body/query 支持 approvalIds（数组/逗号）。
// 用于 watcher 这类同一请求内多个独立权限检查的入口；其它单审批入口继续用 permissionApprovalIdFromRequest。
export function permissionApprovalIdsFromRequest(req) {
  const header = req?.get?.('X-Panel-Approval-Id') || req?.headers?.['x-panel-approval-id'] || '';
  const ids = [];
  const push = (v) => {
    if (!v) return;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    for (const s of arr) {
      const t = safeString(s, 160);
      if (t && !ids.includes(t)) ids.push(t);
    }
  };
  push(req?.body?.approvalIds);
  push(req?.body?.approvalId);
  push(req?.body?.permissionApprovalId);
  push(req?.query?.approvalIds);
  push(req?.query?.approvalId);
  push(req?.query?.permissionApprovalId);
  push(header);
  return ids;
}
