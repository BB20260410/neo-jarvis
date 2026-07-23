#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReadinessReport as createObsidianReadinessReport } from './obsidian-mcp-readiness.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-external-readiness');
const EVIDENCE_DIR = join(ROOT, 'output', 'noe-external-evidence');
const REPORT = join(OUT_DIR, `external-readiness-${Date.now()}.json`);
const DEFAULT_VOICE_EVIDENCE = join(EVIDENCE_DIR, 'real-voice-e2e.json');
const DEFAULT_SAFE_DELEGATE_EVIDENCE = join(EVIDENCE_DIR, 'delegate-confirm-idle.json');
const DEFAULT_DELEGATE_EVIDENCE = join(EVIDENCE_DIR, 'real-delegate-start.json');
const FIGURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.pdf', '.heic']);

function parseArgs(argv, env = process.env) {
  const out = {
    figurePath: env.NOE_FIGURE_ONE_PATH || '',
    voiceEvidence: env.NOE_REAL_VOICE_E2E_EVIDENCE || '',
    safeDelegateEvidence: env.NOE_SAFE_DELEGATE_CONFIRM_EVIDENCE || '',
    delegateEvidence: env.NOE_REAL_DELEGATE_START_EVIDENCE || '',
    writeReport: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--figure-one') out.figurePath = argv[++i] || '';
    else if (arg.startsWith('--figure-one=')) out.figurePath = arg.slice('--figure-one='.length);
    else if (arg === '--voice-evidence') out.voiceEvidence = argv[++i] || '';
    else if (arg.startsWith('--voice-evidence=')) out.voiceEvidence = arg.slice('--voice-evidence='.length);
    else if (arg === '--safe-delegate-evidence') out.safeDelegateEvidence = argv[++i] || '';
    else if (arg.startsWith('--safe-delegate-evidence=')) out.safeDelegateEvidence = arg.slice('--safe-delegate-evidence='.length);
    else if (arg === '--delegate-evidence') out.delegateEvidence = argv[++i] || '';
    else if (arg.startsWith('--delegate-evidence=')) out.delegateEvidence = arg.slice('--delegate-evidence='.length);
    else if (arg === '--no-write') out.writeReport = false;
  }
  return out;
}

