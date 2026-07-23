import { describe, expect, it } from 'vitest';
import {
  createNoeFreedomSession,
  createNoeFreedomSessionStore,
} from '../../src/runtime/NoeFreedomSessionStore.js';

describe('NoeFreedomSessionStore', () => {
  it('creates a developer unrestricted session without exposing secrets', () => {
    const out = createNoeFreedomSession({
      mode: 'developer_unrestricted',
      ownerPresent: true,
      reason: 'use tp-unitsecret000000000000000000000000 without leaking it',
      idGenerator: () => 'unit-session',
      now: () => new Date('2026-06-08T00:00:00.000Z'),
    });

    expect(out.ok).toBe(true);
    expect(out.session).toMatchObject({
      sessionId: 'freedom-session-unit-session',
      mode: 'developer_unrestricted',
      ownerPresent: true,
      createdAt: '2026-06-08T00:00:00.000Z',
      secretValuesReturned: false,
    });
    expect(out.session.profile).toMatchObject({
      skipsTrustManifestAndAllowlist: true,
      stillRedactsSecretValues: true,
      canControlAllOwnerAuthorizedAccounts: true,
      canUseBrowserLoggedInSessions: true,
      canUseSshAgentAndConfiguredKeys: true,
    });
    expect(JSON.stringify(out)).not.toContain('tp-unitsecret');
  });

  it('requires owner presence before creating unrestricted sessions', () => {
    const out = createNoeFreedomSession({
      mode: 'developer_unrestricted',
      ownerPresent: false,
    });

    expect(out).toEqual({
      ok: false,
      errors: ['owner_present_required_for_freedom_session'],
    });
  });

  it('resolves session authorization into mode and owner presence', () => {
    const store = createNoeFreedomSessionStore({
      idGenerator: () => 'resolve-session',
      now: () => new Date('2026-06-08T00:00:00.000Z'),
    });
    const started = store.start({
      mode: 'developer_unrestricted',
      ownerPresent: true,
      reason: 'owner approved',
    });

    const resolved = store.resolveAuthorization({
      authorization: { sessionId: started.session.sessionId },
    });

    expect(resolved).toMatchObject({
      ok: true,
      authorization: {
        sessionId: 'freedom-session-resolve-session',
        mode: 'developer_unrestricted',
        ownerPresent: true,
        sessionSource: 'owner-request',
        reason: 'owner approved',
      },
    });
  });

  it('blocks missing session references instead of trusting payload claims', () => {
    const store = createNoeFreedomSessionStore();
    const resolved = store.resolveAuthorization({
      authorization: {
        sessionId: 'freedom-session-missing',
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
    });

    expect(resolved).toEqual({
      ok: false,
      errors: ['freedom_session_not_found'],
      sessionId: 'freedom-session-missing',
    });
  });

  // owner 偏好（2026-06-11 回滚提权握手）：无 session 时按 payload 透传，不拒自我声明
  it('passes through dry-run payloads that do not claim owner presence', () => {
    const store = createNoeFreedomSessionStore();
    const dryRun = store.resolveAuthorization({
      authorization: { mode: 'dry_run' },
    });
    expect(dryRun.ok).toBe(true);
    expect(dryRun.authorization).toMatchObject({ mode: 'dry_run' });

    const explicitFalse = store.resolveAuthorization({
      authorization: { mode: 'dry_run', ownerPresent: false },
    });
    expect(explicitFalse.ok).toBe(true);
    expect(explicitFalse.authorization).toMatchObject({ mode: 'dry_run', ownerPresent: false });
  });

  // 自我声明用 truthy 字符串 'true' 不该绕过（仍走透传分支但下游 validate ===true 会拦 realExecute）
  it('does not let non-strict-true ownerPresent claim mint a real-execute grant', () => {
    const store = createNoeFreedomSessionStore();
    const resolved = store.resolveAuthorization({
      authorization: { mode: 'developer_unrestricted', ownerPresent: 'true' },
    });
    // 'true' 字符串非严格 true：透传后下游 validateNoeFreedomAuthorization 用 ===true 判定缺 ownerPresent → realExecute 被拦
    expect(resolved.ok).toBe(true);
    expect(resolved.authorization.ownerPresent).not.toBe(true);
  });
});
