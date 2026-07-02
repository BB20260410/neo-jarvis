import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildNoeConsensusLedger,
  readNoeConsensusLedgerFile,
  redactNoeConsensusText,
  sha256Text,
  validateNoeConsensusLedgerArtifact,
  writeNoeConsensusLedgerFile,
} from '../../src/room/NoeConsensusLedger.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'noe-consensus-ledger-'));
}

function vote(model, evidenceRef, rawOutputRef, rawOutputText, extra = {}) {
  const decision = extra.decision || 'approve_with_changes';
  const approval = decision === 'approve' || decision === 'approve_with_changes';
  return {
    model,
    decision,
    authority: model === 'm3' ? 'suggestion_only' : model === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    rawOutputRef,
    rawOutputSha256: sha256Text(rawOutputText),
    evidenceRef,
    consensusVote: approval ? 'yes' : 'abstain',
    recommendedFirstSlice: decision === 'approve_with_changes' ? ['first safe slice'] : [],
    verificationRequired: approval ? ['focused verification'] : [],
    ...extra,
  };
}

function writeFixture(root) {
  const evidenceRef = 'output/noe-multimodel/round/brief.md';
  mkdirSync(join(root, 'output/noe-multimodel/round'), { recursive: true });
  writeFileSync(join(root, evidenceRef), 'same evidence for all models\n');
  const outputs = {};
  for (const model of ['codex', 'claude', 'm3']) {
    outputs[model] = `raw ${model} vote`;
    writeFileSync(join(root, `output/noe-multimodel/round/${model}.txt`), outputs[model]);
  }
  return { evidenceRef, outputs };
}

function writeFiveModelFixture(root) {
  const fixture = writeFixture(root);
  const raw = 'raw xiaomi vote';
  fixture.outputs.xiaomi = raw;
  writeFileSync(join(root, 'output/noe-multimodel/round/xiaomi.txt'), raw);
  return fixture;
}

