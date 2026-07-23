import { describe, expect, it } from 'vitest';
import {
  buildQqPreviewEvent,
  buildSocialIntegrationChecklist,
  buildWeChatContractProbe,
  summarizeQqPreview,
  summarizeWeChatContract,
} from '../../public/src/web/noe-world-social-actions.js';

describe('Noe world social actions', () => {
  it('builds a no-secret social integration checklist from status projections', () => {
    const text = buildSocialIntegrationChecklist({
      readiness: {
        credentialSummary: { total: 4, available: 1, configuredUnavailable: 1, missing: 2 },
        credentialStatuses: {
          wechatOfficialToken: {
            id: 'wechatOfficialToken',
            status: 'available',
            key: 'WECHAT_OFFICIAL_TOKEN',
            reason: 'configured',
            secret: 'wechat-secret-value',
          },
        },
      },
      qq: {
        readyForDryRun: true,
        readyForLiveWebhook: false,
        credentialSummary: { total: 4, available: 0, missing: 4 },
        credentials: {
          credentialStatuses: {
            appSecret: {
              id: 'appSecret',
              status: 'missing',
              key: 'QQ_BOT_APP_SECRET',
              value: 'qq-secret-value',
            },
          },
        },
        blockers: ['qq_bot_app_secret_not_configured'],
      },
      wechatPersonal: { loginState: 'not_configured', ownerVisibleEvidenceRequired: true },
      publicEndpoints: { wechatOfficial: '/api/noe/social-inbound/wechat-official' },
      ownerEndpoints: { qqPreview: '/api/noe/social-inbound/qq/preview' },
    });
    expect(text).toContain('社交凭据：1/4 可用');
    expect(text).toContain('微信公众号凭据：可用（凭据名已记录）');
    expect(text).toContain('扣扣 应用密钥：缺失（凭据名已记录）');
    expect(text).toContain('扣扣阻塞：扣扣应用密钥未配置');
    expect(text).toContain('个人微信：未配置');
    expect(text).toContain('扣扣预演：/api/noe/social-inbound/qq/preview');
    expect(text).toContain('/api/noe/social-inbound/qq/preview');
    expect(text).toContain('秘密值：未返回');
    expect(text).not.toContain('not_configured');
    expect(text).not.toContain('qq_bot_app_secret_not_configured');
    expect(text).not.toContain('wechat-secret-value');
    expect(text).not.toContain('qq-secret-value');
  });

  it('builds safe world action payloads and summaries', () => {
    const event = buildQqPreviewEvent(123);
    expect(event).toMatchObject({
      t: 'GROUP_AT_MESSAGE_CREATE',
      d: {
        id: 'noe-earth-preview-123',
        group_openid: 'noe-earth-preview-group',
      },
    });
    expect(JSON.stringify(event)).not.toMatch(/token|secret|cookie/i);
    expect(summarizeQqPreview({
      ok: true,
      channel: 'qq_official',
      normalized: { channel: 'qq_official', text: '诺伊地球扣扣入站预演' },
    })).toContain('未投递');
    expect(buildWeChatContractProbe()).toMatchObject({ channel: 'wechat_clawbot' });
    expect(summarizeWeChatContract({
      ok: false,
      allowed: false,
      errors: ['owner_visible_evidence_required'],
      reason: 'owner_visible_evidence_missing',
    })).toContain('未发送真实消息');
  });
});
