// @ts-check
// NoeVoiceActivity — 第三阶段·全模态一体化补语音模态。
//
// 多模态融合(NoeMultimodalContext)缺一个「语音通道在不在线」的信号。此轻量追踪器:VoiceSession 每次语音 turn
//   markActive() 打时间戳,融合时 isActive(window) 判断最近有没有语音活动。让四模态(文字/UI/视觉/语音)都活。
//   纯:注入 now,不依赖真时钟;共享单例供 VoiceSession 与 server 融合 provider 用。

export function createNoeVoiceActivity({ now = () => Date.now() } = {}) {
  let lastActiveAt = 0;
  return {
    /** 语音 turn 发生时打时间戳。 */
    markActive() { lastActiveAt = Number(now()) || 0; },
    /** 最近 windowMs 内有没有语音活动(通道在线)。 */
    isActive(windowMs = 60_000) {
      if (!lastActiveAt) return false;
      return (Number(now()) - lastActiveAt) < Math.max(0, Number(windowMs) || 0);
    },
    lastActiveAt: () => lastActiveAt,
  };
}

// 共享单例:VoiceSession markActive、server 融合 provider isActive 读同一实例。
export const defaultNoeVoiceActivity = createNoeVoiceActivity();
