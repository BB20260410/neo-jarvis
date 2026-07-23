#!/usr/bin/env node
// @ts-check
/**
 * S8 packaging status — internal work vs owner-only external blockers.
 * Never marks whole S8 blocked_external while internal items remain open.
 *
 *   node scripts/noe-packaging-status.mjs [--out path] [--source-digest sha256:...]
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  resolvePackagingContract,
  resolveMacAppPath,
  evaluateUpdateDrain,
  evaluateUpdateIntegrity,
  evaluateIdentityBinding,
  evaluateS8StageStatus,
  fileMeta,
  CANONICAL_OUTPUT_DIR,
} from '../src/runtime/NoePackagingContract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] || def : def;
}

const outPath = arg('--out', join(ROOT, 'out-noe', 'packaging-status.json'));
const digestArg = arg('--source-digest', '');
const linuxVerificationPathArg = arg('--linux-verification', '');
const updateVerificationPathArg = arg('--update-verification', '');

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const contract = resolvePackagingContract(pkg);
const macApp = resolveMacAppPath(ROOT, process.env.NOE_PACK_ARCH || 'arm64', contract.productName);
const sbomPath = join(ROOT, CANONICAL_OUTPUT_DIR, 'sbom.json');
const rcManifestPath = join(ROOT, CANONICAL_OUTPUT_DIR, 'rc-manifest.json');
const sbomFileExists = existsSync(sbomPath);
const rcMacAppExists = macApp.source === 'canonical' || macApp.source === 'legacy';

function findTopLevelArtifact(predicate) {
  const outputDir = join(ROOT, CANONICAL_OUTPUT_DIR);
  if (!existsSync(outputDir)) return null;
  return readdirSync(outputDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => fileMeta(join(outputDir, entry.name)))
    .filter(Boolean)
    .sort((left, right) =>
      Number(right?.mtimeMs || 0) - Number(left?.mtimeMs || 0) ||
      String(left?.path || '').localeCompare(String(right?.path || '')),
    )[0] || null;
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function readAppVersion(appPath) {
  if (!appPath || !existsSync(appPath)) return '';
  const plist = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return '';
  const r = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist], {
    encoding: 'utf8',
  });
  return r.status === 0 ? String(r.stdout || '').trim() : '';
}

// Integrity suite (pure contract probes — fail branches included)
const integrityCases = [
  {
    id: 'good_n1_to_n',
    input: {
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'a'.repeat(64),
      signatureValid: true,
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      interrupted: false,
      healthOkWithinSec: 30,
      rollbackTriggered: false,
    },
    expectAccept: true,
  },
  {
    id: 'bad_hash_must_rollback',
    input: {
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'b'.repeat(64),
      signatureValid: true,
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      interrupted: false,
      healthOkWithinSec: 10,
      rollbackTriggered: true,
    },
    expectAccept: false,
    expectBlocker: 'bad_hash',
  },
  {
    id: 'bad_signature_without_rollback',
    input: {
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'a'.repeat(64),
      signatureValid: false,
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      interrupted: false,
      healthOkWithinSec: 10,
      rollbackTriggered: false,
    },
    expectAccept: false,
    expectBlocker: 'rollback_not_triggered',
  },
  {
    id: 'interrupt_requires_rollback',
    input: {
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'a'.repeat(64),
      signatureValid: true,
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      interrupted: true,
      healthOkWithinSec: 10,
      rollbackTriggered: true,
    },
    expectAccept: false,
    expectBlocker: 'update_interrupted',
  },
  {
    id: 'health_over_120s',
    input: {
      expectedSha256: 'a'.repeat(64),
      actualSha256: 'a'.repeat(64),
      signatureValid: true,
      fromVersion: '2.0.9',
      toVersion: '2.1.0',
      interrupted: false,
      healthOkWithinSec: 180,
      rollbackTriggered: true,
    },
    expectAccept: false,
    expectBlocker: 'health_window_exceeded_120s',
  },
];

const integrityResults = integrityCases.map((c) => {
  const r = evaluateUpdateIntegrity(c.input);
  const ok =
    r.accept === c.expectAccept &&
    (c.expectBlocker ? r.blockers.includes(c.expectBlocker) : true);
  return { id: c.id, ok, result: r };
});
const updateIntegrityContractProbePass = integrityResults.every((x) => x.ok);

const drainCases = [
  {
    id: 'undrained_running',
    state: { runningTaskCount: 2, drainComplete: false, checkpointWritten: false },
    expectAllowed: false,
  },
  {
    id: 'drained_ok',
    state: {
      runningTaskCount: 0,
      drainComplete: true,
      checkpointWritten: true,
      healthOkWithinSec: 25,
    },
    expectAllowed: true,
  },
  {
    id: 'health_fail',
    state: {
      runningTaskCount: 0,
      drainComplete: true,
      checkpointWritten: true,
      healthOkWithinSec: 200,
    },
    expectAllowed: false,
  },
];
const drainResults = drainCases.map((c) => {
  const r = evaluateUpdateDrain(c.state);
  return { id: c.id, ok: r.allowed === c.expectAllowed, result: r };
});
const drainContractProbePass = drainResults.every((x) => x.ok);

let sourceDigest = '';
try {
  const mod = await import('../src/runtime/NoeSourceDigest.js');
  const d = await mod.computeSourceDigest({ rootDir: ROOT });
  sourceDigest = d.sourceDigest || '';
} catch {
  sourceDigest = '';
}
if (digestArg && digestArg !== sourceDigest) {
  throw new Error(`sourceDigest mismatch: expected=${digestArg} actual=${sourceDigest || 'missing'}`);
}

const updateVerification = updateVerificationPathArg
  ? readJson(updateVerificationPathArg)
  : null;
const updateIntegrityClaimPass = Boolean(
  updateVerification &&
    updateVerification.sourceDigest === sourceDigest &&
    updateVerification.pass === true &&
    updateVerification.nMinus1ToNVerified === true &&
    updateVerification.badHashRejected === true &&
    updateVerification.badSignatureRejected === true &&
    updateVerification.interruptedUpdateRecovered === true &&
    updateVerification.rollbackVerified === true &&
    updateVerification.healthWithin120s === true,
);
const drainClaimPass = Boolean(
  updateVerification &&
    updateVerification.sourceDigest === sourceDigest &&
    updateVerification.pass === true &&
    updateVerification.runningTaskDrainVerified === true &&
    updateVerification.checkpointVerified === true,
);

let commit = '';
try {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) commit = (r.stdout || '').trim();
} catch {
  /* ignore */
}

