import { describe, it, expect } from 'vitest';
import {
  buildUnifiedTimeline,
  voiceTurnsFromEpisodes,
} from '../../src/context/NoeUnifiedTimeline.js';

describe('buildUnifiedTimeline', () => {
  it('returns empty timeline with defaults', () => {
    const result = buildUnifiedTimeline();
    expect(result.ok).toBe(true);
    expect(result.count).toBe(0);
    expect(result.total).toBe(0);
    expect(result.items).toEqual([]);
  });

  it('normalizes sessions, rooms and voice turns sorted by ts desc', () => {
    const result = buildUnifiedTimeline({
      sessions: [{ id: 's1', title: 'Chat', updatedAt: 1000, status: 'active' }],
      rooms: [{ id: 'r1', name: 'Room A', createdAt: 3000, status: 'idle' }],
      voiceTurns: [{ id: 'v1', transcript: 'hello', ts: 2000 }],
      limit: 10,
    });
    expect(result.ok).toBe(true);
    expect(result.total).toBe(3);
    expect(result.count).toBe(3);
    expect(result.items.map((i) => i.kind)).toEqual(['room', 'voice', 'session']);
    expect(result.items[0].id).toBe('room:r1');
    expect(result.items[1].id).toBe('voice:v1');
    expect(result.items[2].id).toBe('session:s1');
  });

  it('respects limit and clamps it', () => {
    const sessions = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      updatedAt: i + 1,
    }));
    const result = buildUnifiedTimeline({ sessions, limit: 2 });
    expect(result.total).toBe(5);
    expect(result.count).toBe(2);
    expect(result.items).toHaveLength(2);
  });
});

describe('voiceTurnsFromEpisodes', () => {
  it('extracts voice-related episodes only', () => {
    const out = voiceTurnsFromEpisodes([
      { id: 'e1', kind: 'voice', transcript: 'hi', ts: 10 },
      { id: 'e2', kind: 'chat', text: 'nope' },
      { id: 'e3', channel: 'voice', text: 'via channel', createdAt: 20 },
      { id: 'e4', type: 'stt', payload: { transcript: 'spoken' }, at: 30 },
    ]);
    expect(out).toHaveLength(3);
    expect(out.map((t) => t.id)).toEqual(['e1', 'e3', 'e4']);
    expect(out[0].transcript).toBe('hi');
    expect(out[2].transcript).toBe('spoken');
  });

  it('returns empty array for non-array input', () => {
    expect(voiceTurnsFromEpisodes(null)).toEqual([]);
    expect(voiceTurnsFromEpisodes(undefined)).toEqual([]);
  });
});
