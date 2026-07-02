import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { URL } from 'node:url';
import { commandDeletesProtectedPath } from './_protectedPathGuard.js';
import { redactNoeFreedomPayload } from '../capabilities/NoeFreedomManifest.js';
import { defaultNoeSecretBroker, NoeSecretBroker } from '../secrets/NoeSecretBroker.js';
import { buildNoeAccountConnectionInventory } from './NoeAccountConnectionInventory.js';
import { redactSensitiveText } from './NoeContextScrubber.js';
import {
  DEFAULT_NOE_MARKETPLACE_DIR,
  disableNoeMarketplaceTool,
  installNoeMarketplaceTool,
  listNoeMarketplaceTools,
  readNoeMarketplaceTool,
  uninstallNoeMarketplaceTool,
} from './NoeToolMarketplaceRegistry.js';
import {
  DEFAULT_NOE_SOCIAL_DRAFT_DIR,
  cancelNoeSocialDraft,
  createNoeSocialDraft,
  listNoeSocialDrafts,
} from './NoeSocialPublishQueue.js';
import { executeNoeSocialFinalPublish } from './NoeSocialFinalPublishExecutor.js';
import { executeNoeSocialFormFill } from './NoeSocialFormFillExecutor.js';
import { buildNoeSocialFormFillPlan } from './NoeSocialFormFillPlan.js';
import { executeNoeSocialMediaUpload } from './NoeSocialMediaUploadExecutor.js';
import { buildNoeSocialMediaUploadPlan } from './NoeSocialMediaUploadPlan.js';
import { orchestrateNoeSocialPublish } from './NoeSocialPublishOrchestrator.js';
import { runNoeSocialPublishPreflight } from './NoeSocialPublishPreflight.js';
import { prepareNoeSocialPublishWorkflow } from './NoeSocialPublishWorkflow.js';
import {
  buildNoeSocialRollbackExecuteScript,
  parseNoeSocialRollbackExecuteOutput,
  planNoeSocialRollbackEvidenceGate,
} from './NoeSocialRollbackEvidenceGate.js';
import {
  DEFAULT_NOE_SSH_CONFIG_PATH,
  inspectNoeSshInventory,
} from './NoeSshInventory.js';
import {
  DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR,
  listNoeFreedomRunLedgers,
} from './NoeFreedomRunLedger.js';
import {
  buildNoeFreedomReadinessAuditDryRun,
  runNoeFreedomReadinessAudit,
} from './NoeFreedomReadinessAudit.js';
import { auditNoeProviderSecrets } from '../secrets/NoeProviderSecrets.js';
import { auditNoeProviderHealth } from '../secrets/NoeProviderHealth.js';
import { createSafeDeleter } from '../workspace/NoeSafeDelete.js';

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value)));
  } catch {
    return {};
  }
}

function sha256Json(value = {}) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function sha256Text(value = '') {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function redactDiagnosticText(value = '', max = 1000) {
  return clean(value, max)
    .replace(/\b(token|key|secret|password|auth|session|credential|jwt)\s*=\s*[^\s,;&]+/gi, '$1=[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|tp-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[redacted]');
}

function hostFromUrl(value = '') {
  try { return new URL(clean(value, 2000)).hostname.toLowerCase(); } catch { return ''; }
}

async function runProcess(command, args = [], { cwd = process.cwd(), env = process.env, spawnImpl = spawn } = {}) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on?.('data', (chunk) => { stdout += String(chunk); if (stdout.length > 20_000) stdout = stdout.slice(-20_000); });
    child.stderr?.on?.('data', (chunk) => { stderr += String(chunk); if (stderr.length > 20_000) stderr = stderr.slice(-20_000); });
    child.on?.('error', rejectProcess);
    child.on?.('close', (code, signal) => {
      resolveProcess({
        ok: Number(code) === 0,
        exitCode: code,
        signal: signal || null,
        stdout: clean(stdout, 20_000),
        stderr: clean(stderr, 20_000),
      });
    });
  });
}

function dryRunPlan({ tool, args = {}, adapter = 'generic', extras = {}, warnings = [] } = {}) {
  return {
    ok: true,
    adapter,
    plannedOnly: true,
    wouldExecute: tool?.operation || '',
    sideEffectPerformed: false,
    secretValuesReturned: false,
    argsPreview: redactNoeFreedomPayload(args),
    warnings,
    ...extras,
  };
}

function shellDryRun({ tool, args }) {
  const command = clean(args.command, 4000);
  return dryRunPlan({
    tool,
    args,
    adapter: 'shell',
    extras: {
      valid: Boolean(command),
      commandPreview: command,
      cwdPreview: clean(args.cwd || '', 2000),
    },
    warnings: command ? [] : ['command_required'],
  });
}

// shell 选择：macOS 用 zsh（本机生产环境）；zsh 不存在时回退 bash（CI ubuntu runner 没有 /bin/zsh，
// 硬编码会 spawn ENOENT → 整条 freedom 执行链 409——CI 跨平台基线抓出的真实可移植性问题）。
// 导出给测试断言 spawn 参数用（测试写死 '/bin/zsh' 在 ubuntu 上同样会挂）。
export const SHELL_BIN = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';

async function shellExecute({ args, root, deps }) {
  const command = clean(args.command, 4000);
  if (!command) return { ok: false, adapter: 'shell', error: 'command_required' };
  const cwd = clean(args.cwd || root, 2000) || root;
  return {
    adapter: 'shell',
    ...(await runProcess(SHELL_BIN, ['-lc', command], { cwd, spawnImpl: deps.spawn || spawn })),
  };
}

function sshDryRun({ tool, args }) {
  const host = clean(args.host, 300);
  const remoteCommand = clean(args.command, 4000);
  const warnings = [];
  if (!host) warnings.push('ssh_host_required');
  if (!remoteCommand) warnings.push('ssh_command_required');
  return dryRunPlan({
    tool,
    args,
    adapter: 'ssh',
    extras: {
      valid: warnings.length === 0,
      securityMode: 'execute_with_system_ssh_no_secret_output',
      host,
      remoteCommandPreview: remoteCommand,
      networkConnectionAttempted: false,
      privateKeyReadByNoe: false,
      passwordPromptAllowed: false,
    },
    warnings,
  });
}

function sshInventoryDryRun({ tool, args }) {
  const path = clean(args.path || DEFAULT_NOE_SSH_CONFIG_PATH, 2000);
  return dryRunPlan({
    tool,
    args,
    adapter: 'ssh-inventory',
    extras: {
      valid: true,
      securityMode: 'inventory_only',
      path,
      wouldReadSshConfig: true,
      privateKeyRead: false,
      networkConnectionAttempted: false,
      passwordPromptAllowed: false,
    },
  });
}

function sshInventoryExecute({ args }) {
  return {
    adapter: 'ssh-inventory',
    ...inspectNoeSshInventory({
      path: args.path || DEFAULT_NOE_SSH_CONFIG_PATH,
      maxHosts: args.maxHosts || args.limit,
      allowSymlink: args.allowSymlink === true,
    }),
  };
}

async function sshExecute({ args, root, deps }) {
  const host = clean(args.host, 300);
  const remoteCommand = clean(args.command, 4000);
  if (!host) return { ok: false, adapter: 'ssh', error: 'ssh_host_required' };
  if (!remoteCommand) return { ok: false, adapter: 'ssh', error: 'ssh_command_required' };
  return {
    adapter: 'ssh',
    securityMode: 'execute_with_system_ssh_no_secret_output',
    networkConnectionAttempted: true,
    privateKeyReadByNoe: false,
    passwordPromptAllowed: false,
    ...(await runProcess('ssh', ['-o', 'BatchMode=yes', host, remoteCommand], { cwd: root, spawnImpl: deps.spawn || spawn })),
  };
}

function inspectEnv({ args, root, deps }) {
  const broker = deps.secretBroker || defaultNoeSecretBroker;
  return {
    adapter: 'env',
    ...broker.inspectEnvFile({
      path: args.path || '.env',
      root,
      allowOutsideRoot: args.allowOutsideRoot === true,
    }),
  };
}

function inspectDesktop({ args }) {
  const path = args.path ? resolve(String(args.path).replace(/^~/, homedir())) : join(homedir(), 'Desktop');
  if (!existsSync(path)) return { ok: false, adapter: 'desktop', error: 'desktop_path_not_found', path };
  const maxEntries = Math.max(1, Math.min(500, Number(args.maxEntries || args.limit) || 80));
  const entries = readdirSync(path, { withFileTypes: true })
    .filter((entry) => args.includeHidden === true || !entry.name.startsWith('.'))
    .slice(0, maxEntries)
    .map((entry) => {
      const full = join(path, entry.name);
      let size = null;
      try { size = statSync(full).size; } catch {}
      return {
        name: clean(entry.name, 240),
        type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
        size,
        extension: entry.isFile() && entry.name.includes('.') ? clean(entry.name.slice(entry.name.lastIndexOf('.')), 40) : '',
      };
    });
  return { ok: true, adapter: 'desktop', path, count: entries.length, entries, contentRead: false };
}

function readKeychain({ args, deps }) {
  const broker = deps.secretBroker || (deps.spawnSync ? new NoeSecretBroker({ spawnSyncImpl: deps.spawnSync }) : defaultNoeSecretBroker);
  return {
    adapter: 'keychain',
    ...broker.readKeychainMetadata(args),
  };
}

function socialDryRun({ tool, args }) {
  const url = clean(args.webhookUrl || args.url, 2000);
  const content = clean(args.content || args.text || args.message, 8000);
  const warnings = [];
  if (!content) warnings.push('publish_content_required');
  if (!url) warnings.push('publish_endpoint_required');
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-publish',
    extras: {
      valid: warnings.length === 0,
      method: 'POST',
      host: hostFromUrl(url),
      wouldPostBytes: Buffer.byteLength(content, 'utf8'),
      rollbackExpectation: 'platform_delete_or_correction',
    },
    warnings,
  });
}