function redact(value) {
  return String(value || '')
    .replace(/\?t=[0-9a-f]{32,}/gi, '?t=[redacted]')
    .replace(/(Authorization:\s*Bearer\s+)(?!<api-key>)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(/(X-Panel-Owner-Token["':\s]+)[0-9a-f]{32,}/gi, '$1[redacted]');
}

function fileEvidence(pathValue) {
  const value = String(pathValue || '').trim();
  return {
    provided: Boolean(value),
    path: redact(value),
    exists: Boolean(value) && existsSync(value),
  };
}

function readJsonEvidence(pathValue) {
  if (!pathValue || !existsSync(pathValue)) return { ok: false, data: null, error: 'file_missing' };
  try {
    return { ok: true, data: JSON.parse(readFileSync(pathValue, 'utf8')) };
  } catch (e) {
    return { ok: false, data: null, error: `invalid_json:${String(e?.message || e).slice(0, 120)}` };
  }
}

function jsonEvidence(pathValue, expectedKind, { requiredFields = [], requiredAny = [] } = {}) {
  const base = fileEvidence(pathValue);
  const parsed = readJsonEvidence(pathValue);
  const data = parsed.data || {};
  const present = (field) => data[field] === true || (data[field] !== false && data[field] != null && data[field] !== '');
  const missingFields = requiredFields.filter((field) => !present(field));
  const missingAny = requiredAny.filter((fields) => !fields.some(present));
  const valid = parsed.ok && data.ok === true && data.kind === expectedKind
    && missingFields.length === 0 && missingAny.length === 0;
  return {
    ...base,
    valid,
    expectedKind,
    kind: typeof data.kind === 'string' ? data.kind : '',
    okField: data.ok === true,
    missingFields,
    missingAny,
    error: parsed.ok ? '' : parsed.error,
  };
}

function delegateConfirmEvidence(pathValue) {
  const base = fileEvidence(pathValue);
  const parsed = readJsonEvidence(pathValue);
  const data = parsed.data || {};
  const valid = parsed.ok && data.ok === true && data.kind === 'delegate_confirm_idle'
    && Boolean(data.roomId) && data.roomStatus === 'idle' && data.started === false && data.queued === false;
  return {
    ...base,
    valid,
    expectedKind: 'delegate_confirm_idle',
    kind: typeof data.kind === 'string' ? data.kind : '',
    okField: data.ok === true,
    roomStatus: data.roomStatus || '',
    started: data.started ?? null,
    queued: data.queued ?? null,
    hasRoomId: Boolean(data.roomId),
    error: parsed.ok ? '' : parsed.error,
  };
}

function mediaEvidence(pathValue) {
  const base = fileEvidence(pathValue);
  const ext = extname(String(pathValue || '').split('?')[0]).toLowerCase();
  return {
    ...base,
    valid: base.exists && FIGURE_EXTENSIONS.has(ext),
    extension: ext,
    allowedExtensions: [...FIGURE_EXTENSIONS],
  };
}

function findDefaultFigurePath(dir = EVIDENCE_DIR) {
  try {
    return readdirSync(dir)
      .filter((name) => /^figure-one\./i.test(name) && FIGURE_EXTENSIONS.has(extname(name).toLowerCase()))
      .map((name) => join(dir, name))
      .sort()[0] || '';
  } catch {
    return '';
  }
}

function withDefaultEvidencePaths(args) {
  return {
    ...args,
    voiceEvidence: args.voiceEvidence || DEFAULT_VOICE_EVIDENCE,
    safeDelegateEvidence: args.safeDelegateEvidence || DEFAULT_SAFE_DELEGATE_EVIDENCE,
    delegateEvidence: args.delegateEvidence || DEFAULT_DELEGATE_EVIDENCE,
    figurePath: args.figurePath || findDefaultFigurePath() || join(EVIDENCE_DIR, 'figure-one.png'),
  };
}

function check(id, ok, evidence, nextActions) {
  return {
    id,
    ok: Boolean(ok),
    status: ok ? 'passed' : 'external_blocked',
    evidence,
    nextActions: ok ? [] : nextActions,
  };
}

export function buildExternalReadinessReport({
  obsidianReport,
  figurePath = '',
  voiceEvidence = '',
  safeDelegateEvidence = '',
  delegateEvidence = '',
  checkedAt = new Date().toISOString(),
} = {}) {
  const figure = mediaEvidence(figurePath);
  const voice = jsonEvidence(voiceEvidence, 'real_voice_e2e', { requiredFields: ['transcript', 'reply'] });
  const safeDelegate = delegateConfirmEvidence(safeDelegateEvidence);
  const delegate = jsonEvidence(delegateEvidence, 'real_delegate_start', {
    requiredAny: [['roomId', 'jobId', 'runId'], ['startedAt', 'started']],
  });
  const checks = [
    check('obsidian_mcp_ready', obsidianReport?.ok, {
      source: 'scripts/obsidian-mcp-readiness.mjs',
      ok: Boolean(obsidianReport?.ok),
      mode: obsidianReport?.mode || 'read_only',
      recommendedPath: obsidianReport?.recommendedPath,
    }, obsidianReport?.nextActions?.length ? obsidianReport.nextActions : [
      'Prepare a real Obsidian vault, enable Local REST API, provide the API key, and register the Noe MCP endpoint.',
    ]),
    check('real_voice_e2e_verified', voice.valid, voice, [
      'Open cognitive.html, speak one real command, then save JSON evidence to output/noe-external-evidence/real-voice-e2e.json or pass --voice-evidence <path>. Required: ok=true, kind=real_voice_e2e, transcript, reply.',
    ]),
    check('safe_delegate_confirm_verified', safeDelegate.valid, safeDelegate, [
      'Run npm run verify:noe:capture-evidence to create isolated safe delegate evidence. Required: ok=true, kind=delegate_confirm_idle, roomId, roomStatus=idle, started=false, queued=false.',
    ]),
    check('real_delegate_start_verified', delegate.valid, delegate, [
      'Approve one real Noe delegation start, then save JSON evidence to output/noe-external-evidence/real-delegate-start.json or pass --delegate-evidence <path>. Required: ok=true, kind=real_delegate_start, one run id, and started/start time.',
    ]),
    check('figure_one_available', figure.valid, figure, [
      'Put “图一” at output/noe-external-evidence/figure-one.png or pass --figure-one <path>. Allowed: png/jpg/jpeg/webp/gif/pdf/heic.',
    ]),
  ];

  return {
    ok: checks.every((c) => c.ok),
    mode: 'read_only',
    checkedAt,
    checks,
    externalBlocked: checks.filter((c) => !c.ok).map((c) => c.id),
    nextActions: checks.flatMap((c) => c.nextActions),
    note: 'This verifier does not create keys, start child LLM agents, or infer missing image evidence. The safe delegate check only proves confirm creates an idle room.',
  };
}

function printSummary(report) {
  for (const item of report.checks) {
    console.log(`${item.ok ? 'PASS' : 'WAIT'} ${item.id} (${item.status})`);
  }
}

async function main() {
  const args = withDefaultEvidencePaths(parseArgs(process.argv.slice(2)));
  const obsidianReport = await createObsidianReadinessReport();
  const report = buildExternalReadinessReport({ obsidianReport, ...args });
  printSummary(report);
  if (args.writeReport) {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(REPORT, JSON.stringify(report, null, 2));
    console.log(`report=${REPORT}`);
  }
  if (!report.ok) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(REPORT, JSON.stringify({ ok: false, mode: 'read_only', error: e?.message || String(e) }, null, 2));
    console.error(e?.stack || e?.message || e);
    console.error(`report=${REPORT}`);
    process.exit(1);
  });
}

export { delegateConfirmEvidence, fileEvidence, findDefaultFigurePath, jsonEvidence, mediaEvidence, parseArgs, redact, withDefaultEvidencePaths };
