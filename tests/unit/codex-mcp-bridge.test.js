import { describe, it, expect } from 'vitest';
import { buildPanelMcpToml, isCodexMcpStartupFailure } from '../../src/room/CodexSpawnAdapter.js';

describe('CodexSpawnAdapter MCP 桥(buildPanelMcpToml)', () => {
  it('生成基本 toml 段:command + args(无 env)', () => {
    const toml = buildPanelMcpToml([
      { name: 'echo-server', type: 'stdio', enabled: true, command: '/usr/bin/echo', args: ['hello', 'world'] },
    ]);
    expect(toml).toContain('[mcp_servers.panel_echo-server]');
    expect(toml).toContain('command = "/usr/bin/echo"');
    expect(toml).toContain('args = ["hello", "world"]');
    expect(toml).not.toContain('env'); // 无 env 段
  });

  it('生成完整 toml:command + args + env', () => {
    const toml = buildPanelMcpToml([
      { name: 'tool-x', command: '/opt/tool', args: ['--mode', 'json'], env: { API_KEY: 'secret-123', DEBUG: '1' } },
    ]);
    expect(toml).toContain('[mcp_servers.panel_tool-x]');
    expect(toml).toContain('command = "/opt/tool"');
    expect(toml).toContain('args = ["--mode", "json"]');
    expect(toml).toContain('[mcp_servers.panel_tool-x.env]');
    expect(toml).toContain('API_KEY = "secret-123"');
    expect(toml).toContain('DEBUG = "1"');
  });

  it('panel_ 前缀避免与 codex 已装 MCP 同名冲突', () => {
    // codex 已装 basic-memory,panel 也叫 basic-memory → 加前缀后变 panel_basic-memory,不冲突
    const toml = buildPanelMcpToml([{ name: 'basic-memory', command: '/x', args: [] }]);
    expect(toml).toContain('[mcp_servers.panel_basic-memory]');
    expect(toml).not.toContain('[mcp_servers.basic-memory]'); // 不会覆盖 codex 同名
  });

  it('非法字符 name 做安全替换(只允许 a-zA-Z0-9_-)', () => {
    const toml = buildPanelMcpToml([{ name: 'a.b/c d', command: '/x' }]);
    expect(toml).toMatch(/\[mcp_servers\.panel_a_b_c_d\]/);
  });

  it('escape 特殊字符:含 " 和 \\ 的命令/值', () => {
    const toml = buildPanelMcpToml([
      { name: 's1', command: 'echo "hi"', args: ['back\\slash'], env: { NL: 'line1\nline2' } },
    ]);
    expect(toml).toContain('command = "echo \\"hi\\""');
    expect(toml).toContain('args = ["back\\\\slash"]');
    expect(toml).toContain('NL = "line1\\nline2"');
  });

  it('多 server 各自独立段', () => {
    const toml = buildPanelMcpToml([
      { name: 'a', command: '/a' },
      { name: 'b', command: '/b' },
    ]);
    expect(toml.match(/\[mcp_servers\.panel_/g)).toHaveLength(2);
    expect(toml).toContain('panel_a');
    expect(toml).toContain('panel_b');
  });

  it('空数组 / 空 servers → 空字符串(调用方据此跳过 profile)', () => {
    expect(buildPanelMcpToml([])).toBe('');
  });

  it('忽略 undefined/null 的 env 值', () => {
    const toml = buildPanelMcpToml([{ name: 's', command: '/x', env: { A: 'a', B: null, C: undefined, D: 'd' } }]);
    expect(toml).toContain('A = "a"');
    expect(toml).toContain('D = "d"');
    expect(toml).not.toContain('B = ');
    expect(toml).not.toContain('C = ');
  });

  it('识别 Codex 临时 MCP 启动失败，供适配器无 MCP 重试', () => {
    expect(isCodexMcpStartupFailure('MCP startup failed: handshaking with MCP server failed')).toBe(true);
    expect(isCodexMcpStartupFailure('Transport [codex_rmcp_client::stdio_server_launcher::StdioServerTransport] error: Broken pipe')).toBe(true);
    expect(isCodexMcpStartupFailure('model denied the request')).toBe(false);
  });
});
