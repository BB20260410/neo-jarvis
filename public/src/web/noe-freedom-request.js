import { clean } from './noe-freedom-ui-utils.js';

export const DEFAULT_TOOL_ID = 'noe.freedom.shell.execute';

const DEFAULT_ARGS = {
  'noe.freedom.shell.execute': { command: 'printf noe-developer-mode' },
  'noe.freedom.ssh.execute': { host: 'example-host', command: 'hostname' },
  'noe.freedom.ssh.inventory': {},
  'noe.freedom.keychain.read': { service: 'example-service', account: 'example-account' },
  'noe.freedom.env.inspect': { path: '.env' },
  'noe.freedom.desktop.inventory': { dirPath: '~/Desktop', maxEntries: 40 },
  'noe.freedom.account.connection_inventory': { platforms: ['douyin', 'xiaohongshu', 'bilibili', 'wechat_channels', 'youtube'], browserState: {} },
  'noe.freedom.developer.readiness_audit': { platforms: ['douyin', 'xiaohongshu', 'bilibili', 'wechat_channels', 'youtube'], includeBrowserState: true, includeSshInventory: true, includeMarketplace: true, includeDesktop: true, includeProviderSecrets: true, includeProviderHealth: false, providerSecrets: ['minimax', 'xiaomi', 'gemini', 'openai', 'anthropic'], keychainRefs: [] },
  'noe.freedom.social.publish': { url: 'https://example.test/webhook', content: 'draft content' },
  'noe.freedom.social.workflow.prepare': { platform: 'douyin', title: 'draft title', content: 'draft content', mediaFiles: [] },
  'noe.freedom.social.publish_orchestrate': { platform: 'douyin', title: 'draft title', content: 'draft content', mediaFiles: [], browserState: {}, browserApp: 'Google Chrome', includeDomMediaPickerAction: false, includeDomFinalPublishAction: false },
  'noe.freedom.chain.execute': { stopOnError: true, steps: [{ stepId: 'shell_echo', actionId: 'noe.freedom.shell.execute', args: { command: 'printf noe-chain-ok' } }] },
  'noe.freedom.run.resume_next_actions': { ledgerRef: 'output/noe-freedom-runs/replace-run-id/ledger.json', stopOnError: true, persistChildLedgers: true },
  'noe.freedom.run.history': { limit: 20, requireOk: true, onlyWithNextActions: false },
  'noe.freedom.social.preflight.run': { platform: 'douyin', draftId: 'draft-id', mediaFiles: [], browserState: {} },
  'noe.freedom.social.form_fill.plan': { platform: 'douyin', draftId: 'draft-id', browserState: {}, browserApp: 'Google Chrome' },
  'noe.freedom.social.form_fill.execute': { platform: 'douyin', draftId: 'draft-id', browserState: {}, browserApp: 'Google Chrome' },
  'noe.freedom.social.media_upload.prepare': { platform: 'douyin', draftId: 'draft-id', mediaFiles: [], browserState: {}, browserApp: 'Google Chrome' },
  'noe.freedom.social.media_upload.execute': { platform: 'douyin', draftId: 'draft-id', mediaFiles: [], browserState: {}, browserApp: 'Google Chrome' },
  'noe.freedom.social.final_publish.execute': { platform: 'douyin', draftId: 'draft-id', browserState: {}, browserApp: 'Google Chrome' },
  'noe.freedom.browser.open': { url: 'https://example.com' },
  'noe.freedom.browser.dom.execute': { browserApp: 'Google Chrome', actions: [{ type: 'read_title' }] },
  'noe.freedom.macos.applescript.run': { language: 'AppleScript', script: 'return "noe developer mode"' },
  'noe.freedom.social.draft.create': { platform: 'generic', content: 'draft content' },
  'noe.freedom.social.draft.list': {},
  'noe.freedom.social.draft.cancel': { draftId: 'draft-id' },
  'noe.freedom.network.upload': { url: 'https://example.test/upload', method: 'POST', content: 'upload body' },
  'noe.freedom.tool_marketplace.install': { id: 'example-tool', name: 'Example Tool', entrypoint: 'printf example-tool' },
  'noe.freedom.tool_marketplace.list': {},
  'noe.freedom.tool_marketplace.disable': { id: 'example-tool' },
  'noe.freedom.tool_marketplace.uninstall': { id: 'example-tool' },
  'noe.freedom.tool_marketplace.execute': { id: 'example-tool' },
};

export function defaultFreedomArgs(toolId = DEFAULT_TOOL_ID) {
  return JSON.stringify(DEFAULT_ARGS[toolId] || {}, null, 2);
}

export function parseFreedomArgsJson(value = '') {
  try {
    return { ok: true, args: JSON.parse(value || '{}') };
  } catch (error) {
    return { ok: false, error: `invalid_args_json:${clean(error?.message || error, 300)}` };
  }
}

export function buildFreedomRequestBody({
  action = DEFAULT_TOOL_ID,
  argsJson = '{}',
  mode = 'developer_unrestricted',
  sessionId = '',
  realExecute = false,
  persistLedger = true,
  runId = '',
} = {}) {
  const parsed = parseFreedomArgsJson(argsJson);
  if (!parsed.ok) return parsed;
  const selectedMode = realExecute ? (mode || 'developer_unrestricted') : 'dry_run';
  const activeSessionId = clean(sessionId, 180);
  const authorization = selectedMode === 'developer_unrestricted' && realExecute === true && activeSessionId
    ? { sessionId: activeSessionId }
    : selectedMode === 'developer_unrestricted'
    ? { mode: selectedMode, ownerPresent: realExecute === true }
    : selectedMode === 'owner_supervised_unrestricted'
      ? {
          mode: selectedMode,
          ownerPresent: realExecute === true,
          allowlistAccepted: realExecute === true,
          rollbackPlan: 'Owner supervised from Noe Freedom Tools UI.',
        }
      : { mode: 'dry_run' };
  return {
    ok: true,
    body: {
      action,
      args: parsed.args,
      realExecute: realExecute === true,
      persistLedger: persistLedger === true,
      runId: clean(runId || `freedom-ui-${Date.now()}`, 120),
      authorization,
    },
  };
}
