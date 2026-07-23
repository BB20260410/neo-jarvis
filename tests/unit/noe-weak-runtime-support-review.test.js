import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildNoeWeakRuntimeSupportReview,
  renderMarkdown,
} from '../../scripts/noe-weak-runtime-support-review.mjs';

describe('noe-weak-runtime-support-review', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeJson(name, value) {
    const path = join(dir, name);
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
    return path;
  }

  function fixturePaths() {
    dir = mkdtempSync(join(tmpdir(), 'noe-weak-runtime-support-review-'));
    const weakFiles = [
      { file: 'src/route/RouteFeature.js', module: 'route', lines: 10, usefulness: 'supporting', strength: 'weak', disposition: 'line_classified_support_needs_review' },
      { file: 'src/servered/ServerFeature.js', module: 'servered', lines: 20, usefulness: 'supporting', strength: 'weak', disposition: 'line_classified_support_needs_review' },
      { file: 'src/lib/LibraryFeature.js', module: 'lib', lines: 30, usefulness: 'supporting', strength: 'weak', disposition: 'line_classified_support_needs_review' },
      { file: 'src/tool/ScriptTool.js', module: 'tool', lines: 40, usefulness: 'supporting', strength: 'weak', disposition: 'line_classified_support_needs_review' },
      { file: 'src/dead/Uncovered.js', module: 'dead', lines: 50, usefulness: 'supporting', strength: 'weak', disposition: 'line_classified_support_needs_review' },
    ];
    return {
      disposition: writeJson('disposition.json', {
        root: dir,
        files: weakFiles,
      }),
      inventory: writeJson('inventory.json', {
        root: dir,
        files: [
          {
            file: 'src/route/RouteFeature.js',
            sourceImporters: ['src/server/routes/routeFeature.js'],
            tests: ['tests/unit/route-feature.test.js'],
            testImporters: [],
          },
          {
            file: 'src/servered/ServerFeature.js',
            sourceImporters: ['server.js'],
            tests: ['tests/unit/server-feature.test.js'],
            testImporters: [],
          },
          {
            file: 'src/lib/LibraryFeature.js',
            sourceImporters: ['src/lib/Parent.js'],
            tests: ['tests/unit/library-feature.test.js'],
            testImporters: ['tests/unit/library-parent.test.js'],
          },
          {
            file: 'src/tool/ScriptTool.js',
            sourceImporters: ['scripts/tool.mjs'],
            tests: ['tests/unit/script-tool.test.js'],
            testImporters: [],
          },
          {
            file: 'src/dead/Uncovered.js',
            sourceImporters: [],
            tests: [],
            testImporters: [],
          },
        ],
      }),
    };
  }

  it('reviews weak files by import topology and test signals without source bodies', () => {
    const report = buildNoeWeakRuntimeSupportReview({
      paths: fixturePaths(),
      now: new Date('2026-06-15T00:00:00.000Z'),
    });
    const byFile = new Map(report.files.map((file) => [file.file, file]));
    const md = renderMarkdown(report, join(dir, 'review.json'));

    expect(byFile.get('src/route/RouteFeature.js')).toMatchObject({
      reviewClass: 'route_imported_runtime_candidate',
      supportDecision: 'runtime_probe_needed',
    });
    expect(byFile.get('src/servered/ServerFeature.js')).toMatchObject({
      reviewClass: 'server_imported_runtime_candidate',
      supportDecision: 'natural_or_managed_runtime_probe_needed',
    });
    expect(byFile.get('src/lib/LibraryFeature.js')).toMatchObject({
      reviewClass: 'library_support_with_unit_coverage',
      supportDecision: 'support_role_confirmed_by_imports_and_tests',
    });
    expect(byFile.get('src/tool/ScriptTool.js')).toMatchObject({
      reviewClass: 'script_or_manual_tool_support_with_tests',
      supportDecision: 'manual_support_not_live_feature',
    });
    expect(byFile.get('src/dead/Uncovered.js')).toMatchObject({
      reviewClass: 'uncovered_support_or_dead_code_candidate',
      supportDecision: 'manual_review_or_probe_needed',
    });
    expect(report.summary).toMatchObject({
      weakFiles: 5,
      runtimeProbeNeeded: 2,
      supportConfirmed: 2,
      manualReviewOrProbeNeeded: 1,
    });
    expect(md).not.toContain('source body');
  });
});
