#!/usr/bin/env node
// @ts-check
// P3 growth readiness proof: sleep-time reflection, dream consolidation,
// skill candidate extraction, automatic curriculum, and autonomy regression gate.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { close, initSqlite } from '../src/storage/SqliteStore.js';
import { MemoryCore } from '../src/memory/MemoryCore.js';
import { createNightlyReflection } from '../src/memory/NoeNightlyReflection.js';
import { createMemoryDreamLoop } from '../src/memory/NoeDreamConsolidation.js';
import { createSkillExtractor } from '../src/skills/SkillExtractor.js';
import { runSkillCurator } from '../src/skills/SkillCurator.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_GROWTH_READINESS_OUT_DIR
  ? resolve(process.env.NOE_GROWTH_READINESS_OUT_DIR)
  : join(ROOT, 'output', 'noe-growth-readiness');
const NOW = Date.now();
const RUN_ID = new Date(NOW).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const RUN_DIR = join(OUT_DIR, RUN_ID);
const DB_PATH = join(RUN_DIR, 'panel.db');
const REPORT_PATH = join(RUN_DIR, 'report.json');
const LATEST_PATH = join(OUT_DIR, 'latest.json');
const SKIP_SELF_EVOLUTION = process.env.NOE_GROWTH_READINESS_SKIP_SELF_EVOLUTION === '1';

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function latestNoe100() {
  const dir = join(ROOT, 'output', 'noe-100-readiness');
  try {
    const files = readdirSync(dir)
      .filter((name) => /^noe-100-readiness-\d+\.json$/.test(name))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    for (const file of files) {
      try { return { file, json: JSON.parse(readFileSync(file, 'utf8')) }; } catch {}
    }
  } catch {}
  return { file: '', json: null };
}

function buildCurriculum({ noe100 = null, skillCandidate = null } = {}) {
  const blockers = Array.isArray(noe100?.blockers) ? noe100.blockers : [];
  const tasks = [];
  if (blockers.includes('not_enough_soak_evidence')) {
    tasks.push({
      id: 'continue_7_day_soak',
      priority: 'P0-time',
      objective: 'Keep 51835 running until activeDays reaches 7, then rerun verify:noe:100-readiness.',
      evidenceRequired: ['noe_ticks', 'events active day coverage', 'Noe100 report'],
      replaySafe: true,
    });
  }
  tasks.push({
    id: 'daily_model_health_snapshot',
    priority: 'P2',
    objective: 'Run read-only model/provider health snapshot and compare loaded models without load/unload.',
    evidenceRequired: ['output/noe-model-health/*.json'],
    replaySafe: true,
  });
  tasks.push({
    id: 'skill_candidate_review',
    priority: 'P3',
    objective: `Review generated skill candidate ${skillCandidate?.name || '(none)'} before enabling it.`,
    evidenceRequired: ['skill candidate body', 'curator report'],
    replaySafe: true,
  });
  tasks.push({
    id: 'repeat_growth_readiness_proof',
    priority: 'P3',
    objective: 'Rerun growth readiness proof after new sleep, skill, or self-evolution changes.',
    evidenceRequired: ['output/noe-growth-readiness/*.json', 'verify:noe:self-evolution summary'],
    replaySafe: true,
  });
  return {
    schemaVersion: 1,
    source: 'deterministic gaps-to-curriculum planner',
    blockers,
    taskCount: tasks.length,
    tasks,
  };
}

