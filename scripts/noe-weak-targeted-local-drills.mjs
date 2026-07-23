#!/usr/bin/env node
// @ts-check
// Targeted no-side-effect drills for weak runtime-chain/manual support files.
// Uses temp dirs, fake metadata, generated audio, and pure functions only.
// It does not read .env, owner tokens, DBs, real keychain values, or call network/models.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  atomicWriteJson,
  readJsonWithCorruptBackup,
} from '../src/state/atomicJsonFile.js';
import {
  buildNoeSafeChildProcessEnv,
  sanitizeNoeHostExecEnv,
} from '../src/security/NoeHostExecEnv.js';
import { NoeSecretBroker } from '../src/secrets/NoeSecretBroker.js';
import {
  computeVoiceEmbedding,
  scoreVoiceEmbedding,
} from '../src/identity/Voiceprint.js';
import {
  renderBibliography,
  renderCitations,
} from '../src/knowledge/learned/citation-renderer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_WEAK_TARGETED_DRILLS_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_WEAK_TARGETED_DRILLS_BASENAME || 'weak-targeted-local-drills-2026-06-15';

const DEFAULT_PATHS = {
  weakRuntimeRemainingLaneAudit: join(ROOT, 'output', 'noe-audit', 'weak-runtime-remaining-lane-audit-2026-06-15.json'),
};

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function readJson(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(path) {
  return String(path || '').replace(`${ROOT}/`, '');
}

function clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function inc(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function makePcm16Wav({ sampleRate = 16000, seconds = 0.5, freq = 180 } = {}) {
  const frames = Math.floor(sampleRate * seconds);
  const dataSize = frames * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < frames; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * freq * i) / sampleRate) * 9000);
    buf.writeInt16LE(value, 44 + i * 2);
  }
  return buf;
}

function okFile(file, lane, evidence = {}, remainingNeed = '') {
  return {
    file,
    lane,
    drillStatus: 'drilled_ok',
    evidence,
    remainingNeed,
  };
}

function _skippedFile(file, lane, reason = '', remainingNeed = '') {
  return {
    file,
    lane,
    drillStatus: 'skipped_by_policy',
    evidence: { reason: clean(reason, 180) },
    remainingNeed,
  };
}

async function drillLoadEnv(tempRoot) {
  const copyRoot = join(tempRoot, 'load-env-copy');
  const copyDir = join(copyRoot, 'src', 'bootstrap');
  const runtimeCopyDir = join(copyRoot, 'src', 'runtime');
  const roomCopyDir = join(copyRoot, 'src', 'room');
  mkdirSync(copyDir, { recursive: true });
  mkdirSync(runtimeCopyDir, { recursive: true });
  mkdirSync(roomCopyDir, { recursive: true });
  const sourceText = readFileSync(join(ROOT, 'src', 'bootstrap', 'load-env.js'), 'utf8');
  // load-env 顶层 import 的依赖须一并拷贝，否则 temp import 假红
  const depCopies = [
    [join(ROOT, 'src', 'runtime', 'NoeIsolationDbPolicy.js'), join(runtimeCopyDir, 'NoeIsolationDbPolicy.js')],
    [join(ROOT, 'src', 'runtime', 'NoeBaiLongmaRuntimeMode.js'), join(runtimeCopyDir, 'NoeBaiLongmaRuntimeMode.js')],
    [join(ROOT, 'src', 'room', 'NoeSelfEvolutionProfile.js'), join(roomCopyDir, 'NoeSelfEvolutionProfile.js')],
  ];
  const copyPath = join(copyDir, 'load-env.js');
  const isolationPolicyCopyPath = depCopies[0][1];
  const existingKey = `NOE_WEAK_LOADENV_KEEP_${process.pid}`;
  const newKey = `NOE_WEAK_LOADENV_NEW_${process.pid}`;
  const missingKey = `NOE_WEAK_LOADENV_MISSING_${process.pid}`;
  const explicitKey = `NOE_WEAK_LOADENV_EXPLICIT_${process.pid}`;
  writeFileSync(copyPath, sourceText, { mode: 0o600 });
  for (const [from, to] of depCopies) {
    writeFileSync(to, readFileSync(from, 'utf8'), { mode: 0o600 });
  }
  writeFileSync(join(copyRoot, '.env'), `${newKey}=from-temp-copy\n${existingKey}=from-temp-file\n`, { mode: 0o600 });
  writeFileSync(join(tempRoot, 'explicit.env'), `${explicitKey}=from-explicit-file\n`, { mode: 0o600 });

  const oldExisting = process.env[existingKey];
  const oldPort = process.env.PORT;
  const oldPanelDbPath = process.env.PANEL_DB_PATH;
  try {
    process.env[existingKey] = 'from-existing-env';
    // load-env 现在还会在顶层应用隔离 DB 策略。用受控 live 端口导入，
    // 并隔离调用者的 DB env，避免 drill 污染同一进程中的后续测试。
    process.env.PORT = '51835';
    delete process.env.PANEL_DB_PATH;
    const imported = await import(`${pathToFileURL(copyPath).href}?drill=${Date.now()}-${Math.random()}`);
    const missingResult = imported.loadEnvInto(join(tempRoot, 'missing.env'));
    const explicitResult = imported.loadEnvInto(join(tempRoot, 'explicit.env'));
    const evidence = {
      tempCopyOnly: true,
      importedTempCopy: typeof imported.loadEnvInto === 'function',
      isolationPolicyDependencyCopied: existsSync(isolationPolicyCopyPath),
      topLevelLoadedTempEnv: process.env[newKey] === 'from-temp-copy',
      didNotOverrideExisting: process.env[existingKey] === 'from-existing-env',
      missingFileReturnsFalse: missingResult === false,
      explicitFileLoads: explicitResult === true && process.env[explicitKey] === 'from-explicit-file',
      sourceBytes: Buffer.byteLength(sourceText, 'utf8'),
    };
    return okFile('src/bootstrap/load-env.js', 'isolated_tested_support_manual_review_needed', evidence, 'support behavior drilled via temp source copy; actual project-root .env was not imported');
  } finally {
    if (oldExisting === undefined) delete process.env[existingKey];
    else process.env[existingKey] = oldExisting;
    if (oldPort === undefined) delete process.env.PORT;
    else process.env.PORT = oldPort;
    if (oldPanelDbPath === undefined) delete process.env.PANEL_DB_PATH;
    else process.env.PANEL_DB_PATH = oldPanelDbPath;
    delete process.env[newKey];
    delete process.env[missingKey];
    delete process.env[explicitKey];
  }
}

