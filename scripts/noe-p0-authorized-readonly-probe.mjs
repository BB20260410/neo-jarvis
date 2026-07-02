#!/usr/bin/env node
// @ts-check
// Authorized read-only P0 probe harness.
//
// Default mode is plan/drill only: no owner token read and no protected live request.
// Live authorized mode requires --live-authorized plus --ack-read-owner-token,
// NOE_ACK_READ_OWNER_TOKEN=1, or a standing autonomy grant.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';
import {
  evaluateNoePolicyFileWrite,
  evaluateNoePolicyShellMutation,
} from '../src/security/NoePolicyFileGuard.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_BASE_URL = process.env.NOE_PANEL_URL || 'http://127.0.0.1:51835';
const OUT_DIR = process.env.NOE_P0_AUTH_READONLY_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_P0_AUTH_READONLY_BASENAME || 'p0-authorized-readonly-probe-2026-06-15';
const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

const READONLY_PROBES = [
  {
    id: 'agent_runs_readonly',
    path: '/api/agent-runs?limit=1',
    p0Files: ['src/agents/AgentRunStore.js', 'src/agents/AgentRunVerificationExecutor.js'],
    summaryKind: 'agentRuns',
    proofTarget: 'authorized route can list run count without exporting timeline/body',
  },
  {
    id: 'activity_readonly',
    path: '/api/activity?limit=1',
    p0Files: ['src/audit/ActivityLog.js'],
    summaryKind: 'activity',
    proofTarget: 'authorized route can report event count without exporting event body',
  },
  {
    id: 'agent_registry_readonly',
    path: '/api/agent-registry',
    p0Files: ['src/agents/AgentSkillRegistry.js'],
    summaryKind: 'agentRegistry',
    proofTarget: 'authorized route can expose registry counts without classification POST',
  },
  {
    id: 'commands_discover_readonly',
    path: '/api/noe/commands/discover?limit=1',
    p0Files: ['src/capabilities/NoeCommandSurface.js'],
    summaryKind: 'commands',
    proofTarget: 'authorized discovery route can report command counts without executing tools',
  },
  {
    id: 'research_status_readonly',
    path: '/api/noe/research/status',
    p0Files: ['src/research/WebSearch.js'],
    summaryKind: 'researchStatus',
    proofTarget: 'authorized status route can report provider readiness without search/fetch',
  },
];

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function parseArgs(argv = process.argv.slice(2), env = process.env) {
  const out = {
    baseUrl: env.NOE_PANEL_URL || DEFAULT_BASE_URL,
    timeoutMs: Number(env.NOE_P0_AUTH_PROBE_TIMEOUT_MS || 3000),
    liveAuthorized: false,
    explicitAckReadOwnerToken: env.NOE_ACK_READ_OWNER_TOKEN === '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') out.baseUrl = argv[++i] || out.baseUrl;
    else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if (arg.startsWith('--timeout-ms=')) out.timeoutMs = Number(arg.slice('--timeout-ms='.length)) || out.timeoutMs;
    else if (arg === '--live-authorized') out.liveAuthorized = true;
    else if (arg === '--ack-read-owner-token') out.explicitAckReadOwnerToken = true;
  }
  out.baseUrl = String(out.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  out.timeoutMs = Number.isFinite(out.timeoutMs) && out.timeoutMs > 0 ? out.timeoutMs : 3000;
  return out;
}

function localBaseUrl(rawUrl = DEFAULT_BASE_URL) {
  const url = new URL(rawUrl);
  if (!LOCAL_HOSTS.has(url.hostname)) throw new Error(`refusing non-local probe host: ${url.hostname}`);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`refusing unsupported probe protocol: ${url.protocol}`);
  return url;
}

function joinUrl(base, path) {
  const url = new URL(base.href);
  const [pathname, ...query] = String(path || '').split('?');
  url.pathname = pathname || '/';
  url.search = query.length ? `?${query.join('?')}` : '';
  return url;
}