function browserOpenDryRun({ tool, args }) {
  const url = clean(args.url || args.href, 2000);
  const browserApp = clean(args.browserApp || args.app || '', 120);
  const warnings = [];
  if (!/^https?:\/\//i.test(url)) warnings.push('browser_url_must_be_http');
  return dryRunPlan({
    tool,
    args,
    adapter: 'browser-open',
    extras: {
      valid: warnings.length === 0,
      urlPreview: url,
      host: hostFromUrl(url),
      browserApp,
      wouldOpenBrowser: warnings.length === 0,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      externalSideEffectPerformed: false,
    },
    warnings,
  });
}

function appleScriptString(value = '') {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildBrowserOpenScript({ browserApp = 'Google Chrome', url = '' } = {}) {
  const app = appleScriptString(browserApp || 'Google Chrome');
  const targetUrl = appleScriptString(url);
  if (/safari/i.test(browserApp)) {
    return `
tell application ${app}
  activate
  if (count of documents) = 0 then
    make new document with properties {URL:${targetUrl}}
  else
    set URL of front document to ${targetUrl}
  end if
end tell
`;
  }
  return `
tell application ${app}
  activate
  if (count of windows) = 0 then make new window
  set URL of active tab of front window to ${targetUrl}
end tell
`;
}

const BROWSER_STATE_PROBE_SCRIPT = `
function safeString(value) {
  try { return String(value || ""); } catch (_) { return ""; }
}
function frontmostAppName() {
  try {
    return safeString(Application("System Events").processes.whose({ frontmost: true })()[0].name());
  } catch (error) {
    return "";
  }
}
function chromeLikeState(appName, frontmost) {
  try {
    const app = Application(appName);
    if (!app.running()) return null;
    const windows = app.windows();
    const first = frontChromeLikeWindow(windows);
    const tab = first && first.activeTab ? first.activeTab() : null;
    return {
      app: appName,
      running: true,
      frontmost: frontmost === appName,
      url: safeString(tab && tab.url ? tab.url() : ""),
      title: safeString(tab && tab.title ? tab.title() : ""),
      windowCount: windows ? windows.length : 0
    };
  } catch (error) {
    return { app: appName, running: false, frontmost: frontmost === appName, error: safeString(error.message || error) };
  }
}
function frontChromeLikeWindow(windows) {
  if (!windows || !windows.length) return null;
  for (let i = 0; i < windows.length; i += 1) {
    try {
      if (windows[i].index && Number(windows[i].index()) === 1) return windows[i];
    } catch (_) {
      // fall through to first window
    }
  }
  return windows[0] || null;
}
function safariState(frontmost) {
  try {
    const app = Application("Safari");
    if (!app.running()) return null;
    const documents = app.documents();
    const first = documents && documents.length ? documents[0] : null;
    return {
      app: "Safari",
      running: true,
      frontmost: frontmost === "Safari",
      url: safeString(first && first.url ? first.url() : ""),
      title: safeString(first && first.name ? first.name() : ""),
      windowCount: app.windows ? app.windows().length : 0
    };
  } catch (error) {
    return { app: "Safari", running: false, frontmost: frontmost === "Safari", error: safeString(error.message || error) };
  }
}
const frontmost = frontmostAppName();
const chromeApps = ["Google Chrome", "Arc", "Microsoft Edge", "Brave Browser", "Chromium"];
const browsers = chromeApps.map((name) => chromeLikeState(name, frontmost)).concat([safariState(frontmost)]).filter(Boolean);
const activeBrowser = browsers.find((item) => item.frontmost) || browsers.find((item) => item.running && item.url) || null;
JSON.stringify({
  ok: true,
  frontmostApp: frontmost,
  activeBrowser,
  browsers,
  cookiesReadByNoe: false,
  passwordReadByNoe: false,
  pageContentReadByNoe: false
});
`;

function browserStateProbeDryRun({ tool, args }) {
  return dryRunPlan({
    tool,
    args,
    adapter: 'browser-state-probe',
    extras: {
      valid: true,
      wouldRunOsaScript: true,
      language: 'JavaScript',
      includeAll: args.includeAll !== false,
      desktopAutomationAttempted: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    },
  });
}

function parseBrowserStateProbe(stdout = '') {
  try {
    const parsed = JSON.parse(clean(stdout, 20_000));
    const activeBrowser = sanitizeBrowserState(parsed.activeBrowser);
    const browsers = Array.isArray(parsed.browsers) ? parsed.browsers.slice(0, 12).map(sanitizeBrowserState) : [];
    return {
      ok: parsed.ok !== false,
      frontmostApp: clean(parsed.frontmostApp, 200),
      activeBrowser,
      browsers,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    };
  } catch {
    return {
      ok: false,
      error: 'browser_state_probe_parse_failed',
      stdoutReturned: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    };
  }
}

function redactBrowserUrl(value = '') {
  const raw = clean(value, 2000);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|password|code|auth|session|credential|jwt/i.test(key)) url.searchParams.set(key, '[redacted]');
    }
    if (/token|key|secret|password|code|auth|session|credential|jwt/i.test(url.hash)) url.hash = '#[redacted]';
    return clean(url.toString(), 2000);
  } catch {
    return raw.replace(/([?&#][^=]*?(token|key|secret|password|code|auth|session|credential|jwt)[^=]*=)[^&#\s]+/gi, '$1[redacted]');
  }
}

function sanitizeBrowserState(value = null) {
  if (!value || typeof value !== 'object') return null;
  const state = safeJson(value);
  return {
    app: clean(state.app, 120),
    running: state.running === true,
    frontmost: state.frontmost === true,
    url: redactBrowserUrl(state.url),
    title: clean(state.title, 500),
    windowCount: Math.max(0, Number(state.windowCount) || 0),
    ...(state.error ? { error: clean(state.error, 500) } : {}),
  };
}

function normalizeBrowserDomActions(actions = []) {
  const source = Array.isArray(actions) ? actions : [];
  const fallback = source.length ? source : [{ type: 'read_title' }];
  return fallback.slice(0, 20).map((action, index) => {
    const item = safeJson(action);
    return {
      index,
      type: clean(item.type || item.kind || item.action || 'read_title', 40).toLowerCase(),
      selector: clean(item.selector || item.css || '', 1000),
      role: clean(item.role || item.field || '', 80),
      probeTarget: clean(item.probeTarget || item.target || '', 80).toLowerCase(),
      hints: normalizeBrowserDomHints(item.hints || item.labels || item.match || item.matches),
      value: clean(item.value ?? item.text ?? item.content ?? '', 20_000),
    };
  });
}

function normalizeBrowserDomHints(value, maxItems = 20) {
  const source = Array.isArray(value) ? value : clean(value, 2000) ? [value] : [];
  return [...new Set(source.slice(0, maxItems).map((item) => clean(item, 200)).filter(Boolean))];
}

function browserDomExpectedHosts(args = {}) {
  const source = Array.isArray(args.expectedHosts)
    ? args.expectedHosts
    : Array.isArray(args.hosts)
      ? args.hosts
      : [args.expectedHost || args.host].filter(Boolean);
  return source.map((item) => clean(item, 240).toLowerCase()).filter(Boolean).slice(0, 20);
}

function browserDomExpectedUrlPrefixes(args = {}) {
  const source = Array.isArray(args.expectedUrlPrefixes)
    ? args.expectedUrlPrefixes
    : Array.isArray(args.expectedUrls)
      ? args.expectedUrls
      : [args.expectedUrlPrefix || args.expectedUrl].filter(Boolean);
  return source.map((item) => clean(item, 2000).toLowerCase()).filter(Boolean).slice(0, 20);
}

function browserDomActionMutates(action = {}) {
  const type = clean(action.type, 40).toLowerCase();
  return !['read_title', 'probe_by_hints'].includes(type);
}

function browserDomActionPreview(action = {}) {
  return {
    index: Number(action.index) || 0,
    type: clean(action.type, 40),
    selector: clean(action.selector, 1000),
    role: clean(action.role, 80),
    probeTarget: clean(action.probeTarget, 80),
    hintCount: Array.isArray(action.hints) ? action.hints.length : 0,
    hasValue: Boolean(action.value),
  };
}

function normalizeBrowserDomPageProbe(value = null, actions = [], expectedHosts = [], expectedUrlPrefixes = []) {
  if (!value || typeof value !== 'object') return null;
  const probe = safeJson(value);
  const requiredProbeRoles = normalizeBrowserDomHints(
    probe.requiredProbeRoles || probe.requiredRoles || actions.map((action) => action.role || action.type),
    40,
  );
  const fieldRoles = normalizeBrowserDomHints(probe.fieldRoles, 40);
  const clickableRoles = normalizeBrowserDomHints(probe.clickableRoles, 40);
  return {
    expectedHosts: browserDomExpectedHosts({ expectedHosts: probe.expectedHosts?.length ? probe.expectedHosts : expectedHosts }),
    expectedHost: clean(probe.expectedHost || expectedHosts[0] || '', 240).toLowerCase(),
    expectedUrlPrefixes: browserDomExpectedUrlPrefixes({
      expectedUrlPrefixes: probe.expectedUrlPrefixes?.length ? probe.expectedUrlPrefixes : expectedUrlPrefixes,
    }),
    requiresLoginSession: probe.requiresLoginSession === true,
    targetSurface: clean(probe.targetSurface || '', 120),
    titleRead: probe.titleRead !== false,
    requiredProbeRoles,
    fieldRoles,
    clickableRoles,
    probeOnly: probe.probeOnly !== false,
  };
}

function sanitizeBrowserDomPageReadiness(value = null) {
  if (!value || typeof value !== 'object') return null;
  const item = safeJson(value);
  const login = safeJson(item.login || {});
  return {
    ok: item.ok === true,
    hostMatched: item.hostMatched === true,
    expectedHosts: Array.isArray(item.expectedHosts) ? item.expectedHosts.map((host) => clean(host, 240)).filter(Boolean) : [],
    expectedUrlPrefixes: Array.isArray(item.expectedUrlPrefixes) ? item.expectedUrlPrefixes.map((prefix) => clean(prefix, 2000)).filter(Boolean) : [],
    targetSurface: clean(item.targetSurface, 120),
    targetSurfaceReady: item.targetSurfaceReady === true,
    requiresLoginSession: item.requiresLoginSession === true,
    loginSessionLikely: item.loginSessionLikely === true,
    login: {
      passwordFieldPresent: login.passwordFieldPresent === true,
      loginPromptPresent: login.loginPromptPresent === true,
    },
    requiredRoles: Array.isArray(item.requiredRoles) ? item.requiredRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
    foundRoles: Array.isArray(item.foundRoles) ? item.foundRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
    missingRoles: Array.isArray(item.missingRoles) ? item.missingRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
    fieldRoles: Array.isArray(item.fieldRoles) ? item.fieldRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
    clickableRoles: Array.isArray(item.clickableRoles) ? item.clickableRoles.map((role) => clean(role, 80)).filter(Boolean) : [],
    titleRead: item.titleRead === true,
    secretValuesReturned: false,
  };
}

function sanitizeBrowserDomActionResult(value = {}, index = 0) {
  const item = safeJson(value);
  return {
    index,
    type: clean(item.type, 40),
    selector: clean(item.selector, 1000),
    role: clean(item.role, 80),
    probeTarget: clean(item.probeTarget, 80),
    ok: item.ok !== false,
    found: item.found === true,
    matchedByHints: item.matchedByHints === true,
    probed: item.probed === true,
    focused: item.focused === true,
    clicked: item.clicked === true,
    valueSet: item.valueSet === true,
    contentRead: item.contentRead === true,
    // L1：保留读到的正文（read_body），否则深思拿不到内容、又退化成"只开不读"。
    ...(item.contentRead === true ? { extractedText: clean(item.extractedText, 8000), extractedLength: Number(item.extractedLength) || 0 } : {}),
    ...(item.error ? { error: clean(item.error, 300) } : {}),
  };
}

function buildBrowserDomPageScript({ actions = [], expectedHosts = [], expectedUrlPrefixes = [], pageProbe = null } = {}) {
  const safeActions = actions.map((action) => ({
    type: action.type,
    selector: action.selector,
    role: action.role,
    probeTarget: action.probeTarget,
    hints: action.hints,
    value: action.value,
  }));
  const safePageProbe = pageProbe ? {
    expectedHosts: pageProbe.expectedHosts,
    expectedUrlPrefixes: pageProbe.expectedUrlPrefixes,
    requiresLoginSession: pageProbe.requiresLoginSession,
    targetSurface: pageProbe.targetSurface,
    titleRead: pageProbe.titleRead,
    requiredProbeRoles: pageProbe.requiredProbeRoles,
    fieldRoles: pageProbe.fieldRoles,
    clickableRoles: pageProbe.clickableRoles,
  } : null;
  return `
(function () {
  function safeString(value) {
    try { return String(value || ""); } catch (_) { return ""; }
  }
  function matchesExpectedHost(host, expectedHosts) {
    if (!expectedHosts.length) return true;
    return expectedHosts.some(function (expected) {
      return host === expected || host.endsWith("." + expected);
    });
  }
  function matchesExpectedUrl(url, expectedUrlPrefixes) {
    if (!expectedUrlPrefixes.length) return true;
    const safeUrl = safeString(url).toLowerCase();
    return expectedUrlPrefixes.some(function (prefix) {
      return safeUrl.indexOf(safeString(prefix).toLowerCase()) === 0;
    });
  }
  const expectedHosts = ${JSON.stringify(expectedHosts)};
  const expectedUrlPrefixes = ${JSON.stringify(expectedUrlPrefixes)};
  const actions = ${JSON.stringify(safeActions)};
  const pageProbe = ${JSON.stringify(safePageProbe)};
  const host = safeString(location.host).toLowerCase();
  const title = safeString(document.title);
  const url = safeString(location.href);
  const hostMatched = matchesExpectedHost(host, expectedHosts);
  const urlMatched = matchesExpectedUrl(url, expectedUrlPrefixes);
  if (!hostMatched || !urlMatched) {
    return JSON.stringify({
      ok: false,
      error: hostMatched ? "browser_dom_url_mismatch" : "browser_dom_host_mismatch",
      host,
      title,
      url,
      expectedHosts,
      expectedUrlPrefixes,
      pageReadiness: pageProbe ? {
        ok: false,
        hostMatched,
        urlMatched,
        expectedHosts,
        expectedUrlPrefixes,
        targetSurface: safeString(pageProbe.targetSurface),
        targetSurfaceReady: false,
        requiresLoginSession: pageProbe.requiresLoginSession === true,
        loginSessionLikely: false,
        login: { passwordFieldPresent: false, loginPromptPresent: false },
        requiredRoles: Array.isArray(pageProbe.requiredProbeRoles) ? pageProbe.requiredProbeRoles : [],
        foundRoles: [],
        missingRoles: Array.isArray(pageProbe.requiredProbeRoles) ? pageProbe.requiredProbeRoles : [],
        fieldRoles: Array.isArray(pageProbe.fieldRoles) ? pageProbe.fieldRoles : [],
        clickableRoles: Array.isArray(pageProbe.clickableRoles) ? pageProbe.clickableRoles : [],
        titleRead: false,
        secretValuesReturned: false
      } : null,
      actions: [],
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false
    });
  }
  const results = [];
  function elementMetadata(el, includeVisibleText) {
    if (!el) return "";
    const values = [
      el.getAttribute("aria-label"),
      el.getAttribute("placeholder"),
      el.getAttribute("name"),
      el.getAttribute("id"),
      el.getAttribute("class"),
      el.getAttribute("title"),
      includeVisibleText ? el.textContent : ""
    ];
    return values.filter(Boolean).join(" ").toLowerCase();
  }
  function findByHints(candidates, hints, includeVisibleText) {
    const safeHints = Array.isArray(hints) ? hints.map(function (item) { return safeString(item).toLowerCase(); }).filter(Boolean) : [];
    if (!safeHints.length) return null;
    return candidates.find(function (el) {
      const text = elementMetadata(el, includeVisibleText);
      return safeHints.some(function (hint) { return text.indexOf(hint) >= 0; });
    }) || null;
  }
  function findField(action) {
    if (action.selector) return document.querySelector(action.selector);
    const fields = Array.from(document.querySelectorAll("input, textarea, [contenteditable='true']"));
    return findByHints(fields, action.hints, false);
  }
  function findClickable(action) {
    if (action.selector) return document.querySelector(action.selector);
    const controls = Array.from(document.querySelectorAll("button, a, [role='button'], [role='link'], [role='menuitem'], [tabindex], input[type='button'], input[type='submit'], [class*='btn'], [class*='button']"));
    return findByHints(controls, action.hints, true);
  }
  function findProbeTarget(action) {
    const target = safeString(action.probeTarget || "").toLowerCase();
    const role = safeString(action.role || "").toLowerCase();
    if (target === "clickable" || role === "media_upload" || role === "final_publish") return findClickable(action);
    return findField(action);
  }
  for (let index = 0; index < actions.length; index += 1) {
    const action = actions[index] || {};
    const type = safeString(action.type || "read_title").toLowerCase();
    const selector = safeString(action.selector || "");
    const role = safeString(action.role || "");
    const probeTarget = safeString(action.probeTarget || "");
    const result = { index, type, selector, role, probeTarget, ok: true, found: false, matchedByHints: false, focused: false, clicked: false, valueSet: false };
    try {
      if (type === "read_title") {
        result.found = true;
        results.push(result);
        continue;
      }
      if (type === "read_body" || type === "read_text" || type === "extract_text") {
        // L1：真读页面正文（innerText）——优先 main/article 主内容区，截断 8000 字，让 Neo 不再"只开不读"。
        // P5 v2 正文提取去噪(codex+M3 真实 Chrome 实测修 3 bug)：
        //   ① pickMain 优先正文容器(article 要有 p 且 >500 字,治列表页摘要卡冒充正文;补微信/知乎/V2EX 等主流站容器)
        //   ② 【不 clone】detached cloneNode 的 innerText 退化成 textContent 会泄漏 display:none 等 CSS 隐藏内容(比不去噪更脏)；
        //      改在原树临时 display:none 噪声节点 → 取 picked.innerText(在树内 CSS 感知,排除噪声+原本隐藏) → 还原 display
        //   ③ noise 去掉 .comment/.related/[aria-hidden](会掏空论坛/问答正文+误伤折叠正文) ④ 去噪空降级 picked 原始→body,最终空置 found=false 不假成功
        const pickMain = () => {
          const arts = document.querySelectorAll("article");
          let best = null, bestLen = 0;
          for (const a of arts) { const L = a.innerText ? a.innerText.length : 0; if (a.querySelector("p") && L > 500 && L > bestLen) { best = a; bestLen = L; } }
          if (best) return best;
          const sels = ["main", "[role='main']", ".article-body", ".post-content", ".article-content", ".entry-content", ".markdown-body", ".rich_media_content", "#js_content", ".RichText", ".topic_content", "[itemprop='articleBody']", ".story-body", ".article__content"];
          for (const s of sels) { const el = document.querySelector(s); if (el && el.innerText && el.innerText.length > 200) return el; }
          const art1 = document.querySelector("article"); if (art1 && art1.innerText && art1.innerText.length > 200) return art1;
          return document.body;
        };
        let text = "";
        try {
          const picked = pickMain();
          const restore = [];
          try {
            const noise = picked.querySelectorAll("nav, header, footer, aside, script, style, noscript, form, button, iframe, .ad, .ads, .advertisement, .sidebar, .share, .social, .nav, .menu, .breadcrumb, [role='navigation'], [role='banner'], [role='contentinfo']");
            for (const n of noise) { if (n && n !== picked && n.style) { restore.push([n, n.style.display]); n.style.display = "none"; } }
          } catch (e2) { /* 收集噪声失败直接取 innerText */ }
          text = safeString(picked && picked.innerText ? picked.innerText : "");
          for (const pair of restore) { try { pair[0].style.display = pair[1]; } catch (e3) { /* 还原失败忽略 */ } }
        } catch (e4) { text = ""; }
        if (!text || !text.trim()) {
          try { const p2 = pickMain(); text = safeString(p2 && p2.innerText ? p2.innerText : (document.body && document.body.innerText ? document.body.innerText : "")); } catch (e5) { text = safeString(document.body && document.body.innerText ? document.body.innerText : ""); }
        }
        const finalText = text.slice(0, 8000);
        if (!finalText || !finalText.trim()) {
          result.found = false;
          result.contentRead = false;
          result.error = "browser_dom_empty_text";
        } else {
          result.found = true;
          result.contentRead = true;
          result.extractedText = finalText;
          result.extractedLength = text.length;
        }
        results.push(result);
        continue;
      }
      if (!selector && type !== "set_by_hints" && type !== "click_by_hints" && type !== "probe_by_hints") {
        result.ok = false;
        result.error = "browser_dom_selector_required";
        results.push(result);
        continue;
      }
      const element = type === "set_by_hints" ? findField(action) : type === "click_by_hints" ? findClickable(action) : type === "probe_by_hints" ? findProbeTarget(action) : document.querySelector(selector);
      if (!element) {
        result.ok = false;
        result.error = "browser_dom_element_not_found";
        results.push(result);
        continue;
      }
      result.found = true;
      result.matchedByHints = !selector && (type === "set_by_hints" || type === "click_by_hints" || type === "probe_by_hints");
      if (type === "focus") {
        element.focus();
        result.focused = true;
      } else if (type === "probe_by_hints") {
        result.probed = true;
      } else if (type === "set_value" || type === "set_by_hints") {
        element.focus();
        const nextValue = safeString(action.value);
        if (element.isContentEditable) {
          element.textContent = nextValue;
        } else {
          element.value = nextValue;
        }
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
        result.focused = true;
        result.valueSet = true;
      } else if (type === "click" || type === "click_by_hints") {
        element.click();
        result.clicked = true;
      } else {
        result.ok = false;
        result.error = "browser_dom_action_unsupported";
      }
    } catch (error) {
      result.ok = false;
      result.error = "browser_dom_action_failed:" + safeString(error && error.message ? error.message : error).slice(0, 200);
    }
    results.push(result);
  }
  function buildPageReadiness() {
    if (!pageProbe) return null;
    const requiredRoles = Array.isArray(pageProbe.requiredProbeRoles) ? pageProbe.requiredProbeRoles.map(function (role) { return safeString(role); }).filter(Boolean) : [];
    const foundRoles = [];
    for (let i = 0; i < results.length; i += 1) {
      const item = results[i] || {};
      const role = safeString(item.role || item.type);
      if (role && item.ok !== false && item.found === true && foundRoles.indexOf(role) < 0) foundRoles.push(role);
    }
    const missingRoles = requiredRoles.filter(function (role) { return foundRoles.indexOf(role) < 0; });
    const passwordFieldPresent = document.querySelector("input[type='password']") ? true : false;
    const loginControls = Array.from(document.querySelectorAll("button, a, [role='button'], [role='link'], [role='menuitem'], [tabindex], input[type='submit'], [class*='btn'], [class*='button']"));
    const loginPromptPresent = loginControls.some(function (el) {
      const text = elementMetadata(el, true);
      return text.indexOf("login") >= 0 || text.indexOf("log in") >= 0 || text.indexOf("sign in") >= 0 || text.indexOf("登录") >= 0 || text.indexOf("登入") >= 0;
    });
    const loginSessionLikely = pageProbe.requiresLoginSession === true ? !passwordFieldPresent && !loginPromptPresent : true;
    const titleRead = results.some(function (item) { return item.type === "read_title" && item.found === true && item.ok !== false; });
    const targetSurfaceReady = hostMatched && loginSessionLikely && missingRoles.length === 0 && (pageProbe.titleRead === false || titleRead);
    return {
      ok: targetSurfaceReady,
      hostMatched,
      expectedHosts,
      expectedUrlPrefixes,
      targetSurface: safeString(pageProbe.targetSurface),
      targetSurfaceReady,
      requiresLoginSession: pageProbe.requiresLoginSession === true,
      loginSessionLikely,
      login: { passwordFieldPresent, loginPromptPresent },
      requiredRoles,
      foundRoles,
      missingRoles,
      fieldRoles: Array.isArray(pageProbe.fieldRoles) ? pageProbe.fieldRoles : [],
      clickableRoles: Array.isArray(pageProbe.clickableRoles) ? pageProbe.clickableRoles : [],
      titleRead,
      secretValuesReturned: false
    };
  }
  const pageReadiness = buildPageReadiness();
  return JSON.stringify({
    ok: results.every(function (item) { return item.ok !== false; }) && (!pageReadiness || pageReadiness.ok !== false),
    host,
    title,
    url,
    expectedHosts,
    pageReadiness,
    actions: results,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: results.some(function (item) { return item.contentRead === true && item.ok !== false; }),
    secretValuesReturned: false
  });
}());
`;
}

function buildBrowserDomJxa({
  browserApp = 'Google Chrome',
  pageScript = '',
  expectedHosts = [],
  expectedUrlPrefixes = [],
  allowTabSearch = true,
} = {}) {
  const appName = clean(browserApp || 'Google Chrome', 120) || 'Google Chrome';
  const safeExpectedHosts = Array.isArray(expectedHosts)
    ? expectedHosts.map((host) => clean(host, 240).toLowerCase()).filter(Boolean)
    : [];
  const safeExpectedUrlPrefixes = Array.isArray(expectedUrlPrefixes)
    ? expectedUrlPrefixes.map((prefix) => clean(prefix, 2000).toLowerCase()).filter(Boolean)
    : [];
  return `
function safeString(value) {
  try { return String(value || ""); } catch (_) { return ""; }
}
function hostFromUrlString(url) {
  const text = safeString(url).toLowerCase();
  const match = text.match(/^[a-z][a-z0-9+.-]*:\\/\\/([^/?#]+)/);
  return match ? match[1] : "";
}
function matchesExpectedHost(host, expectedHosts) {
  if (!expectedHosts || !expectedHosts.length) return true;
  return expectedHosts.some(function (expected) {
    return host === expected || host.endsWith("." + expected);
  });
}
function matchesExpectedUrl(url, expectedUrlPrefixes) {
  if (!expectedUrlPrefixes || !expectedUrlPrefixes.length) return true;
  const text = safeString(url).toLowerCase();
  return expectedUrlPrefixes.some(function (prefix) {
    return text.indexOf(safeString(prefix).toLowerCase()) === 0;
  });
}
function tabMatchesExpectedTarget(tab, expectedHosts, expectedUrlPrefixes) {
  if (!expectedHosts || !expectedHosts.length) return true;
  try {
    const url = tab.url();
    return matchesExpectedHost(hostFromUrlString(url), expectedHosts) && matchesExpectedUrl(url, expectedUrlPrefixes);
  } catch (_) {
    return false;
  }
}
function chromeLikeTabs(win) {
  try {
    return win && win.tabs ? win.tabs() : [];
  } catch (_) {
    return [];
  }
}
function findChromeLikeTab(windows, expectedHosts, expectedUrlPrefixes, allowTabSearch) {
  const first = frontChromeLikeWindow(windows);
  const active = first && first.activeTab ? first.activeTab() : null;
  if (!expectedHosts || !expectedHosts.length || tabMatchesExpectedTarget(active, expectedHosts, expectedUrlPrefixes)) return active;
  if (!allowTabSearch) return active;
  for (let i = 0; i < windows.length; i += 1) {
    const tabs = chromeLikeTabs(windows[i]);
    for (let j = 0; j < tabs.length; j += 1) {
      if (tabMatchesExpectedTarget(tabs[j], expectedHosts, expectedUrlPrefixes)) return tabs[j];
    }
  }
  return active;
}
function chromeLikeExecute(appName, pageScript) {
  const app = Application(appName);
  if (!app.running()) return JSON.stringify({ ok: false, browserApp: appName, error: "browser_not_running" });
  const windows = app.windows();
  const expectedHosts = ${JSON.stringify(safeExpectedHosts)};
  const expectedUrlPrefixes = ${JSON.stringify(safeExpectedUrlPrefixes)};
  const allowTabSearch = ${JSON.stringify(allowTabSearch === true)};
  const tab = findChromeLikeTab(windows, expectedHosts, expectedUrlPrefixes, allowTabSearch);
  if (!tab) return JSON.stringify({ ok: false, browserApp: appName, error: "browser_active_tab_missing" });
  const pageResult = tab.execute({ javascript: pageScript });
  return JSON.stringify({ ok: true, browserApp: appName, pageResult: safeString(pageResult) });
}
function frontChromeLikeWindow(windows) {
  if (!windows || !windows.length) return null;
  for (let i = 0; i < windows.length; i += 1) {
    try {
      if (windows[i].index && Number(windows[i].index()) === 1) return windows[i];
    } catch (_) {
      // fall through to first window
    }
  }
  return windows[0] || null;
}
function safariExecute(pageScript) {
  const app = Application("Safari");
  if (!app.running()) return JSON.stringify({ ok: false, browserApp: "Safari", error: "browser_not_running" });
  const documents = app.documents();
  const first = documents && documents.length ? documents[0] : null;
  if (!first) return JSON.stringify({ ok: false, browserApp: "Safari", error: "browser_active_document_missing" });
  const pageResult = app.doJavaScript(pageScript, { in: first });
  return JSON.stringify({ ok: true, browserApp: "Safari", pageResult: safeString(pageResult) });
}
const appName = ${JSON.stringify(appName)};
const pageScript = ${JSON.stringify(pageScript)};
appName === "Safari" ? safariExecute(pageScript) : chromeLikeExecute(appName, pageScript);
`;
}

function browserDomDryRun({ tool, args }) {
  const actions = normalizeBrowserDomActions(args.actions);
  const expectedHosts = browserDomExpectedHosts(args);
  const expectedUrlPrefixes = browserDomExpectedUrlPrefixes(args);
  const pageProbe = normalizeBrowserDomPageProbe(args.pageProbe, actions, expectedHosts, expectedUrlPrefixes);
  return dryRunPlan({
    tool,
    args,
    adapter: 'browser-dom-execute',
    extras: {
      valid: actions.length > 0,
      language: 'JavaScript',
      browserApp: clean(args.browserApp || args.app || 'Google Chrome', 120) || 'Google Chrome',
      actionCount: actions.length,
      actions: actions.map(browserDomActionPreview),
      expectedHosts,
      expectedUrlPrefixes,
      pageProbe,
      wouldRunOsaScript: true,
      desktopAutomationAttempted: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false,
    },
  });
}

function parseBrowserDomPageResult(value = '') {
  if (value && typeof value === 'object') return safeJson(value);
  try {
    return JSON.parse(clean(value, 20_000));
  } catch {
    return null;
  }
}

function parseBrowserDomExecuteStdout(stdout = '') {
  let wrapper;
  try {
    wrapper = JSON.parse(clean(stdout, 20_000));
  } catch {
    return {
      ok: false,
      error: 'browser_dom_execution_output_parse_failed',
      stdoutReturned: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false,
    };
  }
  const page = parseBrowserDomPageResult(wrapper.pageResult || wrapper.page || wrapper.result);
  if (!page) {
    return {
      ok: false,
      browserApp: clean(wrapper.browserApp, 120),
      error: clean(wrapper.error || 'browser_dom_page_result_parse_failed', 500),
      stdoutReturned: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false,
    };
  }
  const actions = Array.isArray(page.actions) ? page.actions.slice(0, 20).map(sanitizeBrowserDomActionResult) : [];
  const pageReadiness = sanitizeBrowserDomPageReadiness(page.pageReadiness);
  const redactedUrl = redactBrowserUrl(page.url);
  const title = clean(page.title, 500);
  return {
    ok: wrapper.ok !== false && page.ok !== false && (!pageReadiness || pageReadiness.ok !== false),
    browserApp: clean(wrapper.browserApp, 120),
    host: clean(page.host, 240),
    urlPresent: Boolean(redactedUrl),
    urlSha256: redactedUrl ? sha256Text(redactedUrl) : '',
    titlePresent: Boolean(title),
    titleSha256: title ? sha256Text(title) : '',
    expectedHosts: Array.isArray(page.expectedHosts) ? page.expectedHosts.map((host) => clean(host, 240)).filter(Boolean) : [],
    expectedUrlPrefixes: Array.isArray(page.expectedUrlPrefixes) ? page.expectedUrlPrefixes.map((prefix) => clean(prefix, 2000)).filter(Boolean) : [],
    pageReadiness,
    actionCount: actions.length,
    actions,
    ...(page.error ? { error: clean(page.error, 500) } : {}),
    stdoutReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: page.pageContentReadByNoe === true, // L2：透传 page script 真实申报（读了正文才 true，不再硬编码 false）
    secretValuesReturned: false,
  };
}

async function browserDomExecute({ args, root, deps }) {
  const actions = normalizeBrowserDomActions(args.actions);
  const browserApp = clean(args.browserApp || args.app || 'Google Chrome', 120) || 'Google Chrome';
  const expectedHosts = browserDomExpectedHosts(args);
  const expectedUrlPrefixes = browserDomExpectedUrlPrefixes(args);
  const pageProbe = normalizeBrowserDomPageProbe(args.pageProbe, actions, expectedHosts, expectedUrlPrefixes);
  if (!actions.length) return { ok: false, adapter: 'browser-dom-execute', error: 'browser_dom_actions_required' };
  const pageScript = buildBrowserDomPageScript({ actions, expectedHosts, expectedUrlPrefixes, pageProbe });
  const mutating = actions.some(browserDomActionMutates);
  const script = buildBrowserDomJxa({
    browserApp,
    pageScript,
    expectedHosts,
    expectedUrlPrefixes,
    allowTabSearch: !mutating || expectedUrlPrefixes.length > 0,
  });
  const out = await runProcess('osascript', ['-l', 'JavaScript', '-e', script], { cwd: root, spawnImpl: deps.spawn || spawn });
  const parsed = out.ok ? parseBrowserDomExecuteStdout(out.stdout) : {};
  const { stdout: _stdout, ...safeProcess } = out;
  return {
    adapter: 'browser-dom-execute',
    language: 'JavaScript',
    browserApp,
    actionCount: actions.length,
    desktopAutomationAttempted: true,
    secretValuesReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    stdoutReturned: false,
    ...safeProcess,
    ...parsed,
  };
}

async function browserStateProbeExecute({ root, deps }) {
  const out = await runProcess('osascript', ['-l', 'JavaScript', '-e', BROWSER_STATE_PROBE_SCRIPT], { cwd: root, spawnImpl: deps.spawn || spawn });
  const parsed = out.ok ? parseBrowserStateProbe(out.stdout) : {};
  const { stdout: _stdout, ...safeProcess } = out;
  return {
    adapter: 'browser-state-probe',
    language: 'JavaScript',
    desktopAutomationAttempted: true,
    secretValuesReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    stdoutReturned: false,
    ...safeProcess,
    ...parsed,
  };
}

function appleScriptLanguage(args = {}) {
  const language = clean(args.language || args.lang || 'AppleScript', 80).toLowerCase();
  return ['javascript', 'jxa'].includes(language) ? 'JavaScript' : 'AppleScript';
}

function appleScriptDryRun({ tool, args }) {
  const script = clean(args.script || args.code, 20_000);
  const warnings = script ? [] : ['applescript_required'];
  return dryRunPlan({
    tool,
    args,
    adapter: 'macos-applescript',
    extras: {
      valid: warnings.length === 0,
      language: appleScriptLanguage(args),
      scriptPreview: script.slice(0, 4000),
      wouldRunOsaScript: warnings.length === 0,
      desktopAutomationAttempted: false,
      secretValuesReturned: false,
    },
    warnings,
  });
}

async function appleScriptExecute({ args, root, deps }) {
  const script = clean(args.script || args.code, 20_000);
  if (!script) return { ok: false, adapter: 'macos-applescript', error: 'applescript_required' };
  const language = appleScriptLanguage(args);
  return {
    adapter: 'macos-applescript',
    language,
    desktopAutomationAttempted: true,
    secretValuesReturned: false,
    ...(await runProcess('osascript', ['-l', language, '-e', script], { cwd: root, spawnImpl: deps.spawn || spawn })),
  };
}

async function browserOpenExecute({ args, root, deps }) {
  const url = clean(args.url || args.href, 2000);
  const browserApp = clean(args.browserApp || args.app || '', 120);
  if (!/^https?:\/\//i.test(url)) return { ok: false, adapter: 'browser-open', error: 'browser_url_must_be_http' };
  const out = browserApp
    ? /safari/i.test(browserApp)
      ? await runProcess('osascript', ['-e', buildBrowserOpenScript({ browserApp, url })], { cwd: root, spawnImpl: deps.spawn || spawn })
      : await runProcess('open', ['-a', browserApp, url], { cwd: root, spawnImpl: deps.spawn || spawn })
    : await runProcess('open', [url], { cwd: root, spawnImpl: deps.spawn || spawn });
  return {
    ...out,
    adapter: 'browser-open',
    urlPreview: url,
    host: hostFromUrl(url),
    browserApp,
    browserOpenAttempted: true,
    desktopAutomationAttempted: Boolean(browserApp),
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
  };
}

async function socialExecute({ args, deps }) {
  const target = clean(args.target || args.platform || 'webhook', 120);
  const url = clean(args.webhookUrl || args.url, 2000);
  const content = clean(args.content || args.text || args.message, 8000);
  if (!content) return { ok: false, adapter: 'social-publish', error: 'publish_content_required' };
  if (!url) return { ok: false, adapter: 'social-publish', error: 'publish_endpoint_required' };
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, adapter: 'social-publish', error: 'fetch_unavailable' };
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target, content, metadata: safeJson(args.metadata) }),
  });
  return {
    ok: response.ok,
    adapter: 'social-publish',
    target,
    status: response.status,
    host: hostFromUrl(url),
    responsePreview: clean(await response.text?.(), 1000),
  };
}

