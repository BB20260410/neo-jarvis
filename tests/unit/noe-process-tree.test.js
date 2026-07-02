import { describe, expect, it } from 'vitest';
import { collectNoeProcessTreePids, terminateNoeProcessTree } from '../../src/runtime/NoeProcessTree.js';

describe('NoeProcessTree', () => {
  const ps = () => ({
    stdout: [
      ' 100  1',
      ' 101  100',
      ' 102  101',
      ' 103  100',
      ' 200  1',
      '',
    ].join('\n'),
  });

  it('collects descendants before the root so shutdown can terminate leaf processes first', () => {
    expect(collectNoeProcessTreePids(100, { spawnSyncImpl: ps, platform: 'darwin' })).toEqual([102, 101, 103, 100]);
  });

  it('sends SIGTERM then SIGKILL to the whole process tree', async () => {
    const signals = [];
    const report = await terminateNoeProcessTree(100, {
      spawnSyncImpl: ps,
      platform: 'darwin',
      graceMs: 10,
      killImpl: (pid, signal) => signals.push({ pid, signal }),
      setTimeoutImpl: (fn) => { fn(); return 0; },
    });

    expect(report).toMatchObject({ ok: true, reason: 'terminated', pids: [102, 101, 103, 100] });
    expect(signals).toEqual([
      { pid: 102, signal: 'SIGTERM' },
      { pid: 101, signal: 'SIGTERM' },
      { pid: 103, signal: 'SIGTERM' },
      { pid: 100, signal: 'SIGTERM' },
      { pid: 102, signal: 'SIGKILL' },
      { pid: 101, signal: 'SIGKILL' },
      { pid: 103, signal: 'SIGKILL' },
      { pid: 100, signal: 'SIGKILL' },
    ]);
  });

  it('falls back to the root pid when ps is unavailable', () => {
    expect(collectNoeProcessTreePids(321, {
      spawnSyncImpl: () => { throw new Error('ps down'); },
      platform: 'darwin',
    })).toEqual([321]);
  });
});
