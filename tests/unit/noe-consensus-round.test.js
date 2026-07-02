import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildNoeConsensusLedgerFromRawOutputs,
  buildNoeConsensusVoteFromRaw,
  extractNoeConsensusVoteJson,
} from '../../src/room/NoeConsensusRound.js';
import { validateNoeConsensusLedgerArtifact } from '../../src/room/NoeConsensusLedger.js';
import { assertSafeAssembleCliRef } from '../../scripts/noe-consensus-round-assemble.mjs';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'noe-consensus-round-'));
}

function writeRoundFiles(root, outputs) {
  const dir = join(root, 'output/noe-multimodel/round');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'brief.md'), 'same brief');
  const participants = [];
  for (const [model, raw] of Object.entries(outputs)) {
    const ref = `output/noe-multimodel/round/${model}.txt`;
    writeFileSync(join(root, ref), raw);
    participants.push({ model, rawOutputFile: join(root, ref), rawOutputRef: ref });
  }
  return { evidenceRef: 'output/noe-multimodel/round/brief.md', participants };
}

function raw(model, decision = 'approve_with_changes', extra = {}) {
  const approval = decision === 'approve' || decision === 'approve_with_changes';
  return [
    `${model} review`,
    '```json',
    JSON.stringify({
      model,
      decision,
      confidence: 0.8,
      blockers: [],
      recommended_first_slice: ['ledger'],
      verification_required: approval ? ['run focused consensus verification'] : [],
      consensus_vote: approval ? 'yes' : 'abstain',
      ...extra,
    }, null, 2),
    '```',
  ].join('\n');
}

