import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { OcrClient } from '../../src/vision/OcrClient.js';
import { VisionSession } from '../../src/vision/VisionSession.js';

// 假子进程：按编排回放 stdout/exit（不真 spawn python）
function fakeSpawn({ stdout = '', stderr = '', code = 0 } = {}) {
  const calls = { stdin: '' };
  const spawnFn = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (data) => { calls.stdin = data; queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr));
      child.emit('close', code);
    }); } };
    return child;
  };
  return { spawnFn, calls };
}

// status() 查 python/script 都存在——用本测试文件自己当假 python 路径（肯定存在）
const EXISTING = fileURLToPath(import.meta.url);

describe('OcrClient', () => {
  it('recognize：stdin 喂 base64，解析 stdout JSON 返回行', async () => {
    const payload = JSON.stringify({ ok: true, text: '你好\nWorld', lines: [{ text: '你好', score: 0.98, box: [[0, 0], [1, 0], [1, 1], [0, 1]] }, { text: 'World', score: 0.95, box: [[0, 2], [1, 2], [1, 3], [0, 3]] }], count: 2 });
    const { spawnFn, calls } = fakeSpawn({ stdout: payload });
    const c = new OcrClient({ python: EXISTING, script: EXISTING, spawnFn });
    const r = await c.recognize(Buffer.from('fake-png'));
    expect(r.count).toBe(2);
    expect(r.text).toBe('你好\nWorld');
    expect(JSON.parse(calls.stdin).image).toBe(Buffer.from('fake-png').toString('base64'));
  });

  it('recognize：python 报错 JSON → reject 带原因', async () => {
    const { spawnFn } = fakeSpawn({ stdout: JSON.stringify({ ok: false, error: 'image decode failed' }), code: 1 });
    const c = new OcrClient({ python: EXISTING, script: EXISTING, spawnFn });
    await expect(c.recognize(Buffer.from('x'))).rejects.toThrow('image decode failed');
  });

  it('recognize：非 JSON 输出 → 用 stderr/exit code 报错', async () => {
    const { spawnFn } = fakeSpawn({ stdout: 'Traceback ...', stderr: 'ModuleNotFoundError: rapidocr', code: 1 });
    const c = new OcrClient({ python: EXISTING, script: EXISTING, spawnFn });
    await expect(c.recognize(Buffer.from('x'))).rejects.toThrow(/ModuleNotFoundError/);
  });

  it('runtime 未安装（python 路径不存在）→ 明确报错', async () => {
    const c = new OcrClient({ python: '/nonexistent/python', script: EXISTING, spawnFn: () => { throw new Error('不应该走到 spawn'); } });
    await expect(c.recognize(Buffer.from('x'))).rejects.toThrow(/OCR runtime 未安装/);
    expect(c.status().ok).toBe(false);
  });

  it('空图 / 超大图 → 拒绝', async () => {
    const c = new OcrClient({ python: EXISTING, script: EXISTING, spawnFn: () => { throw new Error('不应该走到 spawn'); } });
    await expect(c.recognize('')).rejects.toThrow('image required');
    await expect(c.recognize('x'.repeat(30_000_001))).rejects.toThrow('image too large');
  });
});

describe('VisionSession.ocr', () => {
  it('不传 image → 现截屏喂 OCR；传 image → 直接读', async () => {
    let captured = 0;
    const session = new VisionSession({
      capturer: { capture: async () => { captured += 1; return Buffer.from('screen-png'); } },
      vlmClient: { describe: async () => '' },
      ocrClient: { recognize: async (img) => ({ ok: true, text: 'OCR:' + img.toString(), lines: [], count: 0 }) },
    });
    const fromScreen = await session.ocr();
    expect(captured).toBe(1);
    expect(fromScreen.text).toBe('OCR:screen-png');
    expect(fromScreen.source).toBe('screen');
    const fromImage = await session.ocr({ image: Buffer.from('my-img') });
    expect(captured).toBe(1); // 没有再截屏
    expect(fromImage.text).toBe('OCR:my-img');
    expect(fromImage.source).toBe('attachment');
  });

  it('ocrClient 缺失 → 明确报错不影响其他能力', async () => {
    const session = new VisionSession({
      capturer: { capture: async () => Buffer.from('x') },
      vlmClient: { describe: async () => '' },
      ocrClient: false, // 显式关掉（默认会建真 OcrClient）
    });
    session.ocrClient = null;
    await expect(session.ocr()).rejects.toThrow('OCR 未配置');
  });
});