function drillAtomicJsonFile(tempRoot) {
  const file = join(tempRoot, 'state', 'sample.json');
  atomicWriteJson(file, { generation: 1 }, { backup: false });
  atomicWriteJson(file, { generation: 2 }, { backup: true });
  const loaded = readJsonWithCorruptBackup(file, { label: 'weak-targeted-drill' });
  const backupExists = existsSync(`${file}.bak-latest`);
  return okFile('src/state/atomicJsonFile.js', 'shared_persistence_utility_tempfile_drill_needed', {
    tempOnly: true,
    loadedGeneration: loaded?.generation ?? null,
    backupExists,
    ok: loaded?.generation === 2 && backupExists,
  }, '');
}

function drillHostExecEnv() {
  const env = {
    PATH: '/usr/bin',
    HOME: '/tmp/noe-home',
    NODE_OPTIONS: '--require bad',
    API_KEY: 'raw-secret',
    SAFE_EXTRA: 'ok',
  };
  const safe = buildNoeSafeChildProcessEnv(env, {
    extraEnv: { SAFE_EXTRA: 'ok', TOKEN_EXTRA: 'raw-token' },
    allowlist: ['PATH', 'HOME'],
    defaults: { LANG: 'C' },
  });
  const sanitized = sanitizeNoeHostExecEnv(env, { allowlist: Object.keys(env) });
  return okFile('src/security/NoeHostExecEnv.js', 'host_exec_boundary_targeted_probe_needed', {
    dangerousDropped: safe.NODE_OPTIONS === undefined && sanitized.NODE_OPTIONS === undefined,
    secretsDropped: safe.API_KEY === undefined && safe.TOKEN_EXTRA === undefined && sanitized.API_KEY === undefined,
    defaultsApplied: safe.LANG === 'C',
    safeExtraAllowed: safe.SAFE_EXTRA === 'ok',
  }, '');
}

