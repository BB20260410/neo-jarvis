import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  disableNoeMarketplaceTool,
  installNoeMarketplaceTool,
  listNoeMarketplaceTools,
  readNoeMarketplaceTool,
  uninstallNoeMarketplaceTool,
} from '../../src/runtime/NoeToolMarketplaceRegistry.js';

describe('NoeToolMarketplaceRegistry', () => {
  it('installs redacted tool records and lists disabled execution state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-marketplace-registry-'));
    try {
      const installed = installNoeMarketplaceTool({
        dir,
        manifest: {
          id: 'demo-tool',
          name: 'Demo Tool',
          sourceUri: 'https://example.test/tools/demo-tool.json',
          command: 'node demo.js',
          apiKey: 'tp-unitsecret000000000000000000000000000000',
        },
      });

      expect(installed).toMatchObject({ ok: true, id: 'demo-tool', state: 'enabled', executionEnabled: false });
      const text = readFileSync(installed.path, 'utf8');
      expect(text).toContain('"executionEnabled": false');
      expect(text).toContain('"sourceUri": "https://example.test/tools/demo-tool.json"');
      expect(text).not.toContain('tp-unitsecret');

      const listed = listNoeMarketplaceTools({ dir });
      expect(listed.tools).toEqual([
        expect.objectContaining({ id: 'demo-tool', state: 'enabled', executionEnabled: false }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed ids, versions, and secret-like source URIs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-marketplace-registry-'));
    try {
      const badId = installNoeMarketplaceTool({ dir, manifest: { id: '../bad-tool' } });
      expect(badId).toMatchObject({ ok: false, error: 'invalid_tool_manifest_metadata' });
      expect(badId.errors).toContain('invalid_tool_manifest_id');

      const badVersion = installNoeMarketplaceTool({ dir, manifest: { id: 'demo-tool', version: '1.0.0 bad' } });
      expect(badVersion.errors).toContain('invalid_tool_manifest_version');

      const badSource = installNoeMarketplaceTool({
        dir,
        manifest: { id: 'demo-tool', sourceUri: 'https://example.test/tool?token=unitsecret0000000000000000' },
      });
      expect(badSource.errors).toContain('secret_like_source_uri_denied');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('disables and uninstalls records through tombstones without executing tool code', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-marketplace-registry-'));
    try {
      installNoeMarketplaceTool({ dir, manifest: { id: 'demo-tool', command: 'node demo.js' } });
      const disabled = disableNoeMarketplaceTool({ dir, id: 'demo-tool', reason: 'test-disable' });
      expect(disabled).toMatchObject({ ok: true, id: 'demo-tool', state: 'disabled' });

      const readDisabled = readNoeMarketplaceTool({ dir, id: 'demo-tool' });
      expect(readDisabled.record).toMatchObject({
        id: 'demo-tool',
        state: 'disabled',
        reason: 'test-disable',
        entrypoint: expect.objectContaining({ executionEnabled: false }),
      });

      const uninstalled = uninstallNoeMarketplaceTool({ dir, id: 'demo-tool', reason: 'test-uninstall' });
      expect(uninstalled).toMatchObject({ ok: true, id: 'demo-tool', state: 'uninstalled' });
      const listed = listNoeMarketplaceTools({ dir });
      expect(listed.tools[0]).toMatchObject({ id: 'demo-tool', state: 'uninstalled', executionEnabled: false });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers active records over disabled tombstones when listing reinstalled tools', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-marketplace-registry-'));
    try {
      installNoeMarketplaceTool({ dir, manifest: { id: 'demo-tool', version: '1.0.0' } });
      disableNoeMarketplaceTool({ dir, id: 'demo-tool' });
      installNoeMarketplaceTool({ dir, manifest: { id: 'demo-tool', version: '2.0.0' } });

      const listed = listNoeMarketplaceTools({ dir });
      expect(listed.tools).toHaveLength(1);
      expect(listed.tools[0]).toMatchObject({
        id: 'demo-tool',
        version: '2.0.0',
        state: 'enabled',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects symlinked registry paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-marketplace-registry-'));
    const outside = mkdtempSync(join(tmpdir(), 'noe-marketplace-outside-'));
    try {
      mkdirSync(join(root, 'market'), { recursive: true });
      symlinkSync(outside, join(root, 'market/tools'));
      expect(() => installNoeMarketplaceTool({
        dir: join(root, 'market/tools'),
        manifest: { id: 'demo-tool' },
      })).toThrow('tool_marketplace_symlink_path_denied');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
