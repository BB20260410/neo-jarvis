// @ts-check
// infra 域适配器：shell / ssh / env / desktop / keychain / file.delete / network.upload / freedom.run.history。
// 拆分自 NoeFreedomAdapters.js（纯搬运，行为零改变）。
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { redactNoeFreedomPayload } from '../../capabilities/NoeFreedomManifest.js';
import { defaultNoeSecretBroker, NoeSecretBroker } from '../../secrets/NoeSecretBroker.js';
import { createSafeDeleter } from '../../workspace/NoeSafeDelete.js';
import { DEFAULT_NOE_SSH_CONFIG_PATH, inspectNoeSshInventory } from '../NoeSshInventory.js';
import { DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR, listNoeFreedomRunLedgers } from '../NoeFreedomRunLedger.js';
import { clean, dryRunPlan, hostFromUrl, redactDiagnosticText, runProcess, safeJson, SHELL_BIN } from './common.js';

export function shellDryRun({ tool, args }) {
  const command = clean(args.command, 4000);
  return dryRunPlan({
    tool,
    args,
    adapter: 'shell',
    extras: {
      valid: Boolean(command),
      commandPreview: command,
      cwdPreview: clean(args.cwd || '', 2000),
    },
    warnings: command ? [] : ['command_required'],
  });
}

export async function shellExecute({ args, root, deps }) {
  const command = clean(args.command, 4000);
  if (!command) return { ok: false, adapter: 'shell', error: 'command_required' };
  const cwd = clean(args.cwd || root, 2000) || root;
  return {
    adapter: 'shell',
    ...(await runProcess(SHELL_BIN, ['-lc', command], { cwd, spawnImpl: deps.spawn || spawn })),
  };
}

export function sshDryRun({ tool, args }) {
  const host = clean(args.host, 300);
  const remoteCommand = clean(args.command, 4000);
  const warnings = [];
  if (!host) warnings.push('ssh_host_required');
  if (!remoteCommand) warnings.push('ssh_command_required');
  return dryRunPlan({
    tool,
    args,
    adapter: 'ssh',
    extras: {
      valid: warnings.length === 0,
      securityMode: 'execute_with_system_ssh_no_secret_output',
      host,
      remoteCommandPreview: remoteCommand,
      networkConnectionAttempted: false,
      privateKeyReadByNoe: false,
      passwordPromptAllowed: false,
    },
    warnings,
  });
}

export function sshInventoryDryRun({ tool, args }) {
  const path = clean(args.path || DEFAULT_NOE_SSH_CONFIG_PATH, 2000);
  return dryRunPlan({
    tool,
    args,
    adapter: 'ssh-inventory',
    extras: {
      valid: true,
      securityMode: 'inventory_only',
      path,
      wouldReadSshConfig: true,
      privateKeyRead: false,
      networkConnectionAttempted: false,
      passwordPromptAllowed: false,
    },
  });
}

export function sshInventoryExecute({ args }) {
  return {
    adapter: 'ssh-inventory',
    ...inspectNoeSshInventory({
      path: args.path || DEFAULT_NOE_SSH_CONFIG_PATH,
      maxHosts: args.maxHosts || args.limit,
      allowSymlink: args.allowSymlink === true,
    }),
  };
}

export async function sshExecute({ args, root, deps }) {
  const host = clean(args.host, 300);
  const remoteCommand = clean(args.command, 4000);
  if (!host) return { ok: false, adapter: 'ssh', error: 'ssh_host_required' };
  if (!remoteCommand) return { ok: false, adapter: 'ssh', error: 'ssh_command_required' };
  return {
    adapter: 'ssh',
    securityMode: 'execute_with_system_ssh_no_secret_output',
    networkConnectionAttempted: true,
    privateKeyReadByNoe: false,
    passwordPromptAllowed: false,
    ...(await runProcess('ssh', ['-o', 'BatchMode=yes', host, remoteCommand], { cwd: root, spawnImpl: deps.spawn || spawn })),
  };
}

