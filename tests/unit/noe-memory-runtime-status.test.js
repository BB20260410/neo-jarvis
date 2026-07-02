import { describe, expect, it } from 'vitest';
import { collectNoeMemoryRuntimeStatus } from '../../src/memory/NoeMemoryRuntimeStatus.js';

describe('collectNoeMemoryRuntimeStatus', () => {
  it('reads only allowlisted live panel environment keys', () => {
    const calls = [];
    const spawnSyncImpl = (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === 'lsof' && args[0] === '-tiTCP:51835') return { stdout: '101\n' };
      if (cmd === 'lsof' && args.includes('-Fn')) return { stdout: 'p101\nn~/Desktop/Neo 贾维斯\n' };
      if (cmd === 'ps' && args.includes('command=')) return { stdout: 'node server.js\n' };
      if (cmd === 'ps' && args[0] === 'eww') {
        return {
          stdout: [
            'PID TT STAT TIME COMMAND',
            '101 ?? S 0:01 node server.js PORT=51835 PANEL_HOST=127.0.0.1',
            'NOE_MEMORY_EMBED=ollama NOE_MEMORY_EMBED_MODEL=qwen3-embedding:0.6b',
            'NOE_DREAM=1 NOE_DREAM_EPISODES=1 NOE_MEMORY_GC=1 SECRET_TOKEN=should_not_leak',
          ].join(' '),
        };
      }
      return { stdout: '' };
    };

    const report = collectNoeMemoryRuntimeStatus({ spawnSyncImpl });

    expect(report).toMatchObject({
      ok: true,
      primaryPid: 101,
      primaryCwdMatchesExpected: true,
      env: {
        PORT: '51835',
        PANEL_HOST: '127.0.0.1',
        NOE_MEMORY_EMBED: 'ollama',
        NOE_MEMORY_EMBED_MODEL: 'qwen3-embedding:0.6b',
        NOE_DREAM: '1',
        NOE_DREAM_EPISODES: '1',
        NOE_MEMORY_GC: '1',
      },
    });
    expect(report.env.SECRET_TOKEN).toBeUndefined();
    expect(report.policy.fullEnvironmentCaptured).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('reports no listener without throwing', () => {
    const report = collectNoeMemoryRuntimeStatus({
      spawnSyncImpl: () => ({ status: 1, stdout: '' }),
    });

    expect(report.ok).toBe(false);
    expect(report.listenerCount).toBe(0);
    expect(report.env).toEqual({});
  });
});
