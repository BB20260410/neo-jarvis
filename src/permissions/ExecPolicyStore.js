// ExecPolicyStore — capability 信任档：把「自由权限」从单一开关变成可声明、可审计、可版本化的策略。
//
// 设计依据：把「信任」拆成 capability 集合，让 owner 的开发者授权可以精确落到执行层。
//   2026-06-11 owner 明确要求无边界开发者环境：developer/unrestricted 档不再保留
//   「读密钥内容 / 改安全栈 / 外网数据出境」永久 deny。default 档仍 defer，保持未显式授信时向后兼容。
//
// 核心契约（向后兼容）：默认 trustLevel='default' 时 evaluate 返回 decision='defer'，
//   调用方（ActPipeline）据此走原有逻辑（blocked_safety）——保证不配置时行为完全不变、存量测试不破。
//   只有显式 developer / unrestricted 档、或 /yolo 会话、或 .noetrust 项目，才真正解锁。
//
// 关键判断：本项目是 owner 自己的本地 Jarvis/Noe 开发环境。developer/unrestricted 档应允许
//   本地凭据、系统策略、网络和外部服务能力；真实性靠审计和验证，不靠永久硬拦截。
//
// 纯逻辑、注入式：fileReader / now / projectTrustChecker 全可注入，单测零文件系统依赖。

import {
  compactNoePolicyFileGuardReport,
  evaluateNoePolicyFileWrite,
  evaluateNoePolicyShellMutation,
} from '../security/NoePolicyFileGuard.js';

// action → capability 归类。
export const ACTION_CAPABILITY = {
  'shell.exec': 'proc.exec',
  'tool.execute': 'proc.exec',
  'file.write_text': 'fs.write',
  'noe.note.write': 'fs.write',
  'file.delete': 'fs.delete',
  'file.move.bulk': 'fs.write',
  'file.batch_move': 'fs.write',
  'browser.open': 'browser.open',
  'browser.open_url': 'browser.open',
  'noe.browser.open_url': 'browser.open',
  'browser.observe': 'browser.state.probe',
  'browser.state_probe': 'browser.state.probe',
  'noe.browser.state_probe': 'browser.state.probe',
  'browser.observe_page': 'browser.dom',
  'noe.browser.observe_page': 'browser.dom',
  'browser.dom.execute': 'browser.dom',
  'browser.click': 'browser.dom',
  'browser.type': 'browser.dom',
  'browser.set_value': 'browser.dom',
  'macos.app.activate': 'desktop.automation',
  'macos.open_app': 'desktop.automation',
  'desktop.app.activate': 'desktop.automation',
  'macos.applescript.run': 'desktop.automation',
  'macos.script.run': 'desktop.automation',
  'desktop.applescript.run': 'desktop.automation',
  'desktop.script.run': 'desktop.automation',
  'macos.jxa.run': 'desktop.automation',
  'desktop.jxa.run': 'desktop.automation',
  'macos.text.type': 'desktop.keyboard',
  'macos.type_text': 'desktop.keyboard',
  'desktop.text.type': 'desktop.keyboard',
  'macos.key.press': 'desktop.keyboard',
  'macos.press_key': 'desktop.keyboard',
  'desktop.key.press': 'desktop.keyboard',
  'macos.pointer.click': 'desktop.pointer',
  'macos.click': 'desktop.pointer',
  'desktop.pointer.click': 'desktop.pointer',
  'desktop.click': 'desktop.pointer',
  'visual.action.plan': 'browser.visual.plan',
  'noe.visual.plan': 'browser.visual.plan',
  'network.upload': 'net.upload',
  'network.external_post': 'net.outbound',
};

// 兼容导出：早期版本这里有永久 deny。owner 已撤销这些项目级硬边界，developer/unrestricted 由档位放行。
export const HARD_DENY_CAPS = new Set([]);

// 兼容导出：早期版本这里有永久 ask。当前无边界开发者环境不再设置永久 ask。
export const HARD_ASK_CAPS = new Set([]);

