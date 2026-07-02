// @ts-check
// SelfTalkLandingPolicy — P6-D "if it thinks, it must land" pure policy.
//
// A self-talk item is not allowed to grow into an endless private stream. After
// a short streak, the next thought must either become an expectation/commitment/
// goal/memory/awareness, or explicitly close as silent. Silent clears the loop
// for compliance, but it is not counted as owner-perceived delivery.

import { rate } from './_mathUtils.js';

export const DEFAULT_SELF_TALK_LANDING_POLICY = Object.freeze({
  maxUnlandedStreak: 3,
  complianceLandingTypes: Object.freeze(['expectation', 'commitment', 'goal', 'memory', 'awareness', 'silent']),
  externalLandingTypes: Object.freeze(['expectation', 'commitment', 'goal', 'memory', 'awareness']),
});

function isSelfTalkOutcome(record) {
  return record?.channel === 'self_talk_outcome' || record?.proposal?.streamType === 'self_talk' || record?.streamType === 'self_talk';
}

function isCommitted(record) {
  if (record?.commit?.committed != null) return record.commit.committed === true;
  return record?.committed === true;
}

function landingType(record) {
  return record?.landing?.type || null;
}

function isSilentClosure(record) {
  return landingType(record) === 'silent';
}

export function isComplianceLanding(type, policy = DEFAULT_SELF_TALK_LANDING_POLICY) {
  return policy.complianceLandingTypes.includes(type);
}

export function isExternalLanding(type, policy = DEFAULT_SELF_TALK_LANDING_POLICY) {
  return policy.externalLandingTypes.includes(type);
}

export function computeSelfTalkLandingWindow(records = [], {
  policy = DEFAULT_SELF_TALK_LANDING_POLICY,
} = {}) {
  const outcomes = (Array.isArray(records) ? records : []).filter((record) => isSelfTalkOutcome(record));
  let committed = 0;
  let complianceLandings = 0;
  let externalLandings = 0;
  let silentClosures = 0;
  let unlandedStreak = 0;

  for (const record of outcomes) {
    const type = landingType(record);
    const committedOrClosed = isCommitted(record) || isSilentClosure(record);
    if (!committedOrClosed) continue;
    committed++;
    if (isComplianceLanding(type, policy)) {
      complianceLandings++;
      if (type === 'silent') silentClosures++;
      if (isExternalLanding(type, policy)) externalLandings++;
      unlandedStreak = 0;
    } else {
      unlandedStreak++;
    }
  }

  return Object.freeze({
    committedSelfTalk: committed,
    complianceLandings,
    externalLandings,
    silentClosures,
    unlandedStreak,
    landingComplianceRate: rate(complianceLandings, committed),
    externalLandingRate: rate(externalLandings, committed),
    mustLandNext: unlandedStreak >= policy.maxUnlandedStreak,
    maxUnlandedStreak: policy.maxUnlandedStreak,
  });
}

export function decideSelfTalkLandingRequirement(records = [], {
  policy = DEFAULT_SELF_TALK_LANDING_POLICY,
  candidateType = null,
} = {}) {
  const window = computeSelfTalkLandingWindow(records, { policy });
  const candidateWouldComply = isComplianceLanding(candidateType, policy);
  return Object.freeze({
    required: window.mustLandNext,
    satisfiedByCandidate: !window.mustLandNext || candidateWouldComply,
    reason: window.mustLandNext ? `unlanded_streak:${window.unlandedStreak}` : null,
    allowedTypes: policy.complianceLandingTypes,
    fallbackType: 'silent',
    window,
  });
}