function socialWorkflowDryRun({ tool, args, deps }) {
  const workflow = prepareNoeSocialPublishWorkflow({
    args,
    realExecute: false,
    draftDir: socialDraftDir(args, deps),
  });
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-workflow-prepare',
    extras: workflow,
    warnings: workflow.warnings || [],
  });
}

function socialWorkflowExecute({ args, deps }) {
  return prepareNoeSocialPublishWorkflow({
    args,
    realExecute: true,
    draftDir: socialDraftDir(args, deps),
  });
}

function socialPublishOrchestratorRun({ args, root, deps, realExecute = false }) {
  return orchestrateNoeSocialPublish({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
  });
}

function socialPreflightRun({ args, root, deps, realExecute = false }) {
  return runNoeSocialPublishPreflight({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
  });
}

function socialFormFillPlanRun({ args, deps, realExecute = false }) {
  return buildNoeSocialFormFillPlan({
    args,
    draftDir: socialDraftDir(args, deps),
    realExecute,
  });
}

async function socialFormFillExecuteRun({ args, root, deps, realExecute = false }) {
  return executeNoeSocialFormFill({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
    deps,
  });
}

function socialMediaUploadPrepareRun({ args, root, deps, realExecute = false }) {
  return buildNoeSocialMediaUploadPlan({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
  });
}

