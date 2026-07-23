import { spawn } from 'node:child_process';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import { basename, dirname, resolve, sep } from 'node:path';
import { DangerousPatternDetector } from '../safety/DangerousPatternDetector.js';
import { createSafeDeleter } from '../workspace/NoeSafeDelete.js';
import { findNoeFreedomTool } from '../capabilities/NoeFreedomManifest.js';
import { runNoeFreedomAdapter } from '../runtime/NoeFreedomAdapters.js';
import { planVisualAction } from '../vision/VisualActionPlanner.js';
import {
  compactNoePolicyFileGuardReport,
  evaluateNoePolicyFileWrite,
  evaluateNoePolicyShellMutation,
} from '../security/NoePolicyFileGuard.js';
import { sanitizeNoeHostExecEnv } from '../security/NoeHostExecEnv.js';
import { checkDomainAllowed } from '../capabilities/NoeBrowserActPolicy.js';
import { registerNoeSelfEvolutionExecutors } from './NoeSelfEvolutionExecutors.js';
import { registerNoeCapabilityExecutors } from '../capabilities/NoeCapabilityExecutor.js';

// 自由执行器（shell.exec/tool.execute）的扩展白名单：覆盖常用开发命令。
// 注意：命令名进白名单只是第一关，参数仍由 DangerousPatternDetector 标出高风险模式；
//   developer/unrestricted 信任档下，ExecPolicyStore 负责把 owner 授权落到真实执行和审计证据。
const EXTENDED_ALLOWED_COMMANDS = new Set([
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'git', 'python3', 'python', 'pip3', 'pip',
  'rg', 'grep', 'find', 'ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'sed', 'awk', 'echo',
  'mkdir', 'touch', 'cp', 'mv', 'which', 'env', 'test', 'diff', 'make', 'go', 'cargo',
  'tsc', 'deno', 'bun', 'jq', 'sort', 'uniq', 'tr', 'cut', 'date', 'whoami', 'uname',
  'tar', 'unzip', 'zip', 'open', 'curl', 'wget',
]);