const appMeta = rcMacAppExists ? fileMeta(macApp.path) : null;
const sbomMeta = sbomFileExists ? fileMeta(sbomPath) : null;
const sbom = sbomFileExists ? readJson(sbomPath) : null;
const rcManifest = readJson(rcManifestPath);
const rcManifestMeta = existsSync(rcManifestPath) ? fileMeta(rcManifestPath) : null;
const buildReceiptPath = join(ROOT, CANONICAL_OUTPUT_DIR, 'build-receipt.json');
const buildReceipt = readJson(buildReceiptPath);
const buildReceiptMeta = existsSync(buildReceiptPath) ? fileMeta(buildReceiptPath) : null;
const artifactPrefix = `${contract.productName}-${pkg.version}-`;
const isCurrentProductArtifact = (name) => name.startsWith(artifactPrefix);
const macDmgArtifact = findTopLevelArtifact(
  (name) => isCurrentProductArtifact(name) && /\.dmg$/i.test(name),
);
const macZipArtifact = findTopLevelArtifact(
  (name) => isCurrentProductArtifact(name) && /\.zip$/i.test(name),
);
const winArtifactPrefix = `${contract.productName}-Setup-${pkg.version}`;
const winNsisArtifact = findTopLevelArtifact(
  (name) => name.startsWith(winArtifactPrefix) && /\.exe$/i.test(name),
);
const linuxAppImageArtifact = findTopLevelArtifact(
  (name) => isCurrentProductArtifact(name) && /\.appimage$/i.test(name),
);
const linuxDebArtifact = findTopLevelArtifact(
  (name) => isCurrentProductArtifact(name) && /\.deb$/i.test(name),
);
const linuxHostReceipt = linuxVerificationPathArg
  ? readJson(linuxVerificationPathArg)
  : null;
const linuxEvidenceRoot = linuxVerificationPathArg
  ? dirname(resolve(linuxVerificationPathArg))
  : '';
