import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  candidateHasSourceEvidence,
  candidateLooksEphemeral,
  candidateNeedsReview,
  candidateNeedsSourceEvidence,
  candidateToMemoryInput,
  detectsSensitiveText,
  normalizeMemoryCandidate,
} from '../../src/memory/NoeMemoryCandidateSchema.js';
import { formatMemoryContextBlock } from '../../src/memory/NoeMemoryContextFormatter.js';
import {
  createNoeProposalDecisionRecord,
  latestNoeProposalDecisionByProposalId,
  listNoeProposalDecisions,
  recordNoeProposalDecision,
} from '../../src/runtime/NoeProposalDecisionLedger.js';
import { buildFinalPublishRollbackEvidence } from '../../src/runtime/NoeSocialFinalPublishRollback.js';
import { buildMissionFinalization, writeMissionFinalization } from '../../src/runtime/mission/NoeMissionFinalizer.js';
import { NoeMissionReviewGate } from '../../src/runtime/mission/NoeMissionReviewGate.js';
import { loadExecPolicyStore } from '../../src/permissions/ExecPolicyLoader.js';

const OLD_TRUST_LEVEL = process.env.NOE_TRUST_LEVEL;

afterEach(() => {
  if (OLD_TRUST_LEVEL === undefined) delete process.env.NOE_TRUST_LEVEL;
  else process.env.NOE_TRUST_LEVEL = OLD_TRUST_LEVEL;
});

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('Noe memory candidate boundaries', () => {
  it('marks sensitive and incomplete candidates as risky to write without evidence', () => {
    const candidate = normalizeMemoryCandidate({
      id: 'c1',
      kind: 'identity',
      title: 'owner key',
      body: 'owner token sk-unit-test-123456789012345678901234 should never be retained raw',
      finish_reason: 'length',
      salience: 5,
      confidence: 2,
      tags: ['profile'],
    }, { now: 42 });

    expect(candidate.sensitive).toBe(true);
    expect(candidate.incomplete).toBe(true);
    expect(candidate.confidence).toBe(1);
    expect(candidate.salience).toBe(5);
    expect(candidate.body).not.toContain('sk-unit-test-123456789012345678901234');
    expect(candidateNeedsSourceEvidence(candidate)).toBe(true);
    expect(candidateHasSourceEvidence(candidate)).toBe(false);
    expect(candidateNeedsReview(candidate)).toBe(true);
    expect(detectsSensitiveText('api_key=unit-test-secret-123456789')).toBe(true);
  });

  it('keeps sourced durable memories while rejecting ephemeral UI facts', () => {
    const durable = normalizeMemoryCandidate({
      kind: 'skill',
      body: '长期记忆写入前必须保留 evidenceRefs。',
      evidenceRefs: ['output/noe-memory/audit.json'],
      sourceEpisodeId: 'episode-1',
      tags: ['skill'],
      ttlMs: 60_000,
      expiresAt: 9_999_999,
    }, { now: 100 });
    const ephemeral = normalizeMemoryCandidate({
      kind: 'fact',
      body: '刚刚当前页面弹窗显示了一个调试输出。',
    }, { now: 101 });

    expect(candidateHasSourceEvidence(durable)).toBe(true);
    expect(candidateLooksEphemeral(durable)).toBe(false);
    expect(candidateLooksEphemeral(ephemeral)).toBe(true);
    const memoryInput = candidateToMemoryInput(durable);
    expect(memoryInput).toMatchObject({
      sourceEpisodeId: 'episode-1',
      ttlMs: 60_000,
      expiresAt: 9_999_999,
    });
    expect(memoryInput).not.toHaveProperty('evidenceRefs');
    expect(memoryInput.mergeTrace.at(-1)).toMatchObject({
      gate: 'noe_memory_write_gate',
      candidateId: durable.id,
    });
  });
});

describe('Noe memory context formatter', () => {
  it('limits injected memories and redacts sensitive text', () => {
    const block = formatMemoryContextBlock({
      selected: [
        {
          id: 'm1',
          scope: 'project',
          sourceType: 'manual',
          confidence: 0.876,
          body: '项目规则：不要把 sk-unit-test-abcdefghijklmnopqrstuvwxyz 这种 secret 放进 prompt。',
        },
        {
          id: 'm2',
          scope: 'insight',
          body: '第二条不应出现。',
        },
      ],
    }, { maxItems: 1, maxBody: 36, budget: 'tiny' });

    expect(block).toContain('<noe-memory-v2 trust="local" budget="tiny">');
    expect(block).toContain('id="m1"');
    expect(block).toContain('<skill ');
    expect(block).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(block).not.toContain('m2');
  });

  it('returns an empty block when nothing is selected', () => {
    expect(formatMemoryContextBlock({ selected: [] })).toBe('');
    expect(formatMemoryContextBlock(null)).toBe('');
  });
});

