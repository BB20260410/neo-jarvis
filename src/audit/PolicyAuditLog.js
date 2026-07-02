// PolicyAuditLog — 独立的 append-only 文件审计日志，专记自主执行/策略决策/外网尝试。
//
// 为什么独立于 ActivityLog（SQLite）：m3 评审强调——放开自主能力后，唯一能事后追责/取证的就是审计日志，
//   它必须 append-only、独立、难篡改。SQLite 事件库会被 Noe 自己读写（甚至 compact），不适合当取证源。
//   本模块把每一次「策略放行/拒绝/询问 + 真实执行」追加一行 JSON 到 ~/.noe/audit.log，只增不改。
//
// 纯逻辑、注入式：writer/now/path 全部可注入，单测注入内存 writer，不碰真实文件系统。
// 安全：密钥类内容写前脱敏（保留行为可读性，只抹明显的 key/token）。

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

const MAX_FIELD = 2000;

/** 脱敏明显的密钥/令牌，保留路径、命令等行为信息（取证需要看得懂干了啥）。 */
export function redactSecret(value) {
  return String(value ?? '')
    .replace(/sk-[A-Za-z0-9_-]{12,}/g, '[key]')
    .replace(/tp-[a-z0-9]{12,}/gi, '[key]')
    .replace(/(Bearer\s+)\S+/gi, '$1[key]')
    .replace(/((?:api[_-]?key|token|secret|password|authorization)\s*[=:]\s*)\S+/gi, '$1[redacted]')
    .slice(0, MAX_FIELD);
}

function redactTarget(target) {
  if (target === undefined || target === null) return null;
  let text;
  try {
    text = typeof target === 'string' ? target : JSON.stringify(target);
  } catch {
    text = String(target);
  }
  return redactSecret(text);
}

/**
 * 创建一个 append-only 策略审计日志。
 *
 * @param {object} [deps]
 * @param {string} [deps.path] 日志文件路径（默认 ~/.noe/audit.log）。
 * @param {(line:string)=>void} [deps.writer] 写一行的实现（默认 append 到文件）。测试请注入。
 * @param {()=>number} [deps.now] 时间源（默认 Date.now）。
 * @returns {{ append: (entry:object)=>object, recordSafe: (entry:object)=>object|null, path: string }}
 */
export function createPolicyAuditLog(deps = {}) {
  const path = typeof deps.path === 'string' && deps.path ? deps.path : join(homedir(), '.noe', 'audit.log');
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const writer = typeof deps.writer === 'function'
    ? deps.writer
    : (line) => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, line, 'utf8'); // append-only：只追加，绝不重写
    };

  function append(entry = {}) {
    const rec = {
      ts: now(),
      event: redactSecret(entry.event || entry.action || 'policy.decision').slice(0, 160),
      action: redactSecret(entry.action || '').slice(0, 160),
      decision: String(entry.decision || '').slice(0, 40) || null,
      capability: String(entry.capability || '').slice(0, 80) || null,
      source: String(entry.source || '').slice(0, 80) || null,
      target: redactTarget(entry.target),
      reason: redactSecret(entry.reason || ''),
      actor: String(entry.actor || 'noe').slice(0, 120),
      trustLevel: entry.trustLevel ? String(entry.trustLevel).slice(0, 40) : null,
    };
    writer(`${JSON.stringify(rec)}\n`);
    return rec;
  }

  /** 不抛版本：审计失败绝不阻断主流程（但会丢日志，调用方需知情）。 */
  function recordSafe(entry = {}) {
    try {
      return append(entry);
    } catch {
      return null;
    }
  }

  return { append, recordSafe, path };
}
