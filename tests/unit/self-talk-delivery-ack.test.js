import { describe, expect, it } from 'vitest';
import {
  applyDeliveryAckToLanding,
  createSelfTalkDeliveryAck,
  deliveryFromAck,
  isOwnerPerceivedDelivery,
} from '../../src/cognition/SelfTalkDeliveryAck.js';
import { createSelfTalkLandingEffect } from '../../src/cognition/SelfTalkOutcome.js';

const T0 = 1_781_253_600_000;

describe('SelfTalkDeliveryAck', () => {
  it('keeps synthesized separate from owner-perceived delivery', () => {
    const ack = createSelfTalkDeliveryAck({
      proposalId: 'delivery-001',
      status: 'synthesized',
      at: T0,
    });
    const delivery = deliveryFromAck(ack);

    expect(delivery.status).toBe('synthesized');
    expect(delivery.confirmedAt).toBe(null);
    expect(isOwnerPerceivedDelivery(delivery)).toBe(false);
  });

  it('converts telemetry playback ack into played_to_user_confirmed delivery', () => {
    const ack = createSelfTalkDeliveryAck({
      proposalId: 'delivery-002',
      status: 'played_to_user_confirmed',
      at: T0 + 10,
      confirmationSource: 'telemetry',
      playbackId: 'front-end-audio-1',
    });
    const landing = createSelfTalkLandingEffect({
      proposalId: 'delivery-002',
      type: 'awareness',
      targetId: 'spoken-1',
      at: T0,
      delivery: { status: 'synthesized' },
    });
    const updated = applyDeliveryAckToLanding(landing, ack);

    expect(updated.delivery).toMatchObject({
      status: 'played_to_user_confirmed',
      confirmedAt: T0 + 10,
      confirmationSource: 'telemetry',
    });
    expect(isOwnerPerceivedDelivery(updated)).toBe(true);
  });

  it('allows manual evidence confirmation but still requires a valid source', () => {
    const ack = createSelfTalkDeliveryAck({
      proposalId: 'delivery-003',
      status: 'played_to_user_confirmed',
      at: T0 + 20,
      confirmationSource: 'manual_evidence',
    });
    expect(isOwnerPerceivedDelivery(deliveryFromAck(ack))).toBe(true);

    expect(() => createSelfTalkDeliveryAck({
      proposalId: 'delivery-003',
      status: 'played_to_user_confirmed',
      at: T0 + 20,
      confirmationSource: 'browser_log',
    })).toThrow(/confirmationSource/);
  });

  it('rejects delivery ack for the wrong proposal', () => {
    const landing = createSelfTalkLandingEffect({
      proposalId: 'delivery-004',
      type: 'awareness',
      at: T0,
    });
    const ack = createSelfTalkDeliveryAck({
      proposalId: 'different-proposal',
      status: 'played_to_user_confirmed',
      at: T0 + 1,
    });

    expect(() => applyDeliveryAckToLanding(landing, ack)).toThrow(/proposalId mismatch/);
  });

  it('scrubs failure error text before audit usage', () => {
    const ack = createSelfTalkDeliveryAck({
      proposalId: 'delivery-005',
      status: 'play_failed',
      at: T0,
      error: 'decode failed owner@example.com https://x.test/audio?token=secret123&ok=1',
    });

    expect(ack.error).toContain('[redacted-email]');
    expect(ack.error).toContain('token=[redacted]');
    expect(ack.error).not.toContain('secret123');
    expect(isOwnerPerceivedDelivery(deliveryFromAck(ack))).toBe(false);
  });
});