async function runSleepAndSkillProof() {
  initSqlite(DB_PATH);
  const memory = new MemoryCore({ logger: null });
  memory.write({
    id: 'prior-insight',
    projectId: 'noe-growth',
    scope: 'insight',
    body: '我需要把恢复演练写成可审计证据，而不是只说机制可用。',
    sourceType: 'fixture',
    confidence: 0.5,
    salience: 3,
  });
  memory.write({ id: 'dup-a', projectId: 'noe-growth', body: 'Act failure drill should avoid duplicate side effects.', salience: 3 });
  memory.write({ id: 'dup-b', projectId: 'noe-growth', body: 'Act failure drill should avoid duplicate side effects.', salience: 4 });
  memory.write({ id: 'identity-protected', projectId: 'noe-growth', body: 'Noe belongs to the owner.', scope: 'identity', salience: 5 });

  const episodes = Array.from({ length: 6 }, (_, i) => ({
    id: `episode-${i}`,
    ts: NOW - 60_000 + i,
    type: 'interaction',
    summary: `P3 growth proof fixture ${i}: recovery evidence and skill reuse need durable reports.`,
    salience: 4,
  }));
  const reflection = createNightlyReflection({
    timeline: { recent: () => episodes },
    memory,
    getAdapter: () => ({
      chat: async () => ({
        reply: JSON.stringify({
          new: [{
            text: '我会把成长能力转成可复跑报告，而不是只写愿景。',
            kind: 'lesson',
            confidence: 0.72,
          }],
          reviews: [{ id: 'prior-insight', verdict: 'confirmed' }],
        }),
      }),
    }),
    phaseOf: () => 'night',
    now: () => NOW,
    projectId: 'noe-growth',
  });
  const reflectionOut = await reflection.refresh({ force: true });
  const dreamLoop = createMemoryDreamLoop(memory, { projectId: 'noe-growth', enabled: false });
  const dreamOut = await dreamLoop.tick();

  const savedSkills = [];
  const store = {
    get: () => null,
    upsert: (skill) => {
      const saved = { ...skill, enabled: false };
      savedSkills.push(saved);
      return saved;
    },
  };
  const extractor = createSkillExtractor({
    store,
    chat: async () => ({
      reply: JSON.stringify({
        name: 'noe-recovery-evidence-drill',
        displayName: 'Noe Recovery Evidence Drill',
        description: 'Use when a Noe recovery mechanism must be proved with a repeatable report.',
        body: [
          '# Recovery Evidence Drill',
          '1. Isolate state unless live behavior is the target.',
          '2. Record before/after status, checkpoint, evidence refs, and rollback policy.',
          '3. Rerun the readiness gate and keep blockers honest.',
        ].join('\n'),
        confidence: 0.86,
      }),
    }),
  });
  const extraction = await extractor.extract([
    { role: 'user', content: 'We need repeatable recovery evidence.' },
    { role: 'assistant', content: 'I will produce a drill report and readiness evidence.' },
    { role: 'user', content: 'Make it reusable as a skill candidate.' },
  ]);
  const curator = runSkillCurator({
    now: new Date(NOW),
    dryRun: true,
    skills: [
      {
        name: extraction.skill?.name || savedSkills[0]?.name || 'noe-recovery-evidence-drill',
        displayName: extraction.skill?.displayName || savedSkills[0]?.displayName || 'Noe Recovery Evidence Drill',
        description: extraction.skill?.description || savedSkills[0]?.description || '',
        updatedAt: new Date(NOW).toISOString(),
      },
      { name: 'old-growth-fixture', updatedAt: '2026-01-01T00:00:00.000Z' },
    ],
  });
  const priorAfter = memory.get('prior-insight', { includeHidden: true });
  const dupA = memory.get('dup-a', { includeHidden: true });
  const dupB = memory.get('dup-b', { includeHidden: true });
  const identity = memory.get('identity-protected', { includeHidden: true });

  return {
    sleepPipeline: {
      ok: Boolean(reflectionOut.reflected === true && reflectionOut.written >= 1 && reflectionOut.reviewed >= 1),
      reflection: reflectionOut,
      priorInsightConfidenceAfter: priorAfter?.confidence ?? null,
      dreamConsolidation: dreamOut,
      duplicateMerged: Boolean(dupA?.hidden === true || dupB?.hidden === true),
      identityProtected: identity?.hidden !== true && identity?.salience === 5,
    },
    skillLibrary: {
      ok: Boolean(extraction.extracted === true && savedSkills.length === 1 && savedSkills[0]?.enabled === false),
      extraction,
      savedCount: savedSkills.length,
      savedSkill: savedSkills[0] || null,
      curator,
    },
  };
}

function runSelfEvolutionGate() {
  if (SKIP_SELF_EVOLUTION) {
    return { ok: true, skipped: true, reason: 'NOE_GROWTH_READINESS_SKIP_SELF_EVOLUTION=1' };
  }
  const out = spawnSync(process.execPath, ['scripts/noe-self-evolution-plan-verify.mjs'], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let parsed = null;
  try {
    const match = String(out.stdout || '').match(/\{\s*"ok"\s*:\s*(?:true|false)[\s\S]*?\}\s*$/);
    parsed = JSON.parse(match ? match[0] : out.stdout || '{}');
  } catch {}
  return {
    ok: out.status === 0 && parsed?.ok === true,
    skipped: false,
    exitCode: out.status,
    stdoutReturned: Boolean(out.stdout),
    stderr: String(out.stderr || '').slice(0, 2000),
    summary: parsed ? {
      ok: parsed.ok === true,
      passed: parsed.passed,
      total: parsed.total,
      failed: parsed.failed,
    } : null,
  };
}

mkdirSync(RUN_DIR, { recursive: true, mode: 0o700 });

let report = null;
try {
  const growthProof = await runSleepAndSkillProof();
  const latest = latestNoe100();
  const curriculum = buildCurriculum({
    noe100: latest.json,
    skillCandidate: growthProof.skillLibrary.savedSkill,
  });
  const selfEvolution = runSelfEvolutionGate();
  report = {
    schemaVersion: 1,
    ok: Boolean(
      growthProof.sleepPipeline.ok
      && growthProof.skillLibrary.ok
      && curriculum.taskCount >= 3
      && selfEvolution.ok
    ),
    generatedAt: new Date(NOW).toISOString(),
    scenario: 'p3_growth_readiness',
    liveDbMutated: false,
    isolatedDbPath: rel(DB_PATH),
    sleepPipeline: growthProof.sleepPipeline,
    skillLibrary: growthProof.skillLibrary,
    automaticCurriculum: curriculum,
    autonomyRegressionGate: selfEvolution,
    evidenceRefs: [
      latest.file ? { file: rel(latest.file), note: 'latest Noe100 readiness report' } : null,
      { file: rel(DB_PATH), note: 'isolated sleep/dream proof DB' },
      { file: 'scripts/noe-self-evolution-plan-verify.mjs', note: 'autonomy regression verifier' },
    ].filter(Boolean),
    source: {
      policy: 'isolated P3 proof; fake reflection adapter; no external model calls; no live DB mutation; no LM Studio load/unload',
      reportPath: rel(REPORT_PATH),
    },
    reportPath: rel(REPORT_PATH),
  };
} catch (e) {
  report = {
    schemaVersion: 1,
    ok: false,
    generatedAt: new Date(NOW).toISOString(),
    scenario: 'p3_growth_readiness',
    liveDbMutated: false,
    isolatedDbPath: rel(DB_PATH),
    error: e?.stack || e?.message || String(e),
    reportPath: rel(REPORT_PATH),
  };
} finally {
  try { close(); } catch {}
}

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), { mode: 0o600 });
writeFileSync(LATEST_PATH, JSON.stringify(report, null, 2), { mode: 0o600 });
const persisted = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
console.log(JSON.stringify({ ...persisted, latestPath: rel(LATEST_PATH) }, null, 2));
if (!persisted.ok) process.exitCode = 1;
