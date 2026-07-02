import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeV4IndexClaimAudit,
  renderMarkdown,
} from '../../scripts/noe-v4-index-claim-audit.mjs';

describe('noe-v4-index-claim-audit', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function write(path, value) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, value);
    return abs;
  }

  function writeJson(path, value) {
    return write(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  function fixturePaths() {
    dir = mkdtempSync(join(tmpdir(), 'noe-v4-index-claim-'));
    write('src/cognition/NoeAffectHealth.js', 'export function evaluateAffectHealth() { return { score: 0.5 }; }\n');
    write('src/cognition/NoeSleepTimeCompute.js', 'export function createSleepTimeCompute() { return { tick() {} }; }\n');
    write('src/room/NoeEvolutionArchive.js', 'export function buildNoeEvolutionArchiveEntry() { return {}; }\n');
    write('src/server/routes/mcp.js', 'import { requireOwnerToken } from "../auth/owner-token.js";\nfunction requirePermission() {}\n');
    write('src/skills/NoeSkillDraftApply.js', 'export const error = "owner_confirmation_required";\n');
    write('tests/unit/noe-sleeptime-compute.test.js', 'import { describe } from "vitest";\n');

    return {
      v4Index: write('v4-index.txt', [
        'Neo 贾维斯 — 整体方案 v4 完整索引',
        '核心目标是培养 AI 自由意识、觉醒意识、AGI。',
        'NoeAffectHealth.js 0 命中；W0 必须新建 50 行。',
        'DGM 跨代 archive 完全空白。',
        '范式 5 元认知 circuit tracing；W9-W12 接 transformer_lens。',
        'A8 Self-Rewarding 自主；NOE_SELF_REWARD=1。',
        'A10 MCP 公开，不设 auth/authz。',
        'Neo 5 AI Freedoms: F1 表达自由 F2 进化自由 F3 评价自由 F4 工具自由 F5 模型自主。',
        'D1 D2 D3 D4 D5 五维验收。',
        'CLAUDE.md / AGENTS.md / PROJECT_INTRO 红线:不动。',
      ].join('\n')),
      runtimeEvidence: writeJson('runtime.json', {
        generatedAt: '2026-06-15T00:00:00.000Z',
        awakeningDimensions: {
          dimensions: [
            { id: 'D1_self_awareness', status: 'partial', evidence: { innerMonologue7d: 1200, narrativeLikeEpisodes7d: 0 } },
            { id: 'D2_self_decision', status: 'met', evidence: { autonomousGoals7d: 60, driveGoals7d: 10 } },
            {
              id: 'D3_self_evolution',
              status: 'partial',
              evidence: {
                selfEvolutionActs7d: 0,
                dgmArchive: { variantGenerations: 1, appliedEntries: 0, lineageEntries: 0, holdoutEntries: 0 },
              },
            },
            { id: 'D4_self_boundary', status: 'not_proven', evidence: { blockedSafety7d: 1, failedActs7d: 9 } },
            {
              id: 'D5_ai_welfare',
              status: 'not_proven',
              evidence: {
                affectHealth: {
                  status: 'needs_attention',
                  score: 0.5,
                  saturatedRatio: 1,
                  varianceMean: 0,
                  alerts: ['affect_saturation_high'],
                },
                affectConfig: { serverDefaultDesaturateOnNextStart: true },
              },
            },
          ],
        },
      }),
      goalCompletionAudit: writeJson('goal.json', {
        generatedAt: '2026-06-15T00:00:00.000Z',
        live: {
          panel: { readinessOk: true },
          localModels: {
            lmStudio: { count: 12, models: ['qwen/qwen3.6-35b-a3b', 'qwen/qwen3.6-27b'] },
            ollama: { count: 6, models: ['qwen3-embedding:0.6b'] },
          },
        },
        completion: {
          achieved: false,
          strictBlockerCount: 3,
          incompleteRequirementIds: ['full_code_function_architecture_understanding'],
        },
      }),
      lineSemantics: writeJson('line.json', {
        generatedAt: '2026-06-15T00:00:00.000Z',
        status: { lineClassification: 'all_lines_classified_no_body' },
        byModule: [{ module: 'tests', files: 4 }],
      }),
      selfEvolutionReadiness: writeJson('self-evo.json', {
        generatedAt: '2026-06-15T00:00:00.000Z',
        readiness: { status: 'archive_writer_lineage_holdout_ready' },
        isolatedDrill: { evidence: { variantGenerations: 10 } },
      }),
      naturalRuntimeEvidence: writeJson('natural.json', {
        generatedAt: '2026-06-15T00:00:00.000Z',
        summary: {
          directStructuredRuntimeEvidenceFiles: 0,
          naturalRuntimeProofStillNeeded: 16,
          common: { heartbeatByKind1h: { sleeptimeCompute: 3 } },
        },
      }),
    };
  }

  it('classifies stale roadmap claims separately from policy and live-proof gaps', () => {
    const paths = fixturePaths();
    const report = buildNoeV4IndexClaimAudit({
      root: dir,
      paths,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const byId = new Map(report.claims.map((item) => [item.id, item]));
    const raw = JSON.stringify(report);
    const md = renderMarkdown(report, join(dir, 'v4-index-claim-audit.json'));

    expect(report.summary.totalClaims).toBeGreaterThan(8);
    expect(byId.get('affect_health_zero_hit')).toMatchObject({
      status: 'stale_or_obsoleted_by_current_code',
      evidence: expect.objectContaining({ fileExists: true, runtimeScore: 0.5 }),
    });
    expect(byId.get('dgm_archive_blank')).toMatchObject({
      status: 'partially_supported_live_gap',
      evidence: expect.objectContaining({ isolatedVariantGenerations: 10, liveVariantGenerations: 1 }),
    });
    expect(byId.get('mcp_public_no_auth_a10')).toMatchObject({
      status: 'policy_conflict_requires_owner_decision',
      evidence: expect.objectContaining({ mcpRouteRequiresOwnerToken: true, mcpRouteHasPermissionFlow: true }),
    });
    expect(byId.get('five_ai_freedoms')).toMatchObject({
      status: 'policy_conflict_requires_owner_decision',
    });
    expect(byId.get('completion_claim')).toMatchObject({
      status: 'not_implemented_or_unproven',
      evidence: expect.objectContaining({ goalAchieved: false, naturalRuntimeProofStillNeeded: 16 }),
    });
    expect(report.policy).toMatchObject({
      noOwnerTokenReads: true,
      noModelCalls: true,
      noLiveHttpRequests: true,
    });
    expect(raw).not.toContain('Bearer ');
    expect(md).toContain('v4 complete-index document should be used as a roadmap');
  });
});
