import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createReadinessReport,
  isObsidianServer,
  redactUrl,
  safeMcpServers,
} from '../../scripts/obsidian-mcp-readiness.mjs';

const closedListeners = {
  http27123: { open: false, error: 'closed' },
  https27124: { open: false, error: 'closed' },
  thirdParty3010: { open: false, error: 'closed' },
};

let tmp = '';

function tempRoot() {
  tmp = mkdtempSync(join(tmpdir(), 'noe-obsidian-mcp-'));
  return tmp;
}

function writeJson(file, value) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 2));
}

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = '';
});

describe('obsidian MCP readiness check', () => {
  it('reports clear next actions without touching real Obsidian config', async () => {
    const root = tempRoot();
    const report = await createReadinessReport({
      obsidianJson: join(root, 'missing-obsidian.json'),
      mcpJson: join(root, 'missing-mcp.json'),
      listeners: closedListeners,
      endpointProbe: { reachable: false, error: 'not probed' },
      env: {},
      checkedAt: '2026-06-05T00:00:00.000Z',
    });

    expect(report.ok).toBe(false);
    expect(report.mode).toBe('read_only');
    expect(report.obsidian.configExists).toBe(false);
    expect(report.noeMcp.configExists).toBe(false);
    expect(report.nextActions).toEqual(expect.arrayContaining([
      'Open or create a real Obsidian vault first.',
      'Install and enable the Obsidian Local REST API community plugin in that vault.',
      'Copy the Local REST API key from Obsidian settings into the MCP header/env at registration time. Do not write it into git or docs.',
    ]));
  });

  it('does not crash on the normal CLI path when listeners are discovered live', async () => {
    const root = tempRoot();
    const report = await createReadinessReport({
      obsidianJson: join(root, 'missing-obsidian.json'),
      mcpJson: join(root, 'missing-mcp.json'),
      env: {},
      checkedAt: '2026-06-05T00:00:00.000Z',
    });

    expect(report.ok).toBe(false);
    expect(report.obsidian.listeners).toHaveProperty('http27123');
    expect(report.obsidian.listeners).toHaveProperty('https27124');
  });

  it('passes when a vault, Local REST plugin, listener, and MCP credential are present', async () => {
    const root = tempRoot();
    const vault = join(root, 'Vault');
    const pluginDir = join(vault, '.obsidian', 'plugins', 'obsidian-local-rest-api');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'manifest.json'), '{}');
    writeFileSync(join(pluginDir, 'data.json'), '{}');

    const obsidianJson = join(root, 'obsidian.json');
    writeJson(obsidianJson, { vaults: { v1: { path: vault, open: true } } });

    const sentinel = 'redaction-sentinel-value';
    const mcpJson = join(root, 'mcp-servers.json');
    writeJson(mcpJson, {
      version: 1,
      servers: [
        {
          name: 'obsidian-local-rest',
          type: 'http',
          url: `http://127.0.0.1:27123/mcp/?token=${sentinel}`,
          headers: { Authorization: 'Bearer <api-key>' },
          enabled: true,
        },
      ],
    });

    const report = await createReadinessReport({
      obsidianJson,
      mcpJson,
      listeners: {
        http27123: { open: true },
        https27124: { open: false },
        thirdParty3010: { open: false },
      },
      endpointProbe: { reachable: true, status: 200 },
      env: {},
      checkedAt: '2026-06-05T00:00:00.000Z',
    });

    expect(report.ok).toBe(true);
    expect(report.obsidian.vaults[0]).toMatchObject({
      exists: true,
      hasObsidianDir: true,
      localRestPlugin: { installed: true, dataFilePresent: true },
    });
    expect(report.obsidian.apiKey).toMatchObject({ envPresent: false, mcpCredentialPresent: true, printed: false });
    expect(report.noeMcp.registeredObsidianServers).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain(sentinel);
    expect(report.noeMcp.registeredObsidianServers[0].url).toContain('redacted');
    expect(report.nextActions).not.toContain('Open or create a real Obsidian vault first.');
  });

  it('redacts URL secrets and recognizes Obsidian MCP server shapes', () => {
    const redacted = redactUrl('http://127.0.0.1:27123/mcp/?api_key=abc12345678901234567890&plain=ok');
    expect(redacted).not.toContain('abc12345678901234567890');
    expect(redacted).toContain('plain=ok');

    expect(isObsidianServer({ name: 'obsidian-local-rest', type: 'http', url: '', command: '', envKeys: [], headerKeys: [] })).toBe(true);
    expect(isObsidianServer({ name: 'unified-kb', type: 'http', url: '', command: '', envKeys: [], headerKeys: [] })).toBe(false);
  });

  it('summarizes MCP config without exposing header or env values', () => {
    const root = tempRoot();
    const mcpJson = join(root, 'mcp-servers.json');
    writeJson(mcpJson, {
      version: 1,
      servers: [
        {
          name: 'obsidian',
          type: 'stdio',
          command: 'npx',
          args: ['-y', '@cyanheads/obsidian-mcp-server'],
          env: { OBSIDIAN_API_KEY: '<api-key>' },
          headers: { Authorization: 'Bearer <api-key>' },
        },
      ],
    });

    const out = safeMcpServers({ mcpJson });
    expect(out.servers[0]).toMatchObject({
      name: 'obsidian',
      argsContainObsidian: true,
      envKeys: ['OBSIDIAN_API_KEY'],
      headerKeys: ['Authorization'],
    });
    expect(JSON.stringify(out)).not.toContain('Bearer <api-key>');
  });
});
