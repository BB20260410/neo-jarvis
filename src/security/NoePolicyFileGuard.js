// @ts-check
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

export const NOE_POLICY_FILE_GUARD_SCHEMA_VERSION = 1;

// A2 治本：区分「tracked 人维护测试(视为现有，A2 该挡改它)」vs「untracked 飞轮残留测试(视为可覆盖/新建，A2 放行)」。
//   根治 test_only 补测试 verify_failed→测试残留→self_repair 重写被 A2 挡(只放新建)→preflight_blocked 死循环（实测 focus-chain/roomStartCluster
//   反复占住 selfEvolve、自主定方向 goal 永走不到 complete）。飞轮写的测试在 complete+commit 前都是 untracked，重写自己的残留是正常 self_repair。纯 DI 可测。
export function defaultIsGitTracked(abs, root) {
  try { execFileSync('git', ['ls-files', '--error-unmatch', abs], { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] }); return true; }
  catch { return false; } // untracked / git 不可用 → 视为未跟踪（放行覆盖飞轮残留）
}
export function gitAwareTestFileExists(abs, root, { fileExists = existsSync, isTracked = defaultIsGitTracked } = {}) {
  if (!fileExists(abs)) return false; // 物理不存在 = 新建
  return isTracked(abs, root) === true; // 存在+tracked=人维护现有(true→A2 挡)；存在+untracked=飞轮残留(false→A2 放行覆盖)
}

const PROJECT_POLICY_FILES = new Set([
  'server.js',
  'package.json',
  'vitest.config.mjs',
  'src/permissions/PermissionGovernance.js',
  'src/permissions/ExecPolicyStore.js',
  'src/safety/DangerousPatternDetector.js',
  'src/loop/NoeSelfEvolutionActGuard.js',
  'src/loop/SafeActExecutors.js',
  'src/loop/ActPipeline.js',
  'src/loop/ActPipelineHelpers.js',
  // 自进化本环源码：禁止 Noe 自改自己的执行/触发/校验/补丁/守卫链路（改掉自己退路）。
  'src/loop/NoeSelfEvolutionExecutors.js',
  'src/room/NoeSelfEvolutionTrigger.js',
  'src/room/NoeSelfEvolutionLoop.js',
  'src/room/NoeSelfEvolutionGate.js',
  'src/room/NoeSelfEvolutionCycleStore.js',
  'src/runtime/mission/NoePatchApplyExecutor.js',
  'src/runtime/mission/NoePatchTransaction.js',
  'src/security/NoePolicyFileGuard.js',
  // P0.5 核心禁区显式化（元自改 = 自己定义自己 = reward hacking，永不自改）：禁 Noe 自改自己的急停/节律/人格/自调链路。
  'src/security/NoeEmergencyStop.js',     // 急停机制自护：防 Neo 自改关掉 owner 的 kill switch（最关键，否则元自改可绕过一切）
  'src/loop/NoeHeartbeat.js',             // 自主节律：防自改心跳调度（emergency stop 挂载点在此）
  'src/model/NoeLocalModelPolicy.js',     // persona/prompt/模型策略：防自改自己的人格与系统提示
  'src/cognition/NoeReflectiveTuner.js',  // P7 自调脑：禁自改（元自改防 reward hacking）
  'src/cognition/NoeReflectiveTunerAdopt.js',
  'src/cognition/NoeReflectiveTunerScore.js',
  'src/capabilities/NoeFreedomManifest.js',
  'src/capabilities/NoeFreedomAllowlist.js',
  'src/capabilities/NoeFreedomTrustManifest.js',
  'src/server/auth/owner-token.js',
  'scripts/lib/noe-standing-autonomy-grant.mjs',
  'scripts/noe-standing-autonomy-grant.mjs',
  'scripts/restart-panel.mjs',
  // P2 切片A：候选池/风险门/候选存储——禁 Neo 自改自己的"提名打分→采纳决策→风险分级"链路（reward hacking 防线）。
  'src/cognition/NoeCandidatePool.js',
  'src/security/NoeRiskTiering.js',
  'src/storage/NoeGoalCandidateStore.js',
  // P3 信任校准模块：禁 Neo 自改自己的预算/审查/失败分级/绿档自驱闸（reward hacking 防线）。
  'src/room/NoeSelfEvolutionBudget.js',
  'src/security/NoeGreenAutonomyDecision.js',
  'src/security/NoeReviewTier.js',
].map((item) => item.toLowerCase()));

