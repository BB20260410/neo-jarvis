#!/usr/bin/env node
// release-build.mjs — 可靠的桌面打包流水线
//
// 解决 electron-builder 已知坑:`npm run package` 跑完后,@electron/rebuild 偶发 silent
// 失败(显示「preparing→finished」但实际未对 better-sqlite3 重编为 Electron ABI),
// 致 .app 内 better-sqlite3.node 仍是 Node ABI 127,运行时报 NODE_MODULE_VERSION mismatch。
//
// 流程:
//   1) 强制 @electron/rebuild Electron       项目 node_modules/bsq3.node → Electron ABI
//   2) electron-builder npmRebuild=false     把已验证 ABI 原样打进 .app
//   3) 可选 --artifacts                      从已验证 .app 生成 unsigned DMG+ZIP
//   4) npm rebuild native deps              项目 node_modules 恢复 Node 22 ABI
//   5) 分别用真实运行时验证 .app 的 Electron ABI 与项目的 Node ABI
//
// 用法:`npm run build:app`(替代直接 `npm run package`)

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSourceDigest } from '../src/runtime/NoeSourceDigest.js';
import { sha256DirectoryTree } from '../src/runtime/NoePackagingContract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON_VERSION = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
).version;
const ARCH = process.env.NOE_PACK_ARCH || 'arm64';
const BUILD_ARTIFACTS = process.argv.includes('--artifacts');
const BUILD_IDENTITY = await computeSourceDigest({ rootDir: ROOT });
const BUILD_SOURCE_DIGEST = BUILD_IDENTITY.sourceDigest;
const BUILD_ID = randomUUID();
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
// Display brand from package.json (external Neo 贾维斯; legacy Noe.app retained as candidate)
const pkgJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const PRODUCT_NAME = pkgJson.productName || pkgJson.build?.productName || 'Neo 贾维斯';
const LOCAL_ADHOC_IDENTITY = '-';
if (pkgJson.build?.mac?.identity !== null) {
  throw new Error('本地 RC 必须保持 build.mac.identity=null；正式签名只能走 npm run dist:signed');
}
const UNSIGNED_BUILD_ENV = {
  ...NODE22_PATH_ENV,
  CSC_IDENTITY_AUTO_DISCOVERY: 'false',
};
const APP_NAMES = [...new Set([`${PRODUCT_NAME}.app`, 'Neo 贾维斯.app', 'Noe.app'])];
// Canonical output is out-noe (package.json build.directories.output); legacy out/ still probed.
const OUT_DIR = process.env.NOE_PACK_OUT || 'out-noe';
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
for (const requiredPath of [ELECTRON_BUILDER_CLI, ELECTRON_REBUILD_CLI, NPM_CLI]) {
  if (!existsSync(requiredPath)) throw new Error(`Node22 打包工具缺失:${requiredPath}`);
}
const PROJ_NODE = join(ROOT, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
const RESTORE_NATIVE_DEPENDENCIES = [
  'better-sqlite3',
  '@homebridge/node-pty-prebuilt-multiarch',
];
if (existsSync(join(ROOT, 'node_modules', 'node-pty'))) {
  RESTORE_NATIVE_DEPENDENCIES.push('node-pty');
}
const APP_NODE_CANDIDATES = APP_NAMES.flatMap((APP_NAME) => [
  join(ROOT, OUT_DIR, `mac-${ARCH}`, APP_NAME, 'Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
  join(ROOT, 'out', `mac-${ARCH}`, APP_NAME, 'Contents/Resources/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'),
]);
function resolveAppNode() {
  for (const p of APP_NODE_CANDIDATES) {
    if (existsSync(p)) return p;
  }
  return APP_NODE_CANDIDATES[0];
}
function resolveAppBundle() {
  for (const name of APP_NAMES) {
    for (const base of [OUT_DIR, 'out']) {
      const p = join(ROOT, base, `mac-${ARCH}`, name);
      if (existsSync(p)) return p;
    }
  }
  return join(ROOT, OUT_DIR, `mac-${ARCH}`, APP_NAMES[0]);
}

function run(label, cmd, args, opts = {}) {
  console.log(`\n▶ ${label}: ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${label} 失败,退出码 ${r.status}`);
}
function hash(p) { return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16) : '(无文件)'; }
function fullHash(p) { return existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null; }
function probePackagedNative(appBundle) {
  const executable = join(appBundle, 'Contents', 'MacOS', PRODUCT_NAME);
  const packageDir = join(appBundle, 'Contents', 'Resources', 'app', 'node_modules', 'better-sqlite3');
  if (!existsSync(executable) || !existsSync(packageDir)) {
    throw new Error(`packaged runtime probe 缺少 executable/native package: ${executable}`);
  }
  const code = "const DB=require(process.argv[1]);const db=new DB(':memory:');const row=db.prepare('select 1 ok').get();db.close();if(row.ok!==1)process.exit(2)";
  const result = spawnSync(executable, ['-e', code, packageDir], {
    cwd: join(appBundle, 'Contents', 'Resources', 'app'),
    encoding: 'utf8',
    env: { ...NODE22_PATH_ENV, ELECTRON_RUN_AS_NODE: '1' },
  });
  if (result.status !== 0) {
    throw new Error(`packaged Electron ABI probe 失败:${String(result.stderr || result.stdout || '').trim()}`);
  }
}
function resolveArtifacts(extension, builtAfterMs) {
  const dir = join(ROOT, OUT_DIR);
  if (!existsSync(dir)) return [];
  const prefixes = [...new Set([PRODUCT_NAME, 'Neo 贾维斯', 'Noe'])];
  return readdirSync(dir)
    .filter((name) => name.endsWith(extension) && prefixes.some((prefix) => name.startsWith(prefix)))
    .map((name) => join(dir, name))
    .filter((path) => statSync(path).isFile() && statSync(path).mtimeMs >= builtAfterMs - 1000)
    .sort();
}

console.log(`=== Neo 贾维斯 桌面打包流水线 (Electron ${ELECTRON_VERSION}, ${ARCH}, product=${PRODUCT_NAME}) ===`);
console.log(`   sourceDigest: ${BUILD_SOURCE_DIGEST}`);

// Electron ABI 准备 → 主打包 → 可选 artifacts → 恢复 Node ABI
let APP_BUNDLE = resolveAppBundle();
let APP_NODE = resolveAppNode();
let electronHash = '(无文件)';
let primaryError = null;
let artifactStartedAt = 0;
let builtDmgs = [];
let builtZips = [];
try {
  run('1. force @electron/rebuild for Electron', process.execPath, [
    ELECTRON_REBUILD_CLI,
    '--version', ELECTRON_VERSION,
    '--only', 'better-sqlite3',
    '--force',
    '--arch', ARCH,
  ], { env: NODE22_PATH_ENV });
  electronHash = hash(PROJ_NODE);
  console.log(`   项目 bsq3.node 哈希(Electron ABI): ${electronHash}`);

  run(
    '2. electron-builder --mac --dir (unsigned RC, preserve prepared ABI)',
    process.execPath,
    [
      ELECTRON_BUILDER_CLI,
      '--mac', '--dir', `--${ARCH}`,
      '--config.npmRebuild=false',
      `--config.mac.identity=${LOCAL_ADHOC_IDENTITY}`,
      `--config.extraMetadata.noeSourceDigest=${BUILD_SOURCE_DIGEST}`,
      `--config.extraMetadata.noeBuildId=${BUILD_ID}`,
    ],
    { env: UNSIGNED_BUILD_ENV },
  );
  APP_BUNDLE = resolveAppBundle();
  APP_NODE = resolveAppNode();
  if (!existsSync(APP_NODE)) throw new Error(`.app 未产出预期 .node 路径: ${APP_NODE} (candidates=${APP_NODE_CANDIDATES.join(' | ')})`);
  console.log(`   .app bundle: ${APP_BUNDLE}`);
  console.log(`   .app 内 bsq3.node 路径: ${APP_NODE}`);
  console.log(`   .app 内 bsq3.node 哈希(签名后): ${hash(APP_NODE)}`);
  const embeddedPackagePath = join(APP_BUNDLE, 'Contents', 'Resources', 'app', 'package.json');
  const embeddedPackage = JSON.parse(readFileSync(embeddedPackagePath, 'utf8'));
  if (embeddedPackage.noeSourceDigest !== BUILD_SOURCE_DIGEST) {
    throw new Error(
      `packaged sourceDigest mismatch: expected=${BUILD_SOURCE_DIGEST} actual=${embeddedPackage.noeSourceDigest || 'missing'}`,
    );
  }
  if (embeddedPackage.noeBuildId !== BUILD_ID) {
    throw new Error(`packaged buildId mismatch: expected=${BUILD_ID}`);
  }
  probePackagedNative(APP_BUNDLE);
  run('   ad-hoc codesign strict verify', '/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=2', APP_BUNDLE,
  ]);

  if (BUILD_ARTIFACTS) {
    artifactStartedAt = Date.now();
    run(
      '3. 从已验证 .app 生成 unsigned DMG+ZIP',
      process.execPath,
      [
        ELECTRON_BUILDER_CLI,
        '--mac', 'dmg', 'zip',
        `--${ARCH}`,
        '--prepackaged', APP_BUNDLE,
        `--config.mac.identity=${LOCAL_ADHOC_IDENTITY}`,
      ],
      { env: UNSIGNED_BUILD_ENV },
    );
  }
} catch (error) {
  primaryError = error;
} finally {
  try {
    run(`${BUILD_ARTIFACTS ? '4' : '3'}. npm rebuild native deps (Node ABI)`, process.execPath, [
      NPM_CLI,
      'rebuild',
      ...RESTORE_NATIVE_DEPENDENCIES,
    ], { env: NODE_RESTORE_ENV });
  } catch (restoreError) {
    const primaryMessage = primaryError instanceof Error ? primaryError.message : String(primaryError);
    const restoreMessage = restoreError instanceof Error ? restoreError.message : String(restoreError);
    if (primaryError) {
      primaryError = new Error(`${primaryMessage}; 同时恢复 Node ABI 失败:${restoreMessage}`);
    } else {
      primaryError = restoreError;
    }
  }
}
if (primaryError) throw primaryError;
const nodeHash = hash(PROJ_NODE);
console.log(`   项目 bsq3.node 哈希(Node ABI): ${nodeHash}`);

