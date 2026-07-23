import { describe, it, expect } from 'vitest';
import { buildCodexAppPluginBridgeCapabilities, buildCodexAppPluginRequestSchema } from '../../src/room/CodexAppPluginBridge.js';

describe('buildCodexAppPluginBridgeCapabilities', () => {
  it('should return an array of capability strings', () => {
    const result = buildCodexAppPluginBridgeCapabilities();
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it('should include base capability messages', () => {
    const result = buildCodexAppPluginBridgeCapabilities();
    expect(result[0]).toContain('Codex App 插件桥接');
    expect(result[1]).toContain('Codex CLI 运行时真实暴露');
    expect(result[2]).toContain('CODEX_APP_PLUGIN_REQUEST');
  });

  it('should include panel MCP names if provided', () => {
    const panelMcpNames = ['mcp-server-1', 'mcp-server-2'];
    const result = buildCodexAppPluginBridgeCapabilities({ panelMcpNames });

    expect(result).toContain('面板已叠加 MCP: mcp-server-1');
    expect(result).toContain('面板已叠加 MCP: mcp-server-2');
  });

  it('should limit panel MCP names to 8', () => {
    const panelMcpNames = Array.from({ length: 10 }, (_, i) => `mcp-${i}`);
    const result = buildCodexAppPluginBridgeCapabilities({ panelMcpNames });

    const mcpEntries = result.filter(line => line.startsWith('面板已叠加 MCP:'));
    expect(mcpEntries.length).toBe(8);
  });

  it('should handle empty panelMcpNames', () => {
    const result = buildCodexAppPluginBridgeCapabilities({ panelMcpNames: [] });
    const mcpEntries = result.filter(line => line.startsWith('面板已叠加 MCP:'));
    expect(mcpEntries.length).toBe(0);
  });

  it('should handle undefined panelMcpNames', () => {
    const result = buildCodexAppPluginBridgeCapabilities();
    const mcpEntries = result.filter(line => line.startsWith('面板已叠加 MCP:'));
    expect(mcpEntries.length).toBe(0);
  });
});

describe('buildCodexAppPluginRequestSchema', () => {
  it('should return a string containing the schema format', () => {
    const result = buildCodexAppPluginRequestSchema();
    expect(typeof result).toBe('string');
  });

  it('should contain the CODEX_APP_PLUGIN_REQUEST block markers', () => {
    const result = buildCodexAppPluginRequestSchema();
    expect(result).toContain('CODEX_APP_PLUGIN_REQUEST');
    expect(result).toContain('END_CODEX_APP_PLUGIN_REQUEST');
  });

  it('should contain required fields', () => {
    const result = buildCodexAppPluginRequestSchema();
    expect(result).toContain('- plugin:');
    expect(result).toContain('- action:');
    expect(result).toContain('- input:');
    expect(result).toContain('- expected_evidence:');
    expect(result).toContain('- blocker:');
  });

  it('should be a multi-line string', () => {
    const result = buildCodexAppPluginRequestSchema();
    const lines = result.split('\n');
    expect(lines.length).toBeGreaterThan(1);
  });
});