async function socialMediaUploadExecuteRun({ args, root, deps, realExecute = false }) {
  return executeNoeSocialMediaUpload({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
    deps,
  });
}

async function socialFinalPublishExecuteRun({ args, root, deps, realExecute = false }) {
  return executeNoeSocialFinalPublish({
    args,
    root,
    draftDir: socialDraftDir(args, deps),
    realExecute,
    deps,
  });
}

// Pure evidence gate. dryRun and execute both run the same gate — it never performs a real
// rollback. Destructive authorization is derived from trusted route/session authorization or deps.
// `root` is threaded into deps so a consensusLedgerRef is verified against the real repo (Task 0.2 Step5).
function socialRollbackEvidenceGateRun({ args, root, deps }) {
  return planNoeSocialRollbackEvidenceGate({
    args,
    authorization: deps.freedomAuthorization || {},
    deps: { ...deps, root: deps.root || root },
  });
}

function socialRollbackExecuteDryRun({ tool, args, root, deps }) {
  const gate = planNoeSocialRollbackEvidenceGate({
    args,
    authorization: deps.freedomAuthorization || {},
    deps: { ...deps, root: deps.root || root },
  });
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-rollback-execute',
    extras: {
      valid: gate.ok === true,
      gateStatus: gate.gateStatus,
      blockers: Array.isArray(gate.blockers) ? gate.blockers : [],
      warnings: Array.isArray(gate.warnings) ? gate.warnings : [],
      evidenceGate: gate,
      wouldExecuteRollback: gate.ok === true,
      executesRealRollback: false,
      externalSideEffectPerformed: false,
      destructionPerformed: false,
      secretValuesReturned: false,
    },
    warnings: Array.isArray(gate.warnings) ? gate.warnings : [],
  });
}

