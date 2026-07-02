// @ts-check
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NoeSelfModelVersionStore } from '../../src/context/NoeSelfModelVersionStore.js';
import {
  buildSelfModelProposalAudit,
  runSelfModelProposalAudit,
} from '../../src/context/NoeSelfModelProposalAudit.js';

const tempRoots = [];
const T0 = 1_780_000_000_000;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'noe-self-model-proposal-audit-'));
  tempRoots.push(dir);
  return dir;
}

function maintenanceReport() {
  return {
    readiness: { ok: true, blockers: [], warnings: ['failure_modes_present'] },
    failureModeClusters: [{ cluster: 'shell failed', count: 3, examples: [['sk', 'cp', '1234567890abcdef'].join('-')] }],
    crossTopicKnowledgeReuse: { score: 0.05 },
    selfLearningGoalExecCount: 30,
    selfLearningSuccessRate: 0.867,
  };
}

afterEach(() => {
  while (tempRoots.length) {
    const dir = tempRoots.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('NoeSelfModelProposalAudit', () => {
  it('generates a shadow proposal from aggregate maintenance signals without applying it', () => {
    const store = new NoeSelfModelVersionStore({ rootDir: join(tempDir(), 'self-model'), now: () => T0 });
    store.writeNextVersion({
      identity: { name: 'Noe', relationship: 'owner 是我的主人', disposition: '诚实' },
      ownerConfirmed: true,
      proposalId: 'initial',
    });
    const report = buildSelfModelProposalAudit({
      maintenanceReport: maintenanceReport(),
      maintenanceReportRef: '/repo/output/noe-self-maintenance-end2end/latest.json',
      store,
      now: T0 + 1,
      reportId: 'audit-1',
      proposalId: 'proposal-1',
    });

    expect(report.decision).toBe('proposal_generated');
    expect(report.policy).toMatchObject({ shadowOnly: true, applyAttempted: false, llmContextAllowed: false });
    expect(report.apply.attempted).toBe(false);
    expect(report.proposal.status).toBe('proposed');
    expect(report.proposal.requiresOwnerConfirmation).toBe(false);
    expect(report.proposal.patch.disposition).toContain('失败模式复盘');
    expect(store.current().versionId).toBe('v001');
  });

  it('does not copy raw failure examples or secret-like source text into the audit report', () => {
    const secretLike = ['sk', 'cp', '1234567890abcdef'].join('-');
    const report = buildSelfModelProposalAudit({
      maintenanceReport: maintenanceReport(),
      maintenanceReportRef: '/repo/output/noe-self-maintenance-end2end/latest.json',
      store: new NoeSelfModelVersionStore({ rootDir: tempDir(), now: () => T0 }),
      now: T0,
    });
    expect(JSON.stringify(report)).not.toContain(secretLike);
  });

  it('does not generate a duplicate proposal after the disposition patch is already present', () => {
    const store = new NoeSelfModelVersionStore({ rootDir: join(tempDir(), 'self-model'), now: () => T0 });
    store.writeNextVersion({
      identity: {
        name: 'Noe',
        relationship: 'owner 是我的主人',
        disposition: '诚实；更重视失败模式复盘、跨主题知识复用、自学习证据闭环，先用证据化提案而不是直接改身份。',
      },
      ownerConfirmed: true,
      proposalId: 'already-applied',
    });
    const report = buildSelfModelProposalAudit({
      maintenanceReport: maintenanceReport(),
      maintenanceReportRef: '/repo/output/noe-self-maintenance-end2end/latest.json',
      store,
      now: T0 + 1,
    });

    expect(report.decision).toBe('no_proposal');
    expect(report.proposal).toBeNull();
  });

  it('writes latest.json and reports no_proposal when the source report is missing', () => {
    const root = tempDir();
    const source = join(root, 'missing.json');
    const outDir = join(root, 'out');
    const { report, written } = runSelfModelProposalAudit({
      maintenanceReportRef: source,
      outDir,
      store: new NoeSelfModelVersionStore({ rootDir: join(root, 'self-model'), now: () => T0 }),
      now: T0,
    });
    const latest = JSON.parse(readFileSync(written.latest, 'utf8'));

    expect(report.decision).toBe('no_proposal');
    expect(report.signals.blockers).toContain('source_report_missing');
    expect(latest.reportId).toBe(report.reportId);

    const existing = join(root, 'source.json');
    writeFileSync(existing, JSON.stringify(maintenanceReport()));
    const second = runSelfModelProposalAudit({
      maintenanceReportRef: existing,
      outDir,
      store: new NoeSelfModelVersionStore({ rootDir: join(root, 'self-model'), now: () => T0 }),
      now: T0 + 1000,
    });
    const latest2 = JSON.parse(readFileSync(second.written.latest, 'utf8'));
    expect(latest2.decision).toBe('proposal_generated');
  });
});
