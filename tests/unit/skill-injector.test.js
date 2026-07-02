import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/skills/SkillStore.js', () => ({
  skillStore: {
    buildSystemPromptForSkills: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('../../src/agents/AgentSkillRegistry.js', () => ({
  buildAgentRuntimeContext: vi.fn(),
}));

vi.mock('../../src/agents/AgentPolicyStore.js', () => ({
  effectiveAgentRegistry: vi.fn(),
}));

vi.mock('../../src/room/RoomAdapter.js', () => ({
  formatNativeCapabilitiesForPrompt: vi.fn(),
}));

import { skillStore } from '../../src/skills/SkillStore.js';
import { buildAgentRuntimeContext } from '../../src/agents/AgentSkillRegistry.js';
import { effectiveAgentRegistry } from '../../src/agents/AgentPolicyStore.js';
import { formatNativeCapabilitiesForPrompt } from '../../src/room/RoomAdapter.js';

import {
  buildRoomAgentContext,
  injectSkillsToMessages,
  appendSystemContext,
  getActiveSkillNames,
} from '../../src/room/skillInjector.js';

beforeEach(() => {
  vi.clearAllMocks();
  formatNativeCapabilitiesForPrompt.mockReturnValue('');
  buildAgentRuntimeContext.mockReturnValue({ skillNames: [], prompt: '' });
  skillStore.buildSystemPromptForSkills.mockReturnValue('');
  skillStore.get.mockReturnValue(null);
  effectiveAgentRegistry.mockReturnValue({});
});

describe('buildRoomAgentContext', () => {
  it('returns null when options.member is missing', () => {
    expect(buildRoomAgentContext({ skills: ['a'] }, {})).toBeNull();
    expect(buildRoomAgentContext({ skills: ['a'] })).toBeNull();
  });

  it('forwards member, objective and codeContext to buildAgentRuntimeContext', () => {
    const room = { skills: ['a'] };
    const member = { id: 'm' };
    buildRoomAgentContext(room, { member, objective: 'OBJ', codeContext: 'CTX' });
    expect(buildAgentRuntimeContext).toHaveBeenCalledWith(
      expect.objectContaining({ member, objective: 'OBJ', codeContext: 'CTX' }),
    );
  });

  it('keeps room.skills intact when not disabled', () => {
    buildRoomAgentContext({ skills: ['a', 'b'] }, { member: { id: 'm' } });
    const call = buildAgentRuntimeContext.mock.calls[0][0];
    expect(call.room.skills).toEqual(['a', 'b']);
    expect(call.skillStore).toBe(skillStore);
  });

  it('strips room.skills and uses null skillStore when disableSharedRoomSkills', () => {
    buildRoomAgentContext({ skills: ['a'] }, { member: { id: 'm' }, disableSharedRoomSkills: true });
    const call = buildAgentRuntimeContext.mock.calls[0][0];
    expect(call.room.skills).toEqual([]);
    expect(call.skillStore.get('any')).toBeNull();
  });

  it('strips room.skills and uses null skillStore when disablePanelSkillInjection', () => {
    buildRoomAgentContext({ skills: ['a'] }, { member: { id: 'm' }, disablePanelSkillInjection: true });
    const call = buildAgentRuntimeContext.mock.calls[0][0];
    expect(call.room.skills).toEqual([]);
    expect(call.skillStore.get('any')).toBeNull();
  });

  it('passes the effectiveAgentRegistry result as registry', () => {
    const reg = { agent1: { id: 'a1' } };
    effectiveAgentRegistry.mockReturnValue(reg);
    buildRoomAgentContext({ skills: [] }, { member: { id: 'm' } });
    expect(effectiveAgentRegistry).toHaveBeenCalled();
    expect(buildAgentRuntimeContext).toHaveBeenCalledWith(expect.objectContaining({ registry: reg }));
  });
});

describe('appendSystemContext', () => {
  it('returns the input array unchanged for empty / null / undefined ctx', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    expect(appendSystemContext(messages, '')).toBe(messages);
    expect(appendSystemContext(messages, null)).toBe(messages);
    expect(appendSystemContext(messages, undefined)).toBe(messages);
  });

  it('prepends a new system message when none exists', () => {
    const out = appendSystemContext([{ role: 'user', content: 'hi' }], 'NEW');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ role: 'system', content: 'NEW' });
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('appends to the first system message and preserves later messages', () => {
    const out = appendSystemContext(
      [{ role: 'system', content: 'EXIST' }, { role: 'user', content: 'hi' }],
      'NEW',
    );
    expect(out[0].content).toBe('EXIST\n\nNEW');
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('does not mutate the input messages array', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    const snapshot = JSON.stringify(messages);
    appendSystemContext(messages, 'NEW');
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('handles a system message whose content is null', () => {
    const out = appendSystemContext(
      [{ role: 'system', content: null }, { role: 'user', content: 'hi' }],
      'NEW',
    );
    expect(out[0].content).toBe('\n\nNEW');
  });

  it('updates only the first system message when multiple exist', () => {
    const out = appendSystemContext(
      [{ role: 'system', content: 'FIRST' }, { role: 'system', content: 'SECOND' }],
      'NEW',
    );
    expect(out[0].content).toBe('FIRST\n\nNEW');
    expect(out[1].content).toBe('SECOND');
  });
});

describe('getActiveSkillNames', () => {
  it('returns [] when disableSharedRoomSkills is true', () => {
    expect(getActiveSkillNames({ skills: ['a'] }, { disableSharedRoomSkills: true })).toEqual([]);
  });

  it('returns [] when disablePanelSkillInjection is true', () => {
    expect(getActiveSkillNames({ skills: ['a'] }, { disablePanelSkillInjection: true })).toEqual([]);
  });

  it('returns [] when room has no skills and no agent context', () => {
    expect(getActiveSkillNames({})).toEqual([]);
    expect(getActiveSkillNames({ skills: null })).toEqual([]);
    expect(getActiveSkillNames({ skills: 'not-an-array' })).toEqual([]);
  });

  it('returns room skill names when they are all enabled and known', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    const out = getActiveSkillNames({ skills: ['a', 'b'] }, { member: { id: 'm' } });
    expect(out).toEqual(['a', 'b']);
  });

  it('merges room skill names with agent context skill names', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    const out = getActiveSkillNames(
      { skills: ['a'] },
      { agentContext: { skillNames: ['b', 'c'] } },
    );
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('deduplicates names that appear in both room and agent lists', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    const out = getActiveSkillNames(
      { skills: ['a', 'b'] },
      { agentContext: { skillNames: ['b', 'c'] } },
    );
    expect(out).toEqual(['a', 'b', 'c']);
  });

  it('deduplicates repeats within the same list while preserving order', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    const out = getActiveSkillNames({ skills: ['a', 'a', 'b', 'a'] }, { member: { id: 'm' } });
    expect(out).toEqual(['a', 'b']);
  });

  it('filters out names that fail the regex or type checks', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    const room = {
      skills: [
        'valid',
        'also_valid',
        'with-hyphen',
        'with.dot',
        'a'.repeat(64),
        'with space',
        '!bad',
        '',
        null,
        undefined,
        123,
        'a'.repeat(65),
      ],
    };
    const out = getActiveSkillNames(room, { member: { id: 'm' } });
    expect(out).toEqual(['valid', 'also_valid', 'with-hyphen', 'with.dot', 'a'.repeat(64)]);
  });

  it('filters out skills whose enabled flag is false', () => {
    skillStore.get.mockImplementation((n) =>
      n === 'off' ? { name: n, enabled: false } : { name: n, enabled: true },
    );
    const out = getActiveSkillNames({ skills: ['on', 'off'] }, { member: { id: 'm' } });
    expect(out).toEqual(['on']);
  });

  it('filters out skills missing from the store (get returns null)', () => {
    skillStore.get.mockImplementation((n) =>
      n === 'missing' ? null : { name: n, enabled: true },
    );
    const out = getActiveSkillNames({ skills: ['present', 'missing'] }, { member: { id: 'm' } });
    expect(out).toEqual(['present']);
  });

  it('uses precomputedAgentContext to avoid rebuilding', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    buildAgentRuntimeContext.mockReturnValue({ skillNames: ['from-build'] });
    const out = getActiveSkillNames({ skills: [] }, {}, { skillNames: ['from-pre'] });
    expect(out).toEqual(['from-pre']);
    expect(buildAgentRuntimeContext).not.toHaveBeenCalled();
  });

  it('falls back to options.agentContext when no precomputed context is given', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    buildAgentRuntimeContext.mockReturnValue({ skillNames: ['from-build'] });
    const out = getActiveSkillNames(
      { skills: [] },
      { agentContext: { skillNames: ['from-opt'] } },
    );
    expect(out).toEqual(['from-opt']);
    expect(buildAgentRuntimeContext).not.toHaveBeenCalled();
  });
});

