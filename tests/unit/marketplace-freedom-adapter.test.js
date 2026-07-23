// @ts-check
import { describe, expect, it } from 'vitest';
import { marketplaceInstallDryRun } from '../../src/runtime/freedomAdapters/marketplace.js';

describe('marketplaceInstallDryRun', () => {
  it('builds a valid install plan and sanitizes the manifest id in the target path', () => {
    const result = marketplaceInstallDryRun({
      tool: 'tool_marketplace_install',
      args: {
        manifest: { id: 'demo/tool' },
        installDir: '/tmp/noe-marketplace-tests',
      },
      deps: {},
    });

    expect(result).toMatchObject({
      adapter: 'tool-marketplace-install',
      valid: true,
      id: 'demo/tool',
      wouldWritePath: '/tmp/noe-marketplace-tests/demo_tool.json',
      registryDir: '/tmp/noe-marketplace-tests',
      rollbackExpectation: 'remove_installed_manifest',
      executionEnabled: false,
      warnings: [],
    });
  });
});
