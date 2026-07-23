import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCodebaseInventory,
  renderInventoryMarkdown,
  writeCodebaseInventory,
} from '../../scripts/noe-codebase-inventory.mjs';

describe('noe-codebase-inventory', () => {
  it('builds a read-only file/function/test/runtime inventory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-codebase-inventory-'));
    try {
      mkdirSync(join(dir, 'src/cognition'), { recursive: true });
      mkdirSync(join(dir, 'src/server/routes'), { recursive: true });
      mkdirSync(join(dir, 'tests/unit'), { recursive: true });
      const fillerImports = Array.from({ length: 90 }, (_, index) => (
        `import "./src/missing/filler-${index}.js";`
      ));
      writeFileSync(join(dir, 'server.js'), [
        ...fillerImports,
        'import { createFooBrain } from "./src/cognition/FooBrain.js";',
        'export const serverReady = createFooBrain();',
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'src/cognition/FooBrain.js'), [
        'export function createFooBrain() {',
        '  return process.env.NOE_MEMORY_EMBED === "1";',
        '}',
        'export class FooBrain {}',
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'src/cognition/FooUse.js'), [
        'import { createFooBrain } from "./FooBrain.js";',
        'export const fooEnabled = createFooBrain();',
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'src/server/routes/noeFoo.js'), [
        'export function register(app) {',
        '  app.get("/api/noe/foo", () => {});',
        '}',
        '',
      ].join('\n'));
      writeFileSync(join(dir, 'tests/unit/foo-brain.test.js'), [
        'import { createFooBrain } from "../../src/cognition/FooBrain.js";',
        'createFooBrain();',
        '',
      ].join('\n'));

      const report = buildCodebaseInventory({
        root: dir,
        scanRoots: ['server.js', 'src', 'tests/unit'],
        generatedAt: '2026-06-15T00:00:00.000Z',
      });
      const foo = report.files.find((item) => item.file === 'src/cognition/FooBrain.js');
      const route = report.files.find((item) => item.file === 'src/server/routes/noeFoo.js');

      expect(report.ok).toBe(true);
      expect(report.policy).toMatchObject({
        readOnly: true,
        noDbReads: true,
        noModelCalls: true,
        noOwnerToken: true,
        noEnvFileReads: true,
      });
      expect(report.totals.sourceFiles).toBe(3);
      expect(foo.symbols).toEqual(expect.arrayContaining(['export:function:createFooBrain', 'export:class:FooBrain']));
      expect(foo.envVars).toEqual(['NOE_MEMORY_EMBED']);
      expect(foo.tests).toContain('tests/unit/foo-brain.test.js');
      expect(foo.testImporters).toContain('tests/unit/foo-brain.test.js');
      expect(foo.sourceImporters).toContain('src/cognition/FooUse.js');
      expect(foo.sourceImporters).toContain('server.js');
      expect(route.routeHints).toEqual(['/api/noe/foo']);
      expect(route.runtimeHints).toContain('http_route');
      expect(report.unreferencedSourceFiles).toEqual(expect.arrayContaining(['src/cognition/FooUse.js', 'src/server/routes/noeFoo.js']));

      const outDir = join(dir, 'out');
      const paths = writeCodebaseInventory(report, { outDir });
      expect(existsSync(paths.jsonPath)).toBe(true);
      expect(existsSync(paths.mdPath)).toBe(true);
      expect(renderInventoryMarkdown(report)).toContain('Neo/Noe 代码与功能清单');
      expect(readFileSync(paths.jsonPath, 'utf8')).toContain('NOE_MEMORY_EMBED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
