import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  buildNoeProposalExecutionPlan,
  executeNoeProposalMaterialization,
} from '../../src/runtime/NoeProposalExecutor.js';
import {
  decideNoeProposalInboxItem,
  executeNoeProposalInboxItem,
  listNoeProposalInbox,
} from '../../src/runtime/NoeProposalInbox.js';

function writeJson(file, data) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function writeMemoryProposal(root) {
  writeJson(join(root, 'output/noe-background-review/review.json'), {
    finishedAt: '2026-06-13T01:00:00.000Z',
    proposals: [
      {
        id: 'memory-proposal',
        kind: 'memory',
        tool: 'memory_candidate',
        createdAt: '2026-06-13T01:00:00.000Z',
        item: {
          text: 'Owner wants tested runtime improvements with sk-unitsecret000000000000000000000000000000 hidden.',
          confidence: 0.78,
        },
      },
    ],
  });
}

function writeSelfModelProposal(root) {
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
        disposition: 'private identity wording should not be queued',
      },
      requiresOwnerConfirmation: false,
    },
  });
}

function writeBootSelfCheckProposal(root) {
  writeJson(join(root, 'output/noe-boot-self-check/latest.json'), {
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
                title: '切换到较新的开爪候选版本',
                reason: '当前 PATH 命中的开爪版本低于本机已发现候选版本；Noe 只排队，不自动改 PATH。',
                currentPath: '/usr/local/bin/openclaw',
                currentVersion: '2026.6.1',
                targetPath: '~/.npm-global/bin/openclaw',
                targetVersion: '2026.6.6',
                verification: ['openclaw --version'],
              },
            ],
          },
        },
      },
    ],
  });
}

