import { homedir, hostname } from 'node:os';
import { resolve, sep } from 'node:path';
import { URL } from 'node:url';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

export const NOE_FREEDOM_ALLOWLIST_SCHEMA_VERSION = 1;

function clean(value, max = 2000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function list(value = []) {
  const input = Array.isArray(value) ? value : String(value || '').split(/[\n,]+/);
  return [...new Set(input.map((item) => clean(item, 500)).filter(Boolean))];
}

function normalizePath(p = '') {
  const text = clean(p, 2000);
  if (!text || text.includes('\0')) return '';
  return resolve(text);
}

function pathInside(base, target) {
  const root = normalizePath(base);
  const next = normalizePath(target);
  if (!root || !next) return false;
  return next === root || next.startsWith(root + sep);
}

function hostFromUrl(value = '') {
  try { return new URL(value).hostname.toLowerCase(); } catch { return ''; }
}

function matchesPattern(pattern = '', value = '') {
  // M10 修复：allowlist 比对必须用原始文本——clean() 的 redactSensitiveText 会把命令里的 secret 模式
  // 替换成 [REDACTED]，导致 allow/deny 判定基于被改写的文本而误判允许或拒绝。脱敏只用于日志输出。
  const p = String(pattern ?? '').trim().slice(0, 500);
  const v = String(value ?? '').trim().slice(0, 4000);
  if (!p) return false;
  if (p === '*') return true;
  if (p.endsWith('*')) return v.startsWith(p.slice(0, -1));
  return p === v;
}

function scopeAllows(scope = [], value = '', matcher = (pattern, next) => pattern === next) {
  const items = Array.isArray(scope) ? scope : [];
  return items.includes('*') || items.some((pattern) => matcher(pattern, value));
}

function scopesFrom(input = {}) {
  return {
    operations: list(input.operations || input.allowedOperations),
    commands: list(input.commands || input.allowedCommands),
    hosts: list(input.hosts || input.allowedHosts),
    paths: list(input.paths || input.allowedPaths),
    secrets: list(input.secrets || input.allowedSecrets),
    marketplaceTools: list(input.marketplaceTools || input.allowedMarketplaceTools),
    networkMethods: list(input.networkMethods || input.allowedMethods),
  };
}

export function normalizeNoeFreedomAllowlist(input = {}) {
  const scopes = scopesFrom(input.scopes || input);
  return {
    schemaVersion: Number(input.schemaVersion) || NOE_FREEDOM_ALLOWLIST_SCHEMA_VERSION,
    id: clean(input.id || `allowlist-${hostname()}`, 180),
    source: clean(input.source || 'owner-provided', 120),
    denyByDefault: input.denyByDefault !== false,
    scopes,
  };
}

export function evaluateNoeFreedomAllowlist({
  tool = null,
  args = {},
  trustManifest = null,
  allowlist = null,
  root = process.cwd(),
  realExecute = false,
} = {}) {
  const errors = [];
  const normalizedAllowlist = allowlist ? normalizeNoeFreedomAllowlist(allowlist) : null;
  if (!realExecute) return { ok: true, errors, allowlist: normalizedAllowlist };
  if (!normalizedAllowlist) errors.push('allowlist_required_for_real_execute');
  if (normalizedAllowlist?.schemaVersion !== NOE_FREEDOM_ALLOWLIST_SCHEMA_VERSION) errors.push('unsupported_allowlist_schema_version');

  const manifestScopes = trustManifest?.scopes || {};
  const allowScopes = normalizedAllowlist?.scopes || {};
  const operation = clean(tool?.operation, 180);
  if (allowScopes.operations?.length && !allowScopes.operations.includes(operation)) errors.push('operation_not_in_allowlist');
  if (manifestScopes.operations?.length && !manifestScopes.operations.includes(operation)) errors.push('operation_not_in_trust_manifest');

  const command = tool?.capability === 'automation.applescript'
    ? clean(args.script || args.code, 4000)
    : clean(args.command, 4000);
  if ((tool?.capability === 'shell.exec' || tool?.capability === 'automation.applescript') && command) {
    if (!scopeAllows(manifestScopes.commands, command, matchesPattern)) errors.push('shell_command_not_in_trust_manifest');
    if (!scopeAllows(allowScopes.commands, command, matchesPattern)) errors.push('shell_command_not_allowlisted');
  }

  if (tool?.capability === 'ssh.exec') {
    const host = clean(args.host, 300);
    if (!host) errors.push('ssh_host_required_for_allowlist');
    else {
      if (!scopeAllows(manifestScopes.hosts, host)) errors.push('ssh_host_not_in_trust_manifest');
      if (!scopeAllows(allowScopes.hosts, host)) errors.push('ssh_host_not_allowlisted');
    }
  }

  if (tool?.capability === 'network.upload' || tool?.capability === 'social.publish' || tool?.capability === 'browser.open') {
    const host = hostFromUrl(args.url || args.webhookUrl);
    const method = clean(args.method || (tool.capability === 'browser.open' ? 'GET' : 'POST'), 20).toUpperCase();
    if (!host) errors.push('network_host_required_for_allowlist');
    else {
      if (!scopeAllows(manifestScopes.hosts, host)) errors.push('network_host_not_in_trust_manifest');
      if (!scopeAllows(allowScopes.hosts, host)) errors.push('network_host_not_allowlisted');
    }
    if (tool.capability !== 'browser.open') {
      if (!scopeAllows((manifestScopes.networkMethods || []).map((item) => item.toUpperCase()), method)) errors.push('network_method_not_in_trust_manifest');
      if (!scopeAllows((allowScopes.networkMethods || []).map((item) => item.toUpperCase()), method)) errors.push('network_method_not_allowlisted');
    }
    const filePath = clean(args.filePath || args.path || '', 2000);
    if (tool.capability === 'network.upload' && filePath) {
      const targetPath = resolve(root, filePath);
      if (!manifestScopes.paths?.length) errors.push('path_scope_required_in_trust_manifest');
      else if (!manifestScopes.paths.some((p) => pathInside(p, targetPath) || normalizePath(p) === targetPath)) errors.push('path_not_in_trust_manifest');
      if (!allowScopes.paths?.length) errors.push('path_scope_required_for_allowlist');
      else if (!allowScopes.paths.some((p) => pathInside(p, targetPath) || normalizePath(p) === targetPath)) errors.push('path_not_allowlisted');
    }
  }

  if (tool?.capability?.startsWith('social.draft.')) {
    const draftDir = clean(args.draftDir || args.dir || '', 2000);
    const targetPath = draftDir ? resolve(root, draftDir) : '';
    if (!targetPath) errors.push('social_draft_dir_required_for_allowlist');
    else if (!manifestScopes.paths?.length) errors.push('path_scope_required_in_trust_manifest');
    else if (!manifestScopes.paths.some((p) => pathInside(p, targetPath) || normalizePath(p) === targetPath)) errors.push('path_not_in_trust_manifest');
    // targetPath 为空时第 133 行已 push 过错误，此处只在有路径时校验 allowlist（原「空 if/else-if」等价改写，去掉空块）
    if (targetPath) {
      if (!allowScopes.paths?.length) errors.push('path_scope_required_for_allowlist');
      else if (!allowScopes.paths.some((p) => pathInside(p, targetPath) || normalizePath(p) === targetPath)) errors.push('path_not_allowlisted');
    }
  }

  if (tool?.capability === 'secret.keychain') {
    const secretRef = `keychain:${clean(args.service || 'Neo Jarvis Noe model API keys', 240)}:${clean(args.account, 200)}`;
    if (!scopeAllows(manifestScopes.secrets, secretRef)) errors.push('secret_ref_not_in_trust_manifest');
    if (!scopeAllows(allowScopes.secrets, secretRef)) errors.push('secret_ref_not_allowlisted');
  }

  if (['secret.env', 'desktop.inventory', 'ssh.inventory'].includes(tool?.capability)) {
    const defaultPath = tool.capability === 'secret.env'
      ? '.env'
      : tool.capability === 'ssh.inventory'
        ? `${homedir()}/.ssh/config`
        : '';
    const targetPath = resolve(root, clean(args.path || defaultPath, 2000));
    if (!manifestScopes.paths?.length) errors.push('path_scope_required_in_trust_manifest');
    else if (!manifestScopes.paths.some((p) => pathInside(p, targetPath) || normalizePath(p) === targetPath)) errors.push('path_not_in_trust_manifest');
    if (!allowScopes.paths?.length) errors.push('path_scope_required_for_allowlist');
    else if (!allowScopes.paths.some((p) => pathInside(p, targetPath) || normalizePath(p) === targetPath)) errors.push('path_not_allowlisted');
  }

  if (tool?.capability?.startsWith('tool.')) {
    const id = tool.capability === 'tool.registry.list'
      ? clean(args.id || '*', 180)
      : clean(args.id || args.manifest?.id || args.tool?.id, 180);
    if (!id) errors.push('marketplace_tool_id_required_for_allowlist');
    else {
      if (!scopeAllows(manifestScopes.marketplaceTools, id)) errors.push('marketplace_tool_not_in_trust_manifest');
      if (!scopeAllows(allowScopes.marketplaceTools, id)) errors.push('marketplace_tool_not_allowlisted');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    allowlist: normalizedAllowlist,
  };
}
