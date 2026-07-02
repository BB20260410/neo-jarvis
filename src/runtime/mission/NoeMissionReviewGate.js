// @ts-check
import { redactSensitiveText } from '../NoeContextScrubber.js';

const AUTONOMY_RANK = {
  read_only: 0,
  local_write: 1,
  live_write: 2,
  external_write: 3,
};

function clean(value, max = 500) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function actionRisks(action = {}) {
  const risks = new Set(asArray(action.risks).map((item) => clean(item, 120)).filter(Boolean));
  const text = `${action.type || ''} ${action.id || ''} ${action.description || ''}`.toLowerCase();
  if (action.requiresOwnerGate === true) risks.add('owner_gate');
  if (action.requiresReviewBrain === true) risks.add('review_brain');
  if (/delete|remove|publish|external|live|identity|memory_write|secret|token/.test(text)) risks.add('high_risk');
  if (/external/.test(text) || action.autonomyLevel === 'external_write') risks.add('external_write');
  if (/live/.test(text) || action.autonomyLevel === 'live_write') risks.add('live_write');
  if (/delete|remove/.test(text)) risks.add('delete');
  if (/publish/.test(text)) risks.add('publish');
  if (/secret|token/.test(text)) risks.add('secret_access');
  if (/identity|memory_write/.test(text)) risks.add('identity_memory_write');
  return [...risks];
}

function requiredAutonomy(action = {}) {
  const level = clean(action.autonomyLevel || '', 80);
  if (AUTONOMY_RANK[level] != null) return level;
  const risks = actionRisks(action);
  if (risks.includes('external_write')) return 'external_write';
  if (risks.includes('live_write')) return 'live_write';
  if (risks.includes('delete') || risks.includes('publish') || risks.includes('identity_memory_write')) return 'local_write';
  return 'read_only';
}

export class NoeMissionReviewGate {
  evaluate({ mission = {}, action = {} } = {}) {
    const missionLevel = clean(mission.autonomyLevel || 'read_only', 80);
    const requiredLevel = requiredAutonomy(action);
    const risks = actionRisks(action);
    const reviewPolicy = mission.reviewPolicy || {};
    const ownerGate = asArray(reviewPolicy.ownerGate).map((item) => clean(item, 120));
    const reviewBrain = asArray(reviewPolicy.reviewBrain).map((item) => clean(item, 120));
    const reasons = [];
    if ((AUTONOMY_RANK[requiredLevel] ?? 0) > (AUTONOMY_RANK[missionLevel] ?? 0)) {
      reasons.push(`autonomy_exceeded:${missionLevel}->${requiredLevel}`);
    }
    for (const risk of risks) {
      if (ownerGate.includes(risk) || risk === 'owner_gate') reasons.push(`owner_gate_required:${risk}`);
      if (reviewBrain.includes(risk) || risk === 'review_brain') reasons.push(`review_brain_required:${risk}`);
    }
    return {
      ok: reasons.length === 0,
      status: reasons.length === 0 ? 'allowed' : 'waiting_approval',
      reasons: [...new Set(reasons)],
      risks,
      missionAutonomyLevel: missionLevel,
      requiredAutonomyLevel: requiredLevel,
    };
  }
}
