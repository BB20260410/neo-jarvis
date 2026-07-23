#!/usr/bin/env node
// @ts-check
// Completion audit for the active Neo/Noe goal.
// Read-only: no env-file reads, no owner-token reads, no protected API auth, no model/chat calls, no shell execution.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = process.env.NOE_GOAL_COMPLETION_AUDIT_OUT_DIR || join(ROOT, 'output', 'noe-audit');
const OUT_BASE = process.env.NOE_GOAL_COMPLETION_AUDIT_BASENAME || 'goal-completion-audit-2026-06-15';

const DEFAULT_PATHS = {
  v4Plan: join(ROOT, 'output', 'noe-2026-06-14-deep-research', '06-reviews', '26-neo-overall-plan-v4.md'),
  atlas: join(ROOT, 'output', 'noe-audit', 'full-code-function-atlas-2026-06-15.json'),
  lineSemantics: join(ROOT, 'output', 'noe-audit', 'line-semantics-audit-2026-06-15.json'),
  moduleMap: join(ROOT, 'output', 'noe-audit', 'module-runtime-map-2026-06-15.json'),
  runtimeEvidence: join(ROOT, 'output', 'noe-runtime-evidence', 'latest.json'),
  authMatrixLive: join(ROOT, 'output', 'noe-audit', 'runtime-proof-auth-surface-matrix-live-2026-06-15.json'),
  localDrills: join(ROOT, 'output', 'noe-audit', 'runtime-proof-local-drills-2026-06-15.json'),
  notProvenLiveDisposition: join(ROOT, 'output', 'noe-audit', 'not-proven-live-disposition-audit-2026-06-15.json'),
  weakRuntimeSupportReview: join(ROOT, 'output', 'noe-audit', 'weak-runtime-support-review-2026-06-15.json'),
  weakRouteSurfaceProbe: join(ROOT, 'output', 'noe-audit', 'weak-route-surface-probe-2026-06-15.json'),
  weakRuntimeRemainingLaneAudit: join(ROOT, 'output', 'noe-audit', 'weak-runtime-remaining-lane-audit-2026-06-15.json'),
  surpriseLearningAudit: join(ROOT, 'output', 'noe-audit', 'surprise-learning-audit-2026-06-15.json'),
  expectationJudgeBlockerAudit: join(ROOT, 'output', 'noe-audit', 'expectation-judge-blocker-audit-2026-06-15.json'),
  postHintJudgementAudit: join(ROOT, 'output', 'noe-audit', 'post-hint-judgement-audit-2026-06-15.json'),
  newActionEvidenceReadiness: join(ROOT, 'output', 'noe-audit', 'new-action-evidence-readiness-2026-06-15.json'),
  directEvidenceReaskReadiness: join(ROOT, 'output', 'noe-audit', 'direct-evidence-reask-readiness-2026-06-15.json'),
  memorySemanticRecallQuality: join(ROOT, 'output', 'noe-audit', 'memory-semantic-recall-quality-audit-2026-06-15.json'),
  selfEvolutionReadiness: join(ROOT, 'output', 'noe-audit', 'self-evolution-readiness-audit-2026-06-15.json'),
  p0AuthorizedReadonly: join(ROOT, 'output', 'noe-audit', 'p0-authorized-readonly-probe-2026-06-15.json'),
  v4IndexClaimAudit: join(ROOT, 'output', 'noe-audit', 'v4-index-claim-audit-2026-06-15.json'),
};

const LOCAL_ENDPOINTS = {
  health: 'http://127.0.0.1:51835/health',
  readiness: 'http://127.0.0.1:51835/api/noe/readiness',
  lmStudioModels: 'http://127.0.0.1:1234/v1/models',
  ollamaTags: 'http://127.0.0.1:11434/api/tags',
};

function readJson(path) {
  if (!path || !existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readText(path) {
  if (!path || !existsSync(path)) return '';
  return readFileSync(path, 'utf8');
}

function arr(value) {
  return Array.isArray(value) ? value : [];
}

function rel(path, root = ROOT) {
  return String(path || '').replace(`${root}/`, '');
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

function compactModelId(value) {
  return clean(value, 160)
    .replace(/[?&](?:key|api_key|token|secret|password)=[^&\s]+/gi, '$1=[redacted]');
}

function pathSummary(paths = {}) {
  return Object.fromEntries(Object.entries(paths).map(([key, path]) => [key, rel(path)]));
}

async function fetchJsonSafe(url, fetchImpl) {
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, error: 'fetch_unavailable' };
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(String(url || ''))) {
    return { ok: false, status: 0, error: 'non_local_endpoint_blocked' };
  }
  try {
    const response = await fetchImpl(url, { method: 'GET' });
    const status = Number(response?.status) || 0;
    const text = await response.text().catch(async () => JSON.stringify(await response.json().catch(() => ({}))));
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { text: clean(text, 1000) }; }
    return { ok: status >= 200 && status < 300, status, data };
  } catch (error) {
    return { ok: false, status: 0, error: clean(error?.message || error, 500) };
  }
}

async function probeLiveLocalState({ fetchImpl = globalThis.fetch } = {}) {
  const health = await fetchJsonSafe(LOCAL_ENDPOINTS.health, fetchImpl);
  const readiness = await fetchJsonSafe(LOCAL_ENDPOINTS.readiness, fetchImpl);
  const lmStudio = await fetchJsonSafe(LOCAL_ENDPOINTS.lmStudioModels, fetchImpl);
  const ollama = await fetchJsonSafe(LOCAL_ENDPOINTS.ollamaTags, fetchImpl);
  const lmModels = arr(lmStudio.data?.data).map((item) => compactModelId(item.id || item.name)).filter(Boolean);
  const ollamaModels = arr(ollama.data?.models).map((item) => compactModelId(item.name || item.model)).filter(Boolean);
  return {
    policy: {
      localhostOnly: true,
      noAuthHeaders: true,
      noOwnerTokenRead: true,
      noModelGenerationCalls: true,
    },
    panel: {
      healthOk: health.ok === true,
      healthStatus: health.status,
      readinessOk: readiness.ok === true && readiness.data?.readiness?.status === 'passed',
      readinessStatus: readiness.data?.readiness?.status || '',
      memoryVisible: readiness.data?.counts?.memoryVisible ?? null,
      focusDepth: readiness.data?.counts?.focusDepth ?? null,
      enabledChecks: readiness.data?.counts?.enabled ?? null,
      totalChecks: readiness.data?.counts?.total ?? null,
      pendingApprovals: readiness.data?.counts?.pendingApprovals ?? null,
      pendingActs: readiness.data?.counts?.pendingActs ?? null,
      p6SelfTalkOutcomes: readiness.data?.counts?.p6SelfTalkOutcomes ?? null,
      ruminationGuardTripRate: readiness.data?.p6?.ruminationGuardTripRate ?? null,
      at: readiness.data?.at || health.data?.at || '',
      errors: [health.error, readiness.error].filter(Boolean),
    },
    localModels: {
      lmStudio: {
        ok: lmStudio.ok === true,
        status: lmStudio.status,
        count: lmModels.length,
        models: lmModels,
        error: lmStudio.error || '',
      },
      ollama: {
        ok: ollama.ok === true,
        status: ollama.status,
        count: ollamaModels.length,
        models: ollamaModels,
        error: ollama.error || '',
      },
    },
  };
}

