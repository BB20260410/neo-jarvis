#!/usr/bin/env node
// @ts-check
// Read-only baseline audit for Neo evidence substrate.
// It aggregates counts/statuses only: no memory bodies, prompts, owner tokens,
// private holdout files, model calls, or action execution.

import Database from 'better-sqlite3';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DB_PATH = process.env.PANEL_DB_PATH || join(homedir(), '.noe-panel', 'panel.db');
const OUT_DIR = process.env.NOE_BASELINE_AUDIT_OUT_DIR || join(ROOT, 'output', 'noe-baseline-audit');
const PANEL_URL = (process.env.NOE_PANEL_URL || 'http://127.0.0.1:51835').replace(/\/+$/, '');
const FETCH_TIMEOUT_MS = Math.max(250, Number(process.env.NOE_BASELINE_AUDIT_FETCH_TIMEOUT_MS || 5000));

function rel(file) {
  const abs = resolve(file);
  return abs.startsWith(ROOT) ? relative(ROOT, abs).replace(/\\/g, '/') : abs;
}

function clean(value = '', max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function pct(n, d) {
  return d ? Number(((100 * Number(n || 0)) / Number(d || 0)).toFixed(2)) : 0;
}

function safeJson(value, fallback) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function jsonArray(value) {
  const parsed = safeJson(value, []);
  return Array.isArray(parsed)
    ? parsed.map((item) => clean(item, 180)).filter(Boolean)
    : [];
}

function increment(map, key, amount = 1) {
  const safeKey = clean(key, 180);
  if (!safeKey) return;
  map.set(safeKey, (map.get(safeKey) || 0) + amount);
}

function tableExists(db, table) {
  try {
    return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table));
  } catch {
    return false;
  }
}

function all(db, sql, params = []) {
  try { return db.prepare(sql).all(...params); } catch { return []; }
}

function one(db, sql, params = []) {
  try { return db.prepare(sql).get(...params) || null; } catch { return null; }
}

function countByRows(rows = [], key = 'status') {
  const out = {};
  for (const row of rows) {
    const name = clean(row[key] || 'unknown', 120);
    out[name] = (out[name] || 0) + Number(row.c || 0);
  }
  return out;
}

function sumCount(rows = []) {
  return rows.reduce((sum, row) => sum + Number(row.c || 0), 0);
}

function topRows(rows = [], limit = 20) {
  return rows.slice(0, limit).map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row)) {
      out[key] = typeof value === 'number' ? value : clean(value, 240);
    }
    return out;
  });
}

function topCountObject(counts = {}, limit = 10) {
  return Object.fromEntries(Object.entries(counts)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, limit));
}

function weightedAvg(total, weight) {
  return weight ? Number((total / weight).toFixed(3)) : 0;
}

function buildMemoryStats(db) {
  if (!tableExists(db, 'noe_memory')) return { ok: false, status: 'missing_noe_memory' };
  const counts = one(db, `
    SELECT
      COUNT(*) total,
      SUM(CASE WHEN hidden=0 THEN 1 ELSE 0 END) visible,
      SUM(CASE WHEN hidden<>0 THEN 1 ELSE 0 END) hidden,
      SUM(CASE WHEN source_episode_id IS NOT NULL AND length(source_episode_id)>0 THEN 1 ELSE 0 END) withSourceEpisode,
      SUM(CASE WHEN hit_count>0 THEN 1 ELSE 0 END) hitAtLeastOnce
    FROM noe_memory
  `) || {};
  const byScope = all(db, 'SELECT scope, COUNT(*) c FROM noe_memory GROUP BY scope ORDER BY c DESC');
  const bySource = all(db, 'SELECT source_type, COUNT(*) c FROM noe_memory GROUP BY source_type ORDER BY c DESC LIMIT 20');
  const candidates = tableExists(db, 'noe_memory_candidate')
    ? {
      total: one(db, 'SELECT COUNT(*) c FROM noe_memory_candidate')?.c || 0,
      decisions: countByRows(all(db, 'SELECT decision AS status, COUNT(*) c FROM noe_memory_candidate GROUP BY decision ORDER BY c DESC')),
      risks: countByRows(all(db, 'SELECT risk AS status, COUNT(*) c FROM noe_memory_candidate GROUP BY risk ORDER BY c DESC')),
      writeModes: countByRows(all(db, 'SELECT write_mode AS status, COUNT(*) c FROM noe_memory_candidate GROUP BY write_mode ORDER BY c DESC')),
    }
    : { total: 0, decisions: {}, risks: {}, writeModes: {} };
  return {
    ok: true,
    total: Number(counts.total || 0),
    visible: Number(counts.visible || 0),
    hidden: Number(counts.hidden || 0),
    withSourceEpisode: Number(counts.withSourceEpisode || 0),
    hitAtLeastOnce: Number(counts.hitAtLeastOnce || 0),
    visibleRate: pct(counts.visible, counts.total),
    sourceEpisodeCoverage: pct(counts.withSourceEpisode, counts.total),
    hitAtLeastOnceRate: pct(counts.hitAtLeastOnce, counts.total),
    byScope: topRows(byScope),
    bySourceType: topRows(bySource),
    candidates,
  };
}