function statusKind(status) {
  if (status === 0) return 'request_failed';
  if (status >= 200 && status < 300) return 'authorized_readonly_ok';
  if (status === 401 || status === 403) return 'auth_failed_or_missing';
  if (status === 404) return 'route_not_registered_or_wrong_path';
  if (status >= 500) return 'route_reached_server_error';
  return 'route_reached_unexpected_status';
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function summarizePayload(kind, payload = {}) {
  if (kind === 'agentRuns') {
    const runs = arr(payload.runs);
    const statusCounts = {};
    for (const run of runs) {
      const status = String(run?.status || 'unknown');
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
    return { ok: payload.ok === true, runCount: runs.length, statusCounts };
  }
  if (kind === 'activity') {
    return { ok: payload.ok === true, count: safeNumber(payload.count, arr(payload.events).length) };
  }
  if (kind === 'agentRegistry') {
    const counts = payload.counts || {};
    return {
      ok: payload.ok === true,
      profiles: safeNumber(counts.profiles),
      rules: safeNumber(counts.rules),
      installedSkills: safeNumber(counts.installedSkills),
      missingBoundSkills: safeNumber(counts.missingBoundSkills),
      policyOverrides: arr(payload.policyOverrides).length,
    };
  }
  if (kind === 'commands') {
    return {
      ok: payload.ok === true,
      schemaVersion: payload.schemaVersion || '',
      count: safeNumber(payload.count),
      visibleCommands: arr(payload.visibleCommands).length,
      hiddenCommands: arr(payload.hiddenCommands).length,
      searchResults: arr(payload.search?.results || payload.search).length,
    };
  }
  if (kind === 'researchStatus') {
    const clone = payload && typeof payload === 'object' ? payload : {};
    return {
      ok: clone.ok === true,
      mode: String(clone.mode || clone.provider || clone.source || ''),
      configured: clone.configured === true || clone.available === true || clone.ready === true,
      providerKeys: Object.keys(clone)
        .filter((key) => !/key|token|secret|credential/i.test(key))
        .sort()
        .slice(0, 20),
    };
  }
  return { ok: payload.ok === true };
}

function liveOwnerToken({ authorized = false, env = process.env } = {}) {
  if (!authorized) {
    return {
      token: '',
      source: 'not_loaded_policy_requires_ack',
      policyBlocked: true,
      reason: 'live owner-token access requires --live-authorized plus explicit ack or standing autonomy grant',
    };
  }
  if (env.NOE_OWNER_TOKEN) return { token: String(env.NOE_OWNER_TOKEN).trim(), source: 'env', policyBlocked: false, reason: '' };
  const tokenPath = join(homedir(), '.noe-panel', 'owner-token.txt');
  if (!existsSync(tokenPath)) return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not found' };
  try {
    return { token: readFileSync(tokenPath, 'utf8').trim(), source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: '' };
  } catch {
    return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not readable' };
  }
}

async function fetchJsonSummary({ base, probe, token, fetchFn = globalThis.fetch, timeoutMs = 3000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(250, timeoutMs));
  try {
    const response = await fetchFn(joinUrl(base, probe.path), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Panel-Owner-Token': token,
      },
      signal: controller.signal,
    });
    const status = Number(response?.status) || 0;
    let summary = null;
    if (status >= 200 && status < 300 && typeof response?.json === 'function') {
      const payload = await response.json();
      summary = summarizePayload(probe.summaryKind, payload);
    }
    return { status, statusKind: statusKind(status), summary, error: '' };
  } catch (e) {
    return { status: 0, statusKind: 'request_failed', summary: null, error: String(e?.name || e?.message || e || 'request_failed').slice(0, 160) };
  } finally {
    clearTimeout(timer);
  }
}

