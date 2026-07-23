import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SherpaSttClient, makeNoeSttClient } from '../../src/voice/SherpaSttClient.js';

// 由若干段(正弦/静音)拼一个 16kHz PCM16 WAV（与 voice-vad.test.js 同款）
function wavFromSegments(segments, sampleRate = 16000) {
  const counts = segments.map((s) => Math.floor(s.seconds * sampleRate));
  const total = counts.reduce((a, b) => a + b, 0);
  const dataSize = total * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  let i = 0;
  segments.forEach((seg, idx) => {
    for (let k = 0; k < counts[idx]; k += 1) {
      const v = seg.freq ? Math.round(Math.sin(2 * Math.PI * seg.freq * k / sampleRate) * (seg.amp ?? 18000)) : 0;
      buf.writeInt16LE(v, 44 + i * 2); i += 1;
    }
  });
  return buf;
}

// 假模型目录：ready() 只查文件存在，touch 空文件即可
function makeModelDirs() {
  const root = mkdtempSync(join(tmpdir(), 'sherpa-test-'));
  const asr = join(root, 'asr');
  const kws = join(root, 'kws');
  mkdirSync(asr); mkdirSync(kws);
  for (const f of ['encoder-epoch-99-avg-1.int8.onnx', 'decoder-epoch-99-avg-1.onnx', 'joiner-epoch-99-avg-1.int8.onnx', 'tokens.txt']) writeFileSync(join(asr, f), '');
  for (const f of ['encoder-epoch-12-avg-2-chunk-16-left-64.int8.onnx', 'decoder-epoch-12-avg-2-chunk-16-left-64.onnx', 'joiner-epoch-12-avg-2-chunk-16-left-64.int8.onnx', 'tokens.txt']) writeFileSync(join(kws, f), '');
  return { root, asr, kws };
}

// 假 addon：记录调用、可编排识别文本/关键词
function fakeAddon({ text = '你好世界', keyword = '' } = {}) {
  const calls = { acceptWaveform: [], inputFinished: 0, decoded: 0, resets: 0 };
  class OnlineRecognizer {
    constructor(config) { this.config = config; }
    createStream() {
      let pending = 2; // 模拟两轮 decode 后出结果
      return {
        acceptWaveform(obj) { calls.acceptWaveform.push(obj); },
        inputFinished() { calls.inputFinished += 1; },
        _next() { return pending-- > 0; },
      };
    }
    isReady(stream) { return stream._next(); }
    decode() { calls.decoded += 1; }
    isEndpoint() { return false; }
    reset() { calls.resets += 1; }
    getResult() { return { text }; }
  }
  class KeywordSpotter {
    constructor(config) { this.config = config; }
    createStream() {
      let pending = 3;
      return {
        acceptWaveform(obj) { calls.acceptWaveform.push(obj); },
        inputFinished() { calls.inputFinished += 1; },
        _next() { return pending-- > 0; },
      };
    }
    isReady(stream) { return stream._next(); }
    decode() { calls.decoded += 1; }
    getResult() { return { keyword }; }
    reset() { calls.resets += 1; }
  }
  return { OnlineRecognizer, KeywordSpotter, calls };
}

