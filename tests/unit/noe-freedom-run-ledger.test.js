import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildNoeFreedomRunLedger,
  listNoeFreedomRunLedgers,
  readNoeFreedomRunLedgerFile,
  resolveNoeFreedomRunLedgerRef,
  validateNoeFreedomRunLedger,
  writeNoeFreedomRunLedgerFile,
} from '../../src/runtime/NoeFreedomRunLedger.js';
import { runNoeFreedomAction } from '../../src/runtime/NoeFreedomExecutor.js';

const baseResult = {
  id: 'freedom-test-run',
  ok: true,
  dryRunOnly: true,
  realExecute: false,
  tool: {
    id: 'noe.freedom.social.publish',
    operation: 'noe.freedom.social.publish',
    capability: 'social.publish',
    riskLevel: 'critical',
  },
  authorization: { mode: 'dry_run', ownerPresent: false },
  trust: null,
  allowlist: null,
  argsPreview: { content: 'hello', apiKey: 'tp-unitsecret000000000000000000000000000000' },
  blockers: [],
  warnings: [],
  runtime: { ok: true, plannedOnly: true, secretValuesReturned: false },
  rollback: { strategy: 'platform_delete_or_correction', plan: '' },
  evidence: { sha256: 'a'.repeat(64), dryRunOnly: true, refs: {} },
};

