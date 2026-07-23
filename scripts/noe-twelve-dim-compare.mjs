#!/usr/bin/env node
// @ts-check
/**
 * Twelve-dimension relative comparison vs BaiLongma fixed baseline.
 * Same machine, 3 runs per comparable task where both sides can execute.
 *
 *   node scripts/noe-twelve-dim-compare.mjs \
 *     --evidence-dir .../evidence/S10/compare \
 *     --source-digest sha256:... \
 *     --bailongma-root .../bailongma-baseline
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const FIXED_BASELINE = Object.freeze({
  name: 'BaiLongma',
  version: '2.1.549',
  commit: '7b9e7b378be5d3e9acc0daed8f0176eb51022b97',
  tag: 'v2.1.549',
});

/**
 * @param {{version?: string|null, commit?: string|null, worktreeClean?: boolean}} [input]
 */
export function fixedBaselineTreeMatches({ version, commit, worktreeClean } = {}) {
  return (
    version === FIXED_BASELINE.version &&
    commit === FIXED_BASELINE.commit &&
    worktreeClean === true
  );
}

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] || def : def;
}

function mean(nums) {
  const a = nums.filter((n) => Number.isFinite(n));
  if (!a.length) return null;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

function rate(oks) {
  if (!oks.length) return null;
  return oks.filter(Boolean).length / oks.length;
}

export async function main() {
const evidenceDir = arg('--evidence-dir', join(ROOT, 'out-noe', 'compare'));
const digestArg = arg('--source-digest', '');
const blRoot = arg(
  '--bailongma-root',
  join(
    process.env.HOME || '',
    'Documents/Neo 2/.planning/2026-07-22-neo-bailongma-surpass-goal/evidence/S0/bailongma-v2.1.549',
  ),
);
const runs = Math.max(1, Number(arg('--runs', '3')) || 3);

mkdirSync(evidenceDir, { recursive: true });

const { computeSourceDigest } = await import('../src/runtime/NoeSourceDigest.js');
const currentIdentity = await computeSourceDigest({ rootDir: ROOT });
if (digestArg && digestArg !== currentIdentity.sourceDigest) {
  throw new Error(
    `sourceDigest changed before compare: expected=${digestArg} actual=${currentIdentity.sourceDigest}`,
  );
}
const sourceDigest = currentIdentity.sourceDigest;
const runtimeConfigDigest = currentIdentity.runtimeConfigDigest;

// Latest release delta audit (network optional)
let latestRelease = null;
try {
  const r = spawnSync(
    'curl',
    ['-sL', 'https://api.github.com/repos/xiaoyuanda666-ship-it/BaiLongma/releases/latest'],
    { encoding: 'utf8', timeout: 15000 },
  );
  if (r.status === 0 && r.stdout) {
    const j = JSON.parse(r.stdout);
    latestRelease = {
      tag: j.tag_name || null,
      publishedAt: j.published_at || null,
      commitish: j.target_commitish || null,
      matchesFixedBaseline:
        (j.tag_name === FIXED_BASELINE.tag || j.tag_name === `v${FIXED_BASELINE.version}`) &&
        j.target_commitish === FIXED_BASELINE.commit,
    };
  }
} catch {
  latestRelease = { error: 'release_lookup_failed' };
}

const blPkgPath = join(blRoot, 'package.json');
const blPresent = existsSync(blPkgPath);
let blPkg = null;
let blCommit = null;
let blWorktreeClean = false;
let blDirtyEntryCount = null;
if (blPresent) {
  blPkg = JSON.parse(readFileSync(blPkgPath, 'utf8'));
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: blRoot, encoding: 'utf8' });
  blCommit = r.status === 0 ? (r.stdout || '').trim() : null;
  const status = spawnSync(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { cwd: blRoot, encoding: 'utf8' },
  );
  if (status.status === 0) {
    const entries = String(status.stdout || '').split('\n').filter(Boolean);
    blDirtyEntryCount = entries.length;
    blWorktreeClean = entries.length === 0;
  }
}

const { recomputeDimensionRelative, summarizeRelativeDimensions } = await import(
  '../src/runtime/NoeRelativeDimensionScore.js'
);
const { UnifiedTaskStore } = await import('../src/runtime/UnifiedTaskStore.js');
const { runFirstVerifiedTaskLoop } = await import('../src/runtime/NoeProductCapabilityLoops.js');
const { runVoiceTaskLoopSuite } = await import('../src/runtime/NoeVoiceTaskLoop.js').catch(() => ({
  runVoiceTaskLoopSuite: null,
}));

