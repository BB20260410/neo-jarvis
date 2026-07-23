// 神经网络 VAD（接本地 silero 模型，借鉴 ricky0123/vad）：判真人声而非比响度，噪声段不进 STT。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SileroVadClient, makeSileroVad } from '../../src/voice/SileroVadClient.js';
import { VoiceSession } from '../../src/voice/VoiceSession.js';

function wav16k(seconds, freq, amp = 18000) {
  const sr = 16000; const n = Math.floor(seconds * sr); const dataSize = n * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataSize, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24); buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(freq ? Math.round(Math.sin(2 * Math.PI * freq * i / sr) * amp) : 0, 44 + i * 2);
  return buf;
}

function modelFile() {
  const f = join(mkdtempSync(join(tmpdir(), 'silero-')), 'silero_vad.onnx');
  writeFileSync(f, ''); // ready() 只查存在
  return f;
}

// 假 sherpa addon：按编排让 Vad 报告有/无语音段
function fakeAddon({ speech = true } = {}) {
  class Vad {
    constructor() { this._popped = 0; this._fed = 0; }
    acceptWaveform() { this._fed += 1; }
    isEmpty() { return !(speech && this._fed > 0 && this._popped < 1); }
    pop() { this._popped += 1; }
    flush() {}
  }
  return { Vad };
}

describe('SileroVadClient', () => {
  it('ready：模型缺失 false；齐全且 addon 可加载 true', () => {
    expect(new SileroVadClient({ model: '/nope.onnx', loadAddon: () => fakeAddon() }).ready()).toBe(false);
    expect(new SileroVadClient({ model: modelFile(), loadAddon: () => fakeAddon() }).ready()).toBe(true);
  });

  it('detect：有语音段 → hasSpeech true', () => {
    const c = new SileroVadClient({ model: modelFile(), loadAddon: () => fakeAddon({ speech: true }) });
    const r = c.detect(wav16k(1, 200));
    expect(r.ok).toBe(true);
    expect(r.hasSpeech).toBe(true);
    expect(r.segments).toBeGreaterThan(0);
  });

  it('detect：Vad 单例复用（深析改进#1）——多次 detect 只 new 一次 Vad，每次用后 reset', () => {
    let built = 0; let resets = 0;
    const addon = (() => {
      class Vad {
        constructor() { built += 1; this._p = 1; }
        acceptWaveform() {}
        isEmpty() { return this._p-- <= 0; }
        pop() {}
        flush() {}
        reset() { resets += 1; this._p = 1; }
      }
      return { Vad };
    })();
    const c = new SileroVadClient({ model: modelFile(), loadAddon: () => addon });
    c.detect(wav16k(1, 200)); c.detect(wav16k(1, 200)); c.detect(wav16k(1, 200));
    expect(built).toBe(1);     // 只建一次
    expect(resets).toBe(3);    // 每次用后 reset
  });

  it('detect：无语音段 → hasSpeech false（噪声会被丢）', () => {
    const c = new SileroVadClient({ model: modelFile(), loadAddon: () => fakeAddon({ speech: false }) });
    const r = c.detect(wav16k(1, 200));
    expect(r.ok).toBe(true);
    expect(r.hasSpeech).toBe(false);
  });

  it('降级放行：模型不可用 / 非 16k / 超长 → ok:false + hasSpeech:true（绝不因 VAD 自身把主人挡门外）', () => {
    expect(new SileroVadClient({ model: '/nope.onnx' }).detect(wav16k(1, 200))).toMatchObject({ ok: false, hasSpeech: true });
    const c = new SileroVadClient({ model: modelFile(), loadAddon: () => fakeAddon(), maxAudioSeconds: 1 });
    expect(c.detect(wav16k(2, 200))).toMatchObject({ ok: false, hasSpeech: true, reason: 'audio_too_long' });
    // 8k wav
    const sr = 8000; const buf = Buffer.alloc(44); buf.write('RIFF', 0); buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24); buf.writeUInt16LE(16, 34); buf.write('data', 36);
    expect(new SileroVadClient({ model: modelFile(), loadAddon: () => fakeAddon() }).detect(buf)).toMatchObject({ ok: false });
  });

  it('makeSileroVad：NOE_SILERO_VAD≠1 → null（默认 OFF），即便本机模型就位也不通电', () => {
    // 指向不存在的模型路径排除本机真模型干扰，确证"开关才是默认 OFF 的决定因素"
    expect(makeSileroVad({ env: { NOE_SILERO_VAD_MODEL: '/nope.onnx' } })).toBeNull();
    expect(makeSileroVad({ env: {} })).toBeNull(); // 未设开关 → null（本机模型在也不启用）
    expect(makeSileroVad({ env: { NOE_SILERO_VAD: '1', NOE_SILERO_VAD_MODEL: '/nope.onnx' } })).toBeNull(); // 开了但模型缺 → null
  });
});