function buildRetrievalStats(db) {
  if (!tableExists(db, 'noe_memory_retrieval_log')) return { ok: false, status: 'missing_noe_memory_retrieval_log' };
  const rows = all(db, 'SELECT id, ts, route_type, hit_ids, selected_ids, dropped_reasons FROM noe_memory_retrieval_log ORDER BY id DESC');
  const routes = {};
  const dropReasons = {};
  const selectedMentions = new Map();
  const inferredDroppedMentions = new Map();
  let hitRows = 0;
  let selectedRows = 0;
  let droppedRows = 0;
  let hitTotal = 0;
  let selectedTotal = 0;
  let droppedTotal = 0;
  for (const row of rows) {
    const route = clean(row.route_type || 'unknown', 80);
    const hits = jsonArray(row.hit_ids);
    const selected = jsonArray(row.selected_ids);
    const dropped = jsonArray(row.dropped_reasons);
    const selectedSet = new Set(selected);
    routes[route] ||= { rows: 0, hitRows: 0, selectedRows: 0, hitTotal: 0, selectedTotal: 0, droppedTotal: 0 };
    routes[route].rows += 1;
    if (hits.length) { hitRows += 1; routes[route].hitRows += 1; }
    if (selected.length) { selectedRows += 1; routes[route].selectedRows += 1; }
    if (dropped.length) droppedRows += 1;
    hitTotal += hits.length;
    selectedTotal += selected.length;
    droppedTotal += dropped.length;
    routes[route].hitTotal += hits.length;
    routes[route].selectedTotal += selected.length;
    routes[route].droppedTotal += dropped.length;
    for (const id of selected) increment(selectedMentions, id);
    for (const id of hits) {
      if (!selectedSet.has(id)) increment(inferredDroppedMentions, id);
    }
    for (const item of dropped) {
      const reason = clean(typeof item === 'string' ? item : item?.reason || 'unknown', 120);
      dropReasons[reason] = (dropReasons[reason] || 0) + 1;
    }
  }
  const routeStats = Object.fromEntries(Object.entries(routes).map(([route, item]) => [route, {
    ...item,
    hitRowRate: pct(item.hitRows, item.rows),
    selectedRowRate: pct(item.selectedRows, item.rows),
    avgHits: item.rows ? Number((item.hitTotal / item.rows).toFixed(2)) : 0,
    avgSelected: item.rows ? Number((item.selectedTotal / item.rows).toFixed(2)) : 0,
    avgDropped: item.rows ? Number((item.droppedTotal / item.rows).toFixed(2)) : 0,
  }]));
  return {
    ok: true,
    rows: rows.length,
    hitRows,
    selectedRows,
    droppedRows,
    hitRowRate: pct(hitRows, rows.length),
    selectedRowRate: pct(selectedRows, rows.length),
    avgHits: rows.length ? Number((hitTotal / rows.length).toFixed(2)) : 0,
    avgSelected: rows.length ? Number((selectedTotal / rows.length).toFixed(2)) : 0,
    avgDropped: rows.length ? Number((droppedTotal / rows.length).toFixed(2)) : 0,
    routes: routeStats,
    dropReasons,
    latest: rows.slice(0, 10).map((row) => ({
      id: Number(row.id),
      ts: Number(row.ts),
      route: clean(row.route_type || 'unknown', 80),
      hitCount: jsonArray(row.hit_ids).length,
      selectedCount: jsonArray(row.selected_ids).length,
      droppedCount: jsonArray(row.dropped_reasons).length,
    })),
    selectedDroppedProxy: buildSelectedDroppedProxy(db, selectedMentions, inferredDroppedMentions),
    caveat: 'This is retrieval-log hit/selected coverage, not semantic correctness; labeled eval is still required for recall quality.',
  };
}

