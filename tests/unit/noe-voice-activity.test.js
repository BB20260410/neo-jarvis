import { describe, it, expect } from 'vitest';
import { createNoeVoiceActivity } from '../../src/voice/NoeVoiceActivity.js';

// 第三阶段·全模态一体化补语音模态:VoiceSession 每次语音 turn markActive,多模态融合据此知道「语音通道在不在线」。
// 让四模态(文字/UI/视觉/语音)都活。纯:注入 now,不依赖真时钟。

describe('createNoeVoiceActivity', () => {
  it('markActive 后在窗口内 isActive=true', () => {
    let t = 1000;
    const va = createNoeVoiceActivity({ now: () => t });
    va.markActive();
    t = 1000 + 30_000; // 30s 后
    expect(va.isActive(60_000)).toBe(true); // 60s 窗口内
  });

  it('超窗口 → isActive=false(语音早停了)', () => {
    let t = 1000;
    const va = createNoeVoiceActivity({ now: () => t });
    va.markActive();
    t = 1000 + 120_000; // 2min 后
    expect(va.isActive(60_000)).toBe(false);
  });

  it('从没 markActive → isActive=false(不误报在线)', () => {
    const va = createNoeVoiceActivity({ now: () => 1000 });
    expect(va.isActive(60_000)).toBe(false);
  });
});