describe('NoeProposalExecutor', () => {
  it('blocks materialization unless a proposal has owner approval for gated apply', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-exec-'));
    try {
      writeMemoryProposal(root);
      const proposal = listNoeProposalInbox({ root }).proposals[0];

      expect(buildNoeProposalExecutionPlan({ root, proposal })).toMatchObject({
        ok: false,
        error: 'proposal_not_approved_for_gated_apply',
      });
      expect(executeNoeProposalMaterialization({ root, proposal, dryRun: false, confirmOwner: true })).toMatchObject({
        ok: false,
        error: 'proposal_not_approved_for_gated_apply',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dry-runs approved materialization without writing queue files', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-exec-'));
    try {
      writeMemoryProposal(root);
      const id = listNoeProposalInbox({ root }).proposals[0].id;
      decideNoeProposalInboxItem({ root, id, decision: 'approve_for_gated_apply', confirmOwner: true });

      const out = executeNoeProposalInboxItem({ root, id, dryRun: true });

      expect(out).toMatchObject({
        ok: true,
        dryRun: true,
        execution: {
          status: 'dry_run',
          effect: 'pending_queue_only',
          writesMemoryCore: false,
          writesSkillStore: false,
          changesCode: false,
        },
      });
      expect(existsSync(join(root, 'output/noe-proposal-executions/queues/memory-candidates.jsonl'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('materializes approved proposals into a redacted pending queue and report', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-exec-'));
    try {
      writeMemoryProposal(root);
      const id = listNoeProposalInbox({ root }).proposals[0].id;
      decideNoeProposalInboxItem({ root, id, decision: 'approve_for_gated_apply', confirmOwner: true });

      const first = executeNoeProposalInboxItem({
        root,
        id,
        dryRun: false,
        confirmOwner: true,
        now: new Date('2026-06-13T01:10:00.000Z'),
      });
      const second = executeNoeProposalInboxItem({ root, id, dryRun: false, confirmOwner: true });

      expect(first.ok).toBe(true);
      expect(first.execution).toMatchObject({
        status: 'materialized',
        effect: 'pending_queue_only',
        appliesProposalDirectly: false,
        directWrites: [
          'output/noe-proposal-executions/queues/memory-candidates.jsonl',
          first.execution.reportRef,
        ],
      });
      expect(second.execution.status).toBe('already_materialized');
      const queue = readFileSync(join(root, 'output/noe-proposal-executions/queues/memory-candidates.jsonl'), 'utf8');
      const report = readFileSync(join(root, first.execution.reportRef), 'utf8');
      expect(queue.split(/\r?\n/).filter(Boolean)).toHaveLength(1);
      expect(queue).toContain('"effect":"pending_queue_only"');
      expect(report).toContain('"writesMemoryCore": false');
      expect(`${queue}\n${report}`).not.toContain('unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('materializes self-model proposals into a gated queue without identity body values', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-exec-'));
    try {
      writeSelfModelProposal(root);
      const id = listNoeProposalInbox({ root, source: 'self_model' }).proposals[0].id;
      decideNoeProposalInboxItem({ root, id, decision: 'approve_for_gated_apply', confirmOwner: true });

      const out = executeNoeProposalInboxItem({
        root,
        id,
        dryRun: false,
        confirmOwner: true,
        now: new Date('2026-06-13T01:12:00.000Z'),
      });

      expect(out.ok).toBe(true);
      expect(out.execution).toMatchObject({
        status: 'materialized',
        effect: 'pending_queue_only',
        proposalType: 'self_model_diff',
        appliesProposalDirectly: false,
        directWrites: [
          'output/noe-proposal-executions/queues/self-model-diffs.jsonl',
          out.execution.reportRef,
        ],
      });
      const queue = readFileSync(join(root, 'output/noe-proposal-executions/queues/self-model-diffs.jsonl'), 'utf8');
      const report = readFileSync(join(root, out.execution.reportRef), 'utf8');
      expect(queue).toContain('"proposalType":"self_model_diff"');
      expect(report).toContain('"patchFields"');
      expect(`${queue}\n${report}`).not.toContain('private identity wording');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('materializes boot self-check manual repair proposals into a gated operations queue', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-exec-'));
    try {
      writeBootSelfCheckProposal(root);
      const id = listNoeProposalInbox({ root, source: 'boot_self_check' }).proposals[0].id;
      decideNoeProposalInboxItem({ root, id, decision: 'approve_for_gated_apply', confirmOwner: true });

      const out = executeNoeProposalInboxItem({
        root,
        id,
        dryRun: false,
        confirmOwner: true,
        now: new Date('2026-06-13T02:10:00.000Z'),
      });

      expect(out.ok).toBe(true);
      expect(out.execution).toMatchObject({
        status: 'materialized',
        effect: 'pending_queue_only',
        proposalType: 'boot_self_check_manual_repair',
        appliesProposalDirectly: false,
        changesCode: false,
        directWrites: [
          'output/noe-proposal-executions/queues/boot-self-check-repairs.jsonl',
          out.execution.reportRef,
        ],
      });
      const queue = readFileSync(join(root, 'output/noe-proposal-executions/queues/boot-self-check-repairs.jsonl'), 'utf8');
      const report = readFileSync(join(root, out.execution.reportRef), 'utf8');
      expect(queue).toContain('"proposalType":"boot_self_check_manual_repair"');
      expect(queue).toContain('"effect":"pending_queue_only"');
      expect(report).toContain('"changesCode": false');
      expect(`${queue}\n${report}`).toContain('prefer_newer_openclaw_candidate');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsupported approved proposal types before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-proposal-exec-'));
    try {
      const proposal = {
        id: 'unsupported',
        type: 'external_publish',
        status: 'approved_for_gated_apply',
        ownerDecision: { status: 'approved_for_gated_apply' },
      };
      const out = executeNoeProposalMaterialization({ root, proposal, dryRun: false, confirmOwner: true });

      expect(out).toMatchObject({ ok: false, error: 'unsupported_proposal_type' });
      expect(existsSync(join(root, 'output/noe-proposal-executions'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
