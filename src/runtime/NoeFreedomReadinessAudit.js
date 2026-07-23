import { DEFAULT_NOE_MARKETPLACE_DIR } from './NoeToolMarketplaceRegistry.js';
import { DEFAULT_NOE_SSH_CONFIG_PATH } from './NoeSshInventory.js';
import { buildNoeAccountConnectionInventory } from './NoeAccountConnectionInventory.js';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { redactNoeFreedomPayload } from '../capabilities/NoeFreedomManifest.js';
import { auditNoeProviderSecrets } from '../secrets/NoeProviderSecrets.js';
import { auditNoeProviderHealth } from '../secrets/NoeProviderHealth.js';
import { buildNoeOnlineModelRoster } from '../room/NoeOnlineModelRoster.js';

function clean(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function safeJson(value) {
  if (!value || typeof value !== 'object') return {};
  try {
    return JSON.parse(redactSensitiveText(JSON.stringify(value)));
  } catch {
    return {};
  }
}

function normalizeReadinessPlatforms(args = {}) {
  const input = args.platforms || args.platform;
  if (Array.isArray(input)) return input.map((item) => clean(item, 80)).filter(Boolean);
  const single = clean(input, 500);
  if (single) return single.split(',').map((item) => clean(item, 80)).filter(Boolean);
  return ['douyin', 'xiaohongshu', 'bilibili', 'wechat_channels', 'youtube'];
}

function normalizeKeychainRefs(value = []) {
  const list = Array.isArray(value) ? value : (value ? [value] : []);
  return list.slice(0, 20).map((item) => {
    if (typeof item === 'string') return { account: clean(item, 200) };
    const ref = safeJson(item);
    const service = clean(ref.service || ref.name || '', 240);
    return {
      ...(service ? { service } : {}),
      account: clean(ref.account || ref.key || ref.id || '', 200),
    };
  }).filter((item) => item.account);
}

function normalizeProviderSecretIds(value) {
  const input = value === undefined || value === null
    ? ['minimax', 'xiaomi', 'gemini', 'openai', 'anthropic']
    : value;
  const list = Array.isArray(input) ? input : String(input).split(',');
  return [...new Set(list.map((item) => clean(item, 80)).filter(Boolean))].slice(0, 20);
}

function countSshHosts(ssh = {}) {
  if (Array.isArray(ssh.hosts)) return ssh.hosts.length;
  if (Array.isArray(ssh.entries)) return ssh.entries.length;
  return 0;
}

function countMarketplaceTools(marketplace = {}) {
  if (Array.isArray(marketplace.tools)) return marketplace.tools.length;
  if (Array.isArray(marketplace.records)) return marketplace.records.length;
  return 0;
}

function readinessSummary({ accounts = {}, ssh = {}, marketplace = {}, secrets = [], desktop = {}, providerSecrets = {}, providerHealth = {}, onlineModelRoster = {} } = {}) {
  const connections = Array.isArray(accounts.connections) ? accounts.connections : [];
  const activePlatforms = connections
    .filter((item) => item.status === 'active_browser_match')
    .map((item) => item.platform)
    .filter(Boolean);
  const knownPlatforms = connections.map((item) => item.platform).filter(Boolean);
  const providerResults = Array.isArray(providerSecrets.providers) ? providerSecrets.providers : [];
  return {
    activeLoggedInPlatforms: activePlatforms,
    knownPlatforms,
    sshHostCount: countSshHosts(ssh),
    marketplaceToolCount: countMarketplaceTools(marketplace),
    secretRefCount: secrets.filter((item) => item.ok).length,
    providerSecretConfiguredCount: providerResults.filter((item) => item.configured).length,
    providerSecretMissingCount: providerResults.filter((item) => !item.configured).length,
    providerSecretsConfigured: providerResults.filter((item) => item.configured).map((item) => item.provider),
    providerSecretsMissing: providerResults.filter((item) => !item.configured).map((item) => item.provider),
    providerHealthReachableCount: Number(providerHealth.reachableCount) || 0,
    providerHealthAuthOkCount: Number(providerHealth.authOkCount) || 0,
    providerHealthUnavailable: Array.isArray(providerHealth.unavailableProviders) ? providerHealth.unavailableProviders : [],
    onlineModelAvailableCount: Number(onlineModelRoster.availableCount) || 0,
    onlineModelAvailable: Array.isArray(onlineModelRoster.availableModels) ? onlineModelRoster.availableModels : [],
    onlineModelUnavailable: Array.isArray(onlineModelRoster.unavailableModels) ? onlineModelRoster.unavailableModels.map((item) => item.id) : [],
    onlineModelThreshold: Number(onlineModelRoster.threshold) || 0,
    desktopEntryCount: Number(desktop.count) || 0,
  };
}

function readinessNextActions({ accounts = {}, args = {}, providerSecrets = {}, providerHealth = {}, onlineModelRoster = {} } = {}) {
  const actions = Array.isArray(accounts.recommendedNextFreedomActions)
    ? accounts.recommendedNextFreedomActions
    : [];
  const providerSecretIds = normalizeProviderSecretIds(args.providerSecrets || args.providers);
  const providerResults = Array.isArray(providerSecrets.providers) ? providerSecrets.providers : [];
  const missingProviders = providerResults.filter((item) => item.configured !== true).map((item) => item.provider);
  const healthResults = Array.isArray(providerHealth.providers) ? providerHealth.providers : [];
  const unhealthyConfiguredProviders = healthResults
    .filter((item) => item.configured === true && item.ok !== true)
    .map((item) => item.provider);
  const providerActions = [];
  if (args.includeProviderHealth !== true) {
    providerActions.push({
      stepId: 'probe_model_provider_health',
      title: '联网验证模型 provider 是否真的可调用',
      actionId: 'noe.freedom.developer.readiness_audit',
      mode: 'developer_unrestricted',
      args: redactNoeFreedomPayload({
        platforms: [],
        includeBrowserState: false,
        includeSshInventory: false,
        includeMarketplace: false,
        includeDesktop: false,
        includeProviderSecrets: true,
        includeProviderHealth: true,
        providers: providerSecretIds,
        keychainRefs: [],
      }),
    });
  }
  if (missingProviders.length > 0) {
    providerActions.push({
      stepId: 'setup_missing_model_provider_keys',
      title: `补齐模型 provider Keychain 凭证：${missingProviders.join(', ')}`,
      actionId: 'noe.freedom.shell.execute',
      mode: 'developer_unrestricted',
      args: redactNoeFreedomPayload({
        command: 'npm run noe:keys:model:setup',
        cwd: '.',
        note: 'interactive_keychain_prompt_no_secret_logging',
        missingProviders,
      }),
    });
  }
  if (unhealthyConfiguredProviders.length > 0) {
    providerActions.push({
      stepId: 'recheck_unhealthy_model_providers',
      title: `复查已配置但不可用的模型 provider：${unhealthyConfiguredProviders.join(', ')}`,
      actionId: 'noe.freedom.developer.readiness_audit',
      mode: 'developer_unrestricted',
      args: redactNoeFreedomPayload({
        platforms: [],
        includeBrowserState: false,
        includeSshInventory: false,
        includeMarketplace: false,
        includeDesktop: false,
        includeProviderSecrets: true,
        includeProviderHealth: true,
        providers: unhealthyConfiguredProviders,
        keychainRefs: [],
      }),
    });
  }
  if (onlineModelRoster.ok === false) {
    providerActions.push({
      stepId: 'repair_online_model_roster',
      title: '补齐至少两个可用线上模型，恢复多模型协作 quorum',
      actionId: 'noe.freedom.developer.readiness_audit',
      mode: 'developer_unrestricted',
      args: redactNoeFreedomPayload({
        platforms: [],
        includeBrowserState: false,
        includeSshInventory: false,
        includeMarketplace: false,
        includeDesktop: false,
        includeProviderSecrets: true,
        includeProviderHealth: true,
        providers: providerSecretIds,
        keychainRefs: [],
      }),
    });
  }
  return [
    {
      stepId: 'refresh_developer_readiness',
      title: '刷新开发者模式可控能力盘点',
      actionId: 'noe.freedom.developer.readiness_audit',
      mode: 'developer_unrestricted',
      args: redactNoeFreedomPayload({
        platforms: normalizeReadinessPlatforms(args),
        includeBrowserState: true,
        includeSshInventory: args.includeSshInventory !== false,
        includeMarketplace: args.includeMarketplace !== false,
        includeDesktop: args.includeDesktop !== false,
        includeProviderSecrets: args.includeProviderSecrets !== false,
        includeProviderHealth: args.includeProviderHealth === true,
        providers: normalizeProviderSecretIds(args.providerSecrets || args.providers),
        keychainRefs: normalizeKeychainRefs(args.keychainRefs),
      }),
    },
    ...providerActions,
    ...actions,
  ].slice(0, 12);
}

export function buildNoeFreedomReadinessAuditDryRun({ tool, args = {}, deps = {}, dryRunPlan } = {}) {
  const platforms = normalizeReadinessPlatforms(args);
  const keychainRefs = normalizeKeychainRefs(args.keychainRefs || args.secrets);
  const providerSecretIds = normalizeProviderSecretIds(args.providerSecrets || args.providers);
  return dryRunPlan({
    tool,
    args,
    adapter: 'developer-readiness-audit',
    extras: {
      valid: true,
      platforms,
      checks: {
        browserState: args.includeBrowserState !== false,
        accountConnections: true,
        sshInventory: args.includeSshInventory !== false,
        marketplace: args.includeMarketplace !== false,
        desktopInventory: args.includeDesktop !== false,
        providerSecrets: args.includeProviderSecrets !== false ? providerSecretIds : [],
        providerHealth: args.includeProviderHealth === true ? providerSecretIds : [],
        keychainRefs: keychainRefs.length,
      },
      marketplaceDir: clean(args.marketplaceDir || args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000),
      sshConfigPath: clean(args.sshConfigPath || args.path || DEFAULT_NOE_SSH_CONFIG_PATH, 2000),
      secretValuesReturned: false,
      externalSideEffectPerformed: false,
      publishPerformed: false,
      authority: {
        canUseLoggedInAccounts: true,
        canReadSecrets: false,
        canPublishExternally: false,
        bypassesNoeGovernance: false,
        readinessOnly: true,
      },
    },
  });
}

export async function runNoeFreedomReadinessAudit({
  args = {},
  probes = {},
} = {}) {
  const platforms = normalizeReadinessPlatforms(args);
  const warnings = [];
  const browser = args.includeBrowserState === false
    ? { ok: true, skipped: true, activeBrowser: null, browsers: [] }
    : await probes.browserState();
  if (browser.ok === false) warnings.push(browser.error || 'browser_state_probe_failed');

  const browserState = browser.ok
    ? {
        frontmostApp: browser.frontmostApp || '',
        activeBrowser: browser.activeBrowser || null,
        browsers: Array.isArray(browser.browsers) ? browser.browsers : [],
      }
    : safeJson(args.browserState);
  const accounts = buildNoeAccountConnectionInventory({
    args: { ...safeJson(args), platforms, browserState },
    realExecute: true,
  });

  const ssh = args.includeSshInventory === false
    ? { ok: true, skipped: true, adapter: 'ssh-inventory' }
    : probes.sshInventory({ path: args.sshConfigPath || args.sshPath, maxHosts: args.maxSshHosts || args.limit });
  if (ssh.ok === false) warnings.push(ssh.error || 'ssh_inventory_failed');

  const marketplace = args.includeMarketplace === false
    ? { ok: true, skipped: true, adapter: 'tool-marketplace-list' }
    : probes.marketplaceList({
        installDir: args.marketplaceDir || args.installDir,
        includeDisabled: args.includeDisabled !== false,
      });
  if (marketplace.ok === false) warnings.push(marketplace.error || 'tool_marketplace_list_failed');

  const desktop = args.includeDesktop === false
    ? { ok: true, skipped: true, adapter: 'desktop' }
    : probes.desktopInventory({ path: args.desktopPath || args.dirPath, maxEntries: args.maxDesktopEntries || 40 });
  if (desktop.ok === false) warnings.push(desktop.error || 'desktop_inventory_failed');

  const secrets = normalizeKeychainRefs(args.keychainRefs || args.secrets).map((ref) => ({
    service: ref.service,
    account: ref.account,
    ...probes.keychainRead(ref),
  }));
  for (const item of secrets) {
    if (item.ok === false) warnings.push(`secret_ref_unavailable:${clean(item.account, 120)}`);
  }

  const providerSecrets = args.includeProviderSecrets === false
    ? { ok: true, skipped: true, adapter: 'provider-secret-readiness', providers: [] }
    : (probes.providerSecrets
        ? probes.providerSecrets({ providers: normalizeProviderSecretIds(args.providerSecrets || args.providers) })
        : auditNoeProviderSecrets({ providers: normalizeProviderSecretIds(args.providerSecrets || args.providers) }));
  if (providerSecrets.ok === false) warnings.push(providerSecrets.error || 'provider_secret_readiness_failed');
  for (const item of providerSecrets.providers || []) {
    if (item.configured !== true) warnings.push(`provider_secret_unconfigured:${clean(item.provider, 80)}`);
  }

  const providerHealth = args.includeProviderHealth === true
    ? (probes.providerHealth
        ? await probes.providerHealth({ providers: normalizeProviderSecretIds(args.providerSecrets || args.providers) })
        : await auditNoeProviderHealth({ providers: normalizeProviderSecretIds(args.providerSecrets || args.providers) }))
    : { ok: true, skipped: true, adapter: 'provider-health-readiness', providers: [] };
  if (providerHealth.ok === false) warnings.push(providerHealth.error || 'provider_health_readiness_failed');
  for (const item of providerHealth.providers || []) {
    if (item.ok !== true) warnings.push(`provider_health_unavailable:${clean(item.provider, 80)}:${clean(item.status, 80)}`);
  }

  const onlineModelRoster = buildNoeOnlineModelRoster({
    providerHealth,
    env: args.env && typeof args.env === 'object' ? args.env : process.env,
    commandResolver: probes.commandResolver,
  });

  const summary = readinessSummary({ accounts, ssh, marketplace, secrets, desktop, providerSecrets, providerHealth, onlineModelRoster });
  return {
    ok: true,
    adapter: 'developer-readiness-audit',
    plannedOnly: false,
    realExecute: true,
    platforms,
    warnings,
    browser,
    accounts,
    ssh,
    marketplace,
    desktop,
    secrets,
    providerSecrets,
    providerHealth,
    onlineModelRoster,
    summary,
    nextFreedomActions: readinessNextActions({ accounts, args, providerSecrets, providerHealth, onlineModelRoster }),
    secretValuesReturned: false,
    cookiesReadByNoe: false,
    passwordReadByNoe: false,
    pageContentReadByNoe: false,
    externalSideEffectPerformed: false,
    publishPerformed: false,
    authority: {
      canUseLoggedInAccounts: true,
      canReadSecrets: false,
      canPublishExternally: false,
      bypassesNoeGovernance: false,
      readinessOnly: true,
    },
  };
}
