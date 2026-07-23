#!/usr/bin/env node
// @ts-check
/**
 * Formal macOS distribution path.
 *
 * Default package/build commands remain deterministically unsigned because
 * package.json keeps build.mac.identity=null. This script is the only path that
 * explicitly overrides that value after loading an owner-provided identity and
 * notarization configuration.
 *
 * Supported ~/.noe-panel/release-config.json shapes:
 *   Preferred: { identity, notaryKeychainProfile, notaryKeychain? }
 *   API key:   { identity, notaryApiKeyPath, notaryApiKeyId, notaryApiIssuer|notaryApiIssuerFile }
 *   Legacy:    { identity, appleId, appleIdPassword, teamId, notaryTeamId? }
 *
 * No credential value is printed or written to the verification log.
 */

import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceDigest } from '../src/runtime/NoeSourceDigest.js';
import { sha256DirectoryTree } from '../src/runtime/NoePackagingContract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = join(homedir(), '.noe-panel', 'release-config.json');
const ELECTRON_BUILDER_CLI = join(ROOT, 'node_modules', 'electron-builder', 'cli.js');
const ELECTRON_REBUILD_CLI = join(ROOT, 'node_modules', '@electron', 'rebuild', 'lib', 'cli.js');
const NPM_CLI = resolve(
  dirname(process.execPath),
  '..',
  'lib',
  'node_modules',
  'npm',
  'bin',
  'npm-cli.js',
);
const NODE22_PATH_ENV = {
  ...process.env,
  PATH: [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter),
};
const NODE_RESTORE_ENV = {
  ...NODE22_PATH_ENV,
  npm_config_runtime: 'node',
  npm_config_target: process.versions.node,
  npm_config_arch: process.arch,
};

function fail(message) {
  throw new Error(message);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    fail(
      `未找到 ${CONFIG_PATH}\n` +
        '请配置 identity，并选择 notaryKeychainProfile（推荐）或 appleId/appleIdPassword/teamId。',
    );
  }
  const mode = statSync(CONFIG_PATH).mode & 0o777;
  if (mode !== 0o600 && mode !== 0o400) {
    fail(`${CONFIG_PATH} 权限必须是 600 或 400，当前为 ${mode.toString(8)}`);
  }

  let cfg;
  try {
    cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  } catch (error) {
    fail(`release config JSON 解析失败:${error instanceof Error ? error.message : String(error)}`);
  }
  if (!nonEmptyString(cfg?.identity)) fail('release config 缺少 identity');

  const hasKeychainProfile = nonEmptyString(cfg?.notaryKeychainProfile);
  let notaryApiIssuer = nonEmptyString(cfg?.notaryApiIssuer) ? String(cfg.notaryApiIssuer).trim() : '';
  if (!notaryApiIssuer && nonEmptyString(cfg?.notaryApiIssuerFile)) {
    const issuerPath = String(cfg.notaryApiIssuerFile).trim();
    if (!existsSync(issuerPath)) fail(`notaryApiIssuerFile 不存在`);
    notaryApiIssuer = readFileSync(issuerPath, 'utf8').trim();
  }
  const hasApiKeyCredentials =
    nonEmptyString(cfg?.notaryApiKeyPath) &&
    nonEmptyString(cfg?.notaryApiKeyId) &&
    nonEmptyString(notaryApiIssuer);
  if (hasApiKeyCredentials && !existsSync(String(cfg.notaryApiKeyPath).trim())) {
    fail('notaryApiKeyPath 指向的 API key 文件不存在');
  }
  const hasLegacyAppleCredentials =
    nonEmptyString(cfg?.appleId) &&
    nonEmptyString(cfg?.appleIdPassword) &&
    nonEmptyString(cfg?.teamId);
  if (!hasKeychainProfile && !hasApiKeyCredentials && !hasLegacyAppleCredentials) {
    fail(
      'release config 缺少公证配置：需要 notaryKeychainProfile，或 notaryApiKeyPath/notaryApiKeyId/notaryApiIssuer，或 appleId/appleIdPassword/teamId',
    );
  }
  return {
    ...cfg,
    notaryApiIssuer,
    hasKeychainProfile,
    hasApiKeyCredentials,
    hasLegacyAppleCredentials,
  };
}

