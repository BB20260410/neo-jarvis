// @ts-check
// NoeAffectModulation（P2-4）——把情感 VAD 状态翻译成**行为调制参数**，让情感真影响行为而非装饰。
//
// 明确接点（计划 P2-4）：
//   - arousal 高 → 缩短深思（deliberationScale < 1，应激下快反应）；arousal 低 → 略放长（从容）。
//   - valence 低 → 抬高 owner 关切优先级（ownerPriorityBoost > 0，难受时更顾 owner）。
//   - dominance 低 → 略增谨慎（cautionBias > 0，掌控感弱时少冒进）。
// 纯函数、确定性、有界；可关（flag）：enabled=false 时返回**中性基线**（deliberationScale=1 等），
//   行为逐字回归未接情感前——满足「关 flag 行为回归基线」完成判定。
// flag 真实接通在 server 侧（NOE_AFFECT_MODULATION，默认 OFF）；调制参数由 deliberation/rhythm/排程消费。

const NEUTRAL = Object.freeze({
  deliberationScale: 1,   // 深思预算乘子（1=基线）
  ownerPriorityBoost: 0,  // owner 关切优先级加成（0..1）
  cautionBias: 0,         // 谨慎偏置（0..1，越高越保守）
  enabled: false,
});

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, Number(x) || 0)); }

/**
 * VAD → 行为调制参数。
 * @param {{v?:number, a?:number, d?:number, valence?:number, arousal?:number, dominance?:number}} vad
 * @param {{ enabled?: boolean, arousalGain?: number, valenceGain?: number, dominanceGain?: number }} [opts]
 * @returns {{deliberationScale:number, ownerPriorityBoost:number, cautionBias:number, enabled:boolean}}
 */
export function affectBehaviorModulation(vad = {}, opts = {}) {
  if (!opts.enabled) return { ...NEUTRAL };
  const v = clamp(vad.v ?? vad.valence ?? 0, -1, 1);
  const a = clamp(vad.a ?? vad.arousal ?? 0.5, 0, 1);
  const d = clamp(vad.d ?? vad.dominance ?? 0, -1, 1);
  const arousalGain = Number.isFinite(opts.arousalGain) ? opts.arousalGain : 0.6;
  const valenceGain = Number.isFinite(opts.valenceGain) ? opts.valenceGain : 0.5;
  const dominanceGain = Number.isFinite(opts.dominanceGain) ? opts.dominanceGain : 0.4;
  // arousal 以 0.5 为中点：高于中点缩短深思（scale<1），低于则放长（scale>1）。裁剪到 [0.5,1.3] 防极端。
  const deliberationScale = clamp(1 - (a - 0.5) * 2 * arousalGain, 0.5, 1.3);
  // valence 越低（负），owner 关切加成越高；valence≥0 不加成。
  const ownerPriorityBoost = clamp(Math.max(0, -v) * valenceGain, 0, 1);
  // dominance 越低（负），谨慎偏置越高。
  const cautionBias = clamp(Math.max(0, -d) * dominanceGain, 0, 1);
  return {
    deliberationScale: Number(deliberationScale.toFixed(3)),
    ownerPriorityBoost: Number(ownerPriorityBoost.toFixed(3)),
    cautionBias: Number(cautionBias.toFixed(3)),
    enabled: true,
  };
}

/**
 * 调制器工厂（DI flag）。modulate(vad) 据 enabled 返回调制参数；exposeNeutral 给消费方默认值。
 * @param {{ enabled?: boolean, arousalGain?: number, valenceGain?: number, dominanceGain?: number }} deps
 */
export function createNoeAffectModulator({ enabled = false, arousalGain, valenceGain, dominanceGain } = {}) {
  const opts = { enabled, arousalGain, valenceGain, dominanceGain };
  return {
    enabled,
    modulate: (vad) => affectBehaviorModulation(vad, opts),
    neutral: () => ({ ...NEUTRAL }),
  };
}

export const NEUTRAL_MODULATION = NEUTRAL;
