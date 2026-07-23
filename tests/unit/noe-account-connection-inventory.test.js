import { describe, expect, it } from 'vitest';
import { buildNoeAccountConnectionInventory } from '../../src/runtime/NoeAccountConnectionInventory.js';

describe('NoeAccountConnectionInventory', () => {
  it('lists social account connection surfaces without reading account secrets', () => {
    const out = buildNoeAccountConnectionInventory({
      args: {
        platforms: ['douyin', 'xiaohongshu'],
        browserState: {
          activeBrowser: {
            app: 'Google Chrome',
            url: 'https://creator.douyin.com/dashboard?token=secret-value',
            title: 'Douyin Creator',
            frontmost: true,
          },
        },
      },
      realExecute: true,
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'account-connection-inventory',
      plannedOnly: false,
      externalSideEffectPerformed: false,
      publishPerformed: false,
      secretValuesReturned: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      authority: {
        canUseLoggedInAccounts: true,
        canControlOwnerAuthorizedAccounts: true,
        canPublishExternally: false,
        canReadSecrets: false,
        bypassesNoeGovernance: false,
        inventoryOnly: true,
      },
    });
    expect(out.connections.map((item) => item.platform)).toEqual(['douyin', 'xiaohongshu']);
    expect(out.connections[0]).toMatchObject({
      platform: 'douyin',
      status: 'active_browser_match',
      browser: {
        host: 'creator.douyin.com',
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
      },
    });
    expect(out.connections[0].actionChain.map((item) => item.actionId)).toContain('noe.freedom.social.final_publish.execute');
    expect(out.connections[0].actionChain.map((item) => item.actionId)).toContain('noe.freedom.browser.dom.execute');
    expect(out.connections[0].requiredAfterPublish).toContain('platform_delete_hide_or_correction_path');
    expect(out.connections[0].activePage).toMatchObject({
      platform: 'douyin',
      host: 'creator.douyin.com',
      stage: 'creator_console',
      inferredOnly: true,
    });
    expect(out.ownerAuthorizedAccountTargets[0]).toMatchObject({
      kind: 'browser_logged_in_account',
      host: 'creator.douyin.com',
      origin: 'https://creator.douyin.com',
      socialPlatform: 'douyin',
      accountAccess: {
        usesExistingLoginSession: true,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
      },
      authority: {
        developerModeCanControl: true,
        canUseBrowserAutomation: true,
        canUseLoggedInAccount: true,
        canReadSecrets: false,
      },
    });
    expect(JSON.stringify(out)).not.toContain('secret-value');
  });

  it('turns any active browser site into an owner-authorized account target without leaking URL secrets', () => {
    const out = buildNoeAccountConnectionInventory({
      args: {
        platforms: ['douyin'],
        browserState: {
          activeBrowser: {
            app: 'Google Chrome',
            url: 'https://platform.minimaxi.com/console/usage?token=secret-value',
            title: 'MiniMax Console',
            frontmost: true,
          },
          browsers: [
            {
              app: 'Safari',
              url: 'https://account.example.test/dashboard?session=plain-secret',
              title: 'Account Dashboard',
              frontmost: false,
            },
          ],
        },
      },
      realExecute: true,
    });

    expect(out.ownerAuthorizedAccountTargets).toHaveLength(2);
    expect(out.ownerAuthorizedAccountTargets[0]).toMatchObject({
      targetId: 'owner_account_platform.minimaxi.com',
      kind: 'browser_logged_in_account',
      app: 'Google Chrome',
      host: 'platform.minimaxi.com',
      origin: 'https://platform.minimaxi.com',
      urlPreview: 'https://platform.minimaxi.com/console/usage?token=%5Bredacted%5D',
      socialPlatform: null,
      authority: {
        developerModeCanControl: true,
        canUseBrowserAutomation: true,
        canBypassPlatform2faOrRiskControls: false,
      },
    });
    expect(out.ownerAuthorizedAccountTargets[1]).toMatchObject({
      host: 'account.example.test',
      origin: 'https://account.example.test',
      urlPreview: 'https://account.example.test/dashboard?session=%5Bredacted%5D',
    });
    expect(out.ownerAuthorizedAccountTargets[0].nextFreedomActions.map((item) => item.actionId)).toEqual([
      'noe.freedom.browser.state_probe',
      'noe.freedom.browser.dom.execute',
      'noe.freedom.browser.open',
    ]);
    const domProbe = out.ownerAuthorizedAccountTargets[0].nextFreedomActions.find((item) => item.actionId === 'noe.freedom.browser.dom.execute');
    expect(domProbe).toMatchObject({
      stepId: 'dom_probe_platform.minimaxi.com_read_title',
      mode: 'developer_unrestricted',
      args: {
        browserApp: 'Google Chrome',
        expectedHost: 'platform.minimaxi.com',
        actions: [{ type: 'read_title' }],
      },
    });
    expect(out.recommendedNextFreedomActions.map((item) => item.stepId)).toContain('dom_probe_platform.minimaxi.com_read_title');
    const openAction = out.recommendedNextFreedomActions.find((item) => item.stepId === 'open_platform.minimaxi.com_account_origin');
    expect(openAction).toMatchObject({
      actionId: 'noe.freedom.browser.open',
      args: { url: 'https://platform.minimaxi.com' },
    });
    expect(JSON.stringify(out)).not.toContain('secret-value');
    expect(JSON.stringify(out)).not.toContain('plain-secret');
  });

  it('infers social page state and recommends executable next actions from the active browser page', () => {
    const out = buildNoeAccountConnectionInventory({
      args: {
        platform: 'douyin',
        draftId: 'draft-42',
        title: '发布标题',
        content: '发布内容',
        mediaFiles: ['/tmp/demo.mp4'],
        browserState: {
          activeBrowser: {
            app: 'Google Chrome',
            url: 'https://creator.douyin.com/creator-micro/content/upload?token=secret-value',
            title: '发布作品 - 抖音创作者中心',
            frontmost: true,
          },
        },
      },
      realExecute: true,
    });

    const actionIds = out.recommendedNextFreedomActions.map((item) => item.actionId);
    const stepIds = out.recommendedNextFreedomActions.map((item) => item.stepId);

    expect(out.connections[0].activePage).toMatchObject({
      stage: 'publish_editor',
      confidence: 0.86,
    });
    expect(out.connections[0].activePage.reasons).toEqual(expect.arrayContaining(['publish_surface_keyword']));
    expect(actionIds).toEqual(expect.arrayContaining([
      'noe.freedom.social.publish_orchestrate',
      'noe.freedom.social.workflow.prepare',
      'noe.freedom.browser.dom.execute',
      'noe.freedom.social.preflight.run',
      'noe.freedom.social.form_fill.plan',
      'noe.freedom.social.media_upload.prepare',
    ]));
    expect(actionIds).not.toContain('noe.freedom.social.final_publish.execute');
    expect(stepIds).toContain('build_douyin_form_fill_plan_from_active_page');
    expect(stepIds).toContain('dom_fill_douyin_fields_from_active_page');
    const domFill = out.recommendedNextFreedomActions.find((item) => item.stepId === 'dom_fill_douyin_fields_from_active_page');
    expect(domFill).toMatchObject({
      actionId: 'noe.freedom.browser.dom.execute',
      mode: 'developer_unrestricted',
      args: {
        browserApp: 'Google Chrome',
        expectedHost: 'creator.douyin.com',
        actions: [
          { type: 'read_title' },
          { type: 'set_by_hints', role: 'title', hints: ['title', '标题', '作品标题'], value: '发布标题' },
          { type: 'set_by_hints', role: 'content', value: '发布内容' },
        ],
      },
    });
    const formFill = out.recommendedNextFreedomActions.find((item) => item.stepId === 'build_douyin_form_fill_plan_from_active_page');
    expect(formFill.args).toMatchObject({
      platform: 'douyin',
      draftId: 'draft-42',
      browserApp: 'Google Chrome',
    });
    expect(formFill.args.browserState.activeBrowser.url).toContain('token=%5Bredacted%5D');
    expect(JSON.stringify(out)).not.toContain('secret-value');
  });

  it('only recommends final publish from active page when explicitly requested', () => {
    const out = buildNoeAccountConnectionInventory({
      args: {
        platform: 'xiaohongshu',
        draftId: 'xhs-1',
        includeFinalPublishAction: true,
        browserState: {
          activeBrowser: {
            url: 'https://creator.xiaohongshu.com/publish/post',
            title: '发布笔记',
          },
        },
      },
    });

    expect(out.recommendedNextFreedomActions.map((item) => item.actionId)).toContain('noe.freedom.social.final_publish.execute');
    const finalPublish = out.recommendedNextFreedomActions.find((item) => item.actionId === 'noe.freedom.social.final_publish.execute');
    expect(finalPublish.stepId).toBe('execute_xiaohongshu_final_publish_from_active_page');
    expect(finalPublish.args).toMatchObject({
      platform: 'xiaohongshu',
      draftId: 'xhs-1',
    });
  });

  it('falls back to a custom platform without granting publish authority', () => {
    const out = buildNoeAccountConnectionInventory({
      args: {
        platform: 'my-custom-platform',
        browserState: { activeBrowser: { url: 'https://custom.example.test/', title: 'Custom' } },
      },
    });

    expect(out).toMatchObject({
      ok: true,
      plannedOnly: true,
      platformsChecked: ['my-custom-platform'],
      authority: { canPublishExternally: false },
    });
    expect(out.connections[0]).toMatchObject({
      platform: 'my-custom-platform',
      label: 'my-custom-platform',
      status: 'known_platform',
      browser: null,
    });
  });
});
