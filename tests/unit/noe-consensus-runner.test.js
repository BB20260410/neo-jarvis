import { mkdtempSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runNoeConsensusRound } from '../../src/room/NoeConsensusRunner.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'noe-consensus-runner-'));
}

function raw(model, decision = 'approve_with_changes', extra = {}) {
  const authority = model === 'codex' ? 'writer_integrator' : model === 'm3' ? 'suggestion_only' : model === 'claude' ? 'readonly_source_reviewer' : 'advisory';
  return JSON.stringify({
    model,
    decision,
    confidence: 0.88,
    authority,
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    blockers: [],
    recommended_first_slice: ['runner'],
    verification_required: ['test:noe:consensus'],
    consensus_vote: 'yes',
    ...extra,
  }, null, 2);
}

describe('Noe consensus runner', () => {
  it('runs injected online core three-model runners and produces a passing ledger', async () => {
    const root = makeRoot();
    const runners = Object.fromEntries(['codex', 'claude', 'm3'].map((model) => [
      model,
      async () => raw(model),
    ]));
    const result = await runNoeConsensusRound({
      roundId: 'mock-run',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    expect(result.status).toBe('consensus_passed');
    expect(result.validation.consensus.totalModels).toBe(3);
    expect(result.validation.consensus.threshold).toBe(2);
    expect(result.validation.consensus.approvedCount).toBe(3);
    const ledger = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/mock-run/ledger.json'), 'utf8'));
    const evidencePack = readFileSync(join(root, 'output/noe-multimodel/mock-run/evidence-pack.md'), 'utf8');
    const disagreements = readFileSync(join(root, 'output/noe-multimodel/mock-run/disagreements.md'), 'utf8');
    const verifierNotes = readFileSync(join(root, 'output/noe-multimodel/mock-run/verifier-notes.md'), 'utf8');
    const finalHandoff = readFileSync(join(root, 'output/noe-multimodel/mock-run/final-handoff.md'), 'utf8');
    expect(ledger.gate.ok).toBe(true);
    expect(ledger.requiredModels).toEqual(['codex', 'claude', 'm3']);
    expect(ledger.votes.map((vote) => vote.model)).toEqual(['codex', 'claude', 'm3']);
    expect(ledger.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'round_support_files',
        countedInConsensus: false,
        files: expect.objectContaining({
          finalHandoff: 'output/noe-multimodel/mock-run/final-handoff.md',
        }),
      }),
    ]));
    expect(evidencePack).toContain('status: consensus_passed');
    expect(evidencePack).toContain('## Redaction Policy');
    expect(evidencePack).toContain('openai_style_sk_key');
    expect(disagreements).toContain('status: none');
    expect(verifierNotes).toContain('node scripts/noe-consensus-ledger-verify.mjs --ledger output/noe-multimodel/mock-run/ledger.json');
    expect(verifierNotes).toContain('panel_owner_token_header_or_field');
    expect(finalHandoff).toContain('status: consensus_passed');
  });

  it('requires explicit cost acknowledgment before invoking runners', async () => {
    const root = makeRoot();
    const runner = vi.fn(async () => raw('codex'));

    await expect(runNoeConsensusRound({
      roundId: 'missing-cost-ack',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: true,
    }, { root, runners: { codex: runner } })).rejects.toThrow('model_cost_ack_required');
    expect(runner).not.toHaveBeenCalled();
  });

  it('applies dynamic quorum when the Claude runner is unavailable', async () => {
    const root = makeRoot();
    const runners = {
      codex: async () => raw('codex'),
      claude: async () => 'plain unavailable text',
      m3: async () => raw('m3'),
    };
    const result = await runNoeConsensusRound({
      roundId: 'mock-blocked',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    expect(result.status).toBe('consensus_passed');
    expect(result.validation.consensus.availableCount).toBe(2);
    expect(result.validation.consensus.threshold).toBe(2);
    expect(result.validation.consensus.unavailable).toEqual(['claude']);
  });

  it('reasks an unparsed participant once and counts only repaired same-model JSON', async () => {
    const root = makeRoot();
    const claudeCalls = [];
    const runners = {
      codex: async () => raw('codex'),
      claude: async (args) => {
        claudeCalls.push(args);
        return args.jsonRepair ? raw('claude') : 'I will inspect files first, then answer later.';
      },
      m3: async () => raw('m3'),
    };
    const result = await runNoeConsensusRound({
      roundId: 'json-repair-claude',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });
    const manifest = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/json-repair-claude/manifest.json'), 'utf8'));
    const ledger = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/json-repair-claude/ledger.json'), 'utf8'));
    const claudeRaw = readFileSync(join(root, 'output/noe-multimodel/json-repair-claude/claude.txt'), 'utf8');
    const initialRaw = readFileSync(join(root, 'output/noe-multimodel/json-repair-claude/claude.unparsed-attempt-1.txt'), 'utf8');

    expect(result.ok).toBe(true);
    expect(result.parseErrors).toEqual([]);
    expect(claudeCalls).toHaveLength(2);
    expect(claudeCalls[1]).toMatchObject({
      jsonRepair: true,
      invalidRawOutputRef: 'output/noe-multimodel/json-repair-claude/claude.txt',
      qualityProfile: 'exhaustive',
    });
    expect(claudeRaw).toContain('"model": "claude"');
    expect(claudeRaw).not.toContain('I will inspect files first');
    expect(initialRaw).toContain('I will inspect files first');
    expect(manifest.jsonRepairPolicy).toMatchObject({
      enabled: true,
      maxAttemptsPerParticipant: 1,
      countedInConsensus: 'same_model_only_when_parseable_and_identity_clean',
      noArtificialTimeout: true,
    });
    expect(ledger.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'participant_json_repair',
        model: 'claude',
        countedInConsensus: true,
        repaired: true,
        initialRawOutputRef: 'output/noe-multimodel/json-repair-claude/claude.unparsed-attempt-1.txt',
        repairRawOutputRef: 'output/noe-multimodel/json-repair-claude/claude.json-repair-attempt-1.txt',
      }),
    ]));
    expect(ledger.votes.find((vote) => vote.model === 'claude')).toMatchObject({
      parseStatus: 'parsed',
      decision: 'approve_with_changes',
    });
  });

  it('does not count repaired JSON that self-reports as a different model', async () => {
    const root = makeRoot();
    const runners = {
      codex: async () => raw('codex'),
      claude: async (args) => (args.jsonRepair ? raw('codex') : 'I will inspect files first, then answer later.'),
      m3: async () => raw('m3'),
    };
    const result = await runNoeConsensusRound({
      roundId: 'json-repair-identity-mismatch',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });
    const ledger = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/json-repair-identity-mismatch/ledger.json'), 'utf8'));
    const claudeRaw = readFileSync(join(root, 'output/noe-multimodel/json-repair-identity-mismatch/claude.txt'), 'utf8');
    const repairRaw = readFileSync(join(root, 'output/noe-multimodel/json-repair-identity-mismatch/claude.json-repair-attempt-1.txt'), 'utf8');

    expect(result.status).toBe('consensus_passed');
    expect(result.parseErrors).toContain('vote_unparsed:claude');
    expect(result.validation.consensus.unavailable).toEqual(['claude']);
    expect(claudeRaw).toContain('I will inspect files first');
    expect(repairRaw).toContain('"model": "codex"');
    expect(ledger.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'participant_json_repair',
        model: 'claude',
        countedInConsensus: false,
        repaired: false,
      }),
      expect.objectContaining({
        type: 'codex_fallback_review',
        fallbackFor: 'claude',
        countedInConsensus: false,
      }),
    ]));
  });

  it('records thrown participant errors as unavailable raw evidence and still writes a ledger', async () => {
    const root = makeRoot();
    const runners = {
      codex: async () => raw('codex'),
      claude: async () => raw('claude'),
      m3: async () => { throw new TypeError('fetch failed'); },
    };
    const result = await runNoeConsensusRound({
      roundId: 'thrown-m3-unavailable',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    expect(result.status).toBe('consensus_passed');
    expect(result.validation.consensus.availableCount).toBe(2);
    expect(result.validation.consensus.threshold).toBe(2);
    expect(result.validation.consensus.unavailable).toEqual(['m3']);
    const m3Raw = readFileSync(join(root, 'output/noe-multimodel/thrown-m3-unavailable/m3.txt'), 'utf8');
    expect(m3Raw).toContain('"decision": "unavailable"');
    expect(m3Raw).toContain('model_unavailable:fetch failed');
    expect(existsSync(join(root, 'output/noe-multimodel/thrown-m3-unavailable/ledger.json'))).toBe(true);
  });

  it('records Codex fallback evidence for unavailable models without counting it as the missing model vote', async () => {
    const root = makeRoot();
    const codexCalls = [];
    const runners = {
      codex: async (args) => {
        codexCalls.push(args);
        return raw('codex');
      },
      claude: async () => raw('claude'),
      m3: async () => JSON.stringify({
        model: 'm3',
        decision: 'unavailable',
        confidence: 0,
        authority: 'suggestion_only',
        canWrite: false,
        blockers: ['quota_exhausted'],
        consensus_vote: 'abstain',
      }),
    };
    const result = await runNoeConsensusRound({
      roundId: 'fallback-m3',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    expect(result.status).toBe('consensus_passed');
    expect(result.validation.consensus).toMatchObject({
      availableCount: 2,
      threshold: 2,
      approvedCount: 2,
      unavailable: ['m3'],
    });
    expect(codexCalls).toHaveLength(2);
    expect(codexCalls[1]).toMatchObject({
      fallbackFor: 'm3',
      countedInConsensus: false,
      qualityProfile: 'exhaustive',
    });
    expect(codexCalls[1].prompt).toContain('Quality profile: exhaustive.');
    expect(codexCalls[1].prompt).toContain('Token cost is not the limiting factor');
    const manifest = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/fallback-m3/manifest.json'), 'utf8'));
    expect(manifest.fallbacks).toEqual([
      expect.objectContaining({
        type: 'codex_fallback_review',
        model: 'codex',
        fallbackFor: 'm3',
        countedInConsensus: false,
        rawOutputRef: 'output/noe-multimodel/fallback-m3/codex-fallback-for-m3.txt',
      }),
    ]);
    expect(manifest.consensusStatus).toBe('consensus_passed');
    expect(manifest.ledgerRef).toBe('output/noe-multimodel/fallback-m3/ledger.json');
    expect(manifest.gateValidated).toBe(true);
    expect(existsSync(join(root, 'output/noe-multimodel/fallback-m3/codex-fallback-for-m3.txt'))).toBe(true);
    const ledger = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/fallback-m3/ledger.json'), 'utf8'));
    expect(ledger.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'codex_fallback_review', fallbackFor: 'm3', countedInConsensus: false }),
    ]));
    expect(ledger.votes.filter((vote) => vote.model === 'codex')).toHaveLength(1);
  });

  it('marks Codex fallback prompt as non-writer when Claude is the active executor', async () => {
    const root = makeRoot();
    const codexCalls = [];
    const runners = {
      codex: async (args) => {
        codexCalls.push(args);
        return args.fallbackFor
          ? raw('codex', 'approve_with_changes', { authority: 'advisory_supplemental', canWrite: false })
          : raw('codex', 'approve_with_changes', { authority: 'advisory', canWrite: false });
      },
      claude: async () => raw('claude', 'approve_with_changes', { authority: 'active_executor', canWrite: true }),
      m3: async () => JSON.stringify({
        model: 'm3',
        decision: 'unavailable',
        confidence: 0,
        authority: 'suggestion_only',
        canWrite: false,
        blockers: ['quota_exhausted'],
        consensus_vote: 'abstain',
      }),
    };
    const result = await runNoeConsensusRound({
      roundId: 'fallback-m3-claude-executor',
      goal: 'Noe self evolution with Claude executor',
      evidenceText: 'evidence',
      activeExecutor: 'claude',
      executorSelection: { selectedBy: 'user', reason: 'claude_requested' },
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    expect(result.ok).toBe(true);
    expect(codexCalls).toHaveLength(2);
    expect(codexCalls[1].prompt).toContain('"authority": "advisory_supplemental"');
    expect(codexCalls[1].prompt).toContain('"canWrite": false');
  });

  it('can require a final stage matrix artifact before consensus passes', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'output/noe-multimodel/auth'), { recursive: true });
    writeFileSync(join(root, 'output/noe-multimodel/auth/authorization.json'), JSON.stringify({
      schemaVersion: 1,
      roundId: 'auth',
      order: ['A', 'B', 'C', 'D', 'E'],
      stageEvidenceDir: 'output/noe-final-real-machine-stages/auth',
      stageEvidenceRefs: {
        B: 'output/noe-final-real-machine-stages/auth/stage-B.json',
        C: 'output/noe-final-real-machine-stages/auth/stage-C.json',
        D: 'output/noe-final-real-machine-stages/auth/stage-D.json',
        E: 'output/noe-final-real-machine-stages/auth/stage-E.json',
      },
      redactionRules: ['redact'],
      forbidden: ['raw secret read'],
      authorization: {
        B: { authorized: true, scope: 'secret configured only', redactionRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
        C: { authorized: true, scope: 'sealed holdout only', redactionRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
        D: { authorized: true, scope: 'scratch write', redactionRequired: true, rollbackRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
        E: { authorized: true, scope: 'restart last', redactionRequired: true, finalStage: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
      },
    }, null, 2));
    const runners = Object.fromEntries(['codex', 'claude', 'm3'].map((model) => [
      model,
      async () => raw(model),
    ]));
    const result = await runNoeConsensusRound({
      roundId: 'stage-matrix-required',
      goal: 'Noe final matrix gate',
      evidenceText: 'evidence',
      stageMatrixRef: 'output/noe-multimodel/auth/authorization.json',
      stageMatrixRequireComplete: true,
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });
    const manifest = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/stage-matrix-required/manifest.json'), 'utf8'));
    const ledger = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/stage-matrix-required/ledger.json'), 'utf8'));

    expect(result.ok).toBe(false);
    expect(manifest.stageMatrix).toMatchObject({ type: 'final_stage_matrix', ok: false, requireComplete: true });
    expect(manifest.consensusStatus).toBe('consensus_blocked');
    expect(manifest.ledgerRef).toBe('output/noe-multimodel/stage-matrix-required/ledger.json');
    expect(manifest.gateValidated).toBe(false);
    expect(ledger.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'final_stage_matrix', ok: false, requireComplete: true }),
    ]));
    expect(result.validation.errors.some((error) => error.startsWith('stage_matrix_not_ok:'))).toBe(true);
  });

  it('does not allow stage-matrix rounds to downgrade from exhaustive quality', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'output/noe-multimodel/auth'), { recursive: true });
    writeFileSync(join(root, 'output/noe-multimodel/auth/authorization.json'), JSON.stringify({
      schemaVersion: 1,
      roundId: 'auth',
      order: ['A', 'B', 'C', 'D', 'E'],
      stageEvidenceDir: 'output/noe-final-real-machine-stages/auth',
      redactionRules: ['redact'],
      forbidden: ['raw secret read'],
      authorization: {
        B: { authorized: true, scope: 'secret configured only', redactionRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
        C: { authorized: true, scope: 'sealed holdout only', redactionRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
        D: { authorized: true, scope: 'scratch write', redactionRequired: true, rollbackRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
        E: { authorized: true, scope: 'restart last', redactionRequired: true, finalStage: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
      },
    }, null, 2));

    await expect(runNoeConsensusRound({
      roundId: 'stage-matrix-standard',
      goal: 'Noe final matrix gate',
      evidenceText: 'evidence',
      qualityProfile: 'standard',
      stageMatrixRef: 'output/noe-multimodel/auth/authorization.json',
      runModels: false,
    }, { root })).rejects.toThrow('stage_matrix_requires_exhaustive_quality_profile');
  });

  it('blocks forbidden stage evidence refs without reading them', async () => {
    const root = makeRoot();
    mkdirSync(join(root, 'output/noe-multimodel/auth'), { recursive: true });
    writeFileSync(join(root, '.env.local'), 'not json and must not be read');
    writeFileSync(join(root, 'output/noe-multimodel/auth/authorization.json'), JSON.stringify({
      schemaVersion: 1,
      roundId: 'auth',
      order: ['A', 'B', 'C', 'D', 'E'],
      stageEvidenceDir: 'output/noe-final-real-machine-stages/auth',
      stageEvidenceRefs: {
        B: '.env.local',
        C: 'output/noe-final-real-machine-stages/auth/stage-C.json',
        D: 'output/noe-final-real-machine-stages/auth/stage-D.json',
        E: 'output/noe-final-real-machine-stages/auth/stage-E.json',
      },
      redactionRules: ['redact'],
      forbidden: ['raw secret read'],
      authorization: {
        B: { authorized: true, scope: 'secret configured only', redactionRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
        C: { authorized: true, scope: 'sealed holdout only', redactionRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
        D: { authorized: true, scope: 'scratch write', redactionRequired: true, rollbackRequired: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
        E: { authorized: true, scope: 'restart last', redactionRequired: true, finalStage: true, rawSecretReadAllowed: false, rawPrivateHoldoutReadAllowed: false },
      },
    }, null, 2));
    const runners = Object.fromEntries(['codex', 'claude', 'm3'].map((model) => [
      model,
      async () => raw(model),
    ]));
    const result = await runNoeConsensusRound({
      roundId: 'stage-matrix-forbidden-ref',
      goal: 'Noe final matrix gate',
      evidenceText: 'evidence',
      stageMatrixRef: 'output/noe-multimodel/auth/authorization.json',
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    expect(result.ok).toBe(false);
    expect(result.validation.errors.some((error) => error.includes('stage_evidence_ref:B_ref_forbidden'))).toBe(true);
  });

  it('does not let Codex fallback evidence make an insufficient real quorum pass', async () => {
    const root = makeRoot();
    const unavailable = (model) => JSON.stringify({
      model,
      decision: 'unavailable',
      confidence: 0,
      authority: model === 'm3' ? 'suggestion_only' : model === 'claude' ? 'readonly_source_reviewer' : 'advisory',
      canWrite: false,
      firstClass: model === 'claude' ? true : undefined,
      blockers: ['no_quota'],
      consensus_vote: 'abstain',
    });
    const runners = {
      codex: async () => raw('codex'),
      claude: async () => unavailable('claude'),
      m3: async () => unavailable('m3'),
    };
    const result = await runNoeConsensusRound({
      roundId: 'fallback-insufficient-quorum',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    expect(result.status).toBe('consensus_blocked');
    expect(result.validation.consensus.availableCount).toBe(1);
    expect(result.validation.errors).toContain('insufficient_available_models:1');
    const ledger = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/fallback-insufficient-quorum/ledger.json'), 'utf8'));
    expect(ledger.artifacts.filter((item) => item.type === 'codex_fallback_review')).toHaveLength(2);
    expect(ledger.gate.ok).toBe(false);
  });
});
