#!/usr/bin/env node
// @ts-check

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveOwnerTokenAuthorization } from './lib/noe-standing-autonomy-grant.mjs';

const HOST = valueAfter('--host', process.env.PANEL_HOST || '127.0.0.1');
const PORT = Number(valueAfter('--port', process.env.PORT || process.env.PANEL_PORT || 51835));
const REPORT_DIR = join(process.cwd(), 'output', 'noe-memory-live-provenance');

function flag(name) {
  return process.argv.includes(name);
}

function valueAfter(name, fallback = '') {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1] || fallback;
  const prefixed = process.argv.find((arg) => arg.startsWith(`${name}=`));
  return prefixed ? prefixed.slice(name.length + 1) : fallback;
}

function clean(value = '', max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function parseArgs() {
  const explicitAckReadOwnerToken = flag('--ack-read-owner-token') || process.env.NOE_ACK_READ_OWNER_TOKEN === '1';
  const ownerTokenAuthorization = resolveOwnerTokenAuthorization({
    explicitAck: explicitAckReadOwnerToken,
    scope: 'memory-live-provenance:run',
  });
  return {
    explicitAckReadOwnerToken,
    ackReadOwnerToken: ownerTokenAuthorization.authorized,
    ownerTokenAuthorization,
    requirePass: flag('--require-pass'),
    requireChatOk: flag('--require-chat-ok'),
    mode: ['action', 'extractor'].includes(valueAfter('--mode', 'action')) ? valueAfter('--mode', 'action') : 'action',
  };
}

function ownerToken({ ackReadOwnerToken = false } = {}) {
  if (!ackReadOwnerToken) {
    return {
      token: '',
      source: 'not_loaded_policy_requires_ack',
      policyBlocked: true,
      reason: 'live owner-token access requires --ack-read-owner-token, NOE_ACK_READ_OWNER_TOKEN=1, or a valid standing autonomy grant',
    };
  }
  if (process.env.NOE_OWNER_TOKEN) {
    return { token: String(process.env.NOE_OWNER_TOKEN).trim(), source: 'env', policyBlocked: false, reason: '' };
  }
  const tokenPath = join(homedir(), '.noe-panel', 'owner-token.txt');
  if (!existsSync(tokenPath)) return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not found' };
  try {
    return { token: readFileSync(tokenPath, 'utf8').trim(), source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: '' };
  } catch {
    return { token: '', source: '~/.noe-panel/owner-token.txt', policyBlocked: false, reason: 'owner token not readable' };
  }
}

function writeReport(report) {
  mkdirSync(REPORT_DIR, { recursive: true });
  const file = join(REPORT_DIR, `noe-memory-live-provenance-${Date.now()}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function readSnapshot({ marker, dbPath = join(homedir(), '.noe-panel', 'panel.db') } = {}) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const like = `%${marker}%`;
    const memories = db.prepare(`
      SELECT id, scope, source_type, source_episode_id, created_at, updated_at, confidence
      FROM noe_memory
      WHERE body LIKE ? OR title LIKE ?
      ORDER BY updated_at DESC
      LIMIT 20
    `).all(like, like);
    const candidates = db.prepare(`
      SELECT id, kind, scope, source_type, source_episode_id, decision, decision_reason, target_memory_id, created_at, decided_at, confidence
      FROM noe_memory_candidate
      WHERE body LIKE ? OR title LIKE ? OR evidence_refs LIKE ? OR candidate_json LIKE ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(like, like, like, like);
    const memoryIds = [...new Set([...memories.map((r) => r.id), ...candidates.map((r) => r.target_memory_id)].filter(Boolean))];
    const episodeIds = [...new Set([...memories.map((r) => r.source_episode_id), ...candidates.map((r) => r.source_episode_id)].filter(Boolean))];
    let links = [];
    if (memoryIds.length) {
      const placeholders = memoryIds.map(() => '?').join(',');
      links = db.prepare(`
        SELECT memory_id, link_type, link_ref, created_at
        FROM noe_memory_link
        WHERE memory_id IN (${placeholders})
        ORDER BY created_at DESC
        LIMIT 80
      `).all(...memoryIds);
    }
    let events = [];
    if (episodeIds.length) {
      const numericEpisodeIds = episodeIds.map((id) => Number(id)).filter((id) => Number.isInteger(id));
      if (numericEpisodeIds.length) {
        const placeholders = numericEpisodeIds.map(() => '?').join(',');
        events = db.prepare(`
          SELECT id, ts, kind, tag, entity_type
          FROM events
          WHERE id IN (${placeholders})
          ORDER BY id DESC
          LIMIT 80
        `).all(...numericEpisodeIds);
      }
    }
    return { memories, candidates, links, events };
  } finally {
    db.close();
  }
}

function summarizeSnapshot(snapshot) {
  return {
    counts: {
      events: snapshot.events.length,
      memories: snapshot.memories.length,
      candidates: snapshot.candidates.length,
      links: snapshot.links.length,
    },
    events: snapshot.events.map((r) => ({ id: r.id, kind: r.kind, tag: r.tag, entityType: r.entity_type })),
    memories: snapshot.memories.map((r) => ({
      id: r.id,
      scope: r.scope,
      sourceType: r.source_type,
      sourceEpisodeId: r.source_episode_id,
      confidence: r.confidence,
    })),
    candidates: snapshot.candidates.map((r) => ({
      id: r.id,
      kind: r.kind,
      scope: r.scope,
      sourceType: r.source_type,
      sourceEpisodeId: r.source_episode_id,
      decision: r.decision,
      targetMemoryId: r.target_memory_id,
      confidence: r.confidence,
    })),
    links: snapshot.links.map((r) => ({
      memoryId: r.memory_id,
      linkType: r.link_type,
      linkRef: r.link_ref,
    })),
  };
}

function evaluate(snapshot, { mode = 'action' } = {}) {
  const memoryIds = new Set(snapshot.memories.map((r) => r.id));
  const episodeIds = new Set(snapshot.events.map((r) => String(r.id)));
  const checks = {
    memoryFound: snapshot.memories.length > 0,
    candidateFound: snapshot.candidates.length > 0,
    acceptedCandidateFound: snapshot.candidates.some((r) => r.decision === 'accepted'),
    memoryHasSourceEpisode: snapshot.memories.some((r) => r.source_episode_id && episodeIds.has(String(r.source_episode_id))),
    sourceEpisodeEventFound: episodeIds.size > 0,
    sourceEpisodeLinkFound: snapshot.links.some((r) => memoryIds.has(r.memory_id) && r.link_type === 'source_episode' && episodeIds.has(String(r.link_ref))),
    evidenceRefLinkFound: snapshot.links.some((r) => memoryIds.has(r.memory_id) && r.link_type === 'evidence_ref' && /^episode:\d+$/.test(String(r.link_ref || ''))),
  };
  if (mode === 'extractor') {
    checks.factExtractCandidateFound = snapshot.candidates.some((r) => r.source_type === 'fact_extract');
    checks.factExtractMemoryFound = snapshot.memories.some((r) => r.source_type === 'fact_extract');
  } else {
    checks.actionCandidateFound = snapshot.candidates.some((r) => r.source_type === 'voice_note');
    checks.actionMemoryFound = snapshot.memories.some((r) => r.source_type === 'voice_note');
  }
  return checks;
}

function allPassed(checks, { requireChatOk = false } = {}) {
  return Object.entries(checks).every(([id, passed]) => id === 'chatOk' && !requireChatOk ? true : Boolean(passed));
}

async function run() {
  const args = parseArgs();
  const tokenPolicy = ownerToken({ ackReadOwnerToken: args.ackReadOwnerToken });
  const baseReport = {
    host: HOST,
    port: PORT,
    generatedAt: new Date().toISOString(),
    tokenPolicy: {
      source: tokenPolicy.source,
      ackReadOwnerToken: Boolean(args.ackReadOwnerToken),
      authorization: args.ownerTokenAuthorization,
      policyBlocked: Boolean(tokenPolicy.policyBlocked),
      reason: tokenPolicy.reason || '',
      secretValueReturned: false,
    },
    ownerTokenPrinted: false,
    memoryBodyPrinted: false,
  };
  if (tokenPolicy.policyBlocked || !tokenPolicy.token) {
    const report = {
      ...baseReport,
      ok: false,
      marker: '',
      response: null,
      checks: { ownerTokenLoaded: false },
      note: 'Live memory provenance smoke did not read owner-token or call protected live APIs because neither explicit ack nor standing autonomy grant authorized it.',
    };
    const reportPath = writeReport(report);
    return { ...report, reportPath };
  }

  const markerPrefix = args.mode === 'extractor' ? 'memory_extractor_live' : 'memory_live_provenance';
  const marker = `${markerPrefix}_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}_${Math.random().toString(36).slice(2, 8)}`;
  const text = args.mode === 'extractor'
    ? `一个长期偏好信息：我现在偏好的项目测试代号是 ${marker}。以后如果聊到测试偏好，可以用这个代号。`
    : `请记住一个长期记忆事实：我的长期记忆验证码是 ${marker}。这是我明确要求你以后能记住的事实，用于验证 Neo 记忆来源链路。`;
  const response = await fetch(`http://${HOST}:${PORT}/api/noe/voice/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Panel-Owner-Token': tokenPolicy.token },
    body: JSON.stringify({ text, voice: false, tts: { enabled: false } }),
  }).then(async (res) => {
    const json = await res.json().catch(() => ({}));
    return {
      status: res.status,
      ok: json?.ok === true,
      intent: clean(json?.intent, 80) || null,
      ignored: json?.ignored === true,
      replyChars: String(json?.reply || '').length,
      errorPresent: Boolean(json?.error),
      usedAdapter: clean(json?.usedAdapter, 120) || null,
      usedModel: clean(json?.usedModel, 160) || null,
    };
  }).catch((error) => ({ status: 0, ok: false, errorPresent: true, error: clean(error?.message || error, 300) }));

  let snapshot = readSnapshot({ marker });
  for (let i = 0; i < 12; i += 1) {
    const checks = evaluate(snapshot, { mode: args.mode });
    if (Object.values(checks).every(Boolean)) break;
    await new Promise((resolve) => setTimeout(resolve, 5000));
    snapshot = readSnapshot({ marker });
  }
  const checks = evaluate(snapshot, { mode: args.mode });
  checks.chatOk = response.ok === true;
  const report = {
    ...baseReport,
    ok: allPassed(checks, { requireChatOk: args.requireChatOk }),
    marker,
    response,
    policy: { mode: args.mode, requireChatOk: args.requireChatOk },
    checks,
    snapshot: summarizeSnapshot(snapshot),
  };
  const reportPath = writeReport(report);
  return { ...report, reportPath };
}

const report = await run();
console.log(JSON.stringify({
  ok: report.ok,
  reportPath: report.reportPath,
  marker: report.marker,
  response: report.response,
  checks: report.checks,
  counts: report.snapshot?.counts || null,
  ownerTokenPrinted: false,
  memoryBodyPrinted: false,
}, null, 2));
if (flag('--require-pass') && !report.ok) process.exit(1);
