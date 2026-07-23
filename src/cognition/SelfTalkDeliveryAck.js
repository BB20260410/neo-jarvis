// @ts-check
// SelfTalkDeliveryAck — P6 delivery confirmation protocol helpers.
//
// TTS synthesis is not the same as owner perception. These helpers model the
// future frontend/WebSocket ack without requiring frontend or live-server wiring.

import { createSelfTalkDelivery } from './SelfTalkOutcome.js';

export const SELF_TALK_DELIVERY_ACK_TYPES = Object.freeze([
  'queued',
  'synthesized',
  'played_to_user_confirmed',
  'tts_failed',
  'play_failed',
]);

export const SELF_TALK_CONFIRMATION_SOURCES = Object.freeze(['telemetry', 'manual_evidence']);

function assertOneOf(value, allowed, field) {
  if (!allowed.includes(value)) throw new TypeError(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

function assertProposalId(value) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError('proposalId is required');
  return value.trim();
}

function toMs(value, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new TypeError(`${field} must be a non-negative timestamp`);
  return n;
}

function scrubError(value) {
  const s = String(value || '').replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[redacted-email]');
  return s.replace(/([?&](?:token|key|secret|password|ownerToken)=)[^&\s]+/gi, '$1[redacted]').slice(0, 160);
}

export function createSelfTalkDeliveryAck({
  proposalId,
  status,
  at = Date.now(),
  confirmationSource = 'telemetry',
  playbackId = null,
  error = null,
} = {}) {
  const normalizedStatus = assertOneOf(status, SELF_TALK_DELIVERY_ACK_TYPES, 'deliveryAck.status');
  const isConfirmed = normalizedStatus === 'played_to_user_confirmed';
  const isFailure = normalizedStatus === 'tts_failed' || normalizedStatus === 'play_failed';
  if (isConfirmed) assertOneOf(confirmationSource, SELF_TALK_CONFIRMATION_SOURCES, 'deliveryAck.confirmationSource');

  return Object.freeze({
    proposalId: assertProposalId(proposalId),
    status: normalizedStatus,
    at: toMs(at, 'deliveryAck.at'),
    confirmationSource: isConfirmed ? confirmationSource : null,
    playbackId: playbackId == null ? null : String(playbackId).slice(0, 120),
    error: isFailure ? scrubError(error) : null,
  });
}

export function deliveryFromAck(ack) {
  if (!ack?.status) throw new TypeError('delivery ack is required');
  if (ack.status === 'played_to_user_confirmed') {
    return createSelfTalkDelivery({
      status: 'played_to_user_confirmed',
      confirmedAt: ack.at,
      confirmationSource: ack.confirmationSource || 'telemetry',
    });
  }
  return createSelfTalkDelivery({ status: ack.status });
}

export function applyDeliveryAckToLanding(landing, ack) {
  if (!landing?.proposalId) throw new TypeError('landing is required');
  if (!ack?.proposalId) throw new TypeError('delivery ack is required');
  if (landing.proposalId !== ack.proposalId) throw new TypeError('proposalId mismatch between landing and delivery ack');
  return Object.freeze({
    ...landing,
    delivery: deliveryFromAck(ack),
  });
}

export function isOwnerPerceivedDelivery(value) {
  const delivery = value?.delivery || value;
  return delivery?.status === 'played_to_user_confirmed'
    && Number.isFinite(Number(delivery.confirmedAt))
    && SELF_TALK_CONFIRMATION_SOURCES.includes(delivery.confirmationSource);
}
