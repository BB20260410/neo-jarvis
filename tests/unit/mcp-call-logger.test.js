// tests/unit/mcp-call-logger.test.js
// Unit tests for src/mcp/learned/call-logger.js (logMcpCall + recentMcpCalls).
// node:fs is mocked so the logger never touches the real ~/.noe-panel directory.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', () => ({
  appendFileSync: vi.fn(),
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  readFileSync: vi.fn(),
}));

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
} from 'node:fs';
import { logMcpCall, recentMcpCalls } from '../../src/mcp/learned/call-logger.js';

describe('mcp/learned/call-logger', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('logMcpCall', () => {
    it('creates the log directory with 0o700 mode when it does not exist', () => {
      // dir missing, file present — avoids the chmod branch (covered separately)
      existsSync.mockImplementation((p) =>
        p.endsWith('.jsonl') ? true : false
      );
      logMcpCall({ serverId: 's', toolName: 't', input: {}, durationMs: 1 });
      expect(mkdirSync).toHaveBeenCalledTimes(1);
      expect(mkdirSync.mock.calls[0][1]).toMatchObject({
        recursive: true,
        mode: 0o700,
      });
    });

    it('does not call mkdir when the log directory already exists', () => {
      existsSync.mockReturnValue(true);
      logMcpCall({ serverId: 's', toolName: 't', input: {}, durationMs: 1 });
      expect(mkdirSync).not.toHaveBeenCalled();
    });

    it('writes a JSONL record with the expected shape and returns it', () => {
      existsSync.mockReturnValue(true);
      const rec = logMcpCall({
        serverId: 'srv-1',
        toolName: 'search',
        input: { q: 'hi' },
        output: { result: [1, 2, 3] },
        durationMs: 25,
        roomId: 'r-1',
        speaker: 'claude',
      });
      expect(appendFileSync).toHaveBeenCalledTimes(1);
      const [, payload] = appendFileSync.mock.calls[0];
      expect(payload.endsWith('\n')).toBe(true);

      const parsed = JSON.parse(payload.trim());
      expect(parsed.serverId).toBe('srv-1');
      expect(parsed.toolName).toBe('search');
      expect(parsed.durationMs).toBe(25);
      expect(parsed.success).toBe(true);
      expect(parsed.error).toBeNull();
      expect(parsed.roomId).toBe('r-1');
      expect(parsed.speaker).toBe('claude');
      expect(parsed.at).toMatch(/T/); // ISO timestamp
      expect(parsed.inputSize).toBeGreaterThan(0);
      expect(parsed.outputSize).toBeGreaterThan(0);

      // returned record mirrors what was persisted
      expect(rec.serverId).toBe('srv-1');
      expect(rec.toolName).toBe('search');
      expect(rec.durationMs).toBe(25);
      expect(rec.success).toBe(true);
    });

    it('reports inputSize/outputSize as 0 when input/output are absent', () => {
      existsSync.mockReturnValue(true);
      const rec = logMcpCall({ serverId: 's', toolName: 't', durationMs: 1 });
      expect(rec.inputSize).toBe(0);
      expect(rec.outputSize).toBe(0);
    });

    it('chmods the file to 0o600 only on creation, not on subsequent writes', () => {
      let fileExists = false;
      existsSync.mockImplementation((p) =>
        p.endsWith('.jsonl') ? fileExists : true
      );

      logMcpCall({ serverId: 's', toolName: 't', input: {}, durationMs: 1 });
      expect(chmodSync).toHaveBeenCalledTimes(1);
      expect(chmodSync.mock.calls[0][1]).toBe(0o600);

      fileExists = true;
      logMcpCall({ serverId: 's', toolName: 't', input: {}, durationMs: 1 });
      expect(chmodSync).toHaveBeenCalledTimes(1); // still 1
    });

    it('marks success=false and stores the error message when error is provided', () => {
      existsSync.mockReturnValue(true);
      const rec = logMcpCall({
        serverId: 's',
        toolName: 't',
        input: {},
        error: 'boom',
        durationMs: 5,
      });
      expect(rec.success).toBe(false);
      expect(rec.error).toBe('boom');

      const [, payload] = appendFileSync.mock.calls[0];
      const parsed = JSON.parse(payload.trim());
      expect(parsed.success).toBe(false);
      expect(parsed.error).toBe('boom');
    });

    it('uses safe defaults for missing serverId/toolName and a non-number durationMs', () => {
      existsSync.mockReturnValue(true);
      const rec = logMcpCall({ input: {} });
      expect(rec.serverId).toBe('unknown');
      expect(rec.toolName).toBe('unknown');
      expect(rec.durationMs).toBeNull();
    });

    it('swallows write errors and still returns the built record', () => {
      existsSync.mockReturnValue(true);
      appendFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });
      const rec = logMcpCall({
        serverId: 's',
        toolName: 't',
        input: {},
        durationMs: 1,
      });
      expect(rec.serverId).toBe('s');
      // no rethrow — caller must not be impacted by a logger failure
    });

    it('logs a warning via console.warn when PANEL_DEBUG is set and write fails', () => {
      existsSync.mockReturnValue(true);
      appendFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const prev = process.env.PANEL_DEBUG;
      process.env.PANEL_DEBUG = '1';
      try {
        logMcpCall({ serverId: 's', toolName: 't', input: {}, durationMs: 1 });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/write failed/);
      } finally {
        process.env.PANEL_DEBUG = prev;
        warn.mockRestore();
      }
    });
  });

  describe('recentMcpCalls', () => {
    it('returns [] when the log file does not exist', () => {
      existsSync.mockReturnValue(false);
      expect(recentMcpCalls(10)).toEqual([]);
    });

    it('reads, parses, and returns the JSONL lines', () => {
      existsSync.mockReturnValue(true);
      const lines = [
        JSON.stringify({ at: 'a', serverId: 's1', toolName: 't1' }),
        JSON.stringify({ at: 'b', serverId: 's2', toolName: 't2' }),
      ].join('\n');
      readFileSync.mockReturnValue(lines);

      const out = recentMcpCalls(10);
      expect(out).toHaveLength(2);
      expect(out[0].serverId).toBe('s1');
      expect(out[1].serverId).toBe('s2');
    });

    it('respects the limit and returns only the last N lines', () => {
      existsSync.mockReturnValue(true);
      const arr = [];
      for (let i = 0; i < 5; i++) arr.push(JSON.stringify({ i }));
      readFileSync.mockReturnValue(arr.join('\n'));

      const out = recentMcpCalls(2);
      expect(out).toHaveLength(2);
      expect(out[0].i).toBe(3);
      expect(out[1].i).toBe(4);
    });

    it('skips lines that fail to parse as JSON', () => {
      existsSync.mockReturnValue(true);
      const content = [
        JSON.stringify({ ok: 1 }),
        'not-json{',
        JSON.stringify({ ok: 2 }),
      ].join('\n');
      readFileSync.mockReturnValue(content);

      const out = recentMcpCalls(10);
      expect(out).toHaveLength(2);
      expect(out[0].ok).toBe(1);
      expect(out[1].ok).toBe(2);
    });

    it('returns [] on read error', () => {
      existsSync.mockReturnValue(true);
      readFileSync.mockImplementation(() => {
        throw new Error('EACCES');
      });
      expect(recentMcpCalls(10)).toEqual([]);
    });
  });
});
