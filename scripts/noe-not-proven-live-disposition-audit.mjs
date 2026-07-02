#!/usr/bin/env node
// @ts-check
// Disposition audit for files whose atlas runtime proof is not direct live evidence.
// Read-only: consumes existing no-body audits and probe summaries only.
// No DB/env/model/network access; no protected API auth; no file bodies exported.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_NOT_PROVEN_LIVE_DISPOSITION_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_NOT_PROVEN_LIVE_DISPOSITION_BASENAME || 'not-proven-live-disposition-audit-2026-06-15';

const DEFAULT_PATHS = {
  atlas: join(ROOT, 'output', 'noe-audit', 'full-code-function-atlas-2026-06-15.json'),
  backlog: join(ROOT, 'output', 'noe-audit', 'runtime-proof-backlog-2026-06-15.json'),
  authMatrix: join(ROOT, 'output', 'noe-audit', 'runtime-proof-auth-surface-matrix-live-2026-06-15.json'),
  nonroutePlan: join(ROOT, 'output', 'noe-audit', 'runtime-proof-nonroute-plan-2026-06-15.json'),
  localDrills: join(ROOT, 'output', 'noe-audit', 'runtime-proof-local-drills-2026-06-15.json'),
  p0AuthorizedReadonly: join(ROOT, 'output', 'noe-audit', 'p0-authorized-readonly-probe-2026-06-15.json'),
};

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function readJson(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function rel(path) {
  return String(path || '').replace(`${ROOT}/`, '');
}

function inc(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function mapByFile(items = []) {
  return new Map(arr(items).map((item) => [item.file, item]));
}

function liveRuntimeProof(proof = '') {
  return ['file_hint_plus_module_live', 'module_live_inferred', 'module_live_with_gap_inferred'].includes(proof);
}

function hasLiveAuthSurface(item = {}) {
  return arr(item.liveProtectedGetProbes).some((probe) => probe.statusKind === 'route_live_auth_protected');
}

function classifyStaticSupport(file = {}) {
  const path = String(file.file || '');
  if (path.startsWith('tests/')) return 'verification_test_not_runtime_feature';
  if (path.startsWith('scripts/')) return 'operations_or_verification_script_not_live_service';
  if (path.startsWith('public/vendor/')) return 'third_party_vendor_asset_support';
  if (path.startsWith('public/')) return 'ui_asset_static_support';
  if (file.usefulness === 'verification') return 'verification_support_not_runtime_feature';
  return '';
}

function localDrillDisposition(drill = {}) {
  if (drill.drillStatus !== 'drilled_ok') return '';
  if (drill.lane === 'support_only_classification_review') return 'support_only_reviewed';
  if (drill.lane === 'scheduler_or_delegation_runtime_evidence') return 'local_or_natural_runtime_evidence_drill_ok';
  if (drill.lane === 'server_constructed_provider_status_probe') return 'provider_status_or_mock_drill_ok';
  return 'local_behavior_drill_ok';
}

function dispositionFor({ atlasFile = {}, backlogFile, authFile, nonrouteFile, localDrill } = {}) {
  const proof = clean(atlasFile.runtime?.proof || '', 120);
  const support = classifyStaticSupport(atlasFile);
  if (liveRuntimeProof(proof)) {
    return {
      disposition: 'live_runtime_evidence',
      strength: 'strong',
      remainingNeed: '',
      evidence: 'atlas runtime proof is live/module-live evidence',
    };
  }
  if (authFile && hasLiveAuthSurface(authFile)) {
    return {
      disposition: 'live_auth_surface_proved_business_pending',
      strength: 'medium',
      remainingNeed: 'owner-authorized protected business summary if behavior proof is required',
      evidence: `${arr(authFile.liveProtectedGetProbes).length} protected GET surface probe(s) returned auth-protected live routes`,
    };
  }
  const drillDisposition = localDrillDisposition(localDrill);
  if (drillDisposition) {
    return {
      disposition: drillDisposition,
      strength: drillDisposition === 'support_only_reviewed' ? 'support' : 'medium',
      remainingNeed: nonrouteFile?.livePanelNeeded
        ? 'natural/live panel evidence still needed for live-running claim'
        : '',
      evidence: `${clean(localDrill.lane || 'local_drill', 120)} drilled ok`,
    };
  }
  if (support) {
    return {
      disposition: support,
      strength: 'support',
      remainingNeed: support.includes('script') ? 'manual invocation only unless wired into runtime' : '',
      evidence: 'path/usefulness indicates support, verification, UI, or static asset role',
    };
  }
  if (backlogFile || nonrouteFile) {
    return {
      disposition: 'pending_runtime_or_business_proof',
      strength: 'weak',
      remainingNeed: clean(nonrouteFile?.nextProof || backlogFile?.recommendedProofStrategy || 'runtime proof or support-only classification review', 220),
      evidence: clean(backlogFile?.priority || nonrouteFile?.priority || 'runtime-proof backlog', 80),
    };
  }
  if (proof === 'static_runtime_surface_unproven') {
    return {
      disposition: 'static_surface_needs_behavioral_check',
      strength: 'weak',
      remainingNeed: 'behavioral runtime probe or support-only classification',
      evidence: 'atlas found static runtime/route hints but no live behavior evidence',
    };
  }
  return {
    disposition: 'line_classified_support_needs_review',
    strength: 'weak',
    remainingNeed: 'confirm support-only role or add runtime probe',
    evidence: 'line/function atlas exists but no live/runtime disposition source matched',
  };
}

function buildDisposition({ atlas, backlog, authMatrix, nonroutePlan, localDrills, p0AuthorizedReadonly }) {
  const backlogMap = mapByFile(backlog.files);
  const authMap = mapByFile(authMatrix.files);
  const nonrouteMap = mapByFile(nonroutePlan.files);
  const drillMap = mapByFile(localDrills.files);
  const p0StillMissing = new Set(arr(p0AuthorizedReadonly?.summary?.p0FilesStillMissingBusinessProof));
  const files = arr(atlas.files).map((atlasFile) => {
    const file = atlasFile.file;
    const backlogFile = backlogMap.get(file);
    const authFile = authMap.get(file);
    const nonrouteFile = nonrouteMap.get(file);
    const localDrill = drillMap.get(file);
    const decision = dispositionFor({ atlasFile, backlogFile, authFile, nonrouteFile, localDrill });
    return {
      file,
      module: clean(atlasFile.module || '', 120),
      lines: Number(atlasFile.lines) || 0,
      usefulness: clean(atlasFile.usefulness || '', 120),
      runtimeProof: clean(atlasFile.runtime?.proof || '', 120),
      disposition: decision.disposition,
      strength: decision.strength,
      evidence: decision.evidence,
      remainingNeed: decision.remainingNeed,
      priority: clean(backlogFile?.priority || nonrouteFile?.priority || '', 20),
      lane: clean(localDrill?.lane || nonrouteFile?.lane || '', 120),
      ownerTokenNeeded: Boolean(nonrouteFile?.ownerTokenNeeded || p0StillMissing.has(file)),
      livePanelNeeded: Boolean(nonrouteFile?.livePanelNeeded),
      externalNetworkRisk: Boolean(nonrouteFile?.externalNetworkRisk),
      paidQuotaRisk: Boolean(nonrouteFile?.paidQuotaRisk),
      directTests: atlasFile.tests?.direct ?? authFile?.directTests ?? nonrouteFile?.directTests ?? null,
      testImporters: atlasFile.tests?.importers ?? authFile?.testImporters ?? nonrouteFile?.testImporters ?? null,
    };
  });
  const dispositionCounts = {};
  const strengthCounts = {};
  const byModule = new Map();
  for (const file of files) {
    inc(dispositionCounts, file.disposition);
    inc(strengthCounts, file.strength);
    if (!byModule.has(file.module)) {
      byModule.set(file.module, { module: file.module, files: 0, lines: 0, dispositionCounts: {}, strengthCounts: {} });
    }
    const module = byModule.get(file.module);
    module.files += 1;
    module.lines += file.lines;
    inc(module.dispositionCounts, file.disposition);
    inc(module.strengthCounts, file.strength);
  }
  const weakRuntimeFiles = files.filter((file) => file.strength === 'weak');
  const ownerOrLiveNeededFiles = files.filter((file) => file.ownerTokenNeeded || file.livePanelNeeded || file.externalNetworkRisk || file.paidQuotaRisk);
  return {
    files,
    summary: {
      files: files.length,
      lines: files.reduce((sum, file) => sum + file.lines, 0),
      atlasNotProvenLive: Number(atlas.summary?.filesNotProvenLive || 0),
      atlasStaticRuntimeSurfaceUnproven: Number(atlas.summary?.filesStaticRuntimeSurfaceUnproven || 0),
      backlogFiles: Number(backlog.summary?.backlogFiles || 0),
      liveAuthSurfaceFiles: Number(authMatrix.summary?.liveAuthSurfaceFiles || 0),
      localDrillOkFiles: Number(localDrills.summary?.okDrills || 0),
      dispositionCounts,
      strengthCounts,
      weakRuntimeFiles: weakRuntimeFiles.length,
      ownerOrLiveNeededFiles: ownerOrLiveNeededFiles.length,
      ownerTokenNeededFiles: files.filter((file) => file.ownerTokenNeeded).length,
      livePanelNeededFiles: files.filter((file) => file.livePanelNeeded).length,
      externalNetworkRiskFiles: files.filter((file) => file.externalNetworkRisk).length,
      paidQuotaRiskFiles: files.filter((file) => file.paidQuotaRisk).length,
      p0BusinessProofStillMissing: p0StillMissing.size,
    },
    byModule: [...byModule.values()]
      .sort((a, b) => b.lines - a.lines || b.files - a.files || a.module.localeCompare(b.module)),
  };
}

export function buildNoeNotProvenLiveDispositionAudit({
  paths = DEFAULT_PATHS,
  now = new Date(),
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const atlas = readJson(resolvedPaths.atlas);
  const backlog = readJson(resolvedPaths.backlog);
  const authMatrix = readJson(resolvedPaths.authMatrix);
  const nonroutePlan = readJson(resolvedPaths.nonroutePlan);
  const localDrills = readJson(resolvedPaths.localDrills);
  const p0AuthorizedReadonly = readJson(resolvedPaths.p0AuthorizedReadonly);
  const disposition = buildDisposition({ atlas, backlog, authMatrix, nonroutePlan, localDrills, p0AuthorizedReadonly });
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root: atlas.root || ROOT,
    inputs: Object.fromEntries(Object.entries(resolvedPaths).map(([key, path]) => [key, rel(path)])),
    policy: {
      readOnlyAudit: true,
      noDbReads: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noProtectedApiAuth: true,
      noModelCalls: true,
      noNetworkCalls: true,
      noSecretValuesReturned: true,
      noFileBodiesReturned: true,
    },
    status: {
      disposition: 'not_proven_live_broad_label_split',
      completionClaim: 'not_complete',
      explanation: 'The broad atlas not_proven_live/static labels are split into live runtime, auth-surface, local-drill, support-only, and still-pending proof categories. This does not claim every feature is naturally running.',
    },
    summary: disposition.summary,
    byModule: disposition.byModule,
    files: disposition.files.sort((a, b) => {
      const strengthOrder = { weak: 0, medium: 1, support: 2, strong: 3 };
      return (strengthOrder[a.strength] ?? 9) - (strengthOrder[b.strength] ?? 9)
        || (a.priority || 'P9').localeCompare(b.priority || 'P9')
        || b.lines - a.lines
        || a.file.localeCompare(b.file);
    }),
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function topCounts(counts = {}, max = 5) {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key, value]) => `${key}:${value}`)
    .join('<br>') || '-';
}

export function renderMarkdown(report, jsonPath = '') {
  const moduleRows = report.byModule.slice(0, 80).map((item) => [
    `\`${item.module}\``,
    String(item.files),
    String(item.lines),
    topCounts(item.dispositionCounts, 4),
    topCounts(item.strengthCounts, 4),
  ]);
  const pendingRows = report.files
    .filter((file) => file.strength === 'weak' || file.ownerTokenNeeded || file.livePanelNeeded || file.paidQuotaRisk)
    .slice(0, 160)
    .map((file) => [
      `\`${file.file}\``,
      file.priority || '-',
      file.disposition,
      file.strength,
      file.lane || '-',
      [
        file.ownerTokenNeeded ? 'owner-token' : '',
        file.livePanelNeeded ? 'live-panel' : '',
        file.externalNetworkRisk ? 'network' : '',
        file.paidQuotaRisk ? 'paid' : '',
      ].filter(Boolean).join(',') || '-',
      clean(file.remainingNeed || file.evidence, 180),
    ]);
  return [
    '# Noe Not-Proven-Live Disposition Audit',
    '',
    `Generated: ${report.generatedAt}`,
    '',
    '## Verdict',
    '',
    `- status: \`${report.status.disposition}\``,
    `- completion claim: \`${report.status.completionClaim}\``,
    `- explanation: ${report.status.explanation}`,
    '',
    '## Summary',
    '',
    `- atlas not_proven_live: ${report.summary.atlasNotProvenLive}; static runtime surface unproven: ${report.summary.atlasStaticRuntimeSurfaceUnproven}`,
    `- backlog files: ${report.summary.backlogFiles}; live auth-surface files: ${report.summary.liveAuthSurfaceFiles}; local drill ok files: ${report.summary.localDrillOkFiles}`,
    `- strength counts: ${topCounts(report.summary.strengthCounts, 8)}`,
    `- disposition counts: ${topCounts(report.summary.dispositionCounts, 12)}`,
    `- weak runtime files: ${report.summary.weakRuntimeFiles}; owner/live/risk files: ${report.summary.ownerOrLiveNeededFiles}; p0 business proof still missing: ${report.summary.p0BusinessProofStillMissing}`,
    '',
    '## By Module',
    '',
    mdTable([
      ['module', 'files', 'lines', 'dispositions', 'strengths'],
      ['---', '---:', '---:', '---', '---'],
      ...moduleRows,
    ]),
    '',
    '## Pending Or Decision-Gated Files',
    '',
    mdTable([
      ['file', 'priority', 'disposition', 'strength', 'lane', 'needs', 'remaining proof'],
      ['---', '---', '---', '---', '---', '---', '---'],
      ...pendingRows,
    ]),
    '',
    '## JSON',
    '',
    jsonPath ? `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.` : 'No JSON path supplied.',
  ].join('\n');
}

export function writeNoeNotProvenLiveDispositionAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildNoeNotProvenLiveDispositionAudit();
  const paths = writeNoeNotProvenLiveDispositionAudit(report);
  console.log(JSON.stringify({
    ok: report.ok,
    status: report.status.disposition,
    atlasNotProvenLive: report.summary.atlasNotProvenLive,
    atlasStaticRuntimeSurfaceUnproven: report.summary.atlasStaticRuntimeSurfaceUnproven,
    backlogFiles: report.summary.backlogFiles,
    liveAuthSurfaceFiles: report.summary.liveAuthSurfaceFiles,
    localDrillOkFiles: report.summary.localDrillOkFiles,
    weakRuntimeFiles: report.summary.weakRuntimeFiles,
    ownerOrLiveNeededFiles: report.summary.ownerOrLiveNeededFiles,
    p0BusinessProofStillMissing: report.summary.p0BusinessProofStillMissing,
    paths,
  }, null, 2));
}
