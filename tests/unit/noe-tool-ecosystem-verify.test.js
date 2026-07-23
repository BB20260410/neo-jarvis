import { describe, expect, it } from 'vitest';
import {
  buildToolEcosystemReport,
  normalizeStepResult,
  parseJsonFromOutput,
  redactText,
  runStep,
} from '../../scripts/noe-tool-ecosystem-verify.mjs';

describe('noe tool ecosystem verifier', () => {
  it('redacts token-like values from command output tails', () => {
    const redacted = redactText('Authorization: Bearer abcdefghijklmnopqrstuvwxyz token=1234567890abcdef OPENAI_API_KEY=sk-1234567890abcdef');
    expect(redacted).toContain('Bearer [redacted]');
    expect(redacted).toContain('token=[redacted]');
    expect(redacted).toContain('OPENAI_API_KEY=[redacted]');
    expect(redacted).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(redacted).not.toContain('1234567890abcdef');
  });

  it('parses the last JSON object from mixed command output', () => {
    expect(parseJsonFromOutput('log line\n{"ok":true,"mode":"read_only"}\n')).toEqual({
      ok: true,
      mode: 'read_only',
    });
    expect(parseJsonFromOutput('plain text')).toBeNull();
  });

  it('keeps optional unavailable tools blocked without failing required ecosystem checks', () => {
    const required = normalizeStepResult(
      { id: 'ecosystem_mcp_smoke', title: 'MCP smoke', required: true, command: 'node', args: ['x'] },
      { status: 0, stdout: '{"ok":true}', stderr: '' },
    );
    const optional = normalizeStepResult(
      { id: 'stagehand_local_poc', title: 'Stagehand', required: false, command: 'node', args: ['y'] },
      { status: 2, stdout: '{"ok":false,"error":"model unavailable"}', stderr: '' },
    );
    const report = buildToolEcosystemReport({
      generatedAt: '2026-06-13T00:00:00.000Z',
      repoRoot: '/repo',
      steps: [required, optional],
    });

    expect(report.ok).toBe(true);
    expect(report.summary.failedRequired).toEqual([]);
    expect(report.summary.blockedOptional).toEqual(['stagehand_local_poc']);
    expect(report.nextActions.join('\n')).toMatch(/LM Studio/);
  });

  it('fails the report when a required tool check fails', () => {
    const required = normalizeStepResult(
      { id: 'lancedb_memory_poc', title: 'LanceDB', required: true, command: 'node', args: ['z'] },
      { status: 1, stdout: '{"ok":false,"error":"missing dependency"}', stderr: '' },
    );
    const report = buildToolEcosystemReport({
      generatedAt: '2026-06-13T00:00:00.000Z',
      repoRoot: '/repo',
      steps: [required],
    });

    expect(report.ok).toBe(false);
    expect(report.summary.failedRequired).toEqual(['lancedb_memory_poc']);
  });

  it('marks a hung step as timed out instead of waiting forever', async () => {
    const result = await runStep(
      {
        id: 'hung_codex_mcp_smoke',
        title: 'hung smoke',
        command: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 10_000)'],
        timeoutMs: 50,
      },
      { cwd: process.cwd() },
    );

    expect(result.status).toBe(124);
    expect(result.timedOut).toBe(true);
    expect(result.timeoutMs).toBe(50);

    const normalized = normalizeStepResult(
      { id: 'codex_mcp_smoke', title: 'Codex MCP smoke', required: true, command: 'node', args: ['x'] },
      result,
    );
    expect(normalized.status).toBe('failed');
    expect(normalized.timedOut).toBe(true);
    expect(normalized.stderrTail).toMatch(/step timeout/);
  });
});
