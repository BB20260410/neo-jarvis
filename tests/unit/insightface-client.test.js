import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Writable } from 'stream';
import { EventEmitter } from 'events';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    existsSync: vi.fn(),
  };
});

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    spawn: vi.fn(),
  };
});

import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { InsightFaceClient } from '../../src/identity/InsightFaceClient.js';

// 构造一个最小可用的 child process 替身：stdout/stderr 是 EventEmitter,
// stdin 是可写的 Writable（write 直接 cb, 容纳 stdin.end(payload)）。
function makeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = new Writable({ write(_chunk, _enc, cb) { cb(); } });
  const child = new EventEmitter();
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.kill = vi.fn();
  return { child, stdout, stderr, stdin };
}

describe('InsightFaceClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSync.mockReturnValue(true);
  });

  describe('constructor / 初始化', () => {
    it('使用默认值构造：python / script / timeoutMs=90_000', () => {
      const c = new InsightFaceClient();
      expect(typeof c.python).toBe('string');
      expect(c.python.length).toBeGreaterThan(0);
      expect(typeof c.script).toBe('string');
      expect(c.script.endsWith('insightface-embed.py')).toBe(true);
      expect(c.timeoutMs).toBe(90_000);
    });

    it('读取构造选项', () => {
      const c = new InsightFaceClient({
        python: '/p/bin/python3',
        script: '/tmp/embed.py',
        timeoutMs: 5000,
      });
      expect(c.python).toBe('/p/bin/python3');
      expect(c.script).toBe('/tmp/embed.py');
      expect(c.timeoutMs).toBe(5000);
    });

    it('读取环境变量 NOE_INSIGHTFACE_PYTHON 与 NOE_INSIGHTFACE_TIMEOUT_MS', () => {
      const prevPy = process.env.NOE_INSIGHTFACE_PYTHON;
      const prevMs = process.env.NOE_INSIGHTFACE_TIMEOUT_MS;
      process.env.NOE_INSIGHTFACE_PYTHON = '/env/py';
      process.env.NOE_INSIGHTFACE_TIMEOUT_MS = '12345';
      try {
        const c = new InsightFaceClient();
        expect(c.python).toBe('/env/py');
        expect(c.timeoutMs).toBe(12345);
      } finally {
        if (prevPy === undefined) delete process.env.NOE_INSIGHTFACE_PYTHON;
        else process.env.NOE_INSIGHTFACE_PYTHON = prevPy;
        if (prevMs === undefined) delete process.env.NOE_INSIGHTFACE_TIMEOUT_MS;
        else process.env.NOE_INSIGHTFACE_TIMEOUT_MS = prevMs;
      }
    });

    it('NOE_INSIGHTFACE_TIMEOUT_MS 非数字时回退默认 90_000', () => {
      const prev = process.env.NOE_INSIGHTFACE_TIMEOUT_MS;
      process.env.NOE_INSIGHTFACE_TIMEOUT_MS = 'not-a-number';
      try {
        const c = new InsightFaceClient();
        expect(c.timeoutMs).toBe(90_000);
      } finally {
        if (prev === undefined) delete process.env.NOE_INSIGHTFACE_TIMEOUT_MS;
        else process.env.NOE_INSIGHTFACE_TIMEOUT_MS = prev;
      }
    });
  });

  describe('status()', () => {
    it('python 与 script 都存在时返回 ok=true', () => {
      existsSync.mockReturnValue(true);
      const c = new InsightFaceClient();
      const s = c.status();
      expect(s.ok).toBe(true);
      expect(s.engine).toBe('insightface');
      expect(s.python).toBe(c.python);
      expect(s.script).toBe(c.script);
      expect(typeof s.modelDir).toBe('string');
    });

    it('python 缺失时 ok=false', () => {
      existsSync.mockImplementation((p) => !String(p).includes('python'));
      const c = new InsightFaceClient();
      expect(c.status().ok).toBe(false);
    });

    it('script 缺失时 ok=false', () => {
      existsSync.mockImplementation((p) => !String(p).endsWith('.py'));
      const c = new InsightFaceClient();
      expect(c.status().ok).toBe(false);
    });

    it('模型 .onnx 缺失时 modelReady=false 但 ok 仍可为 true', () => {
      existsSync.mockImplementation((p) => !String(p).endsWith('.onnx'));
      const c = new InsightFaceClient();
      const s = c.status();
      expect(s.modelReady).toBe(false);
      expect(s.ok).toBe(true); // python / script 不以 .onnx 结尾, 仍视为存在
    });
  });

  describe('embedImage()', () => {
    it('runtime 未安装时直接 reject 而不 spawn', async () => {
      existsSync.mockReturnValue(false);
      const c = new InsightFaceClient();
      await expect(c.embedImage('BASE64')).rejects.toThrow('InsightFace runtime not installed');
      expect(spawn).not.toHaveBeenCalled();
    });

    it('happy path：解析 ok JSON 并返回 embedding', async () => {
      existsSync.mockReturnValue(true);
      const { child, stdout } = makeChild();
      spawn.mockReturnValue(child);

      const c = new InsightFaceClient({ timeoutMs: 60_000 });
      const promise = c.embedImage('BASE64DATA');

      expect(spawn).toHaveBeenCalledWith(
        c.python,
        [c.script],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );

      stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, embedding: [0.1, 0.2, 0.3] })));
      child.emit('close', 0);

      const res = await promise;
      expect(res.ok).toBe(true);
      expect(res.embedding).toEqual([0.1, 0.2, 0.3]);
    });

    it('从多行 stdout 中仅取最后一行 JSON', async () => {
      existsSync.mockReturnValue(true);
      const { child, stdout } = makeChild();
      spawn.mockReturnValue(child);
      const c = new InsightFaceClient({ timeoutMs: 60_000 });
      const promise = c.embedImage('BASE64');
      stdout.emit('data', Buffer.from('{"progress":0.5}\n{"ok":true,"embedding":[1,2,3]}\n'));
      child.emit('close', 0);
      const res = await promise;
      expect(res.embedding).toEqual([1, 2, 3]);
    });

    it('cleanImage 拒绝空值 / null / undefined 以及过大输入', async () => {
      existsSync.mockReturnValue(true);
      spawn.mockReturnValue(makeChild().child);
      const c = new InsightFaceClient();
      await expect(c.embedImage('')).rejects.toThrow('image base64 required');
      await expect(c.embedImage(null)).rejects.toThrow('image base64 required');
      await expect(c.embedImage(undefined)).rejects.toThrow('image base64 required');
      await expect(c.embedImage('x'.repeat(12_000_001))).rejects.toThrow('image too large');
    });

    it('stdout 超过 2MB 上限时 reject "too large" 并触发 SIGTERM', async () => {
      existsSync.mockReturnValue(true);
      const { child, stdout } = makeChild();
      spawn.mockReturnValue(child);
      const c = new InsightFaceClient({ timeoutMs: 60_000 });
      const promise = c.embedImage('BASE64');
      stdout.emit('data', Buffer.from('a'.repeat(2_500_000)));
      await expect(promise).rejects.toThrow('InsightFace output too large');
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    });

    it('parsed.ok=false 时使用 parsed.error 作为错误信息', async () => {
      existsSync.mockReturnValue(true);
      const { child, stdout } = makeChild();
      spawn.mockReturnValue(child);
      const c = new InsightFaceClient({ timeoutMs: 60_000 });
      const promise = c.embedImage('BASE64');
      stdout.emit('data', Buffer.from(JSON.stringify({ ok: false, error: 'detection failed' })));
      child.emit('close', 0);
      await expect(promise).rejects.toThrow('detection failed');
    });

    it('stdout 非 JSON 且 stderr 有内容时使用 stderr 首行非空', async () => {
      existsSync.mockReturnValue(true);
      const { child, stdout, stderr } = makeChild();
      spawn.mockReturnValue(child);
      const c = new InsightFaceClient({ timeoutMs: 60_000 });
      const promise = c.embedImage('BASE64');
      stdout.emit('data', Buffer.from('garbage'));
      stderr.emit('data', Buffer.from('first line\nsecond line'));
      child.emit('close', 1);
      await expect(promise).rejects.toThrow('first line');
    });

    it('stdout 非 JSON 且 stderr 为空时使用退出码信息', async () => {
      existsSync.mockReturnValue(true);
      const { child, stdout } = makeChild();
      spawn.mockReturnValue(child);
      const c = new InsightFaceClient({ timeoutMs: 60_000 });
      const promise = c.embedImage('BASE64');
      stdout.emit('data', Buffer.from('garbage'));
      child.emit('close', 42);
      await expect(promise).rejects.toThrow('InsightFace exit 42');
    });

    it('ok 但 embedding 不是数组时 reject', async () => {
      existsSync.mockReturnValue(true);
      const { child, stdout } = makeChild();
      spawn.mockReturnValue(child);
      const c = new InsightFaceClient({ timeoutMs: 60_000 });
      const promise = c.embedImage('BASE64');
      stdout.emit('data', Buffer.from(JSON.stringify({ ok: true, embedding: 'not-an-array' })));
      child.emit('close', 0);
      await expect(promise).rejects.toThrow();
    });

    it('child 触发 error 事件时以同一错误 reject', async () => {
      existsSync.mockReturnValue(true);
      const { child } = makeChild();
      spawn.mockReturnValue(child);
      const c = new InsightFaceClient({ timeoutMs: 60_000 });
      const promise = c.embedImage('BASE64');
      const err = new Error('spawn ENOENT');
      child.emit('error', err);
      await expect(promise).rejects.toBe(err);
    });

    it('settled 守卫：超限 reject 后再次 close 不再二次结算', async () => {
      existsSync.mockReturnValue(true);
      const { child, stdout } = makeChild();
      spawn.mockReturnValue(child);
      const c = new InsightFaceClient({ timeoutMs: 60_000 });
      const promise = c.embedImage('BASE64');
      stdout.emit('data', Buffer.from('a'.repeat(2_500_000)));
      await expect(promise).rejects.toThrow('InsightFace output too large');
      expect(() => child.emit('close', 0)).not.toThrow();
    });
  });
});