describe('injectSkillsToMessages', () => {
  it('returns the original messages when room and options carry no data', () => {
    const messages = [{ role: 'user', content: 'hi' }];
    expect(injectSkillsToMessages(messages, null)).toEqual(messages);
    expect(injectSkillsToMessages(messages, {})).toEqual(messages);
  });

  it('appends projectContext.prompt to an existing system message', () => {
    const messages = [{ role: 'system', content: 'EXIST' }];
    const out = injectSkillsToMessages(messages, { projectContext: { prompt: 'PROJECT' } });
    expect(out[0].content).toContain('PROJECT');
    expect(out[0].content).toMatch(/PROJECT/);
  });

  it('ignores projectContext.prompt when it is not a string', () => {
    const messages = [{ role: 'system', content: 'EXIST' }];
    const out = injectSkillsToMessages(messages, { projectContext: { prompt: 123 } });
    expect(out[0].content).toBe('EXIST');
  });

  it('passes options.nativeCapabilities to formatNativeCapabilitiesForPrompt', () => {
    const messages = [{ role: 'system', content: 'EXIST' }];
    const caps = { tool: 'web' };
    injectSkillsToMessages(messages, {}, { nativeCapabilities: caps });
    expect(formatNativeCapabilitiesForPrompt).toHaveBeenCalledWith(caps);
  });

  it('falls back to adapter.getNativeCapabilities() when no nativeCapabilities option', () => {
    const messages = [{ role: 'system', content: 'EXIST' }];
    const caps = { tool: 'fs' };
    const adapter = { getNativeCapabilities: vi.fn(() => caps) };
    injectSkillsToMessages(messages, {}, { adapter });
    expect(adapter.getNativeCapabilities).toHaveBeenCalled();
    expect(formatNativeCapabilitiesForPrompt).toHaveBeenCalledWith(caps);
  });

  it('skips native capability append when formatNativeCapabilitiesForPrompt returns falsy', () => {
    const messages = [{ role: 'system', content: 'EXIST' }];
    formatNativeCapabilitiesForPrompt.mockReturnValue(null);
    const out = injectSkillsToMessages(messages, {}, { nativeCapabilities: { x: 1 } });
    expect(out[0].content).toBe('EXIST');
  });

  it('appends the agent context prompt when present', () => {
    buildAgentRuntimeContext.mockReturnValue({ skillNames: [], prompt: 'AGENT' });
    const messages = [{ role: 'system', content: 'EXIST' }];
    const out = injectSkillsToMessages(messages, {}, { member: { id: 'm' } });
    expect(out[0].content).toContain('AGENT');
  });

  it('uses options.agentContext directly and skips buildAgentRuntimeContext', () => {
    const messages = [{ role: 'system', content: 'EXIST' }];
    const out = injectSkillsToMessages(messages, {}, {
      agentContext: { prompt: 'PRECOMPUTED', skillNames: [] },
    });
    expect(out[0].content).toContain('PRECOMPUTED');
    expect(buildAgentRuntimeContext).not.toHaveBeenCalled();
  });

  it('appends the skill system prompt for active skills', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    skillStore.buildSystemPromptForSkills.mockReturnValue('SKILLS');
    const messages = [{ role: 'system', content: 'EXIST' }];
    const out = injectSkillsToMessages(messages, { skills: ['a'] }, { member: { id: 'm' } });
    expect(skillStore.buildSystemPromptForSkills).toHaveBeenCalledWith(['a']);
    expect(out[0].content).toContain('SKILLS');
  });

  it('skips the skill section when no active skills remain after filtering', () => {
    skillStore.get.mockReturnValue({ enabled: false });
    const messages = [{ role: 'system', content: 'EXIST' }];
    const out = injectSkillsToMessages(messages, { skills: ['a'] }, { member: { id: 'm' } });
    expect(skillStore.buildSystemPromptForSkills).not.toHaveBeenCalled();
    expect(out[0].content).toBe('EXIST');
  });

  it('skips the skill section when buildSystemPromptForSkills returns null', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    skillStore.buildSystemPromptForSkills.mockReturnValue(null);
    const messages = [{ role: 'system', content: 'EXIST' }];
    const out = injectSkillsToMessages(messages, { skills: ['a'] }, { member: { id: 'm' } });
    expect(out[0].content).toBe('EXIST');
  });

  it('catches errors thrown by buildSystemPromptForSkills (e.g. version mismatch) and warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    skillStore.buildSystemPromptForSkills.mockImplementation(() => {
      throw new Error('skill version incompatible');
    });
    const messages = [{ role: 'system', content: 'EXIST' }];
    const out = injectSkillsToMessages(messages, { skills: ['a'] }, { member: { id: 'm' } });
    expect(warn).toHaveBeenCalled();
    expect(out[0].content).toBe('EXIST');
    warn.mockRestore();
  });

  it('does not mutate the input messages array', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    skillStore.buildSystemPromptForSkills.mockReturnValue('SKILLS');
    buildAgentRuntimeContext.mockReturnValue({ skillNames: [], prompt: 'AGENT' });
    formatNativeCapabilitiesForPrompt.mockReturnValue('NATIVE');
    const messages = [{ role: 'user', content: 'hi' }];
    const snapshot = JSON.stringify(messages);
    injectSkillsToMessages(
      messages,
      { skills: ['a'], projectContext: { prompt: 'P' } },
      { member: { id: 'm' } },
    );
    expect(JSON.stringify(messages)).toBe(snapshot);
  });

  it('chains contexts in the order: project -> native -> agent -> skills', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    skillStore.buildSystemPromptForSkills.mockReturnValue('SKILLS');
    buildAgentRuntimeContext.mockReturnValue({ skillNames: ['a'], prompt: 'AGENT' });
    formatNativeCapabilitiesForPrompt.mockReturnValue('NATIVE');
    const messages = [];
    const room = { projectContext: { prompt: 'PROJECT' }, skills: ['a'] };
    const out = injectSkillsToMessages(messages, room, { member: { id: 'm' } });
    const content = out[0].content;
    expect(content.indexOf('PROJECT')).toBeLessThan(content.indexOf('NATIVE'));
    expect(content.indexOf('NATIVE')).toBeLessThan(content.indexOf('AGENT'));
    expect(content.indexOf('AGENT')).toBeLessThan(content.indexOf('SKILLS'));
  });

  it('creates a system message at the front when none exists', () => {
    buildAgentRuntimeContext.mockReturnValue({ skillNames: [], prompt: 'AGENT' });
    const messages = [{ role: 'user', content: 'hi' }];
    const out = injectSkillsToMessages(messages, {}, { member: { id: 'm' } });
    expect(out[0].role).toBe('system');
    expect(out[0].content).toContain('AGENT');
    expect(out[1]).toEqual({ role: 'user', content: 'hi' });
  });

  it('overrides a room skill that is disabled by the store', () => {
    skillStore.get.mockImplementation((n) =>
      n === 'off' ? { name: n, enabled: false } : { name: n, enabled: true },
    );
    skillStore.buildSystemPromptForSkills.mockReturnValue('ONLY-ON');
    const messages = [{ role: 'system', content: 'EXIST' }];
    const out = injectSkillsToMessages(
      messages,
      { skills: ['on', 'off'] },
      { member: { id: 'm' } },
    );
    expect(skillStore.buildSystemPromptForSkills).toHaveBeenCalledWith(['on']);
    expect(out[0].content).toContain('ONLY-ON');
  });

  it('does not duplicate skills that appear in both room and agent context', () => {
    skillStore.get.mockImplementation((n) => ({ name: n, enabled: true }));
    skillStore.buildSystemPromptForSkills.mockReturnValue('DEDUPED');
    buildAgentRuntimeContext.mockReturnValue({ skillNames: ['shared'], prompt: '' });
    const messages = [{ role: 'system', content: 'EXIST' }];
    const out = injectSkillsToMessages(
      messages,
      { skills: ['shared'] },
      { member: { id: 'm' } },
    );
    expect(skillStore.buildSystemPromptForSkills).toHaveBeenCalledWith(['shared']);
    expect(skillStore.buildSystemPromptForSkills.mock.calls[0][0]).toHaveLength(1);
    expect(out[0].content).toContain('DEDUPED');
  });
});
