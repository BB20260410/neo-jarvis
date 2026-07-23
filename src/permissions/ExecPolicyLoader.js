// ExecPolicyLoader — 从磁盘加载 capability 信任档（I/O 层，与纯逻辑的 ExecPolicyStore 分离）。
//
// 读 ~/.noe-panel/exec-policy.json（可选）。默认档位 = developer（「无边界开发者」基调）：
//   项目内 exec/fs/网络/凭据/策略修改默认放行；default 档仍 defer，用于测试或临时收紧。
// 用户改 exec-policy.json 即可切 default(全锁)/unrestricted(全开)，或细调 caps —— 可声明、可版本化。
// .noetrust：cwd（或显式 cwd）下有 .noetrust 文件时把档位提升到 developer（项目级精确授信）。

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createExecPolicyStore } from './ExecPolicyStore.js';

const VALID_LEVELS = new Set(['default', 'developer', 'unrestricted']);

/**
 * @param {object} [opts]
 * @param {string} [opts.policyPath] 配置文件路径（默认 ~/.noe-panel/exec-policy.json）。
 * @param {string} [opts.defaultTrust] 无配置时的默认档（默认 'developer'）。
 * @param {() => number} [opts.now] 注入时间源。
 * @returns {{ store: object, trustLevel: string, source: string, policyPath: string }}
 */
export function loadExecPolicyStore(opts = {}) {
  const policyPath = opts.policyPath || join(homedir(), '.noe-panel', 'exec-policy.json');
  let config = {};
  let source = 'default';
  try {
    if (existsSync(policyPath)) {
      config = JSON.parse(readFileSync(policyPath, 'utf8')) || {};
      source = 'file';
    }
  } catch {
    config = {};
    source = 'parse-error-default';
  }
  // 优先级：NOE_TRUST_LEVEL 环境变量 > exec-policy.json > 默认档。供测试/CI/特殊场景强制档位。
  const envLevel = process.env.NOE_TRUST_LEVEL;
  let trustLevel;
  if (envLevel && VALID_LEVELS.has(envLevel)) { trustLevel = envLevel; source = 'env'; }
  else if (config.trustLevel && VALID_LEVELS.has(config.trustLevel)) trustLevel = config.trustLevel;
  else trustLevel = opts.defaultTrust && VALID_LEVELS.has(opts.defaultTrust) ? opts.defaultTrust : 'developer';
  const store = createExecPolicyStore({
    trustLevel,
    caps: (config.caps && typeof config.caps === 'object') ? config.caps : {},
    now: opts.now,
    projectTrustChecker: (cwd) => {
      try { return !!cwd && existsSync(join(String(cwd), '.noetrust')); } catch { return false; }
    },
  });
  return { store, trustLevel, source, policyPath };
}