describe('Noe proposal decision ledger', () => {
  it('requires explicit owner confirmation and records latest decisions with parse errors isolated', () => {
    const root = tempDir('noe-proposal-ledger-test-');
    try {
      const proposal = {
        id: 'proposal-1',
        source: 'self_review',
        sourceReportRef: 'output/report.json',
        type: 'self_model_patch',
        title: 'Update self model',
        patchContentHash: 'patch-a',
      };

      expect(createNoeProposalDecisionRecord({ proposal, decision: 'defer' })).toMatchObject({
        ok: false,
        error: 'owner_confirmation_required',
      });

      const first = recordNoeProposalDecision({
        root,
        proposal,
        decision: 'defer',
        reason: 'needs more evidence',
        confirmOwner: true,
        now: new Date('2026-06-15T00:00:00.000Z'),
      });
      const second = recordNoeProposalDecision({
        root,
        proposal: { ...proposal, patchContentHash: 'patch-b' },
        decision: 'approve_for_gated_apply',
        reason: 'evidence accepted',
        confirmOwner: true,
        now: new Date('2026-06-15T00:01:00.000Z'),
      });
      expect(first.ok).toBe(true);
      expect(second.decision.status).toBe('approved_for_gated_apply');
      expect(second.decision.patchContentHash).toBe('patch-b');

      const log = join(root, 'output/noe-proposal-decisions/decisions.jsonl');
      writeFileSync(log, `${readFileSync(log, 'utf8')}{bad json}\n`);
      const listed = listNoeProposalDecisions({ root });
      const latest = latestNoeProposalDecisionByProposalId(listed.decisions);

      expect(listed.decisions).toHaveLength(2);
      expect(listed.errors).toEqual([{ ref: 'output/noe-proposal-decisions/decisions.jsonl', line: 3, error: 'json_parse_failed' }]);
      expect(latest.get('proposal-1').status).toBe('approved_for_gated_apply');
      expect(latest.get('proposal-1').proposalHash).not.toBe(first.decision.proposalHash);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Noe social publish rollback evidence', () => {
  it('does not mark rollback evidence verified until publish URL and title are captured', () => {
    const pending = buildFinalPublishRollbackEvidence({ platform: 'xiaohongshu', publishPerformed: true });
    expect(pending.evidenceStatus).toBe('pending_probe');
    expect(pending.missingEvidence).toContain('post_publish_url_missing');
  });

  it('redacts URL secrets and marks complete post-publish probes as verified', () => {
    const rollback = buildFinalPublishRollbackEvidence({
      platform: 'youtube',
      publishPerformed: true,
      postPublishProbe: {
        ok: true,
        url: 'https://example.com/post?token=raw-secret-token-123&ok=1#auth=raw-secret-hash',
        title: 'Launch note',
      },
    });

    expect(rollback.evidenceStatus).toBe('verified');
    expect(rollback.verifiedByNoe).toBe(true);
    expect(rollback.postUrlRef).not.toContain('raw-secret-token-123');
    expect(rollback.postUrlRef).not.toContain('raw-secret-hash');
    expect(rollback.nextFreedomActions.map((item) => item.stepId)).toEqual([
      'post_publish_state_probe',
      'rollback_evidence_gate',
    ]);
  });
});

describe('Noe mission finalizer and review gate', () => {
  it('blocks high-risk actions that exceed mission autonomy or require owner/review gates', () => {
    const gate = new NoeMissionReviewGate();
    const blocked = gate.evaluate({
      mission: {
        autonomyLevel: 'read_only',
        reviewPolicy: { ownerGate: ['publish', 'secret_access'], reviewBrain: ['high_risk'] },
      },
      action: {
        id: 'publish-final',
        type: 'social.publish',
        description: 'publish external post with token rollback evidence',
        autonomyLevel: 'external_write',
      },
    });

    expect(blocked.ok).toBe(false);
    expect(blocked.status).toBe('waiting_approval');
    expect(blocked.reasons).toEqual(expect.arrayContaining([
      'autonomy_exceeded:read_only->external_write',
      'owner_gate_required:publish',
      'owner_gate_required:secret_access',
      'review_brain_required:high_risk',
    ]));

    expect(gate.evaluate({
      mission: { autonomyLevel: 'read_only' },
      action: { id: 'inspect', type: 'read', description: 'inspect local evidence only' },
    }).ok).toBe(true);
  });

  it('builds and writes finalization artifacts without pretending blocked missions completed', () => {
    const written = [];
    const updates = [];
    const events = [];
    const store = {
      writeArtifact(missionId, name, payload) {
        written.push({ missionId, name, payload });
        return { ref: `missions/${missionId}/${name}` };
      },
      updateState(missionId, updater) {
        updates.push({ missionId, state: updater({ missionId, current_slice: 2 }) });
      },
      appendEvent(missionId, event) {
        events.push({ missionId, event });
      },
    };
    const finalization = buildMissionFinalization({
      mission: { missionId: 'm1', objective: 'finish real audit' },
      state: { status: 'running', blockers: ['missing live evidence'], evidenceRefs: ['state.json'], current_slice: 2 },
      events: [{ type: 'mission.slice.done', at: '2026-06-15T00:00:00Z', actionId: 'a1' }],
      criteria: { ok: false, blockers: ['criteria unmet'], evidenceRefs: ['criteria.json'] },
      reconciliation: { ok: false, blockers: ['reconciliation unmet'], warnings: ['weak evidence'] },
      status: 'blocked',
      reason: 'not enough evidence',
      sliceCount: 3,
    });

    expect(finalization.completed).toBe(false);
    expect(finalization.terminal).toBe(true);
    expect(finalization.blockers).toEqual(['missing live evidence', 'criteria unmet', 'reconciliation unmet']);
    expect(finalization.evidenceRefs).toEqual(['state.json', 'criteria.json']);
    expect(finalization.latestEvent).toMatchObject({ type: 'mission.slice.done', actionId: 'a1' });

    const artifact = writeMissionFinalization({
      store,
      missionId: 'm1',
      mission: { missionId: 'm1', objective: 'finish real audit' },
      state: { missionId: 'm1', current_slice: 2 },
      status: 'blocked',
      reason: 'not enough evidence',
    });

    expect(artifact.ref).toBe('missions/m1/finalization-000002.json');
    expect(written[0].payload.completed).toBe(false);
    expect(updates[0].state.finalizationRef).toBe('missions/m1/finalization-000002.json');
    expect(events[0].event.type).toBe('mission.finalization.written');
  });
});

describe('ExecPolicyLoader', () => {
  it('loads default developer trust, file trust, env override, parse fallback, and .noetrust uplift', () => {
    const root = tempDir('noe-exec-policy-loader-test-');
    try {
      const missing = join(root, 'missing-policy.json');
      const defaultLoaded = loadExecPolicyStore({ policyPath: missing });
      expect(defaultLoaded).toMatchObject({ trustLevel: 'developer', source: 'default' });
      expect(defaultLoaded.store.evaluate({ action: 'shell.exec' }).decision).toBe('allow');

      const policyPath = join(root, 'exec-policy.json');
      writeFileSync(policyPath, JSON.stringify({ trustLevel: 'default', caps: { 'fs.delete': 'deny' } }));
      const fileLoaded = loadExecPolicyStore({ policyPath });
      expect(fileLoaded).toMatchObject({ trustLevel: 'default', source: 'file' });
      expect(fileLoaded.store.evaluate({ action: 'file.delete' }).decision).toBe('deny');

      process.env.NOE_TRUST_LEVEL = 'unrestricted';
      const envLoaded = loadExecPolicyStore({ policyPath });
      expect(envLoaded).toMatchObject({ trustLevel: 'unrestricted', source: 'env' });
      expect(envLoaded.store.evaluate({ action: 'network.upload' }).decision).toBe('allow');
      delete process.env.NOE_TRUST_LEVEL;

      writeFileSync(policyPath, '{bad json');
      const parseFallback = loadExecPolicyStore({ policyPath, defaultTrust: 'default' });
      expect(parseFallback).toMatchObject({ trustLevel: 'default', source: 'parse-error-default' });
      expect(parseFallback.store.evaluate({ action: 'shell.exec' }).decision).toBe('defer');

      const trustedProject = join(root, 'trusted');
      mkdirSync(trustedProject);
      writeFileSync(join(trustedProject, '.noetrust'), '');
      const noetrustLoaded = loadExecPolicyStore({ policyPath: missing, defaultTrust: 'default' });
      expect(noetrustLoaded.store.evaluate({ action: 'shell.exec', cwd: trustedProject })).toMatchObject({
        decision: 'allow',
        trustLevel: 'developer',
      });
      expect(existsSync(noetrustLoaded.policyPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
