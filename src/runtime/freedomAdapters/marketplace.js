// @ts-check
// marketplace 域适配器：tool_marketplace install / list / disable / uninstall / execute。
// 拆分自 NoeFreedomAdapters.js（纯搬运，行为零改变）。
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { commandDeletesProtectedPath } from '../_protectedPathGuard.js';
import {
  DEFAULT_NOE_MARKETPLACE_DIR,
  disableNoeMarketplaceTool,
  installNoeMarketplaceTool,
  listNoeMarketplaceTools,
  readNoeMarketplaceTool,
  uninstallNoeMarketplaceTool,
} from '../NoeToolMarketplaceRegistry.js';
import { clean, dryRunPlan, runProcess, safeJson, SHELL_BIN } from './common.js';

function marketplaceToolId(args = {}) {
  const manifest = safeJson(args.manifest || args.tool);
  return clean(manifest.id || args.id, 180);
}

export function marketplaceInstallDryRun({ tool, args, deps }) {
  const id = marketplaceToolId(args);
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  const warnings = id ? [] : ['tool_manifest_id_required'];
  return dryRunPlan({
    tool,
    args,
    adapter: 'tool-marketplace-install',
    extras: {
      valid: warnings.length === 0,
      id,
      wouldWritePath: id ? join(dir, `${id.replace(/[^a-z0-9_.-]+/gi, '_')}.json`) : '',
      registryDir: dir,
      rollbackExpectation: 'remove_installed_manifest',
      executionEnabled: false,
    },
    warnings,
  });
}

export function marketplaceInstallExecute({ args, deps }) {
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  const out = installNoeMarketplaceTool({
    manifest: args.manifest || args.tool || { id: args.id },
    dir,
    source: args.source || 'owner-supervised',
  });
  return { adapter: 'tool-marketplace-install', ...out };
}

export function marketplaceListDryRun({ tool, args, deps }) {
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return dryRunPlan({
    tool,
    args,
    adapter: 'tool-marketplace-list',
    extras: {
      valid: true,
      registryDir: dir,
      wouldReadRegistry: true,
      executionEnabled: false,
    },
  });
}

export function marketplaceListExecute({ args, deps }) {
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return { adapter: 'tool-marketplace-list', ...listNoeMarketplaceTools({ dir, includeDisabled: args.includeDisabled !== false }) };
}

export function marketplaceDisableDryRun({ tool, args, deps }) {
  const id = marketplaceToolId(args);
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return dryRunPlan({
    tool,
    args,
    adapter: 'tool-marketplace-disable',
    extras: {
      valid: Boolean(id),
      id,
      registryDir: dir,
      wouldWriteTombstone: Boolean(id),
      rollbackExpectation: 'reinstall_manifest',
      executionEnabled: false,
    },
    warnings: id ? [] : ['tool_manifest_id_required'],
  });
}

export function marketplaceDisableExecute({ args, deps }) {
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return {
    adapter: 'tool-marketplace-disable',
    ...disableNoeMarketplaceTool({ id: marketplaceToolId(args), dir, reason: args.reason || 'owner_disabled' }),
  };
}

export function marketplaceUninstallDryRun({ tool, args, deps }) {
  const id = marketplaceToolId(args);
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return dryRunPlan({
    tool,
    args,
    adapter: 'tool-marketplace-uninstall',
    extras: {
      valid: Boolean(id),
      id,
      registryDir: dir,
      wouldWriteTombstone: Boolean(id),
      rollbackExpectation: 'reinstall_manifest',
      executionEnabled: false,
    },
    warnings: id ? [] : ['tool_manifest_id_required'],
  });
}

export function marketplaceUninstallExecute({ args, deps }) {
  const dir = clean(args.installDir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
  return {
    adapter: 'tool-marketplace-uninstall',
    ...uninstallNoeMarketplaceTool({ id: marketplaceToolId(args), dir, reason: args.reason || 'owner_uninstalled' }),
  };
}

function marketplaceExecuteDir(args = {}, deps = {}) {
  return clean(args.installDir || args.dir || deps.marketplaceDir || DEFAULT_NOE_MARKETPLACE_DIR, 2000);
}

function marketplaceEntrypoint(record = {}) {
  return clean(record.entrypoint?.value || record.manifest?.entrypoint || record.manifest?.command || record.manifest?.main, 4000);
}

export function marketplaceExecuteDryRun({ tool, args, deps }) {
  const id = marketplaceToolId(args);
  const dir = marketplaceExecuteDir(args, deps);
  const current = id ? readNoeMarketplaceTool({ id, dir, includeDisabled: false }) : null;
  const entrypoint = current?.ok ? marketplaceEntrypoint(current.record) : '';
  const warnings = [];
  if (!id) warnings.push('tool_manifest_id_required');
  if (id && !current?.ok) warnings.push(current?.error || 'tool_marketplace_record_not_found');
  if (current?.ok && current.record?.state !== 'enabled') warnings.push('tool_marketplace_tool_not_enabled');
  if (current?.ok && !entrypoint) warnings.push('tool_marketplace_entrypoint_required');
  return dryRunPlan({
    tool,
    args,
    adapter: 'tool-marketplace-execute',
    extras: {
      valid: warnings.length === 0,
      id,
      registryDir: dir,
      entrypointPreview: entrypoint,
      executeAdapterConfigured: true,
      wouldExecuteEntrypoint: warnings.length === 0,
    },
    warnings,
  });
}

export async function marketplaceExecute({ args, root, deps }) {
  const id = marketplaceToolId(args);
  if (!id) return { ok: false, adapter: 'tool-marketplace-execute', error: 'tool_manifest_id_required' };
  const dir = marketplaceExecuteDir(args, deps);
  const current = readNoeMarketplaceTool({ id, dir, includeDisabled: false });
  if (!current.ok) return { ok: false, adapter: 'tool-marketplace-execute', error: current.error, id };
  if (current.record?.state !== 'enabled') return { ok: false, adapter: 'tool-marketplace-execute', error: 'tool_marketplace_tool_not_enabled', id };
  const entrypoint = marketplaceEntrypoint(current.record);
  if (!entrypoint) return { ok: false, adapter: 'tool-marketplace-execute', error: 'tool_marketplace_entrypoint_required', id };
  const protectedDelete = commandDeletesProtectedPath(entrypoint);
  if (protectedDelete) {
    return {
      ok: false,
      adapter: 'tool-marketplace-execute',
      error: `developer_hard_veto_protected_delete:${protectedDelete}`,
      id,
    };
  }
  const cwd = clean(args.cwd || root, 2000) || root;
  const env = {
    ...process.env,
    ...(args.env && typeof args.env === 'object' ? args.env : {}),
  };
  return {
    adapter: 'tool-marketplace-execute',
    id,
    registryRef: current.ref,
    entrypointPreview: entrypoint,
    executionAdapterConfigured: true,
    secretValuesReturned: false,
    ...(await runProcess(SHELL_BIN, ['-lc', entrypoint], { cwd, env, spawnImpl: deps.spawn || spawn })),
  };
}