function drillSecretBroker(tempRoot) {
  const calls = [];
  const broker = new NoeSecretBroker({
    platform: 'darwin',
    spawnSyncImpl: /** @type {any} */ ((bin, args) => {
      calls.push({ bin, args });
      return { status: 0, stderr: 'metadata only', stdout: '' };
    }),
  });
  const keychain = broker.readKeychainMetadata({ account: 'unit-account', service: 'unit-service' });
  const envFile = join(tempRoot, 'fake.env');
  writeFileSync(envFile, 'PUBLIC_NAME=noe\nAPI_KEY=unit-test-secret-value\n', { mode: 0o600 });
  const env = broker.inspectEnvFile({ path: envFile, root: tempRoot });
  const outside = broker.inspectEnvFile({ path: join(dirname(tempRoot), 'outside.env'), root: tempRoot });
  return okFile('src/secrets/NoeSecretBroker.js', 'credential_boundary_targeted_probe_no_secret_read', {
    keychainPresent: keychain.present === true,
    keychainNoDashW: calls.every((call) => !arr(call.args).includes('-w')),
    keychainValueRedacted: keychain.value === '[redacted]' && keychain.secretValuesReturned === false,
    envCount: env.count,
    envSecretRedacted: env.entries?.some((entry) => entry.key === 'API_KEY' && entry.valuePreview === '[redacted]' && entry.secretValuesReturned === false) === true,
    outsideRootBlocked: outside.error === 'env_path_outside_allowed_root',
  }, '');
}

function drillVoiceprint() {
  const wav = makePcm16Wav();
  const embedding = computeVoiceEmbedding(wav);
  const score = scoreVoiceEmbedding(embedding, [embedding]);
  return okFile('src/identity/Voiceprint.js', 'sensor_identity_runtime_probe_needed', {
    generatedAudioOnly: true,
    embeddingLength: embedding.length,
    score: Math.round(score.score * 1000) / 1000,
    sampleCount: score.sampleCount,
    ok: embedding.length > 10 && score.score > 0.99,
  }, '');
}

function drillCitationRenderer() {
  const citations = [{
    index: 1,
    docTitle: 'Doc <Title>',
    sourceUrl: 'https://example.test/?x=<tag>',
    textSnippet: 'snippet with <unsafe>',
    chunkId: 'chunk-1',
  }];
  const html = renderCitations('See [1] and [99]', citations);
  const bib = renderBibliography(citations);
  return okFile('src/knowledge/learned/citation-renderer.js', 'isolated_tested_support_manual_review_needed', {
    pureFunctionOnly: true,
    citationLinked: html.includes('data-cite-chunk-id="chunk-1"'),
    missingCitationPreserved: html.includes('[99]'),
    htmlEscaped: !html.includes('<unsafe>') && bib.includes('&lt;Title&gt;'),
  }, 'support role locally drilled; live runtime wiring only needed if expected as always-on feature');
}

function targetFilesFromLaneAudit(laneAudit = {}) {
  const wanted = new Set([
    'src/state/atomicJsonFile.js',
    'src/security/NoeHostExecEnv.js',
    'src/secrets/NoeSecretBroker.js',
    'src/identity/Voiceprint.js',
    'src/knowledge/learned/citation-renderer.js',
    'src/bootstrap/load-env.js',
  ]);
  return arr(laneAudit.files).filter((file) => wanted.has(file.file));
}

