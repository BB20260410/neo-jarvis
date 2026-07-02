// @ts-check
// ③ 能力自举执行器（手脚）——真下载安装第三方能力（npm 包）。安全极敏感（自动装软件=供应链风险），
// 多重门：standing grant(scope capability:acquire) + 源白名单（合法 npm 包名）+ 隔离目录安装
// （--prefix output/noe-capabilities/<name>，不污染主 node_modules/package.json）+ 装后 require 验证
// + 失败/验证不过自动回滚（删隔离目录）。env 门控（唯一注册入口在 SafeActExecutors，默认 OFF=零回归）。
// 全注入式（evaluateGrant/spawnFn/appendEvent 注入），不设硬超时（跑安装纪律：装多久不可预测）。

import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeNoeHostExecEnv } from '../security/NoeHostExecEnv.js';

export const CAPABILITY_GRANT_SCOPE = 'capability:acquire';
export const NOE_CAPABILITY_DIR = 'output/noe-capabilities';
const NPM_PKG_RE = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i;

function assertStandingGrant(evaluateGrant) {
  const grant = typeof evaluateGrant === 'function' ? evaluateGrant({ scope: CAPABILITY_GRANT_SCOPE }) : { authorized: false };
  if (!grant || grant.authorized !== true) throw new Error('capability_acquire_requires_standing_grant');
}

function safeEnv() {
  return sanitizeNoeHostExecEnv(process.env, {
    allowlist: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL', 'NODE_ENV'],
  });
}

function defaultSpawn(cmd, args, opts = {}) {
  return new Promise((res, rej) => {
    const child = spawn(cmd, args, { cwd: opts.cwd || process.cwd(), env: opts.env || process.env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout?.on('data', (c) => { out = (out + c.toString('utf8')).slice(-100_000); });
    child.stderr?.on('data', (c) => { err = (err + c.toString('utf8')).slice(-100_000); });
    child.on('error', rej);
    // 不设硬超时（跑安装纪律）
    child.on('close', (code) => res({ exitCode: Number(code) || 0, stdout: out, stderr: err }));
  });
}

function safeDirName(name) {
  return String(name).replace(/[^\w.@/-]/g, '_').replace(/\//g, '__');
}

/**
 * 注册 noe.capability.install executor。
 * @param {Map<string, Function>} executors
 * @param {{root?:string, evaluateGrant?:Function, spawnFn?:Function, appendEvent?:Function}} deps
 */
export function registerNoeCapabilityExecutors(executors, deps = {}) {
  if (!(executors instanceof Map)) throw new Error('registerNoeCapabilityExecutors requires a Map');
  const { root = process.cwd(), evaluateGrant, spawnFn = defaultSpawn, appendEvent } = deps;

  executors.set('noe.capability.install', async ({ act }) => {
    assertStandingGrant(evaluateGrant); // 主门：owner standing grant（scope capability:acquire）
    const cap = (act && act.payload && act.payload.capability) || {};
    const type = String(cap.type || '').trim();
    const name = String(cap.installSpec || cap.name || '').trim();
    // 源/类型白名单：MVP 只自动装 npm 包（github MCP 走 owner 审批的 mcp-servers.json，不在此自动装）
    if (type !== 'npm') throw new Error(`capability_type_not_supported_for_auto_install:${type || 'blank'}`);
    if (!NPM_PKG_RE.test(name)) throw new Error('capability_invalid_npm_name');

    const rootAbs = resolve(root);
    const targetDir = resolve(rootAbs, NOE_CAPABILITY_DIR, safeDirName(name));
    mkdirSync(targetDir, { recursive: true, mode: 0o700 });

    // 隔离安装：--prefix 指向隔离目录，绝不碰主 node_modules / package.json
    const install = await spawnFn('npm', ['install', '--prefix', targetDir, '--no-audit', '--no-fund', '--no-save', name], { cwd: rootAbs, env: safeEnv() });
    if (install.exitCode !== 0) {
      try { rmSync(targetDir, { recursive: true, force: true }); } catch { /* 回滚 best-effort */ }
      throw new Error(`capability_install_failed:${name}`);
    }

    // 装后验证：require 隔离目录里的包不崩才算可用
    const requireExpr = `require(require('node:path').resolve(${JSON.stringify(targetDir)}, 'node_modules', ${JSON.stringify(name)}))`;
    const verify = await spawnFn('node', ['-e', requireExpr], { cwd: rootAbs, env: safeEnv() });
    if (verify.exitCode !== 0) {
      try { rmSync(targetDir, { recursive: true, force: true }); } catch { /* 验证失败回滚 */ }
      throw new Error(`capability_verify_failed:${name}`);
    }

    let eventId = null;
    if (typeof appendEvent === 'function') {
      eventId = appendEvent({
        kind: 'noe_capability_installed',
        ts: Date.now(),
        tag: 'noe.capability.installed',
        name,
        installDir: `${NOE_CAPABILITY_DIR}/${safeDirName(name)}`,
        secretValuesReturned: false,
      });
    }
    return {
      installed: true,
      name,
      installDir: `${NOE_CAPABILITY_DIR}/${safeDirName(name)}`,
      verified: true,
      eventId,
      secretValuesReturned: false,
    };
  });

  return executors;
}

// ③ 运用层：列举已装能力（隔离目录里有 node_modules 的）。
export function listInstalledCapabilities(root = process.cwd()) {
  const dir = resolve(root, NOE_CAPABILITY_DIR);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(resolve(dir, e.name, 'node_modules')))
      .map((e) => e.name);
  } catch { return []; }
}

// ③ 运用层：动态加载已装能力（只加载隔离目录里已装的包；未装 throw）。Neo 运用新获取能力的入口。
export async function loadInstalledCapability(root, name) {
  const pkgPath = resolve(root, NOE_CAPABILITY_DIR, safeDirName(name), 'node_modules', name);
  if (!existsSync(pkgPath)) throw new Error(`capability_not_installed:${name}`);
  return import(pathToFileURL(pkgPath).href);
}
