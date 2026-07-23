import { describe, it, expect, vi } from 'vitest';
import { createBrainChat } from '../../src/room/brainChat.js';

const makeAdapter = (impl) => ({ chat: vi.fn(impl) });

describe('createBrainChat', () => {
  it('returns an async function', () => {
    const chat = createBrainChat();
    expect(typeof chat).toBe('function');
  });

  it('uses last message content for routing decision and defaults to empty string', async () => {
    const routeSpy = vi.fn(() => ({ adapterId: 'lmstudio', fallbacks: [] }));
    const lm = makeAdapter(async () => ({ reply: 'r' }));
    const getAdapter = vi.fn((id) => (id === 'lmstudio' ? lm : null));
    const chat = createBrainChat({ getAdapter, brainRouter: { route: routeSpy } });

    await chat([{ role: 'user', content: 'first' }, { role: 'user', content: 'last msg' }]);
    expect(routeSpy).toHaveBeenCalledWith({ text: 'last msg' });

    await chat([]);
    expect(routeSpy).toHaveBeenLastCalledWith({ text: '' });
  });

  it('routes via brainRouter and returns reply from chosen adapter', async () => {
    const primary = makeAdapter(async () => ({ reply: 'hello back' }));
    const getAdapter = vi.fn((id) => (id === 'primary' ? primary : null));
    const brainRouter = { route: vi.fn(() => ({ adapterId: 'primary', fallbacks: [] })) };
    const chat = createBrainChat({ getAdapter, brainRouter });

    const messages = [{ role: 'user', content: 'hi' }];
    const result = await chat(messages);

    expect(result).toEqual({ reply: 'hello back' });
    expect(brainRouter.route).toHaveBeenCalledWith({ text: 'hi' });
    expect(getAdapter).toHaveBeenCalledWith('primary');
    expect(primary.chat).toHaveBeenCalledWith(
      messages,
      expect.objectContaining({ budgetContext: { taskId: 'noe-internal' } })
    );
  });

  it('walks the fallback chain when the primary adapter throws', async () => {
    const primary = makeAdapter(async () => { throw new Error('primary down'); });
    const backup = makeAdapter(async () => ({ reply: 'fallback ok' }));
    const getAdapter = vi.fn((id) => {
      if (id === 'primary') return primary;
      if (id === 'backup') return backup;
      return null;
    });
    const brainRouter = { route: () => ({ adapterId: 'primary', fallbacks: ['backup'] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });

    const result = await chat([{ role: 'user', content: 'test' }]);
    expect(result).toEqual({ reply: 'fallback ok' });
    expect(primary.chat).toHaveBeenCalledTimes(1);
    expect(backup.chat).toHaveBeenCalledTimes(1);
  });

  it('always appends lmstudio as the final fallback', async () => {
    const primary = makeAdapter(async () => { throw new Error('nope'); });
    const lm = makeAdapter(async () => ({ reply: 'lmstudio rescue' }));
    const getAdapter = vi.fn((id) => {
      if (id === 'primary') return primary;
      if (id === 'lmstudio') return lm;
      return null;
    });
    const brainRouter = { route: () => ({ adapterId: 'primary', fallbacks: [] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });

    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'lmstudio rescue' });
    expect(lm.chat).toHaveBeenCalledTimes(1);
  });

  it('skips missing adapters and adapters without a chat function', async () => {
    const good = makeAdapter(async () => ({ reply: 'works' }));
    const getAdapter = vi.fn((id) => {
      if (id === 'primary') return null;          // missing
      if (id === 'backup') return { notChat: 1 }; // no chat()
      if (id === 'lmstudio') return good;
      return null;
    });
    const brainRouter = { route: () => ({ adapterId: 'primary', fallbacks: ['backup'] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });

    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'works' });
    expect(getAdapter).toHaveBeenCalledWith('primary');
    expect(getAdapter).toHaveBeenCalledWith('backup');
    expect(getAdapter).toHaveBeenCalledWith('lmstudio');
  });

  it('throws with taskId and last error message when all adapters fail', async () => {
    const a1 = makeAdapter(async () => { throw new Error('a1 down'); });
    const a2 = makeAdapter(async () => { throw new Error('a2 down'); });
    const getAdapter = vi.fn((id) => {
      if (id === 'primary') return a1;
      if (id === 'backup') return a2;
      return null;
    });
    const brainRouter = { route: () => ({ adapterId: 'primary', fallbacks: ['backup'] }) };
    const chat = createBrainChat({ getAdapter, brainRouter, taskId: 'skillExtract' });

    await expect(chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/skillExtract/);
    await expect(chat([{ role: 'user', content: 'x' }])).rejects.toThrow(/a2 down/);
  });

  it('throws listing the chain when no adapter was reachable (no getAdapter provided)', async () => {
    const chat = createBrainChat({ taskId: 'noe-internal' });
    await expect(chat([{ role: 'user', content: 'hi' }])).rejects.toThrow(/noe-internal/);
  });

  it('tolerates a non-array fallbacks field and still uses lmstudio default', async () => {
    const lm = makeAdapter(async () => ({ reply: 'ok' }));
    const getAdapter = vi.fn((id) => (id === 'lmstudio' ? lm : null));
    const brainRouter = { route: () => ({ adapterId: 'primary', fallbacks: 'not-an-array' }) };
    const chat = createBrainChat({ getAdapter, brainRouter });

    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'ok' });
  });

  it('merges caller opts and injects budgetContext.taskId', async () => {
    const adapter = makeAdapter(async () => ({ reply: 'r' }));
    const getAdapter = vi.fn(() => adapter);
    const chat = createBrainChat({ getAdapter, taskId: 'research' });

    await chat([{ role: 'user', content: 'q' }], { temperature: 0.7, foo: 'bar' });
    expect(adapter.chat).toHaveBeenCalledWith(
      [{ role: 'user', content: 'q' }],
      expect.objectContaining({ temperature: 0.7, foo: 'bar', budgetContext: { taskId: 'research' } })
    );
  });

  it('continues to the next adapter when an adapter resolves without a reply', async () => {
    const empty = makeAdapter(async () => ({ reply: '' }));
    const lm = makeAdapter(async () => ({ reply: 'real' }));
    const getAdapter = vi.fn((id) => {
      if (id === 'primary') return empty;
      if (id === 'lmstudio') return lm;
      return null;
    });
    const brainRouter = { route: () => ({ adapterId: 'primary', fallbacks: [] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });

    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'real' });
    expect(empty.chat).toHaveBeenCalledTimes(1);
    expect(lm.chat).toHaveBeenCalledTimes(1);
  });

  it('deduplicates the chain via Set', async () => {
    const lm = makeAdapter(async () => ({ reply: 'go' }));
    const seen = [];
    const getAdapter = vi.fn((id) => {
      seen.push(id);
      return id === 'lmstudio' ? lm : null;
    });
    const brainRouter = { route: () => ({ adapterId: 'lmstudio', fallbacks: ['lmstudio', 'lmstudio'] }) };
    const chat = createBrainChat({ getAdapter, brainRouter });

    const result = await chat([{ role: 'user', content: 'hi' }]);
    expect(result).toEqual({ reply: 'go' });
    // lmstudio should appear only once in the chain
    expect(seen.filter((id) => id === 'lmstudio')).toHaveLength(1);
  });
});