export function inspectEnv({ args, root, deps }) {
  const broker = deps.secretBroker || defaultNoeSecretBroker;
  return {
    adapter: 'env',
    ...broker.inspectEnvFile({
      path: args.path || '.env',
      root,
      allowOutsideRoot: args.allowOutsideRoot === true,
    }),
  };
}

export function inspectDesktop({ args }) {
  const path = args.path ? resolve(String(args.path).replace(/^~/, homedir())) : join(homedir(), 'Desktop');
  if (!existsSync(path)) return { ok: false, adapter: 'desktop', error: 'desktop_path_not_found', path };
  const maxEntries = Math.max(1, Math.min(500, Number(args.maxEntries || args.limit) || 80));
  const entries = readdirSync(path, { withFileTypes: true })
    .filter((entry) => args.includeHidden === true || !entry.name.startsWith('.'))
    .slice(0, maxEntries)
    .map((entry) => {
      const full = join(path, entry.name);
      let size = null;
      try { size = statSync(full).size; } catch {}
      return {
        name: clean(entry.name, 240),
        type: entry.isDirectory() ? 'directory' : entry.isSymbolicLink() ? 'symlink' : 'file',
        size,
        extension: entry.isFile() && entry.name.includes('.') ? clean(entry.name.slice(entry.name.lastIndexOf('.')), 40) : '',
      };
    });
  return { ok: true, adapter: 'desktop', path, count: entries.length, entries, contentRead: false };
}

export function readKeychain({ args, deps }) {
  const broker = deps.secretBroker || (deps.spawnSync ? new NoeSecretBroker({ spawnSyncImpl: deps.spawnSync }) : defaultNoeSecretBroker);
  return {
    adapter: 'keychain',
    ...broker.readKeychainMetadata(args),
  };
}

export function freedomRunHistoryDryRun({ tool, args }) {
  return dryRunPlan({
    tool,
    args,
    adapter: 'freedom-run-history',
    extras: {
      valid: true,
      ledgerDir: clean(args.dir || args.outDir || DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR, 2000),
      limit: Math.max(1, Math.min(200, Number(args.limit) || 20)),
      onlyWithNextActions: args.onlyWithNextActions === true,
      requireOk: args.requireOk !== false,
      wouldReadFreedomRunLedgers: true,
      secretValuesReturned: false,
      sideEffectPerformed: false,
    },
  });
}

export function freedomRunHistoryExecute({ args, root }) {
  const listed = listNoeFreedomRunLedgers({
    root,
    dir: args.dir || args.outDir || DEFAULT_NOE_FREEDOM_RUN_LEDGER_DIR,
    limit: args.limit || 20,
    onlyWithNextActions: args.onlyWithNextActions === true,
    requireOk: args.requireOk !== false,
  });
  const nextFreedomActions = listed.items
    .filter((item) => item.resumeCandidate)
    .slice(0, 12)
    .map((item) => ({
      stepId: `resume_${clean(item.runId || 'freedom_run', 80)}`.replace(/[^a-z0-9_.-]+/gi, '_'),
      title: `续跑 ${clean(item.runId || item.ref, 160)}`,
      actionId: 'noe.freedom.run.resume_next_actions',
      mode: 'developer_unrestricted',
      args: {
        ledgerRef: item.ref,
        stopOnError: true,
        persistChildLedgers: true,
      },
    }));
  return {
    adapter: 'freedom-run-history',
    plannedOnly: false,
    ...listed,
    nextFreedomActions,
    secretValuesReturned: false,
    sideEffectPerformed: false,
  };
}

function fileDeletePath(args = {}) {
  return clean(args.path || args.filePath || args.targetPath || '', 2000);
}

