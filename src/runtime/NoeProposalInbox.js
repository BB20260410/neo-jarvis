import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { redactSensitiveText } from './NoeContextScrubber.js';
import { executeNoeProposalMaterialization } from './NoeProposalExecutor.js';
import {
  decorateNoeProposalWithDecision,
  latestNoeProposalDecisionByProposalId,
  listNoeProposalDecisions,
  recordNoeProposalDecision,
} from './NoeProposalDecisionLedger.js';

export const NOE_PROPOSAL_INBOX_SCHEMA_VERSION = 1;

const SOURCE_DIRS = {
  background_review: 'output/noe-background-review',
  boot_self_check: 'output/noe-boot-self-check',
  skill_curator: 'output/noe-skill-curator/reports',
  self_model: 'output/noe-self-model-proposals',
};

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function safeJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function refFor(root, file) {
  const rel = relative(root, file);
  if (rel && !rel.startsWith('..') && rel !== '..' && !rel.startsWith('/')) return rel.replaceAll('\\', '/');
  return file;
}

function safeId(...parts) {
  const raw = parts.map((part) => clean(part, 500)).filter(Boolean).join('|');
  return createHash('sha1').update(raw || String(Date.now())).digest('hex').slice(0, 16);
}

// 稳定地序列化任意值（对象键排序），用于内容指纹，避免键顺序导致 hash 漂移。
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

