#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  NOE_MODEL_KEYCHAIN_SERVICE,
  NOE_PROVIDER_SECRET_PROFILES,
  readMacosKeychainSecret,
} from '../src/secrets/NoeProviderSecrets.js';

export const PROVIDERS = Object.keys(NOE_PROVIDER_SECRET_PROFILES);

function print(line = '') {
  process.stdout.write(`${line}\n`);
}

export function buildSecurityAddGenericPasswordArgs({
  account,
  label,
  service = NOE_MODEL_KEYCHAIN_SERVICE,
} = {}) {
  return [
    'add-generic-password',
    '-U',
    '-s', service,
    '-a', account,
    '-l', `${label} API key`,
    '-j', 'Noe online model API key; value is stored by macOS Keychain and must not be logged.',
    '-T', '/usr/bin/security',
    '-w',
  ];
}

export function findExistingSecretAccountForProfile(profile, {
  keychainReader = readMacosKeychainSecret,
} = {}) {
  const accounts = profile?.keychainAccounts?.length
    ? profile.keychainAccounts
    : profile?.envNames || [];
  for (const account of accounts) {
    const result = keychainReader({ account });
    if (result.ok === true) return { ok: true, account };
  }
  return { ok: false, account: null };
}

export function addSecret({ account, label, spawnSyncImpl = spawnSync }) {
  print('');
  print(`现在存入 ${label}`);
  print(`Keychain service: ${NOE_MODEL_KEYCHAIN_SERVICE}`);
  print(`Keychain account: ${account}`);
  print('security 会直接提示输入密码/密钥；输入不会显示，也不会进入 shell history。取消请 Ctrl+C。');
  const result = spawnSyncImpl('security', buildSecurityAddGenericPasswordArgs({ account, label }), {
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    print(`未成功存入 ${label}（security exit ${result.status ?? 'unknown'}）`);
    return false;
  }
  print(`${label} 已存入 macOS Keychain。`);
  return true;
}

function main() {
  if (process.platform !== 'darwin') {
    print('当前不是 macOS，无法使用 macOS Keychain。请用环境变量注入模型 key。');
    process.exitCode = 1;
    return;
  }
  print('Noe online model Keychain setup');
  print('这会把 Noe 已知线上模型 provider 的 API key 存到 macOS Keychain。');
  print('不会写入仓库、日志、ledger、.env 或聊天。');
  print('');

  let stored = 0;
  let skipped = 0;
  for (const provider of PROVIDERS) {
    const profile = NOE_PROVIDER_SECRET_PROFILES[provider];
    const account = profile.envNames[0];
    const existing = findExistingSecretAccountForProfile(profile);
    if (existing.ok) {
      print(`${profile.label}: Keychain 已存在 ${existing.account}，跳过。需要更新时请在 Keychain Access 删除旧条目后重跑。`);
      skipped += 1;
      continue;
    }
    if (addSecret({ account, label: profile.label })) stored += 1;
  }

  print('');
  print(`完成：stored=${stored}, skipped=${skipped}`);
  print('验证可运行：npm run noe:keys:model:check');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
