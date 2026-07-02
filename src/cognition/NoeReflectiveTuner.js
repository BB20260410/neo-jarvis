// @ts-check
// NoeReflectiveTuner — GEPA 式显著度权重「纯 shadow」参数自进化（PoC）。
//
// 背景：NoeWorkspace 的注意力竞争由显著度四权重决定（owner/urgency/novelty/affect，S0.7 已抽成
//   注入式 salienceWeights，env NOE_WS_SALIENCE_* 三层缺省）——这就是 GEPA 的「可优化对象」。
//   NoeEvolutionHoldoutRunner（runNoeEvolutionHoldoutSemantic，硬门权威 + 语义连续分 + fail-open）
//   是现成的「评测尺子」。失败/低分轨迹来自 consciousness/*.jsonl（attend 行的 winner/runnerUps/score、
//   deliberation_done 的 deliberated/rewardScore）。
//
// 本模块做 GEPA 闭环：读失败/低分轨迹 → 本地脑反思提出新权重候选（变异）→ 用语义 holdout 评测候选 →
//   Pareto 多目标选优 → 候选 + 证据 ledger 存进 archive。
//
// 采纳门（standing-grant，env NOE_REFLECTIVE_TUNER_ADOPT 默认 OFF）：闭环最后加 recommendAdoption「是否建议采纳」判定——
//   从 Pareto 前沿挑「真改善基准(holdoutDelta 严格>门槛)+评测器真跑通」的候选。OFF=纯观察(recommendation 照算、adopted 恒 false)；
//   ON=archive 标最佳候选 adopted:true。两态都【绝不写 production/.env/workspace、绝不调 patch-apply】，owner 人工抄进 .env 才生效。
//
// 【codex 硬约束 —— 本模块安全的核心，逐条落实】：
//  · 纯 shadow：只产 candidate weights + 证据 ledger + 采纳建议（不落地）。绝不写 production 权重、绝不改 .env、
//    绝不改 live workspace（本模块根本不 import NoeWorkspace 实例，也不接收任何 workspace 句柄/写回回调）、绝不调用
//    任何 self-evolution patch-apply。系统绝不自动落地权重；采纳门 ON 时也只「建议」，最终由 owner 人工抄进 .env。
//  · 因为不写 production / 不碰自我进化 patch，故【不加任何 protectedPaths / 安全门护栏】（符合 owner
//    “别加护栏”宪法）——本模块产出本身无副作用面，唯一的盘写是 appendArchive（由调用方注入实现，本模块
//    不自带任何 fs 句柄、不知道也不碰 production 文件）。
//  · env NOE_REFLECTIVE_TUNER 默认 OFF，OFF 零回归（server 在 OFF 时根本不构造本工厂）。
//  · 变异用本地脑、评测用语义 holdout，均不设硬超时、全程 fail-open（本地脑挂/未注入 → 退回确定性网格
//    变异；评测炸 → 该候选评测维度降级但不锁死）。
//
// 评测桥（关键设计）：显著度权重影响的是「注意力竞争里谁夺冠」，而 holdout 评测的是「文本输出」。本模块
//   用一组「注意力场景」（固定候选集 + 期望赢家文本）搭桥：用候选权重在场景候选集上选赢家 → 赢家文本作
//   candidateOutput；用基线权重选赢家 → 作 baselineOutput。喂 runNoeEvolutionHoldoutSemantic 即得到
//   「这套权重让注意力更/少命中期望焦点」的可比硬门 + 语义分。scoreSalienceShadow 逐字镜像
//   NoeWorkspace.score 的公式（含 goal_step 分支），并由测试锚定与真实 workspace 数值一致防镜像漂移。

import { runNoeEvolutionHoldoutSemantic } from '../room/NoeEvolutionHoldoutRunner.js';
import { recommendAdoption } from './NoeReflectiveTunerAdopt.js';
// 镜像 NoeWorkspace.score 的打分 + 权重规范化抽到 NoeReflectiveTunerScore.js（保本文件 <500 行）；re-export 保引用面。
import {
  REFLECTIVE_TUNER_BASELINE_WEIGHTS, WEIGHT_KEYS, round4,
  normalizeWeights, scoreSalienceShadow, pickWinnerShadow,
} from './NoeReflectiveTunerScore.js';
import { round3 } from './_mathUtils.js';

