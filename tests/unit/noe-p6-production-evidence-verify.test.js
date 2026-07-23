import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-p6-production-evidence-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeEvidence(overrides = {}) {
  const file = join(dir, 'p6-production-evidence.json');
  writeFileSync(file, JSON.stringify({
    schemaVersion: 1,
    sampleKind: 'production',
    mode: 'audit',
    port: 51835,
    liveVerified: true,
    dbVerified: true,
    no51735Touched: true,
    secretValuesReturned: false,
    ownerTokenPrinted: false,
    selfTalkOutcomes: 1,
    guardRecords: 1,
    confirmedDelivery: 1,
    synthesizedOnlyDelivery: 0,
    confirmedSelfTalkLandingRate: 1,
    ruminationGuardTripRate: 0,
    evidenceRefs: [
      'http://127.0.0.1:51835/health',
      'sqlite:panel.db/noe_self_talk_audit/1',
      'jsonl:self-talk-audit.jsonl',
    ],
    ...overrides,
  }, null, 2));
  return file;
}

function run(args) {
  return spawnSync(process.execPath, ['scripts/noe-p6-production-evidence-verify.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('noe-p6-production-evidence-verify', () => {
  it('passes valid production evidence', () => {
    const result = run(['--evidence-file', writeEvidence()]);
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(true);
    expect(report.summary).toMatchObject({
      port: 51835,
      confirmedDelivery: 1,
      evidenceRefs: 3,
    });
  });

  it('fails when evidence is missing', () => {
    const result = run([]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      reason: 'evidence_file_required',
    });
  });

  it('fails TTS-only synthetic evidence', () => {
    const result = run(['--evidence-file', writeEvidence({
      sampleKind: 'synthetic',
      confirmedDelivery: 0,
      confirmedSelfTalkLandingRate: 0,
      synthesizedOnlyDelivery: 1,
    })]);
    expect(result.status).toBe(1);
    const report = JSON.parse(result.stdout);
    expect(report.ok).toBe(false);
    expect(report.blockers).toContain('sample_kind_not_production:synthetic');
    expect(report.blockers).toContain('tts_only_delivery_not_owner_perceived');
  });
});