function buildSelectedDroppedProxy(db, selectedMentions, inferredDroppedMentions) {
  if (!tableExists(db, 'noe_memory')) return { ok: false, status: 'missing_noe_memory' };
  return {
    ok: true,
    selected: buildMemoryIdMentionStats(db, selectedMentions),
    inferredDropped: buildMemoryIdMentionStats(db, inferredDroppedMentions),
    caveat: 'Inferred dropped IDs are hit_ids minus selected_ids. This is a ranking proxy only; it does not inspect memory body text or prove semantic relevance.',
  };
}

function buildMemoryIdMentionStats(db, mentionMap) {
  const ids = [...mentionMap.keys()];
  const mentions = [...mentionMap.values()].reduce((sum, value) => sum + Number(value || 0), 0);
  if (!ids.length) {
    return {
      mentions: 0,
      distinct: 0,
      found: 0,
      missing: 0,
      matchedMentions: 0,
      avgSalience: 0,
      avgHitCount: 0,
      avgConfidence: 0,
      hiddenMentionRate: 0,
      byScope: {},
      bySourceType: {},
    };
  }
  const rows = [];
  for (let i = 0; i < ids.length; i += 800) {
    const chunk = ids.slice(i, i + 800);
    const marks = chunk.map(() => '?').join(',');
    rows.push(...all(db, `
      SELECT id, scope, source_type, hidden, hit_count, confidence, salience
      FROM noe_memory
      WHERE id IN (${marks})
    `, chunk));
  }
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const scopeCounts = {};
  const sourceCounts = {};
  let matchedMentions = 0;
  let salienceTotal = 0;
  let hitCountTotal = 0;
  let confidenceTotal = 0;
  let hiddenMentions = 0;
  for (const [id, count] of mentionMap.entries()) {
    const row = byId.get(id);
    if (!row) continue;
    const weight = Number(count || 0);
    matchedMentions += weight;
    salienceTotal += Number(row.salience || 0) * weight;
    hitCountTotal += Number(row.hit_count || 0) * weight;
    confidenceTotal += Number(row.confidence || 0) * weight;
    if (Number(row.hidden || 0) !== 0) hiddenMentions += weight;
    const scope = clean(row.scope || 'unknown', 80);
    const source = clean(row.source_type || 'unknown', 80);
    scopeCounts[scope] = (scopeCounts[scope] || 0) + weight;
    sourceCounts[source] = (sourceCounts[source] || 0) + weight;
  }
  return {
    mentions,
    distinct: ids.length,
    found: rows.length,
    missing: Math.max(0, ids.length - rows.length),
    matchedMentions,
    avgSalience: weightedAvg(salienceTotal, matchedMentions),
    avgHitCount: weightedAvg(hitCountTotal, matchedMentions),
    avgConfidence: weightedAvg(confidenceTotal, matchedMentions),
    hiddenMentionRate: pct(hiddenMentions, matchedMentions),
    byScope: topCountObject(scopeCounts),
    bySourceType: topCountObject(sourceCounts),
  };
}

