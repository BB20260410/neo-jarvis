#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EVIDENCE_DIR = join(ROOT, 'output', 'noe-external-evidence');
const REPORT = join(EVIDENCE_DIR, `capture-report-${Date.now()}.json`);
const DEFAULT_BASE = 'http://127.0.0.1:51835';
const DEFAULT_WHISPER = 'http://127.0.0.1:8123';

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.NOE_PANEL_URL || DEFAULT_BASE,
    whisperUrl: process.env.NOE_WHISPER_URL || DEFAULT_WHISPER,
    voiceText: process.env.NOE_EVIDENCE_VOICE_TEXT || '帮我查最新 AI 新闻',
    skipVoice: false,
    skipDelegate: false,
    explicitAckReadOwnerToken: process.env.NOE_ACK_READ_OWNER_TOKEN === '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') out.baseUrl = argv[++i] || out.baseUrl;
    else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice('--base-url='.length);
    else if (arg === '--whisper-url') out.whisperUrl = argv[++i] || out.whisperUrl;
    else if (arg.startsWith('--whisper-url=')) out.whisperUrl = arg.slice('--whisper-url='.length);
    else if (arg === '--voice-text') out.voiceText = argv[++i] || out.voiceText;
    else if (arg.startsWith('--voice-text=')) out.voiceText = arg.slice('--voice-text='.length);
    else if (arg === '--skip-voice') out.skipVoice = true;
    else if (arg === '--skip-delegate') out.skipDelegate = true;
    else if (arg === '--ack-read-owner-token') out.explicitAckReadOwnerToken = true;
  }
  out.ownerTokenAuthorization = resolveOwnerTokenAuthorization({
    explicitAck: out.explicitAckReadOwnerToken,
    scope: 'voice-live:run',
  });
  out.ackReadOwnerToken = out.ownerTokenAuthorization.authorized;
  out.baseUrl = out.baseUrl.replace(/\/+$/, '');
  out.whisperUrl = out.whisperUrl.replace(/\/+$/, '');
  return out;
}

function ownerToken({ ackReadOwnerToken = false } = {}) {
  if (!ackReadOwnerToken) {
    return {
      token: '',
      source: 'not_loaded_policy_requires_ack',
      policyBlocked: true,
      reason: 'live owner-token access requires --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant; use --skip-voice for managed-only delegate evidence',
    };
  }
  if (process.env.NOE_OWNER_TOKEN) return { token: process.env.NOE_OWNER_TOKEN.trim(), source: 'env', policyBlocked: false, reason: '' };
  try {
    return { token: readFileSync(join(homedir(), '.noe-panel', 'owner-token.txt'), 'utf8').trim(), source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: '' };
  } catch {
    return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not found' };
  }
}

function redact(value) {
  return String(value || '')
    .replace(/\?t=[0-9a-f]{32,}/gi, '?t=[redacted]')
    .replace(/(X-Panel-Owner-Token["':\s]+)[0-9a-f]{32,}/gi, '$1[redacted]');
}

function run(command, args, { timeoutMs = 60_000 } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveRun({ ok: false, code: null, stdout, stderr, error: 'timeout' });
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveRun({ ok: code === 0, code, stdout: redact(stdout), stderr: redact(stderr) });
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveRun({ ok: false, code: null, stdout, stderr, error: e?.message || String(e) });
    });
  });
}

async function requestJson(url, { method = 'GET', token = '', body = null, rawBody = null, contentType = 'application/json', timeoutMs = 60_000 } = {}) {
  const headers = {};
  if (token) headers['X-Panel-Owner-Token'] = token;
  if (body || rawBody) headers['Content-Type'] = contentType;
  const res = await fetch(url, {
    method,
    headers,
    body: rawBody || (body ? JSON.stringify(body) : undefined),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 2000) }; }
  return { status: res.status, ok: res.ok, data };
}