describe('SherpaSttClient', () => {
  it('ready()：模型文件缺失 → false；齐全且 addon 可加载 → true', () => {
    const missing = new SherpaSttClient({ modelDir: '/nonexistent/dir', loadAddon: () => fakeAddon() });
    expect(missing.ready()).toBe(false);
    const { asr, kws } = makeModelDirs();
    const ok = new SherpaSttClient({ modelDir: asr, kwsDir: kws, loadAddon: () => fakeAddon() });
    expect(ok.ready()).toBe(true);
    expect(ok.kwsReady()).toBe(true);
  });

  it('ready()：addon 加载抛错（原生依赖坏）→ false 不抛', () => {
    const { asr } = makeModelDirs();
    const c = new SherpaSttClient({ modelDir: asr, loadAddon: () => { throw new Error('no native addon'); } });
    expect(c.ready()).toBe(false);
  });

  it('transcribe：tail padding + inputFinished，返回识别文本（默认关 VAD 预处理防裁渐弱尾音）', async () => {
    const { asr, kws } = makeModelDirs();
    const addon = fakeAddon({ text: ' 帮我查天气 ' });
    const c = new SherpaSttClient({ modelDir: asr, kwsDir: kws, loadAddon: () => addon });
    expect(c.preprocess).toBe(false); // 实测渐弱尾音被 VoiceVad 裁掉丢尾字 → 默认关
    const wav = wavFromSegments([{ freq: 200, seconds: 1.0 }]);
    const text = await c.transcribe(wav);
    expect(text).toBe('帮我查天气'); // trim 过
    // 至少两次 acceptWaveform：正文 + tail padding（最后一段是全 0 静音）
    expect(addon.calls.acceptWaveform.length).toBeGreaterThanOrEqual(2);
    const tail = addon.calls.acceptWaveform.at(-1);
    expect(tail.samples.every((v) => v === 0)).toBe(true);
    expect(addon.calls.inputFinished).toBe(1);
    expect(addon.calls.decoded).toBeGreaterThan(0);
  });

  it('transcribe：preprocess 显式开时仍可用（VoiceVad 钩子保留为可选）', async () => {
    const { asr } = makeModelDirs();
    const addon = fakeAddon({ text: '开了预处理' });
    const c = new SherpaSttClient({ modelDir: asr, loadAddon: () => addon, preprocess: true });
    // 前后带静音的 wav：预处理会裁，但纯函数失败也原样放行——这里只验证整链不炸且返回文本
    const wav = wavFromSegments([{ freq: 0, seconds: 0.5 }, { freq: 200, seconds: 0.8 }, { freq: 0, seconds: 0.5 }]);
    expect(await c.transcribe(wav)).toBe('开了预处理');
  });

  it('transcribe：超过 maxAudioSeconds 拒绝（防同步解码拖死事件循环）', async () => {
    const { asr } = makeModelDirs();
    const c = new SherpaSttClient({ modelDir: asr, loadAddon: () => fakeAddon(), maxAudioSeconds: 1, preprocess: false });
    const wav = wavFromSegments([{ freq: 200, seconds: 2.0 }]);
    await expect(c.transcribe(wav)).rejects.toThrow(/音频过长/);
  });

  it('transcribe：模型未就位 → 明确报错', async () => {
    const c = new SherpaSttClient({ modelDir: '/nonexistent/dir', loadAddon: () => fakeAddon() });
    await expect(c.transcribe(wavFromSegments([{ freq: 200, seconds: 0.5 }]))).rejects.toThrow(/模型未就位/);
  });

  it('createStream：feed/result/finish 流式契约', () => {
    const { asr } = makeModelDirs();
    const c = new SherpaSttClient({ modelDir: asr, loadAddon: () => fakeAddon({ text: '流式结果' }) });
    const s = c.createStream();
    s.feed(new Float32Array(1600), 16000);
    expect(s.result()).toBe('流式结果');
    expect(typeof s.isEndpoint()).toBe('boolean');
    expect(s.finish()).toBe('流式结果');
  });

  it('detectWakeword：命中返回 keyword；keywords 文件不存在时自动写默认"嘿Noe"变体', async () => {
    const { asr, kws, root } = makeModelDirs();
    const kwFile = join(root, 'noe-keywords.txt');
    const c = new SherpaSttClient({ modelDir: asr, kwsDir: kws, keywordsFile: kwFile, loadAddon: () => fakeAddon({ keyword: '嘿Noe' }) });
    const r = await c.detectWakeword(wavFromSegments([{ freq: 200, seconds: 0.6 }]));
    expect(r).toEqual({ spotted: true, keyword: '嘿Noe' });
    expect(existsSync(kwFile)).toBe(true);
    expect(readFileSync(kwFile, 'utf-8')).toContain('@嘿Noe');
    // 未命中
    const c2 = new SherpaSttClient({ modelDir: asr, kwsDir: kws, keywordsFile: kwFile, loadAddon: () => fakeAddon({ keyword: '' }) });
    const r2 = await c2.detectWakeword(wavFromSegments([{ freq: 200, seconds: 0.6 }]));
    expect(r2.spotted).toBe(false);
  });
});

describe('makeNoeSttClient 选择工厂', () => {
  const fakeWhisper = (text = 'whisper 结果') => ({
    async available() { return true; },
    async transcribe() { return text; },
  });

  it('NOE_STT=whisper → null（用默认 LocalSttClient 链路）', () => {
    expect(makeNoeSttClient({ env: { NOE_STT: 'whisper' } })).toBeNull();
  });

  it('auto + sherpa 未就绪 → null（零影响回退）', () => {
    const s = new SherpaSttClient({ modelDir: '/nonexistent', loadAddon: () => fakeAddon() });
    expect(makeNoeSttClient({ env: {}, sherpa: s, whisper: fakeWhisper() })).toBeNull();
  });

  it('NOE_STT=sherpa → 纯 sherpa 实例（强制，便于排查）', () => {
    const s = new SherpaSttClient({ modelDir: '/nonexistent', loadAddon: () => fakeAddon() });
    expect(makeNoeSttClient({ env: { NOE_STT: 'sherpa' }, sherpa: s })).toBe(s);
  });

  it('auto + 就绪 → 组合 client：sherpa 成功直接返回，不碰 whisper', async () => {
    const { asr, kws } = makeModelDirs();
    const s = new SherpaSttClient({ modelDir: asr, kwsDir: kws, loadAddon: () => fakeAddon({ text: 'sherpa 结果' }) });
    let whisperCalled = 0;
    const w = { async available() { return true; }, async transcribe() { whisperCalled += 1; return 'whisper 结果'; } };
    const combo = makeNoeSttClient({ env: {}, sherpa: s, whisper: w, log: () => {} });
    expect(combo).not.toBeNull();
    expect(combo.sherpa).toBe(s); // 暴露给唤醒词端点复用
    const text = await combo.transcribe(wavFromSegments([{ freq: 200, seconds: 0.6 }]));
    expect(text).toBe('sherpa 结果');
    expect(whisperCalled).toBe(0);
  });

  it('auto + 就绪但 sherpa 运行时失败 → 回退 whisper 不哑', async () => {
    const { asr } = makeModelDirs();
    const s = new SherpaSttClient({ modelDir: asr, loadAddon: () => fakeAddon() });
    s.transcribe = async () => { throw new Error('onnx 崩了'); };
    const combo = makeNoeSttClient({ env: {}, sherpa: s, whisper: fakeWhisper('whisper 兜底'), log: () => {} });
    const text = await combo.transcribe(wavFromSegments([{ freq: 200, seconds: 0.6 }]));
    expect(text).toBe('whisper 兜底');
  });
});