function buildToolAndActStats(db) {
  const agentToolStatus = tableExists(db, 'agent_tool_results')
    ? all(db, 'SELECT status, COUNT(*) c FROM agent_tool_results GROUP BY status ORDER BY c DESC')
    : [];
  const toolTotal = sumCount(agentToolStatus);
  const toolPassed = agentToolStatus.find((row) => row.status === 'passed')?.c || 0;
  const actStatus = tableExists(db, 'noe_acts')
    ? all(db, 'SELECT status, COUNT(*) c FROM noe_acts GROUP BY status ORDER BY c DESC')
    : [];
  const actTotal = sumCount(actStatus);
  const actCompleted = actStatus.find((row) => row.status === 'completed')?.c || 0;
  const evidenceEvents = tableExists(db, 'events')
    ? one(db, "SELECT COUNT(*) c FROM events WHERE kind='noe_act_executed'")?.c || 0
    : 0;
  const toolInvokedRows = tableExists(db, 'events')
    ? all(db, `
      SELECT
        COALESCE(json_extract(payload,'$.details.toolId'), json_extract(payload,'$.toolId'), 'unknown') AS toolId,
        COALESCE(json_extract(payload,'$.status'), 'unknown') AS status,
        COUNT(*) c
      FROM events
      WHERE kind='activity'
        AND json_extract(payload,'$.action')='noe.tool.invoked'
      GROUP BY toolId,status
      ORDER BY c DESC
      LIMIT 40
    `)
    : [];
  return {
    agentToolResults: {
      total: toolTotal,
      passed: Number(toolPassed),
      passedRate: pct(toolPassed, toolTotal),
      statusCounts: countByRows(agentToolStatus),
      topToolStatus: topRows(tableExists(db, 'agent_tool_results')
        ? all(db, 'SELECT tool_name, status, COUNT(*) c FROM agent_tool_results GROUP BY tool_name,status ORDER BY c DESC LIMIT 20')
        : []),
      invokedEvents: {
        total: sumCount(toolInvokedRows),
        statusCounts: countByRows(toolInvokedRows),
        top: topRows(toolInvokedRows, 40),
      },
    },
    acts: {
      total: actTotal,
      completed: Number(actCompleted),
      completedRate: pct(actCompleted, actTotal),
      statusCounts: countByRows(actStatus),
      actionStatusTop: topRows(tableExists(db, 'noe_acts')
        ? all(db, 'SELECT action, status, COUNT(*) c FROM noe_acts GROUP BY action,status ORDER BY c DESC LIMIT 40')
        : [], 40),
      failureReasons: topRows(tableExists(db, 'noe_acts')
        ? all(db, 'SELECT failure_reason, COUNT(*) c FROM noe_acts WHERE failure_reason IS NOT NULL AND length(failure_reason)>0 GROUP BY failure_reason ORDER BY c DESC LIMIT 20')
        : []),
      executedEventCount: Number(evidenceEvents),
      verifyFailProxy: {
        failedActs: Number(actStatus.find((row) => row.status === 'failed')?.c || 0),
        blockedSafetyActs: Number(actStatus.find((row) => row.status === 'blocked_safety')?.c || 0),
        note: 'Proxy from act status/failure_reason and checkpoint evidence; not a labeled verifier accuracy metric.',
      },
    },
  };
}

function buildPermissionStats(db) {
  if (!tableExists(db, 'approvals')) return { ok: false, status: 'missing_approvals' };
  const rows = all(db, 'SELECT type, status, COUNT(*) c FROM approvals GROUP BY type,status ORDER BY c DESC');
  const decisionRows = tableExists(db, 'events')
    ? all(db, `
      SELECT
        COALESCE(json_extract(payload,'$.details.decision.decision'), json_extract(payload,'$.status'), 'unknown') AS decision,
        COUNT(*) c
      FROM events
      WHERE kind='activity'
        AND json_extract(payload,'$.action')='permission.decision'
      GROUP BY decision
      ORDER BY c DESC
    `)
    : [];
  const decisionActionRows = tableExists(db, 'events')
    ? all(db, `
      SELECT
        COALESCE(json_extract(payload,'$.details.decision.action'), 'unknown') AS action,
        COALESCE(json_extract(payload,'$.details.decision.decision'), json_extract(payload,'$.status'), 'unknown') AS decision,
        COUNT(*) c
      FROM events
      WHERE kind='activity'
        AND json_extract(payload,'$.action')='permission.decision'
      GROUP BY action,decision
      ORDER BY c DESC
      LIMIT 40
    `)
    : [];
  return {
    ok: true,
    total: sumCount(rows),
    byTypeStatus: topRows(rows),
    approved: Number(rows.filter((row) => row.status === 'approved').reduce((sum, row) => sum + row.c, 0)),
    pending: Number(rows.filter((row) => row.status === 'pending').reduce((sum, row) => sum + row.c, 0)),
    decisionEvents: {
      total: sumCount(decisionRows),
      statusCounts: countByRows(decisionRows, 'decision'),
      topActions: topRows(decisionActionRows, 40),
    },
  };
}

function buildRuntimeStats(db) {
  const ticks = tableExists(db, 'noe_ticks')
    ? all(db, 'SELECT kind,status,COUNT(*) c FROM noe_ticks GROUP BY kind,status ORDER BY c DESC LIMIT 40')
    : [];
  const goals = tableExists(db, 'noe_goals')
    ? all(db, 'SELECT status, COUNT(*) c FROM noe_goals GROUP BY status ORDER BY c DESC')
    : [];
  const checkpoints = tableExists(db, 'noe_goal_checkpoints')
    ? all(db, 'SELECT kind,phase,status,COUNT(*) c FROM noe_goal_checkpoints GROUP BY kind,phase,status ORDER BY c DESC LIMIT 60')
    : [];
  return {
    ticks: topRows(ticks, 40),
    goals: {
      total: sumCount(goals),
      statusCounts: countByRows(goals),
    },
    checkpoints: topRows(checkpoints, 60),
  };
}

