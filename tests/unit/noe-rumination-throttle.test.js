// @ts-nocheck
import { describe, expect, it } from 'vitest';
import { NoeRuminationThrottle, resolveRuminationThrottleConfig } from '../../src/loop/NoeRuminationThrottle.js';

describe('NoeRuminationThrottle', () => {
  it('resolveConfig 默认 OFF', () => {
    const c = resolveRuminationThrottleConfig({});
    expect(c.enabled).toBe(false);
    expect(c.maxPerEpisode).toBe(2);
    expect(c.episodeCooldownMs).toBe(300000);
    expect(c.topicCooldownMs).toBe(900000);
  });

  it('无 episodeId 放行（不节流）', () => {
    const t = new NoeRuminationThrottle({ now: () => 1000 });
    expect(t.check({}).allowed).toBe(true);
  });

  it('per-episode 计数上限（默认2，第3次拒）', () => {
    let now = 1000;
    const t = new NoeRuminationThrottle({ maxPerEpisode: 2, episodeCooldownMs: 100, topicCooldownMs: 100, now: () => now });
    expect(t.check({ episodeId: 'e1' }).allowed).toBe(true);
    t.record({ episodeId: 'e1' }); now += 200;
    expect(t.check({ episodeId: 'e1' }).allowed).toBe(true);
    t.record({ episodeId: 'e1' }); now += 200;
    const r = t.check({ episodeId: 'e1' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('max_per_episode');
  });

  it('per-episode 冷却（冷却期内拒）', () => {
    let now = 1000;
    const t = new NoeRuminationThrottle({ maxPerEpisode: 5, episodeCooldownMs: 5000, topicCooldownMs: 1, now: () => now });
    t.record({ episodeId: 'e1' });
    now += 1000;
    const r = t.check({ episodeId: 'e1' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('episode_cooldown');
  });

  it('per-topic 冷却（同 topic 不同 episode 也抑制）', () => {
    let now = 1000;
    const t = new NoeRuminationThrottle({ maxPerEpisode: 5, episodeCooldownMs: 1, topicCooldownMs: 10000, now: () => now });
    t.record({ episodeId: 'e1', topicId: 'computer-use' });
    now += 2000;
    const r = t.check({ episodeId: 'e2', topicId: 'computer-use' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('topic_cooldown');
  });

  it('跨 topic 不误伤', () => {
    let now = 1000;
    const t = new NoeRuminationThrottle({ maxPerEpisode: 5, episodeCooldownMs: 1, topicCooldownMs: 10000, now: () => now });
    t.record({ episodeId: 'e1', topicId: 'topic-A' });
    now += 2000;
    expect(t.check({ episodeId: 'e2', topicId: 'topic-B' }).allowed).toBe(true);
  });

  it('冷却解冻后放行', () => {
    let now = 1000;
    const t = new NoeRuminationThrottle({ maxPerEpisode: 5, episodeCooldownMs: 5000, topicCooldownMs: 1, now: () => now });
    t.record({ episodeId: 'e1' });
    now += 6000;
    expect(t.check({ episodeId: 'e1' }).allowed).toBe(true);
  });

  it('record LRU 上限淘汰冷 entry', () => {
    const t = new NoeRuminationThrottle({ now: () => 1000, maxEntries: 3 });
    t.record({ episodeId: 'a' }); t.record({ episodeId: 'b' }); t.record({ episodeId: 'c' });
    expect(t.episodes.size).toBe(3);
    t.record({ episodeId: 'd' });
    expect(t.episodes.size).toBe(3);
    expect(t.status('a').count).toBe(0);
  });

  it('topics Map 同样 LRU 有界（开放 topicId 不无界增长，审查 MEDIUM 修复）', () => {
    const t = new NoeRuminationThrottle({ now: () => 1000, maxEntries: 3 });
    t.record({ episodeId: 'e1', topicId: 't-a' });
    t.record({ episodeId: 'e2', topicId: 't-b' });
    t.record({ episodeId: 'e3', topicId: 't-c' });
    expect(t.topics.size).toBe(3);
    t.record({ episodeId: 'e4', topicId: 't-d' }); // 超限淘汰最旧 topic
    expect(t.topics.size).toBe(3);
    expect(t.topics.has('t-a')).toBe(false);
    expect(t.topics.has('t-d')).toBe(true);
    t.record({ episodeId: 'e5', topicId: 't-d' }); // 同 topic 重复 = touch，不增长
    expect(t.topics.size).toBe(3);
  });
});