async function socialRollbackExecuteRun({ args, root, deps }) {
  const gate = planNoeSocialRollbackEvidenceGate({
    args,
    authorization: deps.freedomAuthorization || {},
    deps: { ...deps, root: deps.root || root },
  });
  if (gate.ok !== true) {
    return {
      ok: false,
      adapter: 'social-rollback-execute',
      gateStatus: gate.gateStatus,
      blockers: Array.isArray(gate.blockers) ? gate.blockers : ['rollback_evidence_gate_blocked'],
      warnings: Array.isArray(gate.warnings) ? gate.warnings : [],
      evidenceGate: gate,
      executesRealRollback: false,
      externalSideEffectPerformed: false,
      destructionPerformed: false,
      secretValuesReturned: false,
    };
  }
  const script = buildNoeSocialRollbackExecuteScript({ args });
  const execution = await runProcess('osascript', ['-l', 'JavaScript', '-e', script], {
    cwd: root,
    spawnImpl: deps.spawn || spawn,
  });
  const parsed = parseNoeSocialRollbackExecuteOutput(execution.stdout || '');
  const executionSummary = {
    ok: execution.ok === true,
    exitCode: execution.exitCode,
    signal: execution.signal,
    stderr: redactDiagnosticText(execution.stderr || '', 1000),
    stdoutReturned: false,
  };
  const destructiveRollbackNeedsVerification = ['delete', 'hide', 'recall'].includes(parsed.rollbackAction);
  const rollbackVerificationBlockers = destructiveRollbackNeedsVerification && parsed.rollbackVerified !== true
    ? ['rollback_verification_required']
    : [];
  return {
    ok: execution.ok === true && parsed.ok === true && rollbackVerificationBlockers.length === 0,
    adapter: 'social-rollback-execute',
    gateStatus: gate.gateStatus,
    evidenceGate: gate,
    executionAttempted: true,
    command: 'osascript',
    exitCode: executionSummary.exitCode,
    signal: executionSummary.signal,
    stderr: executionSummary.stderr,
    execution: executionSummary,
    rollbackExecution: parsed,
    executesRealRollback: parsed.rollbackClicked === true,
    rollbackClicked: parsed.rollbackClicked === true,
    confirmationClicked: parsed.confirmationClicked === true,
    externalSideEffectPerformed: parsed.externalSideEffectPerformed === true,
    destructionPerformed: parsed.destructionPerformed === true,
    pageContentReadByNoe: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    secretValuesReturned: false,
    stdoutReturned: false,
    blockers: parsed.ok === true ? rollbackVerificationBlockers : [parsed.error || 'rollback_execute_failed'],
  };
}

