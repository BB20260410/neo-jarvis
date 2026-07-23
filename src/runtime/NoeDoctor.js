import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { discoverLocalModelProviders } from '../room/NoeLocalModelCouncil.js';
import { detectSherpaSttStatus, detectCosyVoiceStatus } from '../context/NoeSelfKnowledge.js';
import { collectNoePanelRuntimePreflight, compactPanelRuntimePreflight } from './NoePanelRuntimePreflight.js';
import { assessDualWriterRisk, dualWriterToDoctorFinding } from './NoeDualWriterGuard.js';
import { resolveIsolationDbPath } from './NoeIsolationDbPolicy.js';
import {
  resolveNoeLaunchdLabel,
  parseLaunchdPlistLabel,
  buildLaunchdAlignmentReport,
  NOE_CANONICAL_LAUNCHD_LABEL,
} from './NoeLaunchdLabel.js';
import { NoeProcessRegistry, isNeoOwnedCommand } from './NoeProcessRegistry.js';
import path from 'node:path';
import os from 'node:os';

export const NOE_DOCTOR_SCHEMA_VERSION = 1;

function clean(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function rel(root, file) {
  return relative(root, file).replace(/\\/g, '/');
}

function finding(checkId, severity, message, extra = {}) {
  return {
    checkId,
    severity,
    message,
    ...(extra.path ? { path: extra.path } : {}),
    ...(extra.fixHint ? { fixHint: extra.fixHint } : {}),
    ...(extra.data ? { data: extra.data } : {}),
  };
}

function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function defaultCommandRunner(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', cwd: opts.cwd || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
}

function versionMajor(version = process.version) {
  const match = String(version).match(/v?(\d+)/);
  return match ? Number(match[1]) : 0;
}

function checkExists(root, path, label) {
  const full = resolve(root, path);
  if (!existsSync(full)) {
    return finding(`file.exists:${path}`, 'error', `${label || path} missing`, {
      path,
      fixHint: `restore ${path} before running Noe self-evolution`,
    });
  }
  return finding(`file.exists:${path}`, 'info', `${label || path} present`, { path });
}

function classifyGitStatus(statusText = '') {
  const lines = String(statusText || '').slice(0, 40_000).replace(/\r/g, '').split('\n').map((line) => line.trimEnd()).filter(Boolean);
  const groups = {
    modified: [],
    untracked: [],
    staged: [],
    deleted: [],
  };
  for (const line of lines) {
    const code = line.slice(0, 2);
    const file = line.slice(3);
    if (!file) continue;
    if (code[0] !== ' ' && code[0] !== '?') groups.staged.push(file);
    if (code.includes('M')) groups.modified.push(file);
    if (code.includes('D')) groups.deleted.push(file);
    if (code === '??') groups.untracked.push(file);
  }
  return { dirty: lines.length > 0, lines, groups };
}

function checkGit(root, commandRunner) {
  try {
    const top = clean(commandRunner('git', ['rev-parse', '--show-toplevel'], { cwd: root }), 2000);
    const status = commandRunner('git', ['status', '--short'], { cwd: root });
    const classified = classifyGitStatus(status);
    if (resolve(top) !== resolve(root)) {
      return finding('git.root', 'error', `git root mismatch: ${top}`, { fixHint: 'run Noe commands from the real repository root', data: { top } });
    }
    if (classified.dirty) {
      return finding('git.status', 'warn', `worktree has ${classified.lines.length} changed entries`, {
        fixHint: 'classify changes before self-evolution writes or staging',
        data: classified,
      });
    }
    return finding('git.status', 'info', 'worktree clean', { data: classified });
  } catch (e) {
    return finding('git.status', 'warn', `git status unavailable: ${e.message}`, { fixHint: 'run doctor inside a git worktree' });
  }
}

function checkPort(commandRunner, root, port) {
  try {
    const out = commandRunner('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { cwd: root });
    const lines = clean(out, 4000).split('\n').filter(Boolean);
    return finding(`port.listen:${port}`, lines.length > 1 ? 'info' : 'warn', lines.length > 1 ? `port ${port} has a listener` : `port ${port} has no listener`, {
      data: { port, listenerLines: lines.slice(1, 4) },
    });
  } catch {
    return finding(`port.listen:${port}`, 'warn', `port ${port} has no listener or lsof is unavailable`, { data: { port } });
  }
}

function checkPanelRuntimePreflight(commandRunner, root) {
  const report = collectNoePanelRuntimePreflight({ root, commandRunner });
  const compact = compactPanelRuntimePreflight(report);
  if (compact.safeToRestart) {
    return finding('panel.runtime.preflight', 'info', `panel 51835 owned by pid ${compact.pid}`, {
      data: compact,
    });
  }
  if (compact.safeToStart) {
    return finding('panel.runtime.preflight', 'warn', 'panel 51835 is not listening', {
      fixHint: 'start panel with npm start or scripts/restart-panel.mjs when live validation is needed',
      data: compact,
    });
  }
  return finding('panel.runtime.preflight', 'warn', `panel 51835 is not safe to restart automatically: ${compact.blockers.join(', ') || compact.status}`, {
    fixHint: 'inspect PID/cwd/command before touching 51835',
    data: compact,
  });
}

function checkGitignore(root) {
  const file = join(root, '.gitignore');
  if (!existsSync(file)) return finding('secrets.gitignore', 'warn', '.gitignore missing', { fixHint: 'ignore .env and local output artifacts' });
  const text = readFileSync(file, 'utf8');
  const missing = ['.env', '.env.local'].filter((item) => !text.split('\n').some((line) => line.trim() === item));
  if (missing.length) {
    return finding('secrets.gitignore', 'warn', `.gitignore does not explicitly ignore ${missing.join(', ')}`, {
      path: '.gitignore',
      fixHint: 'add local secret files to .gitignore',
    });
  }
  return finding('secrets.gitignore', 'info', 'local secret files are ignored', { path: '.gitignore' });
}

function checkSupplyChain(root) {
  const lockFile = join(root, 'package-lock.json');
  if (!existsSync(lockFile)) {
    return finding('supplyChain.lockfile', 'warn', 'package-lock.json missing', {
      fixHint: 'commit a lockfile so local and packaged Noe use the same dependency graph',
    });
  }
  const lock = readJsonFile(lockFile) || {};
  return finding('supplyChain.lockfile', 'info', `package-lock present (lockfileVersion ${lock.lockfileVersion || 'unknown'})`, {
    path: 'package-lock.json',
  });
}

async function checkLocalModels({ discover, fetchImpl, env, skipNetwork }) {
  if (skipNetwork) {
    return finding('local.models.discovery', 'info', 'local model discovery skipped', {
      fixHint: 'run npm run doctor:noe:models to include LM Studio/Ollama discovery',
    });
  }
  try {
    const discovery = await discover({ fetchImpl, env });
    const modelCount = Array.isArray(discovery.models) ? discovery.models.length : 0;
    const availableProviders = (discovery.providers || []).filter((provider) => provider.available).map((provider) => provider.id);
    if (modelCount < 2) {
      return finding('local.models.discovery', 'warn', `only ${modelCount} local model(s) discovered`, {
        fixHint: 'load at least two local chat models before running local council',
        data: { modelCount, availableProviders, providers: discovery.providers },
      });
    }
    return finding('local.models.discovery', 'info', `${modelCount} local model(s) discovered`, {
      data: { modelCount, availableProviders, recommendedRoles: discovery.recommendedRoles },
    });
  } catch (e) {
    return finding('local.models.discovery', 'warn', `local model discovery failed: ${e.message}`, {
      fixHint: 'check LM Studio/Ollama base URLs and loaded models',
    });
  }
}

// C11 伴生语音服务探活：whisper(8123 STT 兜底)/kokoro(8124 英文 TTS)/cosyvoice(8125 中文断网兜底)。
// 分级原则：该服务在"当前配置下会被用到"才 warn，否则 info——避免没启用的可选档也红灯扰人。
const VOICE_COMPANION_SERVICES = [
  { id: 'whisper', port: 8123, role: 'STT（sherpa 未就位时的主转写）', start: '~/.noe-voice/bin/python scripts/noe-whisper-server.py' },
  { id: 'kokoro', port: 8124, role: '英文 TTS 省配额档', start: '~/.noe-voice/bin/python scripts/noe-kokoro-server.py' },
  { id: 'cosyvoice', port: 8125, role: '中文 TTS 断网兜底', start: '~/.noe-voice/cosyvoice/.venv/bin/python scripts/noe-cosyvoice-server.py 8125 ~/.noe-voice/cosyvoice/pretrained_models/CosyVoice-300M-SFT（显式 NOE_COSYVOICE_ENGINE=cosyvoice3-mlx 才用 CosyVoice3 MLX）' },
  { id: 'qwen-tts', port: 8126, role: '中文 TTS 本地档（志玲 VoiceDesign，seed 锁定）', start: '~/.noe-voice/bin/python scripts/noe-qwen-tts-server.py 8126' },
];

export async function checkVoiceCompanionServices({ fetchImpl = globalThis.fetch, env = process.env, sherpaStatus = detectSherpaSttStatus, cosyStatus = detectCosyVoiceStatus } = {}) {
  const probe = async (port) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2000); // 本机探活非跑模型，短超时合理
      const resp = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: ctrl.signal });
      clearTimeout(t);
      return !!resp.ok;
    } catch { return false; }
  };
  const ups = await Promise.all(VOICE_COMPANION_SERVICES.map((svc) => probe(svc.port)));
  const services = VOICE_COMPANION_SERVICES.map((svc, i) => ({ id: svc.id, port: svc.port, up: ups[i] }));
  const needed = {
    whisper: !sherpaStatus().available,            // sherpa 模型在 → whisper 仅兜底，不起不警
    kokoro: env.NOE_KOKORO === '1',
    'qwen-tts': env.NOE_QWEN_TTS === '1',          // 志玲本地档启用 = 该服务必须在线
    cosyvoice: env.NOE_QWEN_TTS !== '1' && env.NOE_COSYVOICE !== '0' && cosyStatus().available, // 志玲档启用时 cosy 让位，不再要求
  };
  const downNeeded = VOICE_COMPANION_SERVICES.filter((svc, i) => !ups[i] && needed[svc.id]);
  if (!downNeeded.length) {
    const downIdle = services.filter((sv) => !sv.up).map((sv) => sv.id);
    return finding('voice.companions', 'info', downIdle.length ? `伴生语音服务可选档未起：${downIdle.join('/')}（当前配置用不到，不警）` : '伴生语音服务全部在线', { data: { services } });
  }
  return finding('voice.companions', 'warn', `当前配置会用到但没起的伴生语音服务：${downNeeded.map((sv) => `${sv.id}(${sv.port}，${sv.role})`).join('；')}`, {
    fixHint: downNeeded.map((sv) => `${sv.id}: ${sv.start} ${sv.port}`).join(' | '),
    data: { services },
  });
}

