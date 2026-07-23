import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireOwnerToken } from '../../../src/server/auth/owner-token.js';
import { registerNoeFreedomRoutes } from '../../../src/server/routes/noeFreedom.js';
import { createNoeFreedomSessionStore } from '../../../src/runtime/NoeFreedomSessionStore.js';
import { createNoeSocialDraft } from '../../../src/runtime/NoeSocialPublishQueue.js';

function makeApp() {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post']) app[method] = (path, ...handlers) => routes.push({ method, path, handlers });
  return { app, routes };
}

function makeReq({ body = {}, query = {}, params = {}, headers = {} } = {}) {
  return {
    body,
    query,
    params,
    get(name) {
      const lower = String(name || '').toLowerCase();
      for (const [key, value] of Object.entries(headers)) {
        if (key.toLowerCase() === lower) return value;
      }
      return undefined;
    },
  };
}

function makeRes() {
  return {
    statusCode: 200,
    payload: undefined,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

function register({ root, getAdapter } = {}) {
  const { app, routes } = makeApp();
  registerNoeFreedomRoutes(app, {
    sendError: (res, e) => res.status(500).json({ ok: false, error: e.message }),
    root,
    getAdapter,
    freedomSessionStore: createNoeFreedomSessionStore({
      idGenerator: () => 'route-session',
      now: () => new Date('2026-06-08T00:00:00.000Z'),
    }),
  });
  return routes;
}

describe('Noe freedom routes', () => {
  it('registers capabilities, dry-run, and execute behind owner-token middleware', () => {
    const routes = register();
    expect(routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      'get /api/noe/freedom/capabilities',
      'post /api/noe/freedom/session/start',
      'get /api/noe/freedom/session/:sessionId',
      'post /api/noe/freedom/dry-run',
      'post /api/noe/freedom/execute',
    ]);
    expect(routes.every((route) => route.handlers[0] === requireOwnerToken)).toBe(true);
  });

  it('lists high-autonomy capabilities without leaking secrets', async () => {
    const routes = register();
    const route = routes.find((item) => item.path === '/api/noe/freedom/capabilities');
    const res = makeRes();
    await route.handlers[1](makeReq(), res);

    expect(res.payload.ok).toBe(true);
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.social.publish');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.social.workflow.prepare');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.social.preflight.run');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.social.form_fill.plan');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.social.form_fill.execute');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.social.media_upload.prepare');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.social.media_upload.execute');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.social.final_publish.execute');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.social.rollback.execute');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.file.delete');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.account.connection_inventory');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.developer.readiness_audit');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.browser.open');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.browser.dom.execute');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.social.publish_orchestrate');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.chain.execute');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.run.resume_next_actions');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.run.history');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.macos.applescript.run');
    expect(res.payload.tools.map((tool) => tool.id)).toContain('noe.freedom.ssh.inventory');
    expect(res.payload.authModes).toContain('developer_unrestricted');
    expect(res.payload.developerMode).toMatchObject({
      mode: 'developer_unrestricted',
      skipsTrustManifestAndAllowlist: true,
      stillRedactsSecretValues: true,
      canOpenBrowserAccounts: true,
      canPublishExternally: true,
      canUploadFiles: true,
      canDeleteFiles: true,
      canDeleteOrHideExternally: true,
      hardVetoes: [
        'system_root_delete',
        'codex_runtime_delete',
        'secret_plaintext_output',
      ],
    });
    expect(res.payload.quickStarts.map((item) => item.id)).toEqual(expect.arrayContaining([
      'developer.shell.safe-echo',
      'account.connection-inventory.social',
      'file.delete.placeholder',
      'developer.readiness-audit',
      'browser.open-douyin-creator',
      'social.workflow.douyin',
      'social.orchestrate.douyin',
      'freedom.chain.echo-and-inventory',
      'freedom.resume-next-actions.placeholder',
      'freedom.run-history.recent',
      'social.preflight.douyin',
      'social.form-fill.douyin',
      'social.form-fill-execute.douyin',
      'social.media-upload.douyin',
      'social.media-upload-execute.douyin',
      'social.final-publish.douyin',
      'social.rollback-execute.douyin',
      'macos.jxa.front-browser-url',
      'browser.dom.read-title',
    ]));
    expect(res.payload.quickStarts.every((item) => res.payload.tools.some((tool) => tool.id === item.actionId))).toBe(true);
    expect(JSON.stringify(res.payload)).not.toMatch(/sk-|tp-|AIza/i);
  });

  it('dry-runs shell execution and redacts sensitive args', async () => {
    const routes = register();
    const route = routes.find((item) => item.path === '/api/noe/freedom/dry-run');
    const res = makeRes();
    await route.handlers[1](makeReq({
      body: {
        action: 'noe.freedom.shell.execute',
        args: { command: 'echo tp-unitsecret000000000000000000000000000000' },
      },
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ ok: true, dryRunOnly: true });
    expect(JSON.stringify(res.payload)).not.toContain('tp-unitsecret');
  });

  it('persists dry-run ledgers only when requested', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-routes-'));
    try {
      const routes = register({ root });
      const route = routes.find((item) => item.path === '/api/noe/freedom/dry-run');
      const res = makeRes();
      await route.handlers[1](makeReq({
        body: {
          action: 'noe.freedom.social.publish',
          args: {
            url: 'https://example.test/hook',
            content: 'hello tp-unitsecret000000000000000000000000000000',
          },
          persistLedger: true,
          runId: 'route-dry-run',
        },
      }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.runLedger).toMatchObject({
        ref: 'output/noe-freedom-runs/route-dry-run/ledger.json',
      });
      const ledger = readFileSync(join(root, res.payload.runLedger.ref), 'utf8');
      expect(ledger).toContain('"runId": "route-dry-run"');
      expect(ledger).not.toContain('tp-unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns final publish prior-stage gate blockers at the dry-run route top level', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-route-final-gate-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-freedom-route-final-draft-'));
    try {
      createNoeSocialDraft({
        dir: draftDir,
        draft: {
          id: 'route-missing-prior-stage',
          platform: 'douyin',
          content: 'visible content',
          metadata: {
            title: 'visible title',
            mediaFiles: ['clips/demo.mp4'],
          },
        },
      });
      const routes = register({ root });
      const route = routes.find((item) => item.path === '/api/noe/freedom/dry-run');
      const res = makeRes();
      await route.handlers[1](makeReq({
        body: {
          action: 'noe.freedom.social.final_publish.execute',
          args: {
            draftId: 'route-missing-prior-stage',
            draftDir,
            platform: 'douyin',
            requirePriorStageEvidence: true,
            browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
          },
        },
      }), res);

      expect(res.statusCode).toBe(409);
      expect(res.payload.ok).toBe(false);
      expect(res.payload.blockers).toContain('final_publish_prior_stage_evidence_required');
      expect(res.payload.blockers).toContain('final_publish_prior_stage_missing:form_fill_execute');
      expect(res.payload.blockers).toContain('final_publish_prior_stage_missing:media_upload_execute');
      expect(res.payload.blockers).not.toContain('freedom_runtime_failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks execute requests that only claim realExecute without owner-supervised authorization', async () => {
    const routes = register();
    const route = routes.find((item) => item.path === '/api/noe/freedom/execute');
    const res = makeRes();
    await route.handlers[1](makeReq({
      body: {
        action: 'noe.freedom.social.publish',
        realExecute: true,
        args: { url: 'https://example.test/hook', content: 'hello' },
        authorization: { mode: 'dry_run' },
      },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.payload.ok).toBe(false);
    expect(res.payload.blockers).toContain('owner_supervised_unrestricted_required_for_real_execute');
  });

  it('executes harmless commands through developer unrestricted mode without trust or allowlist', async () => {
    // /execute 已被 owner-token 保护；真实执行默认视为 owner present，无需调用方再重复传 ownerPresent。
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-route-developer-'));
    try {
      const routes = register({ root });
      const route = routes.find((item) => item.path === '/api/noe/freedom/execute');
      const res = makeRes();
      await route.handlers[1](makeReq({
        body: {
          action: 'noe.freedom.shell.execute',
          realExecute: true,
          args: { command: 'printf route-developer-ok' },
          authorization: {
            mode: 'developer_unrestricted',
          },
          persistLedger: true,
          runId: 'route-developer-unrestricted',
        },
      }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.ok).toBe(true);
      expect(res.payload.trust).toBe(null);
      expect(res.payload.allowlist).toBe(null);
      expect(res.payload.authorization).toMatchObject({
        mode: 'developer_unrestricted',
        ownerPresent: true,
      });
      expect(res.payload.runtime.stdout).toBe('route-developer-ok');
      expect(res.payload.warnings).toContain('developer_unrestricted_mode_active');
      expect(res.payload.runLedger).toMatchObject({
        ref: 'output/noe-freedom-runs/route-developer-unrestricted/ledger.json',
      });
      const ledger = readFileSync(join(root, res.payload.runLedger.ref), 'utf8');
      expect(ledger).toContain('"mode": "developer_unrestricted"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts a developer session and uses it for unrestricted execution', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-route-session-'));
    try {
      const routes = register({ root });
      const startRoute = routes.find((item) => item.path === '/api/noe/freedom/session/start');
      const startRes = makeRes();
      await startRoute.handlers[1](makeReq({
        body: {
          mode: 'developer_unrestricted',
          ownerPresent: true,
          reason: 'owner is at keyboard',
        },
      }), startRes);

      expect(startRes.statusCode).toBe(200);
      expect(startRes.payload.session).toMatchObject({
        sessionId: 'freedom-session-route-session',
        mode: 'developer_unrestricted',
        ownerPresent: true,
      });

      const getRoute = routes.find((item) => item.path === '/api/noe/freedom/session/:sessionId');
      const getRes = makeRes();
      await getRoute.handlers[1](makeReq({ params: { sessionId: 'freedom-session-route-session' } }), getRes);
      expect(getRes.statusCode).toBe(200);
      expect(getRes.payload.session.sessionId).toBe('freedom-session-route-session');

      const executeRoute = routes.find((item) => item.path === '/api/noe/freedom/execute');
      const executeRes = makeRes();
      await executeRoute.handlers[1](makeReq({
        body: {
          action: 'noe.freedom.shell.execute',
          realExecute: true,
          args: { command: 'printf route-session-ok' },
          authorization: {
            sessionId: 'freedom-session-route-session',
          },
          persistLedger: true,
          runId: 'route-session-execute',
        },
      }), executeRes);

      expect(executeRes.statusCode).toBe(200);
      expect(executeRes.payload.ok).toBe(true);
      expect(executeRes.payload.authorization).toMatchObject({
        mode: 'developer_unrestricted',
        ownerPresent: true,
        sessionId: 'freedom-session-route-session',
      });
      expect(executeRes.payload.runtime.stdout).toBe('route-session-ok');
      const ledger = readFileSync(join(root, executeRes.payload.runLedger.ref), 'utf8');
      expect(ledger).toContain('"sessionId": "freedom-session-route-session"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not trust missing freedom session ids for execution', async () => {
    const routes = register();
    const route = routes.find((item) => item.path === '/api/noe/freedom/execute');
    const res = makeRes();
    await route.handlers[1](makeReq({
      body: {
        action: 'noe.freedom.shell.execute',
        realExecute: true,
        args: { command: 'printf should-not-run' },
        authorization: {
          sessionId: 'freedom-session-missing',
          mode: 'developer_unrestricted',
          ownerPresent: true,
        },
      },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.payload).toEqual({
      ok: false,
      blockers: ['freedom_session_not_found'],
      authorization: { sessionId: 'freedom-session-missing' },
    });
  });

  // ── B1.3 接线：生产路由注入 getAdapter 后，高风险 real-execute 的强制复核闸真正生效 ──
  it('wires the local review brain so a high-risk real-execute is blocked when the review brain says block', async () => {
    // fake 本地复核脑（lmstudio）判 block——验证接线后 review gate 真能阻断高风险动作（而非历史的 skip 放行）。
    const getAdapter = (id) => (id === 'lmstudio'
      ? { async chat() { return { reply: JSON.stringify({ verdict: 'block', blockers: ['missing_rollback_plan'] }) }; } }
      : null);
    const routes = register({ getAdapter });
    const route = routes.find((item) => item.path === '/api/noe/freedom/execute');
    const res = makeRes();
    await route.handlers[1](makeReq({
      body: {
        action: 'noe.freedom.shell.execute',
        realExecute: true,
        args: { command: 'printf should-be-reviewed' },
        authorization: { mode: 'developer_unrestricted' },
      },
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.payload.ok).toBe(false);
    expect(res.payload.blockers).toContain('review_brain_blocked');
  });

  it('fail-open degrades to allow when the wired review brain is unavailable (owner freedom constitution)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-route-review-degraded-'));
    try {
      // getAdapter 已注入但本地复核脑全不可用（返回 null）——默认 fail-open 降级，不锁死 real-execute。
      const routes = register({ root, getAdapter: () => null });
      const route = routes.find((item) => item.path === '/api/noe/freedom/execute');
      const res = makeRes();
      await route.handlers[1](makeReq({
        body: {
          action: 'noe.freedom.shell.execute',
          realExecute: true,
          args: { command: 'printf route-review-degraded-ok' },
          authorization: { mode: 'developer_unrestricted' },
        },
      }), res);

      expect(res.statusCode).toBe(200);
      expect(res.payload.ok).toBe(true);
      expect(res.payload.runtime.stdout).toBe('route-review-degraded-ok');
      // 降级放行须留审计标记：verdict 为降级 approve，risks 显式标 review_brain_unavailable。
      expect(res.payload.reviewBrainPreflight?.verdict).toMatchObject({ verdict: 'approve' });
      expect(res.payload.reviewBrainPreflight?.verdict?.risks).toContain('review_brain_unavailable_degraded_open');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
