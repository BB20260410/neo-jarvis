import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGoalCompletionAudit, renderMarkdown } from '../../scripts/noe-goal-completion-audit.mjs';

describe('noe-goal-completion-audit', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeJson(name, value) {
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  function writeText(name, value) {
    const path = join(dir, name);
    writeFileSync(path, value);
    return path;
  }

  function fixturePaths({ semanticMemoryEnabled = false } = {}) {
    dir = mkdtempSync(join(tmpdir(), 'noe-goal-completion-audit-'));
    return {
      v4Plan: writeText('v4.md', '# v4\n\nD1 D2 D3 D4 D5\n\nW14\n'),
      atlas: writeJson('atlas.json', {
        summary: {
          files: 1426,
          lines: 335129,
          symbolBlocks: 10020,
          exportedSymbolBlocks: 2321,
          modules: 55,
          parseFailures: 0,
          filesNotProvenLive: 700,
          filesStaticRuntimeSurfaceUnproven: 49,
          runtimeBlockers: ['expectation_no_failed_samples'],
        },
      }),
      lineSemantics: writeJson('line-semantics.json', {
        status: {
          lineClassification: 'all_lines_classified_no_body',
          semanticSignoff: 'not_claimed',
        },
        summary: {
          files: 1426,
          lines: 335129,
          classifiedLines: 335129,
          classifiedLineCoveragePct: 100,
          readFailures: 0,
          parseFailures: 0,
          codeLikeLines: 274204,
          symbolCoveredCodePct: 53.6,
          topLevelCodeLines: 127213,
          topLevelCodePct: 46.4,
        },
      }),
      moduleMap: writeJson('module-map.json', {
        totals: { files: 1426, lines: 335129, modules: 55 },
      }),
      runtimeEvidence: writeJson('runtime-evidence.json', semanticMemoryEnabled
        ? {
            blockers: [
              'expectation_no_failed_samples',
              'expectation_judge_decisive_unknown_rate_high',
              'curiosity_source_surprise_absent',
              'affect_health_below_target',
            ],
            memory: {
              retrieval: { logs: 55 },
              semantic: {
                status: 'enabled',
                runtimeProvider: 'ollama',
                runtimeModel: 'qwen3-embedding:0.6b',
                runtimeSource: 'default',
                stored: { entries: 647, refs: 647 },
              },
            },
          }
        : {
            blockers: [
              'expectation_no_failed_samples',
              'curiosity_source_surprise_absent',
              'memory_semantic_runtime_unconfigured',
            ],
          }),
      authMatrixLive: writeJson('auth-matrix.json', {
        summary: {
          backlogFiles: 68,
          liveAuthSurfaceFiles: 25,
          liveAuthSurfacePaths: 43,
        },
      }),
      localDrills: writeJson('local-drills.json', {
        summary: {
          targetFiles: 43,
          drilledFiles: 43,
          okDrills: 43,
          failedDrills: 0,
          lanesCovered: 16,
          rawSecretMarkersPresent: false,
        },
      }),
      notProvenLiveDisposition: writeJson('not-proven-live-disposition.json', {
        status: {
          disposition: 'not_proven_live_broad_label_split',
          completionClaim: 'not_complete',
        },
        summary: {
          atlasNotProvenLive: 700,
          atlasStaticRuntimeSurfaceUnproven: 49,
          dispositionCounts: {
            live_runtime_evidence: 690,
            live_auth_surface_proved_business_pending: 25,
            local_behavior_drill_ok: 33,
            local_or_natural_runtime_evidence_drill_ok: 4,
            provider_status_or_mock_drill_ok: 1,
            verification_test_not_runtime_feature: 620,
            support_only_reviewed: 5,
          },
          weakRuntimeFiles: 62,
          ownerOrLiveNeededFiles: 16,
          ownerTokenNeededFiles: 9,
          livePanelNeededFiles: 8,
          paidQuotaRiskFiles: 4,
        },
      }),
      weakRuntimeSupportReview: writeJson('weak-runtime-support-review.json', {
        status: {
          review: 'weak_runtime_support_review_complete',
          completionClaim: 'not_complete',
        },
        summary: {
          weakFiles: 62,
          runtimeProbeNeeded: 44,
          supportConfirmed: 16,
          manualReviewOrProbeNeeded: 2,
          routeImportedRuntimeCandidates: 25,
          serverImportedRuntimeCandidates: 15,
          librarySupportWithUnitCoverage: 10,
        },
      }),
      weakRouteSurfaceProbe: writeJson('weak-route-surface-probe.json', {
        status: {
          probe: 'weak_route_surface_live_probe_complete',
          completionClaim: 'not_complete',
        },
        mode: 'unauthorized_live_get_probe',
        summary: {
          routeCandidateFiles: 25,
          protectedGetCandidateFiles: 20,
          uniqueProtectedGetPaths: 31,
          dynamicPlaceholderPaths: 4,
          liveProbeExecuted: true,
          liveAuthSurfaceFiles: 18,
          liveAuthSurfacePaths: 31,
          remainingWithoutProtectedGet: 5,
          remainingWithoutLiveAuthSurface: 7,
        },
      }),
      weakRuntimeRemainingLaneAudit: writeJson('weak-runtime-remaining-lane.json', {
        status: {
          audit: 'weak_runtime_remaining_lanes_split',
          completionClaim: 'not_complete',
        },
        summary: {
          actionableFiles: 45,
          routeLiveAuthSurfaceBusinessPending: 21,
          routeNoSafeGetFiles: 4,
          routeTargetedDrilledOk: 25,
          routeLiveAuthSurfaceTargetedDrilledOk: 21,
          routeNoSafeGetTargetedDrilledOk: 4,
          routeProtectedBusinessProofStillNeeded: 25,
          serverCandidates: 15,
          serverBootImported: 12,
          serverServiceChain: 3,
          serverTargetedDrilledOk: 15,
          serverBootTargetedDrilledOk: 12,
          serverServiceChainTargetedDrilledOk: 3,
          serverNaturalRuntimeStillNeeded: 15,
          chainCandidates: 4,
          chainTargetedDrilledOk: 4,
          manualSupportReviewFiles: 1,
          manualSupportDrilledOk: 1,
          manualSupportSkippedByPolicy: 0,
          ownerDecisionNeededFiles: 25,
          naturalRuntimeNeededFiles: 16,
          naturalRuntimeDirectEvidenceFiles: 0,
          naturalRuntimeIndirectSignalFiles: 8,
          naturalRuntimeMissingEvidenceFiles: 8,
          naturalRuntimeProofStillNeeded: 16,
          targetedProbeNeededFiles: 44,
          postDrillTargetedProbeNeededFiles: 25,
          componentContractDrilledOk: 20,
        },
      }),
      surpriseLearningAudit: writeJson('surprise-learning.json', {
        status: 'code_ready_live_blocked_no_failed_samples',
        surpriseLearningLive: false,
        diagnostics: [
          'expectation_failure_not_observed',
          'source_surprise_absent',
          'expectation_judge_decisive_unknown_rate_high',
        ],
        current: {
          expectationsFailed: 0,
          failedSurpriseEligible: 0,
          surpriseGoals: 0,
          decisiveUnknownRate: 0.956,
          ownerPredictionStatus: 'code_ready_live_pending_restart',
        },
        trend: {
          snapshots: 8,
          allFailedZero: true,
          allSurpriseGoalsZero: true,
          avgDecisiveUnknownRate: 0.956,
        },
      }),
      expectationJudgeBlockerAudit: writeJson('judge-blocker.json', {
        status: 'blocked_at_judge_and_evidence_linkage',
        codeMitigations: {
          actionEvidenceActPayloadSemanticTrace: {
            status: 'code_ready_live_pending_restart_or_new_actions',
            liveStatus: 'pending_restart_or_new_action_evidence',
          },
        },
        runtime: {
          decisiveUnknownRate: 0.972,
        },
        calibration: {
          recent: {
            outcomeCounts: { unknown: 59 },
            evidenceDecision: { actionSuccess: 18 },
            evidenceClaimAlignment: {
              semanticTraceMaxCoverage: 0.167,
            },
          },
        },
        blockers: [
          { id: 'no_failed_expectation_samples', severity: 'P0' },
          { id: 'decisive_hints_mostly_unknown', severity: 'P0' },
          { id: 'semantic_trace_claim_coverage_low', severity: 'P0' },
          { id: 'observation_only_result_noise', severity: 'P1' },
        ],
      }),
      postHintJudgementAudit: writeJson('post-hint.json', {
        status: 'code_mitigated_live_pending_new_evidence',
        summary: {
          uniqueJudgements: 19,
          actionSuccessUnknown: 7,
          observationOnlyUnknown: 9,
          directEvidenceUnknown: 1,
          staleActionHintOnObservationOnly: 1,
          semanticTraceCoverageMax: 0.167,
        },
      }),
      newActionEvidenceReadiness: writeJson('new-action-readiness.json', {
        status: 'ready_for_new_action_evidence_after_restart_or_natural_action',
        summary: {
          ready: true,
          newActionSemanticTraceCoverage: 1,
          legacyActionSemanticTraceCoverage: 0.178,
          observationOnlySemanticTraceCoverage: 0,
        },
      }),
      directEvidenceReaskReadiness: writeJson('direct-reask-readiness.json', {
        status: 'ready_for_direct_evidence_decisive_reask',
        summary: {
          ready: true,
          directSuccessResolved: 1,
          directSuccessOutcome: 1,
          directSuccessSemanticTraceCoverage: 1,
          claimMismatchResolved: 0,
          claimMismatchSecondReasonCode: 'claim_mismatch',
        },
      }),
      memorySemanticRecallQuality: writeJson('memory-recall-quality.json', semanticMemoryEnabled
        ? {
            ok: true,
            quality: {
              status: 'recall_quality_probe_passed',
              blockers: [],
            },
            queryProbe: {
              sampled: 5,
              okRows: 5,
              queryDim: 1024,
              providerReturned: 'ollama',
              modelReturned: 'qwen3-embedding:0.6b',
            },
            retrievalLogCoverage: {
              selectedEmbeddingCoverage: 1,
              selectedVisibleCoverage: 0.923,
            },
          }
        : {
            ok: false,
            quality: { status: 'missing', blockers: [] },
          }),
      selfEvolutionReadiness: writeJson('self-evolution-readiness.json', {
        ok: true,
        readiness: {
          status: 'archive_writer_lineage_holdout_ready',
          liveStatus: 'live_archive_still_below_target',
          liveGaps: [
            'live_dgm_archive_generations_below_target',
            'live_dgm_parent_child_lineage_missing',
            'live_dgm_holdout_or_benchmark_missing',
            'live_dgm_applied_entry_missing',
          ],
        },
        liveArchive: {
          variantGenerations: 1,
          appliedEntries: 0,
          lineageEntries: 0,
          holdoutEntries: 0,
        },
        isolatedDrill: {
          ok: true,
          evidence: {
            variantGenerations: 10,
            lineageEntries: 11,
            holdoutEntries: 11,
            benchmarkEntries: 11,
          },
        },
      }),
      p0AuthorizedReadonly: writeJson('p0-auth.json', {
        summary: {
          p0FilesStillMissingBusinessProof: [
            'src/agents/AgentRunStore.js',
            'src/research/WebSearch.js',
          ],
        },
      }),
    };
  }

  function fakeFetch(url) {
    if (url.endsWith('/health')) {
      return Promise.resolve({
        status: 200,
        text: async () => JSON.stringify({ ok: true, at: '2026-06-15T00:00:00.000Z' }),
      });
    }
    if (url.endsWith('/api/noe/readiness')) {
      return Promise.resolve({
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          readiness: { status: 'passed' },
          counts: { memoryVisible: 12, focusDepth: 2, enabled: 9, total: 9, pendingApprovals: 1, pendingActs: 0 },
          p6: { ruminationGuardTripRate: 0.1 },
        }),
      });
    }
    if (url.endsWith('/v1/models')) {
      return Promise.resolve({
        status: 200,
        text: async () => JSON.stringify({ data: [{ id: 'qwen/qwen3.6-35b-a3b' }, { id: 'qwen/qwen3.6-27b' }] }),
      });
    }
    if (url.endsWith('/api/tags')) {
      return Promise.resolve({
        status: 200,
        text: async () => JSON.stringify({ models: [{ name: 'qwen3-embedding:0.6b' }] }),
      });
    }
    throw new Error(`unexpected url ${url}`);
  }

  it('keeps the broad goal incomplete even when atlas and local drills are green', async () => {
    const report = await buildGoalCompletionAudit({
      root: dir || process.cwd(),
      paths: fixturePaths(),
      fetchImpl: fakeFetch,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });

    expect(report.completion).toMatchObject({
      achieved: false,
      strictBlockerCount: 3,
    });
    expect(report.completion.incompleteRequirementIds).toEqual([
      'full_code_function_architecture_understanding',
      'feature_usefulness_and_runtime_truth',
      'agi_awakening_self_awareness_adjustment',
    ]);
    expect(report.requirements.find((item) => item.id === 'full_code_function_architecture_understanding')).toMatchObject({
      status: 'line_classified_not_semantically_signed_off',
      evidence: {
        atlasFiles: 1426,
        symbolBlocks: 10020,
        parseFailures: 0,
        lineSemantics: {
          status: 'all_lines_classified_no_body',
          semanticSignoff: 'not_claimed',
          classifiedLineCoveragePct: 100,
          readFailures: 0,
          codeLikeLines: 274204,
          symbolCoveredCodePct: 53.6,
          topLevelCodeLines: 127213,
        },
      },
    });
    expect(report.requirements.find((item) => item.id === 'feature_usefulness_and_runtime_truth')).toMatchObject({
      status: 'partially_proven_with_live_gaps',
      evidence: {
        localDrillTargetFiles: 43,
        localDrillOk: 43,
        p0MissingBusinessProof: 2,
        notProvenLiveDisposition: {
          status: 'not_proven_live_broad_label_split',
          atlasNotProvenLive: 700,
          liveAuthSurfaceBusinessPending: 25,
          localBehaviorDrillOk: 33,
          weakRuntimeFiles: 62,
          ownerOrLiveNeededFiles: 16,
          weakReview: {
            status: 'weak_runtime_support_review_complete',
            weakFiles: 62,
            runtimeProbeNeeded: 44,
            supportConfirmed: 16,
            manualReviewOrProbeNeeded: 2,
            routeImportedRuntimeCandidates: 25,
            serverImportedRuntimeCandidates: 15,
            librarySupportWithUnitCoverage: 10,
          },
          weakRouteSurfaceProbe: {
            status: 'weak_route_surface_live_probe_complete',
            mode: 'unauthorized_live_get_probe',
            routeCandidateFiles: 25,
            protectedGetCandidateFiles: 20,
            uniqueProtectedGetPaths: 31,
            dynamicPlaceholderPaths: 4,
            liveProbeExecuted: true,
            liveAuthSurfaceFiles: 18,
            liveAuthSurfacePaths: 31,
            remainingWithoutProtectedGet: 5,
            remainingWithoutLiveAuthSurface: 7,
          },
          weakRemainingLanes: {
            status: 'weak_runtime_remaining_lanes_split',
            actionableFiles: 45,
            routeLiveAuthSurfaceBusinessPending: 21,
            routeNoSafeGetFiles: 4,
            routeTargetedDrilledOk: 25,
            routeLiveAuthSurfaceTargetedDrilledOk: 21,
            routeNoSafeGetTargetedDrilledOk: 4,
            routeProtectedBusinessProofStillNeeded: 25,
            serverCandidates: 15,
            serverBootImported: 12,
            serverServiceChain: 3,
            serverTargetedDrilledOk: 15,
            serverBootTargetedDrilledOk: 12,
            serverServiceChainTargetedDrilledOk: 3,
            serverNaturalRuntimeStillNeeded: 15,
            chainCandidates: 4,
            chainTargetedDrilledOk: 4,
            manualSupportReviewFiles: 1,
            manualSupportDrilledOk: 1,
            manualSupportSkippedByPolicy: 0,
            ownerDecisionNeededFiles: 25,
            naturalRuntimeNeededFiles: 16,
            naturalRuntimeDirectEvidenceFiles: 0,
            naturalRuntimeIndirectSignalFiles: 8,
            naturalRuntimeMissingEvidenceFiles: 8,
            naturalRuntimeProofStillNeeded: 16,
            targetedProbeNeededFiles: 44,
            postDrillTargetedProbeNeededFiles: 25,
            componentContractDrilledOk: 20,
          },
        },
      },
    });
    expect(report.requirements.find((item) => item.id === 'agi_awakening_self_awareness_adjustment')).toMatchObject({
      status: 'not_achieved_recommendation_ready',
      evidence: {
        surpriseLearningStatus: 'code_ready_live_blocked_no_failed_samples',
        surpriseLearningLive: false,
        surpriseCurrent: {
          expectationsFailed: 0,
          failedSurpriseEligible: 0,
          surpriseGoals: 0,
          decisiveUnknownRate: 0.956,
        },
        expectationJudgeBlockerStatus: 'blocked_at_judge_and_evidence_linkage',
        expectationJudgeP0Blockers: [
          'no_failed_expectation_samples',
          'decisive_hints_mostly_unknown',
          'semantic_trace_claim_coverage_low',
        ],
        expectationJudgeMetrics: {
          decisiveUnknownRate: 0.972,
          semanticTraceMaxCoverage: 0.167,
          actionSuccessSignals: 18,
          recentUnknown: 59,
        },
        expectationJudgeCodeMitigations: {
          actionEvidenceActPayloadSemanticTrace: 'code_ready_live_pending_restart_or_new_actions',
          liveStatus: 'pending_restart_or_new_action_evidence',
        },
        postHintJudgement: {
          status: 'code_mitigated_live_pending_new_evidence',
          uniqueJudgements: 19,
          actionSuccessUnknown: 7,
          observationOnlyUnknown: 9,
          directEvidenceUnknown: 1,
          staleActionHintOnObservationOnly: 1,
          semanticTraceCoverageMax: 0.167,
        },
        newActionEvidenceReadiness: {
          status: 'ready_for_new_action_evidence_after_restart_or_natural_action',
          ready: true,
          newActionSemanticTraceCoverage: 1,
          legacyActionSemanticTraceCoverage: 0.178,
          observationOnlySemanticTraceCoverage: 0,
        },
        directEvidenceReaskReadiness: {
          status: 'ready_for_direct_evidence_decisive_reask',
          ready: true,
          directSuccessResolved: 1,
          directSuccessOutcome: 1,
          directSuccessSemanticTraceCoverage: 1,
          claimMismatchResolved: 0,
          claimMismatchSecondReasonCode: 'claim_mismatch',
        },
        selfEvolutionReadiness: {
          status: 'archive_writer_lineage_holdout_ready',
          liveStatus: 'live_archive_still_below_target',
          isolatedOk: true,
          isolatedVariantGenerations: 10,
          isolatedLineageEntries: 11,
          isolatedHoldoutEntries: 11,
          isolatedBenchmarkEntries: 11,
          liveVariantGenerations: 1,
          liveAppliedEntries: 0,
          liveLineageEntries: 0,
          liveHoldoutEntries: 0,
          liveGaps: [
            'live_dgm_archive_generations_below_target',
            'live_dgm_parent_child_lineage_missing',
            'live_dgm_holdout_or_benchmark_missing',
            'live_dgm_applied_entry_missing',
          ],
        },
        panelReadinessOk: true,
        lmStudioModels: 2,
        ollamaModels: 1,
        keyModelFamilies: { qwen35: true, qwen27: true, qwenEmbedding: true },
      },
    });
    expect(report.requirements.find((item) => item.id === 'online_model_role')).toMatchObject({
      status: 'answered_as_architecture_boundary',
      evidence: { paidProviderCallsRunHere: 0 },
    });
  });

  it('renders a markdown verdict without claiming completion', async () => {
    const report = await buildGoalCompletionAudit({
      root: dir || process.cwd(),
      paths: fixturePaths(),
      fetchImpl: fakeFetch,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const md = renderMarkdown(report, join(dir, 'audit.json'));

    expect(md).toContain('achieved: false');
    expect(md).toContain('line_classified_not_semantically_signed_off');
    expect(md).toContain('qwen/qwen3.6-35b-a3b');
    expect(md).not.toContain('Bearer ');
  });

  it('does not keep the stale semantic memory restart blocker after runtime evidence is enabled', async () => {
    const report = await buildGoalCompletionAudit({
      root: dir || process.cwd(),
      paths: fixturePaths({ semanticMemoryEnabled: true }),
      fetchImpl: fakeFetch,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const agi = report.requirements.find((item) => item.id === 'agi_awakening_self_awareness_adjustment');

    expect(agi.evidence.semanticMemoryRuntime).toMatchObject({
      status: 'enabled',
      provider: 'ollama',
      model: 'qwen3-embedding:0.6b',
      source: 'default',
      storedEntries: 647,
      storedRefs: 647,
      retrievalLogs: 55,
      blockerPresent: false,
    });
    expect(agi.evidence.semanticMemoryRecallQuality).toMatchObject({
      status: 'recall_quality_probe_passed',
      ok: true,
      sampled: 5,
      okRows: 5,
      queryDim: 1024,
      providerReturned: 'ollama',
      modelReturned: 'qwen3-embedding:0.6b',
      selectedEmbeddingCoverage: 1,
      selectedVisibleCoverage: 0.923,
      blockers: [],
    });
    expect(agi.judgment).toContain('semantic memory provider 与只读 recall-quality probe 已通过');
    expect(agi.missingEvidence).toContain('semantic memory recall-quality probe 已通过；剩余缺口是必要时做 owner/user-facing 召回样本，不是 provider 或索引配置');
    expect(agi.missingEvidence).toContain('DGM archive writer 已隔离证明 10 代 lineage/holdout/benchmark 可生成；live 仍缺真实 10+ generations、applied self-mod、lineage/holdout 记录');
    expect(agi.missingEvidence).not.toContain('semantic memory runtime 当前仍需重启后复验');
    expect(agi.missingEvidence).not.toContain('DGM/self-evolution 缺 10+ generations、lineage、holdout、真实 applied self-mod evidence');
  });
});