/**
 * Launchd label alignment: plist Label vs resolved vs launchctl list.
 * Historical bug: restart-panel used legacy label so production was unsupervised.
 */
function checkLaunchdAlignment(commandRunner, env = process.env) {
  try {
    const home = os.homedir();
    const plistPath = path.join(home, 'Library', 'LaunchAgents', `${NOE_CANONICAL_LAUNCHD_LABEL}.plist`);
    let installedLabel = null;
    if (existsSync(plistPath)) {
      try {
        const text = readFileSync(plistPath, 'utf8');
        installedLabel = parseLaunchdPlistLabel(text);
      } catch {
        installedLabel = null;
      }
    }
    let launchctlLabels = [];
    try {
      const out = commandRunner('launchctl', ['list'], { cwd: process.cwd() });
      launchctlLabels = clean(out, 200_000)
        .split('\n')
        .map((line) => {
          const parts = line.trim().split(/\s+/);
          return parts[parts.length - 1] || '';
        })
        .filter((s) => /noe|panel/i.test(s));
    } catch {
      launchctlLabels = [];
    }
    const resolved = resolveNoeLaunchdLabel({
      env,
      installedLabels: [installedLabel, ...launchctlLabels].filter(Boolean),
    });
    const launchctlHasResolved = launchctlLabels.includes(resolved.label);
    const report = buildLaunchdAlignmentReport({
      resolved,
      installedLabel,
      launchctlHasResolved,
    });
    const severity = report.ok ? 'info' : 'warn';
    return finding('runtime.launchd_alignment', severity, report.ok
      ? `launchd aligned: ${resolved.label}`
      : `launchd misaligned: resolved=${resolved.label} installed=${installedLabel || 'none'} launchctlHas=${launchctlHasResolved}`, {
      fixHint: report.ok ? undefined : `ensure ${plistPath} Label matches restart-panel and launchctl bootstrap/kickstart uses ${NOE_CANONICAL_LAUNCHD_LABEL}`,
      data: { ...report, launchctlLabels: launchctlLabels.slice(0, 20), plistPath },
    });
  } catch (e) {
    return finding('runtime.launchd_alignment', 'info', `launchd_probe_unavailable: ${e?.message || e}`);
  }
}