function redactedArgs(args) {
  return args.map((arg) =>
    arg.startsWith('--config.mac.identity=') ? '--config.mac.identity=<redacted>' : arg,
  );
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n▶ ${label}: ${cmd} ${redactedArgs(args).join(' ')}`);
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (result.status !== 0) fail(`${label} 失败，退出码 ${result.status ?? 'unknown'}`);
  return result;
}

function runCapture(label, cmd, args, opts = {}) {
  console.log(`\n▶ ${label}: ${cmd} ${redactedArgs(args).join(' ')}`);
  const result = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', ...opts });
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  return result;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function discoverArtifacts(outputDir, extension, prefixes, builtAfterMs) {
  if (!existsSync(outputDir)) return [];
  return readdirSync(outputDir)
    .filter((name) => name.endsWith(extension) && prefixes.some((prefix) => name.startsWith(prefix)))
    .map((name) => join(outputDir, name))
    .filter((path) => statSync(path).isFile() && statSync(path).mtimeMs >= builtAfterMs - 1000)
    .sort();
}

const cfg = loadConfig();
for (const requiredPath of [ELECTRON_BUILDER_CLI, ELECTRON_REBUILD_CLI, NPM_CLI]) {
  if (!existsSync(requiredPath)) fail(`Node22 正式打包工具缺失:${requiredPath}`);
}
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const buildIdentity = await computeSourceDigest({ rootDir: ROOT });
const buildSourceDigest = buildIdentity.sourceDigest;
const buildId = randomUUID();
const productName = pkg.productName || pkg.build?.productName || 'Neo 贾维斯';
const outputName = pkg.build?.directories?.output || 'out-noe';
const outputDir = join(ROOT, outputName);
const arch = process.env.NOE_PACK_ARCH || 'arm64';
if (!['arm64', 'x64'].includes(arch)) fail(`不支持的 NOE_PACK_ARCH:${arch}`);
const archFlag = `--${arch}`;
const electronVersion = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;
const projectNative = join(
  ROOT,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);
const restoreNativeDependencies = [
  'better-sqlite3',
  '@homebridge/node-pty-prebuilt-multiarch',
];
if (existsSync(join(ROOT, 'node_modules', 'node-pty'))) restoreNativeDependencies.push('node-pty');
const appPath = join(outputDir, `mac-${arch}`, `${productName}.app`);
const appNative = join(
  appPath,
  'Contents',
  'Resources',
  'app',
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);
const appExecutable = join(appPath, 'Contents', 'MacOS', productName);
const artifactPrefixes = [...new Set([productName, 'Neo 贾维斯', 'Noe'])];

/** @type {NodeJS.ProcessEnv} */
const env = { ...NODE22_PATH_ENV, CSC_NAME: cfg.identity };
if (cfg.hasKeychainProfile) {
  env.APPLE_KEYCHAIN_PROFILE = cfg.notaryKeychainProfile;
  if (nonEmptyString(cfg.notaryKeychain)) env.APPLE_KEYCHAIN = cfg.notaryKeychain;
  console.log('✓ 已装载签名身份与公证 keychain profile（值不打印）');
} else if (cfg.hasApiKeyCredentials) {
  // electron-builder / @electron/notarize env contract — values never logged
  env.APPLE_API_KEY = String(cfg.notaryApiKeyPath).trim();
  env.APPLE_API_KEY_ID = String(cfg.notaryApiKeyId).trim();
  env.APPLE_API_ISSUER = String(cfg.notaryApiIssuer).trim();
  console.log('✓ 已装载签名身份与 App Store Connect API key 公证环境（路径/值不打印）');
} else {
  env.APPLE_ID = cfg.appleId;
  env.APPLE_APP_SPECIFIC_PASSWORD = cfg.appleIdPassword;
  env.APPLE_TEAM_ID = cfg.notaryTeamId || cfg.teamId;
  console.log('✓ 已装载签名身份与 Apple 公证环境（值不打印）');
}

const builtAfterMs = Date.now();
let primaryError = null;
let preparedNativeSha256 = null;
try {
  // Prepare the Electron ABI before the normal electron-builder pack/sign/notary
  // lifecycle. Unlike --prepackaged, this path reaches MacPackager.sign().
  run('准备 Electron ABI', process.execPath, [
    ELECTRON_REBUILD_CLI,
    '--version',
    electronVersion,
    '--only',
    'better-sqlite3',
    '--force',
    '--arch',
    arch,
  ], { env: NODE22_PATH_ENV });
  if (!existsSync(projectNative)) fail(`Electron ABI native module 未生成:${projectNative}`);
  preparedNativeSha256 = sha256File(projectNative);

  run(
    'electron-builder 正式签名/公证并生成 DMG+ZIP',
    process.execPath,
    [
      ELECTRON_BUILDER_CLI,
      '--mac',
      'dmg',
      'zip',
      archFlag,
      '--config.npmRebuild=false',
      `--config.mac.identity=${cfg.identity}`,
      '--config.mac.notarize=true',
      `--config.extraMetadata.noeSourceDigest=${buildSourceDigest}`,
      `--config.extraMetadata.noeBuildId=${buildId}`,
    ],
    { env },
  );

  if (!existsSync(appPath)) fail(`未找到正式 .app:${appPath}`);
  if (!existsSync(appNative)) fail(`正式 .app 缺少 better_sqlite3.node:${appNative}`);
  if (!existsSync(appExecutable)) fail(`正式 .app 缺少 executable:${appExecutable}`);
  const embeddedPackage = JSON.parse(
    readFileSync(join(appPath, 'Contents', 'Resources', 'app', 'package.json'), 'utf8'),
  );
  if (
    embeddedPackage.noeSourceDigest !== buildSourceDigest ||
    embeddedPackage.noeBuildId !== buildId
  ) {
    fail('正式 .app 的 sourceDigest/buildId 未与本次构建绑定');
  }
  const packageDir = join(appPath, 'Contents', 'Resources', 'app', 'node_modules', 'better-sqlite3');
  const probeCode = "const DB=require(process.argv[1]);const db=new DB(':memory:');const row=db.prepare('select 1 ok').get();db.close();if(row.ok!==1)process.exit(2)";
  const nativeProbe = spawnSync(appExecutable, ['-e', probeCode, packageDir], {
    cwd: join(appPath, 'Contents', 'Resources', 'app'),
    encoding: 'utf8',
    env: { ...NODE22_PATH_ENV, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (nativeProbe.status !== 0) {
    fail(`正式 .app Electron ABI probe 失败:${String(nativeProbe.stderr || nativeProbe.stdout || '').trim()}`);
  }
} catch (error) {
  primaryError = error;
} finally {
  try {
    run(
      '恢复项目 Node ABI',
      process.execPath,
      [NPM_CLI, 'rebuild', ...restoreNativeDependencies],
      { env: NODE_RESTORE_ENV },
    );
  } catch (restoreError) {
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
    if (primaryError) {
      primaryError = new Error(
        `${primaryMessage}; 同时恢复 Node ABI 失败:${restoreMessage}`,
      );
    } else {
      primaryError = restoreError;
    }
  }
}
if (primaryError) throw primaryError;

const dmgs = discoverArtifacts(outputDir, '.dmg', artifactPrefixes, builtAfterMs);
const zips = discoverArtifacts(outputDir, '.zip', artifactPrefixes, builtAfterMs);
if (dmgs.length === 0) fail(`未找到 ${productName} 的新 DMG:${outputDir}`);
if (zips.length === 0) fail(`未找到 ${productName} 的新 ZIP:${outputDir}`);
const buildIdentityAfter = await computeSourceDigest({ rootDir: ROOT });
if (buildIdentityAfter.sourceDigest !== buildSourceDigest) {
  fail(
    `源码在正式构建期间发生变化: before=${buildSourceDigest} after=${buildIdentityAfter.sourceDigest}`,
  );
}

const logLines = [
  '# Sign + notarize verification',
  `Time: ${new Date().toISOString()}`,
  `Product: ${productName}`,
  `Arch: ${arch}`,
  `App: ${appPath}`,
  `Prepared native SHA-256: ${preparedNativeSha256}`,
  `Signed app native SHA-256: ${sha256File(appNative)}`,
  ...dmgs.map((path) => `DMG: ${path} sha256=${sha256File(path)}`),
  ...zips.map((path) => `ZIP: ${path} sha256=${sha256File(path)}`),
  '',
];

const checks = [
  {
    label: 'codesign strict verify',
    cmd: '/usr/bin/codesign',
    args: ['--verify', '--deep', '--strict', '--verbose=2', appPath],
  },
  {
    label: 'Gatekeeper execute assessment',
    cmd: '/usr/sbin/spctl',
    args: ['-a', '-vv', '--type', 'execute', appPath],
  },
  {
    label: 'stapler app ticket validation',
    cmd: '/usr/bin/xcrun',
    args: ['stapler', 'validate', appPath],
  },
  ...dmgs.flatMap((dmgPath) => [
    {
      label: `Gatekeeper install assessment (${dmgPath.split('/').pop()})`,
      cmd: '/usr/sbin/spctl',
      args: ['-a', '-vv', '--type', 'install', dmgPath],
    },
    {
      label: `stapler DMG ticket validation (${dmgPath.split('/').pop()})`,
      cmd: '/usr/bin/xcrun',
      args: ['stapler', 'validate', dmgPath],
    },
  ]),
];

let validationFailed = false;
for (const check of checks) {
  const result = runCapture(check.label, check.cmd, check.args);
  logLines.push(
    `## ${check.label}`,
    `exit=${result.status ?? 'unknown'}`,
    result.stdout || '',
    result.stderr || '',
    '',
  );
  if (result.status !== 0) validationFailed = true;
}

