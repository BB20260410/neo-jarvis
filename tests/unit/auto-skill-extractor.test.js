import { describe, expect, it } from 'vitest';
import { createAutoSkillExtractor, roomMessagesForSkillExtraction } from '../../src/skills/AutoSkillExtractor.js';

function mockStore() {
  const saved = {};
  return {
    get: (name) => saved[name] || null,
    upsert: (skill) => { saved[skill.name] = skill; return { ...skill, enabled: false }; },
    saved,
  };
}

const room = {
  id: 'room-1',
  name: 'Cloudflare deploy',
  topic: '总结一套 cloudflare 部署流程',
  rounds: [
    { kind: 'r1', turns: [{ displayName: 'A', content: '先配置 wrangler' }, { displayName: 'B', content: '再设置环境变量' }] },
    { kind: 'r2', turns: [{ displayName: 'A', content: '部署前跑测试' }, { displayName: 'B', content: '最后 wrangler deploy' }] },
  ],
  finalConsensus: '复用流程：测试、配置 wrangler、部署。',
};

describe('AutoSkillExtractor', () => {
  it('flattens completed room content into extractable messages', () => {
    const messages = roomMessagesForSkillExtraction(room);
    expect(messages[0]).toMatchObject({ role: 'user' });
    expect(messages.filter((m) => m.role === 'assistant').length).toBeGreaterThanOrEqual(4);
    expect(messages.map((m) => m.content).join('\n')).toContain('wrangler deploy');
  });

  it('queues extraction on room done event and saves disabled draft skill', async () => {
    const store = mockStore();
    const auto = createAutoSkillExtractor({
      roomStore: { get: () => room },
      store,
      schedule: (fn) => fn(),
      getAdapter: () => ({
        chat: async () => ({
          reply: '{"name":"deploy-cloudflare","displayName":"部署 Cloudflare","description":"部署 Cloudflare 项目时使用","body":"先测试，再 wrangler deploy","confidence":0.9}',
        }),
      }),
    });
    const queued = auto.handleRoomEvent('room-1', { type: 'debate_done' });
    expect(queued.queued).toBe(true);
    const out = await queued.promise;
    expect(out.extracted).toBe(true);
    expect(store.saved['deploy-cloudflare']).toMatchObject({ enabled: false });
  });

  it('ignores non-terminal events and de-duplicates repeated done events', async () => {
    let calls = 0;
    const auto = createAutoSkillExtractor({
      roomStore: { get: () => room },
      store: mockStore(),
      schedule: (fn) => fn(),
      getAdapter: () => ({ chat: async () => { calls += 1; return { reply: 'null' }; } }),
    });
    expect(auto.handleRoomEvent('room-1', { type: 'turn_done' }).queued).toBe(false);
    const first = auto.handleRoomEvent('room-1', { type: 'squad_done' });
    const second = auto.handleRoomEvent('room-1', { type: 'squad_done' });
    expect(first.queued).toBe(true);
    expect(second.queued).toBe(false);
    await first.promise;
    expect(calls).toBe(1);
  });
});
