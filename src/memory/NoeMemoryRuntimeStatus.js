// @ts-check

import { spawnSync } from 'node:child_process';

const DEFAULT_ALLOWED_ENV_KEYS = [
  'PORT',
  'PANEL_HOST',
  'NOE_MEMORY_EMBED',
  'NOE_MEMORY_EMBED_MODEL',
  'NOE_MEMORY_EMBED_PROVIDER',
  'NOE_MEMORY_EMBED_BASEURL',
  'NOE_DREAM',
  'NOE_DREAM_CONSOLIDATION',
  'NOE_DREAM_EPISODES',
  'NOE_EPISODE_SUBLIMATION',
  'NOE_MEMORY_GC',
  'NOE_NIGHTLY_REFLECTION',
  'NOE_PERSONALITY_DATASET',
  'NOE_SFT_DATASET',
];

function run(spawnSyncImpl, cmd, args) {
  try {
    return spawnSyncImpl(cmd, args, { encoding: 'utf8' }) || {};
  } catch (error) {
    return { status: 1, stdout: '', stderr: String(error?.message || error) };
  }
}

function uniquePids(stdout = '') {
  return Array.from(new Set(String(stdout || '')
    .split(/\s+/)
    .map((item) => Number(item.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0)));
}

function parseCwd(stdout = '') {
  const line = String(stdout || '').split(/\r?\n/).find((item) => item.startsWith('n'));
  return line ? line.slice(1) : '';
}

function parseCommand(stdout = '') {
  return String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || '';
}

function extractAllowedEnv(stdout = '', allowedEnvKeys = DEFAULT_ALLOWED_ENV_KEYS) {
  const text = String(stdout || '');
  const env = {};
  for (const key of allowedEnvKeys) {
    const escaped = String(key).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`(?:^|\\s)${escaped}=([^\\s]+)`));
    if (match) env[key] = match[1].slice(0, 200);
  }
  return env;
}

export function collectNoeMemoryRuntimeStatus({
  port = 51835,
  expectedCwd = '/Users/hxx/Desktop/Neo 贾维斯',
  spawnSyncImpl = spawnSync,
  allowedEnvKeys = DEFAULT_ALLOWED_ENV_KEYS,
} = {}) {
  const pidResult = run(spawnSyncImpl, 'lsof', [`-tiTCP:${Number(port)}`, '-sTCP:LISTEN']);
  const pids = uniquePids(pidResult.stdout);
  const listeners = pids.map((pid) => {
    const cwdResult = run(spawnSyncImpl, 'lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']);
    const commandResult = run(spawnSyncImpl, 'ps', ['-p', String(pid), '-o', 'command=']);
    const envResult = run(spawnSyncImpl, 'ps', ['eww', '-p', String(pid)]);
    const cwd = parseCwd(cwdResult.stdout);
    return {
      pid,
      cwd,
      cwdMatchesExpected: Boolean(expectedCwd && cwd === expectedCwd),
      command: parseCommand(commandResult.stdout).slice(0, 240),
      env: extractAllowedEnv(envResult.stdout, allowedEnvKeys),
    };
  });
  const primary = listeners.find((item) => item.cwdMatchesExpected) || listeners[0] || null;
  return {
    ok: Boolean(primary),
    port: Number(port),
    listenerCount: listeners.length,
    pids,
    primaryPid: primary?.pid || null,
    primaryCwd: primary?.cwd || '',
    primaryCwdMatchesExpected: Boolean(primary?.cwdMatchesExpected),
    env: primary?.env || {},
    listeners,
    policy: {
      allowedEnvKeys,
      fullEnvironmentCaptured: false,
      secretValuesCaptured: false,
    },
  };
}

export const NOE_MEMORY_RUNTIME_ALLOWED_ENV_KEYS = DEFAULT_ALLOWED_ENV_KEYS.slice();