const MAX_WRITE_BYTES = 200_000;
const DEFAULT_NOTE_PATH = 'output/noe-autonomy/notes.md';
const MAX_OUTPUT_BYTES = 40_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_AUTOMATION_SCRIPT_BYTES = 50_000;
const ALLOWED_COMMANDS = new Set(['node', 'npm', 'git', 'rg', 'ls', 'pwd', 'cat', 'sed', 'wc']);
const GIT_SUBCOMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse']);
const NPM_SUBCOMMANDS = new Set(['run', 'test']);
const SECRET_TEXT_RE = /((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi;
const SENSITIVE_TYPING_TEXT_RE = /(?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token)\s*[:=]|\bBearer\s+[A-Za-z0-9._~+/=-]+|\bsk-[A-Za-z0-9_-]{8,}\b/i;
const MAX_TYPING_BYTES = 10_000;
const MACOS_KEY_CODES = Object.freeze({
  return: 36,
  enter: 76,
  escape: 53,
  esc: 53,
  tab: 48,
  space: 49,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  delete: 51,
  backspace: 51,
  forward_delete: 117,
  home: 115,
  end: 119,
  page_up: 116,
  page_down: 121,
});
const MACOS_SUBMIT_KEYS = new Set(['return', 'enter', 'space']);
const MACOS_DESTRUCTIVE_KEYS = new Set(['delete', 'backspace', 'forward_delete']);

function payloadFrom({ act, input }) {
  return { ...(act?.payload || {}), ...(input?.payload || {}) };
}

function resolveSandboxPath(userPath, safeResolveFsPath) {
  const raw = String(userPath || '').trim();
  if (!raw) throw new Error('path required');
  let full = typeof safeResolveFsPath === 'function' ? safeResolveFsPath(raw) : null;
  const resolvedByInjectedSandbox = Boolean(full);
  const base = resolve(process.cwd());
  const rawResolved = resolve(base, raw);
  if (!full) {
    if (rawResolved === base || rawResolved.startsWith(base + sep)) full = rawResolved;
    else throw new Error('path outside workspace or denied by sandbox');
  }
  const resolved = resolve(String(full || ''));
  if (!resolvedByInjectedSandbox && resolved !== base && !resolved.startsWith(base + sep)) {
    throw new Error('path outside workspace');
  }
  const parts = resolved.split(sep).filter(Boolean);
  if (parts.includes('.git') || parts.includes('node_modules')) throw new Error('refusing to write protected project path');
  if (/^\.env(?:\.|$)/.test(basename(resolved))) throw new Error('refusing to write env files');
  assertNoePolicyFileMutationAllowed(resolved, 'file.write_text');
  return resolved;
}

function assertNoePolicyFileMutationAllowed(filePath, operation) {
  const report = evaluateNoePolicyFileWrite({
    path: filePath,
    operation,
    cwd: process.cwd(),
    root: process.cwd(),
    env: process.env,
  });
  if (report.blocked) {
    const compact = compactNoePolicyFileGuardReport(report);
    throw new Error(`noe_policy_file_mutation_denied: ${compact.operation || operation}:${compact.matchedId || 'policy-file'}`);
  }
}

function assertNoePolicyShellMutationAllowed(command, args, cwd) {
  const report = evaluateNoePolicyShellMutation({
    command,
    args,
    cwd,
    root: process.cwd(),
    env: process.env,
  });
  if (report.blocked) {
    const compact = compactNoePolicyFileGuardReport(report);
    throw new Error(`noe_policy_file_mutation_denied: ${compact.operation || 'shell'}:${compact.matchedId || 'policy-file'}`);
  }
}

function safeEnv(env = process.env) {
  return sanitizeNoeHostExecEnv(env, {
    allowlist: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SHELL'],
  });
}

function validateCommand(command, args = [], opts = {}) {
  const cmd = String(command || '').trim();
  if (!ALLOWED_COMMANDS.has(cmd)) throw new Error(`command not allowed: ${cmd || '(empty)'}`);
  const cleanArgs = (Array.isArray(args) ? args : []).map((arg) => String(arg));
  if (cleanArgs.some((arg) => /[\0]/.test(arg))) throw new Error('command args contain invalid characters');
  if (cmd === 'git' && cleanArgs[0] && !GIT_SUBCOMMANDS.has(cleanArgs[0])) {
    throw new Error(`git subcommand not allowed: ${cleanArgs[0]}`);
  }
  if (cmd === 'npm' && cleanArgs[0] && !NPM_SUBCOMMANDS.has(cleanArgs[0])) {
    throw new Error(`npm subcommand not allowed: ${cleanArgs[0]}`);
  }
  assertNoePolicyShellMutationAllowed(cmd, cleanArgs, opts.cwd || process.cwd());
  return { command: cmd, args: cleanArgs.slice(0, 20) };
}

function redactText(value) {
  return String(value || '')
    .replace(SECRET_TEXT_RE, '$1[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED_KEY]');
}

// 自由版命令校验：扩展白名单 + argv-style + DangerousPatternDetector 兜底（不限子命令，靠 detector 拦真危险）。
function validateFreeCommand(command, args, detector, opts = {}) {
  const cmd = String(command || '').trim();
  if (!cmd) throw new Error('command required');
  if (!EXTENDED_ALLOWED_COMMANDS.has(cmd)) throw new Error(`command not allowed: ${cmd}`);
  const cleanArgs = (Array.isArray(args) ? args : []).map((arg) => String(arg));
  if (cleanArgs.some((arg) => /[\0]/.test(arg))) throw new Error('command args contain invalid characters');
  assertNoePolicyShellMutationAllowed(cmd, cleanArgs, opts.cwd || process.cwd());
  const full = `${cmd} ${cleanArgs.join(' ')}`.trim();
  const hits = detector.scan(full);
  if (detector.shouldBlock(hits, 'standard')) {
    const worst = detector.worstSeverity(hits);
    throw new Error(`dangerous command blocked (${worst}): ${hits[0]?.rule?.category || 'matched danger rule'}`);
  }
  return { command: cmd, args: cleanArgs.slice(0, 40) };
}

function runCommand({ command, args, cwd, timeoutMs, runner }) {
  if (runner) return runner({ command, args, cwd, timeoutMs, env: safeEnv() });
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: safeEnv(), shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const collect = (chunk, key) => {
      const next = (key === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
      const sliced = next.slice(-MAX_OUTPUT_BYTES);
      if (key === 'stdout') stdout = sliced;
      else stderr = sliced;
    };
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ exitCode: Number(code) || 0, signal: signal || null, stdout, stderr });
    });
  });
}

function normalizeBrowserUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) throw new Error('url required');
  let parsed;
  try { parsed = new URL(raw); } catch {
    parsed = new URL(`https://${raw}`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error(`browser.open only supports http/https URLs: ${parsed.protocol}`);
  }
  // P4-1 NetworkPolicy 域白名单（NOE_BROWSER_ALLOWLIST 逗号分隔，opt-in；不设=开放=owner 最大自由，设了才拦非白名单域）。
  const allowlist = String(process.env.NOE_BROWSER_ALLOWLIST || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (allowlist.length) {
    const chk = checkDomainAllowed(parsed.toString(), allowlist);
    if (!chk.allowed) throw new Error(`browser network policy blocked: ${chk.host || parsed.hostname} 不在 NOE_BROWSER_ALLOWLIST`);
  }
  return parsed.toString();
}

function normalizeMacosAppName(value) {
  const app = String(value || '').trim();
  if (!app) throw new Error('app required');
  if (app.length > 120) throw new Error('app name too long');
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,119}$/.test(app)) {
    throw new Error('app name contains unsupported characters');
  }
  return app;
}

