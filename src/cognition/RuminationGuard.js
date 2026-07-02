// @ts-check
// RuminationGuard — P6-C pure guard for self-talk spiral control.
//
// Signal contract: this guard reads raw timeline/self-talk metrics. It must not
// consume AffectEngine VAD, because inner_monologue is emotion-neutralized there
// to prevent self-excited mood loops.

export const RUMINATION_SIGNAL_CONTRACT = Object.freeze({
  readsVad: false,
  readsRawTimeline: true,
  reason: 'inner_monologue is neutralized in AffectEngine; guard decisions use raw episode evidence',
});

export const RUMINATION_MODES = Object.freeze(['audit', 'normal', 'anchored', 'off']);
export const RUMINATION_STATES = Object.freeze(['normal', 'rotate', 'anchor', 'cooldown', 'silent']);

export const DEFAULT_RUMINATION_THRESHOLDS = Object.freeze({
  normal: Object.freeze({
    rotateSemanticSim: 0.55,
    anchorSemanticSim: 0.72,
    minGroundingScore: 0.35,
    maxAbstractDensity: 0.62,
    rotateLandingStreak: 3,
    cooldownLandingStreak: 5,
    cooldownSelfTalkRatio: 2.0,
  }),
  anchored: Object.freeze({
    rotateSemanticSim: 0.40,
    anchorSemanticSim: 0.62,
    minGroundingScore: 0.45,
    maxAbstractDensity: 0.52,
    rotateLandingStreak: 2,
    cooldownLandingStreak: 4,
    cooldownSelfTalkRatio: 1.5,
  }),
});

const ABSTRACT_HINTS = [
  '意识',
  '自由',
  '存在',
  '本质',
  '逻辑',
  '意义',
  '关系',
  '系统',
  '模式',
  '边界',
  '焦虑',
  '卡住',
  '循环',
  '反刍',
  '抽象',
];

function assertMode(mode) {
  if (!RUMINATION_MODES.includes(mode)) throw new TypeError(`mode must be one of: ${RUMINATION_MODES.join(', ')}`);
  return mode;
}

function finiteOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp01(value) {
  const n = finiteOrNull(value);
  if (n == null) return null;
  return Math.max(0, Math.min(1, n));
}

function lexicalSimilarity(a, b) {
  const aa = String(a || '').replace(/\s+/g, '');
  const bb = String(b || '').replace(/\s+/g, '');
  if (!aa || !bb) return null;
  if (aa === bb) return 1;
  const [short, long] = aa.length <= bb.length ? [aa, bb] : [bb, aa];
  if (short.length >= 6 && long.includes(short)) return 0.85;
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(aa);
  const gb = grams(bb);
  if (!ga.size || !gb.size) return null;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared++;
  return shared / Math.max(ga.size, gb.size);
}

function estimateAbstractDensity(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  const hits = ABSTRACT_HINTS.reduce((n, hint) => n + (s.includes(hint) ? 1 : 0), 0);
  return Math.max(0, Math.min(1, hits / Math.max(4, Math.ceil(s.length / 18))));
}

function isSelfTalkEpisode(e) {
  return e?.type === 'inner_monologue' && e?.meta?.streamType === 'self_talk';
}

function isRealExperience(e) {
  return e?.type && e.type !== 'inner_monologue';
}

export function computeRuminationMetrics({
  recentEpisodes = [],
  candidate = '',
  textSimilarity = null,
  groundingScore = null,
  abstractDensity = null,
  landingStreak = 0,
} = {}) {
  const episodes = Array.isArray(recentEpisodes) ? recentEpisodes : [];
  const selfTalk = episodes.filter(isSelfTalkEpisode);
  const realExperiences = episodes.filter(isRealExperience);
  const lastSelfTalk = selfTalk[0]?.summary || '';
  let semanticSim = null;
  if (candidate && lastSelfTalk) {
    try {
      semanticSim = typeof textSimilarity === 'function'
        ? clamp01(textSimilarity(candidate, lastSelfTalk))
        : clamp01(lexicalSimilarity(candidate, lastSelfTalk));
    } catch {
      semanticSim = null;
    }
  }

  return Object.freeze({
    semanticSim,
    groundingScore: clamp01(groundingScore),
    abstractDensity: clamp01(abstractDensity ?? estimateAbstractDensity(candidate)),
    recentSelfTalkRatio: selfTalk.length / Math.max(1, realExperiences.length),
    landingStreak: Math.max(0, Number(landingStreak) || 0),
    rawCounts: Object.freeze({
      selfTalk: selfTalk.length,
      realExperiences: realExperiences.length,
    }),
  });
}