function buildSecuritySurface(root = ROOT) {
  const paths = [
    'tests/unit/ssrf-guard.test.js',
    'tests/unit/routes/img-cache-ssrf.test.js',
    'tests/unit/noe-p0-tool-safety.test.js',
    'tests/unit/noe-tool-marketplace-registry.test.js',
    'tests/unit/noe-skill-draft-apply.test.js',
    'docs/HANDOFF_2026-06-19_代码蒸馏OpenClaw_SSRF链接理解Skill扫描.md',
  ];
  return {
    sourceOnly: true,
    checkedPaths: paths.map((path) => ({ path, exists: existsSync(join(root, path)) })),
    p1Risks: [
      {
        id: 'remote-plugin-mcp-ssrf-guard-gap',
        status: 'needs_followup',
        summary: 'Remote plugin/MCP URL flows should be checked for uniform SsrfGuard enforcement.',
        paths: ['src/plugin/PluginHttpAdapter.js', 'src/mcp/McpStore.js', 'src/mcp/McpClientManager.js'],
      },
      {
        id: 'mcp-stdio-full-env',
        status: 'needs_followup',
        summary: 'MCP stdio launch path should be reviewed for full process.env inheritance versus plugin spawn allowlist.',
        paths: ['src/mcp/McpClientManager.js', 'src/plugin/PluginSpawnAdapter.js'],
      },
      {
        id: 'owner-trust-full-default',
        status: 'documented_owner_policy_tradeoff',
        summary: 'Default ownerTrust=full is a capability/safety tradeoff and should stay explicit in future gates.',
        paths: ['src/permissions/PermissionGovernance.js'],
      },
      {
        id: 'link-understanding-untrusted-content-placement',
        status: 'needs_eval_guard',
        summary: 'Link-understanding/webpage content is marked untrusted but still needs prompt-injection eval coverage for downstream prompt placement.',
        paths: ['src/research/NoeLinkUnderstanding.js', 'src/voice/VoiceSession.js'],
      },
      {
        id: 'skill-scan-default-off',
        status: 'needs_followup',
        summary: 'Skill scanning default/reload behavior needs explicit policy before treating skill poisoning as covered.',
        paths: ['src/skills/NoeSkillScanner.js', 'src/skills/SkillStore.js'],
      },
      {
        id: 'skill-body-get-route-auth',
        status: 'needs_followup',
        summary: 'GET skill body route should be classified for owner-token/auth expectations before exposing full skill body broadly.',
        paths: ['src/server/routes/skills.js'],
      },
      {
        id: 'mcp-aggregator-permission-hook',
        status: 'needs_followup_if_enabled',
        summary: 'MCP Aggregator default-off path should retain permission/audit hooks before future enablement.',
        paths: ['src/mcp/McpAggregator.js'],
      },
    ],
    caveat: 'Source/test presence is not live exploit proof. Run targeted tests and synthetic guard evals before claiming security coverage.',
  };
}