function normalizeMacosTypingText(value) {
  const text = String(value ?? '');
  if (!text) throw new Error('text required');
  if (/[\r\n]/.test(text)) throw new Error('macos.text.type refuses newline text; use a scoped DOM action or explicit submit workflow');
  if (Buffer.byteLength(text, 'utf8') > MAX_TYPING_BYTES) throw new Error(`text exceeds ${MAX_TYPING_BYTES} bytes`);
  if (SENSITIVE_TYPING_TEXT_RE.test(text)) throw new Error('refusing to type sensitive-looking text');
  return text;
}

function buildMacosTypeTextScript(text) {
  return `
const app = Application.currentApplication();
app.includeStandardAdditions = true;
app.setTheClipboardTo(${JSON.stringify(text)});
delay(0.2);
Application("System Events").keystroke("v", { using: "command down" });
JSON.stringify({ ok: true });
`;
}

function normalizeMacosKey(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  const aliases = {
    arrow_left: 'left',
    left_arrow: 'left',
    arrow_right: 'right',
    right_arrow: 'right',
    arrow_up: 'up',
    up_arrow: 'up',
    arrow_down: 'down',
    down_arrow: 'down',
    pgup: 'page_up',
    pageup: 'page_up',
    pgdn: 'page_down',
    pagedown: 'page_down',
    del: 'delete',
    forwarddelete: 'forward_delete',
  };
  const key = aliases[raw] || raw;
  const keyCode = MACOS_KEY_CODES[key];
  if (!Number.isInteger(keyCode)) throw new Error(`unsupported macOS key: ${raw || '(empty)'}`);
  return { key, keyCode };
}

function buildMacosKeyPressScript(keyCode) {
  return `tell application "System Events" to key code ${keyCode}`;
}

