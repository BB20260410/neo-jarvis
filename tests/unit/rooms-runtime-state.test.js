import { describe, expect, it } from 'vitest';
import {
  fullListRoomPayload,
  roomListResponse,
  roomWithFreshClusterRuntimeState,
  summarizeRoom,
} from '../../src/server/routes/rooms.js';

describe('rooms runtime state API fallback', () => {
  it('为集群协同房间读取时派生最新运行态,不依赖旧快照', () => {
    const room = {
      id: 'room-1',
      mode: 'cross_verify',
      status: 'running',
      clusterRuntimeState: {
        statusVersion: 'cluster-runtime-state-v1',
        phase: 'done',
        isRunning: false,
      },
      taskList: [
        { id: 'T1', status: 'done' },
        { id: 'T2', status: 'running' },
      ],
    };

    const responseRoom = roomWithFreshClusterRuntimeState(room, 'unit_test_read');

    expect(responseRoom).not.toBe(room);
    expect(room.clusterRuntimeState.phase).toBe('done');
    expect(responseRoom.clusterRuntimeState).toMatchObject({
      statusVersion: 'cluster-runtime-state-v1',
      event: 'unit_test_read',
      roomStatus: 'running',
      phase: 'running',
      isRunning: true,
      canStart: false,
    });
  });

  it('非集群协同房间保持原样,避免影响其他模式', () => {
    const room = {
      id: 'room-2',
      mode: 'chat',
      status: 'running',
    };

    expect(roomWithFreshClusterRuntimeState(room)).toBe(room);
  });

  it('列表摘要也返回同一套最新运行态,避免左右栏状态口径不一致', () => {
    const room = {
      id: 'room-3',
      mode: 'cross_verify',
      name: '集群协同',
      status: 'running',
      taskList: [{ id: 'T1', status: 'running' }],
    };

    expect(summarizeRoom(room).clusterRuntimeState).toMatchObject({
      event: 'api_list_summary',
      phase: 'running',
      isRunning: true,
    });
  });

  it('full 列表返回完整房间时同样刷新运行态', () => {
    const response = roomListResponse([
      {
        id: 'room-4',
        mode: 'cross_verify',
        status: 'paused',
        clusterRuntimeState: { phase: 'running', isRunning: true },
        taskList: [{ id: 'T1', status: 'paused' }],
      },
    ], { full: '1' });

    expect(response.compact).toBe(false);
    expect(response.rooms[0].clusterRuntimeState).toMatchObject({
      event: 'api_list_full',
      phase: 'paused',
      isRunning: false,
      canResume: true,
    });
  });

  it('full 列表大房间降级为摘要时仍保留最新运行态', () => {
    const payload = fullListRoomPayload({
      id: 'room-5',
      mode: 'cross_verify',
      status: 'running',
      rounds: [{ turns: [{ content: 'A'.repeat(260_000) }] }],
      taskList: [{ id: 'T1', status: 'running' }],
    });

    expect(payload.fullPayloadOmitted).toBe(true);
    expect(payload.rounds).toBeUndefined();
    expect(payload.clusterRuntimeState).toMatchObject({
      event: 'api_list_full',
      phase: 'running',
      isRunning: true,
    });
  });
});
