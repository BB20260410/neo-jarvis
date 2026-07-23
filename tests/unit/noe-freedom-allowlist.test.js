import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluateNoeFreedomAllowlist } from '../../src/capabilities/NoeFreedomAllowlist.js';
import { findNoeFreedomTool } from '../../src/capabilities/NoeFreedomManifest.js';
import { normalizeNoeFreedomTrustManifest } from '../../src/capabilities/NoeFreedomTrustManifest.js';

function manifest(operation, scopes = {}) {
  return normalizeNoeFreedomTrustManifest({
    id: `${operation}-trust`,
    operation,
    executionModes: ['dry_run', 'owner_supervised_unrestricted'],
    scopes,
    rollbackPlan: 'test rollback',
  });
}

describe('NoeFreedomAllowlist', () => {
  it('denies shell commands not covered by manifest and allowlist', () => {
    const tool = findNoeFreedomTool('noe.freedom.shell.execute');
    const out = evaluateNoeFreedomAllowlist({
      tool,
      realExecute: true,
      args: { command: 'rm -rf /tmp/noe-danger' },
      trustManifest: manifest(tool.operation, { commands: ['echo *'] }),
      allowlist: { scopes: { operations: [tool.operation], commands: ['echo *'] } },
    });

    expect(out.ok).toBe(false);
    expect(out.errors).toContain('shell_command_not_allowlisted');
  });

  it('requires explicit script scope for AppleScript automation outside developer mode', () => {
    const tool = findNoeFreedomTool('noe.freedom.macos.applescript.run');
    const accepted = evaluateNoeFreedomAllowlist({
      tool,
      realExecute: true,
      args: { script: 'tell application "System Events" to get name of first process' },
      trustManifest: manifest(tool.operation, { commands: ['tell application "System Events"*'] }),
      allowlist: { scopes: { operations: [tool.operation], commands: ['tell application "System Events"*'] } },
    });
    expect(accepted.ok).toBe(true);

    const rejected = evaluateNoeFreedomAllowlist({
      tool,
      realExecute: true,
      args: { script: 'tell application "Finder" to delete POSIX file "/tmp/demo"' },
      trustManifest: manifest(tool.operation, { commands: ['tell application "System Events"*'] }),
      allowlist: { scopes: { operations: [tool.operation], commands: ['*'] } },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toContain('shell_command_not_in_trust_manifest');
  });

  it('does not let a broad allowlist override a narrow trust manifest', () => {
    const tool = findNoeFreedomTool('noe.freedom.shell.execute');
    const out = evaluateNoeFreedomAllowlist({
      tool,
      realExecute: true,
      args: { command: 'rm -rf /tmp/noe-danger' },
      trustManifest: manifest(tool.operation, { commands: ['echo *'] }),
      allowlist: { scopes: { operations: [tool.operation], commands: ['*'] } },
    });

    expect(out.ok).toBe(false);
    expect(out.errors).toContain('shell_command_not_in_trust_manifest');
  });

  it('allows exact scoped hosts and methods for social publish', () => {
    const tool = findNoeFreedomTool('noe.freedom.social.publish');
    const out = evaluateNoeFreedomAllowlist({
      tool,
      realExecute: true,
      args: { url: 'https://example.test/webhook', method: 'POST' },
      trustManifest: manifest(tool.operation, { hosts: ['example.test'], networkMethods: ['POST'] }),
      allowlist: { scopes: { operations: [tool.operation], hosts: ['example.test'], networkMethods: ['POST'] } },
    });

    expect(out.ok).toBe(true);
  });

  it('requires explicit path scopes for network file uploads outside developer mode', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-upload-allowlist-'));
    const filePath = join(root, 'payload.txt');
    try {
      const tool = findNoeFreedomTool('noe.freedom.network.upload');
      const accepted = evaluateNoeFreedomAllowlist({
        tool,
        root,
        realExecute: true,
        args: { url: 'https://example.test/upload', method: 'POST', filePath },
        trustManifest: manifest(tool.operation, { hosts: ['example.test'], networkMethods: ['POST'], paths: [filePath] }),
        allowlist: { scopes: { operations: [tool.operation], hosts: ['example.test'], networkMethods: ['POST'], paths: [filePath] } },
      });
      expect(accepted.ok).toBe(true);

      const rejected = evaluateNoeFreedomAllowlist({
        tool,
        root,
        realExecute: true,
        args: { url: 'https://example.test/upload', method: 'POST', filePath },
        trustManifest: manifest(tool.operation, { hosts: ['example.test'], networkMethods: ['POST'], paths: [join(root, 'other.txt')] }),
        allowlist: { scopes: { operations: [tool.operation], hosts: ['example.test'], networkMethods: ['POST'], paths: [filePath] } },
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.errors).toContain('path_not_in_trust_manifest');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('requires explicit host scope for browser account pages outside developer mode', () => {
    const tool = findNoeFreedomTool('noe.freedom.browser.open');
    const accepted = evaluateNoeFreedomAllowlist({
      tool,
      realExecute: true,
      args: { url: 'https://accounts.example.test/settings' },
      trustManifest: manifest(tool.operation, { hosts: ['accounts.example.test'] }),
      allowlist: { scopes: { operations: [tool.operation], hosts: ['accounts.example.test'] } },
    });
    expect(accepted.ok).toBe(true);

    const rejected = evaluateNoeFreedomAllowlist({
      tool,
      realExecute: true,
      args: { url: 'https://accounts.example.test/settings' },
      trustManifest: manifest(tool.operation, { hosts: ['other.example.test'] }),
      allowlist: { scopes: { operations: [tool.operation], hosts: ['accounts.example.test'] } },
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.errors).toContain('network_host_not_in_trust_manifest');
  });

  it('requires explicit secret refs for keychain access', () => {
    const tool = findNoeFreedomTool('noe.freedom.keychain.read');
    const out = evaluateNoeFreedomAllowlist({
      tool,
      realExecute: true,
      args: { service: 'Neo Jarvis Noe model API keys', account: 'MINIMAX_API_KEY' },
      trustManifest: manifest(tool.operation, { secrets: ['keychain:Neo Jarvis Noe model API keys:MINIMAX_API_KEY'] }),
      allowlist: { scopes: { operations: [tool.operation], secrets: ['keychain:Neo Jarvis Noe model API keys:MINIMAX_API_KEY'] } },
    });

    expect(out.ok).toBe(true);
  });

  it('requires marketplace wildcard for registry list operations', () => {
    const tool = findNoeFreedomTool('noe.freedom.tool_marketplace.list');
    const out = evaluateNoeFreedomAllowlist({
      tool,
      realExecute: true,
      args: {},
      trustManifest: manifest(tool.operation, { marketplaceTools: ['*'] }),
      allowlist: { scopes: { operations: [tool.operation], marketplaceTools: ['*'] } },
    });

    expect(out.ok).toBe(true);
  });

  it('does not let marketplace disable target tools outside the manifest', () => {
    const tool = findNoeFreedomTool('noe.freedom.tool_marketplace.disable');
    const out = evaluateNoeFreedomAllowlist({
      tool,
      realExecute: true,
      args: { id: 'danger-tool' },
      trustManifest: manifest(tool.operation, { marketplaceTools: ['safe-tool'] }),
      allowlist: { scopes: { operations: [tool.operation], marketplaceTools: ['*'] } },
    });

    expect(out.ok).toBe(false);
    expect(out.errors).toContain('marketplace_tool_not_in_trust_manifest');
  });

  it('requires explicit path scopes for social draft writes', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-draft-allowlist-'));
    try {
      const tool = findNoeFreedomTool('noe.freedom.social.draft.create');
      const accepted = evaluateNoeFreedomAllowlist({
        tool,
        root: '/',
        realExecute: true,
        args: { draftDir, content: 'hello' },
        trustManifest: manifest(tool.operation, { paths: [draftDir] }),
        allowlist: { scopes: { operations: [tool.operation], paths: [draftDir] } },
      });
      expect(accepted.ok).toBe(true);

      const rejected = evaluateNoeFreedomAllowlist({
        tool,
        root: '/',
        realExecute: true,
        args: { content: 'hello' },
        trustManifest: manifest(tool.operation, { paths: [draftDir] }),
        allowlist: { scopes: { operations: [tool.operation], paths: [draftDir] } },
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.errors).toContain('social_draft_dir_required_for_allowlist');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('requires explicit path scopes for SSH inventory reads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-ssh-inventory-allowlist-'));
    const configPath = join(dir, 'config');
    try {
      const tool = findNoeFreedomTool('noe.freedom.ssh.inventory');
      const accepted = evaluateNoeFreedomAllowlist({
        tool,
        root: '/',
        realExecute: true,
        args: { path: configPath },
        trustManifest: manifest(tool.operation, { paths: [configPath] }),
        allowlist: { scopes: { operations: [tool.operation], paths: [configPath] } },
      });
      expect(accepted.ok).toBe(true);

      const rejected = evaluateNoeFreedomAllowlist({
        tool,
        root: '/',
        realExecute: true,
        args: { path: configPath },
        trustManifest: manifest(tool.operation, { paths: [join(dir, 'other-config')] }),
        allowlist: { scopes: { operations: [tool.operation], paths: [configPath] } },
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.errors).toContain('path_not_in_trust_manifest');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
