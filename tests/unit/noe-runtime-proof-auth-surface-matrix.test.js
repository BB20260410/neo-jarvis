import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAuthSurfaceMatrix,
  extractProtectedGetRoutes,
  parseArgs,
  statusKind,
} from '../../scripts/noe-runtime-proof-auth-surface-matrix.mjs';

describe('noe-runtime-proof-auth-surface-matrix', () => {
  let dir;

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  function writeJson(path, value) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, `${JSON.stringify(value, null, 2)}\n`);
    return abs;
  }

  it('extracts only static protected GET routes', () => {
    const routes = extractProtectedGetRoutes(`
      app.get('/api/agent-runs', requireOwnerToken, (req, res) => {});
      app.get('/api/agent-runs/:id', requireOwnerToken, (req, res) => {});
      app.get('/api/public', (_req, res) => {});
      app.post('/api/agent-runs', requireOwnerToken, (req, res) => {});
      router.get("/api/activity", requireOwnerToken, handler);
    `);
    expect(routes).toEqual(['/api/activity', '/api/agent-runs']);
  });

  it('builds a static matrix from backlog, inventory, and route files', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-auth-surface-matrix-'));
    mkdirSync(join(dir, 'src/server/routes'), { recursive: true });
    writeFileSync(join(dir, 'src/server/routes/agentRuns.js'), `
      import { requireOwnerToken } from '../auth/owner-token.js';
      app.get('/api/agent-runs', requireOwnerToken, (req, res) => res.json({ok:true}));
      app.get('/api/agent-runs/:id', requireOwnerToken, (req, res) => res.json({ok:true}));
    `);
    writeFileSync(join(dir, 'src/server/routes/activity.js'), `
      import { requireOwnerToken } from '../auth/owner-token.js';
      app.get('/api/activity', requireOwnerToken, (req, res) => res.json({ok:true}));
    `);
    const backlogPath = writeJson('backlog.json', {
      ok: true,
      generatedAt: '2026-06-15T00:00:00.000Z',
      root: dir,
      files: [
        { file: 'src/agents/AgentRunStore.js', priority: 'P0', module: 'agents', usefulness: 'AGI-critical', recommendedProofStrategy: 'agent_runtime_usage_probe' },
        { file: 'src/audit/ActivityLog.js', priority: 'P0', module: 'audit', usefulness: 'AGI-critical', recommendedProofStrategy: 'safety_gate_runtime_probe' },
        { file: 'src/security/NoePolicyFileGuard.js', priority: 'P0', module: 'security', usefulness: 'AGI-critical', recommendedProofStrategy: 'safety_gate_runtime_probe' },
      ],
    });
    const inventoryPath = writeJson('inventory.json', {
      ok: true,
      generatedAt: '2026-06-15T00:00:00.000Z',
      root: dir,
      files: [
        { file: 'src/agents/AgentRunStore.js', sourceImporters: ['src/server/routes/agentRuns.js'], tests: ['t'], testImporters: [] },
        { file: 'src/audit/ActivityLog.js', sourceImporters: ['src/server/routes/activity.js'], tests: [], testImporters: [] },
        { file: 'src/security/NoePolicyFileGuard.js', sourceImporters: ['src/runtime/NoeBootSelfCheck.js'], tests: [], testImporters: [] },
      ],
    });

    const report = await buildAuthSurfaceMatrix({ root: dir, backlogPath, inventoryPath });
    const byFile = new Map(report.files.map((file) => [file.file, file]));

    expect(report.summary.backlogFiles).toBe(3);
    expect(report.summary.routeImporterFiles).toBe(2);
    expect(report.summary.protectedGetCandidateFiles).toBe(2);
    expect(report.summary.uniqueProtectedGetPaths).toBe(2);
    expect(byFile.get('src/agents/AgentRunStore.js').protectedGetCandidatePaths).toEqual(['/api/agent-runs']);
    expect(byFile.get('src/security/NoePolicyFileGuard.js').surface).toBe('no_route_importer');
  });

  it('optionally probes local protected GETs without sending auth or storing bodies', async () => {
    dir = mkdtempSync(join(tmpdir(), 'noe-auth-surface-live-'));
    mkdirSync(join(dir, 'src/server/routes'), { recursive: true });
    writeFileSync(join(dir, 'src/server/routes/agentRuns.js'), `
      import { requireOwnerToken } from '../auth/owner-token.js';
      app.get('/api/agent-runs', requireOwnerToken, (req, res) => res.json({secret:'no'}));
    `);
    const backlogPath = writeJson('backlog.json', {
      ok: true,
      root: dir,
      files: [{ file: 'src/agents/AgentRunStore.js', priority: 'P0', module: 'agents', recommendedProofStrategy: 'agent_runtime_usage_probe' }],
    });
    const inventoryPath = writeJson('inventory.json', {
      ok: true,
      root: dir,
      files: [{ file: 'src/agents/AgentRunStore.js', sourceImporters: ['src/server/routes/agentRuns.js'], tests: [], testImporters: [] }],
    });
    const requests = [];
    const report = await buildAuthSurfaceMatrix({
      root: dir,
      backlogPath,
      inventoryPath,
      probeLive: true,
      baseUrl: 'http://127.0.0.1:51835',
      fetchFn: async (url, options) => {
        requests.push({ url: String(url), options });
        return { status: 401, text: async () => 'secret response' };
      },
    });

    expect(requests).toHaveLength(1);
    expect(requests[0].options.method).toBe('GET');
    expect(requests[0].options.headers.Authorization).toBeUndefined();
    expect(report.summary.liveAuthSurfaceFiles).toBe(1);
    expect(report.liveProbes[0]).toMatchObject({ path: '/api/agent-runs', status: 401, statusKind: 'route_live_auth_protected' });
    expect(JSON.stringify(report)).not.toContain('secret response');
  });

  it('keeps argument and status handling conservative', () => {
    expect(parseArgs(['--probe-live', '--timeout-ms=250']).probeLive).toBe(true);
    expect(statusKind(401)).toBe('route_live_auth_protected');
    expect(statusKind(404)).toBe('route_not_registered_or_wrong_path');
    expect(statusKind(null)).toBe('not_probed');
  });
});
