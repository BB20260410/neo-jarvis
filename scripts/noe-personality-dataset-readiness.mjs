#!/usr/bin/env node
// @ts-check
// P3 personality dataset readiness: read-only audit for SFT/LoRA data maturity.
// It never trains, never calls models, never exports dataset text, and never
// changes LM Studio loaded models.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SENSITIVE, sftFileChannel } from '../src/memory/NoeSftHarvester.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOME = homedir();
const NOW = Date.now();
const OUT_DIR = join(ROOT, 'output', 'noe-personality-dataset-readiness');
const SFT_DIR = process.env.NOE_SFT_DIR || join(HOME, '.noe-panel', 'sft');
const DB_PATH = process.env.PANEL_DB_PATH || join(HOME, '.noe-panel', 'panel.db');
const OWNER_IDENTITY_FILE = process.env.NOE_OWNER_IDENTITY_FILE || join(HOME, '.noe-panel', 'owner-identity.json');
const PEOPLE_FILE = process.env.NOE_PEOPLE_KNOWLEDGE_FILE || join(HOME, '.noe-panel', 'people-knowledge.json');
const PERSONALITY_FILE = process.env.NOE_PERSONALITY_SNAPSHOT_FILE || join(HOME, '.noe-panel', 'personality-snapshot.json');
const NARRATIVE_FILE = process.env.NOE_NARRATIVE_SELF_FILE || join(HOME, '.noe-panel', 'narrative-self.json');
const LORA_VENV_PY = process.env.NOE_LORA_VENV_PY || join(HOME, '.noe-panel', 'lora-venv', 'bin', 'python');
const LORA_ROOT = process.env.NOE_LORA_ROOT || join(HOME, '.noe-panel', 'lora');
const MIN_PAIRS = Number(process.env.NOE_PERSONALITY_MIN_PAIRS || 500);
const SMOKE_MIN_PAIRS = Number(process.env.NOE_PERSONALITY_SMOKE_MIN_PAIRS || 20);
const OWNER_APPROVED = process.env.NOE_PERSONALITY_TRAINING_APPROVED === '1';

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function ageDays(file, now = NOW) {
  try { return Math.round(((now - statSync(file).mtimeMs) / 86_400_000) * 100) / 100; } catch { return null; }
}