// 受保护目录前缀（项目相对，小写，含尾 '/'）：整树禁改。
// 安全门：自改链路绝不能改掉自己的测试/工具脚本（= 改掉退路 + 制造假绿）。
const PROJECT_POLICY_DIR_PREFIXES = [
  'tests/',
  'scripts/',
].map((item) => item.toLowerCase());

const HOME_POLICY_SUFFIXES = new Set([
  '.noe/config.yaml',
  '.noe/config.yml',
  '.noe/config.json',
  '.noe/policy.yaml',
  '.noe/policy.yml',
  '.noe/policy.json',
  '.noe/approval.yaml',
  '.noe/approval.yml',
  '.noe/approval.json',
  '.noe/allowlist.yaml',
  '.noe/allowlist.yml',
  '.noe/allowlist.json',
  '.noe/quorum.yaml',
  '.noe/quorum.yml',
  '.noe/quorum.json',
  '.noe-panel/exec-policy.json',
  // 真实 standing autonomy grant 文件名（以 scripts/lib/noe-standing-autonomy-grant.mjs DEFAULT_GRANT_PATH 为准）。
  '.noe-panel/autonomy-grant.json',
  '.noe-panel/room-adapters.json',
].map((item) => item.toLowerCase()));

const MUTATING_SHELL_COMMANDS = new Set([
  'chmod', 'chown', 'chgrp', 'install', 'mv', 'rm', 'rmdir', 'tee', 'touch',
  'trash', 'truncate', 'unlink',
]);

function safeString(value, max = 4000) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max).trim();
}

function stripQuotes(value) {
  const text = safeString(value, 4000);
  if (text.length >= 2) {
    const first = text[0];
    const last = text[text.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return text.slice(1, -1);
    }
  }
  return text;
}

function normalizeSlashes(value) {
  return safeString(value, 4000).replace(/\\/g, '/');
}

function stableEnvPath(value, fallback) {
  const text = safeString(value, 4000);
  return text || fallback;
}

function envPaths(env = {}, cwd = process.cwd()) {
  const home = stableEnvPath(env.HOME, os.homedir());
  const noeHome = stableEnvPath(env.NOE_HOME, path.join(home, '.noe'));
  const noePanelHome = stableEnvPath(env.NOE_PANEL_HOME, path.join(home, '.noe-panel'));
  const hermesHome = stableEnvPath(env.HERMES_HOME, path.join(home, '.hermes'));
  return { home, cwd, noeHome, noePanelHome, hermesHome };
}

function expandKnownVariables(value, opts = {}) {
  let text = stripQuotes(value);
  const cwd = safeString(opts.cwd || process.cwd(), 4000) || process.cwd();
  const paths = envPaths(opts.env || process.env, cwd);
  if (text === '~') text = paths.home;
  else if (text.startsWith('~/')) text = path.join(paths.home, text.slice(2));
  const replacements = new Map([
    ['$HOME', paths.home],
    ['${HOME}', paths.home],
    ['$PWD', paths.cwd],
    ['${PWD}', paths.cwd],
    ['$NOE_HOME', paths.noeHome],
    ['${NOE_HOME}', paths.noeHome],
    ['$NOE_PANEL_HOME', paths.noePanelHome],
    ['${NOE_PANEL_HOME}', paths.noePanelHome],
    ['$HERMES_HOME', paths.hermesHome],
    ['${HERMES_HOME}', paths.hermesHome],
  ]);
  for (const [needle, replacement] of replacements) {
    text = text.split(needle).join(replacement);
  }
  return text;
}

function projectRelativePath(abs, root) {
  const rootAbs = path.resolve(root || process.cwd());
  const next = path.resolve(abs);
  const rel = path.relative(rootAbs, next);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return normalizeSlashes(rel).toLowerCase();
}

function homeRelativePath(abs, home) {
  const homeAbs = path.resolve(home);
  const next = path.resolve(abs);
  const rel = path.relative(homeAbs, next);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  return normalizeSlashes(rel).toLowerCase();
}