// 对一段内容算脱敏指纹（16 hex），既能区分内容差异、又不暴露明文值。
export function contentFingerprint(value) {
  return createHash('sha1').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function listJsonFiles(root, source) {
  const dir = resolve(root, SOURCE_DIRS[source]);
  if (!existsSync(dir)) return [];
  // boot_self_check 与 self_model 生成器都双写 latest.json + 时间戳文件(同 payload),
  // 若两者都读会让同一逻辑提案产生多条 inbox 条目(id 含 reportRef 故各异)→ 重复 approve/物化。
  // 优先只读 latest.json 从源头去重;无 latest.json 时(如旧数据/测试)回退读全目录。
  if (source === 'boot_self_check' || source === 'self_model') {
    const latest = resolve(dir, 'latest.json');
    if (existsSync(latest)) {
      let mtimeMs = 0;
      try { mtimeMs = statSync(latest).mtimeMs; } catch {}
      return [{ file: latest, mtimeMs }];
    }
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => resolve(dir, name))
    .filter((file) => file.startsWith(`${dir}/`) || file === dir)
    .map((file) => {
      let mtimeMs = 0;
      try { mtimeMs = statSync(file).mtimeMs; } catch {}
      return { file, mtimeMs };
    });
}

function titleFromItem(item = {}, fallback = 'Noe proposal') {
  return clean(item.title || item.name || item.text || item.description || item.body || fallback, 160);
}

function summaryFromItem(item = {}, fallback = '') {
  return clean(item.summary || item.description || item.reason || item.text || item.body || fallback, 500);
}

function baseItem({
  root,
  source,
  reportFile,
  reportRef,
  createdAt,
  kind,
  type,
  tool = '',
  status = 'proposed',
  title,
  summary = '',
  raw = {},
  patchContentHash = '',
}) {
  const id = `proposal-${safeId(source, reportRef, kind, type, title, JSON.stringify(raw).slice(0, 500))}`;
  return {
    id,
    schemaVersion: NOE_PROPOSAL_INBOX_SCHEMA_VERSION,
    source,
    sourceReportRef: reportRef || refFor(root, reportFile),
    reportFileName: basename(reportFile),
    createdAt: clean(createdAt, 80),
    kind: clean(kind, 80),
    type: clean(type, 120),
    tool: clean(tool, 120),
    status: clean(status || 'proposed', 80) || 'proposed',
    title: clean(title, 200),
    summary: clean(summary, 800),
    proposalOnly: true,
    applySupported: false,
    requiresGatedApply: true,
    decisionSupported: true,
    // 脱敏的内容指纹：随 apply 的实际负载（如 self-model patch 值）变化而变化，
    // 让审批 hash 绑定具体内容、消除 approve→篡改→apply 的 TOCTOU。空表示该类提案无独立内容负载。
    patchContentHash: clean(patchContentHash, 32),
    directWrites: [],
    raw,
  };
}

function backgroundReviewItems(root, file, report) {
  const reportRef = refFor(root, file);
  const proposals = Array.isArray(report?.proposals) ? report.proposals : [];
  return proposals.map((proposal = {}) => {
    const item = proposal.item && typeof proposal.item === 'object' ? proposal.item : {};
    return baseItem({
      root,
      source: 'background_review',
      reportFile: file,
      reportRef,
      createdAt: proposal.createdAt || report.finishedAt || report.startedAt,
      kind: proposal.kind || 'review',
      type: proposal.tool || `background_${proposal.kind || 'proposal'}`,
      tool: proposal.tool || '',
      status: proposal.status || 'proposed',
      title: titleFromItem(item, `${proposal.kind || 'background'} proposal`),
      summary: summaryFromItem(item, ''),
      raw: {
        proposalId: clean(proposal.id, 160),
        item,
        risks: Array.isArray(report.risks) ? report.risks.slice(0, 20).map((risk) => clean(risk, 300)) : [],
        context: report.context || {},
      },
    });
  });
}

function skillCuratorItems(root, file, report) {
  const reportRef = refFor(root, file);
  const createdAt = report?.createdAt;
  const out = [];
  for (const item of Array.isArray(report?.pruned) ? report.pruned : []) {
    out.push(baseItem({
      root,
      source: 'skill_curator',
      reportFile: file,
      reportRef,
      createdAt,
      kind: 'skill',
      type: 'skill_archive_candidate',
      tool: 'skill_archive_proposal',
      title: `Archive skill candidate: ${clean(item.name, 120)}`,
      summary: clean(item.reason || item.action || 'archive candidate', 300),
      raw: item,
    }));
  }
  for (const item of Array.isArray(report?.consolidated) ? report.consolidated : []) {
    out.push(baseItem({
      root,
      source: 'skill_curator',
      reportFile: file,
      reportRef,
      createdAt,
      kind: 'skill',
      type: 'skill_consolidation_candidate',
      tool: 'skill_consolidation_proposal',
      title: `Consolidate skills: ${(Array.isArray(item.skills) ? item.skills : []).map((name) => clean(name, 80)).join(', ')}`,
      summary: clean(item.key || item.action || 'consolidation candidate', 300),
      raw: item,
    }));
  }
  for (const item of Array.isArray(report?.stateTransitions) ? report.stateTransitions : []) {
    out.push(baseItem({
      root,
      source: 'skill_curator',
      reportFile: file,
      reportRef,
      createdAt,
      kind: 'skill',
      type: 'skill_state_transition_candidate',
      tool: 'skill_state_transition_proposal',
      title: `Skill state transition: ${clean(item.name, 120)}`,
      summary: `${clean(item.from, 80)} -> ${clean(item.to, 80)} (${clean(item.action, 120)})`,
      raw: item,
    }));
  }
  for (const item of Array.isArray(report?.items) ? report.items : []) {
    if (item?.action !== 'propose_review') continue;
    out.push(baseItem({
      root,
      source: 'skill_curator',
      reportFile: file,
      reportRef,
      createdAt,
      kind: 'skill',
      type: 'skill_review_candidate',
      tool: 'skill_review_proposal',
      title: `Review stale skill: ${clean(item.name, 120)}`,
      summary: `inactive_for_${Number(item.daysInactive) || 0}_days`,
      raw: item,
    }));
  }
  return out;
}

function selfModelProposalItems(root, file, report) {
  const proposal = report?.proposal;
  if (!proposal || proposal.status !== 'proposed') return [];
  const reportRef = refFor(root, file);
  const patchFields = Object.keys(proposal.patch || {}).sort();
  return [baseItem({
    root,
    source: 'self_model',
    reportFile: file,
    reportRef,
    createdAt: proposal.createdAt || report.generatedAtIso || report.generatedAt,
    kind: 'identity',
    type: 'self_model_diff',
    tool: 'self_model_proposal',
    status: proposal.status || 'proposed',
    title: `Self-model diff proposal: ${patchFields.join(', ') || 'identity'}`,
    summary: proposal.reason || 'Evidence-backed self-model proposal.',
    // patch 实际值（含明文）的脱敏指纹，apply 时用它校验 latest.json 未被篡改。
    patchContentHash: contentFingerprint(proposal.patch || {}),
    raw: {
      proposalId: clean(proposal.proposalId, 160),
      proposalStatus: clean(proposal.status, 80),
      requiresOwnerConfirmation: proposal.requiresOwnerConfirmation === true,
      patchFields,
      evidenceRefs: Array.isArray(proposal.evidenceRefs)
        ? proposal.evidenceRefs.map((ref) => clean(ref, 300)).slice(0, 20)
        : [],
      sourceDecision: clean(report.decision, 80),
    },
  })];
}

function repairPlanActionById(report = {}) {
  const byId = new Map();
  for (const check of Array.isArray(report?.checks) ? report.checks : []) {
    const repairPlan = check?.detail?.repairPlan || {};
    for (const action of Array.isArray(repairPlan.actions) ? repairPlan.actions : []) {
      if (action?.id) byId.set(clean(action.id, 200), { checkId: clean(check.id, 120), ...action });
    }
  }
  return byId;
}

function bootSelfCheckProposalItems(root, file, report) {
  const reportRef = refFor(root, file);
  const repair = report?.selfRepair || report?.repair || {};
  const manualFollowups = Array.isArray(repair.manualFollowups) ? repair.manualFollowups : [];
  if (!manualFollowups.length) return [];
  const planById = repairPlanActionById(report);
  return manualFollowups.map((followup = {}) => {
    const actionId = clean(followup.id, 200);
    const plan = planById.get(actionId) || {};
    const title = clean(plan.title || followup.label || actionId || '开机自检人工修复项', 220);
    const tool = clean(plan.tool || 'boot_self_check', 120);
    return baseItem({
      root,
      source: 'boot_self_check',
      reportFile: file,
      reportRef,
      createdAt: report?.at || report?.generatedAt || report?.finishedAt,
      kind: 'runtime_repair',
      type: 'boot_self_check_manual_repair',
      tool: tool || 'boot_self_check',
      status: 'proposed',
      title,
      summary: clean(plan.reason || followup.label || '开机自检发现需要主人确认的人工修复项。', 600),
      raw: {
        checkId: clean(followup.checkId || plan.checkId, 120),
        actionId,
        title,
        tool,
        warning: clean(plan.warning, 160),
        currentPath: clean(plan.currentPath, 500),
        currentVersion: clean(plan.currentVersion, 120),
        targetPath: clean(plan.targetPath, 500),
        targetVersion: clean(plan.targetVersion, 120),
        verification: Array.isArray(plan.verification) ? plan.verification.map((item) => clean(item, 200)).slice(0, 12) : [],
        bootReportStatus: clean(report?.summary?.status || report?.status, 80),
        bootReportRef: reportRef,
        policy: {
          ownerConfirmationRequired: true,
          proposalOnly: true,
          noPathMutation: true,
          noPackageInstall: true,
          noConfigRead: true,
          noSecretRead: true,
          noProcessRestart: true,
        },
      },
    });
  });
}

function loadSourceItems(root, source) {
  const files = listJsonFiles(root, source);
  const items = [];
  const errors = [];
  for (const { file, mtimeMs } of files) {
    const report = safeJson(file);
    if (!report) {
      errors.push({ source, reportRef: refFor(root, file), error: 'json_parse_failed' });
      continue;
    }
    let next = [];
    if (source === 'background_review') next = backgroundReviewItems(root, file, report);
    else if (source === 'boot_self_check') next = bootSelfCheckProposalItems(root, file, report);
    else if (source === 'skill_curator') next = skillCuratorItems(root, file, report);
    else if (source === 'self_model') next = selfModelProposalItems(root, file, report);
    for (const item of next) items.push({ ...item, reportMtimeMs: mtimeMs });
  }
  return { items, errors };
}

export function listNoeProposalInbox({
  root = process.cwd(),
  source = '',
  limit = 100,
  status = '',
  includeRaw = false,
} = {}) {
  const rootAbs = resolve(root);
  const sources = source ? [source] : Object.keys(SOURCE_DIRS);
  const errors = [];
  let items = [];
  for (const src of sources) {
    if (!SOURCE_DIRS[src]) {
      errors.push({ source: clean(src, 80), error: 'unknown_source' });
      continue;
    }
    const result = loadSourceItems(rootAbs, src);
    errors.push(...result.errors);
    items.push(...result.items);
  }
  const decisions = listNoeProposalDecisions({ root: rootAbs });
  errors.push(...decisions.errors);
  const latestDecisions = latestNoeProposalDecisionByProposalId(decisions.decisions);
  items = items.map((item) => decorateNoeProposalWithDecision(item, latestDecisions.get(item.id)));
  const wantedStatus = clean(status, 80);
  if (wantedStatus) items = items.filter((item) => item.status === wantedStatus);
  items.sort((a, b) => {
    const at = Date.parse(a.createdAt || '') || a.reportMtimeMs || 0;
    const bt = Date.parse(b.createdAt || '') || b.reportMtimeMs || 0;
    return bt - at || a.id.localeCompare(b.id);
  });
  const max = Math.max(1, Math.min(500, Math.trunc(Number(limit) || 100)));
  const sliced = items.slice(0, max).map(({ reportMtimeMs: _reportMtimeMs, raw, ...item }) => {
    const out = {
      ...item,
      preview: {
        title: item.title,
        summary: item.summary,
      },
    };
    if (includeRaw) out.raw = raw;
    return out;
  });
  return {
    ok: true,
    schemaVersion: NOE_PROPOSAL_INBOX_SCHEMA_VERSION,
    sources,
    counts: {
      total: items.length,
      returned: sliced.length,
      bySource: Object.fromEntries(Object.keys(SOURCE_DIRS).map((src) => [src, items.filter((item) => item.source === src).length])),
    },
    proposals: sliced,
    errors,
  };
}

export function getNoeProposalInboxItem({ root = process.cwd(), id = '', includeRaw = false } = {}) {
  const inbox = listNoeProposalInbox({ root, limit: 500, includeRaw });
  const item = inbox.proposals.find((proposal) => proposal.id === id);
  if (!item) return { ok: false, error: 'proposal_not_found', id: clean(id, 200) };
  return { ok: true, proposal: item };
}

export function decideNoeProposalInboxItem({
  root = process.cwd(),
  id = '',
  decision = '',
  reason = '',
  actor = 'owner',
  confirmOwner = false,
  now = new Date(),
} = {}) {
  const found = getNoeProposalInboxItem({ root, id });
  if (!found.ok) return found;
  const recorded = recordNoeProposalDecision({
    root,
    proposal: found.proposal,
    decision,
    reason,
    actor,
    confirmOwner,
    now,
  });
  if (!recorded.ok) return recorded;
  return {
    ok: true,
    decision: recorded.decision,
    proposal: decorateNoeProposalWithDecision(found.proposal, recorded.decision),
  };
}

export function executeNoeProposalInboxItem({
  root = process.cwd(),
  id = '',
  dryRun = true,
  confirmOwner = false,
  now = new Date(),
} = {}) {
  const found = getNoeProposalInboxItem({ root, id, includeRaw: true });
  if (!found.ok) return found;
  return executeNoeProposalMaterialization({
    root,
    proposal: found.proposal,
    dryRun,
    confirmOwner,
    now,
  });
}
