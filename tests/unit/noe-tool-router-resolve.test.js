import { describe, it, expect } from 'vitest';
import { resolveNoeTool } from '../../src/capabilities/NoeToolRouter.js';

describe('NoeToolRouter.resolveNoeTool', () => {
  it('returns structured error for empty tool name', () => {
    const result = resolveNoeTool('');
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOE_TOOL_INVALID_NAME');
    expect(result.schemaVersion).toBeDefined();
  });

  it('returns structured error for null tool name', () => {
    const result = resolveNoeTool(null);
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOE_TOOL_INVALID_NAME');
  });

  it('returns structured error when tool registry is empty', () => {
    const result = resolveNoeTool('noe.find_tool', { commandSurface: { commands: [] } });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOE_TOOL_REGISTRY_EMPTY');
    expect(result.error.toolName).toBe('noe.find_tool');
  });

  it('returns structured error for unknown tool name', () => {
    const result = resolveNoeTool('noe.does_not_exist_xyz', {
      commandSurface: {
        commands: [
          { id: 'noe.find_tool', title: 'Find Tool' },
          { id: 'noe.recall_memory', title: 'Recall Memory' },
        ],
      },
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('NOE_TOOL_NOT_FOUND');
    expect(result.error.toolName).toBe('noe.does_not_exist_xyz');
    expect(Array.isArray(result.error.availableIds)).toBe(true);
    expect(result.error.availableIds).toContain('noe.find_tool');
  });

  it('resolves a known tool name by id', () => {
    const tool = { id: 'noe.find_tool', title: 'Find Tool' };
    const result = resolveNoeTool('noe.find_tool', {
      commandSurface: { commands: [tool] },
    });
    expect(result.ok).toBe(true);
    expect(result.tool).toEqual(tool);
  });

  it('resolves a known tool by alias', () => {
    const tool = { id: 'noe.find_tool', title: 'Find Tool', aliases: ['search'] };
    const result = resolveNoeTool('search', {
      commandSurface: { commands: [tool] },
    });
    expect(result.ok).toBe(true);
    expect(result.tool).toEqual(tool);
  });
});
