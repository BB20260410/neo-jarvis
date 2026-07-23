// @ts-check
// NoeReflectiveTunerScore — 「镜像 NoeWorkspace.score」的确定性显著度打分（从 NoeReflectiveTuner 抽出，保主文件 <500 行）。
//
// 评测桥的根基：显著度权重影响「注意力竞争里谁夺冠」，而 holdout 评测「文本输出」——本模块用候选权重在场景候选集
//   上选赢家、赢家文本作 candidate/baselineOutput 喂评测。scoreSalienceShadow 逐字镜像 NoeWorkspace.score 的公式
//   （含 goal_step 加成分支），SOURCE_BASE/DEFAULT_BASE 与 NoeWorkspace 逐字一致，由测试锚定数值一致防镜像漂移。
import { clamp01, round3 } from './_mathUtils.js';

// 显著度四权重默认值（与 NoeWorkspace WEIGHTS 逐字一致，作变异基线锚点）。
export const REFLECTIVE_TUNER_BASELINE_WEIGHTS = Object.freeze({ owner: 0.35, urgency: 0.25, novelty: 0.2, affect: 0.2 });

// 各候选源的 base 三维（与 NoeWorkspace SOURCE_BASE 逐字一致；scoreSalienceShadow 镜像打分用）。
/** @type {Readonly<Record<string, {owner:number, urgency:number, affect:number}>>} */
const SOURCE_BASE = Object.freeze({
  owner_interaction: { owner: 1.0, urgency: 0.4, affect: 0.5 },
  commitment_due: { owner: 0.8, urgency: 1.0, affect: 0.4 },
  expectation_due: { owner: 0.3, urgency: 0.7, affect: 0.3 },
  goal_step: { owner: 0.25, urgency: 0.55, affect: 0.3 },
  fresh_insight: { owner: 0.2, urgency: 0.45, affect: 0.35 },
  percept: { owner: 0.6, urgency: 0.2, affect: 0.3 },
  system_state: { owner: 0.3, urgency: 0.15, affect: 0.2 },
  drive: { owner: 0.1, urgency: 0.5, affect: 0.4 },
  last_thought: { owner: 0.0, urgency: 0.1, affect: 0.2 },
});
/** @type {{owner:number, urgency:number, affect:number}} */
const DEFAULT_BASE = Object.freeze({ owner: 0.2, urgency: 0.2, affect: 0.2 });

/** @typedef {'owner'|'urgency'|'novelty'|'affect'} WeightKey */
/** @typedef {{owner:number, urgency:number, novelty:number, affect:number}} Weights */
/** @type {WeightKey[]} */
export const WEIGHT_KEYS = ['owner', 'urgency', 'novelty', 'affect'];
/** @param {number} x */
export const round4 = (x) => Math.round(x * 10000) / 10000;

/** @param {*} value @param {*} [fallback] @returns {*} */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 规范化一组权重：逐项取有限数否则回落基线，clamp 到 [0,1]，冻结返回。
 * 用于把本地脑/网格产出的“候选权重”收敛到合法域（绝不让脏值进 archive 候选）。
 * @param {*} input
 * @param {Weights} [baseline]
 * @returns {Readonly<Weights>}
 */
export function normalizeWeights(input, baseline = REFLECTIVE_TUNER_BASELINE_WEIGHTS) {
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const base = baseline && typeof baseline === 'object' ? baseline : REFLECTIVE_TUNER_BASELINE_WEIGHTS;
  /** @param {WeightKey} key */
  const pick = (key) => round4(clamp01(num(src[key], num(base[key], REFLECTIVE_TUNER_BASELINE_WEIGHTS[key]))));
  return Object.freeze({ owner: pick('owner'), urgency: pick('urgency'), novelty: pick('novelty'), affect: pick('affect') });
}

/**
 * 镜像 NoeWorkspace.score 的显著度打分（纯函数、确定性）。candidate.novelty 是预算好的新异度（0..1，
 * shadow 评测里由场景显式给定，不在此 embed/触网）；arousal 默认 0.35（与 workspace 无 affectProbe 时一致）。
 * 逐字对齐 NoeWorkspace（含 goal_step 加成分支），由测试锚定数值一致。
 */
export function scoreSalienceShadow(candidate, weights, arousal = 0.35) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const w = normalizeWeights(weights);
  const base = SOURCE_BASE[c.source] || DEFAULT_BASE;
  const n = clamp01(num(c.novelty, 1));
  const a = num(arousal, 0.35);
  let s = w.owner * base.owner + w.urgency * base.urgency + w.novelty * n + w.affect * base.affect * (0.5 + a / 2);
  if (c.source === 'goal_step') {
    const p = clamp01(num(c.goalPriority, 0));
    s += 0.18 * p;
    const repeatedRecently = n < 0.15;
    if (!repeatedRecently) {
      s = Math.max(s, 0.62);
      if (c.kind === 'act' || c.kind === 'research') s = Math.max(s + 0.08, 0.68);
    } else if (c.kind === 'act' || c.kind === 'research') {
      s = Math.max(s + 0.08, 0.5);
    }
  }
  return round3(s);
}

/**
 * 用一套权重在候选集上选注意力赢家（模拟 NoeWorkspace 的 sort 取首）。稳定排序：分数相同保留输入序。
 * @returns {{winner:object|null, scored:Array}}
 */
export function pickWinnerShadow(candidates, weights, arousal = 0.35) {
  const list = Array.isArray(candidates) ? candidates : [];
  const scored = list.map((c, i) => ({ ...c, _i: i, score: scoreSalienceShadow(c, weights, arousal) }));
  scored.sort((x, y) => (y.score - x.score) || (x._i - y._i));
  return { winner: scored[0] || null, scored };
}
