// @ts-check
// Read-only P7-H0 failure attribution summary for the mind/proof surface.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

function safeReadJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function walkFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

function latestJsonFile(dir, pred = () => true) {
  const files = walkFiles(dir)
    .filter(pred)
    .map((file) => {
      try { return { file, mtimeMs: statSync(file).mtimeMs }; } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const item of files) {
    const json = safeReadJson(item.file);
    if (json) return { file: item.file, json };
  }
  return { file: '', json: null };
}

function relPath(rootDir, file) {
  return file && file.startsWith(rootDir) ? relative(rootDir, file).replace(/\\/g, '/') : file || '';
}

export function compactFailureModes(rootDir) {
  const hit = latestJsonFile(join(rootDir, 'output', 'noe-failure-modes-attribution'), (f) => /\/report\.json$/.test(f) || /\/latest\.json$/.test(f));
  const report = hit.json || null;
  if (!report) return { enabled: false, ok: false, clusters: [] };
  const clusters = Array.isArray(report.failureModeClusters) ? report.failureModeClusters : [];
  return {
    enabled: true,
    ok: report.ok === true,
    generatedAt: report.generatedAtIso || '',
    reportPath: relPath(rootDir, hit.file),
    clusterCount: Number(report.summary?.clusterCount) || clusters.length,
    j0LiteGapSeedCount: Number(report.summary?.j0LiteGapSeedCount) || 0,
    blockers: Array.isArray(report.blockers) ? report.blockers.slice(0, 8) : [],
    warnings: Array.isArray(report.warnings) ? report.warnings.slice(0, 8) : [],
    clusters: clusters.slice(0, 5).map((c) => ({
      cluster: String(c.cluster || ''),
      count: Number(c.count) || 0,
      severity: String(c.severity || ''),
      derived: c.derived === true,
      origin: String(c.origin || ''),
      matchedEvidenceCount: Number(c.matchedEvidenceCount) || 0,
      seedId: String(c.suggestedGapSeed?.seedId || ''),
      readyForJ0Lite: c.suggestedGapSeed?.readyForJ0Lite === true,
      nextAction: String(c.recommendedNextAction || '').slice(0, 180),
      replayLevel: String(c.replaySafety?.level || ''),
    })),
  };
}
