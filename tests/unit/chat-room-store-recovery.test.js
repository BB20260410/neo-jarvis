import { describe, it, expect, vi } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('ChatRoomStore recovery', () => {
  it('load:服务重启后同步恢复房间和 taskList 的 running 假状态', async () => {
    const oldHome = process.env.HOME;
    const tempHome = join(tmpdir(), `noe-store-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempHome, '.noe-panel'), { recursive: true });
    writeFileSync(join(tempHome, '.noe-panel', 'rooms.json'), JSON.stringify({
      rooms: [{
        id: 'room-recover-1',
        name: '恢复测试',
        mode: 'cross_verify',
        status: 'running',
        members: [],
        rounds: [],
        conversation: [],
        taskList: [
          { id: 'CE01', status: 'running' },
          { id: 'CE02', status: 'done' },
        ],
      }],
    }, null, 2));
    process.env.HOME = tempHome;
    vi.resetModules();
    try {
      const { ChatRoomStore } = await import('../../src/room/ChatRoomStore.js');
      const store = new ChatRoomStore();
      const room = store.get('room-recover-1');

      expect(room.status).toBe('paused');
      expect(room.recoveredFromRunning).toMatchObject({ reason: 'store_load_running_room_recovery' });
      expect(room.taskList[0]).toMatchObject({
        status: 'pending',
        blocking: false,
        recoveredFromRunning: { reason: 'store_load_running_task_recovery' },
      });
      expect(room.taskList[0].qualityGateFeedback).toContain('服务重启后检测到任务停留在 running 状态');
      expect(room.taskList[1].status).toBe('done');
    } finally {
      process.env.HOME = oldHome;
      rmSync(tempHome, { recursive: true, force: true });
      vi.resetModules();
    }
  });

  it('load:房间非 running 但 taskList 残留 running 时也恢复为可续跑状态', async () => {
    const oldHome = process.env.HOME;
    const tempHome = join(tmpdir(), `noe-store-task-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(tempHome, '.noe-panel'), { recursive: true });
    writeFileSync(join(tempHome, '.noe-panel', 'rooms.json'), JSON.stringify({
      rooms: [{
        id: 'room-recover-2',
        name: '暂停房间内部任务恢复测试',
        mode: 'cross_verify',
        status: 'paused',
        members: [],
        rounds: [],
        conversation: [],
        taskList: [
          { id: 'CE01', status: 'done' },
          { id: 'CE02', status: 'running', blocking: true },
          { id: 'CE03', status: 'pending' },
        ],
      }],
    }, null, 2));
    process.env.HOME = tempHome;
    vi.resetModules();
    try {
      const { ChatRoomStore } = await import('../../src/room/ChatRoomStore.js');
      const store = new ChatRoomStore();
      const room = store.get('room-recover-2');

      expect(room.status).toBe('paused');
      expect(room.recoveredFromRunning).toMatchObject({ reason: 'store_load_running_task_recovery' });
      expect(room.recoveredTaskCount).toBe(1);
      expect(room.taskList[0].status).toBe('done');
      expect(room.taskList[1]).toMatchObject({
        status: 'pending',
        blocking: false,
        recoveredFromRunning: { reason: 'store_load_running_task_recovery' },
      });
      expect(room.taskList[1].qualityGateFeedback).toContain('服务重启后检测到任务停留在 running 状态');
      expect(room.taskList[2].status).toBe('pending');
    } finally {
      process.env.HOME = oldHome;
      rmSync(tempHome, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});
