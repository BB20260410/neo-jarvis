import { describe, expect, it } from 'vitest';
import {
  normalizeNoeFreedomTrustManifest,
  validateNoeFreedomTrustManifest,
} from '../../src/capabilities/NoeFreedomTrustManifest.js';
import { findNoeFreedomTool } from '../../src/capabilities/NoeFreedomManifest.js';

describe('NoeFreedomTrustManifest', () => {
  it('normalizes manifests with stable redacted hashes', () => {
    const manifest = normalizeNoeFreedomTrustManifest({
      id: 'shell-demo',
      operation: 'noe.freedom.shell.execute',
      executionModes: ['dry_run', 'owner_supervised_unrestricted'],
      scopes: { commands: ['echo hello'] },
      rollbackPlan: 'no mutation',
      evidence: { required: true, secretValuesDenied: true },
    });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      id: 'shell-demo',
      operation: 'noe.freedom.shell.execute',
      riskLevel: 'critical',
    });
    expect(manifest.sha256).toHaveLength(64);
    expect(JSON.stringify(manifest)).not.toMatch(/sk-|tp-|AIza/i);
  });

  it('requires explicit real-execute mode and secret-value denial for execution manifests', () => {
    const tool = findNoeFreedomTool('noe.freedom.shell.execute');
    const invalid = validateNoeFreedomTrustManifest({
      tool,
      realExecute: true,
      manifest: {
        id: 'bad',
        operation: 'noe.freedom.shell.execute',
        executionModes: ['dry_run'],
        evidence: { secretValuesDenied: false },
      },
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toEqual(expect.arrayContaining([
      'trust_manifest_real_execute_mode_required',
      'trust_manifest_must_deny_secret_values',
    ]));
  });

  it('rejects manifests that do not match the requested tool operation', () => {
    const tool = findNoeFreedomTool('noe.freedom.social.publish');
    const out = validateNoeFreedomTrustManifest({
      tool,
      realExecute: true,
      manifest: {
        id: 'wrong',
        operation: 'noe.freedom.shell.execute',
        executionModes: ['owner_supervised_unrestricted'],
        rollbackPlan: 'delete published item',
      },
    });

    expect(out.ok).toBe(false);
    expect(out.errors).toContain('trust_manifest_operation_mismatch');
  });
});