export function fileDeleteDryRun({ tool, args, root, deps }) {
  const targetPath = fileDeletePath(args);
  const deleter = createSafeDeleter({
    cwd: root,
    homeDir: deps.homeDir,
    trasher: deps.trasher,
  });
  const plan = deleter.plan(targetPath);
  const warnings = [];
  if (!targetPath) warnings.push('file_delete_path_required');
  if (plan.blocked) warnings.push(`file_delete_blocked:${clean(plan.reason || 'blocked', 120)}`);
  return dryRunPlan({
    tool,
    args,
    adapter: 'file-delete',
    extras: {
      valid: plan.ok === true,
      targetPath: plan.src || targetPath,
      plan,
      wouldTrash: plan.ok === true && plan.action === 'trash',
      realFileDeletePerformed: false,
      fileDeletedToTrash: false,
      sideEffectPerformed: false,
      secretValuesReturned: false,
      rollbackExpectation: 'finder_put_back_from_trash',
    },
    warnings,
  });
}

export async function fileDeleteExecute({ args, root, deps }) {
  const targetPath = fileDeletePath(args);
  const deleter = createSafeDeleter({
    cwd: root,
    homeDir: deps.homeDir,
    trasher: deps.trasher,
  });
  const out = await deleter.delete(targetPath);
  return {
    ok: out.ok === true && out.trashed === true,
    adapter: 'file-delete',
    targetPath: out.src || targetPath,
    plan: {
      ok: out.ok === true,
      blocked: out.blocked === true,
      action: out.action || '',
      reason: clean(out.reason || '', 160),
    },
    trashed: out.trashed === true,
    realFileDeletePerformed: out.trashed === true,
    fileDeletedToTrash: out.trashed === true,
    sideEffectPerformed: out.trashed === true,
    rollbackExpectation: 'finder_put_back_from_trash',
    secretValuesReturned: false,
    ...(out.error ? { error: redactDiagnosticText(out.error, 500) } : {}),
    blockers: out.ok === true && out.trashed === true ? [] : [`file_delete_failed:${clean(out.reason || out.error || 'unknown', 180)}`],
  };
}

function uploadFilePath(args = {}) {
  return clean(args.filePath || args.path || '', 2000);
}

const MAX_NETWORK_UPLOAD_FILE_BYTES = 25 * 1024 * 1024;
const SECRET_UPLOAD_BASENAMES = new Set([
  '.env',
  '.env.local',
  '.npmrc',
  '.netrc',
  '.pypirc',
  'owner-token',
  'owner-token.txt',
  'room-adapters.json',
  'id_rsa',
  'id_ed25519',
  'id_dsa',
  'id_ecdsa',
]);
const SECRET_UPLOAD_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.noe-panel',
]);
const SECRET_UPLOAD_NAME_RE = /(^|[-_.])(token|secret|credential|credentials|api[-_]?key|private[-_]?key|oauth|cookie|session)([-_.]|$)/i;

function normalizeUploadFilePath(root = process.cwd(), filePath = '') {
  const raw = uploadFilePath({ filePath });
  if (!raw) return { ok: false, error: 'upload_file_path_required', filePath: '' };
  const rootPath = resolve(root || process.cwd());
  const resolved = resolve(rootPath, raw);
  const relativePath = relative(rootPath, resolved);
  if (!relativePath || relativePath.startsWith('..') || isAbsolute(relativePath)) {
    return { ok: false, error: 'upload_file_path_outside_root', filePath: raw };
  }
  const normalized = relativePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  const basename = parts.at(-1)?.toLowerCase() || '';
  const containsSecretDir = parts.slice(0, -1).some((part) => SECRET_UPLOAD_SEGMENTS.has(part.toLowerCase()));
  if (containsSecretDir || SECRET_UPLOAD_BASENAMES.has(basename) || SECRET_UPLOAD_NAME_RE.test(basename)) {
    return { ok: false, error: 'upload_secret_path_blocked', filePath: normalized };
  }
  return { ok: true, resolved, filePath: normalized };
}

