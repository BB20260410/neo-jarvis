import { describe, it, expect, vi } from 'vitest';
import { createBrainChat } from '../../src/room/brainChat.js';

function makeAdapter(reply = 'hi', { shouldThrow = false, errorMessage = 'boom' } = {}) {
  return {
    chat: vi.fn(async () => {
      if (shouldThrow) {
        throw new Error(errorMessage);
      }
      return { reply };
    }),
  };
}

describe('createBrainChat', () => {
  it('exports a factory function', () => {
    expect(typeof createBrainChat).toBe('function');
  });

  it('returns an async chat function', () => {
    const chat = createBrainChat({});
    expect(typeof chat).toBe('function');
  });

  it('uses default lmstudio adapter when no brainRouter is provided', async () => {
    const adapter = makeAdapter('hello');
    const getAdapter = vi.fn(() => adapter);
    const chat = createBrainChat({ getAdapter });
    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'hello' });
    expect(getAdapter).toHaveBeenCalledWith('lmstudio');
  });

  it('passes messages and merges opts with budgetContext({ taskId }) to adapter.chat', async () => {
    const adapter = makeAdapter('reply');
    const chat = createBrainChat({
      getAdapter: () => adapter,
      taskId: 'test-task',
    });
    const messages = [{ role: 'user', content: 'hello' }];
    const opts = { temperature: 0.5, model: 'x' };
    await chat(messages, opts);
    expect(adapter.chat).toHaveBeenCalledWith(messages, {
      temperature: 0.5,
      model: 'x',
      budgetContext: { taskId: 'test-task' },
    });
  });

  it('uses brainRouter decision for adapterId and fallbacks', async () => {
    const a1 = makeAdapter('first');
    const a2 = makeAdapter('second');
    const getAdapter = vi.fn((id) => (id === 'a1' ? a1 : id === 'a2' ? a2 : null));
    const brainRouter = { route: () => ({ adapterId: 'a1', fallbacks: ['a2'] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });
    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'first' });
    expect(a1.chat).toHaveBeenCalledTimes(1);
    expect(a2.chat).not.toHaveBeenCalled();
  });

  it('falls through to the next adapter when the current one throws', async () => {
    const a1 = makeAdapter('', { shouldThrow: true, errorMessage: 'a1 down' });
    const a2 = makeAdapter('from a2');
    const getAdapter = vi.fn((id) => (id === 'a1' ? a1 : id === 'a2' ? a2 : null));
    const brainRouter = { route: () => ({ adapterId: 'a1', fallbacks: ['a2'] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });
    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'from a2' });
    expect(a1.chat).toHaveBeenCalledTimes(1);
    expect(a2.chat).toHaveBeenCalledTimes(1);
  });

  it('appends lmstudio as the final fallback when prior adapters fail', async () => {
    const lmstudio = makeAdapter('from lmstudio');
    const a1 = makeAdapter('', { shouldThrow: true });
    const getAdapter = vi.fn((id) => (id === 'a1' ? a1 : id === 'lmstudio' ? lmstudio : null));
    const brainRouter = { route: () => ({ adapterId: 'a1', fallbacks: [] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });
    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'from lmstudio' });
    expect(getAdapter).toHaveBeenCalledWith('a1');
    expect(getAdapter).toHaveBeenCalledWith('lmstudio');
  });

  it('deduplicates adapter IDs in the chain', async () => {
    const lmstudio = makeAdapter('ok');
    const getAdapter = vi.fn((id) => (id === 'lmstudio' ? lmstudio : null));
    const brainRouter = { route: () => ({ adapterId: 'lmstudio', fallbacks: ['lmstudio', 'lmstudio'] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });
    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'ok' });
    expect(lmstudio.chat).toHaveBeenCalledTimes(1);
  });

  it('skips adapters that are null or lack a chat function', async () => {
    const good = makeAdapter('found');
    const getAdapter = vi.fn((id) => {
      if (id === 'missing') return null;
      if (id === 'nochat') return { foo: 1 };
      if (id === 'lmstudio') return good;
      return null;
    });
    const brainRouter = { route: () => ({ adapterId: 'missing', fallbacks: ['nochat'] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });
    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'found' });
  });

  it('continues to the next adapter when reply is falsy', async () => {
    const a1 = makeAdapter(null);
    const a2 = makeAdapter('second');
    const getAdapter = vi.fn((id) => (id === 'a1' ? a1 : id === 'a2' ? a2 : null));
    const brainRouter = { route: () => ({ adapterId: 'a1', fallbacks: ['a2'] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });
    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'second' });
    expect(a1.chat).toHaveBeenCalledTimes(1);
    expect(a2.chat).toHaveBeenCalledTimes(1);
  });

  it('throws an error containing taskId and last error message when all adapters fail', async () => {
    const a1 = makeAdapter('', { shouldThrow: true, errorMessage: 'a1 down' });
    const lmstudio = makeAdapter('', { shouldThrow: true, errorMessage: 'lmstudio down' });
    const getAdapter = (id) => (id === 'lmstudio' ? lmstudio : a1);
    const brainRouter = { route: () => ({ adapterId: 'a1', fallbacks: [] }) };
    const chat = createBrainChat({ getAdapter, brainRouter, taskId: 'my-task' });
    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /^大脑不可用\(my-task\): lmstudio down$/,
    );
  });

  it('falls back to the chain joined by → when no error was captured', async () => {
    const getAdapter = () => null;
    const brainRouter = { route: () => ({ adapterId: 'x', fallbacks: ['y'] }) };
    const chat = createBrainChat({ getAdapter, brainRouter, taskId: 't2' });
    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /大脑不可用\(t2\): x→y→lmstudio/,
    );
  });

  it('tolerates non-array fallbacks from brainRouter', async () => {
    const lmstudio = makeAdapter('ok');
    const getAdapter = (id) => (id === 'lmstudio' ? lmstudio : null);
    const brainRouter = { route: () => ({ adapterId: 'weird', fallbacks: 'not-an-array' }) };
    const chat = createBrainChat({ getAdapter, brainRouter });
    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'ok' });
  });

  it('handles an empty messages array (text becomes empty string) and uses default taskId', async () => {
    const adapter = makeAdapter('hi');
    const getAdapter = vi.fn(() => adapter);
    const chat = createBrainChat({ getAdapter });
    const result = await chat([]);
    expect(result).toEqual({ reply: 'hi' });
    expect(adapter.chat).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ budgetContext: { taskId: 'noe-internal' } }),
    );
  });

  it('throws when no getAdapter is provided and no adapter resolves', async () => {
    const chat = createBrainChat({});
    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(
      /^大脑不可用\(noe-internal\): lmstudio$/,
    );
  });

  it('routes based on the last message text content', async () => {
    const adapter = makeAdapter('ok');
    const getAdapter = () => adapter;
    const routeSpy = vi.fn(() => ({ adapterId: 'lmstudio', fallbacks: [] }));
    const brainRouter = { route: routeSpy };
    const chat = createBrainChat({ getAdapter, brainRouter });
    await chat([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'the actual question' },
    ]);
    expect(routeSpy).toHaveBeenCalledWith({ text: 'the actual question' });
  });
});