// 各 trust 档位的 capability 默认决策。空档(default)=全 defer，交还原逻辑。
export const TRUST_PRESETS = {
  default: {},
  developer: {
    'proc.exec': 'allow',           // 信任项目内执行
    'fs.write': 'allow',
    'fs.delete': 'allow',
    'browser.open': 'allow',
    'browser.state.probe': 'allow',
    'browser.dom': 'allow',
    'desktop.automation': 'allow',
    'desktop.keyboard': 'allow',
    'desktop.pointer': 'allow',
    'browser.visual.plan': 'allow',
    'net.outbound': 'allow',
    'net.upload': 'allow',
    'secrets.read.metadata': 'allow',
    'secrets.read.content': 'allow',
    'self.modify_policy': 'allow',
    'marketplace.install': 'allow',
    'pkg.install': 'allow',
  },
  unrestricted: {                   // /yolo：开发动作全开
    'proc.exec': 'allow',
    'fs.write': 'allow',
    'fs.delete': 'allow',
    'browser.open': 'allow',
    'browser.state.probe': 'allow',
    'browser.dom': 'allow',
    'desktop.automation': 'allow',
    'desktop.keyboard': 'allow',
    'desktop.pointer': 'allow',
    'browser.visual.plan': 'allow',
    'net.outbound': 'allow',
    'net.upload': 'allow',
    'secrets.read.metadata': 'allow',
    'secrets.read.content': 'allow',
    'self.modify_policy': 'allow',
    'marketplace.install': 'allow',
    'pkg.install': 'allow',
  },
};

const TRUST_ORDER = { default: 0, developer: 1, unrestricted: 2 };

// 改 Noe 自身安全栈的路径（命中即 self.modify_policy capability）。
const POLICY_FILE_RE = /(PermissionGovernance|DangerousPatternDetector|ExecPolicyStore|NoeSelfEvolutionActGuard|exec-policy\.json|\/policy[^/]*\.(?:js|json|ya?ml)|server\.js)/i;
// 读密钥「内容」的敏感路径（cat/read 命中即 secrets.read.content capability）。
const SECRET_CONTENT_RE = /(\.ssh\/id_[^/\s]+|\.ssh\/[^/\s]*\.pem|\.aws\/credentials|\.gnupg\/private|\.netrc|\.npmrc|\.docker\/config\.json|id_rsa|id_ed25519)\b/i;

function targetText(target) {
  if (target === undefined || target === null) return '';
  if (typeof target === 'string') return target;
  try { return JSON.stringify(target); } catch { return String(target); }
}

function looksLikeContentRead(action, text) {
  // 读「内容」的动作：cat/read/cp/grep 等命中敏感路径；纯 inventory/元数据不算。
  return /\b(cat|read|cp|grep|less|head|tail|open|file\.read)\b/i.test(`${action} ${text}`)
    && SECRET_CONTENT_RE.test(text);
}

function looksLikeOutbound(text) {
  return /\bhttps?:\/\/(?!(?:127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\]))/i.test(text)
    || /\b(curl|wget|nc|ncat)\b/i.test(text);
}

function targetPaths(target) {
  if (!target || typeof target !== 'object' || Array.isArray(target)) return [];
  const keys = ['path', 'filePath', 'targetPath', 'relativePath', 'destination', 'dest', 'to', 'outputPath'];
  const out = [];
  for (const key of keys) {
    if (target[key] !== undefined && target[key] !== null) out.push(String(target[key]));
  }
  for (const key of ['paths', 'files', 'targets', 'items']) {
    if (!Array.isArray(target[key])) continue;
    for (const item of target[key]) {
      if (typeof item === 'string') out.push(item);
      else if (item && typeof item === 'object') out.push(...targetPaths(item));
    }
  }
  return [...new Set(out.filter(Boolean))];
}