// 5) 验证项目已恢复为 Node ABI。.app 在上方已由实际 packaged Electron
// 加载 better-sqlite3 并执行 SQL；codesign 可能改写 Mach-O 字节，因此不能
// 再用签名前后的文件哈希相等来冒充 ABI 证明。
const appHash = hash(APP_NODE);
run('5. root Node22 ABI probe', process.execPath, [
  '-e',
  "const DB=require('better-sqlite3');const db=new DB(':memory:');const row=db.prepare('select 1 ok').get();db.close();if(row.ok!==1)process.exit(2)",
], { env: NODE_RESTORE_ENV });
let artifactLines = [];
if (BUILD_ARTIFACTS) {
  builtDmgs = resolveArtifacts('.dmg', artifactStartedAt);
  builtZips = resolveArtifacts('.zip', artifactStartedAt);
  if (builtDmgs.length === 0 || builtZips.length === 0) {
    throw new Error(`unsigned artifacts 不完整: dmg=${builtDmgs.length} zip=${builtZips.length}`);
  }
  artifactLines = [...builtDmgs, ...builtZips].map((path) => `   - artifact: ${path} sha256=${hash(path)}`);
}
const BUILD_IDENTITY_END = await computeSourceDigest({ rootDir: ROOT });
if (BUILD_IDENTITY_END.sourceDigest !== BUILD_SOURCE_DIGEST) {
  throw new Error(
    `source changed during build: before=${BUILD_SOURCE_DIGEST} after=${BUILD_IDENTITY_END.sourceDigest}`,
  );
}
const buildReceipt = {
  schemaVersion: 1,
  builtAt: new Date().toISOString(),
  sourceDigest: BUILD_SOURCE_DIGEST,
  buildId: BUILD_ID,
  runtimeConfigDigest: BUILD_IDENTITY.runtimeConfigDigest,
  baseCommit: BUILD_IDENTITY.baseCommit,
  productName: PRODUCT_NAME,
  packageVersion: pkgJson.version,
  electronVersion: ELECTRON_VERSION,
  arch: ARCH,
  localSignature: 'adhoc',
  embeddedSourceDigestVerified: true,
  embeddedBuildIdVerified: true,
  commandDigest: `sha256:${fullHash(join(ROOT, 'scripts', 'release-build.mjs'))}`,
  macApp: {
    relativePath: APP_BUNDLE.slice(ROOT.length + 1),
    directoryTreeSha256: sha256DirectoryTree(APP_BUNDLE),
  },
  artifacts: {
    dmg: builtDmgs.map((path) => ({ fileName: path.split('/').pop(), sha256: fullHash(path) })),
    zip: builtZips.map((path) => ({ fileName: path.split('/').pop(), sha256: fullHash(path) })),
  },
};
const buildReceiptPath = join(ROOT, OUT_DIR, 'build-receipt.json');
writeFileSync(buildReceiptPath, `${JSON.stringify(buildReceipt, null, 2)}\n`);
console.log(`\n✅ 打包完成且 ABI 分离正确:`);
console.log(`   - productName: ${PRODUCT_NAME}`);
console.log(`   - app bundle: ${APP_BUNDLE}`);
console.log(`   - output dir contract: ${OUT_DIR} (canonical out-noe)`);
console.log(`   - .app(运行时,Electron ABI): ${appHash}`);
console.log(`   - prepared Electron ABI hash (pre-sign): ${electronHash}`);
console.log(`   - packaged Electron ABI probe: pass`);
console.log(`   - local signature: ad-hoc (not Developer ID / not notarized)`);
console.log(`   - 项目 node_modules(测试,Node ABI): ${nodeHash}`);
console.log(`   - root Node22 ABI probe: pass`);
console.log(`   - build receipt: ${buildReceiptPath}`);
for (const line of artifactLines) console.log(line);
console.log(`   后续 npm test 可跑(Node ABI);.app 可运行(Electron ABI)。`);