export const NOE_REFLECTIVE_TUNER_SCHEMA_VERSION = 1;
export { REFLECTIVE_TUNER_BASELINE_WEIGHTS, normalizeWeights, scoreSalienceShadow, pickWinnerShadow };

/** @typedef {{owner:number, urgency:number, novelty:number, affect:number}} Weights */

/** @param {*} value @param {*} [fallback] @returns {*} */
function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clean(value, max = 400) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * 多目标 Pareto 非支配前沿。objectives：每项 {key, dir}（dir='max'|'min'）。
 * 返回输入子集（未被任何其他项在所有目标上支配的项）。确定性、纯函数。
 */
export function paretoFront(items, objectives) {
  const list = Array.isArray(items) ? items : [];
  const objs = Array.isArray(objectives) ? objectives : [];
  if (!list.length || !objs.length) return list.slice();
  const val = (item, o) => {
    const raw = num(item?.objectives?.[o.key] ?? item?.[o.key], 0);
    return o.dir === 'min' ? -raw : raw; // 统一成“越大越好”
  };
  const dominates = (a, b) => {
    let strictly = false;
    for (const o of objs) {
      const va = val(a, o);
      const vb = val(b, o);
      if (va < vb) return false;       // a 在某目标更差 → 不支配
      if (va > vb) strictly = true;    // a 至少有一项严格更优
    }
    return strictly;
  };
  return list.filter((cand) => !list.some((other) => other !== cand && dominates(other, cand)));
}

// 采纳判定（GEPA 闭环最后一关「提了候选 ≠ 该用」）抽到 NoeReflectiveTunerAdopt.js（保本文件 <500 行；顶部已 import）。
// 反向 probe 的拒绝点在该模块：holdout 变差/持平或被 Pareto 支配的坏候选永不被推荐。re-export 保持既有引用面。
export { recommendAdoption };

/**
 * 确定性网格变异（本地脑挂/未注入时的 fallback，绝不锁死）：对基线四权重各 ±delta 单维扰动 + 全维放大/缩小。
 * 产出已 normalize、去重（按权重指纹）。这是 GEPA 在“脑不可用”时仍能产候选的保底路径。
 */
export function mutateWeightsGrid(baseline = REFLECTIVE_TUNER_BASELINE_WEIGHTS, { deltas = [0.1, -0.1, 0.05, -0.05] } = {}) {
  const base = normalizeWeights(baseline);
  const out = [];
  const seen = new Set();
  const push = (w, note) => {
    const nw = normalizeWeights(w, base);
    const fp = WEIGHT_KEYS.map((k) => nw[k]).join('|');
    if (seen.has(fp)) return;
    seen.add(fp);
    out.push({ weights: nw, note });
  };
  for (const key of WEIGHT_KEYS) {
    for (const d of deltas) push({ ...base, [key]: base[key] + d }, `grid:${key}${d >= 0 ? '+' : ''}${d}`);
  }
  // 全维等比缩放（改变“总锐度”，不只改相对比例）
  push(WEIGHT_KEYS.reduce((acc, k) => ({ ...acc, [k]: base[k] * 1.15 }), {}), 'grid:scale*1.15');
  push(WEIGHT_KEYS.reduce((acc, k) => ({ ...acc, [k]: base[k] * 0.85 }), {}), 'grid:scale*0.85');
  return out;
}

/** @typedef {{source:string, score:(number|null), weak:boolean, failed:boolean, text:string}} Regret */

// 从一条 consciousness 轨迹行抽“遗憾信号”：用于挑出值得反思/优化的低分轨迹。
//  - attend 行：escalated=true 但后续深思失败（由 deliberation_done.deliberated=false 关联，调用方可预处理），
//    或 winner.score 低却仍夺冠（弱焦点）→ 记为低分轨迹。本函数只做单行的轻量判读，关联逻辑留给注入的 traces。
/** @param {*} trace @returns {Regret|null} */
function regretOfTrace(trace) {
  const t = trace && typeof trace === 'object' ? trace : {};
  if (t.kind === 'attend' && t.winner) {
    const score = num(t.winner.score, 0);
    return { source: clean(t.winner.source, 60), score, weak: score < 0.55, failed: false, text: clean(t.winner.text, 200) };
  }
  if (t.kind === 'deliberation_done') {
    return { source: 'deliberation', score: num(t.rewardScore, null), weak: false, failed: t.deliberated === false, text: clean(t.topic, 200) };
  }
  return null;
}

