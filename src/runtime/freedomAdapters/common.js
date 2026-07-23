// @ts-check
// 共享底层 util + 常量：被 freedomAdapters 各子模块 import。拆分自 NoeFreedomAdapters.js（纯搬运，行为零改变）。
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { URL } from 'node:url';
import { redactNoeFreedomPayload } from '../../capabilities/NoeFreedomManifest.js';
import { redactSensitiveText } from '../NoeContextScrubber.js';

export function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

export function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value)));
  } catch {
    return {};
  }
}

export function sha256Json(value = {}) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function sha256Text(value = '') {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function redactDiagnosticText(value = '', max = 1000) {
  return clean(value, max)
    .replace(/\b(token|key|secret|password|auth|session|credential|jwt)\s*=\s*[^\s,;&]+/gi, '$1=[redacted]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|tp-[A-Za-z0-9_-]{12,}|AIza[A-Za-z0-9_-]{20,})\b/g, '[redacted]');
}

export function hostFromUrl(value = '') {
  try { return new URL(clean(value, 2000)).hostname.toLowerCase(); } catch { return ''; }
}

export async function runProcess(command, args = [], { cwd = process.cwd(), env = process.env, spawnImpl = spawn } = {}) {
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

export function dryRunPlan({ tool, args = {}, adapter = 'generic', extras = {}, warnings = [] } = {}) {
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

// shell 选择：macOS 用 zsh（本机生产环境）；zsh 不存在时回退 bash（CI ubuntu runner 没有 /bin/zsh，
// 硬编码会 spawn ENOENT → 整条 freedom 执行链 409——CI 跨平台基线抓出的真实可移植性问题）。
// 导出给测试断言 spawn 参数用（测试写死 '/bin/zsh' 在 ubuntu 上同样会挂）。
export const SHELL_BIN = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/bash';