function v4PlanStats(text = '') {
  const lines = text.split('\n');
  return {
    present: text.trim().length > 0,
    lines: lines.length,
    headings: lines.filter((line) => /^#{1,6}\s+/.test(line)).length,
    mentionsD1D5: /D1|D2|D3|D4|D5/.test(text),
    mentions14Weeks: /14\s*周|W14/i.test(text),
  };
}

function buildRequirements({ v4, atlas, lineSemantics, moduleMap, runtimeEvidence, authMatrix, localDrills, notProvenLiveDisposition, weakRuntimeSupportReview, weakRouteSurfaceProbe, weakRuntimeRemainingLaneAudit, surpriseAudit, judgeBlockerAudit, postHintAudit, newActionReadiness, directEvidenceReadiness, memoryRecallQuality, selfEvolutionReadiness, p0Auth, v4IndexClaimAudit, live }) {
  const atlasSummary = atlas?.summary || {};
  const lineSemanticsSummary = lineSemantics?.summary || {};
  const moduleSummary = moduleMap?.totals || {};
  const runtimeBlockers = arr(runtimeEvidence?.blockers || atlasSummary.runtimeBlockers || moduleSummary.runtimeBlockers);
  const p0Missing = arr(p0Auth?.summary?.p0FilesStillMissingBusinessProof);
  const localSummary = localDrills?.summary || {};
  const dispositionSummary = notProvenLiveDisposition?.summary || {};
  const weakReviewSummary = weakRuntimeSupportReview?.summary || {};
  const weakRouteSummary = weakRouteSurfaceProbe?.summary || {};
  const weakLaneSummary = weakRuntimeRemainingLaneAudit?.summary || {};
  const authSummary = authMatrix?.summary || {};
  const surpriseCurrent = surpriseAudit?.current || {};
  const surpriseTrend = surpriseAudit?.trend || {};
  const judgeBlockers = arr(judgeBlockerAudit?.blockers).map((item) => ({
    id: clean(item?.id || '', 120),
    severity: clean(item?.severity || '', 20),
  })).filter((item) => item.id);
  const actionTraceMitigation = judgeBlockerAudit?.codeMitigations?.actionEvidenceActPayloadSemanticTrace || {};
  const postHintSummary = postHintAudit?.summary || {};
  const newActionSummary = newActionReadiness?.summary || {};
  const directEvidenceSummary = directEvidenceReadiness?.summary || {};
  const filesNotProvenLive = Number(atlasSummary.filesNotProvenLive || moduleSummary.filesNotProvenLive || 0);
  const staticRuntimeUnproven = Number(atlasSummary.filesStaticRuntimeSurfaceUnproven || moduleSummary.filesStaticRuntimeSurfaceUnproven || 0);
  const parseFailures = Number(atlasSummary.parseFailures || 0);
  const lineClassificationOk = lineSemantics?.status?.lineClassification === 'all_lines_classified_no_body'
    && Number(lineSemanticsSummary.readFailures || 0) === 0
    && Number(lineSemanticsSummary.parseFailures || 0) === 0
    && Number(lineSemanticsSummary.classifiedLines || 0) === Number(lineSemanticsSummary.lines || 0)
    && Number(lineSemanticsSummary.lines || 0) > 0;
  const semanticMemory = runtimeEvidence?.memory?.semantic || {};
  const semanticMemoryUnconfigured = runtimeBlockers.includes('memory_semantic_runtime_unconfigured');
  const semanticMemoryStatus = clean(
    semanticMemory.status || (semanticMemoryUnconfigured ? 'unconfigured' : 'unknown'),
    120,
  );
  const semanticMemoryEnabled = semanticMemoryStatus === 'enabled';
  const semanticRecallQualityStatus = clean(memoryRecallQuality?.quality?.status || 'missing', 120);
  const semanticRecallQualityPassed = semanticRecallQualityStatus === 'recall_quality_probe_passed';
  const semanticMemoryEvidenceGap = semanticMemoryUnconfigured
    ? 'semantic memory runtime 当前仍需重启后复验'
    : semanticMemoryEnabled
      ? (semanticRecallQualityPassed
        ? 'semantic memory recall-quality probe 已通过；剩余缺口是必要时做 owner/user-facing 召回样本，不是 provider 或索引配置'
        : 'semantic memory runtime 已启用；剩余缺口是抽样验证召回质量，而非 provider 未配置')
      : 'semantic memory runtime 状态未明，需补 provider/config 与召回质量复验';
  const selfEvolutionReady = selfEvolutionReadiness?.readiness?.status === 'archive_writer_lineage_holdout_ready'
    && selfEvolutionReadiness?.isolatedDrill?.ok === true;
  const selfEvolutionLiveGaps = arr(selfEvolutionReadiness?.readiness?.liveGaps).map((item) => clean(item, 120));
  const selfEvolutionEvidenceGap = selfEvolutionReady
    ? 'DGM archive writer 已隔离证明 10 代 lineage/holdout/benchmark 可生成；live 仍缺真实 10+ generations、applied self-mod、lineage/holdout 记录'
    : 'DGM/self-evolution 缺 10+ generations、lineage、holdout、真实 applied self-mod evidence';
  const v4IndexSummary = v4IndexClaimAudit?.summary || {};
  const v4IndexRecommendation = v4IndexClaimAudit?.recommendation || {};

  const requirements = [
    {
      id: 'full_code_function_architecture_understanding',
      request: '全量了解 Neo 贾维斯每行代码、功能和架构',
      status: parseFailures === 0 && Number(atlasSummary.files || moduleSummary.files || 0) > 0
        ? (lineClassificationOk ? 'line_classified_not_semantically_signed_off' : 'traceable_not_semantically_complete')
        : 'missing_or_failed',
      evidence: {
        atlasFiles: atlasSummary.files || moduleSummary.files || 0,
        atlasLines: atlasSummary.lines || moduleSummary.lines || 0,
        symbolBlocks: atlasSummary.symbolBlocks || 0,
        exportedSymbolBlocks: atlasSummary.exportedSymbolBlocks || 0,
        modules: atlasSummary.modules || moduleSummary.modules || 0,
        parseFailures,
        moduleMapFiles: moduleSummary.files || 0,
        lineSemantics: {
          status: clean(lineSemantics?.status?.lineClassification || 'missing', 120),
          semanticSignoff: clean(lineSemantics?.status?.semanticSignoff || 'missing', 80),
          files: lineSemanticsSummary.files || 0,
          lines: lineSemanticsSummary.lines || 0,
          classifiedLines: lineSemanticsSummary.classifiedLines || 0,
          classifiedLineCoveragePct: lineSemanticsSummary.classifiedLineCoveragePct ?? null,
          readFailures: lineSemanticsSummary.readFailures ?? null,
          parseFailures: lineSemanticsSummary.parseFailures ?? null,
          codeLikeLines: lineSemanticsSummary.codeLikeLines ?? null,
          symbolCoveredCodePct: lineSemanticsSummary.symbolCoveredCodePct ?? null,
          topLevelCodeLines: lineSemanticsSummary.topLevelCodeLines ?? null,
          topLevelCodePct: lineSemanticsSummary.topLevelCodePct ?? null,
        },
      },
      judgment: lineClassificationOk
        ? '已有文件/函数/模块级 atlas，并且所有 atlas 行已按 no-body line kind 映射到文件、模块、feature、runtime 与 symbol/top-level context；这仍不是逐行语义签收完成。'
        : '已有文件/函数/模块级可追踪 atlas，但这仍不是逐行语义审阅完成；只能证明已建立全量索引和后续审计入口。',
      missingEvidence: parseFailures === 0
        ? [
            lineClassificationOk
              ? '逐行 no-body 分类已完成，但逐行人工/模型语义签收仍未完成'
              : '逐行人工/模型语义审阅签收仍未完成',
            `仍需把 ${filesNotProvenLive} 个 not_proven_live 文件逐步降级为 live/support-only/irrelevant`,
          ]
        : ['AST parse failures must be resolved before full-code traceability can be claimed'],
    },
    {
      id: 'feature_usefulness_and_runtime_truth',
      request: '深入分析每个功能是否真的有用、是否真的在运行',
      status: localSummary.okDrills === localSummary.targetFiles && localSummary.targetFiles > 0
        ? 'partially_proven_with_live_gaps'
        : 'incomplete',
      evidence: {
        filesNotProvenLive,
        staticRuntimeUnproven,
        runtimeBacklogFiles: authSummary.backlogFiles || 0,
        liveAuthSurfaceFiles: authSummary.liveAuthSurfaceFiles || 0,
        liveAuthSurfacePaths: authSummary.liveAuthSurfacePaths || 0,
        localDrillTargetFiles: localSummary.targetFiles || 0,
        localDrillOk: localSummary.okDrills || 0,
        localDrillFailed: localSummary.failedDrills || 0,
        p0MissingBusinessProof: p0Missing.length,
        p0MissingFiles: p0Missing,
        notProvenLiveDisposition: {
          status: clean(notProvenLiveDisposition?.status?.disposition || 'missing', 120),
          atlasNotProvenLive: dispositionSummary.atlasNotProvenLive ?? null,
          atlasStaticRuntimeSurfaceUnproven: dispositionSummary.atlasStaticRuntimeSurfaceUnproven ?? null,
          liveRuntimeEvidence: dispositionSummary.dispositionCounts?.live_runtime_evidence ?? null,
          liveAuthSurfaceBusinessPending: dispositionSummary.dispositionCounts?.live_auth_surface_proved_business_pending ?? null,
          localBehaviorDrillOk: dispositionSummary.dispositionCounts?.local_behavior_drill_ok ?? null,
          localOrNaturalRuntimeDrillOk: dispositionSummary.dispositionCounts?.local_or_natural_runtime_evidence_drill_ok ?? null,
          providerStatusOrMockDrillOk: dispositionSummary.dispositionCounts?.provider_status_or_mock_drill_ok ?? null,
          verificationTestNotRuntimeFeature: dispositionSummary.dispositionCounts?.verification_test_not_runtime_feature ?? null,
          supportOnlyReviewed: dispositionSummary.dispositionCounts?.support_only_reviewed ?? null,
          weakRuntimeFiles: dispositionSummary.weakRuntimeFiles ?? null,
          ownerOrLiveNeededFiles: dispositionSummary.ownerOrLiveNeededFiles ?? null,
          ownerTokenNeededFiles: dispositionSummary.ownerTokenNeededFiles ?? null,
          livePanelNeededFiles: dispositionSummary.livePanelNeededFiles ?? null,
          paidQuotaRiskFiles: dispositionSummary.paidQuotaRiskFiles ?? null,
          weakReview: {
            status: clean(weakRuntimeSupportReview?.status?.review || 'missing', 120),
            weakFiles: weakReviewSummary.weakFiles ?? null,
            runtimeProbeNeeded: weakReviewSummary.runtimeProbeNeeded ?? null,
            supportConfirmed: weakReviewSummary.supportConfirmed ?? null,
            manualReviewOrProbeNeeded: weakReviewSummary.manualReviewOrProbeNeeded ?? null,
            routeImportedRuntimeCandidates: weakReviewSummary.routeImportedRuntimeCandidates ?? null,
            serverImportedRuntimeCandidates: weakReviewSummary.serverImportedRuntimeCandidates ?? null,
            librarySupportWithUnitCoverage: weakReviewSummary.librarySupportWithUnitCoverage ?? null,
          },
          weakRouteSurfaceProbe: {
            status: clean(weakRouteSurfaceProbe?.status?.probe || 'missing', 120),
            mode: clean(weakRouteSurfaceProbe?.mode || 'missing', 80),
            routeCandidateFiles: weakRouteSummary.routeCandidateFiles ?? null,
            protectedGetCandidateFiles: weakRouteSummary.protectedGetCandidateFiles ?? null,
            uniqueProtectedGetPaths: weakRouteSummary.uniqueProtectedGetPaths ?? null,
            dynamicPlaceholderPaths: weakRouteSummary.dynamicPlaceholderPaths ?? null,
            liveProbeExecuted: weakRouteSummary.liveProbeExecuted ?? null,
            liveAuthSurfaceFiles: weakRouteSummary.liveAuthSurfaceFiles ?? null,
            liveAuthSurfacePaths: weakRouteSummary.liveAuthSurfacePaths ?? null,
            remainingWithoutProtectedGet: weakRouteSummary.remainingWithoutProtectedGet ?? null,
            remainingWithoutLiveAuthSurface: weakRouteSummary.remainingWithoutLiveAuthSurface ?? null,
          },
          weakRemainingLanes: {
            status: clean(weakRuntimeRemainingLaneAudit?.status?.audit || 'missing', 120),
            actionableFiles: weakLaneSummary.actionableFiles ?? null,
            routeLiveAuthSurfaceBusinessPending: weakLaneSummary.routeLiveAuthSurfaceBusinessPending ?? null,
            routeNoSafeGetFiles: weakLaneSummary.routeNoSafeGetFiles ?? null,
            routeTargetedDrilledOk: weakLaneSummary.routeTargetedDrilledOk ?? null,
            routeLiveAuthSurfaceTargetedDrilledOk: weakLaneSummary.routeLiveAuthSurfaceTargetedDrilledOk ?? null,
            routeNoSafeGetTargetedDrilledOk: weakLaneSummary.routeNoSafeGetTargetedDrilledOk ?? null,
            routeProtectedBusinessProofStillNeeded: weakLaneSummary.routeProtectedBusinessProofStillNeeded ?? null,
            serverCandidates: weakLaneSummary.serverCandidates ?? null,
            serverBootImported: weakLaneSummary.serverBootImported ?? null,
            serverServiceChain: weakLaneSummary.serverServiceChain ?? null,
            serverTargetedDrilledOk: weakLaneSummary.serverTargetedDrilledOk ?? null,
            serverBootTargetedDrilledOk: weakLaneSummary.serverBootTargetedDrilledOk ?? null,
            serverServiceChainTargetedDrilledOk: weakLaneSummary.serverServiceChainTargetedDrilledOk ?? null,
            serverNaturalRuntimeStillNeeded: weakLaneSummary.serverNaturalRuntimeStillNeeded ?? null,
            chainCandidates: weakLaneSummary.chainCandidates ?? null,
            chainTargetedDrilledOk: weakLaneSummary.chainTargetedDrilledOk ?? null,
            manualSupportReviewFiles: weakLaneSummary.manualSupportReviewFiles ?? null,
            manualSupportDrilledOk: weakLaneSummary.manualSupportDrilledOk ?? null,
            manualSupportSkippedByPolicy: weakLaneSummary.manualSupportSkippedByPolicy ?? null,
            ownerDecisionNeededFiles: weakLaneSummary.ownerDecisionNeededFiles ?? null,
            naturalRuntimeNeededFiles: weakLaneSummary.naturalRuntimeNeededFiles ?? null,
            naturalRuntimeDirectEvidenceFiles: weakLaneSummary.naturalRuntimeDirectEvidenceFiles ?? null,
            naturalRuntimeIndirectSignalFiles: weakLaneSummary.naturalRuntimeIndirectSignalFiles ?? null,
            naturalRuntimeMissingEvidenceFiles: weakLaneSummary.naturalRuntimeMissingEvidenceFiles ?? null,
            naturalRuntimeProofStillNeeded: weakLaneSummary.naturalRuntimeProofStillNeeded ?? null,
            targetedProbeNeededFiles: weakLaneSummary.targetedProbeNeededFiles ?? null,
            postDrillTargetedProbeNeededFiles: weakLaneSummary.postDrillTargetedProbeNeededFiles ?? null,
            componentContractDrilledOk: weakLaneSummary.componentContractDrilledOk ?? null,
          },
        },
      },
      judgment: dispositionSummary.weakRuntimeFiles != null
        ? (weakReviewSummary.runtimeProbeNeeded != null
            ? (weakRouteSummary.routeCandidateFiles != null
              ? (weakLaneSummary.actionableFiles != null
                ? `粗粒度 not_proven_live 已拆分；weak 队列进一步拆成 ${weakReviewSummary.runtimeProbeNeeded} 个 runtime probe、${weakReviewSummary.supportConfirmed} 个 support confirmed、${weakReviewSummary.manualReviewOrProbeNeeded} 个 manual review/probe；route surface probe 覆盖 ${weakRouteSummary.liveAuthSurfaceFiles || 0}/${weakRouteSummary.routeCandidateFiles} 个 weak route candidates；remaining lane audit 将 ${weakLaneSummary.actionableFiles} 个待处理文件拆成 route/business、mutating route、server、chain、manual support 队列；route import contract drill=${weakLaneSummary.routeTargetedDrilledOk ?? 0}/${weakLaneSummary.routeCandidates ?? weakRouteSummary.routeCandidateFiles ?? 0}，server/service 组件契约 drill=${weakLaneSummary.serverTargetedDrilledOk ?? 0}/${weakLaneSummary.serverCandidates ?? 0}，natural runtime direct evidence=${weakLaneSummary.naturalRuntimeDirectEvidenceFiles ?? 0}/${weakLaneSummary.naturalRuntimeNeededFiles ?? 0}。protected business proof 与自然 live 调用证据仍未完成。`
                : `粗粒度 not_proven_live 已拆分；weak 队列进一步拆成 ${weakReviewSummary.runtimeProbeNeeded} 个 runtime probe、${weakReviewSummary.supportConfirmed} 个 support confirmed、${weakReviewSummary.manualReviewOrProbeNeeded} 个 manual review/probe；route surface probe 覆盖 ${weakRouteSummary.liveAuthSurfaceFiles || 0}/${weakRouteSummary.routeCandidateFiles} 个 weak route candidates。protected business proof 与自然 live 调用证据仍未完成。`)
            : `粗粒度 not_proven_live 已拆分；weak 队列进一步拆成 ${weakReviewSummary.runtimeProbeNeeded} 个 runtime probe、${weakReviewSummary.supportConfirmed} 个 support confirmed、${weakReviewSummary.manualReviewOrProbeNeeded} 个 manual review/probe。protected business proof 与自然 live 调用证据仍未完成。`)
          : `粗粒度 not_proven_live 已拆分：live/auth/local-drill/support 分类可解释大部分文件，当前 weak runtime/support-review 队列为 ${dispositionSummary.weakRuntimeFiles} 个；protected business proof 与自然 live 调用证据仍未完成。`)
        : '非 route 本地行为 proof 已清零，live route/auth surface 已覆盖 25/68 backlog 文件；但 protected business proof 与自然 live 调用证据仍未完成。',
      missingEvidence: [
        'owner 授权只读 protected business summary 仍未执行',
        'P0 仍有 6 个文件缺业务方法摘要证明',
        dispositionSummary.weakRuntimeFiles != null
          ? (weakReviewSummary.runtimeProbeNeeded != null
            ? (weakRouteSummary.routeCandidateFiles != null
              ? (weakLaneSummary.actionableFiles != null
                ? `${weakLaneSummary.actionableFiles} 个 weak remaining files 仍未 complete：${weakLaneSummary.routeTargetedDrilledOk ?? 0}/${weakLaneSummary.routeCandidates ?? weakRouteSummary.routeCandidateFiles ?? 0} 个 route import contracts 已 drill，但 ${weakLaneSummary.routeProtectedBusinessProofStillNeeded ?? weakLaneSummary.routeCandidates ?? 'unknown'} 个 route 仍需 protected business proof；${weakLaneSummary.routeLiveAuthSurfaceBusinessPending || 0} 个 route auth surface 需业务 proof，${weakLaneSummary.routeNoSafeGetFiles || 0} 个 route 只有 mutating/contextual proof lane，${weakLaneSummary.serverTargetedDrilledOk || 0}/${weakLaneSummary.serverCandidates || 0} 个 server candidates 已有 isolated component drill 但 ${weakLaneSummary.serverNaturalRuntimeStillNeeded ?? weakLaneSummary.serverCandidates ?? 0} 个仍需自然 runtime，natural runtime direct=${weakLaneSummary.naturalRuntimeDirectEvidenceFiles ?? 0}、indirect=${weakLaneSummary.naturalRuntimeIndirectSignalFiles ?? 0}、missing=${weakLaneSummary.naturalRuntimeMissingEvidenceFiles ?? 0}、stillNeeded=${weakLaneSummary.naturalRuntimeProofStillNeeded ?? weakLaneSummary.naturalRuntimeNeededFiles ?? 'unknown'}，${weakLaneSummary.chainTargetedDrilledOk || 0}/${weakLaneSummary.chainCandidates || 0} 个 chain candidates 已有 local component drill，post-drill targeted queue=${weakLaneSummary.postDrillTargetedProbeNeededFiles ?? 'unknown'}`
                : `${weakReviewSummary.runtimeProbeNeeded} 个 weak-review runtime candidates 仍需业务执行/自然调用 proof；weak route surface probe 已验证 ${weakRouteSummary.liveAuthSurfaceFiles || 0}/${weakRouteSummary.routeCandidateFiles} 个 route candidates 的 live auth surface`)
              : `${weakReviewSummary.runtimeProbeNeeded} 个 weak-review runtime candidates 仍需 route/server/chain runtime probe`)
            : `${dispositionSummary.weakRuntimeFiles} 个 weak disposition 文件仍需 support-only 确认或 runtime probe`)
          : 'not_proven_live disposition audit 仍未接入',
        weakReviewSummary.manualReviewOrProbeNeeded
          ? `${weakReviewSummary.manualReviewOrProbeNeeded} 个 weak-review 文件仍需人工 support-only 判断或补 probe`
          : 'weak-review manual queue 已清零或未接入',
        '自然 scheduler/delegation/runtime evidence 仍需重启或等待真实 cadence 后验证',
      ],
    },
    {
      id: 'agi_awakening_self_awareness_adjustment',
      request: '根据当前实时本地模型，判断怎么调整才能实现 AGI/AI 觉醒/自我意识',
      status: runtimeBlockers.length ? 'not_achieved_recommendation_ready' : 'needs_manual_review',
      evidence: {
        v4PlanPresent: v4.present,
        v4Lines: v4.lines,
        runtimeBlockers,
        surpriseLearningStatus: surpriseAudit?.status || 'missing',
        surpriseLearningLive: surpriseAudit?.surpriseLearningLive === true,
        surpriseLearningDiagnostics: arr(surpriseAudit?.diagnostics),
        surpriseCurrent: {
          expectationsFailed: surpriseCurrent.expectationsFailed ?? null,
          failedSurpriseEligible: surpriseCurrent.failedSurpriseEligible ?? null,
          surpriseGoals: surpriseCurrent.surpriseGoals ?? null,
          decisiveUnknownRate: surpriseCurrent.decisiveUnknownRate ?? null,
          ownerPredictionStatus: surpriseCurrent.ownerPredictionStatus || '',
        },
        surpriseTrend: {
          snapshots: surpriseTrend.snapshots || 0,
          allFailedZero: surpriseTrend.allFailedZero === true,
          allSurpriseGoalsZero: surpriseTrend.allSurpriseGoalsZero === true,
          avgDecisiveUnknownRate: surpriseTrend.avgDecisiveUnknownRate ?? null,
        },
        expectationJudgeBlockerStatus: judgeBlockerAudit?.status || 'missing',
        expectationJudgeP0Blockers: judgeBlockers.filter((item) => item.severity === 'P0').map((item) => item.id),
        expectationJudgeMetrics: {
          decisiveUnknownRate: judgeBlockerAudit?.runtime?.decisiveUnknownRate ?? null,
          semanticTraceMaxCoverage: judgeBlockerAudit?.calibration?.recent?.evidenceClaimAlignment?.semanticTraceMaxCoverage ?? null,
          actionSuccessSignals: judgeBlockerAudit?.calibration?.recent?.evidenceDecision?.actionSuccess ?? null,
          recentUnknown: judgeBlockerAudit?.calibration?.recent?.outcomeCounts?.unknown ?? null,
        },
        expectationJudgeCodeMitigations: {
          actionEvidenceActPayloadSemanticTrace: clean(actionTraceMitigation.status || 'missing', 120),
          liveStatus: clean(actionTraceMitigation.liveStatus || 'unknown', 120),
        },
        postHintJudgement: {
          status: clean(postHintAudit?.status || 'missing', 120),
          uniqueJudgements: postHintSummary.uniqueJudgements ?? null,
          actionSuccessUnknown: postHintSummary.actionSuccessUnknown ?? null,
          observationOnlyUnknown: postHintSummary.observationOnlyUnknown ?? null,
          directEvidenceUnknown: postHintSummary.directEvidenceUnknown ?? null,
          staleActionHintOnObservationOnly: postHintSummary.staleActionHintOnObservationOnly ?? null,
          semanticTraceCoverageMax: postHintSummary.semanticTraceCoverageMax ?? null,
        },
        newActionEvidenceReadiness: {
          status: clean(newActionReadiness?.status || 'missing', 120),
          ready: newActionSummary.ready === true,
          newActionSemanticTraceCoverage: newActionSummary.newActionSemanticTraceCoverage ?? null,
          legacyActionSemanticTraceCoverage: newActionSummary.legacyActionSemanticTraceCoverage ?? null,
          observationOnlySemanticTraceCoverage: newActionSummary.observationOnlySemanticTraceCoverage ?? null,
        },
        directEvidenceReaskReadiness: {
          status: clean(directEvidenceReadiness?.status || 'missing', 120),
          ready: directEvidenceSummary.ready === true,
          directSuccessResolved: directEvidenceSummary.directSuccessResolved ?? null,
          directSuccessOutcome: directEvidenceSummary.directSuccessOutcome ?? null,
          directSuccessSemanticTraceCoverage: directEvidenceSummary.directSuccessSemanticTraceCoverage ?? null,
          claimMismatchResolved: directEvidenceSummary.claimMismatchResolved ?? null,
          claimMismatchSecondReasonCode: clean(directEvidenceSummary.claimMismatchSecondReasonCode || '', 80),
        },
        semanticMemoryRuntime: {
          status: semanticMemoryStatus,
          provider: clean(semanticMemory.runtimeProvider || '', 80),
          model: clean(semanticMemory.runtimeModel || '', 120),
          source: clean(semanticMemory.runtimeSource || '', 80),
          storedEntries: semanticMemory?.stored?.entries ?? null,
          storedRefs: semanticMemory?.stored?.refs ?? null,
          retrievalLogs: runtimeEvidence?.memory?.retrieval?.logs ?? null,
          blockerPresent: semanticMemoryUnconfigured,
        },
        semanticMemoryRecallQuality: {
          status: semanticRecallQualityStatus,
          ok: memoryRecallQuality?.ok === true,
          sampled: memoryRecallQuality?.queryProbe?.sampled ?? null,
          okRows: memoryRecallQuality?.queryProbe?.okRows ?? null,
          queryDim: memoryRecallQuality?.queryProbe?.queryDim ?? null,
          providerReturned: clean(memoryRecallQuality?.queryProbe?.providerReturned || '', 80),
          modelReturned: clean(memoryRecallQuality?.queryProbe?.modelReturned || '', 120),
          selectedEmbeddingCoverage: memoryRecallQuality?.retrievalLogCoverage?.selectedEmbeddingCoverage ?? null,
          selectedVisibleCoverage: memoryRecallQuality?.retrievalLogCoverage?.selectedVisibleCoverage ?? null,
          blockers: arr(memoryRecallQuality?.quality?.blockers).map((item) => clean(item, 120)),
        },
        selfEvolutionReadiness: {
          status: clean(selfEvolutionReadiness?.readiness?.status || 'missing', 120),
          liveStatus: clean(selfEvolutionReadiness?.readiness?.liveStatus || 'missing', 120),
          isolatedOk: selfEvolutionReadiness?.isolatedDrill?.ok === true,
          isolatedVariantGenerations: selfEvolutionReadiness?.isolatedDrill?.evidence?.variantGenerations ?? null,
          isolatedLineageEntries: selfEvolutionReadiness?.isolatedDrill?.evidence?.lineageEntries ?? null,
          isolatedHoldoutEntries: selfEvolutionReadiness?.isolatedDrill?.evidence?.holdoutEntries ?? null,
          isolatedBenchmarkEntries: selfEvolutionReadiness?.isolatedDrill?.evidence?.benchmarkEntries ?? null,
          liveVariantGenerations: selfEvolutionReadiness?.liveArchive?.variantGenerations ?? null,
          liveAppliedEntries: selfEvolutionReadiness?.liveArchive?.appliedEntries ?? null,
          liveLineageEntries: selfEvolutionReadiness?.liveArchive?.lineageEntries ?? null,
          liveHoldoutEntries: selfEvolutionReadiness?.liveArchive?.holdoutEntries ?? null,
          liveGaps: selfEvolutionLiveGaps,
        },
        v4IndexClaimAudit: {
          status: clean(v4IndexClaimAudit?.status?.audit || 'missing', 120),
          completionClaim: clean(v4IndexClaimAudit?.status?.completionClaim || '', 120),
          totalClaims: v4IndexSummary.totalClaims ?? null,
          supportedClaims: v4IndexSummary.supportedClaims ?? null,
          staleOrObsoletedClaims: v4IndexSummary.staleOrObsoletedClaims ?? null,
          policyDecisionClaims: v4IndexSummary.policyDecisionClaims ?? null,
          liveGapClaims: v4IndexSummary.liveGapClaims ?? null,
          useAs: clean(v4IndexRecommendation.useAs || '', 120),
          doNotUseAs: clean(v4IndexRecommendation.doNotUseAs || '', 120),
          nextAdjustments: arr(v4IndexRecommendation.nextAdjustments).map((item) => clean(item, 240)),
        },
        panelHealthOk: live.panel.healthOk,
        panelReadinessOk: live.panel.readinessOk,
        lmStudioModels: live.localModels.lmStudio.count,
        ollamaModels: live.localModels.ollama.count,
        keyModelFamilies: {
          qwen35: live.localModels.lmStudio.models.some((model) => /qwen\/qwen3\.6-35b-a3b/i.test(model)),
          qwen27: live.localModels.lmStudio.models.some((model) => /qwen.*27b/i.test(model)),
          gemma31: live.localModels.lmStudio.models.some((model) => /gemma-4-31b/i.test(model)),
          qwenEmbedding: live.localModels.ollama.models.some((model) => /qwen3-embedding/i.test(model)),
        },
      },
      judgment: semanticMemoryEnabled
        ? (semanticRecallQualityPassed
          ? '当前可诚实推进的是功能性、可审计自我意识，不是主观意识宣称。AGI/觉醒路线必须先修 prediction failure、surprise learning、expectation judge、affect health、DGM lineage/holdout；semantic memory provider 与只读 recall-quality probe 已通过。'
          : '当前可诚实推进的是功能性、可审计自我意识，不是主观意识宣称。AGI/觉醒路线必须先修 prediction failure、surprise learning、expectation judge、affect health、DGM lineage/holdout；semantic memory runtime 已启用，但召回质量仍需抽样。')
        : '当前可诚实推进的是功能性、可审计自我意识，不是主观意识宣称。AGI/觉醒路线必须先修 prediction failure、surprise learning、semantic memory runtime、affect health、DGM lineage/holdout。',
      missingEvidence: [
        surpriseAudit?.surpriseLearningLive === true
          ? 'source=surprise 需要抽样核验 outcome=0 证据引用'
          : 'surprise learning live proof 仍未通过：expectation outcome=0 与 source=surprise 仍为关键缺口',
        judgeBlockers.some((item) => item.id === 'semantic_trace_claim_coverage_low')
          ? (actionTraceMitigation.status === 'code_ready_live_pending_restart_or_new_actions'
            ? (postHintAudit?.status === 'code_mitigated_live_pending_new_evidence'
              ? (newActionSummary.ready === true
                ? 'post-hint 安全审计已完成，new-action readiness drill 已证明新证据能过 semanticTrace gate；live 仍需重启或新 action evidence 证明'
                : 'post-hint 安全审计已完成：历史 action success UNKNOWN 多缺 semanticTrace；代码侧 act.payload trace 保留已补，live 仍需重启或新 action evidence 证明')
              : 'expectation judge blocker 已定位：semanticTrace claim coverage 仍低；代码侧 act.payload trace 保留已补，live 仍需重启或新 action evidence 证明')
            : 'expectation judge blocker 已定位：semanticTrace claim coverage 仍低，action success 信号仍多被 UNKNOWN')
          : 'expectation judge blocker 仍需持续量化',
        postHintSummary.directEvidenceUnknown > 0
          ? (directEvidenceSummary.ready === true
            ? 'direct-evidence reask readiness drill 已证明二次复核可落账且不覆盖 claim_mismatch；历史 directEvidenceUnknown 仍需新 live 样本或 raw review'
            : 'directEvidenceUnknown 仍需 judge prompt/decisive reask contract review')
          : 'direct evidence UNKNOWN 当前未形成独立缺口',
        semanticMemoryEvidenceGap,
        'affect health score 低且饱和，需要新样本',
        selfEvolutionEvidenceGap,
        v4IndexSummary.totalClaims
          ? `v4 完整索引已接入 claim audit：${v4IndexSummary.staleOrObsoletedClaims || 0} 条已过时/被代码刷新，${v4IndexSummary.policyDecisionClaims || 0} 条需明确 policy 决策，${v4IndexSummary.liveGapClaims || 0} 条仍有 live/unproven 缺口`
          : 'v4 完整索引 claim audit 未接入或未生成',
      ],
    },
    {
      id: 'online_model_role',
      request: '是否还需要配合线上大模型',
      status: 'answered_as_architecture_boundary',
      evidence: {
        localModelsAvailable: live.localModels.lmStudio.count + live.localModels.ollama.count,
        panelReady: live.panel.readinessOk,
        paidProviderCallsRunHere: 0,
      },
      judgment: '线上模型需要作为 critic/research/review，不应默认掌执行权；执行、记忆、证据、回滚和权限决策应保留在本地 core。',
      missingEvidence: [
        '线上 provider 的真实付费/外网调用未在本审计运行，若要测必须单独授权',
      ],
    },
  ];

  return requirements;
}

function completionFromRequirements(requirements = []) {
  const incomplete = requirements.filter((item) => !['proven_complete', 'answered_as_architecture_boundary'].includes(item.status));
  return {
    achieved: false,
    reason: '原目标尚未被当前证据逐项证明完成；本报告保留活跃目标，不把 traceability/local drill 误报为 AGI 或全量 live proof。',
    incompleteRequirementIds: incomplete.map((item) => item.id),
    strictBlockerCount: incomplete.length,
  };
}

function buildNextActions({ requirements = [] }) {
  const missing = new Set(requirements.flatMap((item) => arr(item.missingEvidence)));
  return [
    {
      priority: 'P0',
      action: '在可接受时重启 51835，然后重跑 runtime evidence、memory roadmap、affect health 和 expectation cadence 验证',
      requiresOwnerDecision: true,
      reason: '当前多项代码已就绪但 live process 未加载，不能声称运行中。',
    },
    {
      priority: 'P0',
      action: '显式授权后运行 p0 authorized readonly probe，只保存 count/status bucket，不保存响应正文',
      requiresOwnerDecision: true,
      reason: '6 个 P0 文件仍缺 owner-authorized business proof。',
    },
    {
      priority: 'P0',
      action: '把 prediction failure → harvestSurprise → source=surprise 作为下一段最高优先级 live 验证',
      requiresOwnerDecision: false,
      reason: missing.has('surprise learning live proof 仍未通过：expectation outcome=0 与 source=surprise 仍为关键缺口') ? '这是 AGI/觉醒路线最大可证伪缺口，专项审计已把 code-ready/live-blocked 分开。' : '保持主动学习闭环为核心指标。',
    },
    {
      priority: 'P1',
      action: '跑受控 self-improve cycles，带 holdout-ref / benchmark refs，生成 lineage 与 rollback evidence',
      requiresOwnerDecision: true,
      reason: 'D3 不能只靠结构门和历史 archive 计数宣称完成。',
    },
    {
      priority: 'P1',
      action: '保留 cloud forebrain/critic 角色边界：线上只给研究、批判、复核，不直接执行或发布',
      requiresOwnerDecision: false,
      reason: '本地 continuity/evidence/rollback 才是 Noe 自治核心。',
    },
  ];
}

export async function buildGoalCompletionAudit({
  root = ROOT,
  paths = DEFAULT_PATHS,
  fetchImpl = globalThis.fetch,
  probeLive = true,
  now = new Date(),
} = {}) {
  const resolvedPaths = { ...DEFAULT_PATHS, ...paths };
  const v4Text = readText(resolvedPaths.v4Plan);
  const atlas = readJson(resolvedPaths.atlas) || {};
  const lineSemantics = readJson(resolvedPaths.lineSemantics) || {};
  const moduleMap = readJson(resolvedPaths.moduleMap) || {};
  const runtimeEvidence = readJson(resolvedPaths.runtimeEvidence) || {};
  const authMatrix = readJson(resolvedPaths.authMatrixLive) || {};
  const localDrills = readJson(resolvedPaths.localDrills) || {};
  const notProvenLiveDisposition = readJson(resolvedPaths.notProvenLiveDisposition) || {};
  const weakRuntimeSupportReview = readJson(resolvedPaths.weakRuntimeSupportReview) || {};
  const weakRouteSurfaceProbe = readJson(resolvedPaths.weakRouteSurfaceProbe) || {};
  const weakRuntimeRemainingLaneAudit = readJson(resolvedPaths.weakRuntimeRemainingLaneAudit) || {};
  const surpriseAudit = readJson(resolvedPaths.surpriseLearningAudit) || {};
  const judgeBlockerAudit = readJson(resolvedPaths.expectationJudgeBlockerAudit) || {};
  const postHintAudit = readJson(resolvedPaths.postHintJudgementAudit) || {};
  const newActionReadiness = readJson(resolvedPaths.newActionEvidenceReadiness) || {};
  const directEvidenceReadiness = readJson(resolvedPaths.directEvidenceReaskReadiness) || {};
  const memoryRecallQuality = readJson(resolvedPaths.memorySemanticRecallQuality) || {};
  const selfEvolutionReadiness = readJson(resolvedPaths.selfEvolutionReadiness) || {};
  const p0Auth = readJson(resolvedPaths.p0AuthorizedReadonly) || {};
  const v4IndexClaimAudit = readJson(resolvedPaths.v4IndexClaimAudit) || {};
  const live = probeLive
    ? await probeLiveLocalState({ fetchImpl })
    : {
        policy: { localhostOnly: true, noAuthHeaders: true, noOwnerTokenRead: true, noModelGenerationCalls: true },
        panel: { healthOk: false, readinessOk: false, errors: ['live_probe_disabled'] },
        localModels: { lmStudio: { ok: false, count: 0, models: [] }, ollama: { ok: false, count: 0, models: [] } },
      };
  const v4 = v4PlanStats(v4Text);
  const requirements = buildRequirements({
    v4,
    atlas,
    lineSemantics,
    moduleMap,
    runtimeEvidence,
    authMatrix,
    localDrills,
    notProvenLiveDisposition,
    weakRuntimeSupportReview,
    weakRouteSurfaceProbe,
    weakRuntimeRemainingLaneAudit,
    surpriseAudit,
    judgeBlockerAudit,
    postHintAudit,
    newActionReadiness,
    directEvidenceReadiness,
    memoryRecallQuality,
    selfEvolutionReadiness,
    p0Auth,
    v4IndexClaimAudit,
    live,
  });
  const completion = completionFromRequirements(requirements);
  return {
    ok: true,
    generatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    root,
    objective: {
      fullCodeUnderstanding: true,
      usefulnessAndRuntimeTruth: true,
      agiAwakeningAdjustment: true,
      onlineModelDecision: true,
    },
    inputs: pathSummary(resolvedPaths),
    policy: {
      readOnlyAudit: true,
      noEnvFileReads: true,
      noOwnerTokenReads: true,
      noProtectedApiAuth: true,
      noChatOrCompletionCalls: true,
      noExternalProviderCalls: true,
      noShellExecution: true,
      noSecretValuesReturned: true,
    },
    live,
    requirements,
    completion,
    nextActions: buildNextActions({ requirements }),
  };
}

function mdTable(rows) {
  return rows.map((row) => `| ${row.join(' | ')} |`).join('\n');
}

function renderMarkdown(report, jsonPath) {
  const requirementRows = report.requirements.map((item) => [
    `\`${item.id}\``,
    item.status,
    clean(item.judgment, 260),
    arr(item.missingEvidence).map((missing) => clean(missing, 120)).join('<br>') || '-',
  ]);
  const modelRows = [
    ['LM Studio', String(report.live.localModels.lmStudio.count), report.live.localModels.lmStudio.models.map((model) => `\`${model}\``).join('<br>') || '-'],
    ['Ollama', String(report.live.localModels.ollama.count), report.live.localModels.ollama.models.map((model) => `\`${model}\``).join('<br>') || '-'],
  ];
  const actionRows = report.nextActions.map((item) => [
    item.priority,
    item.requiresOwnerDecision ? 'yes' : 'no',
    clean(item.action, 260),
    clean(item.reason, 220),
  ]);
  return [
    '# Neo Goal Completion Audit',
    '',
    `Generated: ${report.generatedAt}`,
    `Project root: \`${report.root}\``,
    '',
    '## Verdict',
    '',
    `- achieved: ${report.completion.achieved}`,
    `- reason: ${report.completion.reason}`,
    `- incomplete requirement ids: ${report.completion.incompleteRequirementIds.map((id) => `\`${id}\``).join(', ') || '-'}`,
    '',
    '## Live Local State',
    '',
    `- panel health ok: ${report.live.panel.healthOk}`,
    `- panel readiness ok: ${report.live.panel.readinessOk}`,
    `- readiness status: ${report.live.panel.readinessStatus || '-'}`,
    `- memory visible: ${report.live.panel.memoryVisible ?? '-'}`,
    `- pending approvals: ${report.live.panel.pendingApprovals ?? '-'}`,
    `- pending acts: ${report.live.panel.pendingActs ?? '-'}`,
    '',
    mdTable([
      ['provider', 'count', 'models'],
      ['---', '---:', '---'],
      ...modelRows,
    ]),
    '',
    '## Requirements',
    '',
    mdTable([
      ['requirement', 'status', 'judgment', 'missing evidence'],
      ['---', '---', '---', '---'],
      ...requirementRows,
    ]),
    '',
    '## Next Actions',
    '',
    mdTable([
      ['priority', 'owner decision', 'action', 'reason'],
      ['---', '---', '---', '---'],
      ...actionRows,
    ]),
    '',
    '## JSON',
    '',
    `Full report: \`${jsonPath.replace(`${ROOT}/`, '')}\`.`,
  ].join('\n');
}

export function writeGoalCompletionAudit(report) {
  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, `${OUT_BASE}.json`);
  const mdPath = join(OUT_DIR, `${OUT_BASE}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  writeFileSync(mdPath, `${renderMarkdown(report, jsonPath)}\n`, { mode: 0o600 });
  return { jsonPath, mdPath };
}

export { probeLiveLocalState, renderMarkdown };

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await buildGoalCompletionAudit();
  const paths = writeGoalCompletionAudit(report);
  console.log(JSON.stringify({
    ok: report.ok,
    achieved: report.completion.achieved,
    strictBlockerCount: report.completion.strictBlockerCount,
    panelHealthOk: report.live.panel.healthOk,
    panelReadinessOk: report.live.panel.readinessOk,
    lmStudioModels: report.live.localModels.lmStudio.count,
    ollamaModels: report.live.localModels.ollama.count,
    paths,
  }, null, 2));
}
