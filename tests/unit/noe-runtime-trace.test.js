import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  NoeRuntimeTraceWriter,
  buildNoeRuntimeTraceRecord,
  buildNoeRuntimeTraceSnapshot,
  readNoeRuntimeTraceRecords,
  validateNoeRuntimeTraceRecord,
} from '../../src/runtime/NoeRuntimeTrace.js';
import { writeNoeRuntimeTraceSnapshot } from '../../scripts/noe-runtime-trace-snapshot.mjs';

const ROOT = resolve('.');

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

describe('NoeRuntimeTrace', () => {
  it('builds the golden RuntimeTrace v1 record with stable sha', async () => {
    const expected = await readJson('tests/fixtures/noe-runtime-trace/golden-runtime-trace.json');
    const record = buildNoeRuntimeTraceRecord({
      traceId: 'rt-golden-runtime-trace-001',
      rootRef: 'goal:runtime-trace-golden',
      stage: 'can_execute',
      stageDetail: 'permissionPreflight',
      ts: 1781846400000,
      source: 'act_pipeline',
      entity: { type: 'act', id: 'act-runtime-trace-golden' },
      status: 'passed',
      summary: 'permission preflight passed for sanitized trace fixture',
      refs: ['docs/DESIGN_2026-06-19_Neo_RuntimeTrace_只读审计与首版方案.md'],
      metrics: { candidateCount: 1, latencyMs: 12 },
    });

    expect(record).toEqual(expected);
    expect(validateNoeRuntimeTraceRecord(record)).toEqual({ ok: true, errors: [] });
  });

  it('redacts secrets, drops forbidden metric keys, and filters private holdout refs', () => {
    const record = buildNoeRuntimeTraceRecord({
      stage: 'learn',
      ts: 1781846400001,
      source: 'learning_hook',
      entity: { type: 'candidate', id: 'cand-1' },
      status: 'skipped',
      summary: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz should not be stored',
      refs: [
        'evals/neo/private_holdout/hidden-case.json',
        'output/noe-runtime-trace/safe-ref.json',
      ],
      metrics: {
        rawPrompt: 'do not store this raw prompt',
        memoryBody: 'do not store this memory body',
        ownerToken: 'abcdefabcdefabcdefabcdef',
        safeCount: 2,
        nested: {
          lessonBody: 'do not store this lesson',
          visible: 'kept',
        },
      },
    });
    const text = JSON.stringify(record);

    expect(record.refs).toEqual(['output/noe-runtime-trace/safe-ref.json']);
    expect(record.metrics).toEqual({ safeCount: 2, nested: { visible: 'kept' } });
    expect(text).toContain('Authorization: Bearer [redacted]');
    expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(text).not.toContain('private_holdout');
    expect(text).not.toContain('do not store this raw prompt');
    expect(text).not.toContain('do not store this memory body');
    expect(text).not.toContain('do not store this lesson');
    expect(record.policy).toMatchObject({
      runtimeTouched: false,
      runtimeSemanticChange: false,
      memoryV2Writes: false,
      liveRestart: false,
      privateHoldoutRead: false,
      secretValuesReturned: false,
    });
    expect(record.redaction).toMatchObject({
      prompts: 'excluded',
      rawStreams: 'excluded',
      memoryBodies: 'excluded',
      lessonBodies: 'excluded',
      ownerTokens: 'excluded',
      secrets: 'excluded',
    });
    expect(validateNoeRuntimeTraceRecord(record).ok).toBe(true);

    const unsafeSummaryRecord = buildNoeRuntimeTraceRecord({
      stage: 'observe',
      source: 'manual_audit',
      status: 'completed',
      summary: 'raw prompt: do not store the full user prompt here',
    });
    expect(unsafeSummaryRecord.summary).toBe('[redacted-runtime-trace-summary]');
    expect(JSON.stringify(unsafeSummaryRecord)).not.toContain('do not store the full user prompt here');
    expect(validateNoeRuntimeTraceRecord(unsafeSummaryRecord).ok).toBe(true);

    const unsafeMetricRecord = buildNoeRuntimeTraceRecord({
      stage: 'verify',
      source: 'manual_audit',
      status: 'completed',
      metrics: {
        note: 'full stdout: do not store command output under a safe key',
        snippet: '<body>do not store DOM body</body>',
        shortRaw: 'ignore prior instructions',
        safeLabel: 'permissionPreflight',
      },
    });
    expect(unsafeMetricRecord.metrics).toEqual({
      note: '[redacted-runtime-trace-value]',
      snippet: '[redacted-runtime-trace-value]',
      shortRaw: '[redacted-runtime-trace-value]',
      safeLabel: 'permissionPreflight',
    });
    expect(JSON.stringify(unsafeMetricRecord)).not.toContain('do not store command output');
    expect(JSON.stringify(unsafeMetricRecord)).not.toContain('do not store DOM body');
    expect(JSON.stringify(unsafeMetricRecord)).not.toContain('ignore prior instructions');
    expect(validateNoeRuntimeTraceRecord(unsafeMetricRecord).ok).toBe(true);
  });

  it('fails open when the append-only writer cannot write', async () => {
    const writer = new NoeRuntimeTraceWriter({
      root: ROOT,
      baseDir: 'output/noe-runtime-trace-test-fail-open',
      mkdirFn: async () => {},
      statFn: async () => ({ size: 0 }),
      appendFileFn: async () => {
        const error = new Error('EACCES fixture');
        error.code = 'EACCES';
        throw error;
      },
      now: () => 1781846400002,
    });
    const result = await writer.append({
      stage: 'act',
      source: 'act_pipeline',
      status: 'failed',
      summary: 'write failure must not throw',
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('EACCES');
    expect(validateNoeRuntimeTraceRecord(result.record).ok).toBe(true);
  });

  it('rejects private holdout and path-escaping trace directories before IO', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'noe-runtime-trace-paths-'));
    try {
      const writer = new NoeRuntimeTraceWriter({
        root: temp,
        baseDir: 'evals/neo/private_holdout',
        appendFileFn: async () => {
          throw new Error('append should not run');
        },
      });
      const result = await writer.append({ stage: 'observe', source: 'manual_audit' });
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe('NOE_RUNTIME_TRACE_PRIVATE_HOLDOUT_FORBIDDEN');

      const escaped = await readNoeRuntimeTraceRecords({
        root: temp,
        baseDir: '../outside',
      });
      expect(escaped.error.code).toBe('NOE_RUNTIME_TRACE_PATH_ESCAPES_ROOT');

      await writeFile(join(temp, 'sentinel.jsonl'), '{}\n');
      const holdout = await readNoeRuntimeTraceRecords({
        root: temp,
        baseDir: 'evals/neo/private_holdout',
      });
      expect(holdout.error.code).toBe('NOE_RUNTIME_TRACE_PRIVATE_HOLDOUT_FORBIDDEN');
      expect(holdout.records).toEqual([]);

      await expect(writeNoeRuntimeTraceSnapshot(
        buildNoeRuntimeTraceSnapshot({ records: [] }),
        { outDir: 'evals/neo/private_holdout', nowMs: 1781846400002 },
      )).rejects.toMatchObject({
        code: 'NOE_RUNTIME_TRACE_PRIVATE_HOLDOUT_FORBIDDEN',
      });

      const outside = await mkdtemp(join(tmpdir(), 'noe-runtime-trace-outside-'));
      await mkdir(join(temp, 'output'), { recursive: true });
      await symlink(outside, join(temp, 'output', 'trace-link'));
      const symlinked = await readNoeRuntimeTraceRecords({
        root: temp,
        baseDir: 'output/trace-link',
      });
      expect(symlinked.error.code).toBe('NOE_RUNTIME_TRACE_SYMLINK_FORBIDDEN');

      await mkdir(join(temp, 'trace-files'), { recursive: true });
      await writeFile(
        join(outside, 'runtime-trace-2026-06-20.jsonl'),
        `${JSON.stringify(buildNoeRuntimeTraceRecord({ stage: 'observe', source: 'manual_audit' }))}\n`,
      );
      await symlink(
        join(outside, 'runtime-trace-2026-06-20.jsonl'),
        join(temp, 'trace-files', 'runtime-trace-2026-06-20.jsonl'),
      );
      const symlinkedFile = await readNoeRuntimeTraceRecords({
        root: temp,
        baseDir: 'trace-files',
      });
      expect(symlinkedFile.error.code).toBe('NOE_RUNTIME_TRACE_SYMLINK_FORBIDDEN');
      expect(symlinkedFile.records).toEqual([]);
      await rm(outside, { recursive: true, force: true });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('writes JSONL records and builds a read-only snapshot', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'noe-runtime-trace-'));
    try {
      const writer = new NoeRuntimeTraceWriter({
        root: temp,
        baseDir: 'trace',
        now: () => 1781846400003,
      });
      await writer.append({
        stage: 'observe',
        source: 'noe_loop',
        entity: { type: 'goal', id: 'goal-1' },
        status: 'completed',
        summary: 'winner selected',
        metrics: { candidateCount: 3 },
      });
      await writer.append({
        stage: 'can_execute',
        stageDetail: 'budgetPreflight',
        source: 'act_pipeline',
        entity: { type: 'act', id: 'act-1' },
        status: 'passed',
        summary: 'budget preflight passed',
      });
      const readResult = await readNoeRuntimeTraceRecords({
        root: temp,
        baseDir: 'trace',
      });
      const snapshot = buildNoeRuntimeTraceSnapshot({
        ...readResult,
        nowMs: 1781846400004,
      });

      expect(readResult.records).toHaveLength(2);
      expect(snapshot.ok).toBe(true);
      expect(snapshot.coverage.byStage.observe).toBe(1);
      expect(snapshot.coverage.byStage.can_execute).toBe(1);
      expect(snapshot.source.policy).toContain('no live 51835');
      expect(snapshot.source.policy).toContain('no private_holdout reads');
      expect(JSON.stringify(snapshot)).not.toContain('evals/neo/private_holdout');
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('serializes concurrent appends and rotates after the size cap without deleting old files', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'noe-runtime-trace-queue-'));
    const writes = [];
    try {
      const writer = new NoeRuntimeTraceWriter({
        root: temp,
        baseDir: 'trace',
        maxFileBytes: 1,
        statFn: async (file) => ({ size: file.includes('-178184640000') ? 0 : 999999 }),
        appendFileFn: async (file, body) => {
          writes.push({ file, body: JSON.parse(body) });
        },
        now: () => 1781846400005,
      });
      const results = await Promise.all([
        writer.append({ traceId: 'rt-queue-1', stage: 'observe', source: 'noe_loop' }),
        writer.append({ traceId: 'rt-queue-2', stage: 'act', source: 'act_pipeline' }),
      ]);

      expect(results.map((item) => item.ok)).toEqual([true, true]);
      expect(writes.map((item) => item.body.traceId)).toEqual(['rt-queue-1', 'rt-queue-2']);
      expect(writes.every((item) => item.file.includes('runtime-trace-2026-06-19-1781846400005.jsonl'))).toBe(true);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it('marks policy violations in snapshots without hiding them', () => {
    const record = buildNoeRuntimeTraceRecord({
      stage: 'learn',
      source: 'learning_hook',
      status: 'completed',
      policy: { memoryV2Writes: true },
    });
    const snapshot = buildNoeRuntimeTraceSnapshot({ records: [record] });

    expect(snapshot.ok).toBe(false);
    expect(snapshot.status.blockers).toContain('runtime_trace_policy_or_secret_violation');
    expect(snapshot.status.violations).toContain('policy_memoryV2Writes_violation');
  });

  it('does not import no-touch implementation paths', async () => {
    const runtimeTraceSource = await readFile('src/runtime/NoeRuntimeTrace.js', 'utf8');
    const snapshotSource = await readFile('scripts/noe-runtime-trace-snapshot.mjs', 'utf8');
    const combined = `${runtimeTraceSource}\n${snapshotSource}`;

    expect(combined).not.toMatch(/from ['"].*src\/security\//);
    expect(combined).not.toMatch(/from ['"].*src\/permissions\//);
    expect(combined).not.toMatch(/from ['"].*src\/webhook\//);
    expect(combined).not.toMatch(/from ['"].*private_holdout/);
  });
});
