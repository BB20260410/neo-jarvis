// @ts-check
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function normalizeNoeTaskOutput(input = {}) {
  const finishReason = clean(input.finishReason || input.finish_reason || 'stop', 80);
  return {
    ok: input.ok !== false,
    text: clean(input.text || input.reply || input.content || '', 40_000),
    evidenceRefs: asArray(input.evidenceRefs).map((ref) => clean(ref, 1000)).filter(Boolean),
    finishReason,
    brainRoute: clean(input.brainRoute || input.route || 'unknown', 160),
    cost: input.cost && typeof input.cost === 'object' ? input.cost : {},
    durationMs: Math.max(0, Number(input.durationMs || 0)),
    provenance: clean(input.provenance || 'unknown', 80),
    provider: clean(input.provider || '', 120),
    model: clean(input.model || '', 160),
    patchPlan: input.patchPlan || null,
    claimedSucceeded: input.claimedSucceeded === true,
    truncated: input.truncated === true || finishReason === 'length',
    incomplete: input.incomplete === true || input.truncated === true || finishReason === 'length',
  };
}