/**
 * Snapshot neo-owned PPID=1 candidates (report only — no mass kill).
 */
function checkNeoOrphanProcesses(commandRunner, env = process.env, root = process.cwd()) {
  try {
    const out = commandRunner('ps', ['-axo', 'pid=,ppid=,command='], { cwd: process.cwd() });
    const live = clean(out, 500_000).split('\n').map((line) => {
      const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
      if (!m) return null;
      return { pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] };
    }).filter(Boolean);

    const reg = new NoeProcessRegistry({ neoRoots: [root] });
    // Register live neo-looking processes so reconcile can classify PPID=1
    for (const p of live) {
      if (isNeoOwnedCommand(p.cmd, '', [root])) {
        reg.register({ pid: p.pid, ppid: p.ppid, cmd: p.cmd, kind: 'live_scan' });
      }
    }
    const report = reg.reconcile(live);
    const count = report.neoOwnedOrphanProcessCount;
    const companions = report.companionCount || 0;
    const severity = count === 0 ? 'info' : (count > 20 ? 'warn' : 'info');
    return finding('runtime.neo_orphan_processes', severity,
      count === 0
        ? `no failure orphans (companions=${companions})`
        : `neo-owned failure orphans: ${count} (companions=${companions}; precise cleanup only; no mass kill)`,
      {
        data: {
          neoOwnedOrphanProcessCount: count,
          companionCount: companions,
          orphanSample: (report.orphans || []).slice(0, 10).map((o) => ({ pid: o.pid, cmd: String(o.cmd || '').slice(0, 120) })),
          companionSample: (report.companions || []).slice(0, 5).map((o) => ({ pid: o.pid, cmd: String(o.cmd || '').slice(0, 120) })),
          untrackedSample: (report.untrackedNeoOrphans || []).slice(0, 5),
          cleanupPlanTargetCount: reg.planPreciseCleanup(report).targets.length,
        },
      });
  } catch (e) {
    return finding('runtime.neo_orphan_processes', 'info', `orphan_probe_unavailable: ${e?.message || e}`);
  }
}

