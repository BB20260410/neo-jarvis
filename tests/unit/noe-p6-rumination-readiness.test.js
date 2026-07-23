import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { verifyP6RuminationReadiness } from '../../src/cognition/P6RuminationReadiness.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-p6-readiness-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeAuditFile() {
  const file = join(dir, 'self-talk-audit.jsonl');
  const rows = [
    {
      channel: 'self_talk_outcome',
      proposalId: 'p6-ready-1',
      redactionPolicy: 'strict',
      commit: { committed: true, committedAt: 1 },
      landing: {
        type: 'awareness',
        delivery: { status: 'played_to_user_confirmed', confirmedAt: 2, confirmationSource: 'telemetry' },
      },
      rawMetrics: { semanticSim: 0.2, groundingScore: 0.8 },
    },
    {
      channel: 'rumination_guard',
      proposalId: 'p6-ready-1',
      redactionPolicy: 'strict',
      state: 'normal',
      action: 'normal',
      rawMetrics: { landingStreak: 0 },
    },
  ];
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

function writeLiveEvidence(overrides = {}) {
  const file = join(dir, 'live-evidence.json');
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    sampleKind: 'production',
    mode: 'audit',
    liveVerified: true,
    dbVerified: true,
    port: 51835,
    no51735Touched: true,
    secretValuesReturned: false,
    ownerTokenPrinted: false,
    selfTalkOutcomes: 1,
    guardRecords: 1,
    confirmedDelivery: 1,
    confirmedSelfTalkLandingRate: 1,
    synthesizedOnlyDelivery: 0,
    ruminationGuardTripRate: 0,
    evidenceRefs: [
      'http://127.0.0.1:51835/health',
      'sqlite:noe_self_talk_audit/row-1',
      'jsonl:self-talk-audit.jsonl',
    ],
    ...overrides,
  }, null, 2));
  return file;
}

describe('P6RuminationReadiness', () => {
  it('passes isolated component readiness while keeping productionReady false without live evidence', () => {
    const report = verifyP6RuminationReadiness({ root: process.cwd() });
    expect(report.ok).toBe(true);
    expect(report.productionReady).toBe(false);
    expect(report.checks.find((check) => check.id === 'live_db_evidence')).toMatchObject({
      status: 'warn',
      reason: 'live_evidence_file_not_provided',
    });
  });

  it('fails when live evidence is required but missing', () => {
    const report = verifyP6RuminationReadiness({
      root: process.cwd(),
      requireLive: true,
    });
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('live_evidence_file_not_provided');
  });

  it('requires audit replay evidence when requested', () => {
    const report = verifyP6RuminationReadiness({
      root: process.cwd(),
      requireAudit: true,
    });
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('audit_file_not_provided');
  });

  it('marks productionReady only when core, audit, and live/db evidence all pass', () => {
    const report = verifyP6RuminationReadiness({
      root: process.cwd(),
      auditFile: writeAuditFile(),
      liveEvidenceFile: writeLiveEvidence(),
      requireAudit: true,
      requireLive: true,
    });
    expect(report.ok).toBe(true);
    expect(report.productionReady).toBe(true);
    expect(report.checks.find((check) => check.id === 'audit_jsonl_replay_evidence')?.summary).toMatchObject({
      selfTalkOutcomes: 1,
      guardRecords: 1,
      llmContextAllowed: false,
    });
  });

  it('rejects live evidence that lacks DB proof', () => {
    const report = verifyP6RuminationReadiness({
      root: process.cwd(),
      auditFile: writeAuditFile(),
      liveEvidenceFile: writeLiveEvidence({ dbVerified: false }),
      requireAudit: true,
      requireLive: true,
    });
    expect(report.ok).toBe(false);
    expect(report.productionReady).toBe(false);
    expect(report.blockers).toContain('live_db_evidence_insufficient');
  });

  it('rejects live evidence that only proves TTS synthesis', () => {
    const report = verifyP6RuminationReadiness({
      root: process.cwd(),
      auditFile: writeAuditFile(),
      liveEvidenceFile: writeLiveEvidence({
        confirmedDelivery: 0,
        confirmedSelfTalkLandingRate: 0,
        synthesizedOnlyDelivery: 1,
      }),
      requireAudit: true,
      requireLive: true,
    });
    expect(report.ok).toBe(false);
    const liveCheck = report.checks.find((check) => check.id === 'live_db_evidence');
    expect(liveCheck?.blockers).toContain('owner_confirmed_delivery_missing');
    expect(liveCheck?.blockers).toContain('tts_only_delivery_not_owner_perceived');
  });

  it('rejects synthetic or controlled evidence as production proof', () => {
    const report = verifyP6RuminationReadiness({
      root: process.cwd(),
      auditFile: writeAuditFile(),
      liveEvidenceFile: writeLiveEvidence({ sampleKind: 'synthetic' }),
      requireAudit: true,
      requireLive: true,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === 'live_db_evidence')?.blockers).toContain('sample_kind_not_production:synthetic');
  });
});