export function classifyNoePolicyFilePath(value, opts = {}) {
  const input = safeString(value, 4000);
  if (!input || input.includes('\0')) {
    return { protected: false, reason: input ? 'invalid-path' : 'empty-path' };
  }
  const cwd = safeString(opts.cwd || process.cwd(), 4000) || process.cwd();
  const root = safeString(opts.root || process.cwd(), 4000) || process.cwd();
  const expanded = expandKnownVariables(input, { ...opts, cwd });
  const abs = path.resolve(cwd, expanded);
  const rel = projectRelativePath(abs, root);
  if (rel && PROJECT_POLICY_FILES.has(rel)) {
    return {
      protected: true,
      scope: 'project',
      matchedId: rel,
      reason: 'project-policy-file',
      schemaVersion: NOE_POLICY_FILE_GUARD_SCHEMA_VERSION,
    };
  }
  if (rel) {
    const dirPrefix = PROJECT_POLICY_DIR_PREFIXES.find((prefix) => rel === prefix.slice(0, -1) || rel.startsWith(prefix));
    if (dirPrefix) {
      // A2 精细化：仅 tests/ 目录——允许飞轮「新增」测试文件（opts.allowNewTestFiles + 文件不存在），「改现有」仍禁。
      //   修 bug 写复现测试 / 加能力写配套测试的前提；只放新增、不放改现有（不让改掉退路、不让改测试骗绿）；新测试须经复核审真覆盖。
      //   scripts/ 等其他 policy dir 一律不放行。opts.allowNewTestFiles 默认不传 → 现状全禁，零回归。fail-safe：查不到文件当已存在（保守禁改）。
      if (dirPrefix === 'tests/' && opts.allowNewTestFiles === true) {
        const fileExists = typeof opts.fileExists === 'function' ? opts.fileExists : existsSync;
        let exists = true;
        try { exists = fileExists(abs) === true; } catch { exists = true; }
        if (!exists) {
          return { protected: false, reason: 'new-test-file-allowed', matchedDir: dirPrefix, schemaVersion: NOE_POLICY_FILE_GUARD_SCHEMA_VERSION };
        }
      }
      return {
        protected: true,
        scope: 'project',
        matchedId: rel,
        reason: 'project-policy-dir',
        matchedDir: dirPrefix,
        schemaVersion: NOE_POLICY_FILE_GUARD_SCHEMA_VERSION,
      };
    }
  }
  const { home } = envPaths(opts.env || process.env, cwd);
  const homeRel = homeRelativePath(abs, home);
  if (homeRel && HOME_POLICY_SUFFIXES.has(homeRel)) {
    return {
      protected: true,
      scope: 'home',
      matchedId: homeRel,
      reason: 'home-policy-file',
      schemaVersion: NOE_POLICY_FILE_GUARD_SCHEMA_VERSION,
    };
  }
  return { protected: false, reason: 'not-policy-file', schemaVersion: NOE_POLICY_FILE_GUARD_SCHEMA_VERSION };
}

export function isNoePolicyFilePath(value, opts = {}) {
  return classifyNoePolicyFilePath(value, opts).protected === true;
}

function denyReport({ operation, pathValue, opts }) {
  const hit = classifyNoePolicyFilePath(pathValue, opts);
  if (!hit.protected) return null;
  return {
    blocked: true,
    reason: 'noe_policy_file_mutation_denied',
    operation,
    matchedId: hit.matchedId,
    scope: hit.scope,
    policyFileReason: hit.reason,
    schemaVersion: NOE_POLICY_FILE_GUARD_SCHEMA_VERSION,
    secretValuesReturned: false,
  };
}

export function evaluateNoePolicyFileWrite({ path: filePath, operation = 'file.write', root, cwd, env } = {}) {
  const report = denyReport({ operation, pathValue: filePath, opts: { root, cwd, env } });
  if (report) return report;
  return {
    blocked: false,
    reason: 'not_noe_policy_file_mutation',
    operation,
    schemaVersion: NOE_POLICY_FILE_GUARD_SCHEMA_VERSION,
    secretValuesReturned: false,
  };
}

