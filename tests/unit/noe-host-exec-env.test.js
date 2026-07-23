import { describe, expect, it } from 'vitest';
import { PluginSpawnAdapter } from '../../src/plugin/PluginSpawnAdapter.js';
import {
  buildNoeSafeChildProcessEnv,
  isDangerousHostExecEnvKey,
  isSecretHostExecEnvKey,
  sanitizeNoeHostExecEnv,
} from '../../src/security/NoeHostExecEnv.js';

describe('Noe host exec env sanitizer', () => {
  it('drops process injection variables and secret-shaped env by default', () => {
    const env = {
      PATH: '/usr/bin',
      HOME: '/tmp/noe',
      LANG: 'zh_CN.UTF-8',
      LD_PRELOAD: '/tmp/inject.dylib',
      DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
      NODE_OPTIONS: '--require /tmp/hook.js',
      OPENAI_API_KEY: 'tp-unit-test-redaction-key-00000000000000000000',
      SAFE_CUSTOM: 'ok',
    };
    const out = sanitizeNoeHostExecEnv(env, { allowlist: Object.keys(env) });

    expect(out).toMatchObject({ PATH: '/usr/bin', HOME: '/tmp/noe', LANG: 'zh_CN.UTF-8', SAFE_CUSTOM: 'ok' });
    expect(out).not.toHaveProperty('LD_PRELOAD');
    expect(out).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
    expect(out).not.toHaveProperty('NODE_OPTIONS');
    expect(out).not.toHaveProperty('OPENAI_API_KEY');
    expect(isDangerousHostExecEnvKey('DYLD_INSERT_LIBRARIES')).toBe(true);
    expect(isSecretHostExecEnvKey('OPENAI_API_KEY')).toBe(true);
  });

  it('only preserves secret-shaped env with explicit allowSecrets while still dropping injection variables', () => {
    const out = sanitizeNoeHostExecEnv({
      OPENAI_API_KEY: 'unit-key',
      NODE_OPTIONS: '--require /tmp/hook.js',
    }, {
      allowlist: ['OPENAI_API_KEY', 'NODE_OPTIONS'],
      allowSecrets: true,
    });

    expect(out).toEqual({ OPENAI_API_KEY: 'unit-key' });
  });

  it('builds safe child-process env with UTF-8 overrides but no secret or injection inheritance', () => {
    const out = buildNoeSafeChildProcessEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/noe',
      LANG: 'en_US.UTF-8',
      OPENAI_API_KEY: 'tp-unit-test-redaction-key-00000000000000000000',
      NODE_OPTIONS: '--require /tmp/hook.js',
      DYLD_INSERT_LIBRARIES: '/tmp/inject.dylib',
    }, {
      extraEnv: {
        LANG: 'zh_CN.UTF-8',
        LC_ALL: 'zh_CN.UTF-8',
        SAFE_FLAG: '1',
        GEMINI_API_KEY: 'AIzaUnitSecretValueMustNotInherit',
        LD_PRELOAD: '/tmp/preload.so',
      },
    });

    expect(out).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/tmp/noe',
      LANG: 'zh_CN.UTF-8',
      LC_ALL: 'zh_CN.UTF-8',
      SAFE_FLAG: '1',
    });
    expect(out).not.toHaveProperty('OPENAI_API_KEY');
    expect(out).not.toHaveProperty('GEMINI_API_KEY');
    expect(out).not.toHaveProperty('NODE_OPTIONS');
    expect(out).not.toHaveProperty('DYLD_INSERT_LIBRARIES');
    expect(out).not.toHaveProperty('LD_PRELOAD');
  });

  it('sanitizes PluginSpawnAdapter env even when manifest or opts try to pass secret/injection keys', async () => {
    const adapter = new PluginSpawnAdapter({
      valid: true,
      resolvedBin: process.execPath,
      manifest: {
        id: 'env-dump',
        displayName: 'Env Dump',
        input: { mode: 'stdin' },
        output: { mode: 'stream', parser: 'raw' },
        sandbox: {
          timeoutMs: 5000,
          envWhitelist: ['PATH', 'HOME', 'LANG', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'LD_PRELOAD'],
        },
        commands: [{
          id: 'dump',
          args: ['-e', 'process.stdout.write(JSON.stringify(process.env))'],
        }],
      },
    });

    const result = await adapter.execCommand('dump', {}, {
      env: {
        OPENAI_API_KEY: 'tp-unit-test-redaction-key-00000000000000000000',
        NODE_OPTIONS: '--require /tmp/hook.js',
        LD_PRELOAD: '/tmp/inject.dylib',
      },
    });
    const childEnv = JSON.parse(result.reply);

    expect(childEnv.PATH).toBeTruthy();
    expect(childEnv.LANG).toBeTruthy();
    expect(childEnv).not.toHaveProperty('OPENAI_API_KEY');
    expect(childEnv).not.toHaveProperty('NODE_OPTIONS');
    expect(childEnv).not.toHaveProperty('LD_PRELOAD');
    expect(result.reply).not.toContain('tp-unit-test-redaction-key');
  });
});
