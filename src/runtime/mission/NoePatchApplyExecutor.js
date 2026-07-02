// @ts-check

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { NoePatchTransaction } from './NoePatchTransaction.js';
import { redactSensitiveText } from '../NoeContextScrubber.js';
import { classifyNoePolicyFilePath, gitAwareTestFileExists } from '../../security/NoePolicyFileGuard.js';

export const NOE_PATCH_APPLY_SCHEMA_VERSION = 1;
export const NOE_PATCH_APPLY_REPORT_DIR = 'output/noe-patch-transactions/apply-reports';
export const NOE_PATCH_ROLLBACK_REPORT_DIR = 'output/noe-patch-transactions/rollback-reports';
export const NOE_PATCH_BACKUP_DIR = 'output/noe-patch-transactions/backups';

const SECRET_PATH_RE = /(^|\/)(\.env|\.npmrc|\.netrc|.*token.*|.*cookie.*|.*oauth.*|.*secret.*|owner-token\.txt|room-adapters\.json)$/i;

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function sha256(value) {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null), 'utf8').digest('hex');
}

function rel(root, file) {
  const ref = relative(root, file).replaceAll('\\', '/');
  if (ref && !ref.startsWith('..') && ref !== '..' && !isAbsolute(ref)) return ref;
  return file;
}

function isInside(root, file) {
  const ref = relative(root, file);
  return ref && !ref.startsWith('..') && ref !== '..' && !isAbsolute(ref);
}

function safeResolve(root, ref = '') {
  const file = resolve(root, String(ref || ''));
  return isInside(root, file) ? file : null;
}

function blockedPath(ref = '') {
  const normalized = String(ref || '').replaceAll('\\', '/');
  return SECRET_PATH_RE.test(normalized) || normalized.includes('games/cartoon-apocalypse/');
}

// 命中受保护策略文件（PolicyFileGuard）→ matchedId 字符串供 blockers 标注；否则 ''。
// 安全门：禁止自改链路改掉自己的测试/授权脚本/安全门源码。需 rootAbs 做项目相对解析。
function policyFileBlockReason(rootAbs, ref = '', opts = {}) {
  // A2：NOE_ALLOW_NEW_TEST_FILES=1 时放行飞轮「新增」测试文件（改现有/scripts/具体policy文件仍禁）——修 bug 写复现测试/加能力写配套测试的前提。
  //   opts.fileExists 可注入：rollback「删除 apply 新建测试」时文件已被写入(存在)，须传「报不存在」(manifest existed=false 为证)，
  //   否则 A2 默认 existsSync 误判改现有 → 挡 rollback → 新建测试删不掉残留污染 baseline（实测死循环教训）。
  // 默认 git-aware：untracked 飞轮残留测试视为可覆盖（放行重写，根治残留死循环）；rollback 传 rbFileExists(existed-based)时优先用它。
  const fileExists = typeof opts.fileExists === 'function' ? opts.fileExists : (p) => gitAwareTestFileExists(p, rootAbs);
  const hit = classifyNoePolicyFilePath(String(ref || ''), {
    root: rootAbs, cwd: rootAbs,
    allowNewTestFiles: process.env.NOE_ALLOW_NEW_TEST_FILES === '1',
    fileExists,
  });
  return hit && hit.protected === true ? (hit.matchedId || hit.reason || 'policy-file') : '';
}

function reportFileName(kind = 'apply') {
  return `patch-${kind}-${Date.now()}-${randomUUID().slice(0, 8)}.json`;
}

function sanitizeFileName(value = 'backup') {
  return basename(String(value || 'backup')).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'backup';
}

function readJson(file) {
  if (!existsSync(file)) return { ok: false, error: 'json_file_missing' };
  try {
    return { ok: true, data: JSON.parse(readFileSync(file, 'utf8')) };
  } catch {
    return { ok: false, error: 'json_parse_failed' };
  }
}

export function extractNoePatchPlan(value = {}) {
  if (value?.patchPlan && typeof value.patchPlan === 'object') return value.patchPlan;
  if (value?.taskOutput?.patchPlan && typeof value.taskOutput.patchPlan === 'object') return value.taskOutput.patchPlan;
  if (value?.kind === 'noe_patch_plan' || Array.isArray(value?.operations)) return value;
  return null;
}

