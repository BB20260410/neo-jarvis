#!/usr/bin/env node
// @ts-check
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceDigest, jcsStringify, sha256Hex } from '../src/runtime/NoeSourceDigest.js';
import {
  resolveMacAppPath,
  sha256DirectoryTree,
} from '../src/runtime/NoePackagingContract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const sourceIdentity = await computeSourceDigest({ rootDir: ROOT });
const digestArgIndex = process.argv.indexOf('--source-digest');
const expectedDigest = digestArgIndex >= 0 ? String(process.argv[digestArgIndex + 1] || '') : '';
if (expectedDigest && expectedDigest !== sourceIdentity.sourceDigest) {
  throw new Error(
    `sourceDigest changed before SBOM: expected=${expectedDigest} actual=${sourceIdentity.sourceDigest}`,
  );
}
const app = resolveMacAppPath(
  ROOT,
  process.env.NOE_PACK_ARCH || 'arm64',
  pkg.productName,
);
if (app.source === 'expected_canonical_missing' || !existsSync(app.path)) {
  throw new Error(`packaged app missing:${app.path}`);
}
const embeddedPackagePath = join(app.path, 'Contents', 'Resources', 'app', 'package.json');
const embeddedPackage = JSON.parse(readFileSync(embeddedPackagePath, 'utf8'));
const receiptPath = join(ROOT, 'out-noe', 'build-receipt.json');
if (!existsSync(receiptPath)) throw new Error(`build receipt missing:${receiptPath}`);
const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
const appTreeSha256 = sha256DirectoryTree(app.path);
if (
  receipt.sourceDigest !== sourceIdentity.sourceDigest ||
  embeddedPackage.noeSourceDigest !== sourceIdentity.sourceDigest ||
  !receipt.buildId ||
  embeddedPackage.noeBuildId !== receipt.buildId ||
  receipt.macApp?.directoryTreeSha256 !== appTreeSha256
) {
  throw new Error('SBOM packaged app/build receipt binding failed');
}
const npmCli = resolve(
  dirname(process.execPath),
  '..',
  'lib',
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
);
if (!existsSync(npmCli)) throw new Error(`Node22 npm CLI missing:${npmCli}`);

const env = {
  ...process.env,
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
};
const result = spawnSync(
  process.execPath,
  [npmCli, 'sbom', '--sbom-format=cyclonedx', '--omit=dev'],
  { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
if (result.status !== 0) {
  throw new Error(`npm sbom failed:${String(result.stderr || result.stdout || '').trim()}`);
}

let sbom;
try {
  sbom = JSON.parse(result.stdout || '{}');
} catch (error) {
  throw new Error(`npm sbom returned invalid JSON:${error instanceof Error ? error.message : String(error)}`);
}
if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components) || sbom.components.length === 0) {
  throw new Error('CycloneDX SBOM missing components');
}
// npm sbom may surface productName as the root component display name while purl keeps pkg.name.
// Accept either package name or productName when version + purl bind to the npm package identity.
{
  const root = sbom.metadata?.component || {};
  const purl = String(root.purl || '');
  const expectedPurl = `pkg:npm/${pkg.name}@${pkg.version}`;
  const nameOk = root.name === pkg.name || root.name === pkg.productName;
  const versionOk = root.version === pkg.version;
  const purlOk = purl === expectedPurl || purl.includes(expectedPurl);
  if (!nameOk || !versionOk || !purlOk) {
    throw new Error(
      `CycloneDX root component does not match package identity: name=${root.name} version=${root.version} purl=${purl}`,
    );
  }
}
// npm sbom (10.x) can under-enumerate the production tree; backfill missing direct deps
// from the installed node_modules package.json so the inventory is complete and hashable.
const componentNames = new Set(sbom.components.map((component) => component?.name).filter(Boolean));
const missingDirectDependencies = Object.keys(pkg.dependencies || {}).filter(
  (name) => !componentNames.has(name),
);
/** @type {string[]} */
const enrichedDirectDependencies = [];
for (const name of missingDirectDependencies) {
  const depPackagePath = join(ROOT, 'node_modules', ...name.split('/'), 'package.json');
  if (!existsSync(depPackagePath)) {
    throw new Error(`SBOM missing installed production dependency package.json:${name}`);
  }
  const depPkg = JSON.parse(readFileSync(depPackagePath, 'utf8'));
  const version = String(depPkg.version || '');
  if (!version) throw new Error(`SBOM production dependency has empty version:${name}`);
  const purlName = name.startsWith('@')
    ? `%40${name.slice(1).replace('/', '%2F')}`
    : name;
  sbom.components.push({
    type: 'library',
    name,
    version,
    purl: `pkg:npm/${purlName}@${version}`,
    scope: 'required',
    properties: [
      { name: 'noe:sbomEnrichment', value: 'direct_production_node_modules' },
      { name: 'cdx:npm:package:path', value: `node_modules/${name}` },
    ],
  });
  componentNames.add(name);
  enrichedDirectDependencies.push(name);
}
const stillMissing = Object.keys(pkg.dependencies || {}).filter((name) => !componentNames.has(name));
if (stillMissing.length > 0) {
  throw new Error(`SBOM missing direct production dependencies:${stillMissing.join(',')}`);
}

