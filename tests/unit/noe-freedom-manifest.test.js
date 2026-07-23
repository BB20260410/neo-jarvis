import { describe, expect, it } from 'vitest';
import {
  NOE_FREEDOM_DEVELOPER_MODE_PROFILE,
  findNoeFreedomTool,
  listNoeFreedomQuickStarts,
  freedomToolsAsCommandManifests,
  listNoeFreedomTools,
  redactNoeFreedomPayload,
  validateNoeFreedomAuthorization,
} from '../../src/capabilities/NoeFreedomManifest.js';
import { buildNoeCommandSurface } from '../../src/capabilities/NoeCommandSurface.js';

describe('NoeFreedomManifest', () => {
  it('catalogs high-autonomy capabilities as hidden critical commands by default', () => {
    const tools = listNoeFreedomTools();
    expect(tools.map((tool) => tool.id)).toEqual(expect.arrayContaining([
      'noe.freedom.shell.execute',
      'noe.freedom.ssh.execute',
      'noe.freedom.ssh.inventory',
      'noe.freedom.keychain.read',
      'noe.freedom.env.inspect',
      'noe.freedom.desktop.inventory',
      'noe.freedom.account.connection_inventory',
      'noe.freedom.developer.readiness_audit',
      'noe.freedom.social.publish',
      'noe.freedom.social.workflow.prepare',
      'noe.freedom.social.publish_orchestrate',
      'noe.freedom.chain.execute',
      'noe.freedom.run.resume_next_actions',
      'noe.freedom.run.history',
      'noe.freedom.social.preflight.run',
      'noe.freedom.social.form_fill.plan',
      'noe.freedom.social.form_fill.execute',
      'noe.freedom.social.media_upload.prepare',
      'noe.freedom.social.media_upload.execute',
      'noe.freedom.social.final_publish.execute',
      'noe.freedom.browser.open',
      'noe.freedom.browser.state_probe',
      'noe.freedom.browser.dom.execute',
      'noe.freedom.macos.applescript.run',
      'noe.freedom.social.draft.create',
      'noe.freedom.social.draft.list',
      'noe.freedom.social.draft.cancel',
      'noe.freedom.network.upload',
      'noe.freedom.tool_marketplace.install',
      'noe.freedom.tool_marketplace.list',
      'noe.freedom.tool_marketplace.disable',
      'noe.freedom.tool_marketplace.uninstall',
    ]));
    expect(tools.every((tool) => ['high', 'critical'].includes(tool.riskLevel))).toBe(true);

    const surface = buildNoeCommandSurface();
    expect(surface.hiddenCommands.map((item) => item.id)).toContain('noe.freedom.shell.execute');
    expect(surface.visibleCommands.map((item) => item.id)).not.toContain('noe.freedom.shell.execute');
  });

  it('requires owner-supervised unrestricted mode, allowlist acceptance, and rollback for real execution', () => {
    const tool = findNoeFreedomTool('noe.freedom.social.publish');
    const rejected = validateNoeFreedomAuthorization({
      tool,
      realExecute: true,
      authorization: { mode: 'dry_run' },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toEqual(expect.arrayContaining([
      'owner_supervised_unrestricted_required_for_real_execute',
      'owner_present_required_for_real_execute',
      'allowlist_acceptance_required',
      'rollback_plan_required',
    ]));

    const accepted = validateNoeFreedomAuthorization({
      tool,
      realExecute: true,
      authorization: {
        mode: 'owner_supervised_unrestricted',
        ownerPresent: true,
        allowlistAccepted: true,
        rollbackPlan: 'delete or correct the published post from the platform console',
      },
    });
    expect(accepted.ok).toBe(true);
  });

  it('accepts developer unrestricted mode for real execution without allowlist acceptance', () => {
    const tool = findNoeFreedomTool('noe.freedom.shell.execute');
    const accepted = validateNoeFreedomAuthorization({
      tool,
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
    });

    expect(accepted.ok).toBe(true);
  });

  it('defines developer unrestricted as maximum owner-present account and computer control with three hard vetoes', () => {
    expect(NOE_FREEDOM_DEVELOPER_MODE_PROFILE).toMatchObject({
      mode: 'developer_unrestricted',
      skipsTrustManifestAndAllowlist: true,
      ownerPresenceRequired: true,
      stillRedactsSecretValues: true,
      canUseLoggedInAccounts: true,
      canControlAllOwnerAuthorizedAccounts: true,
      canUseBrowserLoggedInSessions: true,
      canUseSecretRefs: true,
      canUseKeychainSecretRefs: true,
      canUseEnvSecretRefs: true,
      canUseSshAgentAndConfiguredKeys: true,
      canRunLocalShell: true,
      canRunSsh: true,
      canRunMacAutomation: true,
      canOpenBrowserAccounts: true,
      canPublishExternally: true,
      canUploadFiles: true,
      canUseToolMarketplace: true,
      hardVetoes: [
        'system_root_delete',
        'codex_runtime_delete',
        'secret_plaintext_output',
      ],
    });
    expect(NOE_FREEDOM_DEVELOPER_MODE_PROFILE.allowedCapabilityPrefixes).toEqual(expect.arrayContaining([
      'shell.',
      'ssh.',
      'secret.',
      'desktop.',
      'account.',
      'browser.',
      'automation.',
      'social.',
      'network.',
      'tool.',
      'workflow.',
    ]));
  });

  it('exports command manifests without secret-bearing fields', () => {
    const manifests = freedomToolsAsCommandManifests();
    expect(manifests.find((item) => item.id === 'noe.freedom.keychain.read')).toBeTruthy();
    expect(JSON.stringify(manifests)).not.toMatch(/sk-|tp-|AIza|password=/i);
  });

  it('redacts secret-like URL parameters from payload previews', () => {
    const out = redactNoeFreedomPayload({
      browserState: {
        activeBrowser: {
          url: 'https://creator.douyin.com/dashboard?token=secret-value&plain=ok#session=abc',
        },
      },
    });

    expect(JSON.stringify(out)).toContain('plain=ok');
    expect(JSON.stringify(out)).not.toContain('secret-value');
    expect(JSON.stringify(out)).not.toContain('session=abc');
  });

  it('redacts browser DOM action values from payload previews', () => {
    const out = redactNoeFreedomPayload({
      actions: [
        { type: 'set_value', selector: '#password', value: 'plain-secret-value' },
        { type: 'click', selector: '#submit' },
      ],
    });

    expect(out.actions[0]).toMatchObject({
      type: 'set_value',
      selector: '#password',
      value: '[redacted]',
    });
    expect(JSON.stringify(out)).not.toContain('plain-secret-value');
  });

  it('keeps safe boolean readiness switches while redacting secret values', () => {
    const out = redactNoeFreedomPayload({
      includeProviderSecrets: true,
      includeProviderHealth: false,
      apiKey: 'sk-unitsecret-manifest-000000000000000000',
    });

    expect(out.includeProviderSecrets).toBe(true);
    expect(out.includeProviderHealth).toBe(false);
    expect(out.apiKey).toBe('[redacted]');
  });

  it('exports developer quick starts that reference real freedom tools without secrets', () => {
    const quickStarts = listNoeFreedomQuickStarts();
    expect(quickStarts.map((item) => item.id)).toEqual(expect.arrayContaining([
      'developer.shell.safe-echo',
      'desktop.inventory',
      'ssh.inventory',
      'account.connection-inventory.social',
      'developer.readiness-audit',
      'browser.open-douyin-creator',
      'social.workflow.douyin',
      'social.orchestrate.douyin',
      'social.dom-publish-actions.douyin',
      'freedom.chain.echo-and-inventory',
      'freedom.resume-next-actions.placeholder',
      'freedom.run-history.recent',
      'social.preflight.douyin',
      'social.form-fill.douyin',
      'social.form-fill-execute.douyin',
      'social.media-upload.douyin',
      'social.media-upload-execute.douyin',
      'social.final-publish.douyin',
      'social.workflow.xiaohongshu',
      'macos.jxa.front-browser-url',
      'browser.dom.read-title',
      'upload.file.placeholder',
    ]));
    expect(quickStarts.find((item) => item.id === 'macos.jxa.front-browser-url')).toMatchObject({
      actionId: 'noe.freedom.browser.state_probe',
      args: { includeAll: true },
    });
    expect(quickStarts.find((item) => item.id === 'browser.dom.read-title')).toMatchObject({
      actionId: 'noe.freedom.browser.dom.execute',
      args: { browserApp: 'Google Chrome', actions: [{ type: 'read_title' }] },
    });
    expect(quickStarts.find((item) => item.id === 'developer.readiness-audit')).toMatchObject({
      actionId: 'noe.freedom.developer.readiness_audit',
      args: {
        platforms: ['douyin', 'xiaohongshu', 'bilibili', 'wechat_channels', 'youtube'],
        includeBrowserState: true,
        includeSshInventory: true,
        includeMarketplace: true,
        includeDesktop: true,
        includeProviderSecrets: true,
        includeProviderHealth: false,
        providerSecrets: ['minimax', 'xiaomi', 'gemini', 'openai', 'anthropic'],
        keychainRefs: [],
      },
    });
    expect(quickStarts.find((item) => item.id === 'social.workflow.douyin')).toMatchObject({
      actionId: 'noe.freedom.social.workflow.prepare',
      args: { platform: 'douyin', title: '待替换标题', content: '请替换成要发布的内容', mediaFiles: [] },
    });
    expect(quickStarts.find((item) => item.id === 'social.orchestrate.douyin')).toMatchObject({
      actionId: 'noe.freedom.social.publish_orchestrate',
      args: { platform: 'douyin', title: '待替换标题', content: '请替换成要发布的内容', mediaFiles: [], browserState: {}, browserApp: 'Google Chrome' },
    });
    expect(quickStarts.find((item) => item.id === 'social.dom-publish-actions.douyin')).toMatchObject({
      actionId: 'noe.freedom.social.publish_orchestrate',
      args: {
        platform: 'douyin',
        title: '待替换标题',
        content: '请替换成要发布的内容',
        mediaFiles: ['替换为本地视频路径'],
        browserState: {},
        browserApp: 'Google Chrome',
        includeDomMediaPickerAction: true,
        includeDomFinalPublishAction: true,
      },
    });
    expect(quickStarts.find((item) => item.id === 'freedom.chain.echo-and-inventory')).toMatchObject({
      actionId: 'noe.freedom.chain.execute',
      args: {
        stopOnError: true,
        steps: [
          { stepId: 'shell_echo', actionId: 'noe.freedom.shell.execute', args: { command: 'printf noe-chain-ok' } },
          { stepId: 'desktop_inventory', actionId: 'noe.freedom.desktop.inventory', args: { dirPath: '~/Desktop', maxEntries: 10 } },
        ],
      },
    });
    expect(quickStarts.find((item) => item.id === 'freedom.resume-next-actions.placeholder')).toMatchObject({
      actionId: 'noe.freedom.run.resume_next_actions',
      args: {
        ledgerRef: 'output/noe-freedom-runs/替换为runId/ledger.json',
        stopOnError: true,
        persistChildLedgers: true,
      },
    });
    expect(quickStarts.find((item) => item.id === 'freedom.run-history.recent')).toMatchObject({
      actionId: 'noe.freedom.run.history',
      args: { limit: 20, requireOk: true, onlyWithNextActions: false },
    });
    expect(quickStarts.find((item) => item.id === 'social.preflight.douyin')).toMatchObject({
      actionId: 'noe.freedom.social.preflight.run',
      args: { platform: 'douyin', draftId: '替换为草稿ID', mediaFiles: [], browserState: {} },
    });
    expect(quickStarts.find((item) => item.id === 'social.form-fill.douyin')).toMatchObject({
      actionId: 'noe.freedom.social.form_fill.plan',
      args: { platform: 'douyin', draftId: '替换为草稿ID', browserState: {}, browserApp: 'Google Chrome' },
    });
    expect(quickStarts.find((item) => item.id === 'social.form-fill-execute.douyin')).toMatchObject({
      actionId: 'noe.freedom.social.form_fill.execute',
      args: { platform: 'douyin', draftId: '替换为草稿ID', browserState: {}, browserApp: 'Google Chrome' },
    });
    expect(quickStarts.find((item) => item.id === 'social.media-upload.douyin')).toMatchObject({
      actionId: 'noe.freedom.social.media_upload.prepare',
      args: { platform: 'douyin', draftId: '替换为草稿ID', mediaFiles: [], browserState: {}, browserApp: 'Google Chrome' },
    });
    expect(quickStarts.find((item) => item.id === 'social.media-upload-execute.douyin')).toMatchObject({
      actionId: 'noe.freedom.social.media_upload.execute',
      args: { platform: 'douyin', draftId: '替换为草稿ID', mediaFiles: [], browserState: {}, browserApp: 'Google Chrome' },
    });
    expect(quickStarts.find((item) => item.id === 'social.final-publish.douyin')).toMatchObject({
      actionId: 'noe.freedom.social.final_publish.execute',
      args: { platform: 'douyin', draftId: '替换为草稿ID', browserState: {}, browserApp: 'Google Chrome' },
    });
    expect(quickStarts.find((item) => item.id === 'account.connection-inventory.social')).toMatchObject({
      actionId: 'noe.freedom.account.connection_inventory',
      args: { platforms: ['douyin', 'xiaohongshu', 'bilibili', 'wechat_channels', 'youtube'], browserState: {} },
    });
    expect(quickStarts.every((item) => findNoeFreedomTool(item.actionId))).toBe(true);
    expect(quickStarts.every((item) => item.mode === 'developer_unrestricted')).toBe(true);
    expect(JSON.stringify(quickStarts)).not.toMatch(/sk-|tp-|AIza|password=|cookie=/i);
  });
});
