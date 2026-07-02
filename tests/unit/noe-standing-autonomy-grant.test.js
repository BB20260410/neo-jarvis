import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  GRANT_SCHEMA_VERSION,
  MAX_AUTONOMY_SCOPES,
  createMaxAutonomyGrant,
  evaluateStandingAutonomyGrant,
  resolveOwnerTokenAuthorization,
  summarizeGrantForReport,
  writeStandingAutonomyGrant,
} from '../../scripts/lib/noe-standing-autonomy-grant.mjs';

describe('noe-standing-autonomy-grant', () => {
  it('blocks by default and still allows explicit ack without reading a grant', () => {
    const missingPath = join(tmpdir(), `noe-missing-grant-${Date.now()}.json`);
    expect(evaluateStandingAutonomyGrant({ grantPath: missingPath, env: {} })).toMatchObject({
      authorized: false,
      source: 'grant_missing',
      grantId: '',
    });
    expect(resolveOwnerTokenAuthorization({ explicitAck: true, grantPath: missingPath, env: {} })).toMatchObject({
      authorized: true,
      mode: 'explicit_ack',
      secretValueReturned: false,
    });
  });

  it('writes a max autonomy grant that authorizes each declared local execution scope without secret values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-standing-grant-'));
    try {
      const grantPath = join(dir, 'autonomy-grant.json');
      const grant = createMaxAutonomyGrant({
        now: Date.parse('2026-06-12T07:30:00Z'),
        reason: 'unit test owner standing grant',
      });
      const { grant: written } = writeStandingAutonomyGrant({ grant, grantPath });

      expect(written.schemaVersion).toBe(GRANT_SCHEMA_VERSION);
      expect(written.secretValuesIncluded).toBe(false);
      expect(written.scopes).toEqual(MAX_AUTONOMY_SCOPES);
      for (const scope of MAX_AUTONOMY_SCOPES) {
        expect(evaluateStandingAutonomyGrant({
          scope,
          grantPath,
          env: {},
          now: Date.parse('2026-06-12T07:31:00Z'),
        })).toMatchObject({
          authorized: true,
          scope,
          secretValueReturned: false,
        });
      }

      const raw = readFileSync(grantPath, 'utf8');
      expect(raw).toContain('owner-max-autonomy-20260612T073000Z');
      expect(raw).not.toMatch(/sk-|api[_-]?key|tokenValue|cookie|OAuth\s+[A-Za-z0-9]/i);
      expect(summarizeGrantForReport(written)).toMatchObject({
        enabled: true,
        secretValuesIncluded: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not let owner-token read imply unrelated scopes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-standing-grant-scope-'));
    try {
      const grantPath = join(dir, 'autonomy-grant.json');
      writeStandingAutonomyGrant({
        grant: {
          ...createMaxAutonomyGrant({ now: Date.parse('2026-06-12T07:30:00Z') }),
          scopes: ['owner-token:read'],
        },
        grantPath,
      });

      expect(evaluateStandingAutonomyGrant({ scope: 'owner-token:read', grantPath, env: {} }).authorized).toBe(true);
      expect(evaluateStandingAutonomyGrant({ scope: 'restart-51835:repair', grantPath, env: {} })).toMatchObject({
        authorized: false,
        reason: 'standing autonomy grant missing scope restart-51835:repair',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('blocks disabled or expired grants and supports env kill switch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-standing-grant-disabled-'));
    try {
      const grantPath = join(dir, 'autonomy-grant.json');
      writeStandingAutonomyGrant({
        grant: createMaxAutonomyGrant({
          now: Date.parse('2026-06-12T07:30:00Z'),
          ttlMs: 1000,
        }),
        grantPath,
      });

      expect(evaluateStandingAutonomyGrant({
        scope: 'freedom-live:run',
        grantPath,
        env: {},
        now: Date.parse('2026-06-12T07:30:00Z') + 2000,
      })).toMatchObject({ authorized: false, reason: 'standing autonomy grant expired' });
      expect(evaluateStandingAutonomyGrant({
        scope: 'freedom-live:run',
        grantPath,
        env: { NOE_STANDING_AUTONOMY_GRANT: '0' },
      })).toMatchObject({
        authorized: false,
        source: 'standing_grant_disabled_by_env',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves owner-token authorization through standing grant when explicit ack is absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-standing-grant-resolve-'));
    try {
      const grantPath = join(dir, 'autonomy-grant.json');
      writeStandingAutonomyGrant({ grant: createMaxAutonomyGrant(), grantPath });

      expect(resolveOwnerTokenAuthorization({
        explicitAck: false,
        scope: 'freedom-live:run',
        grantPath,
        env: {},
      })).toMatchObject({
        authorized: true,
        mode: 'standing_grant',
        source: 'standing_autonomy_grant',
        secretValueReturned: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