const logPath = join(outputDir, 'sign-verify.log');
writeFileSync(logPath, `${logLines.join('\n')}\n`);
console.log(`\n📝 验证日志:${logPath}`);
if (validationFailed) fail('正式签名/公证验证失败，产物不得分发');

const signatureDetails = runCapture(
  'Developer ID authority/runtime verification',
  '/usr/bin/codesign',
  ['-dv', '--verbose=4', appPath],
);
const signatureText = `${signatureDetails.stdout || ''}\n${signatureDetails.stderr || ''}`;
if (
  signatureDetails.status !== 0 ||
  !/Authority=Developer ID Application:/.test(signatureText) ||
  !/TeamIdentifier=(?!not set)\S+/.test(signatureText) ||
  !/flags=.*runtime/.test(signatureText)
) {
  fail('正式签名缺少 Developer ID Application authority、TeamIdentifier 或 hardened runtime');
}
const entitlements = runCapture(
  'signed entitlements verification',
  '/usr/bin/codesign',
  ['-d', '--entitlements', ':-', appPath],
);
const entitlementsText = `${entitlements.stdout || ''}\n${entitlements.stderr || ''}`;
if (entitlements.status !== 0 || !entitlementsText.includes('com.apple.security')) {
  fail('正式签名 entitlements 未能从产物读取');
}

