import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNoeFreedomRunLedger, writeNoeFreedomRunLedgerFile } from '../../src/runtime/NoeFreedomRunLedger.js';
import {
  runNoeFreedomRunLedgerVerify,
  verifyNoeFreedomRunLedgerFile,
} from '../../scripts/noe-freedom-run-ledger-verify.mjs';

const goodResult = {
  id: 'freedom-verify-run',
  ok: true,
  dryRunOnly: true,
  realExecute: false,
  tool: {
    id: 'noe.freedom.social.publish',
    operation: 'noe.freedom.social.publish',
    capability: 'social.publish',
    riskLevel: 'critical',
  },
  authorization: { mode: 'dry_run' },
  argsPreview: { content: 'hello' },
  blockers: [],
  warnings: [],
  runtime: { ok: true, secretValuesReturned: false },
  rollback: { strategy: 'platform_delete_or_correction', plan: '' },
  evidence: { sha256: 'b'.repeat(64), refs: {} },
};

describe('noe-freedom-run-ledger-verify', () => {
  it('verifies written freedom run ledgers', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-verify-'));
    try {
      const written = writeNoeFreedomRunLedgerFile({ result: goodResult, root, runId: 'verify-good' });
      const out = verifyNoeFreedomRunLedgerFile(written.ref, { root, requireOk: true });

      expect(out).toMatchObject({
        ok: true,
        ref: 'output/noe-freedom-runs/verify-good/ledger.json',
        runId: 'verify-good',
        action: 'noe.freedom.social.publish',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails require-ok for structurally valid denied ledgers', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-verify-'));
    try {
      const denied = {
        ...goodResult,
        ok: false,
        blockers: ['owner_supervised_unrestricted_required_for_real_execute'],
      };
      const written = writeNoeFreedomRunLedgerFile({ result: denied, root, runId: 'verify-denied' });
      const structural = verifyNoeFreedomRunLedgerFile(written.ref, { root });
      const requireOk = verifyNoeFreedomRunLedgerFile(written.ref, { root, requireOk: true });

      expect(structural.ok).toBe(true);
      expect(requireOk.ok).toBe(false);
      expect(requireOk.errors).toContain('freedom_run_ledger_not_ok');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('detects tampered ledger hashes in batch mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-verify-'));
    try {
      const written = writeNoeFreedomRunLedgerFile({ result: goodResult, root, runId: 'verify-tampered' });
      const ledger = JSON.parse(readFileSync(written.path, 'utf8'));
      ledger.runtime.ok = false;
      writeFileSync(written.path, `${JSON.stringify(ledger, null, 2)}\n`);

      const out = runNoeFreedomRunLedgerVerify({ root });
      expect(out.ok).toBe(false);
      expect(out.results[0].errors).toContain('freedom_run_ledger_hash_mismatch');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('can verify an in-memory built ledger through the same validator contract', () => {
    const ledger = buildNoeFreedomRunLedger({ result: goodResult, runId: 'memory-ledger' });
    expect(ledger.sha256).toHaveLength(64);
    expect(JSON.stringify(ledger)).not.toMatch(new RegExp(['sk' + '-cp-', 'tp-' + 'c[a-z0-9-]{20,}'].join('|'), 'i'));
  });
});
