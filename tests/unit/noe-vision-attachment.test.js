import { describe, it, expect, vi } from 'vitest';
import { registerNoeVisionAttachmentRoute } from '../../src/server/routes/noeVisionAttachment.js';

function makeApp() {
  const handlers = {};
  const app = {
    post: (path, ...mw) => {
      handlers[path] = mw;
    },
  };
  return { app, handlers };
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  return res;
}

function getHandler(handlers) {
  return handlers['/api/noe/vision/attachment'][1];
}

describe('registerNoeVisionAttachmentRoute', () => {
  it('returns 501 when visionSession.describeAttachment is missing', async () => {
    const { app, handlers } = makeApp();
    registerNoeVisionAttachmentRoute(app, {});
    const handler = getHandler(handlers);
    const req = { body: { frame: 'abc' } };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(501);
    expect(res.body).toEqual({ ok: false, error: 'vision attachment not configured' });
  });

  it('returns 400 when frame is missing or not a string', async () => {
    const describeAttachment = vi.fn();
    const { app, handlers } = makeApp();
    registerNoeVisionAttachmentRoute(app, { visionSession: { describeAttachment } });
    const handler = getHandler(handlers);

    const req1 = { body: {} };
    const res1 = makeRes();
    await handler(req1, res1);
    expect(res1.statusCode).toBe(400);
    expect(res1.body).toEqual({ ok: false, error: 'missing frame' });

    const req2 = { body: { frame: 123 } };
    const res2 = makeRes();
    await handler(req2, res2);
    expect(res2.statusCode).toBe(400);
  });

  it('returns 413 when frame is too large', async () => {
    const describeAttachment = vi.fn();
    const { app, handlers } = makeApp();
    registerNoeVisionAttachmentRoute(app, { visionSession: { describeAttachment } });
    const handler = getHandler(handlers);

    const req = { body: { frame: 'a'.repeat(3_000_001) } };
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(413);
    expect(res.body).toEqual({ ok: false, error: 'frame too large' });
    expect(describeAttachment).not.toHaveBeenCalled();
  });

  it('returns ok with result and normalizes options on success', async () => {
    const result = { description: 'a cat' };
    const describeAttachment = vi.fn().mockResolvedValue(result);
    const { app, handlers } = makeApp();
    registerNoeVisionAttachmentRoute(app, { visionSession: { describeAttachment } });
    const handler = getHandler(handlers);

    const frameB64 = Buffer.from('hello').toString('base64');
    const req = {
      body: {
        frame: frameB64,
        format: 'gif',
        name: 'n'.repeat(300),
        type: 't'.repeat(200),
        prompt: 'p'.repeat(800),
      },
    };
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, description: 'a cat' });
    expect(describeAttachment).toHaveBeenCalledTimes(1);
    const [buf, opts] = describeAttachment.mock.calls[0];
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('hello');
    expect(opts).toEqual({
      format: 'jpeg',
      name: 'n'.repeat(200),
      type: 't'.repeat(120),
      prompt: 'p'.repeat(600),
    });
  });

  it('keeps format as png when body.format is png', async () => {
    const describeAttachment = vi.fn().mockResolvedValue({ description: 'ok' });
    const { app, handlers } = makeApp();
    registerNoeVisionAttachmentRoute(app, { visionSession: { describeAttachment } });
    const handler = getHandler(handlers);

    const req = { body: { frame: Buffer.from('x').toString('base64'), format: 'png' } };
    const res = makeRes();
    await handler(req, res);
    const [, opts] = describeAttachment.mock.calls[0];
    expect(opts.format).toBe('png');
  });

  it('uses sendError when handler throws', async () => {
    const err = new Error('boom');
    const describeAttachment = vi.fn().mockRejectedValue(err);
    const sendError = vi.fn((res, e) => res.status(500).json({ ok: false, error: e.message }));
    const { app, handlers } = makeApp();
    registerNoeVisionAttachmentRoute(app, { visionSession: { describeAttachment }, sendError });
    const handler = getHandler(handlers);

    const req = { body: { frame: Buffer.from('x').toString('base64') } };
    const res = makeRes();
    await handler(req, res);

    expect(sendError).toHaveBeenCalledWith(res, err);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'boom' });
  });

  it('returns 500 when handler throws and no sendError is provided', async () => {
    const err = new Error('kaboom');
    const describeAttachment = vi.fn().mockRejectedValue(err);
    const { app, handlers } = makeApp();
    registerNoeVisionAttachmentRoute(app, { visionSession: { describeAttachment } });
    const handler = getHandler(handlers);

    const req = { body: { frame: Buffer.from('x').toString('base64') } };
    const res = makeRes();
    await handler(req, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ ok: false, error: 'kaboom' });
  });

  it('treats missing req.body as empty object', async () => {
    const { app, handlers } = makeApp();
    registerNoeVisionAttachmentRoute(app, {});
    const handler = getHandler(handlers);
    const req = {};
    const res = makeRes();
    await handler(req, res);
    expect(res.statusCode).toBe(501);
  });

  it('passes prompt as undefined when prompt is not a string', async () => {
    const describeAttachment = vi.fn().mockResolvedValue({});
    const { app, handlers } = makeApp();
    registerNoeVisionAttachmentRoute(app, { visionSession: { describeAttachment } });
    const handler = getHandler(handlers);

    const req = { body: { frame: Buffer.from('x').toString('base64'), prompt: 12345 } };
    const res = makeRes();
    await handler(req, res);
    const [, opts] = describeAttachment.mock.calls[0];
    expect(opts.prompt).toBeUndefined();
  });
});