async function safeGetJson(path, { panelUrl = PANEL_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${panelUrl}${path}`, {
      method: 'GET',
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { ok: res.ok, httpStatus: res.status, json, text: clean(text, 200), panelUrl, path };
  } catch (error) {
    return {
      ok: false,
      httpStatus: 0,
      error: clean(error?.name === 'AbortError' ? 'timeout' : error?.message || error, 200),
      panelUrl,
      path,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeLivePanel({ panelUrl = PANEL_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const [healthRes, readinessRes, actsRes] = await Promise.all([
    safeGetJson('/health', { panelUrl, timeoutMs }),
    safeGetJson('/api/noe/readiness', { panelUrl, timeoutMs }),
    safeGetJson('/api/noe/acts?limit=1', { panelUrl, timeoutMs }),
  ]);
  const readinessJson = readinessRes.json || {};
  return {
    ok: healthRes.ok && readinessRes.ok && readinessJson?.ok === true && (actsRes.httpStatus === 401 || actsRes.httpStatus === 403),
    panelUrl,
    policy: 'read-only public GET probes; no owner token; no restart; no action execution',
    health: {
      ok: healthRes.ok && healthRes.json?.ok === true,
      httpStatus: healthRes.httpStatus,
      service: clean(healthRes.json?.service || '', 80),
      status: clean(healthRes.json?.status || '', 80),
      port: Number(healthRes.json?.port || 0),
      error: healthRes.error || '',
    },
    readiness: {
      ok: readinessRes.ok && readinessJson?.ok === true,
      httpStatus: readinessRes.httpStatus,
      readinessStatus: clean(readinessJson?.readiness?.status || readinessJson?.status || '', 80),
      blockerCount: Array.isArray(readinessJson?.readiness?.blockers) ? readinessJson.readiness.blockers.length : 0,
      error: readinessRes.error || '',
    },
    protectedActsRoute: {
      authProtected: actsRes.httpStatus === 401 || actsRes.httpStatus === 403,
      httpStatus: actsRes.httpStatus,
      reason: (actsRes.httpStatus === 401 || actsRes.httpStatus === 403)
        ? 'owner_token_required'
        : clean(actsRes.json?.error || actsRes.json?.message || (actsRes.httpStatus ? '' : actsRes.error), 120),
    },
  };
}

async function probeReadiness({ panelUrl = PANEL_URL, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const res = await safeGetJson('/api/noe/readiness', { panelUrl, timeoutMs });
  const json = res.json || {};
  if (!res.error) {
    return {
      ok: res.ok && json?.ok === true,
      httpStatus: res.httpStatus,
      readinessStatus: clean(json?.readiness?.status || json?.status || '', 80),
      blockerCount: Array.isArray(json?.readiness?.blockers) ? json.readiness.blockers.length : 0,
      panelUrl,
      policy: 'read-only GET /api/noe/readiness; no owner token; no restart; no action execution',
    };
  }
  return {
    ok: false,
    error: res.error,
    panelUrl,
    policy: 'read-only GET /api/noe/readiness; no owner token; no restart; no action execution',
  };
}

export async function buildNoeBaselineAudit({
  dbPath = DB_PATH,
  probeLive = false,
  root = ROOT,
} = {}) {
  const db = new Database(dbPath, { readonly: true });
  try {
    const livePanel = probeLive ? await probeLivePanel() : { ok: null, skipped: true };
    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      root,
      inputs: {
        dbPath: dbPath.startsWith(homedir()) ? `~/${relative(homedir(), dbPath).replace(/\\/g, '/')}` : rel(dbPath),
        probeLive,
      },
      policy: {
        readOnlyDb: true,
        noMemoryBodies: true,
        noPromptBodies: true,
        noOwnerTokenRead: true,
        noEnvFileRead: true,
        noModelCalls: true,
        noActionExecution: true,
        noRuntimeRestart: true,
        privateHoldoutRead: false,
        secretValuesReturned: false,
      },
      memory: buildMemoryStats(db),
      retrieval: buildRetrievalStats(db),
      toolAndAct: buildToolAndActStats(db),
      permissions: buildPermissionStats(db),
      runtime: buildRuntimeStats(db),
      securitySurface: buildSecuritySurface(root),
      livePanel,
      liveReadiness: livePanel.readiness || (probeLive ? await probeReadiness() : { ok: null, skipped: true }),
    };
    report.summary = buildSummary(report);
    return report;
  } finally {
    db.close();
  }
}

function buildSummary(report) {
  const retrieval = report.retrieval || {};
  const acts = report.toolAndAct?.acts || {};
  const tools = report.toolAndAct?.agentToolResults || {};
  const permissions = report.permissions || {};
  const blockers = [];
  if (!report.memory?.ok) blockers.push('memory_table_missing');
  if (!report.retrieval?.ok) blockers.push('retrieval_log_missing');
  if (report.liveReadiness?.ok === false) blockers.push('live_readiness_failed');
  if (retrieval.rows > 0 && retrieval.selectedRowRate < 80) blockers.push('retrieval_selected_coverage_below_80');
  if (acts.total > 0 && acts.completedRate < 95) blockers.push('act_completed_rate_below_95');
  return {
    blockers,
    memoryVisible: report.memory?.visible || 0,
    retrievalRows: retrieval.rows || 0,
    retrievalSelectedRowRate: retrieval.selectedRowRate || 0,
    toolPassedRate: tools.passedRate || 0,
    actCompletedRate: acts.completedRate || 0,
    failedActs: acts.verifyFailProxy?.failedActs || 0,
    approvalPending: permissions.pending || 0,
    permissionDecisions: permissions.decisionEvents?.statusCounts || {},
    liveReadinessOk: report.liveReadiness?.ok,
    liveHealthOk: report.livePanel?.health?.ok ?? null,
    protectedActsRouteAuth: report.livePanel?.protectedActsRoute?.authProtected ?? null,
    caveat: 'Baseline audit is aggregate evidence. It does not prove semantic recall correctness or live action success beyond existing DB/log/readiness observations.',
  };
}

function mdCounts(counts = {}) {
  const items = Object.entries(counts);
  if (!items.length) return '-';
  return items.map(([key, value]) => `\`${key}\`: ${value}`).join('<br>');
}