function runPolicyGuardDrill() {
  const root = ROOT;
  const home = '/tmp/noe-p0-policy-guard-home';
  const env = {
    HOME: home,
    NOE_HOME: `${home}/.noe`,
    NOE_PANEL_HOME: `${home}/.noe-panel`,
  };
  const protectedWrite = evaluateNoePolicyFileWrite({
    path: '${NOE_PANEL_HOME}/exec-policy.json',
    operation: 'file.write',
    root,
    cwd: root,
    env,
  });
  const normalWrite = evaluateNoePolicyFileWrite({
    path: 'tmp/noe-normal-note.txt',
    operation: 'file.write',
    root,
    cwd: root,
    env,
  });
  const protectedShell = evaluateNoePolicyShellMutation({
    command: 'sed',
    args: ['-i', 's/a/b/', '${NOE_PANEL_HOME}/exec-policy.json'],
    root,
    cwd: root,
    env,
  });
  const readShell = evaluateNoePolicyShellMutation({
    command: 'cat',
    args: ['${NOE_PANEL_HOME}/exec-policy.json'],
    root,
    cwd: root,
    env,
  });
  return {
    ok: protectedWrite.blocked === true
      && normalWrite.blocked === false
      && protectedShell.blocked === true
      && readShell.blocked === false,
    p0Files: ['src/security/NoePolicyFileGuard.js'],
    checks: {
      protectedWriteBlocked: protectedWrite.blocked === true,
      normalWriteAllowed: normalWrite.blocked === false,
      protectedShellBlocked: protectedShell.blocked === true,
      readShellAllowed: readShell.blocked === false,
    },
    secretValuesReturned: false,
  };
}