export function uploadDryRun({ tool, args, root }) {
  const url = clean(args.url, 2000);
  const method = clean(args.method || 'POST', 12).toUpperCase();
  const body = clean(args.body || args.content || '', 20_000);
  const filePath = uploadFilePath(args);
  const warnings = [];
  if (!/^https?:\/\//i.test(url)) warnings.push('upload_url_must_be_http');
  let fileBytes = 0;
  let fileExists = false;
  if (filePath) {
    const normalized = normalizeUploadFilePath(root, filePath);
    if (!normalized.ok) {
      warnings.push(normalized.error);
    } else {
      try {
        const stat = statSync(normalized.resolved);
        fileExists = stat.isFile();
        fileBytes = fileExists ? stat.size : 0;
        if (!fileExists) warnings.push('upload_file_not_a_file');
        if (fileExists && stat.size > MAX_NETWORK_UPLOAD_FILE_BYTES) warnings.push('upload_file_too_large');
      } catch {
        warnings.push('upload_file_not_found');
      }
    }
  }
  return dryRunPlan({
    tool,
    args,
    adapter: 'network-upload',
    extras: {
      valid: warnings.length === 0,
      method,
      host: hostFromUrl(url),
      filePath: filePath || '',
      fileExists,
      fileContentRead: false,
      maxFileBytes: MAX_NETWORK_UPLOAD_FILE_BYTES,
      wouldUploadBytes: filePath ? fileBytes : Buffer.byteLength(body || JSON.stringify(redactNoeFreedomPayload(args.payload || {})), 'utf8'),
      rollbackExpectation: 'endpoint_defined',
    },
    warnings,
  });
}

export async function uploadExecute({ args, root, deps }) {
  const url = clean(args.url, 2000);
  if (!/^https?:\/\//i.test(url)) return { ok: false, adapter: 'network-upload', error: 'upload_url_must_be_http' };
  const body = clean(args.body || args.content || '', 20_000);
  const filePath = uploadFilePath(args);
  let uploadBody = body || JSON.stringify(redactNoeFreedomPayload(args.payload || {}));
  let fileBytes = 0;
  let fileRef = '';
  if (filePath) {
    const normalized = normalizeUploadFilePath(root, filePath);
    if (!normalized.ok) return { ok: false, adapter: 'network-upload', error: normalized.error, filePath: normalized.filePath || filePath };
    try {
      const stat = statSync(normalized.resolved);
      if (!stat.isFile()) return { ok: false, adapter: 'network-upload', error: 'upload_file_not_a_file', filePath: normalized.filePath };
      if (stat.size > MAX_NETWORK_UPLOAD_FILE_BYTES) {
        return {
          ok: false,
          adapter: 'network-upload',
          error: 'upload_file_too_large',
          filePath: normalized.filePath,
          fileBytes: stat.size,
          maxFileBytes: MAX_NETWORK_UPLOAD_FILE_BYTES,
        };
      }
      uploadBody = readFileSync(normalized.resolved);
      fileBytes = stat.size;
      fileRef = normalized.filePath;
    } catch {
      return { ok: false, adapter: 'network-upload', error: 'upload_file_not_found', filePath: normalized.filePath };
    }
  }
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return { ok: false, adapter: 'network-upload', error: 'fetch_unavailable' };
  const headers = {
    'content-type': filePath ? clean(args.contentType || args.content_type || 'application/octet-stream', 120) : 'application/json',
    ...safeJson(args.headers),
  };
  const response = await fetchImpl(url, {
    method: clean(args.method || 'POST', 12).toUpperCase(),
    headers,
    body: uploadBody,
  });
  return {
    ok: response.ok,
    adapter: 'network-upload',
    status: response.status,
    host: hostFromUrl(url),
    fileUploaded: Boolean(filePath),
    fileRef,
    fileBytes,
    fileContentReturned: false,
    responsePreview: clean(await response.text?.(), 1000),
  };
}