function splitCommandLine(commandLine) {
  const input = safeString(commandLine, 8000);
  const out = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = '';
      }
      continue;
    }
    if (ch === '>' || ch === '|' || ch === ';') {
      if (current && (/^(?:\d|&)$/.test(current))) {
        out.push(`${current}>`);
      } else {
        if (current) out.push(current);
        out.push(ch);
      }
      current = '';
      if (ch === '>' && input[i + 1] === '>') {
        out[out.length - 1] = '>>';
        i += 1;
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

function buildTokens(command, args) {
  const cmd = safeString(command, 8000);
  const cleanArgs = Array.isArray(args) ? args.map((arg) => safeString(arg, 4000)) : [];
  if (cleanArgs.length) return [cmd, ...cleanArgs].filter(Boolean);
  return splitCommandLine(cmd);
}

function basenameOfCommand(command) {
  return path.basename(stripQuotes(command)).toLowerCase();
}

function hasSedInPlace(args) {
  return args.some((arg) => arg === '-i' || arg.startsWith('-i.') || arg === '--in-place' || arg.startsWith('--in-place='));
}

function hasPerlInPlace(args) {
  return args.some((arg) => /^-[A-Za-z]*i[A-Za-z]*$/.test(arg) || arg === '-i' || arg.startsWith('-i.'));
}

function nonOptionArgs(args) {
  return args.filter((arg) => arg && !arg.startsWith('-'));
}

function firstBlockedPath(paths, opts, operation) {
  for (const candidate of paths) {
    const report = denyReport({ operation, pathValue: candidate, opts });
    if (report) return report;
  }
  return null;
}

function scanRedirects(commandLine, opts) {
  const input = safeString(commandLine, 8000);
  const redirectRe = /(?:^|[\s;&|])(?:\d?>|&>|>>?)\s*(?:"([^"]+)"|'([^']+)'|([^'"`\s;&|]+))/g;
  let match = redirectRe.exec(input);
  while (match) {
    const candidate = match[1] || match[2] || match[3] || '';
    const report = firstBlockedPath([candidate], opts, 'shell.redirect');
    if (report) return report;
    match = redirectRe.exec(input);
  }
  return null;
}

function scanSingleCommand(tokens, opts) {
  if (!tokens.length) return null;
  const cmd = basenameOfCommand(tokens[0]);
  const args = tokens.slice(1);
  if ((cmd === 'sh' || cmd === 'bash' || cmd === 'zsh') && args.includes('-c')) {
    const idx = args.indexOf('-c');
    const nested = args[idx + 1] || '';
    return scanCommandText(nested, opts);
  }
  if (cmd === 'sed' && hasSedInPlace(args)) {
    return firstBlockedPath(nonOptionArgs(args), opts, 'shell.sed_in_place');
  }
  if (cmd === 'perl' && hasPerlInPlace(args)) {
    return firstBlockedPath(nonOptionArgs(args), opts, 'shell.perl_in_place');
  }
  if (cmd === 'cp' || cmd === 'install') {
    return firstBlockedPath(args.length ? [args[args.length - 1]] : [], opts, `shell.${cmd}`);
  }
  if (cmd === 'mv') {
    return firstBlockedPath(args, opts, 'shell.mv');
  }
  if (MUTATING_SHELL_COMMANDS.has(cmd)) {
    return firstBlockedPath(nonOptionArgs(args), opts, `shell.${cmd}`);
  }
  return null;
}

function scanCommandText(commandLine, opts) {
  const redirectHit = scanRedirects(commandLine, opts);
  if (redirectHit) return redirectHit;
  // H4 修复：分段同时按单个管道符 `|` 切，否则 `cmd | tee <受保护文件>` 会整段绕过守卫
  // （tee/sed -i/rm 等变更命令在管道右侧不被 scanSingleCommand 检查）。`\|\|` 在 `\|` 之前保证 `||` 整体匹配。
  const segments = safeString(commandLine, 8000).split(/(?:&&|\|\||;|\|)/g);
  for (const segment of segments) {
    const hit = scanSingleCommand(splitCommandLine(segment), opts);
    if (hit) return hit;
  }
  return null;
}

export function evaluateNoePolicyShellMutation({ command = '', args = [], root, cwd, env } = {}) {
  const effectiveCwd = safeString(cwd || process.cwd(), 4000) || process.cwd();
  const opts = { root, cwd: effectiveCwd, env };
  const tokens = buildTokens(command, args);
  const text = Array.isArray(args) && args.length ? [command, ...args].map((arg) => String(arg)).join(' ') : safeString(command, 8000);
  const redirectHit = scanRedirects(text, opts);
  if (redirectHit) return redirectHit;
  const directHit = scanSingleCommand(tokens, opts);
  if (directHit) return directHit;
  if (!Array.isArray(args) || !args.length) {
    const shellHit = scanCommandText(text, opts);
    if (shellHit) return shellHit;
  }
  return {
    blocked: false,
    reason: 'not_noe_policy_shell_mutation',
    schemaVersion: NOE_POLICY_FILE_GUARD_SCHEMA_VERSION,
    secretValuesReturned: false,
  };
}

export function compactNoePolicyFileGuardReport(report = {}) {
  return {
    blocked: report.blocked === true,
    reason: report.reason || 'not_noe_policy_file_mutation',
    operation: report.operation || null,
    matchedId: report.matchedId || null,
    scope: report.scope || null,
    schemaVersion: report.schemaVersion || NOE_POLICY_FILE_GUARD_SCHEMA_VERSION,
    secretValuesReturned: false,
  };
}
