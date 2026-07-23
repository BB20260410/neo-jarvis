import { describe, expect, it, vi } from 'vitest';
import {
  appendRoomRequirementInjection,
  registerRoomRequirementsRoutes,
} from '../../../src/server/routes/roomRequirements.js';

function makeApp() {
  const routes = [];
  return {
    routes,
    post(path, ...handlers) {
      routes.push({ method: 'post', path, handlers });
    },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

describe('room requirement injection routes', () => {
  it('appends a mid-run requirement to room and unfinished tasks', () => {
    const room = {
      id: 'r1',
      requirementInjections: [],
      goalMode: { enabled: true, lastReworkDigest: 'old-blocker', repeatedBlockerCount: 3 },
      taskList: [
        { id: 'CE01', status: 'done' },
        { id: 'CE02', status: 'running' },
        { id: 'CE03', status: 'pending', userInjections: [{ id: 'old', content: '旧需求' }] },
      ],
    };

    const result = appendRoomRequirementInjection(room, '新增横屏适配', {
      now: '2026-06-01T00:00:00.000Z',
      id: 'req-1',
    });

    expect(result).toMatchObject({
      ok: true,
      appliedTaskIds: ['CE02', 'CE03'],
      runningTaskIds: ['CE02'],
      skippedDoneTaskIds: ['CE01'],
      reopenedTaskIds: [],
      reopenCompletedRoom: false,
      revision: 1,
      injection: { id: 'req-1', content: '新增横屏适配' },
      auditEvent: {
        type: 'room_requirement_added',
        injectionId: 'req-1',
        revision: 1,
        appliedTaskIds: ['CE02', 'CE03'],
        runningTaskIds: ['CE02'],
        skippedDoneTaskIds: ['CE01'],
        reopenedTaskIds: [],
        reopenCompletedRoom: false,
        goalModeEnabled: true,
      },
    });
    expect(result.injection.revision).toBe(1);
    expect(room.requirementInjections).toHaveLength(1);
    expect(room.requirementRevision).toBe(1);
    expect(room.latestRequirementInjection).toMatchObject({ id: 'req-1', revision: 1 });
    expect(room.requirementInjectionAuditTrail).toHaveLength(1);
    expect(room.goalMode).toMatchObject({
      enabled: true,
      requirementRevision: 1,
      latestRequirementInjectionId: 'req-1',
      lastReworkDigest: '',
      repeatedBlockerCount: 0,
    });
    expect(room.taskList[0].userInjections).toBeUndefined();
    expect(room.taskList[1].userInjections[0]).toMatchObject({ id: 'req-1' });
    expect(room.taskList[1]).toMatchObject({
      requirementRevision: 1,
      requirementInjectionIds: ['req-1'],
    });
    expect(room.taskList[2].userInjections.map((item) => item.id)).toEqual(['old', 'req-1']);
  });

  it('reopens a blocked room when adding a new requirement', () => {
    const room = {
      id: 'r1',
      status: 'blocked',
      goalMode: { enabled: true, lastReworkDigest: 'repeat', repeatedBlockerCount: 2 },
      taskList: [
        { id: 'CE01', stageId: 'idea', status: 'done' },
        {
          id: 'CE02',
          stageId: 'requirements',
          status: 'escalated',
          blocking: true,
          escalateReason: 'previous deadlock',
          rounds: [{ round: 1 }],
          consensus: { ok: false },
        },
        { id: 'CE03', stageId: 'technical_design', status: 'pending' },
      ],
    };

    const result = appendRoomRequirementInjection(room, '新增移动端横屏兼容，继续完成', {
      now: '2026-06-01T01:00:00.000Z',
      id: 'req-blocked',
    });

    expect(result).toMatchObject({
      ok: true,
      appliedTaskIds: ['CE02', 'CE03'],
      skippedDoneTaskIds: ['CE01'],
      reopenedTaskIds: ['CE02'],
      reopenCompletedRoom: false,
      statusChange: { changed: true, previousStatus: 'blocked', nextStatus: 'paused' },
    });
    expect(room.status).toBe('paused');
    expect(room.taskList[1]).toMatchObject({
      status: 'pending',
      blocking: false,
      requirementRevision: 1,
      qualityGateRepairs: 0,
      requirementReopenHistory: [{ injectionId: 'req-blocked', previousStatus: 'escalated' }],
    });
    expect(room.taskList[1].rounds).toEqual([]);
    expect(room.taskList[1].consensus).toBeUndefined();
    expect(room.taskList[1].escalateReason).toBeUndefined();
    expect(room.goalMode).toMatchObject({
      enabled: true,
      requirementRevision: 1,
      latestRequirementInjectionId: 'req-blocked',
      requirementReopenTaskIds: ['CE02'],
      lastReworkDigest: '',
      repeatedBlockerCount: 0,
    });
    expect(room.requirementReopenState).toMatchObject({
      injectionId: 'req-blocked',
      reopenedTaskIds: ['CE02'],
      reopenCompletedRoom: false,
      previousStatus: 'blocked',
      nextStatus: 'paused',
    });
  });

  it('reopens requirement and downstream stages when a completed room receives a new requirement', () => {
    const room = {
      id: 'r1',
      status: 'completed',
      taskList: [
        { id: 'CE01', stageId: 'idea', status: 'done', rounds: [{ round: 1 }] },
        { id: 'CE02', stageId: 'requirements', status: 'done', rounds: [{ round: 1 }], consensus: { ok: true } },
        { id: 'CE03', stageId: 'technical_design', status: 'done', stageArtifact: { stageId: 'technical_design' } },
        { id: 'CE04', stageId: 'implementation', status: 'done', acceptanceReport: { ok: true } },
      ],
    };

    const result = appendRoomRequirementInjection(room, '新增离线收益封顶和导出存档', {
      now: '2026-06-01T02:00:00.000Z',
      id: 'req-completed',
    });

    expect(result).toMatchObject({
      ok: true,
      appliedTaskIds: ['CE02', 'CE03', 'CE04'],
      skippedDoneTaskIds: ['CE01'],
      reopenedTaskIds: ['CE02', 'CE03', 'CE04'],
      reopenCompletedRoom: true,
      statusChange: { changed: true, previousStatus: 'completed', nextStatus: 'paused' },
    });
    expect(room.status).toBe('paused');
    expect(room.taskList[0]).toMatchObject({ status: 'done' });
    expect(room.taskList.slice(1).map((task) => task.status)).toEqual(['pending', 'pending', 'pending']);
    expect(room.taskList[1].rounds).toEqual([]);
    expect(room.taskList[1].consensus).toBeUndefined();
    expect(room.taskList[2].stageArtifact).toBeUndefined();
    expect(room.taskList[3].acceptanceReport).toBeUndefined();
    expect(room.requirementReopenState).toMatchObject({
      injectionId: 'req-completed',
      reopenedTaskIds: ['CE02', 'CE03', 'CE04'],
      reopenCompletedRoom: true,
      previousStatus: 'completed',
      nextStatus: 'paused',
    });
  });

  it('POST /api/rooms/:id/requirements persists, flushes and broadcasts injection', () => {
    const room = { id: 'r1', status: 'running', taskList: [{ id: 'CE01', status: 'pending' }] };
    const updates = [];
    const broadcasts = [];
    const flush = vi.fn();
    const { routes, ...app } = makeApp();
    registerRoomRequirementsRoutes(app, {
      roomStore: {
        get: () => room,
        update: (id, patch) => updates.push({ id, patch }),
        flush,
      },
      requireOwnerToken: (_req, _res, next) => next(),
      broadcastRoom: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
    });

    const route = routes.find((item) => item.path === '/api/rooms/:id/requirements');
    const res = makeResponse();
    route.handlers[1]({ params: { id: 'r1' }, body: { content: '新增离线收益上限设置' } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({ ok: true, appliedTaskIds: ['CE01'], persisted: true, revision: 1 });
    expect(updates[0]).toMatchObject({
      id: 'r1',
      patch: {
        status: 'running',
        requirementRevision: 1,
        latestRequirementInjection: { revision: 1 },
      },
    });
    expect(flush).toHaveBeenCalledTimes(1);
    expect(broadcasts[0]).toMatchObject({
      roomId: 'r1',
      type: 'room_requirement_added',
      appliedTaskIds: ['CE01'],
      revision: 1,
      auditEvent: { injectionId: expect.any(String), revision: 1 },
    });
  });

  it('returns 500 and avoids broadcast when requirement persistence fails', () => {
    const room = { id: 'r1', status: 'running', taskList: [{ id: 'CE01', status: 'pending' }] };
    const broadcasts = [];
    const updates = [];
    const { routes, ...app } = makeApp();
    registerRoomRequirementsRoutes(app, {
      roomStore: {
        get: () => room,
        update: (id, patch) => updates.push({ id, patch }),
        flush: () => { throw new Error('disk full'); },
      },
      requireOwnerToken: (_req, _res, next) => next(),
      broadcastRoom: (roomId, msg) => broadcasts.push({ roomId, ...msg }),
    });

    const route = routes.find((item) => item.path === '/api/rooms/:id/requirements');
    const res = makeResponse();
    route.handlers[1]({ params: { id: 'r1' }, body: { content: '新增崩溃恢复验收' } }, res);

    expect(res.statusCode).toBe(500);
    expect(res.payload).toMatchObject({
      error: 'requirement persist failed',
      detail: 'disk full',
      revision: 1,
      rolledBack: true,
    });
    expect(broadcasts).toEqual([]);
    expect(room.requirementInjections).toBeUndefined();
    expect(room.requirementRevision).toBeUndefined();
    expect(room.latestRequirementInjection).toBeUndefined();
    expect(room.requirementInjectionAuditTrail).toBeUndefined();
    expect(room.taskList).toEqual([{ id: 'CE01', status: 'pending' }]);
    expect(updates).toHaveLength(2);
    expect(updates[1]).toMatchObject({
      id: 'r1',
      patch: {
        requirementInjections: undefined,
        requirementRevision: undefined,
        latestRequirementInjection: undefined,
      },
    });
  });

  it('rejects empty requirement content', () => {
    const result = appendRoomRequirementInjection({}, '   ');
    expect(result).toMatchObject({ ok: false, error: 'content required' });
  });

  it('keeps route protected by owner token middleware', () => {
    const app = makeApp();
    const requireOwnerToken = vi.fn((_req, _res, next) => next());
    registerRoomRequirementsRoutes(app, {
      roomStore: { get: () => ({ id: 'r1' }), update: () => {} },
      requireOwnerToken,
    });
    expect(app.routes[0].handlers[0]).toBe(requireOwnerToken);
  });
});