/**
 * Best-effort dual-writer probe via lsof on panel.db (+ isolation policy note).
 * Inject commandRunner in tests; fail-open to info on tool errors.
 */
function checkDualWriter(commandRunner, env = process.env) {
  try {
    const liveDb = path.join(os.homedir(), '.noe-panel', 'panel.db');
    const dbPath = String(env.PANEL_DB_PATH || liveDb).trim() || liveDb;
    const iso = resolveIsolationDbPath({ port: env.PORT, env, liveDbPath: liveDb });
    let processes = [];
    try {
      const out = commandRunner('lsof', ['-nP', dbPath], { cwd: process.cwd() });
      const lines = clean(out, 20_000).split('\n').filter(Boolean).slice(1); // skip header
      processes = lines.map((line) => {
        const parts = line.trim().split(/\s+/);
        // lsof: COMMAND PID USER FD TYPE ... NAME
        return {
          pid: parts[1],
          cmd: parts[0],
          openFiles: [dbPath],
        };
      }).filter((p) => p.pid);
    } catch {
      processes = [];
    }
    const assessment = assessDualWriterRisk({ dbPath, processes });
    const base = dualWriterToDoctorFinding(assessment);
    if (iso.isolation && iso.rewritten) {
      return {
        ...base,
        data: {
          ...(base.data || {}),
          isolation: iso,
        },
        message: `${base.message}; isolation_policy=${iso.reason}`,
      };
    }
    return base;
  } catch (e) {
    return finding('db.dual_writer', 'info', `dual_writer_probe_unavailable: ${e?.message || e}`);
  }
}