/** Run Neo side tasks ×N */
async function runNeoSuite(runIndex) {
  const reportDir = join(evidenceDir, 'neo', `run-${runIndex}`, 'reports');
  mkdirSync(reportDir, { recursive: true });
  const t0 = performance.now();
  const store = new UnifiedTaskStore({ env: { NOE_UNIFIED_TASK_WRITE: '1' } });
  const first = await runFirstVerifiedTaskLoop({
    taskStore: store,
    reportDir,
    goal: `Compare run ${runIndex}: verified task report`,
    sourceDigest,
    env: { NOE_UNIFIED_TASK_WRITE: '1' },
  });
  const t1 = performance.now();

  // This is an internal Neo technical probe only. It must never be promoted to
  // a bilateral product comparison or used to synthesize packaging/security scores.
  const highRiskOk = null;

  let voice = null;
  if (typeof runVoiceTaskLoopSuite === 'function') {
    try {
      voice = await runVoiceTaskLoopSuite({ taskStore: store, sourceDigest });
    } catch (e) {
      voice = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  return {
    runIndex,
    runKind: 'neo_internal_technical_probe',
    durationMs: t1 - t0,
    firstTaskOk: first?.ok === true,
    falseCompleteDenied: first?.falseCompleteDenied === true,
    vtcrLike: first?.ok === true && first?.falseCompleteDenied === true ? 1 : 0,
    voiceOk: voice?.ok === true || voice?.taskLoopClosed === true,
    highRiskOk,
    taskId: first?.taskId || null,
  };
}

/** BaiLongma side: structural/capability probes on fixed baseline tree (no invented task success) */
function runBaiLongmaProbe(runIndex) {
  const t0 = performance.now();
  if (!blPresent) {
    return {
      runIndex,
      ok: false,
      durationMs: 0,
      nonComparable: true,
      reason: 'bailongma_baseline_tree_missing',
    };
  }
  // Structural capability surface comparable to D02/D05/D04/D03 presence
  const probes = {
    packageName: blPkg?.name === 'bailongma',
    versionPinned: blPkg?.version === FIXED_BASELINE.version || blPkg?.version?.startsWith('2.1.'),
    hasMemory: existsSync(join(blRoot, 'src/memory')) || existsSync(join(blRoot, 'src/memory.js')),
    hasVoice: existsSync(join(blRoot, 'src/voice')) || existsSync(join(blRoot, 'src/voice.js')),
    hasTicker: existsSync(join(blRoot, 'src/ticker.js')),
    hasUi: existsSync(join(blRoot, 'src/ui')) || existsSync(join(blRoot, 'src/ui.js')),
    commitMatch: blCommit === FIXED_BASELINE.commit,
    worktreeClean: blWorktreeClean,
  };
  const score =
    Object.values(probes).filter(Boolean).length / Object.keys(probes).length;
  const t1 = performance.now();
  return {
    runIndex,
    ok: score >= 0.5,
    durationMs: t1 - t0,
    structuralScore: score,
    probes,
    // Task-level success not claimed without live BaiLongma agent run
    taskLoopExecuted: false,
    nonComparableForTaskLoop: true,
    reason: 'structural_probe_only_no_live_agent_task_loop',
  };
}

const neoRuns = [];
for (let i = 1; i <= runs; i++) {
  neoRuns.push(await runNeoSuite(i));
}
const blRuns = [];
for (let i = 1; i <= runs; i++) {
  blRuns.push(runBaiLongmaProbe(i));
}

const neoTaskRate = rate(neoRuns.map((r) => r.firstTaskOk));
const neoVtcr = rate(neoRuns.map((r) => r.vtcrLike === 1));
const neoVoice = rate(neoRuns.map((r) => r.voiceOk));
const blStruct = mean(blRuns.map((r) => r.structuralScore).filter((x) => x != null));

/**
 * Dimension table — absolute + relative.
 * Leading dimensions require Neo absolute pass AND >= BaiLongma where comparable.
 */
const dimensions = [
  {
    id: 'D01',
    name: '安装与首启',
    neoScore: null, // filled from G-FIRST if present
    bailongmaScore: null,
    relative: 'pending_g_first_bind',
    relativeReason: null,
    measurementEquivalent: false,
    neoInputComplete: false,
    bailongmaInputComplete: false,
  },
  {
    id: 'D02',
    name: '默认任务闭环',
    neoScore: neoTaskRate,
    bailongmaScore: null,
    relative: 'non_comparable',
    relativeReason:
      'bailongma_live_task_loop_not_executed_on_fixed_baseline_only_structural_probe',
    measurementEquivalent: false,
    neoInputComplete: neoRuns.length === runs && neoRuns.every((r) => Boolean(r.taskId)),
    bailongmaInputComplete: false,
  },
  {
    id: 'D03',
    name: '浏览器',
    neoScore: null,
    bailongmaScore: null,
    relative: 'non_comparable',
    relativeReason: 'browser_e2e_pair_not_run_both_sides_this_session',
    measurementEquivalent: false,
    neoInputComplete: false,
    bailongmaInputComplete: false,
  },
  {
    id: 'D04',
    name: '语音',
    neoScore: neoVoice,
    bailongmaScore: null,
    relative: 'non_comparable',
    relativeReason: 'bailongma_voice_task_loop_not_run_on_baseline',
    measurementEquivalent: false,
    neoInputComplete: neoRuns.length === runs && neoRuns.every((r) => r.voiceOk === true),
    bailongmaInputComplete: false,
  },
  {
    id: 'D05',
    name: '记忆',
    neoScore: null,
    bailongmaScore: blStruct,
    relative: 'non_comparable',
    relativeReason: 'memory_pair_recall_benchmark_not_dual_run',
    measurementEquivalent: false,
    neoInputComplete: false,
    bailongmaInputComplete: false,
  },
  {
    id: 'D06',
    name: '多 Agent 复杂任务',
    neoScore: null,
    bailongmaScore: null,
    relative: 'non_comparable',
    relativeReason: 'multi_agent_complex_pair_not_run',
    measurementEquivalent: false,
    neoInputComplete: false,
    bailongmaInputComplete: false,
  },
  {
    id: 'D07',
    name: '状态可信度与证据',
    neoScore: neoVtcr,
    bailongmaScore: null,
    relative: 'non_comparable',
    relativeReason: 'bailongma_vtcr_not_measured',
    measurementEquivalent: false,
    neoInputComplete: neoRuns.length === runs && neoRuns.every((r) => Boolean(r.taskId)),
    bailongmaInputComplete: false,
  },
  {
    id: 'D08',
    name: '恢复与稳定性',
    neoScore: null,
    bailongmaScore: null,
    relative: 'non_comparable',
    relativeReason: 'soak_72h_not_complete',
    measurementEquivalent: false,
    neoInputComplete: false,
    bailongmaInputComplete: false,
  },
  {
    id: 'D09',
    name: '权限与安全',
    neoScore: null,
    bailongmaScore: null,
    relative: 'non_comparable',
    relativeReason: 'high_risk_pair_not_dual_run',
    measurementEquivalent: false,
    neoInputComplete: false,
    bailongmaInputComplete: false,
  },
  {
    id: 'D10',
    name: '资源占用',
    neoScore: null,
    bailongmaScore: null,
    relative: 'non_comparable',
    relativeReason: 'rss_fd_pair_sampling_not_run_3x',
    measurementEquivalent: false,
    neoInputComplete: false,
    bailongmaInputComplete: false,
  },
  {
    id: 'D11',
    name: '打包、更新与回滚',
    neoScore: null,
    bailongmaScore: null,
    relative: 'non_comparable',
    relativeReason: 'bilateral_real_artifact_update_rollback_records_missing',
    measurementEquivalent: false,
    neoInputComplete: false,
    bailongmaInputComplete: false,
  },
  {
    id: 'D12',
    name: '开发者扩展与文档',
    neoScore: null,
    bailongmaScore: null,
    relative: 'non_comparable',
    relativeReason: 'docs_extension_pair_not_scored',
    measurementEquivalent: false,
    neoInputComplete: false,
    bailongmaInputComplete: false,
  },
];

// Bind G-FIRST metric if present
const gFirstPaths = [
  join(evidenceDir, '../g-first/G-FIRST-01-summary.json'),
  join(dirname(evidenceDir), 'g-first/G-FIRST-01-summary.json'),
  join(dirname(dirname(evidenceDir)), 'S8/g-first/G-FIRST-01-summary.json'),
];
const gFirstPath = gFirstPaths.find((p) => existsSync(p));
if (gFirstPath) {
  const g = JSON.parse(readFileSync(gFirstPath, 'utf8'));
  const d01 = dimensions.find((d) => d.id === 'D01');
  const realHumanGatePassed =
    g.ok === true &&
    g.absoluteGateStatus === 'pass' &&
    g.fiveRealHumans === true &&
    Number(g.humanUserCount) >= 5 &&
    g.cleanMachineInstall === true;
  if (d01 && realHumanGatePassed && g.metric?.installToFirstVerifiedTaskMinutes != null) {
    // lower minutes is better — invert to score 0..1 with 10 min SLA
    const m = Number(g.metric.installToFirstVerifiedTaskMinutes);
    d01.neoScore = m <= 10 ? Math.max(0, 1 - m / 10) : 0;
    d01.absoluteMinutes = m;
    d01.neoInputComplete = true;
    d01.relative = 'non_comparable';
    d01.relativeReason = 'bailongma_clean_install_timing_not_run_same_machine';
  } else if (d01) {
    d01.neoInputComplete = false;
    d01.relative = 'non_comparable';
    d01.relativeReason = 'neo_five_human_clean_machine_gate_not_passed';
  }
}

// Auto-labels from numbers; D08 waived; strip hand labels that contradict scores
const labeledDimensions = dimensions.map((d) => {
  const pendingOwnerWaived = d.id === 'D08';
  const isProxy =
    d.isProxy === true ||
    (['D06', 'D09', 'D10', 'D11'].includes(d.id) && d.measurementEquivalent === false);
  return recomputeDimensionRelative({
    ...d,
    pendingOwnerWaived,
    isProxy,
    measurementEquivalent: d.measurementEquivalent === true && !pendingOwnerWaived,
    neoInputComplete: d.neoInputComplete === true,
    bailongmaInputComplete: d.bailongmaInputComplete === true,
  });
});

const dimensionSummary = summarizeRelativeDimensions(labeledDimensions);

const leadingRequired = ['D02', 'D06', 'D07', 'D08', 'D09'];
const leading = leadingRequired.map((id) => {
  const d = labeledDimensions.find((x) => x.id === id);
  return {
    id,
    neoScore: d?.neoScore ?? null,
    bailongmaScore: d?.bailongmaScore ?? null,
    leadBy10pp: null,
    status: d?.relative || 'pending',
    reason: d?.relativeReason || null,
  };
});

const summary = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  sourceDigest,
  runtimeConfigDigest,
  fixedBaseline: FIXED_BASELINE,
  latestRelease,
  bailongmaTree: {
    root: blRoot,
    present: blPresent,
    packageVersion: blPkg?.version || null,
    commit: blCommit,
    matchesFixedVersion:
      blPkg?.version === FIXED_BASELINE.version,
    matchesFixedCommit: blCommit === FIXED_BASELINE.commit,
    worktreeClean: blWorktreeClean,
    dirtyEntryCount: blDirtyEntryCount,
    matchesFixedTree: fixedBaselineTreeMatches({
      version: blPkg?.version,
      commit: blCommit,
      worktreeClean: blWorktreeClean,
    }),
  },
  runs,
  neoRuns,
  bailongmaRuns: blRuns,
  dimensions: labeledDimensions,
  dimensionSummary,
  leadingDimensions: leading,
  allDimensionsAbsoluteAndNotBelow: false,
  relativeComparisonComplete: false,
  blockers: [
    'bailongma_live_agent_tasks_not_executed_3x',
    `relative_dimensions_pass_${dimensionSummary.relativePass}_of_${dimensionSummary.total}`,
    `relative_dimensions_non_comparable_${dimensionSummary.nonComparable}`,
    'D08_pending_owner_waived',
  ],
  note:
    'Fail-closed compare: relative pass requires explicit equivalent methods and complete real inputs on both products; D08 remains pending_owner_waived.',
};

const outPath = join(evidenceDir, 'TWELVE_DIM_COMPARE.json');
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(
  join(evidenceDir, 'TWELVE_DIM_COMPARE.md'),
  [
    '# Twelve-dimension comparison (honest)',
    '',
    `- sourceDigest: \`${sourceDigest}\``,
    `- BaiLongma fixed: ${FIXED_BASELINE.tag} @ ${FIXED_BASELINE.commit}`,
    `- Latest release: ${latestRelease?.tag || 'unknown'} (match fixed: ${latestRelease?.matchesFixedBaseline})`,
    `- Neo runs: ${runs}; BaiLongma structural probes: ${runs}`,
    `- relativeComparisonComplete: false`,
    '',
    '| Dim | Neo | BaiLongma | Relative | Reason |',
    '|-----|-----|-----------|----------|--------|',
    ...labeledDimensions.map(
      (d) =>
        `| ${d.id} ${d.name} | ${d.neoScore ?? 'null'} | ${d.bailongmaScore ?? 'null'} | ${d.relative} | ${d.relativeReason || ''} |`,
    ),
    '',
  ].join('\n'),
);

console.log(
  JSON.stringify(
    {
      ok: true,
      outPath,
      sourceDigest,
      relativeComparisonComplete: false,
      neoTaskRate,
      blPresent,
      latestRelease,
    },
    null,
    2,
  ),
);
return summary;
}

const isMain =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  await main();
}