function evaluatePolicyFileGuard({ action, cap, target, cwd }) {
  if (cap === 'proc.exec' || /(?:^|\.)exec|shell|tool\.execute/i.test(action)) {
    const command = typeof target === 'string' ? target : target?.command || target?.cmd || '';
    const args = target && typeof target === 'object' && Array.isArray(target.args) ? target.args : [];
    return evaluateNoePolicyShellMutation({ command, args, cwd, root: process.cwd(), env: process.env });
  }
  if (
    cap === 'fs.write'
    || cap === 'fs.delete'
    || ['file.write', 'file.write_text', 'file.delete', 'file.move.bulk', 'file.batch_move', 'noe.note.write'].includes(action)
  ) {
    for (const filePath of targetPaths(target)) {
      const report = evaluateNoePolicyFileWrite({ path: filePath, operation: action || cap, cwd, root: process.cwd(), env: process.env });
      if (report.blocked) return report;
    }
  }
  return { blocked: false, reason: 'not_noe_policy_file_mutation', secretValuesReturned: false };
}

/**
 * 创建 capability 信任档存储。
 *
 * @param {object} [deps]
 * @param {string} [deps.trustLevel] 基础档位（'default'|'developer'|'unrestricted'，默认 default）。
 * @param {object} [deps.caps] 在档位之上的 capability 覆盖。
 * @param {() => number} [deps.now] 时间源。
 * @param {(cwd:string)=>boolean} [deps.projectTrustChecker] 判断 cwd 是否有 .noetrust（信任项目提升到 developer）。
 * @returns {object}
 */