describe('NoeFreedomRunLedger', () => {
  it('builds a redacted hashable ledger from a freedom result', () => {
    const ledger = buildNoeFreedomRunLedger({ result: baseResult, runId: 'unit-run' });

    expect(ledger.runId).toBe('unit-run');
    expect(ledger.sha256).toHaveLength(64);
    expect(validateNoeFreedomRunLedger(ledger)).toMatchObject({ ok: true, errors: [] });
    expect(JSON.stringify(ledger)).not.toContain('tp-unitsecret');
  });

  it('writes ledger files under the repo output root only', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-run-ledger-'));
    try {
      const written = writeNoeFreedomRunLedgerFile({
        result: baseResult,
        root,
        outDir: 'output/noe-freedom-runs',
        runId: 'unit-run',
      });

      expect(written.ref).toBe('output/noe-freedom-runs/unit-run/ledger.json');
      const text = readFileSync(written.path, 'utf8');
      expect(text).toContain('"runId": "unit-run"');
      expect(text).not.toContain('tp-unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads and verifies ledger refs only from output/noe-freedom-runs', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-run-ledger-'));
    try {
      const written = writeNoeFreedomRunLedgerFile({
        result: baseResult,
        root,
        outDir: 'output/noe-freedom-runs',
        runId: 'readable-run',
      });
      const resolved = resolveNoeFreedomRunLedgerRef(root, written.ref);
      const read = readNoeFreedomRunLedgerFile(written.ref, { root });

      expect(resolved.endsWith('output/noe-freedom-runs/readable-run/ledger.json')).toBe(true);
      expect(read).toMatchObject({
        ok: true,
        ref: 'output/noe-freedom-runs/readable-run/ledger.json',
        ledger: { runId: 'readable-run' },
      });
      expect(() => readNoeFreedomRunLedgerFile('../outside/ledger.json', { root })).toThrow('freedom_run_ledger_ref_path_traversal');
      expect(() => readNoeFreedomRunLedgerFile('/tmp/ledger.json', { root })).toThrow('freedom_run_ledger_ref_must_be_relative');
      expect(() => readNoeFreedomRunLedgerFile('output/noe-freedom-runs/readable-run/not-ledger.json', { root })).toThrow('freedom_run_ledger_ref_must_end_with_ledger_json');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists redacted run ledger summaries and marks resume candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-run-ledger-'));
    try {
      writeNoeFreedomRunLedgerFile({
        result: baseResult,
        root,
        runId: 'plain-run',
      });
      writeNoeFreedomRunLedgerFile({
        result: {
          ...baseResult,
          id: 'source-with-next',
          runtime: {
            ok: true,
            plannedOnly: true,
            secretValuesReturned: false,
            nextFreedomActions: [
              {
                stepId: 'next_shell',
                title: 'Next shell',
                actionId: 'noe.freedom.shell.execute',
                mode: 'developer_unrestricted',
                args: { command: 'printf ok', apiKey: 'tp-unitsecret000000000000000000000000000000' },
              },
            ],
          },
        },
        root,
        runId: 'source-with-next',
      });

      const out = listNoeFreedomRunLedgers({
        root,
        limit: 10,
        onlyWithNextActions: true,
        requireOk: true,
      });

      expect(out).toMatchObject({
        ok: true,
        returned: 1,
        secretValuesReturned: false,
      });
      expect(out.items[0]).toMatchObject({
        ref: 'output/noe-freedom-runs/source-with-next/ledger.json',
        runId: 'source-with-next',
        hasNextFreedomActions: true,
        nextActionCount: 1,
        resumeCandidate: true,
      });
      expect(out.items[0].nextFreedomActions[0]).toEqual({
        stepId: 'next_shell',
        title: 'Next shell',
        actionId: 'noe.freedom.shell.execute',
        mode: 'developer_unrestricted',
      });
      expect(JSON.stringify(out)).not.toContain('tp-unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts browser DOM action values from runtime next actions in persisted ledgers', () => {
    const ledger = buildNoeFreedomRunLedger({
      result: {
        ...baseResult,
        tool: {
          id: 'noe.freedom.account.connection_inventory',
          operation: 'noe.freedom.account.connection_inventory',
          capability: 'account.connection_inventory',
          riskLevel: 'high',
        },
        runtime: {
          ok: true,
          secretValuesReturned: false,
          nextFreedomActions: [
            {
              stepId: 'dom_fill_account',
              actionId: 'noe.freedom.browser.dom.execute',
              mode: 'developer_unrestricted',
              args: {
                browserApp: 'Google Chrome',
                expectedHost: 'example.test',
                actions: [
                  { type: 'set_by_hints', role: 'content', hints: ['正文'], value: 'plain-dom-value' },
                ],
              },
            },
          ],
        },
      },
      runId: 'dom-next-actions-redacted',
    });

    expect(JSON.stringify(ledger)).toContain('"value":"[redacted]"');
    expect(JSON.stringify(ledger)).not.toContain('plain-dom-value');
    expect(validateNoeFreedomRunLedger(ledger)).toMatchObject({ ok: true, errors: [] });
  });

  it('does not mark run history ledgers themselves as resume candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-run-ledger-'));
    try {
      writeNoeFreedomRunLedgerFile({
        result: {
          ...baseResult,
          id: 'history-ledger',
          tool: {
            id: 'noe.freedom.run.history',
            operation: 'noe.freedom.run.history',
            capability: 'workflow.run_history',
            riskLevel: 'high',
          },
          runtime: {
            ok: true,
            secretValuesReturned: false,
            nextFreedomActions: [
              {
                stepId: 'resume_other',
                actionId: 'noe.freedom.run.resume_next_actions',
                mode: 'developer_unrestricted',
                args: { ledgerRef: 'output/noe-freedom-runs/other/ledger.json' },
              },
            ],
          },
        },
        root,
        runId: 'history-ledger',
      });

      const out = listNoeFreedomRunLedgers({ root, limit: 5, requireOk: true });

      expect(out.items[0]).toMatchObject({
        runId: 'history-ledger',
        hasNextFreedomActions: true,
        resumeCandidate: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects absolute or outside-root output directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-run-ledger-'));
    try {
      expect(() => writeNoeFreedomRunLedgerFile({
        result: baseResult,
        root,
        outDir: '/tmp/noe-freedom-outside',
        runId: 'unit-run',
      })).toThrow('freedom_run_ledger_out_dir_must_be_relative');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects symlinked output path components before writing', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-run-ledger-'));
    const outside = mkdtempSync(join(tmpdir(), 'noe-freedom-run-ledger-outside-'));
    try {
      mkdirSync(join(root, 'output'), { recursive: true });
      symlinkSync(outside, join(root, 'output/noe-freedom-runs'));
      expect(() => writeNoeFreedomRunLedgerFile({
        result: baseResult,
        root,
        outDir: 'output/noe-freedom-runs',
        runId: 'unit-run',
      })).toThrow('freedom_run_ledger_symlink_path_denied');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('persists run ledgers from the executor when explicitly requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-run-ledger-'));
    try {
      const out = await runNoeFreedomAction({
        actionId: 'noe.freedom.social.publish',
        args: { url: 'https://example.test/hook', content: 'hello' },
        realExecute: false,
        persistLedger: true,
        runId: 'dry-run-ledger',
        root,
      });

      expect(out.ok).toBe(true);
      expect(out.runLedger).toMatchObject({
        ref: 'output/noe-freedom-runs/dry-run-ledger/ledger.json',
      });
      const text = readFileSync(join(root, out.runLedger.ref), 'utf8');
      expect(text).toContain('"plannedOnly": true');
      const realKeyPattern = new RegExp(['sk' + '-cp-', 'tp-' + 'c[a-z0-9-]{20,}'].join('|'), 'i');
      expect(text).not.toMatch(realKeyPattern);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('allows developer unrestricted real-execute ledgers without trust or allowlist records', () => {
    const ledger = buildNoeFreedomRunLedger({
      result: {
        ...baseResult,
        ok: true,
        dryRunOnly: false,
        realExecute: true,
        authorization: { mode: 'developer_unrestricted', ownerPresent: true },
        trust: null,
        allowlist: null,
        runtime: { ok: true, stdout: 'done', secretValuesReturned: false },
      },
      runId: 'developer-ledger',
    });

    expect(validateNoeFreedomRunLedger(ledger)).toMatchObject({ ok: true, errors: [] });
  });

  it('fails closed if requested ledger persistence targets outside root', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-run-ledger-'));
    try {
      const out = await runNoeFreedomAction({
        actionId: 'noe.freedom.social.publish',
        args: { url: 'https://example.test/hook', content: 'hello' },
        realExecute: false,
        persistLedger: true,
        runLedgerOutDir: '/tmp/noe-freedom-outside',
        runId: 'bad-outdir',
        root,
      });

      expect(out.ok).toBe(false);
      expect(out.blockers.some((item) => item.includes('freedom_run_ledger_write_failed'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
