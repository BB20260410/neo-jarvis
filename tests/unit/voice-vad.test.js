import { describe, expect, it } from 'vitest';
import { preprocessVoiceWav, analyzeVoiceActivity, __vadInternals } from '../../src/identity/VoiceVad.js';
import { parsePcm16Wav } from '../../src/identity/Voiceprint.js';

// 由若干段(正弦/静音)拼一个 PCM16 WAV;freq=0 表示静音段。
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

describe('VoiceVad 声纹前处理', () => {
  it('裁掉前后静音段,只保留语音(显著变短且仍为合法 WAV)', () => {
    const input = wavFromSegments([
      { freq: 0, seconds: 0.5 },     // 前静音
      { freq: 200, seconds: 0.6 },   // 语音
      { freq: 0, seconds: 0.5 },     // 后静音
    ]);
    const out = preprocessVoiceWav(input);
    expect(out).not.toBe(input);                 // 确实改了
    expect(out.length).toBeLessThan(input.length * 0.7);
    const parsed = parsePcm16Wav(out);           // 仍可解析
    const keptSec = parsed.samples.length / parsed.sampleRate;
    expect(keptSec).toBeGreaterThan(0.4);        // 语音段保住(0.6s±hangover)
    expect(keptSec).toBeLessThan(1.1);           // 静音被裁掉
  });

  it('纯语音(无静音对比)→ 原样返回,不冒险裁剪', () => {
    const input = wavFromSegments([{ freq: 200, seconds: 1.0 }]);
    expect(preprocessVoiceWav(input)).toBe(input);
  });

  it('非法 buffer / 过短音频 → 原样返回,绝不抛错破坏信号', () => {
    const junk = Buffer.from('this is not a wav at all');
    expect(preprocessVoiceWav(junk)).toBe(junk);
    const tooShort = wavFromSegments([{ freq: 200, seconds: 0.1 }]);
    expect(preprocessVoiceWav(tooShort)).toBe(tooShort);
  });

  it('analyzeVoiceActivity：静音/极弱杂音被拒，有清晰人声放行', () => {
    expect(analyzeVoiceActivity(wavFromSegments([{ freq: 0, seconds: 1.0 }])).ok).toBe(false); // 纯静音 → 拒
    const tone = analyzeVoiceActivity(wavFromSegments([{ freq: 200, seconds: 1.0, amp: 16000 }]));
    expect(tone.ok).toBe(true); // 有足够能量的连续声 → 放行
    expect(analyzeVoiceActivity(wavFromSegments([{ freq: 200, seconds: 0.1 }])).ok).toBe(false); // 太短 → 拒
    expect(analyzeVoiceActivity(Buffer.from('not a wav')).ok).toBe(true); // 非法 → 降级放行(不锁主人)
    expect(analyzeVoiceActivity(wavFromSegments([{ freq: 200, seconds: 1.0, amp: 200 }])).ok).toBe(false); // 极弱(amp 200) → 太安静拒
  });

  it('高通滤波去除直流偏置', () => {
    const dc = new Float32Array(2000).fill(0.5); // 纯直流
    const out = __vadInternals.highpass(dc, 0.97);
    const tail = Array.from(out.subarray(1000));  // 跳过起始瞬态
    const mean = tail.reduce((a, b) => a + b, 0) / tail.length;
    expect(Math.abs(mean)).toBeLessThan(0.05);     // 直流被压到接近 0
  });
});