async function runAuthorizedReadonlyProbe({
  argv = process.argv.slice(2),
  env = process.env,
  fetchFn = globalThis.fetch,
} = {}) {
  const args = parseArgs(argv, env);
  const base = localBaseUrl(args.baseUrl);
  const authorization = args.liveAuthorized
    ? resolveOwnerTokenAuthorization({
      explicitAck: args.explicitAckReadOwnerToken,
      scope: 'live-protected-api:call',
      env,
    })
    : {
      authorized: false,
      mode: 'plan_only',
      source: 'default_plan_only',
      scope: 'live-protected-api:call',
      reason: 'pass --live-authorized plus explicit ack or standing grant to run protected GET probes',
      secretValueReturned: false,
    };
  const tokenPolicy = liveOwnerToken({ authorized: authorization.authorized, env });
  const tokenReady = Boolean(tokenPolicy.token && !tokenPolicy.policyBlocked);
  const probes = [];
  for (const probe of READONLY_PROBES) {
    if (!args.liveAuthorized || !tokenReady) {
      probes.push({
        id: probe.id,
        method: 'GET',
        path: probe.path,
        p0Files: probe.p0Files,
        proofTarget: probe.proofTarget,
        status: null,
        statusKind: args.liveAuthorized ? 'skipped_missing_authorized_token' : 'skipped_plan_only',
        summary: null,
        error: '',
      });
      continue;
    }
    const result = await fetchJsonSummary({
      base,
      probe,
      token: tokenPolicy.token,
      fetchFn,
      timeoutMs: args.timeoutMs,
    });
    probes.push({
      id: probe.id,
      method: 'GET',
      path: probe.path,
      p0Files: probe.p0Files,
      proofTarget: probe.proofTarget,
      status: result.status,
      statusKind: result.statusKind,
      summary: result.summary,
      error: result.error,
    });
  }
  const policyGuardDrill = runPolicyGuardDrill();
  const authorizedOk = probes.filter((probe) => probe.statusKind === 'authorized_readonly_ok');
  const provenFiles = new Set(authorizedOk.flatMap((probe) => probe.p0Files));
  if (policyGuardDrill.ok) provenFiles.add('src/security/NoePolicyFileGuard.js');
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    root: ROOT,
    baseUrl: `${base.protocol}//${base.host}`,
    mode: args.liveAuthorized ? 'live_authorized_readonly' : 'plan_only_with_policy_guard_drill',
    authorization: {
      authorized: authorization.authorized === true,
      mode: authorization.mode || '',
      source: authorization.source || '',
      scope: authorization.scope || '',
      reason: authorization.reason || '',
      grantId: authorization.grantId || '',
      secretValueReturned: false,
    },
    tokenPolicy: {
      loaded: tokenReady,
      source: tokenPolicy.source || '',
      policyBlocked: tokenPolicy.policyBlocked === true,
      reason: tokenPolicy.reason || '',
      secretValueReturned: false,
    },
    policy: {
      defaultNoOwnerTokenRead: true,
      liveRequiresExplicitAuthorizedMode: true,
      readOnlyGetOnly: true,
      localHostOnly: true,
      noPostRequests: true,
      noResponseBodiesStored: true,
      summariesOnly: true,
      noDbWrites: true,
      noModelCalls: true,
      noExternalNetworkCalls: true,
      noSecretValuesReturned: true,
    },
    summary: {
      protectedReadProbes: probes.length,
      executedProtectedReadProbes: probes.filter((probe) => probe.status !== null).length,
      authorizedReadonlyOk: authorizedOk.length,
      p0FilesWithAuthorizedReadonlySummaryOrPolicyDrill: provenFiles.size,
      p0FilesStillMissingBusinessProof: ['src/agents/AgentRunStore.js', 'src/agents/AgentRunVerificationExecutor.js', 'src/audit/ActivityLog.js', 'src/agents/AgentSkillRegistry.js', 'src/capabilities/NoeCommandSurface.js', 'src/research/WebSearch.js', 'src/security/NoePolicyFileGuard.js']
        .filter((file) => !provenFiles.has(file)),
      policyGuardDrillOk: policyGuardDrill.ok,
    },
    probes,
    policyGuardDrill,
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function renderMarkdown(report, jsonPath) {
  const rows = report.probes.map((probe) => [
    probe.id,
    probe.method,
    `\`${probe.path}\``,
    probe.status === null ? '-' : String(probe.status),
    probe.statusKind,
    probe.summary ? `\`${JSON.stringify(probe.summary).replaceAll('|', '\\|')}\`` : '-',
    probe.p0Files.map((file) => `\`${file}\``).join('<br>'),
  ]);
  return [
    '# Neo P0 Authorized Readonly Probe',
    '',
    `Generated: ${report.generatedAt}`,
    `Mode: ${report.mode}`,
    `Base URL: \`${report.baseUrl}\``,
    '',
    '## Summary',
    '',
    `- protected read probes: ${report.summary.protectedReadProbes}`,
    `- executed protected read probes: ${report.summary.executedProtectedReadProbes}`,
    `- authorized readonly ok: ${report.summary.authorizedReadonlyOk}`,
    `- P0 files with authorized summary or policy drill: ${report.summary.p0FilesWithAuthorizedReadonlySummaryOrPolicyDrill}/7`,
    `- P0 files still missing business proof: ${report.summary.p0FilesStillMissingBusinessProof.map((file) => `\`${file}\``).join(', ') || 'none'}`,
    `- policy guard drill ok: ${report.summary.policyGuardDrillOk}`,
    `- token loaded: ${report.tokenPolicy.loaded}; authorization mode: ${report.authorization.mode || report.mode}`,
    '',
    '## Protected GET Probes',
    '',
    mdTable([
      ['id', 'method', 'path', 'status', 'status kind', 'summary', 'P0 files'],
      ['---', '---', '---', '---:', '---', '---', '---'],
      ...rows,
    ]),
    '',
    '## Policy Guard Drill',
    '',
    `- ok: ${report.policyGuardDrill.ok}`,
    `- checks: \`${JSON.stringify(report.policyGuardDrill.checks)}\``,
    '',
    '## Interpretation',
    '',
    '- Default mode does not read owner token and does not call protected live APIs. It only records the exact authorized read-only probes to run later and executes a local policy-guard drill.',
    '- Live authorized mode stores only summaries such as counts/status buckets. It does not store response bodies, run POST requests, perform searches, or call models.',
    '',
    '## JSON',
    '',
    `Full output is in \`${jsonPath.replace(`${ROOT}/`, '')}\`. It stores probe status and summaries only.`,
  ].join('\n');
}

function writeReport(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export {
  parseArgs,
  runAuthorizedReadonlyProbe,
  runPolicyGuardDrill,
  summarizePayload,
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runAuthorizedReadonlyProbe();
  const paths = writeReport(report);
  console.log(JSON.stringify({
    ok: true,
    generatedAt: report.generatedAt,
    mode: report.mode,
    executedProtectedReadProbes: report.summary.executedProtectedReadProbes,
    p0FilesWithAuthorizedReadonlySummaryOrPolicyDrill: report.summary.p0FilesWithAuthorizedReadonlySummaryOrPolicyDrill,
    policyGuardDrillOk: report.summary.policyGuardDrillOk,
    paths,
  }, null, 2));
}
