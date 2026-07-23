#!/usr/bin/env node
// @ts-check
/**
 * Stamp RC packaging manifest next to out-noe app with version/commit/sourceDigest/hashes.
 *   node scripts/noe-stamp-rc-manifest.mjs
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveMacAppPath, fileMeta, CANONICAL_OUTPUT_DIR } from '../src/runtime/NoePackagingContract.js';
import { computeSourceDigest } from '../src/runtime/NoeSourceDigest.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const arch = process.env.NOE_PACK_ARCH || 'arm64';
const dig = await computeSourceDigest({ rootDir: ROOT });
const sourceDigestArgIndex = process.argv.indexOf('--source-digest');
const expectedSourceDigest =
  sourceDigestArgIndex >= 0 ? String(process.argv[sourceDigestArgIndex + 1] || '').trim() : '';
if (expectedSourceDigest && expectedSourceDigest !== dig.sourceDigest) {
  throw new Error(
    `sourceDigest changed before RC stamp: expected=${expectedSourceDigest} actual=${dig.sourceDigest}`,
  );
}
const commit = (() => {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? (r.stdout || '').trim() : '';
})();
const productName = pkg.productName || pkg?.build?.productName || 'Neo 贾维斯';
const macApp = resolveMacAppPath(ROOT, arch, productName);
const appMeta = macApp.source !== 'expected_canonical_missing' ? fileMeta(macApp.path) : null;
const appVersion = (() => {
  if (!appMeta) return null;
  const plist = join(macApp.path, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return null;
  const result = spawnSync(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist],
    { encoding: 'utf8' },
  );
  return result.status === 0 ? String(result.stdout || '').trim() || null : null;
})();
if (!appMeta) throw new Error(`RC app missing:${macApp.path}`);
if (appVersion !== pkg.version) {
  throw new Error(`RC app version mismatch: package=${pkg.version} app=${appVersion || 'missing'}`);
}
const embeddedPackagePath = join(macApp.path, 'Contents', 'Resources', 'app', 'package.json');
const embeddedPackage = existsSync(embeddedPackagePath)
  ? JSON.parse(readFileSync(embeddedPackagePath, 'utf8'))
  : null;
const buildReceiptPath = join(ROOT, CANONICAL_OUTPUT_DIR, 'build-receipt.json');
const buildReceipt = existsSync(buildReceiptPath)
  ? JSON.parse(readFileSync(buildReceiptPath, 'utf8'))
  : null;
if (!buildReceipt) throw new Error(`build receipt missing:${buildReceiptPath}`);
if (buildReceipt.sourceDigest !== dig.sourceDigest) {
  throw new Error('build receipt sourceDigest does not match current source');
}
if (embeddedPackage?.noeSourceDigest !== dig.sourceDigest) {
  throw new Error('packaged sourceDigest does not match current source');
}
if (!buildReceipt.buildId || embeddedPackage?.noeBuildId !== buildReceipt.buildId) {
  throw new Error('packaged buildId does not match build receipt');
}
if (buildReceipt.macApp?.relativePath !== relative(ROOT, macApp.path)) {
  throw new Error('build receipt app path mismatch');
}
if (buildReceipt.macApp?.directoryTreeSha256 !== appMeta.sha256) {
  throw new Error('build receipt app hash mismatch');
}
const validateArtifactEntries = (kind) => {
  const entries = buildReceipt.artifacts?.[kind];
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error(`build receipt ${kind} artifacts missing`);
  }
  return entries.map((entry) => {
    if (!entry?.fileName || basename(entry.fileName) !== entry.fileName) {
      throw new Error(`invalid build receipt ${kind} fileName`);
    }
    const meta = fileMeta(join(ROOT, CANONICAL_OUTPUT_DIR, entry.fileName));
    if (!meta || meta.sha256 !== entry.sha256) {
      throw new Error(`build receipt ${kind} artifact hash mismatch:${entry.fileName}`);
    }
    return meta;
  });
};
const macArtifacts = {
  dmg: validateArtifactEntries('dmg'),
  zip: validateArtifactEntries('zip'),
};
const sbomPath = join(ROOT, CANONICAL_OUTPUT_DIR, 'sbom.json');
const sbomMeta = existsSync(sbomPath) ? fileMeta(sbomPath) : null;

const manifest = {
  schemaVersion: 1,
  stampedAt: new Date().toISOString(),
  productName,
  packageVersion: pkg.version,
  appVersion,
  commit,
  sourceDigest: dig.sourceDigest,
  runtimeConfigDigest: dig.runtimeConfigDigest || null,
  baseCommit: dig.baseCommit || null,
  arch,
  macApp: appMeta,
  embeddedSourceDigest: embeddedPackage.noeSourceDigest,
  buildId: buildReceipt.buildId,
  buildReceipt: fileMeta(buildReceiptPath),
  macArtifacts,
  sbom: sbomMeta,
  hardenedRuntime: pkg?.build?.mac?.hardenedRuntime === true,
  entitlements: pkg?.build?.mac?.entitlements || null,
  outputDir: CANONICAL_OUTPUT_DIR,
  note: 'RC identity binding for S8; formal signing/notarization may still be owner-gated',
};

const outDir = join(ROOT, CANONICAL_OUTPUT_DIR);
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, 'rc-manifest.json');
const body = `${JSON.stringify(manifest, null, 2)}\n`;
writeFileSync(outPath, body);
const sha = createHash('sha256').update(body).digest('hex');
console.log(JSON.stringify({ ok: true, outPath, sha256: sha, sourceDigest: manifest.sourceDigest, appPresent: !!appMeta }, null, 2));