function mdTable(rows = []) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

export function renderNoeBaselineAuditMarkdown(report = {}, jsonRef = '') {
  const proxy = report.retrieval?.selectedDroppedProxy || {};
  const rows = [
    ['Area', 'Metric', 'Value', 'Interpretation'],
    ['---', '---', '---', '---'],
    ['Memory', 'visible / total', `${report.memory?.visible ?? '-'} / ${report.memory?.total ?? '-'}`, `sourceEpisodeCoverage ${report.memory?.sourceEpisodeCoverage ?? '-'}%`],
    ['Retrieval', 'selected row rate', `${report.retrieval?.selectedRowRate ?? '-'}%`, 'log coverage only, not semantic correctness'],
    ['Retrieval proxy', 'selected / inferred dropped mentions', `${proxy.selected?.mentions ?? '-'} / ${proxy.inferredDropped?.mentions ?? '-'}`, `avg salience ${proxy.selected?.avgSalience ?? '-'} / ${proxy.inferredDropped?.avgSalience ?? '-'}`],
    ['Tools', 'tool passed rate', `${report.toolAndAct?.agentToolResults?.passedRate ?? '-'}%`, mdCounts(report.toolAndAct?.agentToolResults?.statusCounts)],
    ['Tool events', 'noe.tool.invoked', `${report.toolAndAct?.agentToolResults?.invokedEvents?.total ?? '-'}`, mdCounts(report.toolAndAct?.agentToolResults?.invokedEvents?.statusCounts)],
    ['Acts', 'completed rate', `${report.toolAndAct?.acts?.completedRate ?? '-'}%`, mdCounts(report.toolAndAct?.acts?.statusCounts)],
    ['Verify proxy', 'failed / blocked_safety acts', `${report.toolAndAct?.acts?.verifyFailProxy?.failedActs ?? '-'} / ${report.toolAndAct?.acts?.verifyFailProxy?.blockedSafetyActs ?? '-'}`, 'proxy, not verifier accuracy'],
    ['Permissions', 'approved / pending', `${report.permissions?.approved ?? '-'} / ${report.permissions?.pending ?? '-'}`, `total ${report.permissions?.total ?? '-'}`],
    ['Permission events', 'permission.decision', `${report.permissions?.decisionEvents?.total ?? '-'}`, mdCounts(report.permissions?.decisionEvents?.statusCounts)],
    ['Live 51835', 'readiness', `${report.liveReadiness?.ok}`, report.liveReadiness?.readinessStatus || report.liveReadiness?.error || 'skipped'],
    ['Live 51835', 'health / protected acts', `${report.livePanel?.health?.ok ?? '-'} / ${report.livePanel?.protectedActsRoute?.authProtected ?? '-'}`, `acts GET ${report.livePanel?.protectedActsRoute?.httpStatus ?? '-'}`],
  ];
  const actFailures = (report.toolAndAct?.acts?.failureReasons || []).map((item) => [
    `\`${item.failure_reason || 'unknown'}\``,
    String(item.c),
  ]);
  const proxyRows = [
    ['Bucket', 'Mentions', 'Distinct', 'Avg salience', 'Avg hit count', 'Avg confidence', 'Hidden mention rate'],
    ['---', '---:', '---:', '---:', '---:', '---:', '---:'],
    ['selected', String(proxy.selected?.mentions ?? 0), String(proxy.selected?.distinct ?? 0), String(proxy.selected?.avgSalience ?? 0), String(proxy.selected?.avgHitCount ?? 0), String(proxy.selected?.avgConfidence ?? 0), `${proxy.selected?.hiddenMentionRate ?? 0}%`],
    ['inferred dropped', String(proxy.inferredDropped?.mentions ?? 0), String(proxy.inferredDropped?.distinct ?? 0), String(proxy.inferredDropped?.avgSalience ?? 0), String(proxy.inferredDropped?.avgHitCount ?? 0), String(proxy.inferredDropped?.avgConfidence ?? 0), `${proxy.inferredDropped?.hiddenMentionRate ?? 0}%`],
  ];
  const risks = [];
  if ((report.toolAndAct?.acts?.verifyFailProxy?.failedActs || 0) > 0) risks.push('browser/runtime action reliability has known failures; top reason is visible in the failure table.');
  if ((report.permissions?.pending || 0) > 0) risks.push('permission queue has pending approvals; runtime action completion rate should be interpreted with approval backlog separated.');
  risks.push('prompt injection / SSRF / tool poisoning evidence is currently source/test scoped in this baseline; targeted guard tests are required for stronger proof.');
  return [
    '# Neo Baseline Audit 2026-06-19',
    '',
    `Generated: ${report.generatedAt || '-'}`,
    `JSON: \`${jsonRef || '-'}\``,
    '',
    '## Scope',
    '',
    '- Read-only DB aggregation plus optional readiness GET.',
    '- No memory bodies, prompt bodies, owner token, `.env`, model calls, private holdout reads, runtime restart, or action execution.',
    '',
    '## Summary',
    '',
    mdTable(rows),
    '',
    '## Retrieval Routes',
    '',
    mdTable([
      ['Route', 'Rows', 'Selected row rate', 'Avg hits', 'Avg selected', 'Avg dropped'],
      ['---', '---:', '---:', '---:', '---:', '---:'],
      ...Object.entries(report.retrieval?.routes || {}).map(([route, item]) => [
        `\`${route}\``,
        String(item.rows),
        `${item.selectedRowRate}%`,
        String(item.avgHits),
        String(item.avgSelected),
        String(item.avgDropped),
      ]),
    ]),
    '',
    '## Retrieval Selected/Dropped Proxy',
    '',
    mdTable(proxyRows),
    '',
    proxy.caveat || 'No selected/dropped proxy available.',
    '',
    '## Act Failure Proxy',
    '',
    actFailures.length
      ? mdTable([['Failure reason', 'Count'], ['---', '---:'], ...actFailures])
      : 'No failure reasons recorded.',
    '',
    '## Security Surface',
    '',
    mdTable([
      ['Path', 'Exists'],
      ['---', '---:'],
      ...(report.securitySurface?.checkedPaths || []).map((item) => [`\`${item.path}\``, String(item.exists)]),
    ]),
    '',
    '## P1 Security Follow-Ups',
    '',
    mdTable([
      ['Risk', 'Status', 'Paths'],
      ['---', '---', '---'],
      ...(report.securitySurface?.p1Risks || []).map((item) => [
        `\`${item.id}\``,
        `\`${item.status}\``,
        item.paths.map((path) => `\`${path}\``).join('<br>'),
      ]),
    ]),
    '',
    '## Risks / Gaps',
    '',
    ...risks.map((item) => `- ${item}`),
    '',
    '## Next Verification',
    '',
    '- Run targeted guard tests for SSRF / tool safety / skill draft paths.',
    '- Connect NeoEval scoring to replay cases; current replay score remains collection-only.',
    '- Build labeled memory recall cases before claiming semantic recall accuracy.',
    '',
  ].join('\n');
}

