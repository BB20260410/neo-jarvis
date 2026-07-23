import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NoeLoop } from '../../src/loop/NoeLoop.js';
import { SoloChatDispatcher } from '../../src/room/SoloChatDispatcher.js';
import { BudgetLimitExceededError } from '../../src/budget/BudgetPolicyStore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';

// 波次6 接线测试：TurnFinalizer 死前交接（NoeLoop 预算硬停 + SoloChat 预算爆）+ HangAlert 巡检告警。

let tmp;

beforeEach(() => {
  close();
  tmp = mkdtempSync(join(tmpdir(), 'noe-loop-fin-'));
  initSqlite(join(tmp, 'panel.db'));
});

afterEach(() => {
  close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('NoeLoop × TurnFinalizer（预算硬停死前交接）', () => {
  it('预算硬停 → 写 handoff 记忆 + 广播 + 暂停', async () => {
    const written = [];
    const broadcasts = [];
    const loop = new NoeLoop({
      projectId: 'noe',
      memory: { write: (m) => written.push(m), stats: () => ({ visible: 5 }) },
      focus: { list: () => [{ title: '修复登录页崩溃' }, { title: '接线波次6' }] },
      budget: { preflight: () => { throw new BudgetLimitExceededError('monthly usd cap', { blocked: [] }); } },
      broadcast: (m) => broadcasts.push(m),
      logger: null,
    });
    loop.actMode = true;
    const r = await loop.tick({ force: true });
    expect(r.skipped).toBe('budget');
    expect(loop.state).toBe('paused_budget');
    expect(written).toHaveLength(1);
    expect(written[0].scope).toBe('handoff');
    expect(written[0].salience).toBe(4);
    expect(written[0].body).toContain('修复登录页崩溃');     // 焦点留痕
    expect(written[0].body).toContain('budget_hard_stop');
    expect(broadcasts.some((b) => b.type === 'noe_turn_finalized')).toBe(true);
  });

  it('死前交接失败(memory.write 抛错) 不阻断暂停', async () => {
    const loop = new NoeLoop({
      projectId: 'noe',
      memory: { write: () => { throw new Error('db down'); }, stats: () => null },
      focus: { list: () => [] },
      budget: { preflight: () => { throw new BudgetLimitExceededError('cap', {}); } },
      logger: null,
    });
    loop.actMode = true;
    const r = await loop.tick({ force: true });
    expect(r.skipped).toBe('budget');
    expect(loop.state).toBe('paused_budget');
  });
});

describe('NoeLoop × HangAlert（巡检告警非杀）', () => {
  it('首次告警广播 noe_hang_alert，非首次不刷屏', async () => {
    const broadcasts = [];
    const loop = new NoeLoop({
      projectId: 'noe',
      hangAlert: {
        check: () => [
          { taskId: 'act-1', firstAlert: true, silentMs: 600000, runningMs: 700000, meta: { action: 'shell.exec' } },
          { taskId: 'act-2', firstAlert: false, silentMs: 900000, runningMs: 950000, meta: {} },
        ],
      },
      broadcast: (m) => broadcasts.push(m),
      logger: null,
    });
    await loop.tick({ force: true });
    const alerts = broadcasts.filter((b) => b.type === 'noe_hang_alert');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].alert.taskId).toBe('act-1');
  });
});

describe('SoloChatDispatcher × TurnFinalizer（聊天预算爆死前交接）', () => {
  it('BUDGET_LIMIT_EXCEEDED → conversation 追加 finalizer 交接消息', async () => {
    const room = { id: 'r1', mode: 'chat', members: [{ adapterId: 'fake', enabled: true }], conversation: [], cwd: '/tmp' };
    const updates = [];
    const broadcasts = [];
    const err = Object.assign(new Error('monthly cap hit'), { code: 'BUDGET_LIMIT_EXCEEDED' });
    const d = new SoloChatDispatcher({
      store: { get: () => room, update: (id, patch) => updates.push(patch), setStatus: () => {} },
      adapters: new Map([['fake', { chat: async () => { throw err; } }]]),
      broadcast: (id, msg) => broadcasts.push(msg),
      metrics: { record: () => {} },
    });
    await expect(d.sendMessage('r1', '继续帮我修 bug')).rejects.toThrow('monthly cap');
    const fin = room.conversation.find((m) => m.finalizer === true);
    expect(fin).toBeTruthy();
    expect(fin.from).toBe('system');
    expect(fin.content).toContain('死前交接');
    expect(fin.content).toContain('修 bug');                  // 对话留痕
    expect(broadcasts.some((b) => b.type === 'chat_finalizer')).toBe(true);
  });

  it('普通错误不触发 finalizer', async () => {
    const room = { id: 'r1', mode: 'chat', members: [{ adapterId: 'fake', enabled: true }], conversation: [], cwd: '/tmp' };
    const d = new SoloChatDispatcher({
      store: { get: () => room, update: () => {}, setStatus: () => {} },
      adapters: new Map([['fake', { chat: async () => { throw new Error('网络抖动'); } }]]),
      broadcast: () => {},
      metrics: { record: () => {} },
    });
    await expect(d.sendMessage('r1', '你好')).rejects.toThrow('网络抖动');
    expect(room.conversation.find((m) => m.finalizer)).toBeUndefined();
  });
});