/**
 * 汇总失败/低分轨迹 → 给本地脑变异的反思摘要（纯文本，确定性、脱敏由上游 journal 已做）。
 * 不读盘：traces 由调用方从 consciousness/*.jsonl 预读注入（保持本模块零 fs 句柄）。
 * @param {*} traces @param {{max?:number}} [opts]
 */
export function summarizeRegretTraces(traces, { max = 12 } = {}) {
  const list = Array.isArray(traces) ? traces : [];
  /** @type {Regret[]} */
  const regrets = list.map(regretOfTrace).filter((r) => r !== null);
  const weak = regrets.filter((r) => r.weak || r.failed);
  const lines = (weak.length ? weak : regrets).slice(0, max).map((r) => {
    const tag = r.failed ? '深思失败' : r.weak ? '弱焦点夺冠' : '焦点';
    const sc = r.score == null ? '?' : round3(r.score);
    return `- [${tag}] source=${r.source} score=${sc} ${r.text}`;
  });
  return {
    total: regrets.length,
    weakCount: weak.length,
    summary: lines.join('\n').slice(0, 2000),
  };
}

const MUTATE_SYSTEM = '你在调一个“注意力显著度打分”的四个权重：owner（与主人相关）/urgency（紧迫）/novelty（新异）/affect（情绪强度）。'
  + '每个权重 0..1。下面给你最近“注意力选错/弱焦点夺冠/深思失败”的轨迹。请提出 2-3 组新的权重，让注意力更准。'
  + '只输出 JSON 数组，每项形如 {"owner":0.x,"urgency":0.x,"novelty":0.x,"affect":0.x,"why":"一句理由"}，不要别的文字。';

// 从本地脑回复里解析候选权重数组（fail-open：解析不出 → 空数组，调用方退网格）。
function parseBrainWeights(reply) {
  const text = String(reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '');
  const m = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 5).map((o) => ({ weights: normalizeWeights(o), note: clean(o?.why, 160) || 'brain' }));
}

/**
 * 创建 shadow ReflectiveTuner。全注入式。
 * @param {object} opts
 * @param {object} [opts.baselineWeights] 当前显著度四权重基线（默认 = NoeWorkspace 硬编码默认）。
 * @param {Array}  [opts.scenarios] 注意力场景集：[{ id, input, expectedIncludes, forbiddenIncludes, expectedText,
 *                                   candidates:[{source,text,novelty,goalPriority,kind}], arousal }]。每个场景的
 *                                   候选集会被基线/候选权重分别选赢家，赢家文本作 baseline/candidateOutput 喂评测。
 * @param {function} [opts.evaluate] 评测尺子（默认 runNoeEvolutionHoldoutSemantic）；注入便于测试。
 * @param {function} [opts.reflectMutate] async ({summary, baselineWeights}) => 候选权重数组 [{weights,note}]；
 *                                   挂掉/未注入 → 退确定性网格（fail-open）。
 * @param {function} [opts.appendArchive] (dateStr, lineObj) => void：写候选 + 证据 ledger（调用方注入 fs 实现；
 *                                   本模块不自带 fs 句柄，故不可能碰 production 文件）。
 * @param {function} [opts.embed] 传给评测的 embed（语义维度）；不传走评测默认。
 * @param {boolean}  [opts.semantic] 评测语义维度开关（透传，默认随 env NOE_HOLDOUT_SEMANTIC）。
 * @param {number}   [opts.maxCandidates] 评测的候选上限（防一次烧太多评测）。
 * @param {function} [opts.now]
 */
