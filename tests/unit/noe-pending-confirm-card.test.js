// @ts-check
import { describe, expect, it } from 'vitest';
import express from 'express';
import {
  buildConfirmCard,
  buildConfirmCardQueue,
  pendingCountFromQueue,
  applyConfirmDecision,
  classifyPendingRiskKind,
  resolveActActionType,
  listPendingActsForConfirm,
  buildPendingConfirmsFromStores,
  isPendingConfirmStatus,
} from '../../src/runtime/NoePendingConfirmCard.js';
import { registerNoeProductSettingsRoutes } from '../../src/server/routes/noeProductSettings.js';

describe('NoePendingConfirmCard', () => {
  it('classifies file and shell risk kinds', () => {
    expect(classifyPendingRiskKind('fs_delete')).toBe('file');
    expect(classifyPendingRiskKind('shell_write')).toBe('shell');
    expect(classifyPendingRiskKind('shell_exec')).toBe('shell');
    expect(classifyPendingRiskKind('dangerous_command')).toBe('shell');
  });

  it('maps real ActStore row shape: action + awaiting_approval + payload', () => {
    // Production rowToAct shape (see ActStore.js) — field is `action`, status awaiting_approval
    const actFile = {
      id: 'act-fs-1',
      projectId: 'noe',
      title: '删除演示文件',
      action: 'fs_delete',
      riskLevel: 'high',
      status: 'awaiting_approval',
      payload: { path: '/tmp/demo.txt' },
    };
    const actShell = {
      id: 'act-sh-1',
      projectId: 'noe',
      title: '危险 shell',
      action: 'shell_write',
      riskLevel: 'critical',
      status: 'awaiting_approval',
      payload: { command: 'rm -rf /tmp/x' },
    };
    const actDone = {
      id: 'act-done',
      action: 'shell_write',
      status: 'completed',
      payload: { command: 'echo done' },
    };

    expect(resolveActActionType(actFile)).toBe('fs_delete');
    expect(resolveActActionType(actShell)).toBe('shell_write');

    const fileCard = buildConfirmCard(actFile, 'act');
    expect(fileCard.pending).toBe(true);
    expect(fileCard.riskKind).toBe('file');
    expect(fileCard.riskLabel).toMatch(/文件/);
    expect(fileCard.path).toBe('/tmp/demo.txt');
    expect(fileCard.actionType).toBe('fs_delete');
    expect(fileCard.status).toBe('awaiting_approval');

    const shellCard = buildConfirmCard(actShell, 'act');
    expect(shellCard.riskKind).toBe('shell');
    expect(shellCard.command).toContain('rm -rf');
    expect(shellCard.gate.highRisk).toBe(true);

    const q = buildConfirmCardQueue({
      acts: [actFile, actShell, actDone],
      approvals: [],
    });
    expect(q.pendingCount).toBe(2);
    expect(q.cards).toHaveLength(2);
    expect(pendingCountFromQueue([actFile, actShell, actDone])).toBe(2);
  });

  it('maps ApprovalStore dangerous_command shape', () => {
    const approval = {
      id: 'ap-1',
      type: 'dangerous_command',
      status: 'pending',
      payload: { command: 'sudo reboot', cwd: '/tmp' },
    };
    const card = buildConfirmCard(approval, 'approval');
    expect(card.pending).toBe(true);
    expect(card.riskKind).toBe('shell');
    expect(card.command).toContain('sudo reboot');
    expect(card.actionType).toBe('dangerous_command');
  });

  it('deny leaves action not executed; allow does not mark executed', () => {
    const card = buildConfirmCard({
      id: 'x',
      status: 'awaiting_approval',
      action: 'shell_write',
      payload: { command: 'echo hi' },
    });
    const denied = applyConfirmDecision(card, 'deny');
    expect(denied.status).toBe('denied');
    expect(denied.executed).toBe(false);
    expect(denied.pending).toBe(false);

    const allowed = applyConfirmDecision(card, 'allow');
    expect(allowed.executed).toBe(false);
    expect(allowed.ownerConfirmed).toBe(true);
    expect(allowed.status).toBe('approved');
  });

  it('listPendingActsForConfirm never calls status pending; uses awaiting_approval', () => {
    /** @type {string[]} */
    const seenStatuses = [];
    const actStore = {
      list({ status }) {
        seenStatuses.push(String(status));
        if (status === 'pending') {
          throw new Error('invalid act status: pending');
        }
        if (status === 'awaiting_approval') {
          return [{
            id: 'a1',
            action: 'fs_write',
            status: 'awaiting_approval',
            payload: { path: '/tmp/a' },
          }];
        }
        return [];
      },
    };
    const rows = listPendingActsForConfirm(actStore, { projectId: 'noe', limit: 20 });
    expect(seenStatuses).not.toContain('pending');
    expect(seenStatuses).toContain('awaiting_approval');
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('fs_write');
  });

  it('listPendingActsForConfirm swallows list throws so queue can continue', () => {
    const actStore = {
      list() {
        throw new Error('invalid act status: pending');
      },
    };
    expect(listPendingActsForConfirm(actStore)).toEqual([]);
  });

  it('buildPendingConfirmsFromStores: act list throw still returns approvals', () => {
    const actStore = {
      list({ status }) {
        if (status === 'pending' || status === 'awaiting_approval') {
          // Simulate buggy or strict store that rejects; helper must not 500 the route path
          if (status === 'pending') throw new Error('invalid act status: pending');
          return [{
            id: 'act-ok',
            action: 'shell_write',
            status: 'awaiting_approval',
            payload: { command: 'ls' },
          }];
        }
        return [];
      },
    };
    const approvalStore = {
      listApprovals({ status }) {
        expect(status).toBe('pending');
        return [{
          id: 'ap-ok',
          type: 'dangerous_command',
          status: 'pending',
          payload: { command: 'echo risk' },
        }];
      },
    };
    const payload = buildPendingConfirmsFromStores({ actStore, approvalStore, projectId: 'noe' });
    expect(payload.ok).toBe(true);
    expect(payload.pendingCount).toBeGreaterThanOrEqual(2);
    expect(payload.cards.some((c) => c.riskKind === 'shell')).toBe(true);
    expect(payload.cards.some((c) => c.id === 'ap-ok')).toBe(true);
    expect(payload.cards.some((c) => c.id === 'act-ok')).toBe(true);
  });

  it('buildPendingConfirmsFromStores: when actStore.list always throws, approvals still returned', () => {
    const actStore = {
      list() {
        throw new Error('invalid act status: pending');
      },
    };
    const approvalStore = {
      listApprovals() {
        return [{
          id: 'ap-only',
          type: 'dangerous_command',
          status: 'pending',
          payload: { command: 'id' },
        }];
      },
    };
    const payload = buildPendingConfirmsFromStores({ actStore, approvalStore });
    expect(payload.ok).toBe(true);
    expect(payload.approvalsListed).toBe(1);
    expect(payload.actsListed).toBe(0);
    expect(payload.cards).toHaveLength(1);
    expect(payload.cards[0].id).toBe('ap-only');
  });

  it('route GET /api/noe/pending-confirms returns 200 with real ActStore shapes (no pending status)', async () => {
    const app = express();
    app.use(express.json());
    /** @type {string[]} */
    const listStatuses = [];
    const actStore = {
      list({ status }) {
        listStatuses.push(String(status));
        if (status === 'pending') throw new Error('invalid act status: pending');
        if (status === 'awaiting_approval') {
          return [{
            id: 'act-route',
            action: 'fs_delete',
            status: 'awaiting_approval',
            title: 'delete file',
            payload: { path: '/tmp/route.txt' },
          }];
        }
        return [];
      },
    };
    const approvalStore = {
      listApprovals() {
        return [{
          id: 'ap-route',
          type: 'dangerous_command',
          status: 'pending',
          payload: { command: 'whoami' },
        }];
      },
    };

    // Drive the exact helper the route ships
    const body = buildPendingConfirmsFromStores({ actStore, approvalStore, projectId: 'noe' });
    expect(body.ok).toBe(true);
    expect(body.cards.some((c) => c.riskKind === 'file' && c.path === '/tmp/route.txt')).toBe(true);
    expect(body.cards.some((c) => c.id === 'ap-route')).toBe(true);
    expect(listStatuses).not.toContain('pending');

    registerNoeProductSettingsRoutes(app, {
      actStore,
      approvalStore,
      sendError: (res, e) => res.status(500).json({ ok: false, error: e?.message || String(e) }),
    });

    const { getOrCreateOwnerToken } = await import('../../src/server/auth/owner-token.js');
    const token = getOrCreateOwnerToken();
    expect(token && token.length >= 32).toBe(true);

    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const { port } = server.address();
      const r = await fetch(`http://127.0.0.1:${port}/api/noe/pending-confirms`, {
        headers: { 'X-Panel-Owner-Token': token },
      });
      expect(r.status).not.toBe(500);
      expect(r.status).toBe(200);
      const j = await r.json();
      expect(j.ok).toBe(true);
      expect(j.cards?.length).toBeGreaterThanOrEqual(2);
      expect(j.cards.some((c) => c.riskKind === 'file' && c.path === '/tmp/route.txt')).toBe(true);
      expect(j.cards.some((c) => c.id === 'ap-route' && c.riskKind === 'shell')).toBe(true);
      // Route must never have asked ActStore for invalid "pending"
      expect(listStatuses).not.toContain('pending');
      expect(listStatuses).toContain('awaiting_approval');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('isPendingConfirmStatus distinguishes act vs approval', () => {
    expect(isPendingConfirmStatus('awaiting_approval', 'act')).toBe(true);
    expect(isPendingConfirmStatus('pending', 'act')).toBe(true); // fixture tolerance
    expect(isPendingConfirmStatus('completed', 'act')).toBe(false);
    expect(isPendingConfirmStatus('pending', 'approval')).toBe(true);
    expect(isPendingConfirmStatus('approved', 'approval')).toBe(false);
  });
});