function socialDraftDir(args = {}, deps = {}) {
  return clean(args.draftDir || args.dir || deps.socialDraftDir || DEFAULT_NOE_SOCIAL_DRAFT_DIR, 2000);
}

function hasBrowserStateEvidence(browserState = {}) {
  const state = safeJson(browserState);
  if (!state || !Object.keys(state).length) return false;
  const candidates = [
    state,
    state.activeBrowser,
    ...(Array.isArray(state.browsers) ? state.browsers : []),
  ].filter(Boolean);
  return candidates.some((item) => Boolean(clean(item.url || item.activeUrl || item.title || item.app || item.browser, 1000)));
}

function browserStateProbeForInventory(probe = {}) {
  const safeProbe = safeJson(probe);
  return {
    frontmostApp: clean(safeProbe.frontmostApp, 160),
    activeBrowser: safeProbe.activeBrowser || null,
    browsers: Array.isArray(safeProbe.browsers) ? safeProbe.browsers : [],
  };
}

function summarizeBrowserStateProbe(probe = {}) {
  const safeProbe = safeJson(probe);
  return {
    ok: safeProbe.ok !== false,
    adapter: clean(safeProbe.adapter || 'browser-state-probe', 120),
    frontmostApp: clean(safeProbe.frontmostApp, 160),
    activeBrowser: safeProbe.activeBrowser ? {
      app: clean(safeProbe.activeBrowser.app, 120),
      url: redactBrowserUrl(safeProbe.activeBrowser.url),
      title: clean(safeProbe.activeBrowser.title, 500),
      frontmost: safeProbe.activeBrowser.frontmost === true,
    } : null,
    browserCount: Array.isArray(safeProbe.browsers) ? safeProbe.browsers.length : 0,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    secretValuesReturned: false,
    ...(safeProbe.error ? { error: redactDiagnosticText(safeProbe.error, 500) } : {}),
    ...(safeProbe.stderr ? { stderr: redactDiagnosticText(safeProbe.stderr, 500) } : {}),
  };
}

async function accountConnectionInventoryRun({
  args = {},
  root,
  deps = {},
  realExecute = false,
} = {}) {
  const inputArgs = safeJson(args);
  const browserStateWasProvided = hasBrowserStateEvidence(inputArgs.browserState);
  const autoProbeEnabled = inputArgs.autoProbeBrowserState !== false && inputArgs.autoProbe !== false;
  let usedArgs = inputArgs;
  let probeSummary = null;
  let autoProbeUsed = false;
  const warnings = [];

  if (realExecute === true && !browserStateWasProvided && autoProbeEnabled) {
    try {
      const probe = await browserStateProbeExecute({ root, deps });
      probeSummary = summarizeBrowserStateProbe(probe);
      if (probeSummary.ok && (probeSummary.activeBrowser || probeSummary.browserCount > 0)) {
        usedArgs = {
          ...inputArgs,
          browserState: browserStateProbeForInventory(probe),
        };
        autoProbeUsed = true;
      } else {
        warnings.push(`browser_state_auto_probe_unavailable:${redactDiagnosticText(probeSummary.error || probeSummary.stderr || 'no_browser_state', 300)}`);
      }
    } catch (error) {
      probeSummary = {
        ok: false,
        adapter: 'browser-state-probe',
        error: redactDiagnosticText(error?.message || error, 500),
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
        secretValuesReturned: false,
      };
      warnings.push(`browser_state_auto_probe_failed:${redactDiagnosticText(probeSummary.error, 300)}`);
    }
  }

  const base = buildNoeAccountConnectionInventory({ args: usedArgs, realExecute });
  const { sha256: _baseSha256, ...baseWithoutSha } = base;
  const enriched = {
    ...baseWithoutSha,
    warnings: [
      ...(Array.isArray(base.warnings) ? base.warnings : []),
      ...warnings,
    ],
    browserStateAutoProbe: {
      planned: realExecute !== true && !browserStateWasProvided && autoProbeEnabled,
      attempted: realExecute === true && !browserStateWasProvided && autoProbeEnabled,
      used: autoProbeUsed,
      source: autoProbeUsed ? 'noe.freedom.browser.state_probe' : (browserStateWasProvided ? 'provided' : 'none'),
      provided: browserStateWasProvided,
      probe: probeSummary,
    },
  };
  return {
    ...enriched,
    sha256: sha256Json({ ...enriched, sha256: undefined }),
  };
}

function freedomRunHistoryDryRun({ tool, args }) {
  return dryRunPlan({
    tool,
    args,
    adapter: 'freedom-run-history',
    extras: {
      valid: true,
      ledgerDir: clean(args.dir || args.outDir || DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR, 2000),
      limit: Math.max(1, Math.min(200, Number(args.limit) || 20)),
      onlyWithNextActions: args.onlyWithNextActions === true,
      requireOk: args.requireOk !== false,
      wouldReadFreedomRunLedgers: true,
      secretValuesReturned: false,
      sideEffectPerformed: false,
    },
  });
}

function freedomRunHistoryExecute({ args, root }) {
  const listed = listNoeFreedomRunLedgers({
    root,
    dir: args.dir || args.outDir || DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR,
    limit: args.limit || 20,
    onlyWithNextActions: args.onlyWithNextActions === true,
    requireOk: args.requireOk !== false,
  });
  const nextFreedomActions = listed.items
    .filter((item) => item.resumeCandidate)
    .slice(0, 12)
    .map((item) => ({
      stepId: `resume_${clean(item.runId || 'freedom_run', 80)}`.replace(/[^a-z0-9_.-]+/gi, '_'),
      title: `续跑 ${clean(item.runId || item.ref, 160)}`,
      actionId: 'noe.freedom.run.resume_next_actions',
      mode: 'developer_unrestricted',
      args: {
        ledgerRef: item.ref,
        stopOnError: true,
        persistChildLedgers: true,
      },
    }));
  return {
    adapter: 'freedom-run-history',
    plannedOnly: false,
    ...listed,
    nextFreedomActions,
    secretValuesReturned: false,
    sideEffectPerformed: false,
  };
}

function readinessAuditDryRun({ tool, args, deps }) {
  return buildNoeFreedomReadinessAuditDryRun({
    tool,
    args,
    deps,
    dryRunPlan,
  });
}

async function readinessAuditExecute({ args, root, deps }) {
  return runNoeFreedomReadinessAudit({
    args,
    probes: {
      browserState: () => browserStateProbeExecute({ root, deps }),
      sshInventory: (input) => sshInventoryExecute({ args: input }),
      marketplaceList: (input) => marketplaceListExecute({ args: input, deps }),
      desktopInventory: (input) => inspectDesktop({ args: input }),
      keychainRead: (input) => readKeychain({ args: input, deps }),
      providerSecrets: (input) => auditNoeProviderSecrets({
        ...input,
        env: deps.env || process.env,
        keychainReader: deps.providerKeychainReader,
        roomConfigLoader: deps.roomConfigLoader,
      }),
      providerHealth: (input) => auditNoeProviderHealth({
        ...input,
        env: deps.env || process.env,
        fetchImpl: deps.providerFetch || deps.fetch || globalThis.fetch,
        secretResolver: deps.providerSecretResolver,
        roomConfigLoader: deps.roomConfigLoader,
      }),
      commandResolver: deps.commandResolver,
    },
  });
}

function socialDraftCreateDryRun({ tool, args, deps }) {
  const dir = socialDraftDir(args, deps);
  const content = clean(args.content || args.text || args.message, 20_000);
  const warnings = content ? [] : ['social_draft_content_required'];
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-draft-create',
    extras: {
      valid: warnings.length === 0,
      draftDir: dir,
      platform: clean(args.platform || args.target || 'webhook', 80),
      wouldWriteDraft: warnings.length === 0,
      externalSideEffectPerformed: false,
      rollbackExpectation: 'cancel_draft',
    },
    warnings,
  });
}

