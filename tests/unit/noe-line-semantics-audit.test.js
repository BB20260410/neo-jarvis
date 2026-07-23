import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNoeLineSemanticsAudit, renderMarkdown } from '../../scripts/noe-line-semantics-audit.mjs';

describe('noe-line-semantics-audit', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function fixture() {
    dir = mkdtempSync(join(tmpdir(), 'noe-line-semantics-audit-'));
    mkdirSync(join(dir, 'src', 'cognition'), { recursive: true });
    mkdirSync(join(dir, 'tests', 'unit'), { recursive: true });
    writeFileSync(join(dir, 'src', 'cognition', 'Example.js'), [
      '// top comment',
      'import { readFileSync } from "node:fs";',
      '',
      'const topSecretFixture = "SECRET LINE BODY MUST NOT LEAK";',
      '',
      'export function decide(input) {',
      '  if (input) return 1;',
      '  return 0;',
      '}',
      '',
    ].join('\n'));
    writeFileSync(join(dir, 'tests', 'unit', 'example.test.js'), [
      'import { describe } from "vitest";',
      'describe("x", () => {});',
      '',
    ].join('\n'));
    const atlasPath = join(dir, 'atlas.json');
    writeFileSync(atlasPath, `${JSON.stringify({
      ok: true,
      generatedAt: '2026-06-15T00:00:00.000Z',
      root: dir,
      files: [
        {
          file: 'src/cognition/Example.js',
          module: 'cognition',
          role: 'source_module',
          lines: 9,
          usefulness: 'AGI-critical',
          runtime: { proof: 'module_live_inferred' },
          featureTags: ['prediction_calibration'],
          nextAction: 'keep_covered_and_recheck_after_runtime_changes',
          parse: { ok: true, errors: [] },
          symbolBlocks: [
            { kind: 'function', name: 'decide', startLine: 6, endLine: 9 },
          ],
        },
        {
          file: 'tests/unit/example.test.js',
          module: 'tests',
          role: 'unit_test',
          lines: 2,
          usefulness: 'verification',
          runtime: { proof: 'not_proven_live' },
          featureTags: ['verification_ops'],
          nextAction: 'keep_as_verification_coverage',
          parse: { ok: true, errors: [] },
          symbolBlocks: [],
        },
      ],
    }, null, 2)}\n`);
    return { atlasPath };
  }

  it('classifies every line without exporting source bodies', () => {
    const { atlasPath } = fixture();
    const report = buildNoeLineSemanticsAudit({
      atlasPath,
      root: dir,
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const md = renderMarkdown(report, join(dir, 'line-semantics.md'));
    const raw = JSON.stringify(report);

    expect(report.status).toMatchObject({
      lineClassification: 'all_lines_classified_no_body',
      semanticSignoff: 'not_claimed',
    });
    expect(report.summary).toMatchObject({
      files: 2,
      lines: 11,
      classifiedLines: 11,
      classifiedLineCoveragePct: 100,
      readFailures: 0,
    });
    expect(report.summary.lineKindCounts.import_export).toBe(2);
    expect(report.summary.lineKindCounts.comment).toBe(1);
    expect(report.files.find((file) => file.file === 'src/cognition/Example.js')).toMatchObject({
      codeLikeLines: 6,
      topLevelCodeLines: 2,
      topLevelCodeRanges: [
        { startLine: 2, endLine: 2, lines: 1 },
        { startLine: 4, endLine: 4, lines: 1 },
      ],
    });
    expect(raw).not.toContain('SECRET LINE BODY');
    expect(md).not.toContain('SECRET LINE BODY');
    expect(md).toContain('all_lines_classified_no_body');
  });
});