export async function runNoeDoctor({
  root = process.cwd(),
  env = process.env,
  fetchImpl = globalThis.fetch,
  commandRunner = defaultCommandRunner,
  discover = discoverLocalModelProviders,
  skipNetwork = true,
} = {}) {
  const repoRoot = resolve(root);
  const findings = [];
  const packageFile = join(repoRoot, 'package.json');
  const pkg = readJsonFile(packageFile);
  if (!pkg) {
    findings.push(finding('project.package', 'error', 'package.json missing or invalid', { path: 'package.json' }));
  } else {
    findings.push(finding('project.package', pkg.name === 'noe' ? 'info' : 'warn', `package ${pkg.name || 'unknown'}@${pkg.version || '0.0.0'}`, { path: 'package.json' }));
  }
  findings.push(finding('runtime.node', versionMajor(process.version) >= 22 ? 'info' : 'error', `node ${process.version}`, {
    fixHint: versionMajor(process.version) >= 22 ? undefined : 'use Node 22+ before running Noe',
  }));
  findings.push(checkGit(repoRoot, commandRunner));
  findings.push(checkGitignore(repoRoot));
  findings.push(checkSupplyChain(repoRoot));
  for (const path of [
    'src/runtime/NoeDoctor.js',
    'src/runtime/NoePanelRuntimePreflight.js',
    'src/runtime/NoeGatewayProtocol.js',
    'src/runtime/NoeTaskFlowStore.js',
    'src/runtime/NoeLaneQueue.js',
    'src/runtime/NoeContextScrubber.js',
    'src/memory/NoeActiveMemory.js',
    'src/safety/ToolCallGuardrailController.js',
    'src/room/NoeLocalModelCouncil.js',
    'scripts/noe-self-evolution-cycle-assemble.mjs',
    'scripts/noe-consensus-ledger-verify.mjs',
  ]) findings.push(checkExists(repoRoot, path));
  findings.push(checkPort(commandRunner, repoRoot, 51835));
  findings.push(checkPort(commandRunner, repoRoot, 51735));
  findings.push(checkPanelRuntimePreflight(commandRunner, repoRoot));
  findings.push(checkDualWriter(commandRunner, env));
  findings.push(checkLaunchdAlignment(commandRunner, env));
  findings.push(checkNeoOrphanProcesses(commandRunner, env, repoRoot));
  findings.push(await checkLocalModels({ discover, fetchImpl, env, skipNetwork }));
  findings.push(await checkVoiceCompanionServices({ fetchImpl, env }));

  const errors = findings.filter((item) => item.severity === 'error');
  const warnings = findings.filter((item) => item.severity === 'warn');
  return {
    schemaVersion: NOE_DOCTOR_SCHEMA_VERSION,
    ok: errors.length === 0,
    status: errors.length ? 'error' : warnings.length ? 'warn' : 'ok',
    root: repoRoot,
    summary: {
      errors: errors.length,
      warnings: warnings.length,
      info: findings.filter((item) => item.severity === 'info').length,
    },
    findings,
  };
}

export function doctorFindingPath(root, item = {}) {
  return item.path ? rel(root, resolve(root, item.path)) : '';
}