function socialDraftCreateExecute({ args, deps }) {
  const dir = socialDraftDir(args, deps);
  return {
    adapter: 'social-draft-create',
    ...createNoeSocialDraft({ dir, draft: args }),
  };
}

function socialDraftListDryRun({ tool, args, deps }) {
  const dir = socialDraftDir(args, deps);
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-draft-list',
    extras: {
      valid: true,
      draftDir: dir,
      wouldReadDrafts: true,
      externalSideEffectPerformed: false,
    },
  });
}

function socialDraftListExecute({ args, deps }) {
  const dir = socialDraftDir(args, deps);
  return {
    adapter: 'social-draft-list',
    ...listNoeSocialDrafts({ dir }),
  };
}

function socialDraftCancelDryRun({ tool, args, deps }) {
  const dir = socialDraftDir(args, deps);
  const id = clean(args.id, 180);
  return dryRunPlan({
    tool,
    args,
    adapter: 'social-draft-cancel',
    extras: {
      valid: Boolean(id),
      id,
      draftDir: dir,
      wouldCancelDraft: Boolean(id),
      externalSideEffectPerformed: false,
      rollbackExpectation: 'recreate_draft',
    },
    warnings: id ? [] : ['social_draft_id_required'],
  });
}

function socialDraftCancelExecute({ args, deps }) {
  const dir = socialDraftDir(args, deps);
  return {
    adapter: 'social-draft-cancel',
    ...cancelNoeSocialDraft({ dir, id: args.id, reason: args.reason || 'owner_cancelled' }),
  };
}

function fileDeletePath(args = {}) {
  return clean(args.path || args.filePath || args.targetPath || '', 2000);
}

function fileDeleteDryRun({ tool, args, root, deps }) {
  const targetPath = fileDeletePath(args);
  const deleter = createSafeDeleter({
    cwd: root,
    homeDir: deps.homeDir,
    trasher: deps.trasher,
  });
  const plan = deleter.plan(targetPath);
  const warnings = [];
  if (!targetPath) warnings.push('file_delete_path_required');
  if (plan.blocked) warnings.push(`file_delete_blocked:${clean(plan.reason || 'blocked', 120)}`);
  return dryRunPlan({
    tool,
    args,
    adapter: 'file-delete',
    extras: {
      valid: plan.ok === true,
      targetPath: plan.src || targetPath,
      plan,
      wouldTrash: plan.ok === true && plan.action === 'trash',
      realFileDeletePerformed: false,
      fileDeletedToTrash: false,
      sideEffectPerformed: false,
      secretValuesReturned: false,
      rollbackExpectation: 'finder_put_back_from_trash',
    },
    warnings,
  });
}

async function fileDeleteExecute({ args, root, deps }) {
  const targetPath = fileDeletePath(args);
  const deleter = createSafeDeleter({
    cwd: root,
    homeDir: deps.homeDir,
    trasher: deps.trasher,
  });
  const out = await deleter.delete(targetPath);
  return {
    ok: out.ok === true && out.trashed === true,
    adapter: 'file-delete',
    targetPath: out.src || targetPath,
    plan: {
      ok: out.ok === true,
      blocked: out.blocked === true,
      action: out.action || '',
      reason: clean(out.reason || '', 160),
    },
    trashed: out.trashed === true,
    realFileDeletePerformed: out.trashed === true,
    fileDeletedToTrash: out.trashed === true,
    sideEffectPerformed: out.trashed === true,
    rollbackExpectation: 'finder_put_back_from_trash',
    secretValuesReturned: false,
    ...(out.error ? { error: redactDiagnosticText(out.error, 500) } : {}),
    blockers: out.ok === true && out.trashed === true ? [] : [`file_delete_failed:${clean(out.reason || out.error || 'unknown', 180)}`],
  };
}

function uploadFilePath(args = {}) {
  return clean(args.filePath || args.path || '', 2000);
}

const MAX_NETWORK_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const SECRET_UPLOAD_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'owner-token',
  'owner-token.txt',
  'room-adapters.json',
  'id_rsa',
  'id_ed25519',
  'id_dsa',
  'id_ecdsa',
]);
const SECRET_UPLOAD_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.noe-panel',
]);
const SECRET_UPLOAD_NAME_RE = /(^|[-_.])(token|secret|credential|credentials|api[-_]?key|private[-_]?key|oauth|cookie|session)([-_.]|$)/i;

function normalizeUploadFilePath(root = process.cwd(), filePath = '') {
  const raw = uploadFilePath({ filePath });
  if (!raw) return { ok: false, error: 'upload_file_path_required', filePath: '' };
  const rootPath = resolve(root || process.cwd());
  const resolved = resolve(rootPath, raw);
  const relativePath = relative(rootPath, resolved);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return { ok: false, error: 'upload_file_path_outside_root', filePath: raw };
  }
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts.at(-1)?.toLowerCase() || '';
  const containsSecretDir = parts.slice(0, -1).some((part) => SECRET_UPLOAD_SEGMENTS.has(part.toLowerCase()));
  if (containsSecretDir || SECRET_UPLOAD_BASENAMES.has(basename) || SECRET_UPLOAD_NAME_RE.test(basename)) {
    return { ok: false, error: 'upload_secret_path_blocked', filePath: normalized };
  }
  return { ok: true, resolved, filePath: normalized };
}