describe('Noe consensus round assembly', () => {
  it('extracts the last fenced JSON vote from model output', () => {
    const parsed = extractNoeConsensusVoteJson(`notes\n\`\`\`json\n{"model":"claude","decision":"reject"}\n\`\`\``);

    expect(parsed.model).toBe('claude');
    expect(parsed.decision).toBe('reject');
  });

  it('accepts decision aliases from model output JSON', () => {
    const root = makeRoot();
    const { evidenceRef, participants } = writeRoundFiles(root, {
      codex: raw('codex'),
      claude: raw('claude'),
      m3: '```json\n{"model":"m3","voteDecision":"approve"}\n```',
    });
    const { parseErrors } = buildNoeConsensusLedgerFromRawOutputs({
      roundId: 'round-with-alias',
      goal: 'Noe self evolution',
      evidenceRef,
      participants,
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
    }, { createdAt: '2026-06-07T00:00:00.000Z' });

    expect(parseErrors).toEqual([]);
  });

  it('assembles three core raw model outputs into a valid ledger', () => {
    const root = makeRoot();
    const { evidenceRef, participants } = writeRoundFiles(root, {
      codex: raw('codex'),
      claude: raw('claude'),
      m3: raw('m3'),
    });
    const { ledger, parseErrors } = buildNoeConsensusLedgerFromRawOutputs({
      roundId: 'round-from-raw',
      goal: 'Noe self evolution',
      evidenceRef,
      participants,
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
    }, { createdAt: '2026-06-07T00:00:00.000Z' });
    const result = validateNoeConsensusLedgerArtifact(ledger, {
      root,
      requireEvidenceFile: true,
      requireRawOutputFiles: true,
    });

    expect(parseErrors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.consensus.approvedCount).toBe(3);
  });

  it('redacts secret-like raw output before it is parsed into ledger fields', () => {
    const root = makeRoot();
    const fakeSecret = 'sk-assemble-secret-that-must-not-be-stored-1234567890';
    const { evidenceRef, participants } = writeRoundFiles(root, {
      codex: raw('codex', 'approve_with_changes', {
        recommended_first_slice: [`saw ${fakeSecret}`],
      }),
      claude: raw('claude'),
      m3: raw('m3'),
    });
    const { ledger } = buildNoeConsensusLedgerFromRawOutputs({
      roundId: 'round-redacts-raw',
      goal: 'Noe self evolution',
      evidenceRef,
      participants,
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
    }, { createdAt: '2026-06-07T00:00:00.000Z' });

    const serialized = JSON.stringify(ledger);
    expect(serialized).not.toContain(fakeSecret);
    expect(serialized).toContain('[redacted-openai-key]');
  });

  it('rejects unsafe assemble CLI refs before raw output reads', () => {
    const allowed = ['output/noe-multimodel'];

    expect(assertSafeAssembleCliRef('output/noe-multimodel/round/codex.txt', {
      kind: 'raw_output:codex',
      allowedPrefixes: allowed,
    })).toBe('output/noe-multimodel/round/codex.txt');

    for (const ref of [
      '.env',
      '/tmp/codex.txt',
      '../output/noe-multimodel/round/codex.txt',
      'file:output/noe-multimodel/round/codex.txt',
      'output/noe-multimodel/private_holdout/codex.txt',
      'output/noe-multimodel/room-adapters.json',
      'output/noe-multimodel/owner-token/codex.txt',
      'docs/not-a-raw-output.txt',
    ]) {
      expect(() => assertSafeAssembleCliRef(ref, {
        kind: 'raw_output:codex',
        allowedPrefixes: allowed,
      })).toThrow(/raw_output:codex_ref_/);
    }
  });

  it('assembles Xiaomi MiMo raw output into an explicit four-model required ledger', () => {
    const root = makeRoot();
    const { evidenceRef, participants } = writeRoundFiles(root, {
      codex: raw('codex'),
      claude: raw('claude'),
      m3: raw('m3'),
      xiaomi: raw('mimo-v2.5-pro'),
    });
    const { ledger, parseErrors } = buildNoeConsensusLedgerFromRawOutputs({
      roundId: 'round-from-five-models',
      goal: 'Noe self evolution',
      evidenceRef,
      requiredModels: ['codex', 'claude', 'm3', 'xiaomi'],
      participants,
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
    }, { createdAt: '2026-06-07T00:00:00.000Z' });
    const result = validateNoeConsensusLedgerArtifact(ledger, {
      root,
      requireEvidenceFile: true,
      requireRawOutputFiles: true,
    });

    expect(parseErrors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.consensus.totalModels).toBe(4);
    expect(result.consensus.threshold).toBe(3);
    expect(result.consensus.approvedCount).toBe(4);
    expect(ledger.votes.map((vote) => vote.model)).toContain('xiaomi');
  });

  it('turns unparseable raw output into an unavailable vote and applies dynamic quorum', () => {
    const root = makeRoot();
    const { evidenceRef, participants } = writeRoundFiles(root, {
      codex: raw('codex'),
      claude: 'plain text without json',
      m3: raw('m3'),
    });
    const { ledger, parseErrors } = buildNoeConsensusLedgerFromRawOutputs({
      roundId: 'round-with-bad-claude',
      goal: 'Noe self evolution',
      evidenceRef,
      participants,
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
    }, { createdAt: '2026-06-07T00:00:00.000Z' });
    const result = validateNoeConsensusLedgerArtifact(ledger, {
      root,
      requireEvidenceFile: true,
      requireRawOutputFiles: true,
    });

    expect(parseErrors).toContain('vote_unparsed:claude');
    expect(result.ok).toBe(true);
    expect(result.consensus.availableCount).toBe(2);
    expect(result.consensus.threshold).toBe(2);
    expect(result.consensus.unavailable).toEqual(['claude']);
  });

  it('blocks when M3 cannot produce a parsed vote and only one approver remains', () => {
    const root = makeRoot();
    const { evidenceRef, participants } = writeRoundFiles(root, {
      codex: raw('codex'),
      claude: raw('claude'),
      m3: 'plain text without json',
    });
    const { ledger, parseErrors } = buildNoeConsensusLedgerFromRawOutputs({
      roundId: 'round-with-bad-m3',
      goal: 'Noe self evolution',
      evidenceRef,
      participants,
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
    }, { createdAt: '2026-06-07T00:00:00.000Z' });
    const result = validateNoeConsensusLedgerArtifact(ledger, {
      root,
      requireEvidenceFile: true,
      requireRawOutputFiles: true,
    });

    expect(parseErrors).toContain('vote_unparsed:m3');
    expect(result.ok).toBe(true);
    expect(result.consensus.availableCount).toBe(2);
    expect(result.consensus.threshold).toBe(2);
    expect(result.consensus.unavailable).toEqual(['m3']);
  });

  it('blocks raw M3 outputs that include execution artifacts', () => {
    const root = makeRoot();
    const { evidenceRef, participants } = writeRoundFiles(root, {
      codex: raw('codex'),
      claude: raw('claude'),
      m3: raw('m3', 'approve', {
        commands: ['npm test'],
        diffs: [{ file: 'src/room/example.js' }],
      }),
    });
    const { ledger, parseErrors } = buildNoeConsensusLedgerFromRawOutputs({
      roundId: 'round-with-m3-overreach',
      goal: 'Noe self evolution',
      evidenceRef,
      participants,
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
    }, { createdAt: '2026-06-07T00:00:00.000Z' });
    const result = validateNoeConsensusLedgerArtifact(ledger, {
      root,
      requireEvidenceFile: true,
      requireRawOutputFiles: true,
    });

    expect(parseErrors).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('m3_content_violation:diffs');
    expect(result.errors).toContain('m3_content_violation:commands');
  });

  it('pins vote identity to the trusted slot, ignoring a spoofed parsed.model', () => {
    // m3 自报 model:"codex" 想冒领 writer 权限/逃避 m3 内容违规检查。
    const vote = buildNoeConsensusVoteFromRaw({
      model: 'm3',
      rawOutput: '```json\n{"model":"codex","decision":"approve","canWrite":true}\n```',
      rawOutputRef: 'output/noe-multimodel/round/m3.txt',
      evidenceRef: 'output/noe-multimodel/round/brief.md',
    });

    expect(vote.model).toBe('m3');
    // 可信槽决定身份 → m3 不能凭自报内容默认拿到 writer。
    expect(vote.canWrite).toBe(false);
    expect(vote.identityViolations).toContain('model_identity_mismatch:claimed=codex:trusted=m3');
  });

  it('does not let a participant self-report as claude to gain first-class status', () => {
    const vote = buildNoeConsensusVoteFromRaw({
      model: 'm3',
      rawOutput: '```json\n{"model":"claude","decision":"approve","firstClass":true,"commands":["npm test"]}\n```',
      rawOutputRef: 'output/noe-multimodel/round/m3.txt',
      evidenceRef: 'output/noe-multimodel/round/brief.md',
    });

    expect(vote.model).toBe('m3');
    expect(vote.identityViolations).toContain('model_identity_mismatch:claimed=claude:trusted=m3');
    // 仍按 m3 判定内容违规（commands 是 m3 禁字段），未被冒领的 claude 身份掩盖。
    expect(vote.contentViolations).toContain('commands');
  });

  it('keeps a matching parsed.model and records no identity violation', () => {
    const vote = buildNoeConsensusVoteFromRaw({
      model: 'codex',
      rawOutput: '```json\n{"model":"codex","decision":"approve","canWrite":true}\n```',
      rawOutputRef: 'output/noe-multimodel/round/codex.txt',
      evidenceRef: 'output/noe-multimodel/round/brief.md',
    });

    expect(vote.model).toBe('codex');
    expect(vote.canWrite).toBe(true);
    expect(vote.identityViolations).toEqual([]);
  });

  it('records verification requirements and parse strategy in votes', () => {
    const vote = buildNoeConsensusVoteFromRaw({
      model: 'claude',
      rawOutput: raw('claude', 'approve', { verification_required: ['run live smoke'] }),
      rawOutputRef: 'output/noe-multimodel/round/claude.txt',
      evidenceRef: 'output/noe-multimodel/round/brief.md',
    });

    expect(vote.verificationRequired).toEqual(['run live smoke']);
    expect(vote.parseStatus).toBe('parsed');
    expect(vote.parseStrategy).toBe('fenced_json');
  });

  it('serializes object array items into readable ledger strings', () => {
    const vote = buildNoeConsensusVoteFromRaw({
      model: 'm3',
      rawOutput: raw('m3', 'approve', {
        blockers: [{ priority: 'P2', item: 'wording follow-up' }],
        recommended_first_slice: [{ priority: 'P2', item: 'tighten caveat' }],
        verification_required: [{ command: 'rg raw-read guard', expected: 'no matches' }],
      }),
      rawOutputRef: 'output/noe-multimodel/round/m3.txt',
      evidenceRef: 'output/noe-multimodel/round/brief.md',
    });

    expect(vote.blockers).toEqual(['{"priority":"P2","item":"wording follow-up"}']);
    expect(vote.recommendedFirstSlice).toEqual(['{"priority":"P2","item":"tighten caveat"}']);
    expect(vote.verificationRequired).toEqual(['{"command":"rg raw-read guard","expected":"no matches"}']);
    expect(JSON.stringify(vote)).not.toContain('[object Object]');
  });

  it('serializes object unavailable reasons into readable ledger strings', () => {
    const vote = buildNoeConsensusVoteFromRaw({
      model: 'claude',
      rawOutput: raw('claude', 'unavailable', {
        blockers: [{ category: 'tool_failure', item: 'model unavailable' }],
        consensus_vote: 'abstain',
      }),
      rawOutputRef: 'output/noe-multimodel/round/claude.txt',
      evidenceRef: 'output/noe-multimodel/round/brief.md',
    });

    expect(vote.unavailableReason).toBe('{"category":"tool_failure","item":"model unavailable"}');
    expect(JSON.stringify(vote)).not.toContain('[object Object]');
  });

  it('falls back to the trusted slot when parsed.model is absent, with no violation', () => {
    const vote = buildNoeConsensusVoteFromRaw({
      model: 'gemini',
      rawOutput: '```json\n{"decision":"approve"}\n```',
      rawOutputRef: 'output/noe-multimodel/round/gemini.txt',
      evidenceRef: 'output/noe-multimodel/round/brief.md',
    });

    expect(vote.model).toBe('gemini');
    expect(vote.identityViolations).toEqual([]);
  });

  it('blocks a ledger where a model spoofs another model identity in its raw output', () => {
    const root = makeRoot();
    const { evidenceRef, participants } = writeRoundFiles(root, {
      codex: raw('codex'),
      claude: raw('claude'),
      // m3 槽里的内容自报成 codex，企图冒领 writer。
      m3: '```json\n{"model":"codex","decision":"approve","canWrite":true,"consensus_vote":"yes"}\n```',
    });
    const { ledger, parseErrors } = buildNoeConsensusLedgerFromRawOutputs({
      roundId: 'round-with-spoofed-identity',
      goal: 'Noe self evolution',
      evidenceRef,
      participants,
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
    }, { createdAt: '2026-06-07T00:00:00.000Z' });
    const result = validateNoeConsensusLedgerArtifact(ledger, {
      root,
      requireEvidenceFile: true,
      requireRawOutputFiles: true,
    });

    expect(parseErrors).toEqual([]);
    // 身份钉死在可信槽 → 票仍归 m3，冒领的 writer 声明被中和（canWrite=false）。
    expect(ledger.votes.map((vote) => vote.model).sort()).toEqual(['claude', 'codex', 'm3']);
    const m3Vote = ledger.votes.find((vote) => vote.model === 'm3');
    expect(m3Vote.canWrite).toBe(false);
    expect(m3Vote.identityViolations).toContain('model_identity_mismatch:claimed=codex:trusted=m3');
    expect(result.errors).toContain('identity_violation:m3:model_identity_mismatch:claimed=codex:trusted=m3');
    // 冒领被中和后 m3 不再持 writer，ledger 不应再报 m3_must_not_write。
    expect(result.errors).not.toContain('m3_must_not_write');
    // 真正的 codex 槽仍是唯一 writer。
    const codexVote = ledger.votes.find((vote) => vote.model === 'codex');
    expect(codexVote.canWrite).toBe(true);
  });

  it('blocks approve JSON when consensus_vote explicitly says no', () => {
    const root = makeRoot();
    const { evidenceRef, participants } = writeRoundFiles(root, {
      codex: raw('codex'),
      claude: raw('claude', 'approve', { consensus_vote: 'no' }),
      m3: raw('m3'),
    });
    const { ledger, parseErrors } = buildNoeConsensusLedgerFromRawOutputs({
      roundId: 'round-with-conflicting-vote',
      goal: 'Noe self evolution',
      evidenceRef,
      participants,
      implementation: {
        writer: 'codex',
        authorizationRequired: true,
        runtimeVerificationRequired: true,
        rollbackRequired: true,
        memoryWritebackAckRequired: true,
      },
    }, { createdAt: '2026-06-07T00:00:00.000Z' });
    const result = validateNoeConsensusLedgerArtifact(ledger, {
      root,
      requireEvidenceFile: true,
      requireRawOutputFiles: true,
    });

    expect(parseErrors).toEqual([]);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('consensus_vote_conflict:claude');
  });
});
