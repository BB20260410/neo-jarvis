// @ts-check
import { describe, expect, it } from 'vitest';
import {
  createErrorEnvelope,
  fromThrown,
  isErrorEnvelope,
  toPublicError,
} from '../../src/runtime/NoeErrorEnvelope.js';

describe('NoeErrorEnvelope', () => {
  it('creates a valid envelope', () => {
    const env = createErrorEnvelope({
      code: 'task_not_found',
      message: 'Task missing',
      category: 'not_found',
      retryable: false,
      details: { taskId: 't1' },
    });
    expect(isErrorEnvelope(env)).toBe(true);
    expect(env.kind).toBe('neo.error.envelope.v1');
    expect(env.details?.taskId).toBe('t1');
  });

  it('rejects empty code/message', () => {
    expect(() => createErrorEnvelope({ code: '', message: 'x' })).toThrow(/code/);
    expect(() => createErrorEnvelope({ code: 'c', message: '' })).toThrow(/message/);
  });

  it('strips secret-like detail keys for public projection', () => {
    const env = createErrorEnvelope({
      code: 'auth_failed',
      message: 'Auth failed',
      category: 'auth',
      details: { userId: 'u1', api_key: 'SECRET', token: 'nope' },
      cause: new Error('inner'),
    });
    const pub = toPublicError(env);
    expect(pub.details?.userId).toBe('u1');
    expect(pub.details?.api_key).toBeUndefined();
    expect(pub.details?.token).toBeUndefined();
    expect('cause' in pub).toBe(false);
  });

  it('fromThrown preserves Error cause', () => {
    const err = new Error('boom');
    const env = fromThrown(err, { code: 'boundary_wrap' });
    expect(env.code).toBe('boundary_wrap');
    expect(env.cause).toBe(err);
    expect(isErrorEnvelope(env)).toBe(true);
  });

  it('fromThrown accepts existing envelope', () => {
    const env = createErrorEnvelope({ code: 'a', message: 'b' });
    expect(fromThrown(env)).toBe(env);
  });
});