function pickState(metrics, profile) {
  const reasons = [];
  const sim = finiteOrNull(metrics.semanticSim);
  const grounding = finiteOrNull(metrics.groundingScore);
  const abstractDensity = finiteOrNull(metrics.abstractDensity);
  const ratio = finiteOrNull(metrics.recentSelfTalkRatio) ?? 0;
  const landing = finiteOrNull(metrics.landingStreak) ?? 0;

  if (landing >= profile.cooldownLandingStreak) reasons.push(`landing_streak:${landing}`);
  if (ratio >= profile.cooldownSelfTalkRatio) reasons.push(`self_talk_ratio:${ratio.toFixed(2)}`);
  if (reasons.length) return { state: 'cooldown', reasons };

  if (sim != null && sim >= profile.anchorSemanticSim) reasons.push(`semantic_sim_anchor:${sim.toFixed(2)}`);
  if (grounding != null && grounding < profile.minGroundingScore) reasons.push(`low_grounding:${grounding.toFixed(2)}`);
  if (abstractDensity != null && abstractDensity > profile.maxAbstractDensity) reasons.push(`abstract_density:${abstractDensity.toFixed(2)}`);
  if (reasons.length) return { state: 'anchor', reasons };

  if (sim != null && sim >= profile.rotateSemanticSim) reasons.push(`semantic_sim_rotate:${sim.toFixed(2)}`);
  if (landing >= profile.rotateLandingStreak) reasons.push(`landing_streak_rotate:${landing}`);
  if (reasons.length) return { state: 'rotate', reasons };

  return { state: 'normal', reasons: [] };
}

export function decideRuminationGuard({
  mode = 'audit',
  metrics = {},
  thresholds = DEFAULT_RUMINATION_THRESHOLDS,
} = {}) {
  const normalizedMode = assertMode(mode);
  if (normalizedMode === 'off') {
    return Object.freeze({
      mode: normalizedMode,
      state: 'silent',
      action: 'block',
      wouldBlock: true,
      shadowWouldBlock: true,
      reasons: Object.freeze(['inner_mode_off']),
      rawMetrics: Object.freeze({ ...metrics }),
    });
  }

  const profile = normalizedMode === 'anchored' ? thresholds.anchored : thresholds.normal;
  const picked = pickState(metrics, profile);
  const productionWouldBlock = picked.state === 'cooldown' || picked.state === 'silent';
  const action = normalizedMode === 'audit'
    ? 'allow'
    : productionWouldBlock ? 'block' : picked.state;

  return Object.freeze({
    mode: normalizedMode,
    state: picked.state,
    action,
    wouldBlock: normalizedMode === 'audit' ? false : productionWouldBlock,
    shadowWouldBlock: productionWouldBlock,
    reasons: Object.freeze(picked.reasons),
    rawMetrics: Object.freeze({ ...metrics }),
  });
}

export function createRuminationAuditRecord({
  proposalId,
  mode = 'audit',
  decision,
  redactionPolicy = 'strict',
} = {}) {
  if (!proposalId) throw new TypeError('proposalId is required');
  if (!decision?.state) throw new TypeError('decision is required');
  return Object.freeze({
    proposalId: String(proposalId),
    channel: 'rumination_guard',
    redactionPolicy,
    mode,
    state: decision.state,
    action: decision.action,
    wouldBlock: decision.wouldBlock,
    shadowWouldBlock: decision.shadowWouldBlock,
    reasons: decision.reasons,
    rawMetrics: decision.rawMetrics,
    signalContract: RUMINATION_SIGNAL_CONTRACT,
  });
}
