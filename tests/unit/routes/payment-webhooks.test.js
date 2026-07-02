import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { buildIssuedWebhookResponse, normalizeWebhookSecretInput, verifySignature } from '../../../src/server/routes/payment-webhooks.js';

const SECRET = 'test-secret-32-chars-1234567890ab';
const PAYLOAD = JSON.stringify({ event: 'order_created', data: { id: 1 } });

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('verifySignature', () => {
  it('正例 - 正确签名通过', () => {
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), SECRET)).toBe(true);
  });

  it('正例 - sha256= 前缀也通过', () => {
    expect(verifySignature(PAYLOAD, 'sha256=' + sign(PAYLOAD, SECRET), SECRET)).toBe(true);
  });

  it('反例 - 错误 secret 拒绝', () => {
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), 'wrong-secret')).toBe(false);
  });

  it('反例 - 篡改 payload 拒绝', () => {
    expect(verifySignature(PAYLOAD + 'x', sign(PAYLOAD, SECRET), SECRET)).toBe(false);
  });

  it('反例 - 长度不一致拒绝（防 timingSafeEqual 抛错）', () => {
    expect(verifySignature(PAYLOAD, 'aabb', SECRET)).toBe(false);
  });

  it('反例 - 非 hex 签名拒绝', () => {
    expect(verifySignature(PAYLOAD, 'not-hex-at-all', SECRET)).toBe(false);
  });

  it('反例 - 空签名拒绝', () => {
    expect(verifySignature(PAYLOAD, '', SECRET)).toBe(false);
  });

  it('反例 - 空 secret 拒绝', () => {
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), '')).toBe(false);
  });

  it('反例 - null 签名/secret 拒绝', () => {
    expect(verifySignature(PAYLOAD, null, SECRET)).toBe(false);
    expect(verifySignature(PAYLOAD, sign(PAYLOAD, SECRET), null)).toBe(false);
  });
});

describe('buildIssuedWebhookResponse', () => {
  it('签发成功响应不回传完整 license，避免泄露到第三方 webhook 日志', () => {
    const license = 'license.secret.payload.signature';
    const response = buildIssuedWebhookResponse({ email: 'buyer@example.com', tier: 'pro', license });

    expect(response).toMatchObject({
      ok: true,
      issued: true,
      email: 'buyer@example.com',
      tier: 'pro',
      licenseReturned: false,
    });
    expect(response).not.toHaveProperty('license');
    expect(JSON.stringify(response)).not.toContain(license);
  });
});

describe('normalizeWebhookSecretInput', () => {
  it('只接受足够长的字符串 secret，并在保存前 trim', () => {
    expect(normalizeWebhookSecretInput('  test-secret-32-chars-1234567890ab  ')).toEqual({
      ok: true,
      value: 'test-secret-32-chars-1234567890ab',
    });
  });

  it('拒绝非字符串和过短 secret', () => {
    expect(normalizeWebhookSecretInput(['not', 'a', 'secret'])).toMatchObject({ ok: false });
    expect(normalizeWebhookSecretInput({ value: SECRET })).toMatchObject({ ok: false });
    expect(normalizeWebhookSecretInput('   too-short   ')).toMatchObject({ ok: false });
  });
});
