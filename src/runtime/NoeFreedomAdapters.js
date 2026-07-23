// @ts-check
// NoeFreedomAdapters —— freedom 适配器组合根（thin dispatch）。
// 各域适配器已拆到 ./freedomAdapters/{common,infra,browser,social,marketplace}.js；
// 本文件只保留：跨域编排 developer.readiness_audit + ADAPTERS 注册表 + dispatch。
// 对外 export（SHELL_BIN / getNoeFreedomAdapter / runNoeFreedomAdapter）保持不变，外部 import 零改动。
import { auditNoeProviderHealth } from '../secrets/NoeProviderHealth.js';
import { auditNoeProviderSecrets } from '../secrets/NoeProviderSecrets.js';
import {
  buildNoeFreedomReadinessAuditDryRun,
  runNoeFreedomReadinessAudit,
} from './NoeFreedomReadinessAudit.js';
import { clean, dryRunPlan } from './freedomAdapters/common.js';
import {
  fileDeleteDryRun,
  fileDeleteExecute,
  freedomRunHistoryDryRun,
  freedomRunHistoryExecute,
  inspectDesktop,
  inspectEnv,
  readKeychain,
  shellDryRun,
  shellExecute,
  sshDryRun,
  sshExecute,
  sshInventoryDryRun,
  sshInventoryExecute,
  uploadDryRun,
  uploadExecute,
} from './freedomAdapters/infra.js';
import {
  accountConnectionInventoryRun,
  browserDomDryRun,
  browserDomExecute,
  browserOpenDryRun,
  browserOpenExecute,
  browserStateProbeDryRun,
  browserStateProbeExecute,
} from './freedomAdapters/browser.js';
import {
  appleScriptDryRun,
  appleScriptExecute,
  socialDraftCancelDryRun,
  socialDraftCancelExecute,
  socialDraftCreateDryRun,
  socialDraftCreateExecute,
  socialDraftListDryRun,
  socialDraftListExecute,
  socialDryRun,
  socialExecute,
  socialFinalPublishExecuteRun,
  socialFormFillExecuteRun,
  socialFormFillPlanRun,
  socialMediaUploadExecuteRun,
  socialMediaUploadPrepareRun,
  socialPreflightRun,
  socialPublishOrchestratorRun,
  socialRollbackEvidenceGateRun,
  socialRollbackExecuteDryRun,
  socialRollbackExecuteRun,
  socialWorkflowDryRun,
  socialWorkflowExecute,
} from './freedomAdapters/social.js';
import {
  marketplaceDisableDryRun,
  marketplaceDisableExecute,
  marketplaceExecute,
  marketplaceExecuteDryRun,
  marketplaceInstallDryRun,
  marketplaceInstallExecute,
  marketplaceListDryRun,
  marketplaceListExecute,
  marketplaceUninstallDryRun,
  marketplaceUninstallExecute,
} from './freedomAdapters/marketplace.js';

function readinessAuditDryRun({ tool, args, deps }) {
  return buildNoeFreedomReadinessAuditDryRun({
    tool,
    args,
    deps,
    dryRunPlan,
  });
}

async function readinessAuditExecute({ args, root, deps }) {
  return runNoeFreedomReadinessAudit({
    args,
    probes: {
      browserState: () => browserStateProbeExecute({ root, deps }),
      sshInventory: (input) => sshInventoryExecute({ args: input }),
      marketplaceList: (input) => marketplaceListExecute({ args: input, deps }),
      desktopInventory: (input) => inspectDesktop({ args: input }),
      keychainRead: (input) => readKeychain({ args: input, deps }),
      providerSecrets: (input) => auditNoeProviderSecrets({
        ...input,
        env: deps.env || process.env,
        keychainReader: deps.providerKeychainReader,
        roomConfigLoader: deps.roomConfigLoader,
      }),
      providerHealth: (input) => auditNoeProviderHealth({
        ...input,
        env: deps.env || process.env,
        fetchImpl: deps.providerFetch || deps.fetch || globalThis.fetch,
        secretResolver: deps.providerSecretResolver,
        roomConfigLoader: deps.roomConfigLoader,
      }),
      commandResolver: deps.commandResolver,
    },
  });
}

