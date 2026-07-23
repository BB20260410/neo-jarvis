// @ts-check
import { describe, expect, it } from 'vitest';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectCurrentBytes,
  computeSourceDigest,
  computeSourceDigestSync,
  computeRuntimeConfigDigest,
  readNonSecretRuntimeConfig,
  readToolchain,
  jcsStringify,
  sha256Hex,
  buildEvidenceKey,
  shouldExcludePath,
} from '../../src/runtime/NoeSourceDigest.js';
import {
  buildCapabilityManifest,
  isProductClaimable,
  assertNotStaticComplete,
  CAPABILITY_STATUSES,
} from '../../src/runtime/NoeCapabilityManifest.js';
import {
  evaluateAbsoluteGate,
  runAcceptanceGates,
  computeVtcr,
  computeTruthMetrics,
  evalOperator,
} from '../../src/runtime/NoeAcceptanceGateRunner.js';
import {
  BAILONGMA_FIXED_BASELINE,
  BAILONGMA_FUSION_SCHEMA_VERSION,
  buildProductSurpassFeatureMap,
  buildBaiLongmaFusionReport,
  scanBaiLongmaRepository,
} from '../../src/runtime/NoeBaiLongmaFusionPlanner.js';

describe('NoeSourceDigest', () => {
  it('produces stable digest for identical currentBytes and changes when bytes change', () => {
    const a = computeSourceDigestSync({
      baseCommit: 'abc',
      currentBytes: { 'src/a.js': sha256Hex('one'), 'package.json': sha256Hex('{}') },
      toolchain: { node: 'v1', npm: '1', electron: '1' },
      target: { platform: 'darwin', arch: 'arm64' },
      presentEnvKeys: ['PORT'],
    });
    const b = computeSourceDigestSync({
      baseCommit: 'abc',
      currentBytes: { 'src/a.js': sha256Hex('one'), 'package.json': sha256Hex('{}') },
      toolchain: { node: 'v1', npm: '1', electron: '1' },
      target: { platform: 'darwin', arch: 'arm64' },
      presentEnvKeys: ['PORT'],
    });
    const c = computeSourceDigestSync({
      baseCommit: 'abc',
      currentBytes: { 'src/a.js': sha256Hex('two'), 'package.json': sha256Hex('{}') },
      toolchain: { node: 'v1', npm: '1', electron: '1' },
      target: { platform: 'darwin', arch: 'arm64' },
      presentEnvKeys: ['PORT'],
    });
    expect(a.sourceDigest).toBe(b.sourceDigest);
    expect(a.sourceDigest).not.toBe(c.sourceDigest);
    expect(a.sourceDigest.startsWith('sha256:')).toBe(true);
    expect(a.runtimeConfigDigest.startsWith('sha256:')).toBe(true);
  });

  it('excludes secrets, node_modules, and db paths', () => {
    expect(shouldExcludePath('node_modules/x.js')).toBe(true);
    expect(shouldExcludePath('.env')).toBe(true);
    expect(shouldExcludePath('src/runtime/NoeSourceDigest.js')).toBe(false);
    expect(shouldExcludePath('src/outcome.js')).toBe(false);
    expect(shouldExcludePath('panel.db')).toBe(true);
  });

  it('runtime config digest canonicalizes key-presence order', () => {
    const d1 = computeRuntimeConfigDigest({ presentEnvKeys: ['B', 'A'] });
    const d2 = computeRuntimeConfigDigest({ presentEnvKeys: ['A', 'B'] });
    expect(d1).toBe(d2);
  });

  it('runtime config digest binds allowlisted non-secret behavior values', () => {
    const free = readNonSecretRuntimeConfig({ NOE_AUTONOMY_PROFILE: 'free' });
    const off = readNonSecretRuntimeConfig({ NOE_AUTONOMY_PROFILE: 'off' });
    expect(computeRuntimeConfigDigest(free)).not.toBe(computeRuntimeConfigDigest(off));
    expect(free.runtimeValues.NOE_AUTONOMY_PROFILE).toBe('free');
    expect(free.runtimeValues).not.toHaveProperty('MINIMAX_API_KEY');
  });

  it('binds build resources that affect the packaged application', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-digest-build-'));
    try {
      mkdirSync(join(root, 'build'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}\n');
      writeFileSync(join(root, 'build/entitlements.mac.plist'), '<plist>one</plist>\n');
      const before = collectCurrentBytes(root, { sync: true });
      expect(before).toHaveProperty('build/entitlements.mac.plist');
      writeFileSync(join(root, 'build/entitlements.mac.plist'), '<plist>two</plist>\n');
      const after = collectCurrentBytes(root, { sync: true });
      expect(after['build/entitlements.mac.plist']).not.toBe(before['build/entitlements.mac.plist']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds packaged media and unknown future extensions under public', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-digest-public-assets-'));
    try {
      mkdirSync(join(root, 'public/assets'), { recursive: true });
      mkdirSync(join(root, 'public/vendor/earth'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}\n');
      writeFileSync(join(root, 'public/assets/onboarding.mp4'), Buffer.from([0, 1, 2, 3]));
      writeFileSync(join(root, 'public/vendor/earth/earth.jpg'), Buffer.from([4, 5, 6]));
      writeFileSync(join(root, 'public/runtime.future-asset'), Buffer.from([7, 8, 9]));

      const before = collectCurrentBytes(root, { sync: true });
      expect(before).toHaveProperty('public/assets/onboarding.mp4');
      expect(before).toHaveProperty('public/vendor/earth/earth.jpg');
      expect(before).toHaveProperty('public/runtime.future-asset');

      writeFileSync(join(root, 'public/assets/onboarding.mp4'), Buffer.from([0, 1, 2, 4]));
      const after = collectCurrentBytes(root, { sync: true });
      expect(after['public/assets/onboarding.mp4']).not.toBe(
        before['public/assets/onboarding.mp4'],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds the external website and developer documentation surfaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-digest-docs-'));
    try {
      mkdirSync(join(root, 'website'), { recursive: true });
      mkdirSync(join(root, 'docs'), { recursive: true });
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'README.md'), '# Neo\n');
      writeFileSync(join(root, '.nvmrc'), '22.22.2\n');
      writeFileSync(join(root, 'vitest.config.mjs'), 'export default {}\n');
      writeFileSync(join(root, 'jsconfig.json'), '{}\n');
      writeFileSync(join(root, 'website/index.html'), '<title>Neo</title>\n');
      writeFileSync(join(root, 'website/_headers'), '/*\n  X-Frame-Options: DENY\n');
      writeFileSync(join(root, 'scripts/tool.py'), 'print("bound")\n');
      writeFileSync(join(root, 'docs/extension.md'), 'extension contract\n');
      const bytes = collectCurrentBytes(root, { sync: true });
      expect(bytes).toHaveProperty('README.md');
      expect(bytes).toHaveProperty('.nvmrc');
      expect(bytes).toHaveProperty('vitest.config.mjs');
      expect(bytes).toHaveProperty('jsconfig.json');
      expect(bytes).toHaveProperty('website/index.html');
      expect(bytes).toHaveProperty('website/_headers');
      expect(bytes).toHaveProperty('scripts/tool.py');
      expect(bytes).toHaveProperty('docs/extension.md');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds actual non-secret migration switches without exposing secret keys', () => {
    const config = readNonSecretRuntimeConfig({
      NOE_UNIFIED_TASK_WRITE: '1',
      NODE_ENV: 'production',
      MINIMAX_API_KEY: 'must-not-enter-digest-shape',
    });
    expect(config.migrationSwitches.NOE_UNIFIED_TASK_WRITE).toBe('1');
    expect(config.presentEnvKeys).toContain('NODE_ENV');
    expect(config.presentEnvKeys).not.toContain('MINIMAX_API_KEY');
  });

  it('binds source permission bits and symlink targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'source-digest-metadata-'));
    try {
      mkdirSync(join(root, 'scripts'), { recursive: true });
      writeFileSync(join(root, 'package.json'), '{}\n');
      writeFileSync(join(root, 'scripts/a.js'), 'export const a = 1\n', { mode: 0o644 });
      writeFileSync(join(root, 'scripts/b.js'), 'export const b = 1\n');
      symlinkSync('a.js', join(root, 'scripts/current.js'));
      const before = collectCurrentBytes(root, { sync: true });
      expect(before).toHaveProperty('scripts/current.js');

      chmodSync(join(root, 'scripts/a.js'), 0o755);
      const afterMode = collectCurrentBytes(root, { sync: true });
      expect(afterMode['scripts/a.js']).not.toBe(before['scripts/a.js']);

      rmSync(join(root, 'scripts/current.js'));
      symlinkSync('b.js', join(root, 'scripts/current.js'));
      const afterTarget = collectCurrentBytes(root, { sync: true });
      expect(afterTarget['scripts/current.js']).not.toBe(before['scripts/current.js']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects the legacy root option instead of silently hashing process.cwd()', async () => {
    await expect(computeSourceDigest({ root: '/tmp/wrong-option' })).rejects.toThrow(/rootDir/);
    expect(() => computeSourceDigestSync({ root: '/tmp/wrong-option' })).toThrow(/rootDir/);
  });

  it('binds npm from the active Node runtime instead of an unrelated PATH node', () => {
    const toolchain = readToolchain(process.cwd());
    expect(toolchain.node).toBe(process.version);
    expect(toolchain.npm).toMatch(/^\d+\.\d+\.\d+/);
    expect(toolchain.electron).not.toBe('unknown');
  });

  it('buildEvidenceKey binds gate + digests', () => {
    const k1 = buildEvidenceKey({
      gateId: 'G-TRUTH-01',
      sourceDigest: 'sha256:aaa',
      runtimeConfigDigest: 'sha256:bbb',
      platform: 'darwin',
      arch: 'arm64',
    });
    const k2 = buildEvidenceKey({
      gateId: 'G-TRUTH-01',
      sourceDigest: 'sha256:aaa',
      runtimeConfigDigest: 'sha256:bbb',
      platform: 'darwin',
      arch: 'arm64',
    });
    const k3 = buildEvidenceKey({
      gateId: 'G-TRUTH-01',
      sourceDigest: 'sha256:ccc',
      runtimeConfigDigest: 'sha256:bbb',
      platform: 'darwin',
      arch: 'arm64',
    });
    expect(k1).toBe(k2);
    expect(k1).not.toBe(k3);
  });

  it('jcsStringify sorts keys', () => {
    expect(jcsStringify({ b: 1, a: 2 })).toBe(jcsStringify({ a: 2, b: 1 }));
  });
});

describe('NoeCapabilityManifest', () => {
  it('never marks verified from static presence alone', () => {
    const root = mkdtempSync(join(tmpdir(), 'cap-manifest-'));
    try {
      mkdirSync(join(root, 'src/runtime'), { recursive: true });
      writeFileSync(join(root, 'src/runtime/NoeIsolationDbPolicy.js'), 'export const x=1\n');
      writeFileSync(join(root, 'src/runtime/NoeDoctor.js'), 'export const d=1\n');
      const m = buildCapabilityManifest({ rootDir: root });
      expect(m.summary.verifiedCount).toBe(0);
      expect(m.capabilities.every((c) => c.status !== 'verified')).toBe(true);
      expect(isProductClaimable('shadow')).toBe(false);
      expect(isProductClaimable('verified')).toBe(true);
      for (const s of CAPABILITY_STATUSES) expect(typeof s).toBe('string');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('demotes verified without evidence or sourceDigest', () => {
    const m = buildCapabilityManifest({
      rootDir: process.cwd(),
      evidenceOverrides: [
        { id: 'cap.isolation_db_policy', status: 'verified', evidence: [], sourceDigest: null },
      ],
    });
    const cap = m.capabilities.find((c) => c.id === 'cap.isolation_db_policy');
    expect(cap).toBeTruthy();
    expect(cap.status).not.toBe('verified');
    const bad = assertNotStaticComplete({ status: 'verified', evidence: [], sourceDigest: null });
    expect(bad.ok).toBe(false);
  });
});

describe('NoeAcceptanceGateRunner', () => {
  it('evalOperator supports eq/gte/lte', () => {
    expect(evalOperator('eq', 0, 0).pass).toBe(true);
    expect(evalOperator('gte', 0.9, 0.9).pass).toBe(true);
    expect(evalOperator('lte', 10, 10).pass).toBe(true);
    expect(evalOperator('gte', 0.8, 0.9).pass).toBe(false);
  });

  it('fail-closed: metric hit without bound evidence stays pending', () => {
    const gate = {
      id: 'G-TRUTH-01',
      name: 'false completions',
      metric: 'falseCompletionCount',
      operator: 'eq',
      target: 0,
      evidence: [],
    };
    const r = evaluateAbsoluteGate(gate, {
      metrics: { falseCompletionCount: 0 },
      sourceDigest: 'sha256:test',
    });
    expect(r.status).toBe('pending');
    expect(r.blockers).toContain('no_valid_bound_evidence');
  });

  it('passes only with matching sourceDigest evidence and metric', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gate-ev-'));
    const artifact = join(tmp, 'proof.txt');
    writeFileSync(artifact, 'ok\n');
    try {
      const gate = {
        id: 'G-TRUTH-01',
        name: 'false completions',
        metric: 'falseCompletionCount',
        operator: 'eq',
        target: 0,
        evidence: [
          {
            path: artifact,
            sourceDigest: 'sha256:abc',
            artifactSha256: sha256Hex('ok\n'),
          },
        ],
      };
      const r = evaluateAbsoluteGate(gate, {
        metrics: { falseCompletionCount: 0 },
        sourceDigest: 'sha256:abc',
        runtimeConfigDigest: 'sha256:cfg',
      });
      expect(r.status).toBe('pass');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('stales evidence when sourceDigest mismatches', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'gate-stale-'));
    const artifact = join(tmp, 'proof.txt');
    writeFileSync(artifact, 'ok\n');
    try {
      const gate = {
        id: 'G-TRUTH-01',
        metric: 'falseCompletionCount',
        operator: 'eq',
        target: 0,
        evidence: [{ path: artifact, sourceDigest: 'sha256:old' }],
      };
      const r = evaluateAbsoluteGate(gate, {
        metrics: { falseCompletionCount: 0 },
        sourceDigest: 'sha256:new',
      });
      expect(r.status).toBe('pending');
      expect(r.validEvidenceCount).toBe(0);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('runAcceptanceGates refuses executor accepted and computes summary', () => {
    const matrix = {
      planId: 'test',
      authority: { executorMaximumStatus: 'ready_for_codex_validation' },
      candidate: { overallStatus: 'accepted', startedAt: '2026-01-01' },
      absoluteGates: [
        { id: 'G1', metric: 'falseCompletionCount', operator: 'eq', target: 0, evidence: [] },
      ],
      stages: [{ id: 'S0', name: 'RECOVERING', dependsOn: [], status: 'completed', evidence: [] }],
    };
    const r = runAcceptanceGates(matrix, {
      metrics: { falseCompletionCount: 0 },
      sourceDigest: 'sha256:x',
    });
    expect(r.ok).toBe(true);
    expect(r.overallStatus).toBe('invalid_executor_claimed_accepted');
    expect(r.readyForCodexValidation).toBe(false);
    expect(r.summary.pending).toBe(1);
  });

  it('computeVtcr and truth metrics from real receipt rows', () => {
    const tasks = [
      { status: 'completed', verified: true, hasValidArtifacts: true, hasEvidence: true, receiptId: 'r1', exitCode: 0 },
      { status: 'completed', verified: false, hasValidArtifacts: true, hasEvidence: true, receiptId: 'r2', exitCode: 0 },
      { status: 'cancelled', cancelledByUser: true },
      { status: 'failed', verified: false },
    ];
    const vtcr = computeVtcr(tasks);
    expect(vtcr.accepted).toBe(3);
    expect(vtcr.verifiedCompleted).toBe(1);
    expect(vtcr.VTCR).toBeCloseTo(1 / 3);
    const truth = computeTruthMetrics(tasks);
    expect(truth.falseCompletionCount).toBe(1);
    expect(truth.completedWithExitNonZero).toBe(0);
  });
});

describe('Fusion planner product dimensions (S1)', () => {
  it('exports fixed baseline and schema v2', () => {
    expect(BAILONGMA_FIXED_BASELINE.release).toBe('v2.1.549');
    expect(BAILONGMA_FIXED_BASELINE.commit).toBe('7b9e7b378be5d3e9acc0daed8f0176eb51022b97');
    expect(BAILONGMA_FUSION_SCHEMA_VERSION).toBe(2);
  });

  it('buildProductSurpassFeatureMap returns twelve-dim oriented features', () => {
    const features = buildProductSurpassFeatureMap({
      inventory: { ok: true, files: [{ path: 'package.json' }, { path: 'README.md' }, { path: 'src/memory/x.js' }] },
      packageJson: { dependencies: { electron: '1' } },
    });
    expect(features.length).toBeGreaterThanOrEqual(6);
    expect(features.every((f) => f.dimension)).toBe(true);
    expect(features.some((f) => f.id === 'product_default_task_loop')).toBe(true);
  });

  it('scans real fixed baseline cache when present', () => {
    const root =
      '/Users/hxx/Documents/Neo 2/.planning/2026-07-22-neo-bailongma-surpass-goal/evidence/S0/bailongma-v2.1.549';
    const inventory = scanBaiLongmaRepository(root);
    if (!inventory.ok) {
      expect(inventory.error).toBe('bailongma_root_missing');
      return;
    }
    const report = buildBaiLongmaFusionReport({
      bailongmaRoot: root,
      upstreamCommit: BAILONGMA_FIXED_BASELINE.commit,
    });
    expect(report.ok).toBe(true);
    expect(report.schemaVersion).toBe(2);
    expect(report.fixedBaseline.commit).toBe(BAILONGMA_FIXED_BASELINE.commit);
    expect(report.productFeatures.length).toBeGreaterThan(0);
    expect(report.features.length).toBeGreaterThan(7);
  });
});
