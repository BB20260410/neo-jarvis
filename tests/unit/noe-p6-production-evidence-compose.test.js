import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'noe-p6-production-compose-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeJson(name, value) {
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function writeAudit(overrides = {}) {
  const file = join(dir, 'audit.jsonl');
  const rows = [
    {
      channel: 'self_talk_outcome',
      proposalId: 'p6-compose-1',
      redactionPolicy: 'strict',
      commit: { committed: true, committedAt: 1 },
      landing: {
        type: 'awareness',
        delivery: { status: 'played_to_user_confirmed', confirmedAt: 2, confirmationSource: 'telemetry' },
      },
      ...overrides.outcome,
    },
    {
      channel: 'rumination_guard',
      proposalId: 'p6-compose-1',
      redactionPolicy: 'strict',
      state: 'rotate',
      action: 'rotate',
      rawMetrics: { semanticSim: 0.6 },
      ...overrides.guard,
    },
  ];
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  return file;
}

function runtime(overrides = {}) {
  return writeJson('runtime.json', {
    mode: 'audit',
    port: 51835,
    healthOk: true,
    readinessOk: true,
    no51735Touched: true,
    secretValuesReturned: false,
    ownerTokenPrinted: false,
    evidenceRefs: ['http://127.0.0.1:51835/health'],
    ...overrides,
  });
}

function db(overrides = {}) {
  return writeJson('db.json', {
    verified: true,
    selfTalkOutcomes: 1,
    guardRecords: 1,
    confirmedDelivery: 1,
    synthesizedOnlyDelivery: 0,
    evidenceRefs: ['sqlite:panel.db/noe_self_talk_audit/1'],
    ...overrides,
  });
}

function run(args) {
  return spawnSync(process.execPath, ['scripts/noe-p6-production-evidence-compose.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('noe-p6-production-evidence-compose', () => {
  it('writes a validator-ready production evidence file', () => {
    const out = join(dir, 'evidence.json');
    const result = run([
      '--runtime-file', runtime(),
      '--db-file', db(),
      '--audit-file', writeAudit(),
      '--out', out,
    ]);
    expect(result.status).toBe(0);
    expect(existsSync(out)).toBe(true);
    const report = JSON.parse(result.stdout);
    const evidence = JSON.parse(readFileSync(out, 'utf8'));
    expect(report.ok).toBe(true);
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      sampleKind: 'production',
      mode: 'audit',
      liveVerified: true,
      dbVerified: true,
      confirmedDelivery: 1,
    });
    expect(evidence.evidenceRefs.length).toBeGreaterThanOrEqual(3);
  });

  it('fails before composing when required files are missing', () => {
    const result = run(['--db-file', db(), '--audit-file', writeAudit()]);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      reason: 'runtime_file_required',
    });
  });

  it('writes evidence but exits non-zero when the composed sample is not production proof', () => {
    const out = join(dir, 'bad-evidence.json');
    const result = run([
      '--runtime-file', runtime({ port: 51735, no51735Touched: false }),
      '--db-file', db({ confirmedDelivery: 0, synthesizedOnlyDelivery: 1 }),
      '--audit-file', writeAudit({
        outcome: {
          landing: {
            type: 'awareness',
            delivery: { status: 'synthesized' },
          },
        },
      }),
      '--sample-kind', 'controlled',
      '--out', out,
    ]);
    expect(result.status).toBe(1);
    expect(existsSync(out)).toBe(true);
    const report = JSON.parse(result.stdout);
    expect(report.blockers).toContain('sample_kind_not_production:controlled');
    expect(report.blockers).toContain('live_port_not_51835');
    expect(report.blockers).toContain('owner_confirmed_delivery_missing');
  });
});