describe('VoiceSession × silero 精筛', () => {
  function session(vadResult) {
    let sttCalled = 0;
    const s = new VoiceSession({
      sttClient: { transcribe: async () => { sttCalled += 1; return '你好'; } },
      sileroVad: vadResult ? { detect: () => vadResult } : null,
      brainRouter: { route: () => ({ adapterId: 'fake', tier: 'local', fallbacks: [] }) },
      getAdapter: () => ({ chat: async () => ({ reply: '好' }) }),
      ownerGate: { check: () => ({ ok: true }) },
    });
    return { s, sttCalls: () => sttCalled };
  }

  it('VAD 判无人声 → 直接 ignored，连 STT 都不跑', async () => {
    const { s, sttCalls } = session({ ok: true, hasSpeech: false });
    const r = await s.chat(wav16k(1, 200), { noTts: true });
    expect(r.ok).toBe(false);
    expect(r.intent).toBe('no_speech');
    expect(sttCalls()).toBe(0);
  });

  it('VAD 前移到门禁前（深析改进#2）：噪声段在声纹门禁触发前就被丢，门禁的重推理不跑', async () => {
    let voiceGateCalled = 0;
    const s = new VoiceSession({
      sttClient: { transcribe: async () => '你好' },
      sileroVad: { detect: () => ({ ok: true, hasSpeech: false }) },
      identityStore: {
        status: () => ({ voice: {} }),
        shouldGateVoice: () => true,
        verifyVoice: () => { voiceGateCalled += 1; return { ok: false }; },
      },
      personStore: { modelSettings: { status: () => ({ voice: { enabled: true }, face: { enabled: false } }) } },
      brainRouter: { route: () => ({ adapterId: 'fake', tier: 'local', fallbacks: [] }) },
      getAdapter: () => ({ chat: async () => ({ reply: '好' }) }),
      ownerGate: { check: () => ({ ok: true }) },
    });
    const r = await s.chat(wav16k(1, 200), { noTts: true });
    expect(r.intent).toBe('no_speech');
    expect(voiceGateCalled).toBe(0); // 噪声没走到声纹门禁（VAD 在最前）
  });

  it('VAD 判有人声 → 正常走 STT 对话', async () => {
    const { s, sttCalls } = session({ ok: true, hasSpeech: true });
    const r = await s.chat(wav16k(1, 200), { noTts: true });
    expect(r.ok).toBe(true);
    expect(sttCalls()).toBe(1);
  });

  it('VAD 不可用(ok:false) → 降级放行走 STT', async () => {
    const { s, sttCalls } = session({ ok: false, hasSpeech: true });
    const r = await s.chat(wav16k(1, 200), { noTts: true });
    expect(r.ok).toBe(true);
    expect(sttCalls()).toBe(1);
  });

  it('未注入 sileroVad → 行为同旧（直接 STT）', async () => {
    const { s, sttCalls } = session(null);
    await s.chat(wav16k(1, 200), { noTts: true });
    expect(sttCalls()).toBe(1);
  });
});
