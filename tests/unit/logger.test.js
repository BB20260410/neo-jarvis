import { describe, it, expect, vi } from 'vitest';
import {
  logger,
  child,
  info,
  warn,
  error,
  debug,
  newTraceId,
  flushSync,
  LOG_DIR,
} from '../../src/logger/index.js';

describe('src/logger/index.js', () => {
  describe('LOG_DIR export', () => {
    it('should be a string', () => {
      expect(typeof LOG_DIR).toBe('string');
      expect(LOG_DIR.length).toBeGreaterThan(0);
    });

    it('should point at .noe-panel/logs under home directory', () => {
      expect(LOG_DIR).toContain('.noe-panel');
      expect(LOG_DIR).toContain('logs');
    });
  });

  describe('logger singleton', () => {
    it('should expose pino-style log methods', () => {
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(typeof logger.child).toBe('function');
    });
  });

  describe('child()', () => {
    it('should return a logger-like object with bindings', () => {
      const log = child({ traceId: 'abc-123' });
      expect(log).toBeDefined();
      expect(typeof log.info).toBe('function');
      expect(typeof log.warn).toBe('function');
      expect(typeof log.error).toBe('function');
      expect(typeof log.debug).toBe('function');
    });

    it('should accept no arguments', () => {
      const log = child();
      expect(log).toBeDefined();
      expect(typeof log.info).toBe('function');
    });

    it('should accept undefined bindings', () => {
      const log = child(undefined);
      expect(log).toBeDefined();
      expect(typeof log.info).toBe('function');
    });
  });

  describe('info() helper', () => {
    it('should forward to logger.info with meta as first arg, msg as second', () => {
      const spy = vi.spyOn(logger, 'info').mockImplementation(() => {});
      info('hello world', { feature: 'license' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ feature: 'license' }, 'hello world');
      spy.mockRestore();
    });

    it('should default meta to {} when omitted', () => {
      const spy = vi.spyOn(logger, 'info').mockImplementation(() => {});
      info('plain message');
      expect(spy).toHaveBeenCalledWith({}, 'plain message');
      spy.mockRestore();
    });
  });

  describe('warn() helper', () => {
    it('should forward to logger.warn with meta and msg', () => {
      const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      warn('signature failed', { provider: 'lemon' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ provider: 'lemon' }, 'signature failed');
      spy.mockRestore();
    });

    it('should default meta to {} when omitted', () => {
      const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      warn('just a warning');
      expect(spy).toHaveBeenCalledWith({}, 'just a warning');
      spy.mockRestore();
    });
  });

  describe('error() helper', () => {
    it('should forward to logger.error with meta and msg', () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      error('crashed', { err: 'stack trace' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ err: 'stack trace' }, 'crashed');
      spy.mockRestore();
    });

    it('should default meta to {} when omitted', () => {
      const spy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      error('boom');
      expect(spy).toHaveBeenCalledWith({}, 'boom');
      spy.mockRestore();
    });
  });

  describe('debug() helper', () => {
    it('should forward to logger.debug with meta and msg', () => {
      const spy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      debug('low level detail', { ctx: 'test' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith({ ctx: 'test' }, 'low level detail');
      spy.mockRestore();
    });

    it('should default meta to {} when omitted', () => {
      const spy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      debug('trace');
      expect(spy).toHaveBeenCalledWith({}, 'trace');
      spy.mockRestore();
    });
  });

  describe('newTraceId()', () => {
    it('should return a non-empty string', () => {
      const id = newTraceId();
      expect(typeof id).toBe('string');
      expect(id.length).toBeGreaterThan(0);
    });

    it('should be composed of two base36 segments joined by hyphen', () => {
      const id = newTraceId();
      const parts = id.split('-');
      expect(parts.length).toBe(2);
      expect(parts[0]).toMatch(/^[0-9a-z]+$/);
      expect(parts[1]).toMatch(/^[0-9a-z]+$/);
    });

    it('should return different ids on successive calls (counter increments)', () => {
      const a = newTraceId();
      const b = newTraceId();
      expect(a).not.toBe(b);
    });
  });

  describe('flushSync()', () => {
    it('should not throw when destination is healthy', () => {
      expect(() => flushSync()).not.toThrow();
    });
  });
});
