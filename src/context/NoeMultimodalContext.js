// @ts-check
// NoeMultimodalContext — 第三阶段·全模态一体化:把视觉/语音/文本/工具融进「一个」推理上下文。
//
// 现状各模态各管各的(视觉 NoeVisionSituation、UI 信号 NoeUiSignalStore、语音 VoiceSession 分散)。
// 「无缝的它」= 同一个上下文里 Neo 同时看到:屏幕上是什么、主人刚在面板做了什么、语音通道开着没、当前哪个 app。
// 让大脑跨模态推理(看到你在看 X + 你刚点了 Y → 更懂你此刻在干嘛),而不是文字聊天里对视觉/操作一无所知。
// 纯函数:只收有信号的模态(无信号不产噪声),每段限长防撑爆 prompt,fail-open。

function clip(s, max) {
  const t = String(s == null ? '' : s).trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 融合当前可得的多模态感知为一段推理上下文(空则 ''，不注入垃圾)。
 * @param {object} [signals]
 * @param {string} [signals.visionSummary] 视觉:屏幕上是什么(NoeVisionSituation.summary)
 * @param {boolean} [signals.visionStale] 视觉画面是否过期(过期则标注不确定)
 * @param {{lastAction?:string,lastCard?:string}} [signals.uiSignal] UI:主人刚在面板做了什么(NoeUiSignalStore.snapshot)
 * @param {boolean} [signals.voiceActive] 语音通道是否在线
 * @param {string} [signals.activeApp] 当前焦点 app
 * @returns {string} 融合上下文段(带前缀),无信号则 ''
 */
export function buildMultimodalContext({ visionSummary = '', visionStale = false, uiSignal = null, voiceActive = false, activeApp = '' } = {}) {
  const lines = [];
  const vs = clip(visionSummary, 600);
  if (vs) lines.push(`- 视觉(我看到的屏幕${visionStale ? ',可能已过期' : ''}): ${vs}`);
  if (activeApp) lines.push(`- 当前 app: ${clip(activeApp, 80)}`);
  if (uiSignal && (uiSignal.lastAction || uiSignal.lastCard)) {
    const bits = [uiSignal.lastAction && `操作: ${clip(uiSignal.lastAction, 120)}`, uiSignal.lastCard && `卡片: ${clip(uiSignal.lastCard, 80)}`].filter(Boolean);
    if (bits.length) lines.push(`- 面板(主人刚做的): ${bits.join(', ')}`);
  }
  if (voiceActive === true) lines.push('- 语音通道: 在线(主人可能在说话/听)');
  if (!lines.length) return '';
  return `\n\n当前多模态感知(我此刻跨模态看到的,供理解你在干嘛):\n${lines.join('\n')}`;
}