function normalizeScreenCoordinate(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} coordinate required`);
  const rounded = Math.round(n);
  if (rounded < 0 || rounded > 20000) throw new Error(`${name} coordinate out of supported range`);
  return rounded;
}

function buildMacosCoordinateClickScript(x, y) {
  return `tell application "System Events" to click at {${x}, ${y}}`;
}

function normalizeMacosAutomationScript(value) {
  const script = String(value ?? '');
  if (!script.trim()) throw new Error('script required');
  if (/[\0]/.test(script)) throw new Error('script contains invalid characters');
  if (Buffer.byteLength(script, 'utf8') > MAX_AUTOMATION_SCRIPT_BYTES) {
    throw new Error(`script exceeds ${MAX_AUTOMATION_SCRIPT_BYTES} bytes`);
  }
  return script;
}

const DANGEROUS_BROWSER_CLICK_RE = /(final[_-]?publish|publish|post|upload|delete|remove|trash|submit|send|pay|purchase|付款|购买|发布|上传|删除|移除|提交|发送)/i;

function normalizeHints(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 20);
  const s = String(value || '').trim();
  return s ? [s] : [];
}

function buildBrowserDomArgs(payload = {}, actions = null) {
  const args = {
    browserApp: String(payload.browserApp || payload.app || 'Google Chrome').trim().slice(0, 120) || 'Google Chrome',
    actions: Array.isArray(actions) ? actions : Array.isArray(payload.actions) ? payload.actions : [{ type: 'read_title' }],
  };
  if (payload.expectedHost || payload.host) args.expectedHost = String(payload.expectedHost || payload.host).trim().slice(0, 240);
  if (Array.isArray(payload.expectedHosts)) args.expectedHosts = payload.expectedHosts.map((host) => String(host || '').trim()).filter(Boolean).slice(0, 20);
  if (payload.pageProbe && typeof payload.pageProbe === 'object') args.pageProbe = payload.pageProbe;
  return args;
}

function makeBrowserClickAction(payload = {}) {
  const selector = String(payload.selector || payload.css || '').trim();
  const hints = normalizeHints(payload.hints || payload.labels || payload.text || payload.label);
  if (!selector && !hints.length) throw new Error('browser.click requires selector or hints');
  return {
    type: selector ? 'click' : 'click_by_hints',
    selector,
    role: String(payload.role || payload.field || '').trim().slice(0, 80),
    probeTarget: String(payload.probeTarget || payload.target || 'clickable').trim().slice(0, 80),
    hints,
  };
}

function makeBrowserTypeAction(payload = {}) {
  const selector = String(payload.selector || payload.css || '').trim();
  const hints = normalizeHints(payload.hints || payload.labels || payload.field || payload.label);
  const value = payload.value ?? payload.text ?? payload.content;
  if (value === undefined || value === null) throw new Error('browser.type requires text/value');
  if (!selector && !hints.length) throw new Error('browser.type requires selector or hints');
  return {
    type: selector ? 'set_value' : 'set_by_hints',
    selector,
    role: String(payload.role || payload.field || '').trim().slice(0, 80),
    hints,
    value: String(value).slice(0, 20_000),
  };
}

function assertBrowserSideEffectAck(actions = [], payload = {}) {
  if (payload.ackSideEffect === true || payload.ackExternalSideEffect === true || payload.allowExternalSideEffect === true || payload.ownerApproved === true) return;
  for (const action of actions) {
    const type = String(action?.type || '').toLowerCase();
    if (!type.includes('click')) continue;
    const text = [
      action.selector,
      action.role,
      action.probeTarget,
      ...(Array.isArray(action.hints) ? action.hints : []),
    ].filter(Boolean).join(' ');
    if (DANGEROUS_BROWSER_CLICK_RE.test(text)) {
      throw new Error('browser_dom_external_side_effect_ack_required');
    }
  }
}

function assertBrowserDomResult(out = {}, expected = '') {
  if (out?.ok !== true) {
    const blockers = Array.isArray(out?.blockers) ? out.blockers.join('; ') : '';
    throw new Error(out?.error || blockers || 'browser dom action failed');
  }
  const actions = Array.isArray(out.actions) ? out.actions : [];
  if (!expected || !actions.length) return;
  const ok = expected === 'click'
    ? actions.some((action) => action.clicked === true)
    : expected === 'type'
      ? actions.some((action) => action.valueSet === true)
      : true;
  if (!ok) throw new Error(`browser.${expected} did not complete on the active page`);
}

async function runBrowserDomAdapter({ payload, actions, freedomDeps }) {
  const tool = findNoeFreedomTool('noe.freedom.browser.dom.execute');
  const args = buildBrowserDomArgs(payload, actions);
  const out = await runNoeFreedomAdapter({
    tool,
    args,
    root: process.cwd(),
    deps: freedomDeps,
    realExecute: true,
  });
  return { out, args };
}

async function reopenBrowserDomTarget({ payload = {}, runCommand, commandRunner }) {
  const rawUrl = payload.url || payload.targetUrl || payload.href;
  if (!rawUrl) return null;
  const url = normalizeBrowserUrl(rawUrl);
  const app = normalizeMacosAppName(payload.browserApp || payload.app || 'Google Chrome');
  const timeoutMs = Math.min(Math.max(Number(payload.reopenTimeoutMs || payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const args = ['-a', app, url];
  const result = await runCommand({ command: 'open', args, cwd: process.cwd(), timeoutMs, runner: commandRunner });
  const activateScript = `tell application "${app}" to activate`;
  const activation = await runCommand({ command: 'osascript', args: ['-e', activateScript], cwd: process.cwd(), timeoutMs: Math.min(timeoutMs, 5000), runner: commandRunner });
  const retryDelayRaw = payload.retryDelayMs ?? 2000;
  const retryDelayMs = Math.min(Math.max(Number(retryDelayRaw) || 0, 0), 5000);
  if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  return {
    app,
    url,
    command: 'open',
    args,
    timeoutMs,
    exitCode: result.exitCode,
    activationExitCode: activation.exitCode,
    signal: result.signal || null,
    stdout: String(result.stdout || '').slice(-MAX_OUTPUT_BYTES),
    stderr: `${String(result.stderr || '')}\n${String(activation.stderr || '')}`.trim().slice(-MAX_OUTPUT_BYTES),
  };
}

export function createSafeActExecutors({ safeResolveFsPath = null, commandRunner = null, detector = new DangerousPatternDetector(), trasher = null, freedomDeps = {}, selfEvolution = null, capability = null } = {}) {
  const executors = new Map([
    ['file.write_text', async ({ act, input }) => {
      const payload = payloadFrom({ act, input });
      const targetPath = resolveSandboxPath(payload.path || payload.targetPath, safeResolveFsPath);
      // 与 noe.note.write 对齐：Noe 自主落盘前对 content 做 secret 脱敏，secret 原值绝不入文件（防外泄）。
      const content = redactText(payload.content ?? '');
      if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes`);
      await mkdir(dirname(targetPath), { recursive: true });
      if (payload.append === true) await appendFile(targetPath, content, 'utf8');
      else await writeFile(targetPath, content, 'utf8');
      return {
        path: targetPath,
        bytes: Buffer.byteLength(content, 'utf8'),
        append: payload.append === true,
      };
    }],
    ['visual.action.plan', async ({ act, input }) => {
      const payload = payloadFrom({ act, input });
      const plan = planVisualAction({
        goal: payload.goal || payload.stepText || act?.title || '',
        screenshotSummary: payload.screenshotSummary || payload.screenshot || '',
        domSummary: payload.domSummary || payload.dom || '',
        surface: payload.surface || 'browser',
      });
      if (!plan.ok) throw new Error(plan.error || 'visual action plan failed');
      return plan;
    }],
    ['noe.note.write', async ({ act, input }) => {
      const payload = payloadFrom({ act, input });
      const targetPath = resolveSandboxPath(payload.path || payload.targetPath || DEFAULT_NOTE_PATH, safeResolveFsPath);
      const rawContent = payload.content ?? payload.note ?? payload.stepText ?? act?.title ?? 'Noe autonomous note';
      const content = redactText(rawContent).trim();
      if (!content) throw new Error('note content required');
      const stamp = new Date().toISOString();
      const entry = `\n## ${stamp}\n\n${content}\n`;
      if (Buffer.byteLength(entry, 'utf8') > MAX_WRITE_BYTES) throw new Error(`content exceeds ${MAX_WRITE_BYTES} bytes`);
      await mkdir(dirname(targetPath), { recursive: true });
      await appendFile(targetPath, entry, 'utf8');
      return {
        path: targetPath,
        bytes: Buffer.byteLength(entry, 'utf8'),
        append: true,
      };
    }],
    ['shell.safe_exec', async ({ act, input }) => {
      const payload = payloadFrom({ act, input });
      if (typeof payload.command === 'string' && payload.command.includes(' ')) {
        throw new Error('command must be argv-style: {command,args}; shell strings are not allowed');
      }
      const cwd = payload.cwd ? resolveSandboxPath(payload.cwd, safeResolveFsPath) : process.cwd();
      const { command, args } = validateCommand(payload.command, payload.args, { cwd });
      const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
      const result = await runCommand({ command, args, cwd, timeoutMs, runner: commandRunner });
      return {
        command,
        args,
        cwd,
        timeoutMs,
        exitCode: result.exitCode,
        signal: result.signal || null,
        stdout: String(result.stdout || '').slice(-MAX_OUTPUT_BYTES),
        stderr: String(result.stderr || '').slice(-MAX_OUTPUT_BYTES),
      };
    }],
  ]);

  // ── 自由执行器：developer 信任档下，ActPipeline 经 ExecPolicyStore 放行后才会调到这里 ──
  const freeExec = async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    if (typeof payload.command === 'string' && payload.command.includes(' ')) {
      throw new Error('command must be argv-style: {command,args}; shell strings are not allowed');
    }
    const cwd = payload.cwd ? resolve(String(payload.cwd)) : process.cwd();
    const { command, args } = validateFreeCommand(payload.command, payload.args, detector, { cwd });
    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const result = await runCommand({ command, args, cwd, timeoutMs, runner: commandRunner });
    return {
      command,
      args,
      cwd,
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal || null,
      stdout: String(result.stdout || '').slice(-MAX_OUTPUT_BYTES),
      stderr: String(result.stderr || '').slice(-MAX_OUTPUT_BYTES),
    };
  };
  executors.set('shell.exec', freeExec);
  executors.set('tool.execute', freeExec);

  // 低风险真实电脑动作：打开浏览器 URL。配合 ActPipeline.autoExecuteLowRisk，
  // Noe 的 goal act 可以真的“动一下电脑”，同时仍产生 noe_act_executed 证据。
  executors.set('browser.open', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    const url = normalizeBrowserUrl(payload.url || payload.targetUrl || payload.href);
    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const app = normalizeMacosAppName(payload.browserApp || payload.app || 'Google Chrome');
    // 复用当前标签(set URL of active tab)而非 macOS `open` 开新 tab——治"自主学习反复开网页累积、标签堆爆卡电脑"
    //   (owner 2026-06-23)。Chrome 系浏览器走 AppleScript set URL(无窗口先开一个,只此一处可能新开窗口)；
    //   非 Chrome 或脚本失败时回退 open。allowNewTab:true 显式要求时才用 open 新开。url 内反斜杠/引号转义防 AppleScript 注入。
    const isChromeLike = /chrome|chromium|brave|edge|vivaldi/i.test(app);
    const forceNewTab = payload.allowNewTab === true || payload.newTab === true;
    let command;
    let args;
    let result;
    let reused = false;
    if (isChromeLike && !forceNewTab) {
      const safeUrl = url.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `tell application "${app}"\n  activate\n  if (count of windows) = 0 then make new window\n  set URL of active tab of front window to "${safeUrl}"\nend tell`;
      command = 'osascript';
      args = ['-e', script];
      result = await runCommand({ command, args, cwd: process.cwd(), timeoutMs, runner: commandRunner });
      if (result && result.exitCode === 0) reused = true;
    }
    if (!reused) {
      // 非 Chrome 系 / 显式要新标签 / AppleScript 失败 → 回退 macOS open（可能新开标签）
      command = 'open';
      args = [url];
      result = await runCommand({ command, args, cwd: process.cwd(), timeoutMs, runner: commandRunner });
    }
    return {
      url,
      command,
      args,
      reused,
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal || null,
      stdout: String(result.stdout || '').slice(-MAX_OUTPUT_BYTES),
      stderr: String(result.stderr || '').slice(-MAX_OUTPUT_BYTES),
    };
  });
  executors.set('browser.open_url', executors.get('browser.open'));
  executors.set('noe.browser.open_url', executors.get('browser.open'));

  executors.set('macos.app.activate', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    const app = normalizeMacosAppName(payload.app || payload.appName || payload.name);
    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    const result = await runCommand({ command: 'open', args: ['-a', app], cwd: process.cwd(), timeoutMs, runner: commandRunner });
    if (Number(result.exitCode) !== 0) throw new Error(`macos.app.activate failed: ${String(result.stderr || result.stdout || 'open failed').slice(0, 500)}`);
    return {
      app,
      command: 'open',
      args: ['-a', app],
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal || null,
      stdout: String(result.stdout || '').slice(-MAX_OUTPUT_BYTES),
      stderr: String(result.stderr || '').slice(-MAX_OUTPUT_BYTES),
      desktopAutomationAttempted: true,
    };
  });
  executors.set('macos.open_app', executors.get('macos.app.activate'));
  executors.set('desktop.app.activate', executors.get('macos.app.activate'));

  executors.set('macos.text.type', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    const text = normalizeMacosTypingText(payload.text ?? payload.value ?? payload.content);
    if (payload.ackClipboardOverwrite !== true && payload.allowClipboardOverwrite !== true && payload.ownerApproved !== true) {
      throw new Error('macos.text.type requires ackClipboardOverwrite=true because it uses clipboard paste without reading/restoring the previous clipboard');
    }
    const app = payload.app || payload.appName ? normalizeMacosAppName(payload.app || payload.appName) : null;
    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    let activation = null;
    if (app) {
      activation = await runCommand({ command: 'open', args: ['-a', app], cwd: process.cwd(), timeoutMs, runner: commandRunner });
      if (Number(activation.exitCode) !== 0) throw new Error(`macos.text.type app activation failed: ${String(activation.stderr || activation.stdout || 'open failed').slice(0, 500)}`);
    }
    const result = await runCommand({
      command: 'osascript',
      args: ['-l', 'JavaScript', '-e', buildMacosTypeTextScript(text)],
      cwd: process.cwd(),
      timeoutMs,
      runner: commandRunner,
    });
    if (Number(result.exitCode) !== 0) throw new Error(`macos.text.type failed: ${String(result.stderr || result.stdout || 'osascript failed').slice(0, 500)}`);
    return {
      app,
      command: 'osascript',
      language: 'JavaScript',
      strategy: 'clipboard_paste',
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal || null,
      textBytes: Buffer.byteLength(text, 'utf8'),
      textReturned: false,
      clipboardOverwritten: true,
      previousClipboardRead: false,
      activatedApp: Boolean(app),
      activationExitCode: activation ? activation.exitCode : null,
      stdout: String(result.stdout || '').slice(-MAX_OUTPUT_BYTES),
      stderr: String(result.stderr || '').slice(-MAX_OUTPUT_BYTES),
      desktopAutomationAttempted: true,
    };
  });
  executors.set('macos.type_text', executors.get('macos.text.type'));
  executors.set('desktop.text.type', executors.get('macos.text.type'));

  executors.set('macos.key.press', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    const { key, keyCode } = normalizeMacosKey(payload.key || payload.keyName || payload.name);
    if (MACOS_SUBMIT_KEYS.has(key) && payload.ackSubmitKey !== true && payload.ownerApproved !== true) {
      throw new Error('macos.key.press requires ackSubmitKey=true for return/enter/space because it can submit or activate focused controls');
    }
    if (MACOS_DESTRUCTIVE_KEYS.has(key) && payload.ackDestructiveKey !== true && payload.ownerApproved !== true) {
      throw new Error('macos.key.press requires ackDestructiveKey=true for delete/backspace keys');
    }
    const app = payload.app || payload.appName ? normalizeMacosAppName(payload.app || payload.appName) : null;
    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    let activation = null;
    if (app) {
      activation = await runCommand({ command: 'open', args: ['-a', app], cwd: process.cwd(), timeoutMs, runner: commandRunner });
      if (Number(activation.exitCode) !== 0) throw new Error(`macos.key.press app activation failed: ${String(activation.stderr || activation.stdout || 'open failed').slice(0, 500)}`);
    }
    const result = await runCommand({
      command: 'osascript',
      args: ['-e', buildMacosKeyPressScript(keyCode)],
      cwd: process.cwd(),
      timeoutMs,
      runner: commandRunner,
    });
    if (Number(result.exitCode) !== 0) throw new Error(`macos.key.press failed: ${String(result.stderr || result.stdout || 'osascript failed').slice(0, 500)}`);
    return {
      app,
      key,
      keyCode,
      command: 'osascript',
      language: 'AppleScript',
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal || null,
      activatedApp: Boolean(app),
      activationExitCode: activation ? activation.exitCode : null,
      stdout: String(result.stdout || '').slice(-MAX_OUTPUT_BYTES),
      stderr: String(result.stderr || '').slice(-MAX_OUTPUT_BYTES),
      desktopAutomationAttempted: true,
    };
  });
  executors.set('macos.press_key', executors.get('macos.key.press'));
  executors.set('desktop.key.press', executors.get('macos.key.press'));

  executors.set('macos.pointer.click', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    if (payload.ackCoordinateClick !== true && payload.ownerApproved !== true) {
      throw new Error('macos.pointer.click requires ackCoordinateClick=true because screen coordinates can hit arbitrary UI');
    }
    const x = normalizeScreenCoordinate(payload.x ?? payload.left, 'x');
    const y = normalizeScreenCoordinate(payload.y ?? payload.top, 'y');
    const app = payload.app || payload.appName || payload.name ? normalizeMacosAppName(payload.app || payload.appName || payload.name) : null;
    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    let activation = null;
    if (app) {
      activation = await runCommand({ command: 'open', args: ['-a', app], cwd: process.cwd(), timeoutMs, runner: commandRunner });
      if (Number(activation.exitCode) !== 0) throw new Error(`macos.pointer.click app activation failed: ${String(activation.stderr || activation.stdout || 'open failed').slice(0, 500)}`);
    }
    let result = null;
    let command = 'cliclick';
    let args = [`c:${x},${y}`];
    let backend = 'cliclick';
    try {
      result = await runCommand({ command, args, cwd: process.cwd(), timeoutMs, runner: commandRunner });
      if (Number(result.exitCode) !== 0) throw new Error(String(result.stderr || result.stdout || 'cliclick failed'));
    } catch (e) {
      if (payload.requireCliclick === true) throw e;
      command = 'osascript';
      args = ['-e', buildMacosCoordinateClickScript(x, y)];
      backend = 'applescript';
      result = await runCommand({
        command,
        args,
        cwd: process.cwd(),
        timeoutMs,
        runner: commandRunner,
      });
    }
    if (Number(result.exitCode) !== 0) throw new Error(`macos.pointer.click failed: ${String(result.stderr || result.stdout || 'osascript failed').slice(0, 500)}`);
    return {
      app,
      x,
      y,
      button: 'left',
      command,
      args,
      backend,
      language: backend === 'applescript' ? 'AppleScript' : null,
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal || null,
      activatedApp: Boolean(app),
      activationExitCode: activation ? activation.exitCode : null,
      stdout: String(result.stdout || '').slice(-MAX_OUTPUT_BYTES),
      stderr: String(result.stderr || '').slice(-MAX_OUTPUT_BYTES),
      desktopAutomationAttempted: true,
    };
  });
  executors.set('macos.click', executors.get('macos.pointer.click'));
  executors.set('desktop.pointer.click', executors.get('macos.pointer.click'));
  executors.set('desktop.click', executors.get('macos.pointer.click'));

  const runMacosScript = ({ language, argsForScript }) => async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    const script = normalizeMacosAutomationScript(payload.script ?? payload.source ?? payload.code);
    const app = payload.app || payload.appName || payload.name ? normalizeMacosAppName(payload.app || payload.appName || payload.name) : null;
    const timeoutMs = Math.min(Math.max(Number(payload.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
    let activation = null;
    if (app) {
      activation = await runCommand({ command: 'open', args: ['-a', app], cwd: process.cwd(), timeoutMs, runner: commandRunner });
      if (Number(activation.exitCode) !== 0) throw new Error(`macos script app activation failed: ${String(activation.stderr || activation.stdout || 'open failed').slice(0, 500)}`);
    }
    const result = await runCommand({
      command: 'osascript',
      args: argsForScript(script),
      cwd: process.cwd(),
      timeoutMs,
      runner: commandRunner,
    });
    if (Number(result.exitCode) !== 0) throw new Error(`macos script failed: ${String(result.stderr || result.stdout || 'osascript failed').slice(0, 500)}`);
    return {
      app,
      command: 'osascript',
      language,
      timeoutMs,
      exitCode: result.exitCode,
      signal: result.signal || null,
      scriptBytes: Buffer.byteLength(script, 'utf8'),
      scriptReturned: false,
      activatedApp: Boolean(app),
      activationExitCode: activation ? activation.exitCode : null,
      stdout: String(result.stdout || '').slice(-MAX_OUTPUT_BYTES),
      stderr: String(result.stderr || '').slice(-MAX_OUTPUT_BYTES),
      desktopAutomationAttempted: true,
    };
  };
  const appleScriptRun = runMacosScript({
    language: 'AppleScript',
    argsForScript: (script) => ['-e', script],
  });
  const jxaRun = runMacosScript({
    language: 'JavaScript',
    argsForScript: (script) => ['-l', 'JavaScript', '-e', script],
  });
  executors.set('macos.applescript.run', appleScriptRun);
  executors.set('macos.script.run', appleScriptRun);
  executors.set('desktop.applescript.run', appleScriptRun);
  executors.set('desktop.script.run', appleScriptRun);
  executors.set('macos.jxa.run', jxaRun);
  executors.set('desktop.jxa.run', jxaRun);

  executors.set('browser.state_probe', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    const tool = findNoeFreedomTool('noe.freedom.browser.state_probe');
    const out = await runNoeFreedomAdapter({
      tool,
      args: payload,
      root: process.cwd(),
      deps: freedomDeps,
      realExecute: true,
    });
    if (out?.ok !== true) {
      const blockers = Array.isArray(out?.blockers) ? out.blockers.join('; ') : '';
      throw new Error(out?.error || blockers || 'browser state probe failed');
    }
    return out;
  });
  executors.set('noe.browser.state_probe', executors.get('browser.state_probe'));
  executors.set('browser.observe', executors.get('browser.state_probe'));
  executors.set('noe.visual.plan', executors.get('visual.action.plan'));

  executors.set('browser.dom.execute', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    assertBrowserSideEffectAck(actions, payload);
    const { out } = await runBrowserDomAdapter({ payload, freedomDeps });
    assertBrowserDomResult(out);
    return out;
  });

  executors.set('browser.observe_page', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    // P2 浏览器空转修复补全（三方审查 serious 共识）：默认路径(无显式 actions，含 LLM 计划/recovery)也读正文，
    //   治 observe_page 只读标题不读正文→pageContentReadByNoe 恒 false 的空转；显式传 actions 时尊重调用方。
    const actions = Array.isArray(payload.actions) && payload.actions.length ? payload.actions : [{ type: 'read_title' }, { type: 'read_body' }];
    let { out } = await runBrowserDomAdapter({ payload, actions, freedomDeps });
    if (out?.ok !== true && out?.error === 'browser_dom_host_mismatch' && (payload.url || payload.targetUrl || payload.href)) {
      const recovery = await reopenBrowserDomTarget({ payload, runCommand, commandRunner });
      const retry = await runBrowserDomAdapter({ payload, actions, freedomDeps });
      out = {
        ...retry.out,
        browserDomRecovery: {
          reason: 'browser_dom_host_mismatch',
          attempted: true,
          reopenedUrl: recovery?.url || '',
          browserApp: recovery?.app || '',
          openExitCode: recovery?.exitCode ?? null,
          activationExitCode: recovery?.activationExitCode ?? null,
        },
      };
    }
    assertBrowserDomResult(out);
    return out;
  });
  executors.set('noe.browser.observe_page', executors.get('browser.observe_page'));

  executors.set('browser.click', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    const actions = [makeBrowserClickAction(payload)];
    assertBrowserSideEffectAck(actions, payload);
    const { out } = await runBrowserDomAdapter({ payload, actions, freedomDeps });
    assertBrowserDomResult(out, 'click');
    return out;
  });

  executors.set('browser.type', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    const actions = [makeBrowserTypeAction(payload)];
    const { out } = await runBrowserDomAdapter({ payload, actions, freedomDeps });
    assertBrowserDomResult(out, 'type');
    return out;
  });
  executors.set('browser.set_value', executors.get('browser.type'));

  // 删除走 macOS 回收站（NoeSafeDelete），永不物理删除（撑红线 6：删错可一键恢复）。
  const deleter = createSafeDeleter(trasher ? { trasher } : {});
  executors.set('file.delete', async ({ act, input }) => {
    const payload = payloadFrom({ act, input });
    const deletePath = payload.path || payload.targetPath;
    assertNoePolicyFileMutationAllowed(deletePath, 'file.delete');
    const result = await deleter.delete(deletePath);
    if (result.blocked) throw new Error(`safe delete blocked: ${result.reason}`);
    if (result.ok === false) throw new Error(`safe delete failed: ${result.error || 'unknown'}`);
    return result;
  });

  // 环1：self-evolution executor（手脚）——唯一注册入口，env 门控默认 OFF。
  // 不设 NOE_SELF_EVOLUTION_EXECUTORS=1（或不注入 selfEvolution）时 Map 无这四个 key = 与现状逐字一致零回归。
  if (selfEvolution && process.env.NOE_SELF_EVOLUTION_EXECUTORS === '1') {
    registerNoeSelfEvolutionExecutors(executors, selfEvolution);
  }

  // ③ 能力自举 executor：env NOE_CAPABILITY_ACQUISITION 默认 OFF（不设=Map 无此 key=零回归）。
  if (capability && process.env.NOE_CAPABILITY_ACQUISITION === '1') {
    registerNoeCapabilityExecutors(executors, capability);
  }

  return executors;
}
