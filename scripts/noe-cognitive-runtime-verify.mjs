#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'output', 'noe-cognitive-runtime');
const REPORT = join(OUT_DIR, `cognitive-runtime-${Date.now()}.json`);
const DEFAULT_BASE = 'http://127.0.0.1:51835';

function parseArgs(argv) {
  const out = {
    baseUrl: process.env.NOE_PANEL_URL || DEFAULT_BASE,
    timeoutMs: 15_000,
    skipM3: false,
    headful: false,
    explicitAckReadOwnerToken: process.env.NOE_ACK_READ_OWNER_TOKEN === '1',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--base-url') out.baseUrl = argv[++i] || out.baseUrl;
    else if (arg.startsWith('--base-url=')) out.baseUrl = arg.slice(11);
    else if (arg === '--timeout-ms') out.timeoutMs = Number(argv[++i]) || out.timeoutMs;
    else if (arg.startsWith('--timeout-ms=')) out.timeoutMs = Number(arg.slice(13)) || out.timeoutMs;
    else if (arg === '--skip-m3') out.skipM3 = true;
    else if (arg === '--headful') out.headful = true;
    else if (arg === '--ack-read-owner-token') out.explicitAckReadOwnerToken = true;
  }
  out.ownerTokenAuthorization = resolveOwnerTokenAuthorization({
    explicitAck: out.explicitAckReadOwnerToken,
    scope: 'cognitive-live:run',
  });
  out.ackReadOwnerToken = out.ownerTokenAuthorization.authorized;
  out.baseUrl = String(out.baseUrl || DEFAULT_BASE).replace(/\/+$/, '');
  return out;
}