const ADAPTERS = {
  'noe.freedom.shell.execute': { dryRun: shellDryRun, execute: shellExecute },
  'noe.freedom.ssh.execute': { dryRun: sshDryRun, execute: sshExecute },
  'noe.freedom.ssh.inventory': { dryRun: sshInventoryDryRun, execute: sshInventoryExecute },
  'noe.freedom.keychain.read': { dryRun: ({ tool, args }) => dryRunPlan({ tool, args, adapter: 'keychain', extras: { readonly: true } }), execute: readKeychain },
  'noe.freedom.env.inspect': { dryRun: ({ tool, args }) => dryRunPlan({ tool, args, adapter: 'env', extras: { readonly: true } }), execute: inspectEnv },
  'noe.freedom.desktop.inventory': { dryRun: ({ tool, args }) => dryRunPlan({ tool, args, adapter: 'desktop', extras: { readonly: true, contentRead: false } }), execute: inspectDesktop },
  'noe.freedom.account.connection_inventory': {
    dryRun: ({ args, root, deps }) => accountConnectionInventoryRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => accountConnectionInventoryRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.run.history': { dryRun: freedomRunHistoryDryRun, execute: freedomRunHistoryExecute },
  'noe.freedom.developer.readiness_audit': {
    dryRun: readinessAuditDryRun,
    execute: readinessAuditExecute,
  },
  'noe.freedom.social.publish': { dryRun: socialDryRun, execute: socialExecute },
  'noe.freedom.social.workflow.prepare': { dryRun: socialWorkflowDryRun, execute: socialWorkflowExecute },
  'noe.freedom.social.publish_orchestrate': {
    dryRun: ({ args, root, deps }) => socialPublishOrchestratorRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialPublishOrchestratorRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.preflight.run': {
    dryRun: ({ args, root, deps }) => socialPreflightRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialPreflightRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.form_fill.plan': {
    dryRun: ({ args, deps }) => socialFormFillPlanRun({ args, deps, realExecute: false }),
    execute: ({ args, deps }) => socialFormFillPlanRun({ args, deps, realExecute: true }),
  },
  'noe.freedom.social.form_fill.execute': {
    dryRun: ({ args, root, deps }) => socialFormFillExecuteRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialFormFillExecuteRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.media_upload.prepare': {
    dryRun: ({ args, root, deps }) => socialMediaUploadPrepareRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialMediaUploadPrepareRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.media_upload.execute': {
    dryRun: ({ args, root, deps }) => socialMediaUploadExecuteRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialMediaUploadExecuteRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.final_publish.execute': {
    dryRun: ({ args, root, deps }) => socialFinalPublishExecuteRun({ args, root, deps, realExecute: false }),
    execute: ({ args, root, deps }) => socialFinalPublishExecuteRun({ args, root, deps, realExecute: true }),
  },
  'noe.freedom.social.rollback.evidence_gate': {
    dryRun: socialRollbackEvidenceGateRun,
    execute: socialRollbackEvidenceGateRun,
  },
  'noe.freedom.social.rollback.execute': {
    dryRun: socialRollbackExecuteDryRun,
    execute: socialRollbackExecuteRun,
  },
  'noe.freedom.browser.open': { dryRun: browserOpenDryRun, execute: browserOpenExecute },
  'noe.freedom.browser.state_probe': { dryRun: browserStateProbeDryRun, execute: browserStateProbeExecute },
  'noe.freedom.browser.dom.execute': { dryRun: browserDomDryRun, execute: browserDomExecute },
  'noe.freedom.macos.applescript.run': { dryRun: appleScriptDryRun, execute: appleScriptExecute },
  'noe.freedom.social.draft.create': { dryRun: socialDraftCreateDryRun, execute: socialDraftCreateExecute },
  'noe.freedom.social.draft.list': { dryRun: socialDraftListDryRun, execute: socialDraftListExecute },
  'noe.freedom.social.draft.cancel': { dryRun: socialDraftCancelDryRun, execute: socialDraftCancelExecute },
  'noe.freedom.file.delete': { dryRun: fileDeleteDryRun, execute: fileDeleteExecute },
  'noe.freedom.network.upload': { dryRun: uploadDryRun, execute: uploadExecute },
  'noe.freedom.tool_marketplace.install': { dryRun: marketplaceInstallDryRun, execute: marketplaceInstallExecute },
  'noe.freedom.tool_marketplace.list': { dryRun: marketplaceListDryRun, execute: marketplaceListExecute },
  'noe.freedom.tool_marketplace.disable': { dryRun: marketplaceDisableDryRun, execute: marketplaceDisableExecute },
  'noe.freedom.tool_marketplace.uninstall': { dryRun: marketplaceUninstallDryRun, execute: marketplaceUninstallExecute },
  'noe.freedom.tool_marketplace.execute': { dryRun: marketplaceExecuteDryRun, execute: marketplaceExecute },
};

export function getNoeFreedomAdapter(operation = '') {
  return ADAPTERS[clean(operation, 180)] || null;
}

export async function runNoeFreedomAdapter({ tool, args = {}, root = process.cwd(), deps = {}, realExecute = false } = {}) {
  const adapter = getNoeFreedomAdapter(tool?.operation);
  if (!adapter) return { ok: false, adapter: 'unknown', error: 'freedom_operation_not_implemented' };
  if (!realExecute) return adapter.dryRun({ tool, args, root, deps });
  return adapter.execute({ tool, args, root, deps });
}

export { SHELL_BIN } from './freedomAdapters/common.js';
