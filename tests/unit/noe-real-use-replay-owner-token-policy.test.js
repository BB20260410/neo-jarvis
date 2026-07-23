import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  liveOwnerToken,
  parseArgs,
  redact,
  summarizeOwnerTokenSource,
} from '../../scripts/noe-real-use-replay.mjs';

function withEnv(patch, callback) {
  const previous = {};
  for (const key of Object.keys(patch)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = String(value);
    }
    return callback();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe('noe-real-use-replay owner-token policy', () => {
  it('blocks live owner-token reads by default without leaking token values', () => {
    const home = mkdtempSync(join(tmpdir(), 'noe-real-use-replay-policy-'));
    try {
      mkdirSync(join(home, '.noe-panel'), { recursive: true });
      writeFileSync(join(home, '.noe-panel', 'owner-token.txt'), '0123456789abcdef0123456789abcdef\n', { mode: 0o600 });

      withEnv({
        HOME: home,
        NOE_OWNER_TOKEN: undefined,
        NOE_ACK_READ_OWNER_TOKEN: undefined,
        NOE_STANDING_AUTONOMY_GRANT: '0',
      }, () => {
        const args = parseArgs([]);
        const tokenPolicy = liveOwnerToken({ ackReadOwnerToken: args.ackReadOwnerToken });

        expect(args.ackReadOwnerToken).toBe(false);
        expect(args.ownerTokenAuthorization).toMatchObject({
          authorized: false,
          mode: 'policy_blocked',
          secretValueReturned: false,
        });
        expect(tokenPolicy).toMatchObject({
          token: '',
          source: 'not_loaded_policy_requires_ack',
          policyBlocked: true,
        });
        expect(JSON.stringify({ args, tokenPolicy })).not.toContain('0123456789abcdef');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('allows explicit ack while keeping authorization metadata secret-free', () => withEnv({
    NOE_OWNER_TOKEN: undefined,
    NOE_ACK_READ_OWNER_TOKEN: undefined,
    NOE_STANDING_AUTONOMY_GRANT: '0',
  }, () => {
    const args = parseArgs(['--ack-read-owner-token']);

    expect(args.ackReadOwnerToken).toBe(true);
    expect(args.ownerTokenAuthorization).toMatchObject({
      authorized: true,
      mode: 'explicit_ack',
      source: '--ack-read-owner-token',
      scope: 'real-use-replay-live:run',
      secretValueReturned: false,
    });
    expect(JSON.stringify(args.ownerTokenAuthorization)).not.toMatch(/[0-9a-f]{32,}/i);
  }));

  it('redacts owner-token query and header shapes before replay evidence is written', () => {
    const token = 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789';
    const text = `http://127.0.0.1:51835/?t=${token}\nX-Panel-Owner-Token: ${token}`;

    const out = redact(text);

    expect(out).toContain('?t=[redacted]');
    expect(out).toContain('X-Panel-Owner-Token: [redacted]');
    expect(out).not.toContain(token);
  });

  it('managed mode is explicitly separate from live owner-token access', () => withEnv({
    NOE_ACK_READ_OWNER_TOKEN: undefined,
    NOE_STANDING_AUTONOMY_GRANT: '0',
  }, () => {
    const args = parseArgs(['--managed', '--port=51999']);

    expect(args.managed).toBe(true);
    expect(args.port).toBe(51999);
    expect(args.ackReadOwnerToken).toBe(false);
    expect(args.ownerTokenAuthorization.authorized).toBe(false);
  }));

  it('summarizes managed owner credential locations without path-like owner-token fields', () => {
    const source = '/tmp/noe-real-use-replay-test/.noe-panel/owner-token.txt';
    const summary = {
      source: summarizeOwnerTokenSource({ source, managed: true }),
      managed: {
        isolatedHomeUsed: true,
        isolatedHomeKept: false,
        dbLocation: 'managed_isolated_home',
        ownerCredentialLocation: 'managed_isolated_home',
      },
    };
    const serialized = JSON.stringify(summary);

    expect(summary.source).toBe('managed_isolated_owner_credential');
    expect(serialized).not.toContain(source);
    expect(serialized).not.toContain('ownerTokenPath');
  });
});