function summarizeOperation(rootAbs, operation = {}, index = 0) {
  const op = clean(operation.op || operation.type || 'write_file', 80);
  const path = clean(operation.path, 1000);
  const content = String(operation.content ?? '');
  const from = String(operation.from ?? '');
  const to = String(operation.to ?? '');
  const isReplace = op === 'replace';
  const file = safeResolve(rootAbs, path);
  const blockers = [];
  if (op !== 'write_file' && op !== 'replace') blockers.push(`unsupported_patch_operation:${op || 'missing'}`);
  if (!path) blockers.push('patch_path_required');
  if (!file) blockers.push(`patch_path_outside_root:${path || 'missing'}`);
  if (policyFileBlockReason(rootAbs, path)) blockers.push(`patch_path_policy_protected:${path}`);
  else if (blockedPath(path)) blockers.push(`patch_path_blocked:${path}`);
  if (isReplace) {
    if (!from) blockers.push(`patch_replace_from_required:${operation.id || `op-${index + 1}`}`);
    if (redactSensitiveText(to) !== to) blockers.push(`patch_content_contains_secret_like_value:${path || 'missing'}`);
    // 唯一性/file_missing/finalText-secret 全部交给 NoePatchTransaction.checkPreconditions 的「虚拟串行应用」：
    //   同文件多 op 时唯一性须基于前序 op 改后的中间态，逐 op 读原盘会误报合法链式改、漏报注入式越界改。
  } else {
    if (!content) blockers.push(`patch_content_required:${operation.id || `op-${index + 1}`}`);
    if (redactSensitiveText(content) !== content) blockers.push(`patch_content_contains_secret_like_value:${path || 'missing'}`);
  }
  const existed = Boolean(file && existsSync(file));
  return {
    id: clean(operation.id || `op-${index + 1}`, 160),
    op,
    path,
    existed,
    willOverwrite: existed,
    contentSha256: sha256(isReplace ? JSON.stringify([from, to]) : content),
    contentBytes: Buffer.byteLength(isReplace ? to : content, 'utf8'),
    blockers,
  };
}

export function buildNoePatchApplyPlan({
  root = process.cwd(),
  patchPlan = {},
  patchPlanRef = '',
} = {}) {
  const rootAbs = resolve(root);
  const operations = asArray(patchPlan?.operations).map((operation, index) => summarizeOperation(rootAbs, operation, index));
  const blockers = [];
  if (!patchPlan || typeof patchPlan !== 'object') blockers.push('patch_plan_required');
  if (!operations.length) blockers.push('patch_operations_required');
  for (const operation of operations) blockers.push(...operation.blockers);
  const tx = new NoePatchTransaction({ root: rootAbs, missionId: patchPlan?.missionId || patchPlan?.providerId || 'patch-apply-plan', patchPlan });
  const preflight = tx.checkPreconditions();
  if (!preflight.ok) blockers.push(...preflight.blockers);
  return {
    ok: blockers.length === 0,
    blockers: [...new Set(blockers)],
    plan: {
      schemaVersion: NOE_PATCH_APPLY_SCHEMA_VERSION,
      status: blockers.length ? 'blocked' : 'ready_for_apply',
      patchPlanRef: clean(patchPlanRef, 500),
      providerId: clean(patchPlan?.providerId || '', 120),
      objective: clean(patchPlan?.objective || '', 1000),
      operationCount: operations.length,
      operations: operations.map(({ blockers: _blockers, ...operation }) => operation),
      requiresOwnerConfirmation: true,
      dryRunOnlyByDefault: true,
      rollbackEvidenceRequired: true,
      writesRepoFiles: true,
    },
  };
}

