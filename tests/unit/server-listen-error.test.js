import { describe, expect, it, vi } from 'vitest';
import {
  buildServerListenErrorMessage,
  handleServerListenError,
} from '../../src/server/services/server-listen-error.js';

describe('server listen error handling', () => {
  it('builds actionable port conflict and permission messages', () => {
    expect(buildServerListenErrorMessage({ code: 'EADDRINUSE' }, { port: 51835 }))
      .toContain('端口 51835 被占用');
    expect(buildServerListenErrorMessage({ code: 'EACCES' }, { port: 80 }))
      .toContain('端口 80 权限不足');
    expect(buildServerListenErrorMessage({ code: 'OTHER', message: 'boom' }, { port: 51835 }))
      .toBe('❌ server listen 错误: boom');
  });

  it('sets exit code and delays process exit to avoid logger shutdown races', () => {
    const logger = { error: vi.fn() };
    const flushLogs = vi.fn(() => {
      throw new Error('sonic boom is not ready yet');
    });
    const exit = vi.fn();
    const setExitCode = vi.fn();
    const timers = [];
    const setTimeoutFn = vi.fn((fn, ms) => {
      timers.push({ fn, ms });
      return { id: 'timer-1' };
    });

    const result = handleServerListenError({ code: 'EADDRINUSE' }, {
      port: 51835,
      logger,
      flushLogs,
      exit,
      setExitCode,
      setTimeoutFn,
      exitDelayMs: 500,
    });

    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('端口 51835 被占用'));
    expect(flushLogs).toHaveBeenCalledTimes(1);
    expect(setExitCode).toHaveBeenCalledWith(1);
    expect(exit).not.toHaveBeenCalled();
    expect(setTimeoutFn).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(result).toMatchObject({ exitCode: 1, exitDelayMs: 500 });

    timers[0].fn();
    expect(exit).toHaveBeenCalledWith(1);
  });
});
