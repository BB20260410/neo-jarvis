import { describe, expect, it } from 'vitest';
import { buildClusterCapabilityGuardReport } from '../../src/server/services/cluster-capability-guard.js';

describe('cluster capability guard', () => {
  it('passes normal multi-member rooms without forcing a fixed model list', () => {
    const report = buildClusterCapabilityGuardReport({
      rooms: [
        {
          id: 'game-room',
          mode: 'cross_verify',
          status: 'running',
          members: [
            { adapterId: 'claude', model: 'claude-opus-4-8', enabled: true },
            { adapterId: 'codex', model: 'gpt-5.5', enabled: true, pluginBridge: { app: 'codex-app' } },
            { adapterId: 'gemini-cli', model: 'gemini-3.5-flash', enabled: true },
            { adapterId: 'local-qwen', model: 'qwen-local', enabled: true },
          ],
        },
      ],
      now: new Date('2026-06-01T01:00:00.000Z'),
    });

    expect(report).toMatchObject({
      guardVersion: 'cluster-capability-guard-v1',
      generatedAt: '2026-06-01T01:00:00.000Z',
      status: 'passed',
      ok: true,
      summary: {
        totalRoomCount: 1,
        activeRoomCount: 1,
        enabledMemberCount: 4,
        nativeBridgeViolationCount: 0,
        sharedRoomBridgeCount: 0,
      },
      blockers: [],
      warnings: [],
    });
  });

  it('blocks active rooms with no executable member or missing adapter identity', () => {
    const report = buildClusterCapabilityGuardReport({
      rooms: [
        { id: 'empty-room', mode: 'cross_verify', status: 'paused', members: [{ adapterId: 'claude', enabled: false }] },
        { id: 'missing-adapter-room', mode: 'cross_verify', status: 'idle', members: [{ enabled: true }] },
        { id: 'finished-room', mode: 'cross_verify', status: 'done', members: [] },
      ],
    });

    expect(report.status).toBe('blocked');
    expect(report.ok).toBe(false);
    expect(report.blockers).toEqual(expect.arrayContaining([
      'enabled_members_empty:empty-room',
      'member_adapter_id_missing:missing-adapter-room:0',
    ]));
    expect(report.blockers).not.toContain('enabled_members_empty:finished-room');
  });

  it('blocks shared room skill injection and non-Codex native bridge drift', () => {
    const report = buildClusterCapabilityGuardReport({
      rooms: [
        {
          id: 'shared-bridge-room',
          mode: 'cross_verify',
          status: 'running',
          skillIds: ['room-wide-skill'],
          members: [
            { adapterId: 'claude', enabled: true, skillBridge: { source: 'codex-app' } },
            { adapterId: 'gemini-cli', enabled: true, capabilityMode: 'shared-plugin' },
            { adapterId: 'codex', enabled: true, pluginBridge: { source: 'codex-app' } },
          ],
        },
      ],
    });

    expect(report.status).toBe('blocked');
    expect(report.blockers).toEqual(expect.arrayContaining([
      'room_shared_capability_bridge:shared-bridge-room:skillIds',
      'native_member_shared_bridge:shared-bridge-room:claude#0',
      'native_member_shared_bridge:shared-bridge-room:gemini-cli#1',
    ]));
    expect(report.blockers).not.toContain('native_member_shared_bridge:shared-bridge-room:codex#2');
  });

  it('warns on duplicate or unknown adapters without blocking custom expansion', () => {
    const report = buildClusterCapabilityGuardReport({
      knownAdapterIds: ['claude', 'codex'],
      rooms: [
        {
          id: 'duplicate-room',
          mode: 'cross_verify',
          status: 'running',
          members: [
            { adapterId: 'claude', enabled: true },
            { adapterId: 'claude', enabled: true },
            { adapterId: 'custom-model', enabled: true },
          ],
        },
      ],
    });

    expect(report.status).toBe('warn');
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual(expect.arrayContaining([
      'duplicate_enabled_adapter:duplicate-room:claude=2',
      'unknown_adapter_id:duplicate-room:custom-model',
    ]));
    expect(report.blockers).toEqual([]);
  });
});
