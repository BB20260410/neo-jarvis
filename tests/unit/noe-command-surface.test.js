import { describe, expect, it } from 'vitest';
import {
  buildNoeCommandDryRun,
  buildNoeCommandHelp,
  buildNoeCommandSurface,
  findNoeTools,
  normalizeNoeCommandDescriptor,
} from '../../src/capabilities/NoeCommandSurface.js';

describe('NoeCommandSurface', () => {
  it('builds discoverable safe core commands and readonly tools', () => {
    const surface = buildNoeCommandSurface();

    expect(surface.visibleCommands.map((item) => item.id)).toContain('noe.find_tool');
    expect(surface.visibleCommands.map((item) => item.id)).toContain('noe.memory.recall');
    expect(surface.visibleCommands.map((item) => item.id)).toContain('noe.fs.search');
    expect(surface.visibleCommands.every((item) => item.inputSchema?.type === 'object')).toBe(true);
  });

  it('hides high-risk commands unless permission state allows them', () => {
    const extraCommands = [{
      id: 'noe.file.delete',
      title: '删除文件',
      description: '删除指定文件',
      riskLevel: 'critical',
      capabilityTags: ['delete', 'file'],
    }];
    const hidden = buildNoeCommandSurface({ extraCommands });
    const allowed = buildNoeCommandSurface({ extraCommands, permissionState: { userApproved: true } });

    expect(hidden.visibleCommands.map((item) => item.id)).not.toContain('noe.file.delete');
    expect(hidden.hiddenCommands.map((item) => item.id)).toContain('noe.file.delete');
    expect(allowed.visibleCommands.map((item) => item.id)).toContain('noe.file.delete');
  });

  it('redacts and marks secret-like descriptors instead of exposing values', () => {
    const command = normalizeNoeCommandDescriptor({
      id: 'noe.secret.test',
      title: 'secret',
      description: 'token tp-unitsecret000000000000000000000000000000',
      riskLevel: 'low',
    });

    expect(command.riskLevel).toBe('critical');
    expect(command.permissionRequired).toBe(true);
    expect(command.hiddenReason).toBe('command_descriptor_contains_secret_like_value');
    expect(command.description).not.toContain('tp-unitsecret');
  });

  it('supports find_tool style Chinese and English search', () => {
    const surface = buildNoeCommandSurface();
    const cn = findNoeTools({ query: '文件检索', commands: surface.commands });
    const en = findNoeTools({ query: 'memory', commands: surface.commands });
    const sentence = findNoeTools({ query: '我想检索记忆和文件，先看工具怎么用', commands: surface.commands, limit: 5 });

    expect(cn.results.map((item) => item.id)).toContain('noe.fs.search');
    expect(en.results.map((item) => item.id)).toContain('noe.memory.recall');
    expect(sentence.results.map((item) => item.id)).toEqual(expect.arrayContaining(['noe.fs.search', 'noe.memory.recall']));
  });

  it('returns command help with schema without executing anything', () => {
    const surface = buildNoeCommandSurface();
    const help = buildNoeCommandHelp({ id: 'noe.find_tool', commands: surface.commands });

    expect(help).toMatchObject({
      ok: true,
      commandId: 'noe.find_tool',
      dryRunSupported: true,
      riskLevel: 'low',
    });
    expect(help.inputSchema?.properties?.query).toBeTruthy();
  });

  it('builds redacted dry-run previews and blocks hidden commands', () => {
    const surface = buildNoeCommandSurface({
      extraCommands: [{
        id: 'noe.file.delete',
        title: '删除文件',
        description: '删除指定文件',
        riskLevel: 'critical',
        capabilityTags: ['delete', 'file'],
      }],
    });
    const safe = buildNoeCommandDryRun({
      id: 'noe.find_tool',
      commands: surface.commands,
      input: { query: '文件', apiKey: 'tp-unitsecret000000000000000000000000000000' },
    });
    const blocked = buildNoeCommandDryRun({ id: 'noe.file.delete', commands: surface.commands, includeHidden: true });

    expect(safe).toMatchObject({ ok: true, dryRun: true, wouldExecute: false, commandId: 'noe.find_tool' });
    expect(safe.inputPreview.apiKey).toBe('[redacted]');
    expect(JSON.stringify(safe)).not.toContain('tp-unitsecret');
    expect(blocked).toMatchObject({
      ok: false,
      error: 'permission_required_before_dry_run',
      commandId: 'noe.file.delete',
    });
  });
});
