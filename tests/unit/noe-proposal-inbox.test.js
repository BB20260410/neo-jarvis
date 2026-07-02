import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  decideNoeProposalInboxItem,
  getNoeProposalInboxItem,
  listNoeProposalInbox,
} from '../../src/runtime/NoeProposalInbox.js';

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

describe('NoeProposalInbox', () => {
  it('combines background, skill, and self-model proposal reports into a redacted inbox', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-inbox-'));
    try {
      writeJson(join(root, 'output/noe-background-review/review.json'), {
        kind: 'noe_background_review_report',
        finishedAt: '2026-06-13T01:00:00.000Z',
        context: { projectId: 'noe' },
        proposals: [
          {
            id: 'mem-proposal',
            kind: 'memory',
            tool: 'memory_candidate',
            status: 'proposed',
            createdAt: '2026-06-13T01:00:00.000Z',
            item: {
              title: 'Remember owner preference',
              text: 'MINIMAX_API_KEY=unit-secret-value should not leak',
            },
          },
        ],
      });
      writeJson(join(root, 'output/noe-skill-curator/reports/curator.json'), {
        createdAt: '2026-06-13T00:30:00.000Z',
        pruned: [{ name: 'old-skill', action: 'propose_archive', reason: 'inactive_for_120_days' }],
        consolidated: [{ key: 'debugging', skills: ['debug-a', 'debug-b'], action: 'propose_consolidation' }],
        stateTransitions: [{ name: 'aging', from: 'active', to: 'stale', action: 'propose_review' }],
        items: [{ name: 'stale-skill', action: 'propose_review', daysInactive: 60 }],
      });
      writeJson(join(root, 'output/noe-self-model-proposals/proposal.json'), {
        generatedAtIso: '2026-06-13T00:45:00.000Z',
        decision: 'proposal_generated',
        proposal: {
          schemaVersion: 1,
          proposalId: 'self-model-proposal',
          createdAt: '2026-06-13T00:45:00.000Z',
          status: 'proposed',
          reason: 'P7-D shadow audit derived from self-maintenance baseline signals.',
          evidenceRefs: ['output/noe-self-maintenance-end2end/latest.json'],
          patch: {
            disposition: 'private identity wording should not be exposed in inbox',
          },
          requiresOwnerConfirmation: false,
        },
      });

      const out = listNoeProposalInbox({ root });

      expect(out.ok).toBe(true);
      expect(out.counts.total).toBe(6);
      expect(out.proposals.map((item) => item.type)).toContain('memory_candidate');
      expect(new Set(out.proposals.map((item) => item.type))).toEqual(new Set([
        'memory_candidate',
        'skill_archive_candidate',
        'skill_consolidation_candidate',
        'skill_state_transition_candidate',
        'skill_review_candidate',
        'self_model_diff',
      ]));
      expect(out.proposals.every((item) => item.proposalOnly === true && item.applySupported === false)).toBe(true);
      expect(out.proposals.every((item) => item.raw === undefined)).toBe(true);
      expect(JSON.stringify(out)).not.toContain('unit-secret-value');
      expect(JSON.stringify(out)).not.toContain('private identity wording');
      expect(out.counts.bySource).toMatchObject({ background_review: 1, boot_self_check: 0, skill_curator: 4, self_model: 1 });

      const one = getNoeProposalInboxItem({ root, id: out.proposals[0].id });
      expect(one.ok).toBe(true);
      expect(one.proposal.sourceReportRef).toBe('output/noe-background-review/review.json');
      expect(one.proposal.raw).toBeUndefined();
      const selfModel = listNoeProposalInbox({ root, source: 'self_model', includeRaw: true });
      expect(selfModel.counts.total).toBe(1);
      expect(selfModel.proposals[0]).toMatchObject({
        source: 'self_model',
        type: 'self_model_diff',
        raw: {
          proposalId: 'self-model-proposal',
          patchFields: ['disposition'],
          evidenceRefs: ['output/noe-self-maintenance-end2end/latest.json'],
        },
      });
      expect(JSON.stringify(selfModel)).not.toContain('private identity wording');
      const internal = getNoeProposalInboxItem({ root, id: out.proposals[0].id, includeRaw: true });
      expect(internal.ok).toBe(true);
      expect(internal.proposal.raw).toBeDefined();
      expect(readFileSync(join(root, 'output/noe-background-review/review.json'), 'utf8')).toContain('unit-secret-value');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('turns boot self-check manual repairs into owner-gated proposals without duplicating historical reports', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-inbox-'));
    try {
      const bootReport = {
        at: '2026-06-13T02:00:00.000Z',
        summary: { status: 'degraded' },
        selfRepair: {
          manualFollowups: [
            {
              checkId: 'companion_tools_preflight',
              id: 'prefer_newer_openclaw_candidate',
              label: '切换到较新的开爪候选版本',
              repairable: false,
            },
          ],
        },
        checks: [
          {
            id: 'companion_tools_preflight',
            detail: {
              repairPlan: {
                actions: [
                  {
                    id: 'prefer_newer_openclaw_candidate',
                    tool: 'openclaw',
                    warning: 'active_openclaw_older_than_available_candidate',
                    title: '切换到较新的开爪候选版本',
                    reason: '当前 PATH 命中的开爪版本低于本机已发现候选版本；Noe 只排队，不自动改 shell。',
                    currentPath: '/usr/local/bin/openclaw',
                    currentVersion: '2026.6.1',
                    targetPath: '~/.npm-global/bin/openclaw',
                    targetVersion: '2026.6.6',
                    verification: ['openclaw --version', 'openclaw doctor --fix 需主人确认'],
                  },
                ],
              },
            },
          },
        ],
      };
      writeJson(join(root, 'output/noe-boot-self-check/latest.json'), bootReport);
      writeJson(join(root, 'output/noe-boot-self-check/boot-self-check-older.json'), {
        ...bootReport,
        selfRepair: { manualFollowups: [{ checkId: 'old', id: 'old-action', label: '旧报告不应重复' }] },
      });

      const out = listNoeProposalInbox({ root, source: 'boot_self_check', includeRaw: true });

      expect(out).toMatchObject({
        ok: true,
        counts: { total: 1, returned: 1, bySource: { boot_self_check: 1 } },
      });
      expect(out.proposals[0]).toMatchObject({
        source: 'boot_self_check',
        kind: 'runtime_repair',
        type: 'boot_self_check_manual_repair',
        tool: 'openclaw',
        title: '切换到较新的开爪候选版本',
        proposalOnly: true,
        requiresGatedApply: true,
        raw: {
          actionId: 'prefer_newer_openclaw_candidate',
          currentVersion: '2026.6.1',
          targetVersion: '2026.6.6',
          policy: {
            ownerConfirmationRequired: true,
            noPathMutation: true,
            noPackageInstall: true,
            noProcessRestart: true,
          },
        },
      });
      expect(JSON.stringify(out)).not.toContain('旧报告不应重复');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('filters by source and reports parse errors without throwing', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-inbox-'));
    try {
      mkdirSync(join(root, 'output/noe-background-review'), { recursive: true });
      writeFileSync(join(root, 'output/noe-background-review/bad.json'), '{bad');
      writeJson(join(root, 'output/noe-skill-curator/reports/curator.json'), {
        createdAt: '2026-06-13T00:30:00.000Z',
        pruned: [{ name: 'old-skill', reason: 'inactive_for_120_days' }],
      });

      const skillOnly = listNoeProposalInbox({ root, source: 'skill_curator' });
      expect(skillOnly.counts.total).toBe(1);
      expect(skillOnly.errors).toEqual([]);

      const all = listNoeProposalInbox({ root });
      expect(all.counts.total).toBe(1);
      expect(all.errors).toEqual([{ source: 'background_review', reportRef: 'output/noe-background-review/bad.json', error: 'json_parse_failed' }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('records explicit owner decisions in a ledger and overlays proposal status', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-inbox-'));
    try {
      writeJson(join(root, 'output/noe-background-review/review.json'), {
        finishedAt: '2026-06-13T01:00:00.000Z',
        proposals: [
          {
            id: 'mem-proposal',
            kind: 'memory',
            tool: 'memory_candidate',
            createdAt: '2026-06-13T01:00:00.000Z',
            item: { title: 'Remember owner preference', text: 'draft only' },
          },
        ],
      });
      const before = listNoeProposalInbox({ root });
      const id = before.proposals[0].id;

      const missingConfirm = decideNoeProposalInboxItem({
        root,
        id,
        decision: 'approve_for_gated_apply',
        reason: 'sk-unitsecret000000000000000000000000000000',
      });
      expect(missingConfirm).toMatchObject({ ok: false, error: 'owner_confirmation_required' });

      const decided = decideNoeProposalInboxItem({
        root,
        id,
        decision: 'approve_for_gated_apply',
        reason: 'contains sk-unitsecret000000000000000000000000000000',
        confirmOwner: true,
        now: new Date('2026-06-13T01:02:00.000Z'),
      });
      expect(decided.ok).toBe(true);
      expect(decided.decision).toMatchObject({
        proposalId: id,
        status: 'approved_for_gated_apply',
        effect: 'ledger_only',
        appliesProposalDirectly: false,
      });
      expect(JSON.stringify(decided)).not.toContain('unitsecret');

      const after = listNoeProposalInbox({ root, status: 'approved_for_gated_apply' });
      expect(after.counts.total).toBe(1);
      expect(after.proposals[0]).toMatchObject({
        id,
        sourceStatus: 'proposed',
        status: 'approved_for_gated_apply',
        ownerDecision: { status: 'approved_for_gated_apply' },
      });
      const ledger = readFileSync(join(root, 'output/noe-proposal-decisions/decisions.jsonl'), 'utf8');
      expect(ledger).toContain('"effect":"ledger_only"');
      expect(ledger).not.toContain('unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('binds decision hash to self-model patch content so tampered patches diverge (TOCTOU)', () => {
    const writeSelfModelReport = (root, patch) => {
      writeJson(join(root, 'output/noe-self-model-proposals/self-model.json'), {
        schemaVersion: 1,
        decision: 'proposal_generated',
        generatedAtIso: '2026-06-13T00:45:00.000Z',
        proposal: {
          schemaVersion: 1,
          proposalId: 'self-model-toctou',
          createdAt: '2026-06-13T00:45:00.000Z',
          status: 'proposed',
          reason: 'identity proposal',
          evidenceRefs: ['output/noe-self-maintenance-end2end/latest.json'],
          patch,
          requiresOwnerConfirmation: false,
        },
      });
    };
    const decidedHashFor = (patch) => {
      const root = mkdtempSync(join(tmpdir(), 'noe-proposal-toctou-'));
      try {
        writeSelfModelReport(root, patch);
        const before = listNoeProposalInbox({ root, source: 'self_model' });
        const id = before.proposals[0].id;
        const decided = decideNoeProposalInboxItem({
          root,
          id,
          decision: 'approve_for_gated_apply',
          reason: 'identity approval',
          confirmOwner: true,
          now: new Date('2026-06-13T01:02:00.000Z'),
        });
        expect(decided.ok).toBe(true);
        return { id, proposalHash: decided.decision.proposalHash };
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    };

    // 同 proposalId/source/type/title，但 patch 值不同（仅值变，键相同）。
    const benign = decidedHashFor({ disposition: 'benign owner-approved wording' });
    const tampered = decidedHashFor({ disposition: 'MALICIOUS injected wording after approval' });

    // 当前 bug：两者 id 与 proposalHash 相同 → 审批锁不住具体 patch 值。
    expect(benign.id).toBe(tampered.id);
    expect(benign.proposalHash).not.toBe(tampered.proposalHash);
  });

  it('exposes a redacted patch content fingerprint on self-model proposals without leaking values', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-fp-'));
    try {
      writeJson(join(root, 'output/noe-self-model-proposals/self-model.json'), {
        schemaVersion: 1,
        decision: 'proposal_generated',
        generatedAtIso: '2026-06-13T00:45:00.000Z',
        proposal: {
          schemaVersion: 1,
          proposalId: 'self-model-fp',
          createdAt: '2026-06-13T00:45:00.000Z',
          status: 'proposed',
          reason: 'identity proposal',
          evidenceRefs: ['output/noe-self-maintenance-end2end/latest.json'],
          patch: { disposition: 'private identity wording should stay private' },
          requiresOwnerConfirmation: false,
        },
      });
      const out = listNoeProposalInbox({ root, source: 'self_model' });
      const proposal = out.proposals[0];
      expect(proposal.patchContentHash).toMatch(/^[0-9a-f]{16}$/);
      expect(JSON.stringify(out)).not.toContain('private identity wording');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