function buildFixtureLedger(root, overrides = {}) {
  const { evidenceRef, outputs } = writeFixture(root);
  return buildNoeConsensusLedger({
    roundId: 'round-a',
    goal: 'Noe self evolution',
    evidenceRef,
    votes: [
      vote('codex', evidenceRef, 'output/noe-multimodel/round/codex.txt', outputs.codex),
      vote('claude', evidenceRef, 'output/noe-multimodel/round/claude.txt', outputs.claude),
      vote('m3', evidenceRef, 'output/noe-multimodel/round/m3.txt', outputs.m3),
    ],
    implementation: {
      writer: 'codex',
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
    ...overrides,
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
}

describe('Noe consensus ledger', () => {
  it('builds and validates a persisted ledger with evidence and raw output files', () => {
    const root = makeRoot();
    const ledger = buildFixtureLedger(root);
    const file = writeNoeConsensusLedgerFile(ledger, { root, outDir: 'output/noe-multimodel' });
    const saved = readNoeConsensusLedgerFile(file);
    const result = validateNoeConsensusLedgerArtifact(saved, {
      root,
      requireEvidenceFile: true,
      requireRawOutputFiles: true,
    });

    expect(saved.roundId).toBe('round-a');
    expect(result.ok).toBe(true);
    expect(result.consensus.approvedCount).toBe(3);
  });

  it('builds and validates an explicit four-model ledger with Xiaomi MiMo as advisory evidence', () => {
    const root = makeRoot();
    const { evidenceRef, outputs } = writeFiveModelFixture(root);
    const ledger = buildNoeConsensusLedger({
      roundId: 'round-five',
      goal: 'Noe self evolution',
      evidenceRef,
      requiredModels: ['codex', 'claude', 'm3', 'xiaomi'],
      votes: [
        vote('codex', evidenceRef, 'output/noe-multimodel/round/codex.txt', outputs.codex),
        vote('claude', evidenceRef, 'output/noe-multimodel/round/claude.txt', outputs.claude),
        vote('m3', evidenceRef, 'output/noe-multimodel/round/m3.txt', outputs.m3),
        vote('xiaomi', evidenceRef, 'output/noe-multimodel/round/xiaomi.txt', outputs.xiaomi),
      ],
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

    expect(result.ok).toBe(true);
    expect(result.consensus.totalModels).toBe(4);
    expect(result.consensus.threshold).toBe(3);
    expect(result.consensus.approvedCount).toBe(4);
  });

  it('detects raw output hash drift', () => {
    const root = makeRoot();
    const ledger = buildFixtureLedger(root);
    writeFileSync(join(root, 'output/noe-multimodel/round/claude.txt'), 'changed');
    const result = validateNoeConsensusLedgerArtifact(ledger, {
      root,
      requireEvidenceFile: true,
      requireRawOutputFiles: true,
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('raw_output_sha256_mismatch:claude');
  });

  it('rejects raw output references that escape the repo root', () => {
    const root = makeRoot();
    const ledger = buildFixtureLedger(root, {
      votes: [
        {
          model: 'codex',
          decision: 'approve',
          authority: 'writer_integrator',
          canWrite: true,
          rawOutputRef: '../secret.txt',
          evidenceRef: 'output/noe-multimodel/round/brief.md',
          consensusVote: 'yes',
          verificationRequired: ['focused verification'],
        },
        vote('claude', 'output/noe-multimodel/round/brief.md', 'output/noe-multimodel/round/claude.txt', 'raw claude vote'),
        vote('m3', 'output/noe-multimodel/round/brief.md', 'output/noe-multimodel/round/m3.txt', 'raw m3 vote'),
      ],
    });
    const result = validateNoeConsensusLedgerArtifact(ledger, { root, requireRawOutputFiles: true });

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.includes('escapes repo'))).toBe(true);
  });

  it('detects stale stored gate metadata', () => {
    const root = makeRoot();
    const ledger = buildFixtureLedger(root);
    ledger.gate.ok = false;
    const result = validateNoeConsensusLedgerArtifact(ledger, { root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('stored_gate_result_is_stale');
  });

  it('detects artifact drift in stored gate metadata', () => {
    const root = makeRoot();
    const ledger = buildFixtureLedger(root, {
      artifacts: [{ type: 'final_stage_matrix', ok: true, errors: [] }],
    });
    ledger.artifacts[0].ok = false;
    const result = validateNoeConsensusLedgerArtifact(ledger, { root });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('stored_gate_sha256_is_stale');
  });

  it('redacts obvious secrets before storing notes', () => {
    const input = [
      'MINIMAX_API_KEY', '=', 'abc123',
      ' XIAOMI_API_KEY', '=', 'tp-unit-test-redaction-key-00000000000000000000',
      ' standalone ', 'tp-unit-test-redaction-key-11111111111111111111',
      ' Authorization: Bearer ', 'token1234567890',
      ' ', 'sk-', '12345678901234567890123456789012',
      ' ', '?t=', '0123456789abcdef0123456789abcdef',
    ].join('');
    const text = redactNoeConsensusText(input);

    expect(text).toContain(['MINIMAX_API_KEY', '=[redacted]'].join(''));
    expect(text).toContain(['XIAOMI_API_KEY', '=[redacted]'].join(''));
    expect(text).toContain('[redacted-xiaomi-key]');
    expect(text).toContain('Authorization: Bearer [redacted]');
    expect(text).toContain('[redacted-openai-key]');
    expect(text).toContain('?t=[redacted]');
  });

  it('writes ledger files with stable JSON content', () => {
    const root = makeRoot();
    const ledger = buildFixtureLedger(root);
    const file = writeNoeConsensusLedgerFile(ledger, { root });
    const text = readFileSync(file, 'utf8');

    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text).schemaVersion).toBe(1);
  });
});
