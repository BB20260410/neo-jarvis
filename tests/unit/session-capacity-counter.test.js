import { describe, expect, it } from 'vitest';
import { createSessionCapacityCounter } from '../../src/server/services/session-capacity-counter.js';

function res() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; },
  };
}

describe('session capacity counter', () => {
  it('tracks active sessions incrementally and enforces active limit without scanning on check', () => {
    const sessions = new Map([
      ['a', { id: 'a', archived: false }],
      ['b', { id: 'b', archived: true }],
    ]);
    const counter = createSessionCapacityCounter({ sessions });
    expect(counter.rebuild()).toBe(1);
    const c = { id: 'c', archived: false };
    sessions.set(c.id, c);
    counter.onSessionCreated(c);
    expect(counter.activeCount()).toBe(2);
    counter.onSessionArchivedChange(c, true, false);
    c.archived = true;
    expect(counter.activeCount()).toBe(1);
    counter.onSessionArchivedChange(c, false, true);
    c.archived = false;
    expect(counter.activeCount()).toBe(2);
    counter.onSessionDeleted(c);
    sessions.delete(c.id);
    expect(counter.activeCount()).toBe(1);
    const out = res();
    expect(counter.check({ res: out, maxSessions: 10, maxActiveSessions: 1 })).toBe(false);
    expect(out.statusCode).toBe(429);
    expect(out.payload.error).toContain('活跃 session 上限');
  });
});