const resolveLinuxEvidenceRef = (ref) => {
  if (!linuxEvidenceRoot || !ref || typeof ref !== 'object') return null;
  const rawPath = String(ref.path || '').trim();
  if (!rawPath) return null;
  const path = resolve(linuxEvidenceRoot, rawPath);
  if (path !== linuxEvidenceRoot && !path.startsWith(`${linuxEvidenceRoot}${sep}`)) return null;
  const meta = fileMeta(path);
  if (
    !meta ||
    meta.isDirectory ||
    !(meta.size > 0) ||
    !/^[0-9a-f]{64}$/i.test(String(ref.sha256 || '')) ||
    meta.sha256 !== String(ref.sha256).toLowerCase()
  ) return null;
  return meta;
};
const linuxSummaryMeta = resolveLinuxEvidenceRef(linuxHostReceipt?.summary);
const linuxSummary = linuxSummaryMeta ? readJson(linuxSummaryMeta.path) : null;
const linuxEvidenceKeys = [
  'embeddedIdentities',
  'unpackedNative',
  'appImageNative',
  'debNative',
  'appImageSmoke',
  'debSmoke',
  'debInfo',
];
const linuxEvidence = Object.fromEntries(
  linuxEvidenceKeys.map((key) => [
    key,
    resolveLinuxEvidenceRef(linuxHostReceipt?.evidence?.[key]),
  ]),
);
const linuxVerificationBlockers = [];
for (const key of linuxEvidenceKeys) {
  if (!linuxEvidence[key]) linuxVerificationBlockers.push(`linux_evidence_missing_or_unbound:${key}`);
}
const linuxIdentities = linuxEvidence.embeddedIdentities
  ? readJson(linuxEvidence.embeddedIdentities.path)
  : null;