const buildReceipt = {
  schemaVersion: 1,
  builtAt: new Date().toISOString(),
  sourceDigest: buildSourceDigest,
  buildId,
  runtimeConfigDigest: buildIdentity.runtimeConfigDigest,
  baseCommit: buildIdentity.baseCommit,
  productName,
  packageVersion: pkg.version,
  electronVersion,
  arch,
  localSignature: 'developer_id_notarized',
  embeddedSourceDigestVerified: true,
  embeddedBuildIdVerified: true,
  commandDigest: `sha256:${sha256File(fileURLToPath(import.meta.url))}`,
  macApp: {
    relativePath: appPath.slice(ROOT.length + 1),
    directoryTreeSha256: sha256DirectoryTree(appPath),
  },
  artifacts: {
    dmg: dmgs.map((path) => ({ fileName: path.split('/').pop(), sha256: sha256File(path) })),
    zip: zips.map((path) => ({ fileName: path.split('/').pop(), sha256: sha256File(path) })),
  },
};
writeFileSync(
  join(outputDir, 'build-receipt.json'),
  `${JSON.stringify(buildReceipt, null, 2)}\n`,
);

console.log('\n✅ 已验证 Developer ID 签名、公证/staple 的 Neo 贾维斯 App，并封装为 DMG 与 ZIP');
console.log('   未执行上传、发布或部署。');
