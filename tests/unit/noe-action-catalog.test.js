import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { createNoeActionCatalog } from '../../src/actions/NoeActionCatalog.js';

const execFileP = promisify(execFile);

describe('NoeActionCatalog', () => {
  it('lists discoverable preview actions without execute authority', () => {
    const actions = createNoeActionCatalog().list();
    expect(actions.map((action) => action.id)).toEqual([
      'files.organize.preview',
      'hwfit.recommend.preview',
      'research.deep.plan',
      'research.search.preview',
      'skills.extract.preview',
    ]);
    expect(actions.every((action) => action.supportsDryRun)).toBe(true);
    expect(actions.every((action) => !action.supportsExecute)).toBe(true);
  });

  it('returns stable schema/help for an action', () => {
    const catalog = createNoeActionCatalog();
    const schema = catalog.schema('research.search.preview');
    expect(schema.inputSchema.required).toContain('query');
    expect(schema.modules).toContain('src/research/WebSearch.js');
    expect(catalog.help('research.search.preview')).toContain('dry-run: yes');
  });

  it('dry-runs without side effects and normalizes inputs', () => {
    const preview = createNoeActionCatalog().dryRun('research.search.preview', {
      query: '  Wukong AI   ',
      count: 3,
    });
    expect(preview).toMatchObject({
      ok: true,
      dryRun: true,
      actionId: 'research.search.preview',
      normalizedInput: { query: 'Wukong AI', count: 3 },
      sideEffects: [],
    });
    expect(preview.blockedEffects).toContain('touch_ports_51735_51835');
  });

  it('rejects unknown actions and invalid input', () => {
    const catalog = createNoeActionCatalog();
    expect(() => catalog.schema('missing.action')).toThrow(/unknown Noe action/);
    expect(() => catalog.dryRun('research.search.preview', {})).toThrow(/query is required/);
  });

  it('refuses preview paths under games/cartoon-apocalypse', () => {
    const catalog = createNoeActionCatalog();
    expect(() => catalog.dryRun('files.organize.preview', {
      root: '~/Desktop/Neo 贾维斯/games/cartoon-apocalypse',
    })).toThrow(/cartoon-apocalypse/);
  });

  it('CLI emits JSON schema and dry-run output', async () => {
    const schema = await execFileP(process.execPath, ['scripts/noe-action-catalog.mjs', 'schema', 'research.search.preview']);
    expect(JSON.parse(schema.stdout)).toMatchObject({ ok: true, schema: { id: 'research.search.preview' } });

    const dry = await execFileP(process.execPath, [
      'scripts/noe-action-catalog.mjs',
      'dry-run',
      'skills.extract.preview',
      '--input',
      '{"source":"部署流程：先测试，再配置，再验证"}',
    ]);
    expect(JSON.parse(dry.stdout)).toMatchObject({
      ok: true,
      actionId: 'skills.extract.preview',
      dryRun: true,
      sideEffects: [],
    });
  });
});