for (const key of ['unpacked', 'appImage', 'deb']) {
  if (
    linuxIdentities?.[key]?.sourceDigest !== sourceDigest ||
    linuxIdentities?.[key]?.buildId !== linuxSummary?.buildId
  ) linuxVerificationBlockers.push(`linux_embedded_identity_invalid:${key}`);
}
const linuxNativeProbeOk = (meta) => {
  const probe = meta ? readJson(meta.path) : null;
  return Boolean(
    probe?.platform === 'linux' &&
    probe?.arch === 'arm64' &&
    probe?.modules === '136' &&
    probe?.sqlite === 1 &&
    probe?.ptySpawn === 'function' &&
    probe?.sherpaLoaded === true,
  );
};
for (const key of ['unpackedNative', 'appImageNative', 'debNative']) {
  if (!linuxNativeProbeOk(linuxEvidence[key])) {
    linuxVerificationBlockers.push(`linux_native_probe_invalid:${key}`);
  }
}
const linuxSmokeOk = (meta) => {
  if (!meta) return false;
  let events;
  try {
    events = readFileSync(meta.path, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return false;
  }
  const required = ['app_ready', 'server_node_selected', 'server_ready', 'window_loaded', 'smoke_quit_requested'];
  let previous = -1;
  for (const eventName of required) {
    const index = events.findIndex((event, i) => i > previous && event?.event === eventName);
    if (index < 0) return false;
    previous = index;
  }
  const runtime = events.find((event) => event?.event === 'server_node_selected');
  const window = events.find((event) => event?.event === 'window_loaded');
  return Boolean(
    runtime?.isElectron === true &&
    runtime?.modules === '136' &&
    String(window?.pageTitle || '').includes('Neo') &&
    String(window?.bodyMarker || '').includes('Neo'),
  );
};
for (const key of ['appImageSmoke', 'debSmoke']) {
  if (!linuxSmokeOk(linuxEvidence[key])) {
    linuxVerificationBlockers.push(`linux_smoke_invalid:${key}`);
  }
}
const pinnedLinuxImage = 'node:22.22.2-bookworm@sha256:c760c04370bd16dbbafd74bce0857af5ec32c3926902d8c8c2be2f87fedcf9b0';
if (
  linuxHostReceipt?.schemaVersion !== 1 ||
  linuxHostReceipt?.runner !== 'codex_linux_arm64_rc_v1' ||
  linuxHostReceipt?.pass !== true ||
  linuxHostReceipt?.sourceDigestBefore !== sourceDigest ||
  linuxHostReceipt?.sourceDigestAfter !== sourceDigest ||
  linuxHostReceipt?.containerImage !== pinnedLinuxImage ||
  !/^sha256:[0-9a-f]{64}$/i.test(String(linuxHostReceipt?.containerImageId || '')) ||
  linuxHostReceipt?.dockerPlatform !== 'linux/arm64/v8' ||
  !['aarch64', 'arm64'].includes(String(linuxHostReceipt?.colimaVmArch || '')) ||
  linuxHostReceipt?.containerExitCode !== 0 ||
  !linuxSummaryMeta ||
  linuxSummary?.schemaVersion !== 2 ||
  linuxSummary?.runner !== 'noe_linux_arm64_container_v1' ||
  linuxSummary?.pass !== true ||
  linuxSummary?.sourceDigest !== sourceDigest ||
  linuxSummary?.containerImage !== pinnedLinuxImage ||
  linuxSummary?.platform !== 'linux' ||
  linuxSummary?.arch !== 'arm64' ||
  !['aarch64', 'arm64'].includes(String(linuxSummary?.kernel?.arch || '')) ||
  linuxHostReceipt?.buildId !== linuxSummary?.buildId ||
  linuxSummary?.buildId?.length < 16 ||
  linuxHostReceipt?.appImage?.fileName !== linuxSummary?.appImage?.fileName ||
  linuxHostReceipt?.appImage?.sha256 !== linuxSummary?.appImage?.sha256 ||
  linuxHostReceipt?.deb?.fileName !== linuxSummary?.deb?.fileName ||
  linuxHostReceipt?.deb?.sha256 !== linuxSummary?.deb?.sha256 ||
  basename(linuxAppImageArtifact?.path || '') !== linuxSummary?.appImage?.fileName ||
  linuxAppImageArtifact?.sha256 !== linuxSummary?.appImage?.sha256 ||
  basename(linuxDebArtifact?.path || '') !== linuxSummary?.deb?.fileName ||
  linuxDebArtifact?.sha256 !== linuxSummary?.deb?.sha256
) {
  linuxVerificationBlockers.push('linux_host_receipt_summary_or_artifact_binding_invalid');
}
const linuxVerificationVerified = linuxVerificationBlockers.length === 0;
const embeddedPackage = rcMacAppExists
  ? readJson(join(macApp.path, 'Contents', 'Resources', 'app', 'package.json'))
  : null;
const receiptDmgEntries = Array.isArray(buildReceipt?.artifacts?.dmg)
  ? buildReceipt.artifacts.dmg
  : [];
const receiptZipEntries = Array.isArray(buildReceipt?.artifacts?.zip)
  ? buildReceipt.artifacts.zip
  : [];
const receiptDmg = receiptDmgEntries.find(
  (entry) => entry?.fileName === basename(macDmgArtifact?.path || ''),
);
const receiptZip = receiptZipEntries.find(
  (entry) => entry?.fileName === basename(macZipArtifact?.path || ''),
);

const updateVerificationBlockers = [];
const updateEvidenceRoot = updateVerificationPathArg
  ? dirname(resolve(updateVerificationPathArg))
  : '';
const resolveBoundEvidenceRef = (ref) => {
  if (!updateEvidenceRoot || !ref || typeof ref !== 'object') return null;
  const rawPath = String(ref.path || '').trim();
  if (!rawPath) return null;
  const path = resolve(updateEvidenceRoot, rawPath);
  if (path !== updateEvidenceRoot && !path.startsWith(`${updateEvidenceRoot}${sep}`)) return null;
  const meta = fileMeta(path);
  if (
    !meta ||
    meta.isDirectory ||
    !(meta.size > 0) ||
    !/^[0-9a-f]{64}$/i.test(String(ref.sha256 || '')) ||
    meta.sha256 !== String(ref.sha256).toLowerCase()
  ) return null;
  return meta;
};
const requiredUpdateEvidenceKeys = [
  'nMinus1ToN',
  'badHash',
  'badSignature',
  'interruptionRecovery',
  'rollback',
  'taskDrain',
  'checkpoint',
  'healthWindow',
];
const boundUpdateEvidence = Object.fromEntries(
  requiredUpdateEvidenceKeys.map((key) => [
    key,
    resolveBoundEvidenceRef(updateVerification?.evidence?.[key]),
  ]),
);
/** @type {Record<string, any>} */
const updateCaseReceipts = {};
/** @type {Record<string, any>} */
const updateCaseLogs = {};
for (const key of requiredUpdateEvidenceKeys) {
  const meta = boundUpdateEvidence[key];
  if (!meta) {
    updateVerificationBlockers.push(`update_evidence_missing_or_unbound:${key}`);
    continue;
  }
  const caseReceipt = readJson(meta.path);
  const rawLog = resolveBoundEvidenceRef(caseReceipt?.rawLog);
  updateCaseReceipts[key] = caseReceipt;
  updateCaseLogs[key] = rawLog;
  if (
    caseReceipt?.schemaVersion !== 1 ||
    caseReceipt?.runner !== 'noe_real_update_case_v1' ||
    caseReceipt?.caseId !== key ||
    caseReceipt?.sourceDigest !== sourceDigest ||
    caseReceipt?.buildId !== buildReceipt?.buildId ||
    caseReceipt?.pass !== true ||
    caseReceipt?.exitCode !== 0 ||
    caseReceipt?.signal != null ||
    !Array.isArray(caseReceipt?.command) ||
    caseReceipt.command.length === 0 ||
    !rawLog
  ) {
    updateVerificationBlockers.push(`update_case_receipt_invalid:${key}`);
  }
}
if (new Set(Object.values(boundUpdateEvidence).filter(Boolean).map((meta) => meta.path)).size !== requiredUpdateEvidenceKeys.length) {
  updateVerificationBlockers.push('update_case_receipts_not_unique');
}
if (new Set(Object.values(updateCaseLogs).filter(Boolean).map((meta) => meta.path)).size !== requiredUpdateEvidenceKeys.length) {
  updateVerificationBlockers.push('update_case_logs_not_unique');
}
const commandReceiptMeta = resolveBoundEvidenceRef(updateVerification?.commandReceipt);
const commandReceipt = commandReceiptMeta ? readJson(commandReceiptMeta.path) : null;
if (!commandReceiptMeta) updateVerificationBlockers.push('update_command_receipt_unbound');
if (
  commandReceipt?.runner !== 'noe_real_update_verification_v1' ||
  commandReceipt?.sourceDigest !== sourceDigest ||
  commandReceipt?.buildId !== buildReceipt?.buildId ||
  commandReceipt?.exitCode !== 0 ||
  commandReceipt?.signal != null ||
  !Array.isArray(commandReceipt?.command) ||
  commandReceipt.command.length === 0
) {
  updateVerificationBlockers.push('update_command_receipt_invalid');
}
const fromArtifactMeta = resolveBoundEvidenceRef(updateVerification?.fromArtifact);
if (!fromArtifactMeta) updateVerificationBlockers.push('update_from_artifact_unbound');
if (
  updateVerification?.schemaVersion !== 2 ||
  updateVerification?.runner !== 'noe_real_update_verification_v1' ||
  updateVerification?.sourceDigest !== sourceDigest ||
  updateVerification?.buildId !== buildReceipt?.buildId ||
  updateVerification?.toVersion !== pkg.version ||
  !updateVerification?.fromVersion ||
  updateVerification.fromVersion === updateVerification.toVersion ||
  !updateVerification?.fromBuildId ||
  updateVerification.fromBuildId === buildReceipt?.buildId ||
  updateVerification?.toArtifact?.fileName !== receiptZip?.fileName ||
  updateVerification?.toArtifact?.sha256 !== receiptZip?.sha256 ||
  updateVerification?.toArtifact?.sha256 !== macZipArtifact?.sha256
) {
  updateVerificationBlockers.push('update_identity_or_artifact_binding_invalid');
}
const updateVerificationBinding = {
  ok: updateVerificationBlockers.length === 0,
  blockers: updateVerificationBlockers,
  commandReceipt: commandReceiptMeta,
  evidence: boundUpdateEvidence,
  caseReceipts: updateCaseReceipts,
  caseLogs: updateCaseLogs,
  fromArtifact: fromArtifactMeta,
  toArtifact: macZipArtifact,
};
const updateIntegritySuitePass =
  updateIntegrityClaimPass && updateVerificationBinding.ok;
const drainSuitePass = drainClaimPass && updateVerificationBinding.ok;
const buildReceiptBlockers = [];
if (!buildReceipt) buildReceiptBlockers.push('build_receipt_missing');
if (buildReceipt?.sourceDigest !== sourceDigest) buildReceiptBlockers.push('build_receipt_digest_mismatch');
if (embeddedPackage?.noeSourceDigest !== sourceDigest) {
  buildReceiptBlockers.push('embedded_source_digest_mismatch');
}
if (!buildReceipt?.buildId || embeddedPackage?.noeBuildId !== buildReceipt.buildId) {
  buildReceiptBlockers.push('embedded_build_id_mismatch');
}
if (buildReceipt?.productName !== contract.productName) {
  buildReceiptBlockers.push('build_receipt_product_mismatch');
}
if (buildReceipt?.packageVersion !== pkg.version) {
  buildReceiptBlockers.push('build_receipt_version_mismatch');
}
if (buildReceipt?.macApp?.relativePath !== relative(ROOT, macApp.path)) {
  buildReceiptBlockers.push('build_receipt_app_path_mismatch');
}
if (!appMeta?.sha256 || buildReceipt?.macApp?.directoryTreeSha256 !== appMeta.sha256) {
  buildReceiptBlockers.push('build_receipt_app_hash_mismatch');
}
if (!macDmgArtifact?.sha256 || receiptDmg?.sha256 !== macDmgArtifact.sha256) {
  buildReceiptBlockers.push('build_receipt_dmg_hash_mismatch');
}
if (!macZipArtifact?.sha256 || receiptZip?.sha256 !== macZipArtifact.sha256) {
  buildReceiptBlockers.push('build_receipt_zip_hash_mismatch');
}
const buildReceiptBinding = {
  ok: buildReceiptBlockers.length === 0,
  blockers: buildReceiptBlockers,
  embeddedSourceDigest: embeddedPackage?.noeSourceDigest || null,
};
const sbomProperties = new Map(
  (Array.isArray(sbom?.metadata?.properties) ? sbom.metadata.properties : [])
    .map((property) => [property?.name, property?.value]),
);
const sbomBindingBlockers = [];
if (!sbom) sbomBindingBlockers.push('sbom_missing_or_invalid');
if (sbom?.bomFormat !== 'CycloneDX') sbomBindingBlockers.push('sbom_not_cyclonedx');
// npm sbom may use productName as display name while purl/package identity stays pkg.name
if (
  sbom?.metadata?.component?.name !== pkg.name &&
  sbom?.metadata?.component?.name !== pkg.productName
) {
  sbomBindingBlockers.push('sbom_name_mismatch');
}
if (sbom?.metadata?.component?.version !== pkg.version) sbomBindingBlockers.push('sbom_version_mismatch');
if (sbomProperties.get('noe:sourceDigest') !== sourceDigest) {
  sbomBindingBlockers.push('sbom_source_digest_mismatch');
}
if (sbomProperties.get('noe:buildId') !== buildReceipt?.buildId) {
  sbomBindingBlockers.push('sbom_build_id_mismatch');
}
if (sbomProperties.get('noe:macAppTreeSha256') !== appMeta?.sha256) {
  sbomBindingBlockers.push('sbom_app_hash_mismatch');
}
if (sbomProperties.get('noe:buildReceiptSha256') !== buildReceiptMeta?.sha256) {
  sbomBindingBlockers.push('sbom_build_receipt_hash_mismatch');
}
if (!/^[0-9a-f]{64}$/i.test(String(sbomProperties.get('noe:packagedNodeModulesManifestSha256') || ''))) {
  sbomBindingBlockers.push('sbom_packaged_manifest_missing');
}
if (!(Number(sbomProperties.get('noe:packagedPackageCount')) > 0)) {
  sbomBindingBlockers.push('sbom_packaged_package_count_missing');
}
const sbomBinding = { ok: sbomBindingBlockers.length === 0, blockers: sbomBindingBlockers };
const appVersion = rcMacAppExists ? readAppVersion(macApp.path) : '';
const directChecks = (() => {
  if (!rcMacAppExists) {
    return {
      codesignStrict: false,
      gatekeeperAccepted: false,
      notarizationTicketValid: false,
    };
  }
  const run = (command, args) => {
    const result = spawnSync(command, args, { encoding: 'utf8' });
    return {
      ok: result.status === 0,
      exitCode: typeof result.status === 'number' ? result.status : null,
      summary: String(result.stderr || result.stdout || '').trim().slice(0, 500),
    };
  };
  const codesign = run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', macApp.path]);
  const gatekeeper = run('/usr/sbin/spctl', ['-a', '-vv', '--type', 'execute', macApp.path]);
  const stapler = run('/usr/bin/xcrun', ['stapler', 'validate', macApp.path]);
  const dmgGatekeeper = macDmgArtifact
    ? run('/usr/sbin/spctl', ['-a', '-vv', '--type', 'install', macDmgArtifact.path])
    : { ok: false, exitCode: null, summary: 'mac_dmg_missing' };
  const dmgStapler = macDmgArtifact
    ? run('/usr/bin/xcrun', ['stapler', 'validate', macDmgArtifact.path])
    : { ok: false, exitCode: null, summary: 'mac_dmg_missing' };
  return {
    codesignStrict: codesign.ok,
    gatekeeperAccepted: gatekeeper.ok,
    notarizationTicketValid: stapler.ok,
    dmgGatekeeperAccepted: dmgGatekeeper.ok,
    dmgNotarizationTicketValid: dmgStapler.ok,
    details: { codesign, gatekeeper, stapler, dmgGatekeeper, dmgStapler },
  };
})();
const manifestIdentityBinding = evaluateIdentityBinding({
  packageVersion: pkg.version,
  appVersion,
  commit,
  expectedCommit: rcManifest?.commit,
  sourceDigest: sourceDigest || undefined,
  expectedSourceDigest: rcManifest?.sourceDigest,
  packageSha256: appMeta?.sha256 || undefined,
  manifestSha256: rcManifest?.macApp?.sha256,
});
const rcManifestBlockers = [];
if (!rcManifest) rcManifestBlockers.push('rc_manifest_missing');
if (rcManifest?.buildId !== buildReceipt?.buildId) rcManifestBlockers.push('rc_manifest_build_id_mismatch');
if (rcManifest?.embeddedSourceDigest !== sourceDigest) {
  rcManifestBlockers.push('rc_manifest_embedded_digest_mismatch');
}
if (rcManifest?.buildReceipt?.sha256 !== buildReceiptMeta?.sha256) {
  rcManifestBlockers.push('rc_manifest_build_receipt_hash_mismatch');
}
if (rcManifest?.sbom?.sha256 !== sbomMeta?.sha256) {
  rcManifestBlockers.push('rc_manifest_sbom_hash_mismatch');
}
if (!(
  Array.isArray(rcManifest?.macArtifacts?.dmg) &&
  rcManifest.macArtifacts.dmg.some((entry) => entry?.sha256 === macDmgArtifact?.sha256)
)) {
  rcManifestBlockers.push('rc_manifest_dmg_hash_mismatch');
}
if (!(
  Array.isArray(rcManifest?.macArtifacts?.zip) &&
  rcManifest.macArtifacts.zip.some((entry) => entry?.sha256 === macZipArtifact?.sha256)
)) {
  rcManifestBlockers.push('rc_manifest_zip_hash_mismatch');
}
const rcManifestBinding = { ok: rcManifestBlockers.length === 0, blockers: rcManifestBlockers };
const identityBinding = {
  ok: manifestIdentityBinding.ok && buildReceiptBinding.ok && rcManifestBinding.ok,
  blockers: [
    ...manifestIdentityBinding.blockers,
    ...buildReceiptBinding.blockers,
    ...rcManifestBinding.blockers,
  ],
  manifest: manifestIdentityBinding,
  buildReceipt: buildReceiptBinding,
  rcManifest: rcManifestBinding,
};

const releaseConfigPath = join(process.env.HOME || '', '.noe-panel', 'release-config.json');
const notarizationConfigured = existsSync(releaseConfigPath);

const stage = evaluateS8StageStatus(contract, {
  sbomExists: sbomBinding.ok,
  rcMacAppExists,
  updateIntegritySuitePass,
  drainSuitePass,
  identityBindingOk: identityBinding.ok,
  macDmgArtifactExists: Boolean(macDmgArtifact && receiptDmg),
  macDmgArtifactSha256: macDmgArtifact?.sha256 || undefined,
  macZipArtifactExists: Boolean(macZipArtifact && receiptZip),
  macZipArtifactSha256: macZipArtifact?.sha256 || undefined,
  winNsisArtifactExists: Boolean(winNsisArtifact),
  winNsisArtifactSha256: winNsisArtifact?.sha256 || undefined,
  linuxAppImageArtifactExists: Boolean(linuxAppImageArtifact),
  linuxAppImageArtifactSha256: linuxAppImageArtifact?.sha256 || undefined,
  linuxDebArtifactExists: Boolean(linuxDebArtifact),
  linuxDebArtifactSha256: linuxDebArtifact?.sha256 || undefined,
  crossPlatformArtifactsExternal: process.platform === 'darwin',
  crossPlatformRuntimeExternal: process.platform === 'darwin',
  winInstallVerified: false,
  linuxAppImageRunVerified: linuxVerificationVerified,
  linuxDebInstallVerified: linuxVerificationVerified,
  formalSignatureVerified:
    directChecks.codesignStrict === true &&
    directChecks.gatekeeperAccepted === true &&
    directChecks.dmgGatekeeperAccepted === true,
  notarizationVerified:
    directChecks.notarizationTicketValid === true &&
    directChecks.dmgNotarizationTicketValid === true,
});

const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  packageVersion: pkg.version,
  productName: contract.productName,
  appId: contract.appId,
  sourceDigest: sourceDigest || null,
  commit: commit || null,
  contract,
  macApp,
  appVersion: appVersion || null,
  sbom: sbomMeta,
  sbomBinding,
  appArtifact: appMeta,
  crossPlatformArtifacts: {
    macDmg: macDmgArtifact,
    macZip: macZipArtifact,
    winNsis: winNsisArtifact,
    linuxAppImage: linuxAppImageArtifact,
    linuxDeb: linuxDebArtifact,
  },
  linuxVerification: {
    path: linuxVerificationPathArg || null,
    verified: linuxVerificationVerified,
    blockers: linuxVerificationBlockers,
    hostReceipt: linuxHostReceipt,
    summary: linuxSummary,
    evidence: linuxEvidence,
  },
  buildReceipt: buildReceiptMeta,
  buildReceiptBinding,
  rcManifest: rcManifestMeta,
  suites: {
    updateIntegrity: {
      pass: updateIntegritySuitePass,
      contractProbePass: updateIntegrityContractProbePass,
      cases: integrityResults,
    },
    updateDrain: {
      pass: drainSuitePass,
      contractProbePass: drainContractProbePass,
      cases: drainResults,
    },
    updateVerification: {
      path: updateVerificationPathArg || null,
      evidence: updateVerification,
      binding: updateVerificationBinding,
    },
    identityBinding,
    formalDistribution: directChecks,
  },
  stage,
  // Legacy fields for older readers — do NOT force whole-stage blocked when internal open
  mac: {
    hardenedRuntime: contract.hardenedRuntime,
    identityConfigured: contract.identityConfigured,
    identityValueIsNull: contract.identityValueIsNull,
    gatekeeperAssess: contract.gatekeeperAssess,
    outputDir: contract.configuredOutputDir,
    entitlements: contract.entitlements,
    entitlementsInherit: contract.entitlementsInherit,
  },
  verdict: stage.status,
  reasons: [...stage.internalOpen, ...stage.externalOnly],
  canBuildUnsignedCandidate: true,
  releaseConfigPresent: notarizationConfigured,
  canAttemptFormalDistribution: notarizationConfigured,
};

mkdirSync(dirname(outPath), { recursive: true });
const body = `${JSON.stringify(report, null, 2)}\n`;
writeFileSync(outPath, body);
const sha = createHash('sha256').update(body).digest('hex');
console.log(
  JSON.stringify(
    {
      ok: true,
      outPath,
      sha256: sha,
      stageStatus: stage.status,
      internalOpen: stage.internalOpen,
      externalOnly: stage.externalOnly,
      sourceDigest: sourceDigest || null,
    },
    null,
    2,
  ),
);
