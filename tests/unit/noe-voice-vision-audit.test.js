// 语音/视觉审计修复测试（审计 §3.4 P0-4/5/7）
// P0-4 ScreenCapturer 残留帧清理、P0-5 VoiceVad 精确分配裁剪、P0-7 PersonKnowledgeStore campplus 维度无关
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ScreenCapturer } from '../../src/vision/ScreenCapturer.js';
import { preprocessVoiceWav } from '../../src/identity/VoiceVad.js';
import { PersonKnowledgeStore } from '../../src/identity/PersonKnowledgeStore.js';

describe('P0-4 ScreenCapturer.cleanupStaleFrames', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-screencap-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const PID = process.pid; // 本进程 PID（cleanupStaleFrames 只认本进程命名的帧）

  it('删本实例陈旧残留帧，保留本实例新帧与非帧文件', async () => {
    const old = join(dir, `noe-frame-${PID}-1.png`);
    const fresh = join(dir, `noe-frame-${PID}-2.png`);
    const other = join(dir, 'unrelated.txt');
    writeFileSync(old, 'x');
    writeFileSync(fresh, 'y');
    writeFileSync(other, 'z');
    const past = Date.now() / 1000 - 120; // 2 分钟前
    utimesSync(old, past, past);

    const cap = new ScreenCapturer({ tmpDir: dir });
    await cap.cleanupStaleFrames({ olderThanMs: 60_000 });

    expect(existsSync(old)).toBe(false);   // 本实例陈旧帧被删
    expect(existsSync(fresh)).toBe(true);  // 本实例新帧保留（绝不碰正在用的）
    expect(existsSync(other)).toBe(true);  // 非 noe-frame 文件不碰
  });

  it('不删其他实例（其他 PID）的陈旧帧——同机多实例不互删', async () => {
    // 模拟另一个 Noe 实例（51999 隔离端口自测）遗留的陈旧帧，PID 必与本进程不同
    const otherPid = PID + 1;
    const otherStale = join(dir, `noe-frame-${otherPid}-1.png`);
    // 边界：另一实例 PID 恰以本进程 PID 为前缀（防前缀粘连误删，如本 PID 999 vs 另一 9991）
    const prefixCollision = join(dir, `noe-frame-${PID}9-1.png`);
    // 对照：本实例自己的陈旧帧应被删，证明清理确实在工作（避免“全都没删”的假绿）
    const ownStale = join(dir, `noe-frame-${PID}-7.png`);
    writeFileSync(otherStale, 'a');
    writeFileSync(prefixCollision, 'b');
    writeFileSync(ownStale, 'c');
    const past = Date.now() / 1000 - 120; // 三者都置为 2 分钟前（足够陈旧）
    utimesSync(otherStale, past, past);
    utimesSync(prefixCollision, past, past);
    utimesSync(ownStale, past, past);

    const cap = new ScreenCapturer({ tmpDir: dir });
    await cap.cleanupStaleFrames({ olderThanMs: 60_000 });

    expect(existsSync(otherStale)).toBe(true);      // 其他实例的帧绝不碰（修复前会被误删）
    expect(existsSync(prefixCollision)).toBe(true); // PID 前缀粘连的帧也不碰
    expect(existsSync(ownStale)).toBe(false);       // 本实例自己的陈旧帧仍被正常清理
  });
});

describe('P0-5 VoiceVad 精确分配裁剪', () => {
  function voiceThenSilence(sampleRate = 16000, seconds = 1.4) {
    const n = Math.floor(seconds * sampleRate);
    const buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
    buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i += 1) {
      const v = i < n / 2 ? Math.round(Math.sin(2 * Math.PI * 220 * i / sampleRate) * 18000) : 0; // 前半语音后半静音
      buf.writeInt16LE(v, 44 + i * 2);
    }
    return buf;
  }

  it('语音+静音输入裁剪后产出有效 WAV 且不超过原长', () => {
    const input = voiceThenSilence();
    const out = preprocessVoiceWav(input);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.length).toBeGreaterThan(44);          // 有效 WAV（含头）
    expect(out.length).toBeLessThanOrEqual(input.length); // 裁掉静音不会变长
  });

  it('全静音/过短输入安全返回原 buffer', () => {
    const silent = Buffer.alloc(44 + 16000 * 2); // 1s 全 0
    silent.write('RIFF', 0); silent.write('WAVE', 8); silent.write('fmt ', 12);
    silent.writeUInt16LE(1, 20); silent.writeUInt16LE(1, 22); silent.writeUInt32LE(16000, 24); silent.writeUInt16LE(16, 34);
    silent.write('data', 36);
    expect(() => preprocessVoiceWav(silent)).not.toThrow();
  });
});

describe('P0-7 PersonKnowledgeStore campplus 维度无关', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-person-dim-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('256 维 campplus 样本仍被识别为 ready（不因维度≠192 被静默过滤）', () => {
    const store = new PersonKnowledgeStore({ file: join(dir, 'people.json') });
    const p = store.upsert({ displayName: '主人', relation: 'owner' });
    const person = store.people.get(p.id);
    // 手动注入 256 维 campplus 样本（模拟模型升维；测试环境无 campplus runtime，故直接构造）
    person.voiceSamples = [
      { engine: 'campplus', embedding: Array.from({ length: 256 }, (_, i) => Math.sin(i / 7)), name: 'v1' },
      { engine: 'campplus', embedding: Array.from({ length: 256 }, (_, i) => Math.sin(i / 7) + 0.01), name: 'v2' },
      { engine: 'campplus', embedding: Array.from({ length: 256 }, (_, i) => Math.sin(i / 7) - 0.01), name: 'v3' },
    ];
    const query = [{ engine: 'campplus', embedding: Array.from({ length: 256 }, (_, i) => Math.sin(i / 7) + 0.005) }];
    const cands = store._voiceCandidates(query, { threshold: 0.5, minSamples: 3 });
    expect(cands.length).toBeGreaterThan(0);          // 256 维样本被算作有效（旧 ===192 会过滤致空）
    expect(cands[0].enough).toBe(true);               // 3 条样本达 minSamples
  });
});