async function captureVoice({ whisperUrl, baseUrl, token, voiceText }) {
  const source = join(EVIDENCE_DIR, 'voice-source.aiff');
  const wav = join(EVIDENCE_DIR, 'voice-source.wav');
  const out = join(EVIDENCE_DIR, 'real-voice-e2e.json');
  const health = await requestJson(`${whisperUrl}/`, { timeoutMs: 5000 }).catch((e) => ({ ok: false, error: e?.message || String(e) }));
  const say = await run('/usr/bin/say', ['-v', 'Tingting', '-o', source, voiceText], { timeoutMs: 45_000 });
  const sayOk = say.ok || (await run('/usr/bin/say', ['-o', source, voiceText], { timeoutMs: 45_000 })).ok;
  const convert = sayOk ? await run('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', '-c', '1', source, wav]) : { ok: false, error: 'say_failed' };
  let transcript = '';
  let whisper = { ok: false, data: {} };
  if (health.ok && convert.ok && existsSync(wav)) {
    whisper = await requestJson(whisperUrl, {
      method: 'POST',
      rawBody: readFileSync(wav),
      contentType: 'application/octet-stream',
      timeoutMs: 90_000,
    }).catch((e) => ({ ok: false, data: { error: e?.message || String(e) } }));
    transcript = String(whisper.data?.text || '').trim();
  }
  const voice = token && transcript
    ? await requestJson(`${baseUrl}/api/noe/voice/chat`, {
      method: 'POST',
      token,
      body: { text: transcript, voice: false },
      timeoutMs: 90_000,
    }).catch((e) => ({ ok: false, data: { error: e?.message || String(e) } }))
    : { ok: false, data: { error: token ? 'empty transcript' : 'missing owner token' } };
  const evidence = {
    ok: Boolean(health.ok && convert.ok && transcript && voice.ok && voice.data?.ok && voice.data?.reply),
    kind: 'real_voice_e2e',
    method: 'generated_audio_to_whisper_then_noe_text_route',
    physicalMicrophone: false,
    generatedText: voiceText,
    transcript,
    reply: voice.data?.reply || '',
    status: { whisperHealth: Boolean(health.ok), say: Boolean(sayOk), afconvert: Boolean(convert.ok), noeVoice: voice.status || null },
    errors: [health.error || health.data?.error, say.stderr || say.error, convert.stderr || convert.error, voice.data?.error].filter(Boolean).map((s) => String(s).slice(0, 240)),
    checkedAt: new Date().toISOString(),
  };
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  return { id: 'voice_evidence', ok: evidence.ok, file: out, evidence };
}

function latestPhase5Report() {
  const dir = join(ROOT, 'output', 'noe-phase5-runtime');
  try {
    return readdirSync(dir).filter((name) => /^phase5-runtime-\d+\.json$/.test(name)).sort().pop()
      ? join(dir, readdirSync(dir).filter((name) => /^phase5-runtime-\d+\.json$/.test(name)).sort().pop())
      : '';
  } catch {
    return '';
  }
}

async function captureSafeDelegate() {
  const phase = await run('npm', ['run', 'verify:noe:phase5', '--', '--managed'], { timeoutMs: 120_000 });
  const reportPath = (phase.stdout.match(/report=(.+)$/m) || [])[1] || latestPhase5Report();
  let check = null;
  try {
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    check = report.checks?.find((item) => item.id === 'managed_delegate_confirm_creates_idle_room_only') || null;
  } catch { /* handled below */ }
  const out = join(EVIDENCE_DIR, 'delegate-confirm-idle.json');
  const evidence = {
    ok: Boolean(phase.ok && check?.ok),
    kind: 'delegate_confirm_idle',
    method: 'managed_isolated_noe_delegate_confirm',
    roomId: check?.details?.roomId || '',
    roomStatus: check?.details?.roomStatus || '',
    started: check?.details?.started ?? null,
    queued: check?.details?.queued ?? null,
    phase5Report: reportPath ? reportPath.replace(`${ROOT}/`, '') : '',
    checkedAt: new Date().toISOString(),
  };
  writeFileSync(out, JSON.stringify(evidence, null, 2));
  return { id: 'safe_delegate_evidence', ok: evidence.ok, file: out, evidence };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const tokenPolicy = ownerToken({ ackReadOwnerToken: args.ackReadOwnerToken });
  const token = tokenPolicy.token;
  const results = [];
  const voicePolicyBlocked = !args.skipVoice && tokenPolicy.policyBlocked;
  if (voicePolicyBlocked) {
    results.push({
      id: 'voice_evidence',
      ok: false,
      file: '',
      evidence: { kind: 'policy_blocked', source: tokenPolicy.source, reason: tokenPolicy.reason, secretValueReturned: false },
    });
  }
  if (!args.skipVoice && !voicePolicyBlocked) results.push(await captureVoice({ ...args, token }));
  if (!args.skipDelegate) results.push(await captureSafeDelegate());
  const report = {
    ok: results.every((r) => r.ok),
    checkedAt: new Date().toISOString(),
    tokenPolicy: {
      source: tokenPolicy.source,
      ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
      authorization: args.ownerTokenAuthorization,
      policyBlocked: Boolean(tokenPolicy.policyBlocked),
      reason: tokenPolicy.reason || '',
      secretValueReturned: false,
    },
    results,
  };
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.id} file=${item.file}`);
  console.log(`report=${REPORT}`);
  if (!report.ok) process.exitCode = tokenPolicy.policyBlocked ? 2 : 1;
}

main().catch((e) => {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify({ ok: false, error: e?.message || String(e) }, null, 2));
  console.error(e?.stack || e?.message || e);
  console.error(`report=${REPORT}`);
  process.exit(1);
});