const packagedNodeModules = join(
  app.path,
  'Contents',
  'Resources',
  'app',
  'node_modules',
);
const packagedPackageRows = [];
const walk = (directory) => {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(path);
      continue;
    }
    if (!entry.isFile() || entry.name !== 'package.json') continue;
    const data = readFileSync(path);
    try {
      const packageJson = JSON.parse(data.toString('utf8'));
      packagedPackageRows.push({
        path: path.slice(packagedNodeModules.length + 1),
        name: packageJson.name || null,
        version: packageJson.version || null,
        sha256: createHash('sha256').update(data).digest('hex'),
      });
    } catch {
      throw new Error(`invalid packaged package.json:${path}`);
    }
  }
};
if (!existsSync(packagedNodeModules) || !statSync(packagedNodeModules).isDirectory()) {
  throw new Error('packaged node_modules missing');
}
walk(packagedNodeModules);
packagedPackageRows.sort((left, right) => left.path.localeCompare(right.path));
if (packagedPackageRows.length === 0) throw new Error('packaged dependency inventory empty');
const packagedManifestSha256 = sha256Hex(jcsStringify(packagedPackageRows));
const receiptSha256 = createHash('sha256').update(readFileSync(receiptPath)).digest('hex');
sbom.metadata = sbom.metadata || {};
sbom.metadata.properties = [
  ...(Array.isArray(sbom.metadata.properties) ? sbom.metadata.properties : []),
  { name: 'noe:sourceDigest', value: sourceIdentity.sourceDigest },
  { name: 'noe:buildId', value: receipt.buildId },
  { name: 'noe:macAppTreeSha256', value: appTreeSha256 },
  { name: 'noe:buildReceiptSha256', value: receiptSha256 },
  { name: 'noe:packagedNodeModulesManifestSha256', value: packagedManifestSha256 },
  { name: 'noe:packagedPackageCount', value: String(packagedPackageRows.length) },
  {
    name: 'noe:sbomDirectDepEnrichmentCount',
    value: String(enrichedDirectDependencies.length),
  },
  {
    name: 'noe:sbomDirectDepEnrichment',
    value: enrichedDirectDependencies.join(',') || 'none',
  },
];

const outDir = join(ROOT, 'out-noe');
const outPath = join(outDir, 'sbom.json');
mkdirSync(outDir, { recursive: true });
const body = `${JSON.stringify(sbom, null, 2)}\n`;
writeFileSync(outPath, body, { mode: 0o600 });
const sha256 = createHash('sha256').update(readFileSync(outPath)).digest('hex');
console.log(JSON.stringify({
  ok: true,
  outPath,
  format: sbom.bomFormat,
  specVersion: sbom.specVersion || null,
  componentCount: sbom.components.length,
  packagedPackageCount: packagedPackageRows.length,
  sourceDigest: sourceIdentity.sourceDigest,
  buildId: receipt.buildId,
  appTreeSha256,
  buildReceiptSha256: receiptSha256,
  packagedNodeModulesManifestSha256: packagedManifestSha256,
  sha256,
}, null, 2));