function liveOwnerToken({ ackReadOwnerToken = false } = {}) {
  if (!ackReadOwnerToken) {
    return {
      token: '',
      source: 'not_loaded_policy_requires_ack',
      policyBlocked: true,
      reason: 'live owner-token access requires --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant',
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
    .replace(/\?t=[^&\s]+/g, '?t=[redacted]')
    .replace(/[0-9a-f]{32,}/gi, '[redacted]');
}

function add(checks, id, ok, details = {}) {
  checks.push({ id, ok: Boolean(ok), details });
}

async function request(path, { method = 'GET', token = '', body, timeoutMs = 15_000, noTimeout = false } = {}) {
  const headers = token ? { 'X-Panel-Owner-Token': token } : {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const opts = { method, headers, body: body === undefined ? undefined : JSON.stringify(body) };
  if (!noTimeout) opts.signal = AbortSignal.timeout(timeoutMs);
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: redact(text).slice(0, 2000) }; }
  return { status: res.status, ok: res.ok, data };
}

async function verifyApi({ checks, baseUrl, token, timeoutMs, skipM3 }) {
  const health = await request(`${baseUrl}/api/noe/health`, { token, timeoutMs }).catch((e) => ({ error: e.message }));
  add(checks, 'authorized_health_ok', health.status === 200 && health.data?.ok === true, { status: health.status || null, error: health.error || null });

  const profiles = await request(`${baseUrl}/api/noe/chat/profiles`, { token, timeoutMs }).catch((e) => ({ error: e.message }));
  const rows = Array.isArray(profiles.data?.profiles) ? profiles.data.profiles : [];
  add(checks, 'profiles_expose_temperature_and_max_tokens', profiles.status === 200 && rows.length > 0 && rows.every((p) => typeof p.temperature === 'number' && typeof p.maxCompletionTokens === 'number'), {
    status: profiles.status || null,
    count: rows.length,
    sample: rows.slice(0, 5).map((p) => ({ id: p.id, temperature: p.temperature, maxCompletionTokens: p.maxCompletionTokens })),
  });

  const id = `runtime_${Date.now().toString(36)}`;
  const create = await request(`${baseUrl}/api/noe/chat/profiles`, {
    method: 'POST', token, timeoutMs,
    body: { id, name: '运行验收配置', adapterId: 'minimax', model: 'MiniMax-M3', mode: 'assistant', thinkingMode: 'disabled', temperature: 0.37, maxCompletionTokens: 4096, personaName: 'Noe', systemPrompt: '你是运行验收配置。中文简洁回答。' },
  }).catch((e) => ({ error: e.message }));
  const list = await request(`${baseUrl}/api/noe/chat/profiles`, { token, timeoutMs }).catch((e) => ({ error: e.message }));
  const found = (list.data?.profiles || []).find((p) => p.id === id);
  add(checks, 'profile_create_persists_runtime_fields', create.status === 201 && found?.temperature === 0.37 && found?.maxCompletionTokens === 4096, {
    createStatus: create.status || null,
    found: found ? { id: found.id, temperature: found.temperature, maxCompletionTokens: found.maxCompletionTokens } : null,
    error: create.error || create.data?.error || null,
  });
  const del = await request(`${baseUrl}/api/noe/chat/profiles/${encodeURIComponent(id)}`, { method: 'DELETE', token, timeoutMs }).catch((e) => ({ error: e.message }));
  add(checks, 'profile_runtime_cleanup_deleted', del.status === 200 && del.data?.ok === true, { status: del.status || null, error: del.error || del.data?.error || null });

  const ownerBefore = await request(`${baseUrl}/api/noe/owner-gate`, { token, timeoutMs }).catch((e) => ({ error: e.message }));
  const original = ownerBefore.data?.config || { enabled: false, wakeWords: [], passphrases: [] };
  const ownerOn = await request(`${baseUrl}/api/noe/owner-gate`, { method: 'POST', token, timeoutMs, body: { enabled: true, wakeWords: '运行验收唤醒词', passphrases: '' } }).catch((e) => ({ error: e.message }));
  const ownerRead = await request(`${baseUrl}/api/noe/owner-gate`, { token, timeoutMs }).catch((e) => ({ error: e.message }));
  const ownerRestore = await request(`${baseUrl}/api/noe/owner-gate`, { method: 'POST', token, timeoutMs, body: original }).catch((e) => ({ error: e.message }));
  add(checks, 'owner_gate_updates_and_restores', ownerOn.status === 200 && ownerRead.data?.config?.enabled === true && ownerRestore.status === 200, {
    setStatus: ownerOn.status || null,
    readEnabled: ownerRead.data?.config?.enabled ?? null,
    restoreStatus: ownerRestore.status || null,
  });

  const identity = await request(`${baseUrl}/api/noe/identity/status`, { token, timeoutMs }).catch((e) => ({ error: e.message }));
  const originalFaceOwnerId = identity.data?.status?.face?.ownerPersonId || '';
  add(checks, 'identity_status_exposes_readiness', identity.status === 200 && typeof identity.data?.status?.voice?.ready === 'boolean' && typeof identity.data?.status?.face?.ready === 'boolean', {
    status: identity.status || null,
    voice: identity.data?.status?.voice || null,
    face: identity.data?.status?.face || null,
  });

  const personName = `运行验收人物 ${Date.now().toString(36)}`;
  const face = Array.from({ length: 64 }, (_, i) => Math.sin((i + 3) / 9));
  const person = await request(`${baseUrl}/api/noe/people`, { method: 'POST', token, timeoutMs, body: { displayName: personName, relation: '运行验收', notes: '临时人物，验收后删除。' } }).catch((e) => ({ error: e.message }));
  const pid = person.data?.person?.id;
  if (pid) {
    await request(`${baseUrl}/api/noe/people/${encodeURIComponent(pid)}/face/enroll`, { method: 'POST', token, timeoutMs, body: { embedding: face, name: 'a' } }).catch(() => ({}));
    await request(`${baseUrl}/api/noe/people/${encodeURIComponent(pid)}/face/enroll`, { method: 'POST', token, timeoutMs, body: { embedding: face.map((v, i) => v + Math.sin(i) * 0.001), name: 'b' } }).catch(() => ({}));
    await request(`${baseUrl}/api/noe/people/${encodeURIComponent(pid)}/face/enroll`, { method: 'POST', token, timeoutMs, body: { embedding: face.map((v, i) => v + Math.cos(i) * 0.001), name: 'c' } }).catch(() => ({}));
  }
  const match = pid ? await request(`${baseUrl}/api/noe/people/identify/face`, { method: 'POST', token, timeoutMs, body: { embedding: face, threshold: 0.5 } }).catch((e) => ({ error: e.message })) : {};
  const bindFace = pid ? await request(`${baseUrl}/api/noe/identity/face/owner-person`, { method: 'POST', token, timeoutMs, body: { personId: pid, enabled: true } }).catch((e) => ({ error: e.message })) : {};
  const restoreFace = await request(`${baseUrl}/api/noe/identity/face/owner-person`, { method: 'POST', token, timeoutMs, body: { personId: originalFaceOwnerId } }).catch((e) => ({ error: e.message }));
  const cleanupPerson = pid ? await request(`${baseUrl}/api/noe/people/${encodeURIComponent(pid)}`, { method: 'DELETE', token, timeoutMs }).catch((e) => ({ error: e.message })) : {};
  add(checks, 'people_store_create_enroll_identify_delete', person.status === 201 && match.data?.match?.ok === true && match.data?.match?.person?.displayName === personName && cleanupPerson.status === 200, {
    createStatus: person.status || null,
    match: match.data?.match ? { ok: match.data.match.ok, name: match.data.match.person?.displayName, score: match.data.match.score } : null,
    cleanupStatus: cleanupPerson.status || null,
  });
  add(checks, 'people_owner_face_binding_roundtrip', bindFace.status === 200 && bindFace.data?.face?.ownerPersonId === pid && bindFace.data?.face?.ownerPerson?.displayName === personName && restoreFace.status === 200, {
    bindStatus: bindFace.status || null,
    boundName: bindFace.data?.face?.ownerPerson?.displayName || null,
    samples: bindFace.data?.face?.samples || null,
    restoreStatus: restoreFace.status || null,
  });

  const engine = await request(`${baseUrl}/api/noe/people/face-engine`, { token, timeoutMs }).catch((e) => ({ error: e.message }));
  const engineStatus = engine.data?.status || {};
  add(checks, 'insightface_engine_installed', engine.status === 200 && engineStatus.ok === true && engineStatus.modelReady === true, {
    status: engine.status || null,
    engine: engineStatus.engine || null,
    modelReady: engineStatus.modelReady ?? null,
    error: engine.error || engine.data?.error || null,
  });
  const samplePaths = [
    join(homedir(), '.noe-panel', 'insightface-venv', 'lib', 'python3.11', 'site-packages', 'insightface', 'data', 'images', 't1.jpg'),
    join(homedir(), '.noe-panel', 'insightface-venv', 'insightface', 'data', 'images', 't1.jpg'),
  ];
  const samplePath = samplePaths.find((p) => existsSync(p));
  const faceEmbedding = samplePath ? await request(`${baseUrl}/api/noe/people/face-embedding`, {
    method: 'POST', token, timeoutMs: 120_000,
    body: { image: `data:image/jpeg;base64,${readFileSync(samplePath).toString('base64')}` },
  }).catch((e) => ({ error: e.message })) : {};
  add(checks, 'insightface_api_returns_512_embedding', faceEmbedding.status === 200 && faceEmbedding.data?.engine === 'insightface' && faceEmbedding.data?.embedding?.length === 512, {
    sampleFound: Boolean(samplePath),
    status: faceEmbedding.status || null,
    engine: faceEmbedding.data?.engine || null,
    faceCount: faceEmbedding.data?.faceCount || null,
    embeddingLength: faceEmbedding.data?.embedding?.length || 0,
    error: faceEmbedding.error || faceEmbedding.data?.error || null,
  });

  if (!skipM3) {
    await request(`${baseUrl}/api/noe/owner-gate`, { method: 'POST', token, timeoutMs, body: { enabled: false, wakeWords: original.wakeWords || [], passphrases: original.passphrases || [] } }).catch(() => ({}));
    const m3 = await request(`${baseUrl}/api/noe/voice/chat`, { method: 'POST', token, noTimeout: true, body: { text: '用中文只回答：好', profileId: 'm3_fast' } }).catch((e) => ({ error: e.message }));
    const m3Restore = await request(`${baseUrl}/api/noe/owner-gate`, { method: 'POST', token, timeoutMs, body: original }).catch((e) => ({ error: e.message }));
    add(checks, 'm3_fast_uses_minimax_without_local_fallback', m3.status === 200 && m3.data?.ok === true && m3.data?.usedAdapter === 'minimax' && m3.data?.usedModel === 'MiniMax-M3', {
      status: m3.status || null,
      ok: m3.data?.ok ?? null,
      usedAdapter: m3.data?.usedAdapter || null,
      usedModel: m3.data?.usedModel || null,
      reply: String(m3.data?.reply || '').slice(0, 60),
      ownerGateRestoreStatus: m3Restore.status || null,
      error: m3.error || m3.data?.error || null,
    });
  }
}

async function verifyPage({ checks, baseUrl, token, timeoutMs, headful }) {
  const browser = await chromium.launch({ headless: !headful });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const consoleErrors = [];
  let photoPersonId = '';
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(redact(msg.text()).slice(0, 300)); });
  try {
    await page.goto(`${baseUrl}/cognitive.html?t=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.waitForSelector('#chatProfileSettings', { timeout: timeoutMs });
    await page.click('#chatProfileSettings');
    await page.waitForSelector('input[name="temperature"]', { timeout: timeoutMs });
    const state = await page.evaluate(() => ({
      title: document.title,
      script: Array.from(document.scripts).map((s) => s.src).find((src) => src.includes('cognitive-research')) || '',
      temp: !!document.querySelector('input[name="temperature"]'),
      maxTokens: !!document.querySelector('input[name="maxCompletionTokens"]'),
      ownerGate: !!document.querySelector('#dOwnerGate'),
      ownerWakeWords: !!document.querySelector('#ownerWakeWords'),
      identityStatus: document.querySelector('#identityStatus')?.textContent || '',
      voiceClear: !!document.querySelector('#identityVoiceClear'),
      faceClear: !!document.querySelector('#identityFaceClear'),
      photoEmbeddingBridge: typeof window.cogFaceEmbeddingFromImageFile === 'function',
      peopleEntry: !!document.querySelector('#dPeopleKb'),
      peopleSheet: !!document.querySelector('#peopleSheet'),
      peopleControls: ['peopleSave', 'peoplePhoto', 'peoplePhotoInput', 'peopleFace', 'peopleVoice', 'peopleOwnerFace', 'peopleOwnerVoice', 'peopleIdentify'].every((id) => !!document.querySelector(`#${id}`)),
      peopleSampleList: !!document.querySelector('.people-samples'),
      gearBottom: getComputedStyle(document.querySelector('#gear')).bottom,
      profileTabs: Array.from(document.querySelectorAll('#chatProfileTabs button')).map((b) => b.textContent.trim()).slice(0, 5),
      profileList: Array.from(document.querySelectorAll('#profileList button b')).map((b) => b.textContent.trim()).slice(0, 8),
      overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    }));
    add(checks, 'cognitive_page_profile_and_owner_controls', state.temp && state.maxTokens && state.ownerGate && state.ownerWakeWords && state.voiceClear && state.faceClear, state);
    add(checks, 'cognitive_page_people_kb_controls', state.peopleEntry && state.peopleSheet && state.peopleControls && state.peopleSampleList, state);
    add(checks, 'cognitive_page_profile_labels_are_compact', state.profileTabs.every((tab) => !/^M3.*M3/.test(tab)) && state.profileList.every((name) => !/^M3\s/.test(name)), { profileTabs: state.profileTabs, profileList: state.profileList });
    add(checks, 'cognitive_page_no_horizontal_overflow', !state.overflow, { overflow: state.overflow, profileTabs: state.profileTabs });
    let capturedVoiceBody = {};
    await page.route('**/api/noe/voice/chat', async (route) => {
      try { capturedVoiceBody = JSON.parse(route.request().postData() || '{}'); } catch { capturedVoiceBody = {}; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, reply: 'ok' }) });
    });
    await page.evaluate(async () => {
      window.cogCurrentFaceEmbeddingPayload = async () => ({ faceEmbedding: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], faceEmbeddingEngine: 'test' });
      await fetch('/api/noe/voice/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '这个人是谁' }) });
    });
    add(checks, 'cognitive_text_chat_attaches_face_embedding', Array.isArray(capturedVoiceBody.faceEmbedding) && capturedVoiceBody.faceEmbedding.length >= 8, { hasText: capturedVoiceBody.text === '这个人是谁', faceEmbeddingLength: capturedVoiceBody.faceEmbedding?.length || 0 });
    const photoPerson = await request(`${baseUrl}/api/noe/people`, { method: 'POST', token, timeoutMs, body: { displayName: `照片导入验收 ${Date.now().toString(36)}`, relation: '运行验收', notes: '照片导入后删除。' } }).catch((e) => ({ error: e.message }));
    photoPersonId = photoPerson.data?.person?.id || '';
    const photoImport = photoPersonId ? await page.evaluate(async ({ pid, ownerToken }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 32;
      const ctx = canvas.getContext('2d');
      const grad = ctx.createLinearGradient(0, 0, 32, 32);
      grad.addColorStop(0, '#111827'); grad.addColorStop(1, '#d4a27b');
      ctx.fillStyle = grad; ctx.fillRect(0, 0, 32, 32);
      ctx.fillStyle = '#f6d7c2'; ctx.fillRect(10, 7, 12, 14);
      ctx.fillStyle = '#1f2937'; ctx.fillRect(12, 11, 2, 2); ctx.fillRect(18, 11, 2, 2);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const file = new File([blob], 'runtime-person-photo.png', { type: 'image/png' });
      const extracted = await window.cogFaceEmbeddingFromImageFile(file);
      const res = await fetch(`/api/noe/people/${encodeURIComponent(pid)}/face/enroll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': ownerToken },
        body: JSON.stringify({ embedding: extracted.embedding, name: extracted.fileName }),
      });
      const data = await res.json();
      return { ok: res.ok && data.ok, len: extracted.embedding?.length || 0, faceSamples: data.person?.faceSamples || 0 };
    }, { pid: photoPersonId, ownerToken: token }).catch((e) => ({ error: e.message })) : {};
    add(checks, 'cognitive_people_photo_file_to_person_sample', photoImport.ok === true && photoImport.len >= 512 && photoImport.faceSamples >= 1, { createStatus: photoPerson.status || null, photoImport });
    add(checks, 'cognitive_page_no_console_errors', consoleErrors.length === 0, { consoleErrors });
  } finally {
    if (photoPersonId) await request(`${baseUrl}/api/noe/people/${encodeURIComponent(photoPersonId)}`, { method: 'DELETE', token, timeoutMs }).catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tokenPolicy = liveOwnerToken({ ackReadOwnerToken: args.ackReadOwnerToken });
  const token = tokenPolicy.token;
  const checks = [];
  add(checks, 'owner_token_loaded', Boolean(token), {
    source: tokenPolicy.source,
    policyBlocked: Boolean(tokenPolicy.policyBlocked),
    reason: tokenPolicy.reason || '',
  });
  if (token) {
    await verifyApi({ checks, baseUrl: args.baseUrl, token, timeoutMs: args.timeoutMs, skipM3: args.skipM3 });
    await verifyPage({ checks, baseUrl: args.baseUrl, token, timeoutMs: args.timeoutMs, headful: args.headful });
  }
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.length - passed;
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify({
    ok: failed === 0,
    baseUrl: args.baseUrl,
    tokenPolicy: {
      source: tokenPolicy.source,
      ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
      authorization: args.ownerTokenAuthorization,
      policyBlocked: Boolean(tokenPolicy.policyBlocked),
      reason: tokenPolicy.reason || '',
      secretValueReturned: false,
    },
    checks,
    passed,
    failed,
    note: 'No secrets are written; owner token is redacted from page logs. Reading live owner-token requires explicit ack or standing autonomy grant.',
  }, null, 2));
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}`);
  console.log(`report=${REPORT}`);
  if (failed > 0) process.exitCode = tokenPolicy.policyBlocked ? 2 : 1;
}

main().catch((e) => {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(REPORT, JSON.stringify({ ok: false, error: redact(e?.message || String(e)) }, null, 2));
  console.error(redact(e?.stack || e?.message || e));
  console.error(`report=${REPORT}`);
  process.exit(1);
});
