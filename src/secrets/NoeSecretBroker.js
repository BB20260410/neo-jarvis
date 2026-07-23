import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_SECRET_BROKER_SCHEMA_VERSION = 1;

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function hashRef(value = '') {
  return createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24);
}

function pathInside(base, target) {
  const root = resolve(base);
  const next = resolve(target);
  return next === root || next.startsWith(root + sep);
}

function parseEnvText(text = '', { fileRef = 'env' } = {}) {
  const entries = [];
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const raw = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    const secretLike = raw !== redactSensitiveText(raw) || /key|token|secret|password|credential/i.test(key);
    entries.push({
      key: clean(key, 160),
      valuePreview: secretLike ? '[redacted]' : clean(raw, 120),
      secretLike,
      secretRef: secretLike ? `env:${fileRef}:${clean(key, 160)}:${hashRef(raw)}` : '',
      secretValuesReturned: false,
    });
  }
  return entries;
}

export class NoeSecretBroker {
  constructor({
    spawnSyncImpl = spawnSync,
    platform = process.platform,
  } = {}) {
    this.spawnSync = spawnSyncImpl;
    this.platform = platform;
  }

  keychainRef({ account = '', service = 'Neo Jarvis Noe model API keys' } = {}) {
    const safeAccount = clean(account, 200);
    const safeService = clean(service, 240);
    return `keychain:${safeService}:${safeAccount}`;
  }

  readKeychainMetadata({ account = '', service = 'Neo Jarvis Noe model API keys' } = {}) {
    const safeAccount = clean(account, 200);
    const safeService = clean(service, 240);
    if (!safeAccount) return { ok: false, error: 'keychain_account_required' };
    if (this.platform !== 'darwin') return { ok: false, error: 'macos_keychain_unavailable' };
    // 仅查元数据：不带 -w，security 不会把密码明文写到 stdout（防外泄）。
    // 存在性凭退出码判定（status 0 = 命中），属性 dump 走 stderr，不进进程内存/返回值。
    const result = this.spawnSync('security', ['find-generic-password', '-a', safeAccount, '-s', safeService], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const present = result.status === 0;
    return {
      ok: present,
      schemaVersion: NOE_SECRET_BROKER_SCHEMA_VERSION,
      source: 'keychain',
      account: safeAccount,
      service: safeService,
      secretRef: this.keychainRef({ account: safeAccount, service: safeService }),
      present,
      value: '[redacted]',
      secretValuesReturned: false,
      error: present ? '' : clean(result.stderr || `security_exit_${result.status}`, 300),
    };
  }

  inspectEnvFile({ path = '', root = process.cwd(), allowOutsideRoot = false } = {}) {
    const target = resolve(root, clean(path || '.env', 2000));
    if (!allowOutsideRoot && !pathInside(root, target)) {
      return { ok: false, error: 'env_path_outside_allowed_root', path: target };
    }
    if (!existsSync(target)) return { ok: false, error: 'env_file_not_found', path: target };
    const text = readFileSync(target, 'utf8');
    return {
      ok: true,
      schemaVersion: NOE_SECRET_BROKER_SCHEMA_VERSION,
      source: 'env',
      path: target,
      count: parseEnvText(text, { fileRef: hashRef(target) }).length,
      entries: parseEnvText(text, { fileRef: hashRef(target) }),
      secretValuesReturned: false,
    };
  }
}

export const defaultNoeSecretBroker = new NoeSecretBroker();