export function createReflectiveTuner({
  baselineWeights = REFLECTIVE_TUNER_BASELINE_WEIGHTS,
  scenarios = [],
  evaluate = runNoeEvolutionHoldoutSemantic,
  // scoreFn(candidateWeights) => number|Promise<number>：可选的「标量评测尺子」(GEPA 单目标接法)。
  //   生产可接 S0.5 的 scoreNoeHoldoutOutputSemantic 包出的标量；测试注入 stub。不传 → 走 evaluate(完整 holdout 报告)。
  scoreFn = null,
  reflectMutate = null,
  appendArchive = null,
  embed,
  semantic,
  maxCandidates = 6,
  // GEPA 开关。env NOE_REFLECTIVE_TUNER 默认 OFF 的「不构造/不 tick」在 server 接线层强制（仅 ==='1' 才 createReflectiveTuner）；
  //   工厂层 enabled 默认 true（被构造即意味着调用方要用），调用方可显式传 enabled=false 让 tick() return []（零副作用、零盘写）。
  enabled = true,
  // 采纳门（standing-grant，env NOE_REFLECTIVE_TUNER_ADOPT 默认 OFF，server 透传）。语义见顶部头注释：OFF=纯观察
  //   （recommendation 照算、adopted 恒 false）；ON=archive 标 adopted:true「建议采纳」。两态都【绝不写 production/.env/workspace】。
  adoptEnabled = false,
  // 采纳门槛：候选 holdoutDelta 必须严格 > adoptMinDelta 才够格被推荐（默认 0 = 必须真改善基准）。
  adoptMinDelta = 0,
  now = Date.now,
} = {}) {
  const baseline = normalizeWeights(baselineWeights);
  const sceneList = Array.isArray(scenarios) ? scenarios.filter((s) => s && Array.isArray(s.candidates) && s.candidates.length) : [];

  // 用一套权重在所有场景上选赢家 → {caseId: 赢家文本} 输出表（喂 holdout 的 baseline/candidateOutputs）。
  function outputsFor(weights) {
    const out = {};
    for (const sc of sceneList) {
      const id = clean(sc.id, 160) || `scene-${sceneList.indexOf(sc) + 1}`;
      const { winner } = pickWinnerShadow(sc.candidates, weights, num(sc.arousal, 0.35));
      out[id] = clean(winner?.text ?? '', 8000);
    }
    return out;
  }

  // 把场景集转成 holdout dataset（cases 复用场景的 expected/forbidden/expectedText）。
  function dataset() {
    return {
      id: 'reflective-tuner-attention-holdout',
      cases: sceneList.map((sc, i) => ({
        id: clean(sc.id, 160) || `scene-${i + 1}`,
        input: clean(sc.input, 300),
        expectedIncludes: Array.isArray(sc.expectedIncludes) ? sc.expectedIncludes : [],
        forbiddenIncludes: Array.isArray(sc.forbiddenIncludes) ? sc.forbiddenIncludes : [],
        ...(sc.expectedText ? { expectedText: clean(sc.expectedText, 2000) } : {}),
      })),
    };
  }

  // 评测一个候选权重：用 holdout 语义尺子比候选 vs 基线（fail-open：评测抛错 → 评测维度降级，不锁死）。
  // 若注入了标量 scoreFn（GEPA 单目标接法），优先用它给 candidate/baseline 打标量分，holdoutDelta=候选分-基线分。
  async function evalCandidateWeights(weights) {
    if (typeof scoreFn === 'function') {
      try {
        const candidateScore = round4(num(await scoreFn(normalizeWeights(weights, baseline)), 0));
        const baselineScore = round4(num(await scoreFn(baseline), 0));
        return { ok: true, holdoutDelta: round4(candidateScore - baselineScore), baselineScore, candidateScore, semanticMean: candidateScore, semanticLowConfidence: null, evaluatorOk: true };
      } catch (e) {
        return { ok: false, holdoutDelta: 0, baselineScore: 0, candidateScore: 0, semanticMean: null, semanticLowConfidence: null, evaluatorOk: false, evalError: clean(e?.message || e, 200) };
      }
    }
    const ds = dataset();
    const baselineOutputs = outputsFor(baseline);
    const candidateOutputs = outputsFor(weights);
    try {
      const report = await evaluate({
        dataset: ds,
        baselineOutputs,
        candidateOutputs,
        ...(embed ? { embed } : {}),
        ...(semantic !== undefined ? { semantic } : {}),
      });
      return {
        ok: true,
        holdoutDelta: round4(num(report?.delta, 0)),
        baselineScore: round4(num(report?.baselineScore, 0)),
        candidateScore: round4(num(report?.candidateScore, 0)),
        semanticMean: report?.semantic ? num(report.semantic.meanCandidateSemantic, null) : null,
        semanticLowConfidence: report?.semantic ? report.semantic.lowConfidence === true : null,
        evaluatorOk: report?.ok === true,
      };
    } catch (e) {
      // fail-open：评测不可用 → 该候选标评测降级，仍可进 archive（owner 看到 evalError 自行判断），绝不锁死。
      return { ok: false, holdoutDelta: 0, baselineScore: 0, candidateScore: 0, semanticMean: null, semanticLowConfidence: null, evaluatorOk: false, evalError: clean(e?.message || e, 200) };
    }
  }

  // 权重正则距离（L1，越小越接近基线 → 防漂移；作 Pareto 的“最小改动”目标）。
  function driftFrom(weights) {
    const w = normalizeWeights(weights, baseline);
    return round4(WEIGHT_KEYS.reduce((sum, k) => sum + Math.abs(w[k] - baseline[k]), 0));
  }

  // 变异：本地脑反思产候选（fail-open → 网格），合并去重，限流。
  async function mutate(traces) {
    const regret = summarizeRegretTraces(traces);
    let brainCands = [];
    if (typeof reflectMutate === 'function') {
      try {
        // 不设硬超时（本地模型 JIT 加载慢正常）；脑挂/空 → 退网格。
        const raw = await reflectMutate({ summary: regret.summary, baselineWeights: baseline, system: MUTATE_SYSTEM });
        brainCands = Array.isArray(raw)
          ? raw.map((o) => (o && o.weights ? { weights: normalizeWeights(o.weights, baseline), note: clean(o.note, 160) || 'brain' } : { weights: normalizeWeights(o, baseline), note: 'brain' }))
          : parseBrainWeights(raw);
      } catch { brainCands = []; } // 脑炸不阻断：退网格
    }
    const source = brainCands.length ? 'brain' : 'grid';
    const cands = brainCands.length ? brainCands : mutateWeightsGrid(baseline);
    // 去重（按指纹）+ 去掉与基线完全相同的“空变异” + 限流。
    const seen = new Set();
    const baseFp = WEIGHT_KEYS.map((k) => baseline[k]).join('|');
    const deduped = [];
    for (const c of cands) {
      const fp = WEIGHT_KEYS.map((k) => c.weights[k]).join('|');
      if (fp === baseFp || seen.has(fp)) continue;
      seen.add(fp);
      deduped.push(c);
      if (deduped.length >= maxCandidates) break;
    }
    return { source, regret, candidates: deduped };
  }

  // —— GEPA 命名 API（spec 契约）：propose → evaluate → select → archive，皆纯函数/无副作用（除注入的 appendArchive）——

  /** proposeCandidates：对基线四权重做确定性扰动产 N 个候选变体（零 LLM；本地脑变异由 runShadowCycle 内部走）。 */
  function proposeCandidates(base = baseline, opts = {}) {
    const seed = normalizeWeights(base, baseline);
    const grid = mutateWeightsGrid(seed, opts);
    const limit = Math.max(1, Number(opts.maxCandidates) || maxCandidates);
    return grid.slice(0, limit).map((g) => g.weights);
  }

  /** evaluateCandidate：用注入 scoreFn（优先）或 holdout 评测尺子给单个候选打分；fail-open。 */
  async function evaluateCandidate(candidate, opts = {}) {
    const w = normalizeWeights(candidate, baseline);
    const fn = typeof opts.scoreFn === 'function' ? opts.scoreFn : scoreFn;
    if (typeof fn === 'function') {
      try {
        const candidateScore = round4(num(await fn(w), 0));
        const baselineScore = round4(num(await fn(baseline), 0));
        return { ok: true, holdoutDelta: round4(candidateScore - baselineScore), baselineScore, candidateScore, semanticMean: candidateScore, semanticLowConfidence: null, evaluatorOk: true };
      } catch (e) {
        return { ok: false, holdoutDelta: 0, baselineScore: 0, candidateScore: 0, semanticMean: null, semanticLowConfidence: null, evaluatorOk: false, evalError: clean(e?.message || e, 200) };
      }
    }
    return evalCandidateWeights(w);
  }

  /** selectPareto：多目标非支配前沿（最大化 holdoutDelta + 语义均分，最小化漂移）。 */
  function selectPareto(scored) {
    return paretoFront(Array.isArray(scored) ? scored : [], [
      { key: 'holdoutDelta', dir: 'max' },
      { key: 'semanticMean', dir: 'max' },
      { key: 'minimalChange', dir: 'min' },
    ]);
  }

  /** toArchiveRecord：产纯对象归档记录（candidate + 证据 + Pareto 标记 + 采纳建议 + ts）；调用方负责落 kv/文件，本模块不碰 fs。 */
  function toArchiveRecord({ ts = now(), source = 'grid', regret = { total: 0, weakCount: 0 }, evaluated = [], front = [], recommendation = null } = {}) {
    const frontIds = new Set((Array.isArray(front) ? front : []).map((c) => c.candidateId));
    const rec = recommendation && typeof recommendation === 'object' ? recommendation : { recommended: null, reason: 'no_recommendation', eligibleCount: 0 };
    // adopted：仅当采纳门 ON 且有合格推荐时为 true。即便 true 也只是「系统建议采纳」标志——绝不写 production/.env/workspace。
    const adopted = adoptEnabled && rec.recommended ? true : false;
    return {
      schemaVersion: NOE_REFLECTIVE_TUNER_SCHEMA_VERSION,
      ts,
      kind: 'reflective_tuner_shadow_cycle',
      shadow: true,
      // 给 owner 看的硬声明：系统绝不自动落地权重。adoptEnabled OFF=纯观察候选；ON=系统会标「建议采纳谁」，仍需 owner 人工抄进 .env。
      adoption: adoptEnabled ? 'recommend_only' : 'observe_only',
      adopted,
      note: adopted
        ? '系统【建议采纳】下方 recommendation 候选（adoptEnabled=ON）。但本条未写 production、未改 .env、未改 live workspace、未触发 patch-apply——owner 需人工把 recommendation.weights 抄进 .env NOE_WS_SALIENCE_* 才真生效。'
        : '纯 shadow 观察候选（adoptEnabled=OFF）；未写 production、未改 .env、未改 live workspace、未触发 patch-apply。owner 审阅后人工决定是否采纳。',
      baselineWeights: baseline,
      mutationSource: source,
      regret: { total: regret?.total ?? 0, weakCount: regret?.weakCount ?? 0 },
      scenarioCount: sceneList.length,
      evaluatedCount: (Array.isArray(evaluated) ? evaluated : []).length,
      candidates: (Array.isArray(evaluated) ? evaluated : []).map((c) => ({ ...c, paretoOptimal: frontIds.has(c.candidateId) })),
      paretoFront: (Array.isArray(front) ? front : []).map((c) => ({ candidateId: c.candidateId, weights: c.weights, objectives: c.objectives })),
      // 采纳建议（observe/recommend 两态都写，便于 owner 看「若采纳会选谁 + 为何」）。
      recommendation: {
        recommendedId: rec.recommended?.candidateId ?? null,
        weights: rec.recommended?.weights ?? null,
        holdoutDelta: rec.recommended ? num(rec.recommended?.objectives?.holdoutDelta, null) : null,
        eligibleCount: rec.eligibleCount ?? 0,
        reason: clean(rec.reason || 'no_recommendation', 80),
      },
    };
  }

  /**
   * 跑一轮 shadow GEPA：读失败/低分轨迹 → 变异 → 评测 → Pareto 选优 → 写 archive 候选 + 证据 ledger。
   * 【绝不写 production 参数、不改 .env、不改 live workspace、不调 patch-apply】——返回值仅供观测，唯一盘写
   * 是 appendArchive（注入实现）。OFF 时 server 不构造本工厂，故零回归。
   * @param {object} input
   * @param {Array} [input.traces] consciousness/*.jsonl 预读的轨迹行（失败/低分来源）。
   * @returns {Promise<{ok:boolean, schemaVersion:number, ts:number, shadow:true, baselineWeights:object,
   *   mutationSource:string, evaluated:number, candidates:Array, paretoFront:Array, archived:boolean}>}
   */
  async function runShadowCycle({ traces = [] } = {}) {
    // env NOE_REFLECTIVE_TUNER 默认 OFF：OFF 时整轮空转、零盘写、零评测（server 在 OFF 时本就不构造本工厂，此为双保险）。
    if (!enabled) {
      return { ok: true, schemaVersion: NOE_REFLECTIVE_TUNER_SCHEMA_VERSION, ts: now(), shadow: true, adoption: adoptEnabled ? 'recommend_only' : 'observe_only', adopted: false, baselineWeights: baseline, mutationSource: 'disabled', evaluated: 0, candidates: [], paretoFront: [], recommendation: { recommendedId: null, weights: null, holdoutDelta: null, eligibleCount: 0, reason: 'disabled' }, archived: false };
    }
    const ts = now();
    const { source, regret, candidates } = await mutate(traces);
    const evaluated = [];
    for (const c of candidates) {
      const evalResult = await evalCandidateWeights(c.weights); // 串行评测，不设超时
      evaluated.push({
        candidateId: `rtc-${ts.toString(36)}-${evaluated.length + 1}`,
        weights: c.weights,
        note: c.note,
        drift: driftFrom(c.weights),
        objectives: {
          holdoutDelta: evalResult.holdoutDelta,
          semanticMean: num(evalResult.semanticMean, 0),
          minimalChange: driftFrom(c.weights), // Pareto 里取 min（越接近基线越好）
        },
        evaluation: evalResult,
      });
    }
    const front = selectPareto(evaluated);
    // 采纳判定（反向 probe 拒绝点）：只在 Pareto 前沿 + 严格改善 + 评测器真跑通的候选里挑；坏参数（delta≤门槛）永不被选。
    const recommendation = recommendAdoption(evaluated, front, { minDelta: adoptMinDelta });
    const ledger = toArchiveRecord({ ts, source, regret, evaluated, front, recommendation }); // candidates 已带 paretoOptimal 标记

    let archived = false;
    if (typeof appendArchive === 'function') {
      try {
        appendArchive(new Date(ts).toISOString().slice(0, 10), ledger);
        archived = true;
      } catch { archived = false; } // archive 写失败不阻断（observability 降级，绝不锁死）
    }

    return {
      ok: true,
      schemaVersion: NOE_REFLECTIVE_TUNER_SCHEMA_VERSION,
      ts,
      shadow: true,
      adoption: ledger.adoption,
      adopted: ledger.adopted,
      baselineWeights: baseline,
      mutationSource: source,
      evaluated: evaluated.length,
      candidates: ledger.candidates,
      paretoFront: ledger.paretoFront,
      recommendation: ledger.recommendation,
      archived,
    };
  }

  // tick：spec 编排入口。enabled=false → 直接 return [] 空候选数组（零 propose/evaluate/archive、零副作用，符合 spec 契约）；
  //   enabled=true → 跑整轮并返回本轮候选 archive 记录数组（即 ledger.candidates，调用方人工审后决定是否采纳）。
  async function tick(input = {}) {
    if (!enabled) return [];
    const out = await runShadowCycle(input);
    return Array.isArray(out?.candidates) ? out.candidates : [];
  }

  /** recommendAdopt：对一组已评测候选 + 前沿给采纳建议（实例级便捷封装；纯函数版见模块导出 recommendAdoption）。 */
  function recommendAdopt(evaluated, front, opts = {}) {
    return recommendAdoption(evaluated, front, { minDelta: adoptMinDelta, ...opts });
  }

  return {
    // spec 命名 API
    proposeCandidates, evaluateCandidate, selectPareto, toArchiveRecord, tick,
    // 既有 API（server 接线 + 镜像/选赢家工具）
    runShadowCycle, scoreSalienceShadow, pickWinnerShadow,
    // 采纳门（standing-grant；recommendAdopt 只建议不落地）
    recommendAdopt,
    baselineWeights: baseline, enabled, adoptEnabled,
  };
}
