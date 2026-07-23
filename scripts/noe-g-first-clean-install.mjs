#!/usr/bin/env node
// @ts-check
/**
 * G-FIRST-01 supplementary probe: isolated HOME copy → Doctor → verified task timing.
 * This script never claims the five-real-human absolute gate.
 *
 * Isolation:
 *   - Temporary HOME (no ~/.noe-panel pollution)
 *   - Isolated SQLite DB
 *   - Non-live PORT (5199x)
 *   - RC app path from out-noe (or package dir)
 *
 * Usage:
 *   node scripts/noe-g-first-clean-install.mjs \
 *     --evidence-dir "/path/to/evidence/S8/g-first" \
 *     --users 5 \
 *     --source-digest "sha256:..."
 *   (`--users` counts technical personas, not human participants.)
 */
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, cpSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  DIRECTORY_TREE_HASH_KIND,
  evaluateGFirstGate,
  sha256DirectoryTree,
} from '../src/runtime/NoePackagingContract.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] || def : def;
}

function fileEvidence(path) {
  if (!path || !existsSync(path) || !statSync(path).isFile()) return null;
  const bytes = readFileSync(path);
  return {
    path,
    size: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

const evidenceDir = arg(
  '--evidence-dir',
  join(ROOT, 'out-noe', 'g-first-evidence'),
);
const personaCount = Math.max(1, Number(arg('--users', '5')) || 5);
const digestArg = arg('--source-digest', '');
const arch = process.env.NOE_PACK_ARCH || 'arm64';
const pkgEarly = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const productName = pkgEarly.productName || pkgEarly.build?.productName || 'Neo 贾维斯';
const defaultAppCandidates = [
  join(ROOT, 'out-noe', `mac-${arch}`, `${productName}.app`),
  join(ROOT, 'out-noe', `mac-${arch}`, 'Neo 贾维斯.app'),
  join(ROOT, 'out-noe', `mac-${arch}`, 'Noe.app'),
];
const appPathArg = arg('--app', '');
const appPath =
  appPathArg ||
  defaultAppCandidates.find((p) => existsSync(p)) ||
  defaultAppCandidates[0];

mkdirSync(evidenceDir, { recursive: true });

// Resolve sourceDigest from current bytes. An argument is an expectation, never
// an authority that may relabel an older app.
const { computeSourceDigest } = await import('../src/runtime/NoeSourceDigest.js');
const currentIdentity = await computeSourceDigest({ rootDir: ROOT });
if (digestArg && digestArg !== currentIdentity.sourceDigest) {
  throw new Error(
    `sourceDigest changed before G-FIRST: expected=${digestArg} actual=${currentIdentity.sourceDigest}`,
  );
}
const sourceDigest = currentIdentity.sourceDigest;
const runtimeConfigDigest = currentIdentity.runtimeConfigDigest;

const pkg = pkgEarly;
const appPresent = existsSync(appPath);
const installedAppName = `${productName}.app`;
const rcManifestPath = join(ROOT, 'out-noe', 'rc-manifest.json');
const directoryTreeSha256 = appPresent ? sha256DirectoryTree(appPath) : null;
const appBundleVersion = (() => {
  if (!appPresent) return null;
  const plistPath = join(appPath, 'Contents', 'Info.plist');
  if (!existsSync(plistPath)) return null;
  const result = spawnSync(
    '/usr/bin/plutil',
    ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plistPath],
    { encoding: 'utf8' },
  );
  return result.status === 0 ? String(result.stdout || '').trim() || null : null;
})();
const rcManifest = (() => {
  if (!existsSync(rcManifestPath)) return null;
  try {
    return JSON.parse(readFileSync(rcManifestPath, 'utf8'));
  } catch {
    return null;
  }
})();
const embeddedPackage = (() => {
  if (!appPresent) return null;
  const packagePath = join(appPath, 'Contents', 'Resources', 'app', 'package.json');
  if (!existsSync(packagePath)) return null;
  try {
    return JSON.parse(readFileSync(packagePath, 'utf8'));
  } catch {
    return null;
  }
})();
const manifestBound = Boolean(
  rcManifest &&
    rcManifest.packageVersion === pkgEarly.version &&
    rcManifest.sourceDigest === sourceDigest &&
    rcManifest.macApp?.sha256 === directoryTreeSha256 &&
    rcManifest.buildId &&
    rcManifest.buildId === embeddedPackage?.noeBuildId &&
    embeddedPackage?.noeSourceDigest === sourceDigest,
);

const { UnifiedTaskStore } = await import('../src/runtime/UnifiedTaskStore.js');
const { runFirstVerifiedTaskLoop } = await import('../src/runtime/NoeProductCapabilityLoops.js');
const { runNoeDoctor } = await import('../src/runtime/NoeDoctor.js');

/** @type {any[]} */
const sessions = [];

for (let i = 1; i <= personaCount; i++) {
  const userId = `u${String(i).padStart(2, '0')}`;
  const sessionRoot = join(tmpdir(), `noe-g-first-${userId}-${randomUUID().slice(0, 8)}`);
  const homeDir = join(sessionRoot, 'home');
  const dataDir = join(homeDir, '.noe-panel');
  const dbPath = join(dataDir, 'panel-isolation.db');
  const reportDir = join(evidenceDir, userId, 'reports');
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(reportDir, { recursive: true });

  const t0 = Date.now(); // install start
  // "Install": copy RC app into isolated Applications-like path (clean home)
  const installDir = join(homeDir, 'Applications');
  mkdirSync(installDir, { recursive: true });
  let installError = null;
  if (appPresent) {
    try {
      cpSync(appPath, join(installDir, installedAppName), { recursive: true });
    } catch (e) {
      installError = e instanceof Error ? e.message : String(e);
    }
  } else {
    installError = 'rc_app_missing';
  }
  const tInstall = Date.now();

  // Doctor probe against isolated env (no live 51835 mutation)
  const doctorEnv = {
    ...process.env,
    HOME: homeDir,
    PORT: String(51990 + i),
    NOE_DB_PATH: dbPath,
    NOE_ISOLATION: '1',
    NOE_UNIFIED_TASK_WRITE: '1',
  };
  let doctor = null;
  let doctorError = null;
  const tDoctorStart = Date.now();
  try {
    doctor = await runNoeDoctor({
      env: doctorEnv,
      root: ROOT,
      skipNetwork: true,
    });
  } catch (e) {
    doctorError = e instanceof Error ? e.message : String(e);
    // minimal doctor fallback probe
    doctor = {
      ok: false,
      error: doctorError,
      checks: {
        packageVersion: pkg.version,
        appPresent: existsSync(join(installDir, installedAppName)),
        dbPath,
      },
    };
  }
  const tDoctor = Date.now();

  // Verified technical task: UnifiedTask + receipt in isolation
  let firstTask = null;
  let firstTaskError = null;
  const tTaskStart = Date.now();
  try {
    const store = new UnifiedTaskStore({ env: doctorEnv });
    firstTask = await runFirstVerifiedTaskLoop({
      taskStore: store,
      reportDir,
      goal: `P01 clean-install first task for ${userId}: write verified report`,
      sourceDigest,
      env: doctorEnv,
    });
  } catch (e) {
    firstTaskError = e instanceof Error ? e.message : String(e);
    firstTask = { ok: false, error: firstTaskError };
  }
  const tTask = Date.now();

  // U01-ish: capability/version consistency snapshot
  const u01 = {
    packageVersion: pkg.version,
    appBundleVersion,
    sourceDigest,
    manifestBound,
    ok:
      appPresent &&
      appBundleVersion === pkg.version &&
      Boolean(sourceDigest) &&
      manifestBound,
  };

  // U04-ish: ordinary receipt exists and sameTruth from first task
  const u04 = {
    taskOk: firstTask?.ok === true,
    reportExists: firstTask?.reportExists === true,
    ordinaryCompleted: firstTask?.ordinaryCompleted === true,
    sameTruth: firstTask?.sameTruth === true,
    ok:
      firstTask?.ok === true &&
      firstTask?.reportExists === true &&
      firstTask?.sameTruth === true,
  };

  const installToFirstMinutes = (tTask - t0) / 60000;
  const withinSla = installToFirstMinutes <= 10 && firstTask?.ok === true && !installError;

  const session = {
    userId,
    persona: 'unattended_isolated_clean_home',
    guidance: 'none',
    method:
      'Isolated HOME + copy RC app (productName brand) + Doctor probe + UnifiedTask first verified loop (P01/U01/U04); supplementary only vs 5-human lab',
    timestamps: {
      installStartAt: new Date(t0).toISOString(),
      installEndAt: new Date(tInstall).toISOString(),
      doctorStartAt: new Date(tDoctorStart).toISOString(),
      doctorEndAt: new Date(tDoctor).toISOString(),
      taskStartAt: new Date(tTaskStart).toISOString(),
      taskEndAt: new Date(tTask).toISOString(),
    },
    durationsMs: {
      install: tInstall - t0,
      doctor: tDoctor - tDoctorStart,
      firstTask: tTask - tTaskStart,
      installToFirstTask: tTask - t0,
    },
    installToFirstVerifiedTaskMinutes: Number(installToFirstMinutes.toFixed(4)),
    withinSla10min: withinSla,
    package: {
      appPath,
      productName,
      installedApp: join(installDir, installedAppName),
      directoryTreeSha256,
      buildId: embeddedPackage?.noeBuildId || null,
      packageHashKind: DIRECTORY_TREE_HASH_KIND,
      packageVersion: pkg.version,
      appPresent,
      installError,
    },
    doctor: {
      ok: doctor?.ok !== false && !doctorError,
      error: doctorError,
      summary:
        doctor?.summary ||
        /** @type {any} */ (doctor)?.checks ||
        doctor ||
        null,
    },
    firstTask,
    tasks: { P01: firstTask?.ok === true, U01: u01.ok, U04: u04.ok },
    u01,
    u04,
    sourceDigest,
    sessionRoot,
    interventions: 0,
    evidence: {
      taskReport: fileEvidence(firstTask?.reportPath),
    },
  };

  const sessionPath = join(evidenceDir, userId, 'session.json');
  mkdirSync(dirname(sessionPath), { recursive: true });
  writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`);
  sessions.push({ ...session, sessionEvidence: fileEvidence(sessionPath) });

  // cleanup isolation tree except evidence
  try {
    rmSync(sessionRoot, { recursive: true, force: true });
  } catch {
    /* keep for debug */
  }
}

const passedUsers = sessions.filter(
  (s) =>
    s.withinSla10min &&
    s.tasks.P01 &&
    s.tasks.U01 &&
    s.tasks.U04 &&
    s.sessionEvidence?.sha256 &&
    s.evidence?.taskReport?.sha256,
);
const passRate = sessions.length ? passedUsers.length / sessions.length : 0;
const metricMinutes = sessions.length
  ? Math.max(...sessions.map((s) => s.installToFirstVerifiedTaskMinutes))
  : null;

const technicalPass =
  appPresent &&
  manifestBound &&
  sessions.length >= 5 &&
  passedUsers.length === sessions.length &&
  metricMinutes != null &&
  metricMinutes <= 10;
// This automation deliberately cannot assert human participation. Human-lab
// evidence must come from an independently reviewed real-user run.
const humanGate = evaluateGFirstGate({
  technicalPass,
  fiveRealHumans: false,
  humanUserCount: 0,
  humanPassedUserCount: 0,
  requiredPassUsers: 4,
});
const summary = {
  schemaVersion: 3,
  gate: 'G-FIRST-01',
  generatedAt: new Date().toISOString(),
  sourceDigest,
  runtimeConfigDigest,
  packageVersion: pkg.version,
  productName,
  rcAppPath: appPath,
  rcAppPresent: appPresent,
  directoryTreeSha256,
  packageHashKind: DIRECTORY_TREE_HASH_KIND,
  rcManifestExists: existsSync(rcManifestPath),
  rcManifestBound: manifestBound,
  appBundleVersion,
  buildId: embeddedPackage?.noeBuildId || null,
  humanUserCount: humanGate.humanUserCount,
  humanPassedUserCount: humanGate.humanPassedUserCount,
  requiredPassUsers: humanGate.requiredPassUsers,
  humanPassRate: 0,
  technicalPersonaCount: sessions.length,
  technicalPassedPersonaCount: passedUsers.length,
  technicalPassRate: passRate,
  metric: {
    installToFirstVerifiedTaskMinutes: metricMinutes,
    operator: 'lte',
    target: 10,
    pass: false,
    technicalPass,
    note: 'isolated_HOME_measurement_only_not_absolute_human_gate',
  },
  cleanMachineInstall: false,
  clean_machine_install_run: false,
  method:
    'unattended_isolated_clean_home_xN — supplementary automation on post-freeze RC package; NOT 5 real human lab',
  humanLab: {
    ok: humanGate.ok,
    status: humanGate.status,
    blockers: humanGate.blockers,
    reason: 'five_real_humans_not_evidenced_by_this_automation',
    fiveRealHumans: humanGate.fiveRealHumans,
    humanUserCount: humanGate.humanUserCount,
    humanPassedUserCount: humanGate.humanPassedUserCount,
    requiredPassUsers: humanGate.requiredPassUsers,
  },
  fiveRealHumans: humanGate.fiveRealHumans,
  isolatedHomeSupplementaryOnly: true,
  technicalIsolatedHomeOk: technicalPass,
  technicalTasksCovered: ['P01', 'U01', 'U04'],
  sessions: sessions.map((s) => ({
    userId: s.userId,
    installToFirstVerifiedTaskMinutes: s.installToFirstVerifiedTaskMinutes,
    withinSla10min: s.withinSla10min,
    tasks: s.tasks,
    directoryTreeSha256: s.package.directoryTreeSha256,
    packageHashKind: s.package.packageHashKind,
    taskId: s.firstTask?.taskId || null,
    reportPath: s.firstTask?.reportPath || null,
    buildId: s.package.buildId,
    sourceDigest: s.sourceDigest,
    sessionEvidence: s.sessionEvidence,
    taskReportEvidence: s.evidence?.taskReport || null,
  })),
  ok: humanGate.ok,
  absoluteGateClaim: 'technical_isolated_HOME_only_human_lab_required',
  absoluteGateStatus: humanGate.status,
  blockers: humanGate.blockers,
};

const summaryPath = join(evidenceDir, 'G-FIRST-01-summary.json');
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
// also write raw timing CSV-like log
const logPath = join(evidenceDir, 'timings.tsv');
writeFileSync(
  logPath,
  [
    'userId\tinstallToFirstMin\tP01\tU01\tU04\twithinSla\ttaskId',
    ...sessions.map(
      (s) =>
        `${s.userId}\t${s.installToFirstVerifiedTaskMinutes}\t${s.tasks.P01}\t${s.tasks.U01}\t${s.tasks.U04}\t${s.withinSla10min}\t${s.firstTask?.taskId || ''}`,
    ),
  ].join('\n') + '\n',
);

console.log(
  JSON.stringify(
    {
      ok: summary.ok,
      summaryPath,
      technicalPassedPersonaCount: summary.technicalPassedPersonaCount,
      technicalPersonaCount: summary.technicalPersonaCount,
      humanPassedUserCount: summary.humanPassedUserCount,
      humanUserCount: summary.humanUserCount,
      installToFirstVerifiedTaskMinutes: metricMinutes,
      sourceDigest,
      appPresent,
    },
    null,
    2,
  ),
);
process.exit(summary.ok ? 0 : 2);
