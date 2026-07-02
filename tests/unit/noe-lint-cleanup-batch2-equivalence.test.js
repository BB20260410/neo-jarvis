// @ts-check
// 批2 lint 整洁的等价性守卫：证明本轮删未用符号 / 加 _ 前缀 / 解构别名 后，
// 受影响模块的公共导出与运行时行为逐字不变。确定性（不触网、不依赖真实时钟断言）。
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import * as ProposalInbox from '../../src/runtime/NoeProposalInbox.js';
import * as ProposalExecutor from '../../src/runtime/NoeProposalExecutor.js';
import * as SkillCurator from '../../src/skills/SkillCurator.js';
import * as SemanticBackfill from '../../src/memory/NoeMemorySemanticBackfill.js';
import * as AutonomousReview from '../../src/memory/NoeMemoryAutonomousReview.js';

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

describe('lint-cleanup batch2 等价性守卫', () => {
  it('删未用本地函数后，受影响模块公共导出仍完整（防误删 export）', () => {
    // NoeProposalExecutor：删了未用 import join，导出不应受影响
    expect(typeof ProposalExecutor.buildNoeProposalExecutionPlan).toBe('function');
    expect(typeof ProposalExecutor.executeNoeProposalMaterialization).toBe('function');
    expect(ProposalExecutor.NOE_PROPOSAL_EXECUTOR_SCHEMA_VERSION).toBe(1);
    // SkillCurator：删了未用 import dirname
    expect(typeof SkillCurator.runSkillCurator).toBe('function');
    expect(typeof SkillCurator.classifySkillForCurator).toBe('function');
    // NoeMemorySemanticBackfill：删了死本地函数 embeddingSummary（不是 export）
    expect(typeof SemanticBackfill.runNoeMemorySemanticBackfill).toBe('function');
    expect('embeddingSummary' in SemanticBackfill).toBe(false);
    // NoeMemoryAutonomousReview：删了死本地函数 json（不是 export），原有 5 个 export 必须都在
    for (const name of [
      'listAutonomousReviewTargets',
      'classifyAutonomousMemoryReview',
      'runNoeMemoryAutonomousReview',
      'renderAutonomousReviewMarkdown',
      'writeAutonomousReviewMarkdown',
    ]) {
      expect(typeof AutonomousReview[name], name).toBe('function');
    }
    expect('json' in AutonomousReview).toBe(false);
  });

  it('NoeProposalInbox 解构别名改写后，输出仍剔除内部字段 reportMtimeMs/raw（omit 行为不变）', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-lint-b2-inbox-'));
    writeJson(join(root, 'output/noe-self-model-proposals/proposal.json'), {
      generatedAtIso: '2026-06-13T00:45:00.000Z',
      decision: 'proposal_generated',
      proposal: {
        schemaVersion: 1,
        proposalId: 'self-model-proposal',
        createdAt: '2026-06-13T00:45:00.000Z',
        status: 'proposed',
        reason: 'shadow audit baseline.',
        evidenceRefs: ['output/noe-self-maintenance-end2end/latest.json'],
        patch: { disposition: 'wording' },
        requiresOwnerConfirmation: false,
      },
    });

    const out = ProposalInbox.listNoeProposalInbox({ root });
    expect(out.ok).toBe(true);
    expect(out.proposals.length).toBeGreaterThan(0);
    // 关键：reportMtimeMs 是内部排序字段，解构丢弃别名(reportMtimeMs:_reportMtimeMs)必须仍把它剔除
    for (const item of out.proposals) {
      expect(Object.prototype.hasOwnProperty.call(item, 'reportMtimeMs')).toBe(false);
      // includeRaw 默认 false → raw 也不应出现
      expect(item.raw).toBeUndefined();
    }
    // includeRaw=true 时 raw 应回归（证明别名未误伤 raw 这个仍在用的解构项）
    const withRaw = ProposalInbox.listNoeProposalInbox({ root, includeRaw: true });
    expect(withRaw.proposals.some((it) => it.raw !== undefined)).toBe(true);
    for (const item of withRaw.proposals) {
      expect(Object.prototype.hasOwnProperty.call(item, 'reportMtimeMs')).toBe(false);
    }
  });
});