function uploadDryRun({ tool, args, root }) {
  const url = clean(args.url, 2000);
  const method = clean(args.method || 'POST', 12).toUpperCase();
  const body = clean(args.body || args.content || '', 20_000);
  const filePath = uploadFilePath(args);
  const warnings = [];
  if (!/^https?:\/\//i.test(url)) warnings.push('upload_url_must_be_http');
  let fileBytes = 0;
  let fileExists = false;
  if (filePath) {
    const normalized = normalizeUploadFilePath(root, filePath);
    if (!normalized.ok) {
      warnings.push(normalized.error);
    } else {
      try {
        const stat = statSync(normalized.resolved);
        fileExists = stat.isFile();
        fileBytes = fileExists ? stat.size : 0;
        if (!fileExists) warnings.push('upload_file_not_a_file');
        if (fileExists && stat.size > MAX_NETWORK_UPLOAD_FILE_BYTES) warnings.push('upload_file_too_large');
      } catch {
        warnings.push('upload_file_not_found');
      }
    }
  }
  return dryRunPlan({
    tool,
    args,
    adapter: 'network-upload',
    extras: {
      valid: warnings.length === 0,
      method,
      host: hostFromUrl(url),
      filePath: filePath || '',
      fileExists,
      fileContentRead: false,
      maxFileBytes: MAX_NETWORK_UPLOAD_FILE_BYTES,
      wouldUploadBytes: filePath ? fileBytes : Buffer.byteLength(body || JSON.stringify(redactNoeFreedomPayload(args.payload || {})), 'utf8'),
      rollbackExpectation: 'endpoint_defined',
    },
    warnings,
  });
}

async function uploadExecute({ args, root, deps }) {
  const url = clean(args.url, 2000);
  if (!/^https?:\/\//i.test(url)) return { ok: false, adapter: 'network-upload', error: 'upload_url_must_be_http' };
  const body = clean(args.body || args.content || '', 20_000);
  const filePath = uploadFilePath(args);
  let uploadBody = body || JSON.stringify(redactNoeFreedomPayload(args.payload || {}));
  let fileBytes = 0;
  let fileRef = '';
  if (filePath) {
    const normalized = normalizeUploadFilePath(root, filePath);
    if (!normalized.ok) return { ok: false, adapter: 'network-upload', error: normalized.error, filePath: normalized.filePath || filePath };
    try {
      const stat = statSync(normalized.resolved);
      if (!stat.isFile()) return { ok: false, adapter: 'network-upload', error: 'upload_file_not_a_file', filePath: normalized.filePath };
      if (stat.size > MAX_NETWORK_UPLOAD_FILE_BYTES) {
        return {
          ok: false,
          adapter: 'network-upload',
          error: 'upload_file_too_large',
          filePath: normalized.filePath,
          fileBytes: stat.size,
          maxFileBytes: MAX_NETWORK_UPLOAD_FILE_BYTES,
        };
      }
      uploadBody = readFileSync(normalized.resolved);
      fileBytes = stat.size;
      fileRef = normalized.filePath;
    } catch {
      return { ok: false, adapter: 'network-upload', error: 'upload_file_not_found', filePath: normalized.filePath };
    }
  }
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, adapter: 'network-upload', error: 'fetch_unavailable' };
  const headers = {
    'content-type': filePath ? clean(args.contentType || args.content_type || 'application/octet-stream', 120) : 'application/json',
    ...safeJson(args.headers),
  };
  const response = await fetchImpl(url, {
    method: clean(args.method || 'POST', 12).toUpperCase(),
    headers,
    body: uploadBody,
  });
  return {
    ok: response.ok,
    adapter: 'network-upload',
    status: response.status,
    host: hostFromUrl(url),
    fileUploaded: Boolean(filePath),
    fileRef,
    fileBytes,
    fileContentReturned: false,
    responsePreview: clean(await response.text?.(), 1000),
  };
}

function marketplaceToolId(args = {}) {
  const manifest = safeJson(args.manifest || args.tool);
  return clean(manifest.id || args.id, 180);
}

function marketplaceInstallDryRun({ tool, args, deps }) {
  const id = marketplaceToolId(args);
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  const warnings = id ? [] : ['tool_manifest_id_required'];
  return dryRunPlan({
    tool,
    args,
    adapter: 'tool-marketplace-install',
    extras: {
      valid: warnings.length === 0,
      id,
      wouldWritePath: id ? join(dir, `${id.replace(/[^a-z0-9_.-]+/gi, '_')}.json`) : '',
      registryDir: dir,
      rollbackExpectation: 'remove_installed_manifest',
      executionEnabled: false,
    },
    warnings,
  });
}

function marketplaceInstallExecute({ args, deps }) {
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  const out = installNoeMarketplaceTool({
    manifest: args.manifest || args.tool || { id: args.id },
    dir,
    source: args.source || 'owner-supervised',
  });
  return { adapter: 'tool-marketplace-install', ...out };
}

function marketplaceListDryRun({ tool, args, deps }) {
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return dryRunPlan({
    tool,
    args,
    adapter: 'tool-marketplace-list',
    extras: {
      valid: true,
      registryDir: dir,
      wouldReadRegistry: true,
      executionEnabled: false,
    },
  });
}

function marketplaceListExecute({ args, deps }) {
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return { adapter: 'tool-marketplace-list', ...listNoeMarketplaceTools({ dir, includeDisabled: args.includeDisabled !== false }) };
}

function marketplaceDisableDryRun({ tool, args, deps }) {
  const id = marketplaceToolId(args);
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return dryRunPlan({
    tool,
    args,
    adapter: 'tool-marketplace-disable',
    extras: {
      valid: Boolean(id),
      id,
      registryDir: dir,
      wouldWriteTombstone: Boolean(id),
      rollbackExpectation: 'reinstall_manifest',
      executionEnabled: false,
    },
    warnings: id ? [] : ['tool_manifest_id_required'],
  });
}

function marketplaceDisableExecute({ args, deps }) {
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return {
    adapter: 'tool-marketplace-disable',
    ...disableNoeMarketplaceTool({ id: marketplaceToolId(args), dir, reason: args.reason || 'owner_disabled' }),
  };
}

function marketplaceUninstallDryRun({ tool, args, deps }) {
  const id = marketplaceToolId(args);
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return dryRunPlan({
    tool,
    args,
    adapter: 'tool-marketplace-uninstall',
    extras: {
      valid: Boolean(id),
      id,
      registryDir: dir,
      wouldWriteTombstone: Boolean(id),
      rollbackExpectation: 'reinstall_manifest',
      executionEnabled: false,
    },
    warnings: id ? [] : ['tool_manifest_id_required'],
  });
}

function marketplaceUninstallExecute({ args, deps }) {
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return {
    adapter: 'tool-marketplace-uninstall',
    ...uninstallNoeMarketplaceTool({ id: marketplaceToolId(args), dir, reason: args.reason || 'owner_uninstalled' }),
  };
}

function marketplaceExecuteDir(args = {}, deps = {}) {
  return clean(args.installDir || args.dir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
}

function marketplaceEntrypoint(record = {}) {
  return clean(record.entrypoint?.value || record.manifest?.entrypoint || record.manifest?.command || record.manifest?.main, 4000);
}

function marketplaceExecuteDryRun({ tool, args, deps }) {
  const id = marketplaceToolId(args);
  const dir = marketplaceExecuteDir(args, deps);
  const current = id ? readNoeMarketplaceTool({ id, dir, includeDisabled: false }) : null;
  const entrypoint = current?.ok ? marketplaceEntrypoint(current.record) : '';
  const warnings = [];
  if (!id) warnings.push('tool_manifest_id_required');
  if (id && !current?.ok) warnings.push(current?.error || 'tool_marketplace_record_not_found');
  if (current?.ok && current.record?.state !== 'enabled') warnings.push('tool_marketplace_tool_not_enabled');
  if (current?.ok && !entrypoint) warnings.push('tool_marketplace_entrypoint_required');
  return dryRunPlan({
    tool,
    args,
    adapter: 'tool-marketplace-execute',
    extras: {
      valid: warnings.length === 0,
      id,
      registryDir: dir,
      entrypointPreview: entrypoint,
      executeAdapterConfigured: true,
      wouldExecuteEntrypoint: warnings.length === 0,
    },
    warnings,
  });
}

async function marketplaceExecute({ args, root, deps }) {
  const id = marketplaceToolId(args);
  if (!id) return { ok: false, adapter: 'tool-marketplace-execute', error: 'tool_manifest_id_required' };
  const dir = marketplaceExecuteDir(args, deps);
  const current = readNoeMarketplaceTool({ id, dir, includeDisabled: false });
  if (!current.ok) return { ok: false, adapter: 'tool-marketplace-execute', error: current.error, id };
  if (current.record?.state !== 'enabled') return { ok: false, adapter: 'tool-marketplace-execute', error: 'tool_marketplace_tool_not_enabled', id };
  const entrypoint = marketplaceEntrypoint(current.record);
  if (!entrypoint) return { ok: false, adapter: 'tool-marketplace-execute', error: 'tool_marketplace_entrypoint_required', id };
  const protectedDelete = commandDeletesProtectedPath(entrypoint);
  if (protectedDelete) {
    return {
      ok: false,
      adapter: 'tool-marketplace-execute',
      error: `developer_hard_veto_protected_delete:${protectedDelete}`,
      id,
    };
  }
  const cwd = clean(args.cwd || root, 2000) || root;
  const env = {
    ...process.env,
    ...(args.env && typeof args.env === 'object' ? args.env : {}),
  };
  return {
    adapter: 'tool-marketplace-execute',
    id,
    registryRef: current.ref,
    entrypointPreview: entrypoint,
    executionAdapterConfigured: true,
    secretValuesReturned: false,
    ...(await runProcess(SHELL_BIN, ['-lc', entrypoint], { cwd, env, spawnImpl: deps.spawn || spawn })),
  };
}

const ADAPTERS = {
  'noe.freedom.shell.execute': { dryRun: shellDryRun, execute: shellExecute },
  'noe.freedom.ssh.execute': { dryRun: sshDryRun, execute: sshExecute },
  'noe.freedom.ssh.inventory': { dryRun: sshInventoryDryRun, execute: sshInventoryExecute },
  'noe.freedom.keychain.read': { dryRun: ({ tool, args }) => dryRunPlan({ tool, args, adapter: 'keychain', extras: { readonly: true } }), execute: readKeychain },
  'noe.freedom.env.inspect': { dryRun: ({ tool, args }) => dryRunPlan({ tool, args, adapter: 'env', extras: { readonly: true } }), execute: inspectEnv },
  'noe.freedom.desktop.inventory': { dryRun: ({ tool, args }) => dryRunPlan({ tool, args, adapter: 'desktop', extras: { readonly: true, contentRead: false } }), execute: inspectDesktop },
  'noe.freedom.account.connection_inventory': {
    dryRun: ({ args, root, deps }) => accountConnectionInventoryRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => accountConnectionInventoryRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.run.history': { dryRun: freedomRunHistoryDryRun, execute: freedomRunHistoryExecute },
  'noe.freedom.developer.readiness_audit': {
    dryRun: readinessAuditDryRun,
    execute: readinessAuditExecute,
  },
  'noe.freedom.social.publish': { dryRun: socialDryRun, execute: socialExecute },
  'noe.freedom.social.workflow.prepare': { dryRun: socialWorkflowDryRun, execute: socialWorkflowExecute },
  'noe.freedom.social.publish_orchestrate': {
    dryRun: ({ args, root, deps }) => socialPublishOrchestratorRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialPublishOrchestratorRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.preflight.run': {
    dryRun: ({ args, root, deps }) => socialPreflightRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialPreflightRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.form_fill.plan': {
    dryRun: ({ args, deps }) => socialFormFillPlanRun({ args, deps, realExecute: false }),
    execute: ({ args, deps }) => socialFormFillPlanRun({ args, deps, realExecute: true }),
  },
  'noe.freedom.social.form_fill.execute': {
    dryRun: ({ args, root, deps }) => socialFormFillExecuteRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialFormFillExecuteRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.media_upload.prepare': {
    dryRun: ({ args, root, deps }) => socialMediaUploadPrepareRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialMediaUploadPrepareRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.media_upload.execute': {
    dryRun: ({ args, root, deps }) => socialMediaUploadExecuteRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialMediaUploadExecuteRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.final_publish.execute': {
    dryRun: ({ args, root, deps }) => socialFinalPublishExecuteRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialFinalPublishExecuteRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.rollback.evidence_gate': {
    dryRun: socialRollbackEvidenceGateRun,
    execute: socialRollbackEvidenceGateRun,
  },
  'noe.freedom.social.rollback.execute': {
    dryRun: socialRollbackExecuteDryRun,
    execute: socialRollbackExecuteRun,
  },
  'noe.freedom.browser.open': { dryRun: browserOpenDryRun, execute: browserOpenExecute },
  'noe.freedom.browser.state_probe': { dryRun: browserStateProbeDryRun, execute: browserStateProbeExecute },
  'noe.freedom.browser.dom.execute': { dryRun: browserDomDryRun, execute: browserDomExecute },
  'noe.freedom.macos.applescript.run': { dryRun: appleScriptDryRun, execute: appleScriptExecute },
  'noe.freedom.social.draft.create': { dryRun: socialDraftCreateDryRun, execute: socialDraftCreateExecute },
  'noe.freedom.social.draft.list': { dryRun: socialDraftListDryRun, execute: socialDraftListExecute },
  'noe.freedom.social.draft.cancel': { dryRun: socialDraftCancelDryRun, execute: socialDraftCancelExecute },
  'noe.freedom.file.delete': { dryRun: fileDeleteDryRun, execute: fileDeleteExecute },
  'noe.freedom.network.upload': { dryRun: uploadDryRun, execute: uploadExecute },
  'noe.freedom.tool_marketplace.install': { dryRun: marketplaceInstallDryRun, execute: marketplaceInstallExecute },
  'noe.freedom.tool_marketplace.list': { dryRun: marketplaceListDryRun, execute: marketplaceListExecute },
  'noe.freedom.tool_marketplace.disable': { dryRun: marketplaceDisableDryRun, execute: marketplaceDisableExecute },
  'noe.freedom.tool_marketplace.uninstall': { dryRun: marketplaceUninstallDryRun, execute: marketplaceUninstallExecute },
  'noe.freedom.tool_marketplace.execute': { dryRun: marketplaceExecuteDryRun, execute: marketplaceExecute },
};

export function getNoeFreedomAdapter(operation = '') {
  return ADAPTERS[clean(operation, 180)] || null;
}

export async function runNoeFreedomAdapter({ tool, args = {}, root = process.cwd(), deps = {}, realExecute = false } = {}) {
  const adapter = getNoeFreedomAdapter(tool?.operation);
  if (!adapter) return { ok: false, adapter: 'unknown', error: 'freedom_operation_not_implemented' };
  if (!realExecute) return adapter.dryRun({ tool, args, root, deps });
  return adapter.execute({ tool, args, root, deps });
}