function countLines(file) {
  try { return readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

export function scanSftDir({ sftDir = SFT_DIR } = {}) {
  const files = existsSync(sftDir)
    ? readdirSync(sftDir).filter((name) => name.endsWith('.jsonl')).sort()
    : [];
  let totalLines = 0;
  // P0-①（三方审）：顶层 validPairs 是「人格 SFT 成熟度」口径——只计 persona 通道，
  // 否则项目复盘留档会把人格训练量算虚高，formal-training 门槛形同放水。project 单列计数。
  let validPairs = 0;          // = personaValidPairs（formal-training 对账口径）
  let projectValidPairs = 0;   // 工程留档有效对（不进人格 SFT）
  let invalidPairs = 0;        // 全通道（坏行无论 persona/project 都是 blocker）
  let sensitivePairs = 0;      // 全通道（敏感无论落哪个文件都是 blocker）
  let totalAssistantChars = 0; // 仅 persona（与 validPairs 同口径算均长）
  const assistantHashes = new Set(); // 仅 persona（去重统计对人格语料才有意义）
  const byFile = [];
  for (const file of files) {
    const channel = sftFileChannel(file);
    const abs = join(sftDir, file);
    let fileValid = 0;
    let fileInvalid = 0;
    let fileSensitive = 0;
    for (const line of countLines(abs)) {
      totalLines += 1;
      let parsed = null;
      try { parsed = JSON.parse(line); } catch {
        invalidPairs += 1;
        fileInvalid += 1;
        continue;
      }
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const assistant = messages.findLast?.((m) => m?.role === 'assistant') || messages[messages.length - 1] || null;
      const assistantText = String(assistant?.content || '');
      const valid = messages.length >= 3 && typeof assistant?.content === 'string' && assistantText.trim().length >= 10;
      if (!valid) {
        invalidPairs += 1;
        fileInvalid += 1;
        continue;
      }
      if (SENSITIVE.test(JSON.stringify(parsed))) {
        sensitivePairs += 1;
        fileSensitive += 1;
      }
      fileValid += 1;
      // 行级再保险：persona 文件里若混入 split==='project' 行，归 project 计数（与 train 行级剔除同口径）。
      if (channel === 'project' || parsed?.split === 'project') {
        projectValidPairs += 1;
      } else {
        validPairs += 1;
        totalAssistantChars += assistantText.trim().length;
        assistantHashes.add(assistantText.replace(/\s+/g, ' ').trim());
      }
    }
    byFile.push({
      file,
      channel,
      validPairs: fileValid,
      invalidPairs: fileInvalid,
      sensitivePairs: fileSensitive,
      mtimeAgeDays: ageDays(abs),
    });
  }
  return {
    exists: existsSync(sftDir),
    dir: sftDir,
    fileCount: files.length,
    totalLines,
    validPairs,
    // P0-①：persona/project 分项（personaValidPairs 与 validPairs 同值，显式命名供报告/对账无歧义）。
    personaValidPairs: validPairs,
    projectValidPairs,
    invalidPairs,
    sensitivePairs,
    uniqueAssistantPairs: assistantHashes.size,
    duplicateAssistantPairs: Math.max(0, validPairs - assistantHashes.size),
    avgAssistantChars: validPairs ? Math.round(totalAssistantChars / validPairs) : 0,
    byFile,
  };
}

export function summarizeIdentity({
  ownerFile = OWNER_IDENTITY_FILE,
  peopleFile = PEOPLE_FILE,
  personalityFile = PERSONALITY_FILE,
  narrativeFile = NARRATIVE_FILE,
  now = NOW,
} = {}) {
  const owner = readJson(ownerFile);
  const people = readJson(peopleFile);
  const personality = readJson(personalityFile);
  const narrative = readJson(narrativeFile);
  const peopleRows = Array.isArray(people?.people) ? people.people : [];
  return {
    ownerIdentity: {
      exists: Boolean(owner),
      voice: {
        enabled: owner?.voice?.enabled === true,
        samples: Array.isArray(owner?.voice?.samples) ? owner.voice.samples.length : 0,
        ready: (Array.isArray(owner?.voice?.samples) ? owner.voice.samples.length : 0) >= 3 || Boolean(owner?.voice?.ownerPersonId),
        ownerPersonBound: Boolean(owner?.voice?.ownerPersonId),
      },
      face: {
        enabled: owner?.face?.enabled === true,
        samples: Array.isArray(owner?.face?.samples) ? owner.face.samples.length : 0,
        ready: (Array.isArray(owner?.face?.samples) ? owner.face.samples.length : 0) >= 1 || Boolean(owner?.face?.ownerPersonId),
        ownerPersonBound: Boolean(owner?.face?.ownerPersonId),
      },
      mtimeAgeDays: owner ? ageDays(ownerFile, now) : null,
    },
    peopleKnowledge: {
      exists: Boolean(people),
      people: peopleRows.length,
      faceReadyPeople: peopleRows.filter((p) => Array.isArray(p?.faceSamples) && p.faceSamples.length >= 1).length,
      voiceReadyPeople: peopleRows.filter((p) => Array.isArray(p?.voiceSamples) && p.voiceSamples.length >= 3).length,
      mtimeAgeDays: people ? ageDays(peopleFile, now) : null,
    },
    personalitySnapshot: {
      exists: typeof personality?.personality === 'string' && personality.personality.trim().length >= 10,
      chars: typeof personality?.personality === 'string' ? personality.personality.trim().length : 0,
      atMs: Number(personality?.atMs || 0) || null,
      ageDays: Number(personality?.atMs || 0) ? Math.round(((now - Number(personality.atMs)) / 86_400_000) * 100) / 100 : null,
    },
    narrativeSelf: {
      exists: typeof narrative?.narrative === 'string' && narrative.narrative.trim().length >= 10,
      chars: typeof narrative?.narrative === 'string' ? narrative.narrative.trim().length : 0,
      atMs: Number(narrative?.atMs || 0) || null,
      ageDays: Number(narrative?.atMs || 0) ? Math.round(((now - Number(narrative.atMs)) / 86_400_000) * 100) / 100 : null,
    },
  };
}

function scalar(db, sql, params = []) {
  try { return db.prepare(sql).get(...params); } catch { return null; }
}

function byRows(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

export async function summarizeLiveDb({ dbPath = DB_PATH, now = NOW } = {}) {
  if (!existsSync(dbPath)) return { exists: false, dbPath, memory: {}, events: {} };
  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  try {
    const memory = scalar(db, `
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN hidden = 0 THEN 1 ELSE 0 END) AS visible,
        SUM(CASE WHEN hidden = 0 AND scope = 'insight' THEN 1 ELSE 0 END) AS insight,
        SUM(CASE WHEN hidden = 0 AND scope = 'fact' THEN 1 ELSE 0 END) AS fact,
        SUM(CASE WHEN hidden = 0 AND salience >= 4 THEN 1 ELSE 0 END) AS highSalience,
        SUM(CASE WHEN hidden = 0 AND source_episode_id IS NOT NULL AND source_episode_id != '' THEN 1 ELSE 0 END) AS sourceLinked,
        AVG(CASE WHEN hidden = 0 THEN confidence ELSE NULL END) AS avgConfidence
      FROM noe_memory
    `) || {};
    const memoryByScope = byRows(db, 'SELECT scope, COUNT(*) AS n FROM noe_memory WHERE hidden = 0 GROUP BY scope ORDER BY n DESC LIMIT 20');
    const events = scalar(db, `
      SELECT
        COUNT(*) AS totalEpisodes,
        SUM(CASE WHEN tag = 'inner_monologue' OR json_extract(payload,'$.episodeType') = 'inner_monologue' THEN 1 ELSE 0 END) AS innerMonologue,
        SUM(CASE WHEN tag = 'interaction' OR json_extract(payload,'$.episodeType') = 'interaction' THEN 1 ELSE 0 END) AS interaction,
        SUM(CASE WHEN tag = 'milestone' OR json_extract(payload,'$.episodeType') = 'milestone' THEN 1 ELSE 0 END) AS milestone,
        COUNT(DISTINCT substr(datetime(ts / 1000, 'unixepoch'), 1, 10)) AS activeDays
      FROM events
      WHERE kind = 'noe_episode'
    `) || {};
    const recentInner = scalar(db, `
      SELECT COUNT(*) AS n, MAX(ts) AS lastTs
      FROM events
      WHERE kind = 'noe_episode'
        AND (tag = 'inner_monologue' OR json_extract(payload,'$.episodeType') = 'inner_monologue')
        AND ts >= ?
    `, [now - 7 * 86_400_000]) || {};
    return {
      exists: true,
      dbPath,
      memory: {
        total: Number(memory.total || 0),
        visible: Number(memory.visible || 0),
        insight: Number(memory.insight || 0),
        fact: Number(memory.fact || 0),
        highSalience: Number(memory.highSalience || 0),
        sourceLinked: Number(memory.sourceLinked || 0),
        avgConfidence: Number.isFinite(Number(memory.avgConfidence)) ? Math.round(Number(memory.avgConfidence) * 1000) / 1000 : null,
        byScope: memoryByScope.map((r) => ({ scope: r.scope, count: Number(r.n || 0) })),
      },
      events: {
        totalEpisodes: Number(events.totalEpisodes || 0),
        innerMonologue: Number(events.innerMonologue || 0),
        interaction: Number(events.interaction || 0),
        milestone: Number(events.milestone || 0),
        activeDays: Number(events.activeDays || 0),
        innerMonologue7d: Number(recentInner.n || 0),
        lastInnerMonologueTs: Number(recentInner.lastTs || 0) || null,
      },
    };
  } finally {
    try { db.close(); } catch {}
  }
}

export function latestGateReport({ loraRoot = LORA_ROOT } = {}) {
  if (!existsSync(loraRoot)) return { exists: false, reportPath: '', pass: false };
  const files = readdirSync(loraRoot)
    .filter((name) => /^gate-report-.+\.json$/.test(name))
    .map((name) => join(loraRoot, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of files) {
    const json = readJson(file);
    if (json) return {
      exists: true,
      reportPath: file,
      pass: json.pass === true,
      failed: Number(json.failed || 0),
      adapterPresent: typeof json.adapter === 'string' && existsSync(json.adapter),
      mtimeAgeDays: ageDays(file),
    };
  }
  return { exists: false, reportPath: '', pass: false };
}

export function buildPersonalityDatasetReadiness({
  now = NOW,
  sft = scanSftDir(),
  identity = summarizeIdentity({ now }),
  liveDb = null,
  gate = latestGateReport(),
  minPairs = MIN_PAIRS,
  smokeMinPairs = SMOKE_MIN_PAIRS,
  trainScriptExists = existsSync(join(ROOT, 'scripts', 'noe-lora-train.mjs')),
  gateScriptExists = existsSync(join(ROOT, 'scripts', 'noe-lora-gate.mjs')),
  loraVenvExists = existsSync(LORA_VENV_PY),
  ownerApproved = OWNER_APPROVED,
} = {}) {
  const blockers = [];
  const warnings = [];
  if (!sft.exists) blockers.push('sft_dir_missing');
  if (Number(sft.validPairs || 0) < smokeMinPairs) blockers.push('not_enough_sft_pairs_for_smoke');
  if (Number(sft.validPairs || 0) < minPairs) blockers.push('not_enough_sft_pairs_for_formal_training');
  if (Number(sft.invalidPairs || 0) > 0) blockers.push('invalid_sft_pairs_present');
  if (Number(sft.sensitivePairs || 0) > 0) blockers.push('sensitive_sft_pairs_present');
  if (!trainScriptExists) blockers.push('lora_train_script_missing');
  if (!gateScriptExists) blockers.push('lora_gate_script_missing');
  if (!loraVenvExists) blockers.push('lora_venv_missing');
  if (!ownerApproved) blockers.push('owner_training_plan_required');
  if (!gate.pass) warnings.push('no_passed_lora_gate_report');
  if (!identity.personalitySnapshot.exists) warnings.push('personality_snapshot_missing_or_short');
  if (!identity.narrativeSelf.exists) warnings.push('narrative_self_missing_or_short');
  if (liveDb?.events?.activeDays < 7) warnings.push('low_active_day_coverage_for_personality_training');
  const sensitiveClean = Number(sft.sensitivePairs || 0) === 0 && Number(sft.invalidPairs || 0) === 0;
  const smokeDatasetReady = Number(sft.validPairs || 0) >= smokeMinPairs && sensitiveClean;
  const formalDatasetReady = Number(sft.validPairs || 0) >= minPairs && sensitiveClean;
  const toolingReady = Boolean(trainScriptExists && gateScriptExists && loraVenvExists);
  const readyForFormalTraining = formalDatasetReady && toolingReady && ownerApproved;
  const readyForAdoption = readyForFormalTraining && gate.pass === true && gate.adapterPresent === true;
  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    policy: {
      readOnly: true,
      noTrainingStarted: true,
      noModelCalls: true,
      noDatasetTextOutput: true,
      lmStudioLoadUnloadChanged: false,
      secretValuesReturned: false,
    },
    thresholds: {
      smokeMinPairs,
      formalMinPairs: minPairs,
    },
    status: {
      smokeDatasetReady,
      formalDatasetReady,
      toolingReady,
      ownerApproved,
      readyForFormalTraining,
      readyForAdoption,
      blockers,
      warnings,
    },
    sft: {
      dir: sft.dir,
      exists: sft.exists,
      fileCount: sft.fileCount,
      totalLines: sft.totalLines,
      // P0-①：validPairs = persona 通道（人格 SFT 成熟度口径）；project 留档单列，不计入人格门槛。
      validPairs: sft.validPairs,
      personaValidPairs: sft.personaValidPairs ?? sft.validPairs,
      projectValidPairs: sft.projectValidPairs ?? 0,
      invalidPairs: sft.invalidPairs,
      sensitivePairs: sft.sensitivePairs,
      uniqueAssistantPairs: sft.uniqueAssistantPairs,
      duplicateAssistantPairs: sft.duplicateAssistantPairs,
      avgAssistantChars: sft.avgAssistantChars,
      byFile: sft.byFile,
    },
    liveDb,
    identity,
    tooling: {
      trainScriptExists,
      gateScriptExists,
      loraVenvExists,
      loraVenvPath: LORA_VENV_PY,
      latestGateReport: {
        exists: gate.exists,
        reportPath: gate.reportPath,
        pass: gate.pass,
        failed: gate.failed,
        adapterPresent: gate.adapterPresent,
        mtimeAgeDays: gate.mtimeAgeDays,
      },
    },
    evidenceRefs: [
      { file: sft.dir, note: 'SFT JSONL dataset directory; content not exported' },
      { file: DB_PATH, note: 'SQLite memory and episode counts; read-only' },
      { file: OWNER_IDENTITY_FILE, note: 'owner identity sample counts only' },
      { file: PEOPLE_FILE, note: 'people profile counts only' },
      { file: 'src/memory/NoeSftHarvester.js', note: 'SFT harvester sensitive filter and pair builder' },
      { file: 'scripts/noe-lora-train.mjs', note: 'formal training threshold and local train pipeline' },
      { file: 'scripts/noe-lora-gate.mjs', note: 'post-train personality regression gate' },
    ],
  };
}

export function writeReport(report, { outDir = OUT_DIR } = {}) {
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const reportPath = join(outDir, `personality-dataset-readiness-${Date.now()}.json`);
  const latestPath = join(outDir, 'latest.json');
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(reportPath, body, { mode: 0o600 });
  writeFileSync(latestPath, body, { mode: 0o600 });
  return { reportPath: rel(reportPath), latestPath: rel(latestPath) };
}

export async function main() {
  const liveDb = await summarizeLiveDb();
  const report = buildPersonalityDatasetReadiness({ liveDb });
  const paths = writeReport(report);
  console.log(JSON.stringify({ ...report, ...paths }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => {
    console.error(e?.stack || e?.message || String(e));
    process.exit(1);
  });
}