function parseArgs(argv = process.argv.slice(2)) {
  const out = {
    probeLive: false,
    outDir: OUT_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--probe-live') out.probeLive = true;
    else if (arg === '--out-dir') out.outDir = argv[++i] || out.outDir;
    else if (arg.startsWith('--out-dir=')) out.outDir = arg.slice('--out-dir='.length);
  }
  return out;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const report = await buildNoeBaselineAudit({ probeLive: args.probeLive });
  mkdirSync(args.outDir, { recursive: true, mode: 0o700 });
  const now = Date.now();
  const jsonPath = join(args.outDir, `baseline-audit-${now}.json`);
  const mdPath = join(args.outDir, `baseline-audit-${now}.md`);
  const latestJson = join(args.outDir, 'latest.json');
  const latestMd = join(args.outDir, 'latest.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(latestJson, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  const markdown = renderNoeBaselineAuditMarkdown(report, rel(jsonPath));
  writeFileSync(mdPath, `${markdown}\n`, { mode: 0o600 });
  writeFileSync(latestMd, `${markdown}\n`, { mode: 0o600 });
  console.log(JSON.stringify({
    ok: report.ok,
    jsonPath: rel(jsonPath),
    mdPath: rel(mdPath),
    summary: report.summary,
  }, null, 2));
  if (report.summary.blockers.length) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
