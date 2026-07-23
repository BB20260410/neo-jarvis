import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NoeSecretBroker } from '../../src/secrets/NoeSecretBroker.js';

describe('NoeSecretBroker', () => {
  it('returns keychain handles without returning raw secret values', () => {
    const broker = new NoeSecretBroker({
      spawnSyncImpl: () => ({ status: 0, stdout: 'sk-unitsecret000000000000000000000000000000', stderr: '' }),
      platform: 'darwin',
    });
    const out = broker.readKeychainMetadata({
      service: 'Neo Jarvis Noe model API keys',
      account: 'MINIMAX_API_KEY',
    });

    expect(out.ok).toBe(true);
    expect(out.secretRef).toBe('keychain:Neo Jarvis Noe model API keys:MINIMAX_API_KEY');
    expect(out.value).toBe('[redacted]');
    expect(out.secretValuesReturned).toBe(false);
    expect(JSON.stringify(out)).not.toContain('sk-unitsecret');
  });

  it('queries keychain metadata without -w so the secret never reaches stdout', () => {
    const calls = [];
    const broker = new NoeSecretBroker({
      spawnSyncImpl: (cmd, args, opts) => {
        calls.push({ cmd, args, opts });
        // 仅元数据查询：security 在 status 0 时把属性 dump 写到 stderr，stdout 为空，绝不含明文
        return { status: 0, stdout: '', stderr: 'keychain: "login.keychain-db"\nclass: "genp"\n' };
      },
      platform: 'darwin',
    });
    const out = broker.readKeychainMetadata({
      service: 'Neo Jarvis Noe model API keys',
      account: 'MINIMAX_API_KEY',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('security');
    expect(calls[0].args).not.toContain('-w');
    expect(calls[0].args).toContain('find-generic-password');
    expect(calls[0].args).toEqual(['find-generic-password', '-a', 'MINIMAX_API_KEY', '-s', 'Neo Jarvis Noe model API keys']);
    // 即便 stdout 为空，凭 status===0 也要判定 present，名实相符
    expect(out.ok).toBe(true);
    expect(out.present).toBe(true);
    expect(out.value).toBe('[redacted]');
    expect(out.secretValuesReturned).toBe(false);
  });

  it('reports absent keychain entries via non-zero status, not stdout content', () => {
    const broker = new NoeSecretBroker({
      spawnSyncImpl: () => ({ status: 44, stdout: '', stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.' }),
      platform: 'darwin',
    });
    const out = broker.readKeychainMetadata({ account: 'MISSING_KEY' });
    expect(out.ok).toBe(false);
    expect(out.present).toBe(false);
    expect(out.secretValuesReturned).toBe(false);
  });

  it('inspects env files as redacted secret refs and public previews only', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-secret-broker-'));
    try {
      writeFileSync(join(root, '.env'), 'TOKEN=tp-unitsecret000000000000000000000000000000\nPUBLIC_NAME=noe\n');
      const broker = new NoeSecretBroker({ platform: 'darwin' });
      const out = broker.inspectEnvFile({ root, path: '.env' });

      expect(out.ok).toBe(true);
      const token = out.entries.find((item) => item.key === 'TOKEN');
      const publicName = out.entries.find((item) => item.key === 'PUBLIC_NAME');
      expect(token.valuePreview).toBe('[redacted]');
      expect(token.secretRef).toContain('env:');
      expect(publicName.valuePreview).toBe('noe');
      expect(JSON.stringify(out)).not.toContain('tp-unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks env path traversal by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-secret-broker-root-'));
    const other = mkdtempSync(join(tmpdir(), 'noe-secret-broker-other-'));
    try {
      writeFileSync(join(other, '.env'), 'TOKEN=secret\n');
      const broker = new NoeSecretBroker({ platform: 'darwin' });
      const out = broker.inspectEnvFile({ root, path: join(other, '.env') });
      expect(out.ok).toBe(false);
      expect(out.error).toBe('env_path_outside_allowed_root');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });
});