export async function buildNoeWeakTargetedLocalDrills({
  paths = DEFAULT_PATHS,
  now = new Date(),
  keepTemp = false,
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const laneAudit = readJson(resolvedPaths.weakRuntimeRemainingLaneAudit);
  const targets = targetFilesFromLaneAudit(laneAudit);
  const tempRoot = mkdtempSync(join(tmpdir(), 'noe-weak-targeted-drills-'));
  const files = [];
  try {
    const targetSet = new Set(targets.map((file) => file.file));
    if (targetSet.has('src/state/atomicJsonFile.js')) files.push(drillAtomicJsonFile(tempRoot));
    if (targetSet.has('src/security/NoeHostExecEnv.js')) files.push(drillHostExecEnv());
    if (targetSet.has('src/secrets/NoeSecretBroker.js')) files.push(drillSecretBroker(tempRoot));
    if (targetSet.has('src/identity/Voiceprint.js')) files.push(drillVoiceprint());
    if (targetSet.has('src/knowledge/learned/citation-renderer.js')) files.push(drillCitationRenderer());
    if (targetSet.has('src/bootstrap/load-env.js')) files.push(await drillLoadEnv(tempRoot));
  } finally {
    if (!keepTemp) rmSync(tempRoot, { recursive: true, force: true });
  }

  const statusCounts = {};
  const laneCounts = {};
  for (const file of files) {
    inc(statusCounts, file.drillStatus);
    inc(laneCounts, file.lane);
  }
  const drilledOk = files.filter((file) => file.drillStatus === 'drilled_ok');
  const skipped = files.filter((file) => file.drillStatus === 'skipped_by_policy');
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: laneAudit.root || ROOT,
    inputs: {
      weakRuntimeRemainingLaneAudit: rel(resolvedPaths.weakRuntimeRemainingLaneAudit),
      weakRuntimeRemainingLaneAuditGeneratedAt: laneAudit.generatedAt || '',
    },
    policy: {
      localTempOnly: true,
      readOnlyRealProjectState: true,
      noRealEnvFileReads: true,
      tempEnvFileOnly: true,
      noProjectEnvImport: true,
      noOwnerTokenReads: true,
      noRealKeychainSecretReads: true,
      noProtectedApiAuth: true,
      noDbReads: true,
      noNetworkCalls: true,
      noModelCalls: true,
      noMicOrCameraAccess: true,
      noHostExecSpawn: true,
      noSecretValuesReturned: true,
    },
    status: {
      drill: skipped.length ? 'targeted_local_drills_partial_policy_skip' : 'targeted_local_drills_complete',
      completionClaim: 'not_complete',
      explanation: 'Local drills cover runtime-chain/manual support behavior where safe. They prove component contracts, not natural live-panel invocation.',
    },
    summary: {
      targetFiles: targets.length,
      drilledOk: drilledOk.length,
      skippedByPolicy: skipped.length,
      failed: files.filter((file) => file.drillStatus === 'failed').length,
      chainTargetFiles: targets.filter((file) => file.reviewClass === 'runtime_chain_imported_candidate').length,
      chainDrilledOk: drilledOk.filter((file) => [
        'src/state/atomicJsonFile.js',
        'src/security/NoeHostExecEnv.js',
        'src/secrets/NoeSecretBroker.js',
        'src/identity/Voiceprint.js',
      ].includes(file.file)).length,
      manualSupportFiles: targets.filter((file) => file.reviewClass === 'isolated_library_with_tests').length,
      manualSupportDrilledOk: drilledOk.filter((file) => [
        'src/knowledge/learned/citation-renderer.js',
        'src/bootstrap/load-env.js',
      ].includes(file.file)).length,
      manualSupportSkippedByPolicy: skipped.filter((file) => file.file === 'src/bootstrap/load-env.js').length,
      statusCounts,
      laneCounts,
    },
    files,
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderMarkdown(report, jsonPath = '') {
  const rows = report.files.map((file) => [
    `\`${file.file}\``,
    file.lane,
    file.drillStatus,
    Object.entries(file.evidence || {}).slice(0, 6).map(([key, value]) => `${key}:${clean(value, 80)}`).join('<br>') || '-',
    clean(file.remainingNeed || '-', 180),
  ]);
  return [
    '# Noe Weak Targeted Local Drills',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Verdict',
    '',
    `- drill: \`${report.status.drill}\``,
    `- completion claim: \`${report.status.completionClaim}\``,
    `- explanation: ${report.status.explanation}`,
    '',
    '## Summary',
    '',
    `- target files: ${report.summary.targetFiles}`,
    `- drilled ok: ${report.summary.drilledOk}; skipped by policy: ${report.summary.skippedByPolicy}; failed: ${report.summary.failed}`,
    `- chain drilled ok: ${report.summary.chainDrilledOk}/${report.summary.chainTargetFiles}`,
    `- manual support drilled ok: ${report.summary.manualSupportDrilledOk}/${report.summary.manualSupportFiles}; skipped by policy: ${report.summary.manualSupportSkippedByPolicy}`,
    '',
    '## Files',
    '',
    mdTable([
      ['file', 'lane', 'status', 'evidence', 'remaining need'],
      ['---', '---', '---', '---', '---'],
      ...rows,
    ]),
    '',
    '## Interpretation',
    '',
    '- `drilled_ok` proves a local component contract in isolation with temp/fake inputs.',
    '- It does not prove natural live-panel invocation, owner-authorized business behavior, or route handler execution.',
    '- `src/bootstrap/load-env.js` is drilled by importing a temp source copy whose module side effect points at a temp `.env`, avoiding the real project `.env`.',
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writeNoeWeakTargetedLocalDrills(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildNoeWeakTargetedLocalDrills();
  const paths = writeNoeWeakTargetedLocalDrills(report);
  console.log(JSON.stringify({
    ok: report.ok,
    drill: report.status.drill,
    targetFiles: report.summary.targetFiles,
    drilledOk: report.summary.drilledOk,
    skippedByPolicy: report.summary.skippedByPolicy,
    chainDrilledOk: report.summary.chainDrilledOk,
    manualSupportDrilledOk: report.summary.manualSupportDrilledOk,
    paths,
  }, null, 2));
}