export function createExecPolicyStore(deps = {}) {
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  let baseTrust = TRUST_ORDER[deps.trustLevel] !== undefined ? deps.trustLevel : 'default';
  const capOverrides = (deps.caps && typeof deps.caps === 'object') ? { ...deps.caps } : {};
  const projectTrustChecker = typeof deps.projectTrustChecker === 'function' ? deps.projectTrustChecker : null;

  /** @type {Map<string, number>} sessionId -> yolo 过期时间戳 */
  const yoloSessions = new Map();

  function capabilityFor(action, explicit) {
    if (explicit) return String(explicit);
    return ACTION_CAPABILITY[action] || (/(^|\.)exec|shell|tool\.execute/i.test(action) ? 'proc.exec' : `action:${action}`);
  }

  function yoloActive(sessionId) {
    if (!sessionId) return false;
    const exp = yoloSessions.get(sessionId);
    if (!exp) return false;
    if (exp <= now()) { yoloSessions.delete(sessionId); return false; } // 有界过期
    return true;
  }

  /** 解析「当前生效档位」：base ⊔ .noetrust(developer) ⊔ yolo(unrestricted) 取最高。 */
  function effectiveTrust({ cwd = '', sessionId = '' } = {}) {
    let level = baseTrust;
    if (projectTrustChecker && cwd && projectTrustChecker(cwd)) {
      if (TRUST_ORDER.developer > TRUST_ORDER[level]) level = 'developer';
    }
    if (yoloActive(sessionId)) {
      if (TRUST_ORDER.unrestricted > TRUST_ORDER[level]) level = 'unrestricted';
    }
    return level;
  }

  /**
   * 评估一次动作的策略决策。
   * @returns {{decision:'allow'|'ask'|'deny'|'defer', capability:string, source:string, reason:string, trustLevel:string}}
   */
  function evaluate({ action = '', capability = '', target = null, cwd = '', sessionId = '' } = {}) {
    const cap = capabilityFor(action, capability);
    const text = targetText(target);
    const trustLevel = effectiveTrust({ cwd, sessionId });
    const wrap = (decision, source, reason, details = undefined) => {
      const out = { decision, capability: cap, source, reason, trustLevel };
      if (details && typeof details === 'object') out.details = details;
      return out;
    };

    const policyGuard = evaluatePolicyFileGuard({ action, cap, target, cwd: cwd || process.cwd() });
    if (policyGuard.blocked) {
      return wrap('deny', 'policy-file-guard', 'noe_policy_file_mutation_denied', {
        noePolicyFileGuard: compactNoePolicyFileGuardReport(policyGuard),
      });
    }

    // 1) 高影响 target 归类为 capability，而不是永久拒绝。default 档无预设时仍 defer。
    if (POLICY_FILE_RE.test(text)) {
      const selfDecision = resolveCap('self.modify_policy', trustLevel);
      if (selfDecision) return wrap(selfDecision, 'policy', `self.modify_policy = ${selfDecision} at trust=${trustLevel}`);
    }
    if (looksLikeContentRead(action, text)) {
      const secretDecision = resolveCap('secrets.read.content', trustLevel);
      if (secretDecision) return wrap(secretDecision, 'policy', `secrets.read.content = ${secretDecision} at trust=${trustLevel}`);
    }

    // 2) 兼容保留的全局 deny / ask 清单；当前为空。
    if (HARD_DENY_CAPS.has(cap)) return wrap('deny', 'hard-deny', `${cap} is on the permanent deny list`);
    if (HARD_ASK_CAPS.has(cap)) return wrap('ask', 'hard-ask', `${cap} always requires confirmation`);

    // 3) 外网出境：归到 net.outbound。developer/unrestricted 默认 allow。
    if (cap === 'net.outbound' || looksLikeOutbound(text)) {
      const netDecision = resolveCap('net.outbound', trustLevel);
      if (netDecision) return wrap(netDecision, 'policy', `net.outbound = ${netDecision} at trust=${trustLevel}`);
      return wrap('defer', 'default-defer', `no policy for net.outbound at trust=${trustLevel}; defer to caller`);
    }

    // 4) 档位 capability 决策（覆盖 > 档位预设；无则 defer 交还原逻辑）。
    const decision = resolveCap(cap, trustLevel);
    if (!decision) return wrap('defer', 'default-defer', `no policy for ${cap} at trust=${trustLevel}; defer to caller`);
    const src = (capOverrides[cap] && capOverrides[cap] === decision) ? 'policy-override'
      : (yoloActive(sessionId) ? 'yolo' : (trustLevel !== baseTrust ? 'noetrust' : 'policy'));
    return wrap(decision, src, `capability ${cap} = ${decision} at trust=${trustLevel}`);
  }

  function resolveCap(cap, trustLevel) {
    if (HARD_DENY_CAPS.has(cap)) return 'deny';
    if (Object.prototype.hasOwnProperty.call(capOverrides, cap)) {
      const v = capOverrides[cap];
      if (['allow', 'ask', 'deny'].includes(v)) return v;
    }
    const preset = TRUST_PRESETS[trustLevel] || {};
    return preset[cap] || null;
  }

  return {
    evaluate,
    effectiveTrust,
    /** ⚠️ 高危：开启会话级 /yolo（有界自动过期，绕过逐次审批）。审计 §3.2 M④：无路由暴露，仅供受信装配/显式 owner 授权调用，绝不接到用户/模型可达入口。 */
    startYolo({ sessionId, ttlMs = 30 * 60 * 1000 } = {}) {
      const id = String(sessionId || '').trim();
      if (!id) return { ok: false, reason: 'sessionId required' };
      const expiresAt = now() + Math.max(1000, Math.min(Number(ttlMs) || 0, 8 * 60 * 60 * 1000));
      yoloSessions.set(id, expiresAt);
      return { ok: true, sessionId: id, expiresAt };
    },
    endYolo(sessionId) { return yoloSessions.delete(String(sessionId || '')); },
    isYoloActive(sessionId) { return yoloActive(sessionId); },
    /** ⚠️ 高危：直接改基础信任档（绕过审批/共识）。审计 §3.2 M④：无路由暴露，仅供受信装配代码调用，绝不接到用户/模型可达入口。 */
    setTrustLevel(level) { if (TRUST_ORDER[level] !== undefined) baseTrust = level; return baseTrust; },
    getTrustLevel() { return baseTrust; },
  };
}
