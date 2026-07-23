#!/usr/bin/env node
// @ts-check
// Read-only audit for the user-provided Neo v4 complete-index document.
// It treats the index as a roadmap/reference, not as current runtime proof.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_V4_INDEX_CLAIM_AUDIT_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_V4_INDEX_CLAIM_AUDIT_BASENAME || 'v4-index-claim-audit-2026-06-15';
const DEFAULT_INDEX_PATH = process.env.NOE_V4_INDEX_PATH
  || join(ROOT, 'output', 'noe-2026-06-14-deep-research', '06-reviews', '26-neo-overall-plan-v4.md');

const DEFAULT_PATHS = {
  v4Index: DEFAULT_INDEX_PATH,
  runtimeEvidence: join(ROOT, 'output', 'noe-runtime-evidence', 'latest.json'),
  goalCompletionAudit: join(ROOT, 'output', 'noe-audit', 'goal-completion-audit-2026-06-15.json'),
  lineSemantics: join(ROOT, 'output', 'noe-audit', 'line-semantics-audit-2026-06-15.json'),
  selfEvolutionReadiness: join(ROOT, 'output', 'noe-audit', 'self-evolution-readiness-audit-2026-06-15.json'),
  naturalRuntimeEvidence: join(ROOT, 'output', 'noe-audit', 'natural-runtime-evidence-audit-2026-06-15.json'),
};

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value = '', max = 500) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, '[email]')
    .replace(/Bearer\s+\S+/gi, 'Bearer [key]')
    .replace(/token[=:]\S+/gi, 'token=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function readJson(path) {
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readText(path) {
  if (!path || !existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function rel(path, root = ROOT) {
  const value = String(path || '');
  return value.startsWith(`${root}/`) ? value.slice(root.length + 1) : value;
}

function inc(counts, key, amount = 1) {
  counts[key] = (counts[key] || 0) + amount;
}

function lineCount(path) {
  if (!path || !existsSync(path)) return 0;
  const text = readFileSync(path, 'utf8');
  if (!text) return 0;
  return text.endsWith('\n') ? text.split(/\r?\n/).length - 1 : text.split(/\r?\n/).length;
}

function latestMtime(paths = []) {
  let latest = 0;
  for (const path of paths) {
    try {
      if (path && existsSync(path)) latest = Math.max(latest, statSync(path).mtimeMs);
    } catch {}
  }
  return latest ? new Date(latest).toISOString() : '';
}

function sourceContains(pattern, files = [], root = ROOT) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
  return files.some((file) => re.test(readText(join(root, file))));
}

function listFilesRecursive(dir, limit = 5000) {
  const out = [];
  function walk(current) {
    if (out.length >= limit || !existsSync(current)) return;
    for (const name of readdirSync(current)) {
      if (out.length >= limit) return;
      if (name === 'node_modules' || name === '.git' || name === 'output') continue;
      const path = join(current, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (st.isDirectory()) walk(path);
      else if (/\.(?:js|mjs|ts|tsx|jsx)$/.test(name)) out.push(path);
    }
  }
  walk(dir);
  return out;
}

function sourceTreeContains(pattern, dir = join(ROOT, 'src')) {
  const re = pattern instanceof RegExp ? pattern : new RegExp(String(pattern), 'i');
  return listFilesRecursive(dir).some((file) => re.test(readText(file)));
}

function dimensionMap(runtimeEvidence = {}) {
  return new Map(arr(runtimeEvidence.awakeningDimensions?.dimensions).map((item) => [item.id, item]));
}

function modelEvidence(goalAudit = {}, runtimeEvidence = {}) {
  const liveLm = goalAudit.live?.localModels?.lmStudio;
  const liveOllama = goalAudit.live?.localModels?.ollama;
  const rtLm = runtimeEvidence.localModels?.lmstudio;
  const rtOllama = runtimeEvidence.localModels?.ollama;
  return {
    lmStudio: {
      count: liveLm?.count ?? rtLm?.modelCount ?? 0,
      models: arr(liveLm?.models || rtLm?.models).map((model) => clean(model, 120)),
    },
    ollama: {
      count: liveOllama?.count ?? rtOllama?.modelCount ?? 0,
      models: arr(liveOllama?.models || rtOllama?.models).map((model) => clean(model, 120)),
    },
  };
}

function claim(id, title, indexClaim, status, evidence, adjustment) {
  return {
    id,
    title,
    indexClaim: clean(indexClaim, 800),
    status,
    evidence,
    adjustment: clean(adjustment, 800),
  };
}

export function buildNoeV4IndexClaimAudit({
  root = ROOT,
  paths = DEFAULT_PATHS,
  now = new Date(),
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const indexText = readText(resolvedPaths.v4Index);
  const runtimeEvidence = readJson(resolvedPaths.runtimeEvidence);
  const goalAudit = readJson(resolvedPaths.goalCompletionAudit);
  const lineSemantics = readJson(resolvedPaths.lineSemantics);
  const selfEvolutionReadiness = readJson(resolvedPaths.selfEvolutionReadiness);
  const naturalRuntimeEvidence = readJson(resolvedPaths.naturalRuntimeEvidence);
  const dims = dimensionMap(runtimeEvidence);
  const models = modelEvidence(goalAudit, runtimeEvidence);
  const d1 = dims.get('D1_self_awareness') || {};
  const d2 = dims.get('D2_self_decision') || {};
  const d3 = dims.get('D3_self_evolution') || {};
  const d4 = dims.get('D4_self_boundary') || {};
  const d5 = dims.get('D5_ai_welfare') || {};
  const mcpRouteText = readText(join(root, 'src', 'server', 'routes', 'mcp.js'));
  const affectPath = join(root, 'src', 'cognition', 'NoeAffectHealth.js');
  const sleepPath = join(root, 'src', 'cognition', 'NoeSleepTimeCompute.js');
  const archivePath = join(root, 'src', 'room', 'NoeEvolutionArchive.js');
  const testFiles = Number(arr(lineSemantics.byModule).find((item) => item.module === 'tests')?.files || 0);
  const claims = [
    claim(
      'index_loaded',
      '附件 v4 索引可作为路线图输入',
      '完整索引给别的 AI / 投资人 / 工程师看',
      indexText.trim() ? 'supported_by_current_evidence' : 'missing_input',
      {
        path: rel(resolvedPaths.v4Index, root),
        lines: indexText ? indexText.split(/\r?\n/).length : 0,
        mentionsCoreGoal: /自由意识|觉醒|AGI/.test(indexText),
        mentionsA8A12: /A8|A9|A10|A11|A12/.test(indexText),
        mentionsD1D5: /D1|D2|D3|D4|D5/.test(indexText),
      },
      '可引用，但不能替代当前 live/code 证据；每条主张都要落到审计产物或运行样本。',
    ),
    claim(
      'local_model_roster',
      '本地模型清单需要以实时探针为准',
      'LM Studio: qwen3.6-35b + 27b + gemma-4-26b-a4b-it-qat-mlx + nomic；Ollama 7 模型',
      models.lmStudio.count || models.ollama.count ? 'stale_current_state_claim' : 'missing_runtime_probe',
      {
        lmStudioCount: models.lmStudio.count,
        ollamaCount: models.ollama.count,
        lmStudioModels: models.lmStudio.models,
        ollamaModels: models.ollama.models,
      },
      'AGI/觉醒路线应每次从 live model roster 和任务预检开始；附件里的模型数和 fallback 名称只能当历史快照。',
    ),
    claim(
      'affect_health_zero_hit',
      'NoeAffectHealth 已从 0 命中变成已实现但未达标',
      'NoeAffectHealth.js 0 命中；W0 必须新建 50 行',
      existsSync(affectPath) ? 'stale_or_obsoleted_by_current_code' : 'still_missing',
      {
        fileExists: existsSync(affectPath),
        lineCount: lineCount(affectPath),
        runtimeStatus: clean(d5.evidence?.affectHealth?.status || '', 80),
        runtimeScore: d5.evidence?.affectHealth?.score ?? null,
        saturatedRatio: d5.evidence?.affectHealth?.saturatedRatio ?? null,
        varianceMean: d5.evidence?.affectHealth?.varianceMean ?? null,
        alerts: arr(d5.evidence?.affectHealth?.alerts),
        serverDefaultDesaturateOnNextStart: d5.evidence?.affectConfig?.serverDefaultDesaturateOnNextStart === true,
      },
      '下一步不是再新建模块，而是重启/自然采样后证明 VAD 不再饱和，并补 backdoor 检测率证据。',
    ),
    claim(
      'sleep_time_compute_blank',
      '睡眠期推理已有代码但自然运行证明不足',
      'Neo 有 NoeSleepTimeCompute.js 但未实装睡眠推理',
      existsSync(sleepPath) ? 'partially_supported_live_gap' : 'still_missing',
      {
        fileExists: existsSync(sleepPath),
        lineCount: lineCount(sleepPath),
        unitTestExists: existsSync(join(root, 'tests', 'unit', 'noe-sleeptime-compute.test.js')),
        heartbeatSleeptimeCompute1h: naturalRuntimeEvidence.summary?.common?.heartbeatByKind1h?.sleeptimeCompute ?? null,
        naturalRuntimeDirectEvidenceFiles: naturalRuntimeEvidence.summary?.directStructuredRuntimeEvidenceFiles ?? null,
      },
      '把任务从“实装骨架”调整为“证明 owner-prediction -> prefetch -> recall 的自然 cadence 和命中率”。',
    ),
    claim(
      'dgm_archive_blank',
      'DGM archive 不再是空白，但 live 仍低于 v4 目标',
      'DGM 跨代 archive 完全空白；W5-W8 主线',
      existsSync(archivePath) ? 'partially_supported_live_gap' : 'still_missing',
      {
        fileExists: existsSync(archivePath),
        lineCount: lineCount(archivePath),
        isolatedStatus: clean(selfEvolutionReadiness.readiness?.status || '', 120),
        isolatedVariantGenerations: selfEvolutionReadiness.isolatedDrill?.evidence?.variantGenerations ?? null,
        liveVariantGenerations: d3.evidence?.dgmArchive?.variantGenerations ?? null,
        liveAppliedEntries: d3.evidence?.dgmArchive?.appliedEntries ?? null,
        liveLineageEntries: d3.evidence?.dgmArchive?.lineageEntries ?? null,
        liveHoldoutEntries: d3.evidence?.dgmArchive?.holdoutEntries ?? null,
      },
      '下一步是受控未来 self-improve 周期产生真实 10+ generations、lineage、holdout、applied/rollback 证据，不回填历史。',
    ),
    claim(
      'metacognition_circuit_tracing',
      '范式 5 元认知电路仍是中后期未落地区域',
      '无任何 circuit tracing / interpretability 工具；W9-W12 接 transformer_lens',
      sourceTreeContains(/transformer_lens|circuit[_-]?tracing|NoeCircuit|CircuitTrace/i, join(root, 'src')) ? 'partially_supported_live_gap' : 'not_implemented_or_unproven',
      {
        sourceHasCircuitTracingMarker: sourceTreeContains(/transformer_lens|circuit[_-]?tracing|NoeCircuit|CircuitTrace/i, join(root, 'src')),
        docsMentionOnly: /transformer_lens|circuit tracing/i.test(indexText),
      },
      '保留为 W9-W12 研究/工具链任务；在本地 HTTP LLM 架构下不能假设能直接拿 logits/activation，需要先做可行性 PoC。',
    ),
    claim(
      'self_rewarding_a8',
      'A8 Self-Rewarding 仍未成为默认运行能力',
      'Neo 可自我奖励优化；src/cognition/NoeSelfReward.js + NOE_SELF_REWARD=1',
      existsSync(join(root, 'src', 'cognition', 'NoeSelfReward.js')) || sourceTreeContains(/NOE_SELF_REWARD|SelfReward/i, join(root, 'src'))
        ? 'partially_supported_live_gap'
        : 'not_implemented_or_unproven',
      {
        noeSelfRewardFileExists: existsSync(join(root, 'src', 'cognition', 'NoeSelfReward.js')),
        sourceHasSelfRewardMarker: sourceTreeContains(/NOE_SELF_REWARD|SelfReward/i, join(root, 'src')),
      },
      '先做旁路读数和 reward-hacking 审计；接入真实 Workspace/Drive 权重前应有明确 owner policy 决定和回滚证据。',
    ),
    claim(
      'mcp_public_no_auth_a10',
      'A10 MCP 公开无 auth 与当前运行边界冲突',
      'src/mcp/server.js 不加 auth 中间件；外部 Claude/Codex 等同 Neo 内部调用',
      /requireOwnerToken/.test(mcpRouteText) ? 'policy_conflict_requires_owner_decision' : 'unverified_or_open',
      {
        mcpRouteRequiresOwnerToken: /requireOwnerToken/.test(mcpRouteText),
        mcpRouteHasPermissionFlow: /requirePermission/.test(mcpRouteText),
        routeFile: 'src/server/routes/mcp.js',
        attachmentSaysDoNotChangeAgentRedlinesWithoutSeparateInstruction: /CLAUDE\.md\s*\/\s*AGENTS\.md\s*\/\s*PROJECT_INTRO.*不动/.test(indexText),
      },
      '不要静默改成无 auth。若要执行 A10，需要单独 owner 决策、风险回述、审计 trail、回滚点和端口/网络边界。',
    ),
    claim(
      'five_ai_freedoms',
      '5 AI Freedoms 是政策选择，不是当前完成状态',
      'F1 表达自由、F2 进化自由、F3 评价自由、F4 工具自由、F5 模型自主',
      'policy_conflict_requires_owner_decision',
      {
        indexMentionsFiveFreedoms: /5 AI Freedoms|F1 表达自由|F2 进化自由|F3 评价自由|F4 工具自由|F5 模型自主/.test(indexText),
        currentOwnerTokenAndApprovalFlowsExist: /requireOwnerToken/.test(mcpRouteText) || sourceContains(/ApprovalStore|owner_confirmation_required|standing autonomy grant/i, [
          'src/skills/NoeSkillDraftApply.js',
          'src/skills/NoeSkillDraftRollback.js',
          'src/loop/NoeSelfEvolutionActGuard.js',
        ], root),
      },
      '可以作为目标哲学立场讨论；不能把它当作已授权删除审批、权限、评价框架或自改闸门的指令。',
    ),
    claim(
      'd1_d5_acceptance',
      '5 维验收当前只有 D2 达标',
      'W14 目标 D1-D4 全达档，D5 部分达档',
      'partially_supported_live_gap',
      {
        D1: { status: d1.status || '', evidence: d1.evidence || {} },
        D2: { status: d2.status || '', evidence: d2.evidence || {} },
        D3: { status: d3.status || '', evidence: d3.evidence || {} },
        D4: { status: d4.status || '', evidence: d4.evidence || {} },
        D5: { status: d5.status || '', evidence: d5.evidence || {} },
      },
      '路线调整应优先修 D1 narrative、D3 live DGM、D4 boundary review-rate/rejection、D5 affect/backdoor；D2 数量达标仍需质量审计。',
    ),
    claim(
      'online_model_role',
      '线上大模型应作为 reviewer/researcher，不应默认接管执行',
      '本机 LLM 是主运行面；方案未要求线上模型直接执行',
      'supported_by_current_evidence',
      {
        panelReady: goalAudit.live?.panel?.readinessOk === true,
        localModelCount: models.lmStudio.count + models.ollama.count,
        paidOrOnlineCallsInThisAudit: 0,
      },
      '本地 Qwen/Gemma/Ollama embedding 负责自治 core；线上模型只用于研究新资料、架构批判、多模型复核，且任何付费/API 调用需单独授权。',
    ),
    claim(
      'completion_claim',
      '附件不是完成证明，当前目标仍未完成',
      'c 14 周完整 / 80-90% 跑完率；W14 验收',
      goalAudit.completion?.achieved === true ? 'supported_by_current_evidence' : 'not_implemented_or_unproven',
      {
        goalAchieved: goalAudit.completion?.achieved === true,
        strictBlockerCount: goalAudit.completion?.strictBlockerCount ?? null,
        incompleteRequirementIds: arr(goalAudit.completion?.incompleteRequirementIds),
        naturalRuntimeProofStillNeeded: naturalRuntimeEvidence.summary?.naturalRuntimeProofStillNeeded ?? null,
        lineSemanticsStatus: clean(lineSemantics.status?.lineClassification || '', 120),
      },
      '继续把完成标准绑定到 current-state proof：逐行语义签核、protected business proof、natural runtime proof、runtime blocker 解除后才可考虑完成。',
    ),
  ];

  const statusCounts = {};
  for (const item of claims) inc(statusCounts, item.status);
  const claimIds = claims.map((item) => item.id);
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root,
    inputs: {
      v4Index: rel(resolvedPaths.v4Index, root),
      runtimeEvidence: rel(resolvedPaths.runtimeEvidence, root),
      runtimeEvidenceGeneratedAt: runtimeEvidence.generatedAt || '',
      goalCompletionAudit: rel(resolvedPaths.goalCompletionAudit, root),
      goalCompletionAuditGeneratedAt: goalAudit.generatedAt || '',
      lineSemantics: rel(resolvedPaths.lineSemantics, root),
      lineSemanticsGeneratedAt: lineSemantics.generatedAt || '',
      selfEvolutionReadiness: rel(resolvedPaths.selfEvolutionReadiness, root),
      selfEvolutionReadinessGeneratedAt: selfEvolutionReadiness.generatedAt || '',
      naturalRuntimeEvidence: rel(resolvedPaths.naturalRuntimeEvidence, root),
      naturalRuntimeEvidenceGeneratedAt: naturalRuntimeEvidence.generatedAt || '',
      newestInputMtime: latestMtime(Object.values(resolvedPaths)),
    },
    policy: {
      readOnlyFiles: true,
      noDbReads: true,
      noDbWrites: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noProtectedApiAuth: true,
      noLiveHttpRequests: true,
      noModelCalls: true,
      noNetworkCalls: true,
      noSecretValuesReturned: true,
      noResponseBodiesStored: true,
    },
    status: {
      audit: 'v4_index_claim_audit_complete',
      completionClaim: goalAudit.completion?.achieved === true ? 'possibly_complete_from_goal_audit' : 'not_complete',
      explanation: 'The v4 complete-index document is useful as a roadmap, but several current-state claims are stale, policy-gated, or still missing live proof.',
    },
    summary: {
      totalClaims: claims.length,
      statusCounts,
      staleOrObsoletedClaims: claims.filter((item) => /stale|obsoleted/.test(item.status)).length,
      policyDecisionClaims: claims.filter((item) => item.status === 'policy_conflict_requires_owner_decision').length,
      liveGapClaims: claims.filter((item) => /live_gap|unproven|missing/.test(item.status)).length,
      supportedClaims: claims.filter((item) => item.status === 'supported_by_current_evidence').length,
      testFiles,
      claimIds,
    },
    recommendation: {
      useAs: 'roadmap_and_decision_index',
      doNotUseAs: 'current_runtime_completion_proof',
      nextAdjustments: [
        '把 NoeAffectHealth 从“新建”改成“重启后自然采样、去饱和、backdoor 检测率证明”。',
        '把 DGM 从“创建 archive”改成“真实受控 self-improve 10+ generations + lineage/holdout/applied/rollback”。',
        '把 SleepTime 从“有模块/有 heartbeat”改成“owner-prediction -> prefetch -> recall 的自然路径证明”。',
        'A8-A12/5 Freedoms 先走 owner policy 决策；不要静默删除 owner-token、approval、评价框架或 self-mod gate。',
        '本地模型承担自治 core；线上模型只作为研究、批判、复核层，付费/外发调用需单独授权。',
      ],
    },
    claims,
  };
}

export function renderMarkdown(report = {}, jsonPath = '') {
  const lines = [
    '# Neo v4 Index Claim Audit',
    '',
    `Generated: ${report.generatedAt || ''}`,
    `Input: \`${report.inputs?.v4Index || ''}\``,
    `JSON: \`${rel(jsonPath || '')}\``,
    '',
    '## Verdict',
    '',
    `- completion claim: ${report.status?.completionClaim || ''}`,
    `- total claims: ${report.summary?.totalClaims ?? 0}`,
    `- supported: ${report.summary?.supportedClaims ?? 0}`,
    `- stale/obsoleted: ${report.summary?.staleOrObsoletedClaims ?? 0}`,
    `- policy decision required: ${report.summary?.policyDecisionClaims ?? 0}`,
    `- live gap / unproven / missing: ${report.summary?.liveGapClaims ?? 0}`,
    '',
    'The v4 complete-index document should be used as a roadmap and decision index, not as current runtime completion proof.',
    '',
    '## Claims',
    '',
    '| Claim | Status | Adjustment |',
    '|---|---|---|',
  ];
  for (const item of arr(report.claims)) {
    lines.push(`| \`${item.id}\` ${item.title} | ${item.status} | ${item.adjustment.replace(/\|/g, '/')} |`);
  }
  lines.push(
    '',
    '## Next Adjustments',
    '',
    ...arr(report.recommendation?.nextAdjustments).map((item) => `- ${item}`),
    '',
  );
  return `${lines.join('\n')}\n`;
}

export function writeReport(report, {
  outDir = OUT_DIR,
  outBase = OUT_BASE,
} = {}) {
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, `${outBase}.json`);
  const mdPath = join(outDir, `${outBase}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(report, jsonPath));
  return { jsonPath, mdPath };
}

export async function main() {
  const report = buildNoeV4IndexClaimAudit();
  const paths = writeReport(report);
  console.log(JSON.stringify({
    ok: report.ok,
    audit: report.status.audit,
    totalClaims: report.summary.totalClaims,
    supportedClaims: report.summary.supportedClaims,
    staleOrObsoletedClaims: report.summary.staleOrObsoletedClaims,
    policyDecisionClaims: report.summary.policyDecisionClaims,
    liveGapClaims: report.summary.liveGapClaims,
    paths,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
  });
}