function writeBackupManifest({
  rootAbs,
  backupDir,
  applyId,
  patchPlanRef,
  backups = [],
  now,
} = {}) {
  const dir = resolve(rootAbs, backupDir, applyId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const entries = backups.map((backup, index) => {
    const entry = {
      path: clean(backup.ref, 1000),
      existed: backup.existed === true,
      backupRef: '',
      previousSha256: backup.existed ? sha256(backup.previous || '') : '',
      previousBytes: backup.existed ? Buffer.byteLength(String(backup.previous || ''), 'utf8') : 0,
    };
    if (backup.existed) {
      const file = resolve(dir, `${String(index + 1).padStart(4, '0')}-${sanitizeFileName(backup.ref)}.bak`);
      writeFileSync(file, String(backup.previous || ''), { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch {}
      entry.backupRef = rel(rootAbs, file);
    }
    return entry;
  });
  const manifest = {
    schemaVersion: NOE_PATCH_APPLY_SCHEMA_VERSION,
    applyId,
    generatedAt: now,
    patchPlanRef: clean(patchPlanRef, 500),
    entries,
    secretValuesReturned: false,
  };
  const manifestPath = resolve(dir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(manifestPath, 0o600); } catch {}
  return { manifest, ref: rel(rootAbs, manifestPath) };
}

export function runNoePatchApply({
  root = process.cwd(),
  patchPlanRef = '',
  reportDir = NOE_PATCH_APPLY_REPORT_DIR,
  backupDir = NOE_PATCH_BACKUP_DIR,
  dryRun = true,
  confirmOwner = false,
  now = new Date(),
} = {}) {
  const rootAbs = resolve(root);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const reportPath = resolve(rootAbs, reportDir, reportFileName('apply'));
  const errors = [];
  let patchPlan = null;
  if (!patchPlanRef) {
    // no-op smoke path
  } else {
    const patchPlanPath = safeResolve(rootAbs, patchPlanRef);
    if (!patchPlanPath) errors.push({ error: 'patch_plan_ref_outside_root' });
    else {
      const loaded = readJson(patchPlanPath);
      if (!loaded.ok) errors.push({ error: loaded.error });
      else {
        patchPlan = extractNoePatchPlan(loaded.data);
        if (!patchPlan) errors.push({ error: 'patch_plan_not_found' });
      }
    }
  }
  const built = patchPlan
    ? buildNoePatchApplyPlan({ root: rootAbs, patchPlan, patchPlanRef })
    : { ok: false, blockers: [], plan: { operations: [] } };
  const applyErrors = [...errors];
  if (!dryRun && confirmOwner !== true) applyErrors.push({ error: 'owner_confirmation_required' });
  const applyId = `patch-apply-${sha256Json({ patchPlanRef, generatedAt, operations: built.plan.operations }).slice(0, 16)}`;
  let applyResult = null;
  let diff = null;
  let backupManifestRef = '';
  if (!dryRun && applyErrors.length === 0 && built.ok && patchPlan) {
    const tx = new NoePatchTransaction({ root: rootAbs, missionId: applyId, patchPlan });
    try {
      applyResult = tx.apply();
      if (!applyResult.ok) applyErrors.push({ error: 'patch_transaction_apply_failed', preflight: applyResult.preflight });
      else {
        const backup = writeBackupManifest({
          rootAbs,
          backupDir,
          applyId,
          patchPlanRef,
          backups: tx.backups,
          now: generatedAt,
        });
        backupManifestRef = backup.ref;
        diff = tx.recordDiff();
      }
    } catch (error) {
      try { tx.rollback(); } catch {}
      applyErrors.push({ error: 'patch_transaction_exception', message: clean(error?.message || error, 500) });
    }
  }
  const blocked = patchPlanRef && !built.ok ? [{ blockers: built.blockers }] : [];
  const status = !patchPlanRef
    ? 'skipped'
    : (applyErrors.length || blocked.length ? 'blocked' : (dryRun ? 'dry_run_ready' : 'applied'));
  const report = {
    ok: !patchPlanRef || (applyErrors.length === 0 && blocked.length === 0),
    schemaVersion: NOE_PATCH_APPLY_SCHEMA_VERSION,
    generatedAt,
    status,
    reason: !patchPlanRef ? 'patch_plan_ref_required' : '',
    dryRun,
    applyId,
    patchPlanRef: clean(patchPlanRef, 500),
    reportRef: rel(rootAbs, reportPath),
    backupManifestRef,
    counts: {
      operations: built.plan.operations.length,
      changedFiles: applyResult?.changedFiles?.length || 0,
      blocked: blocked.length,
      errors: applyErrors.length,
    },
    errors: applyErrors,
    blocked,
    plan: built.plan,
    changedFiles: applyResult?.changedFiles || [],
    diff: diff ? { changedFiles: diff.changedFiles, operations: diff.operations, secretValuesReturned: false } : null,
    directWrites: dryRun ? [] : [
      rel(rootAbs, reportPath),
      ...(backupManifestRef ? [backupManifestRef] : []),
      ...(applyResult?.changedFiles || []),
    ],
    writesRepoFiles: !dryRun && (applyResult?.changedFiles?.length || 0) > 0,
    rollbackEvidenceRequired: !dryRun,
    secretValuesReturned: false,
  };
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(reportPath, 0o600); } catch {}
  return report;
}

function loadRollbackInput(rootAbs, applyReportRef = '') {
  const applyReportPath = safeResolve(rootAbs, applyReportRef);
  if (!applyReportPath) return { ok: false, error: 'apply_report_outside_root' };
  const loaded = readJson(applyReportPath);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, applyReport: loaded.data, applyReportPath };
}

function loadBackupManifest(rootAbs, ref = '') {
  const file = safeResolve(rootAbs, ref);
  if (!file) return { ok: false, error: 'backup_manifest_outside_root' };
  const loaded = readJson(file);
  if (!loaded.ok) return { ok: false, error: loaded.error };
  return { ok: true, manifest: loaded.data, file };
}

export function buildNoePatchRollbackPlan(applyReport = {}, {
  applyReportRef = '',
  backupManifest = null,
  root = process.cwd(),
} = {}) {
  const rootAbs = resolve(root);
  const blockers = [];
  if (applyReport?.status !== 'applied') blockers.push('apply_report_not_applied');
  if (applyReport?.rollbackEvidenceRequired !== true) blockers.push('rollback_evidence_not_required');
  if (!applyReport?.backupManifestRef) blockers.push('backup_manifest_ref_required');
  if (backupManifest && backupManifest.applyId !== applyReport.applyId) blockers.push('backup_manifest_apply_id_mismatch');
  const entries = asArray(backupManifest?.entries);
  if (backupManifest && !entries.length && asArray(applyReport.changedFiles).length > 0) blockers.push('backup_manifest_entries_required');
  const rollbackItems = entries.map((entry = {}) => {
    const itemBlockers = [];
    if (!entry.path) itemBlockers.push('rollback_path_required');
    if (blockedPath(entry.path)) itemBlockers.push(`rollback_path_blocked:${entry.path}`);
    // 纵深防御：rollback 也过 PolicyFileGuard，杜绝伪造 manifest 借回滚写受保护文件。
    //   A2 对称：existed=false 是「删除 apply 新建文件」(remove_new_file)，文件此刻已存在(apply 写的)，须传「报不存在」
    //   让 A2 放行删除新建测试——与 apply 放行新建对称。否则新建测试 verify 失败删不掉残留污染 baseline（实测死循环）。
    //   existed=true(restore_file 还原现有)仍按默认 existsSync 检查（改现有受保护文件仍挡）。
    const rbFileExists = entry.existed === false ? () => false : undefined;
    if (policyFileBlockReason(rootAbs, entry.path, { fileExists: rbFileExists })) itemBlockers.push(`rollback_path_policy_protected:${entry.path}`);
    if (entry.existed === true && !entry.backupRef) itemBlockers.push('backup_ref_required');
    return {
      path: clean(entry.path, 1000),
      action: entry.existed === true ? 'restore_file' : 'remove_new_file',
      backupRef: clean(entry.backupRef, 1000),
      previousSha256: clean(entry.previousSha256, 100),
      previousBytes: Number(entry.previousBytes || 0),
      blockers: itemBlockers,
    };
  });
  const itemBlockers = rollbackItems.flatMap((item) => item.blockers);
  return {
    ok: blockers.length === 0 && itemBlockers.length === 0,
    blockers: [...new Set([...blockers, ...itemBlockers])],
    plan: {
      schemaVersion: NOE_PATCH_APPLY_SCHEMA_VERSION,
      status: blockers.length || itemBlockers.length ? 'blocked' : 'ready_for_rollback',
      applyId: clean(applyReport?.applyId, 200),
      applyReportRef: clean(applyReportRef, 500),
      backupManifestRef: clean(applyReport?.backupManifestRef, 500),
      rollbackItems: rollbackItems.map(({ blockers: _blockers, ...item }) => item),
      requiresOwnerConfirmation: true,
      dryRunOnlyByDefault: true,
    },
  };
}

export function runNoePatchRollback({
  root = process.cwd(),
  applyReportRef = '',
  reportDir = NOE_PATCH_ROLLBACK_REPORT_DIR,
  dryRun = true,
  confirmOwner = false,
  now = new Date(),
} = {}) {
  const rootAbs = resolve(root);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const reportPath = resolve(rootAbs, reportDir, reportFileName('rollback'));
  const errors = [];
  let applyReport = null;
  let backupManifest = null;
  if (!applyReportRef) {
    // no-op smoke path
  } else {
    const input = loadRollbackInput(rootAbs, applyReportRef);
    if (!input.ok) errors.push({ error: input.error });
    else {
      applyReport = input.applyReport;
      const loadedManifest = loadBackupManifest(rootAbs, applyReport.backupManifestRef || '');
      if (!loadedManifest.ok) errors.push({ error: loadedManifest.error });
      else backupManifest = loadedManifest.manifest;
    }
  }
  const built = applyReport
    ? buildNoePatchRollbackPlan(applyReport, { applyReportRef, backupManifest, root: rootAbs })
    : { ok: false, blockers: [], plan: { rollbackItems: [] } };
  const rollbackErrors = [...errors];
  if (!dryRun && confirmOwner !== true) rollbackErrors.push({ error: 'owner_confirmation_required' });
  const rolledBack = [];
  if (!dryRun && rollbackErrors.length === 0 && built.ok) {
    for (const item of [...built.plan.rollbackItems].reverse()) {
      const target = safeResolve(rootAbs, item.path);
      if (!target) {
        rolledBack.push({ path: item.path, status: 'blocked', error: 'rollback_path_outside_root' });
        continue;
      }
      if (item.action === 'restore_file') {
        const backup = safeResolve(rootAbs, item.backupRef);
        if (!backup || !existsSync(backup)) {
          rolledBack.push({ path: item.path, status: 'blocked', error: 'backup_missing' });
          continue;
        }
        const previous = readFileSync(backup, 'utf8');
        if (item.previousSha256 && sha256(previous) !== item.previousSha256) {
          rolledBack.push({ path: item.path, status: 'blocked', error: 'backup_hash_mismatch' });
          continue;
        }
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, previous, 'utf8');
        rolledBack.push({
          path: item.path,
          action: item.action,
          status: sha256(readFileSync(target, 'utf8')) === item.previousSha256 ? 'restored' : 'restore_unverified',
        });
      } else if (item.action === 'remove_new_file') {
        if (existsSync(target)) rmSync(target, { force: true });
        rolledBack.push({
          path: item.path,
          action: item.action,
          status: existsSync(target) ? 'not_removed' : 'removed_or_already_missing',
        });
      } else {
        rolledBack.push({ path: item.path, status: 'blocked', error: `unsupported_rollback_action:${item.action}` });
      }
    }
  }
  const executionBlockers = rolledBack.filter((item) => item.status === 'blocked' || item.status === 'not_removed' || item.status === 'restore_unverified')
    .map((item) => ({ path: item.path, blockers: [item.error || item.status] }));
  const blocked = !applyReportRef
    ? []
    : [
        ...(!built.ok ? [{ blockers: built.blockers }] : []),
        ...executionBlockers,
      ];
  const status = !applyReportRef
    ? 'skipped'
    : (rollbackErrors.length || blocked.length ? 'blocked' : (dryRun ? 'dry_run_ready' : 'rolled_back'));
  const report = {
    ok: !applyReportRef || (rollbackErrors.length === 0 && blocked.length === 0),
    schemaVersion: NOE_PATCH_APPLY_SCHEMA_VERSION,
    generatedAt,
    status,
    reason: !applyReportRef ? 'apply_report_required' : '',
    dryRun,
    applyReportRef: clean(applyReportRef, 500),
    reportRef: rel(rootAbs, reportPath),
    counts: {
      rollbackItems: built.plan.rollbackItems.length,
      rolledBack: rolledBack.length,
      blocked: blocked.length,
      errors: rollbackErrors.length,
    },
    errors: rollbackErrors,
    blocked,
    plan: built.plan,
    rolledBack,
    directWrites: dryRun ? [] : [rel(rootAbs, reportPath), ...rolledBack.map((item) => item.path)],
    writesRepoFiles: !dryRun && rolledBack.length > 0,
    requiresOwnerConfirmation: true,
    secretValuesReturned: false,
  };
  mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  try { chmodSync(reportPath, 0o600); } catch {}
  return report;
}
