import { describe, it, expect } from 'vitest';
import { createWalCheckpointMaintenance } from '../../src/storage/NoeWalCheckpointMaintenance.js';

// WAL 截断维护：长驻进程 WAL 单调膨胀(PASSIVE autocheckpoint 刷回主库但不缩文件)，
//   心跳定期跑 wal_checkpoint(TRUNCATE) 截回小尺寸。返回值参考 backupDbOnce：[{busy,log,checkpointed}]。
//   核心契约：busy=0=截断成功；撞 reader / 异常 / 无 db 都 fail-safe 不崩心跳，下周期重来。

const mkDb = (pragmaImpl) => ({ pragma: pragmaImpl });

describe('NoeWalCheckpointMaintenance', () => {
  it('正常 TRUNCATE busy=0 → ok:true + 帧数 + 时间戳', () => {
    const db = mkDb(() => [{ busy: 0, log: 8, checkpointed: 8 }]);
    const m = createWalCheckpointMaintenance({ getDb: () => db, now: () => 1000 });
    const r = m.runOnce();
    expect(r.ok).toBe(true);
    expect(r.busy).toBe(0);
    expect(r.walFrames).toBe(8);
    expect(r.checkpointed).toBe(8);
    expect(r.at).toBe(1000);
  });

  it('撞 reader busy=1 → ok:false 不抛(这次没截净,下周期重来)', () => {
    const db = mkDb(() => [{ busy: 1, log: 200, checkpointed: 50 }]);
    const r = createWalCheckpointMaintenance({ getDb: () => db }).runOnce();
    expect(r.ok).toBe(false);
    expect(r.busy).toBe(1);
  });

  it('pragma 抛错 → fail-safe ok:false reason=checkpoint_failed 不崩心跳', () => {
    const db = mkDb(() => { throw new Error('disk io error'); });
    const r = createWalCheckpointMaintenance({ getDb: () => db }).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('checkpoint_failed');
    expect(r.error).toContain('disk io');
  });

  it('getDb 抛错 → no_db 不崩', () => {
    const r = createWalCheckpointMaintenance({ getDb: () => { throw new Error('no db'); } }).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_db');
  });

  it('getDb 返回 null → no_db', () => {
    expect(createWalCheckpointMaintenance({ getDb: () => null }).runOnce().reason).toBe('no_db');
  });

  it('db 无 pragma 方法 → no_db(防御非法 db)', () => {
    expect(createWalCheckpointMaintenance({ getDb: () => ({}) }).runOnce().reason).toBe('no_db');
  });

  it('pragma 返回非数组(simple 模式) → 兼容取值', () => {
    const db = mkDb(() => ({ busy: 0, log: 3, checkpointed: 3 }));
    expect(createWalCheckpointMaintenance({ getDb: () => db }).runOnce().ok).toBe(true);
  });

  it('pragma 返回空数组 → ok:false 不崩', () => {
    const db = mkDb(() => []);
    const r = createWalCheckpointMaintenance({ getDb: () => db }).runOnce();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('no_result');
  });

  it('不注入 getDb 时构造与 runOnce 都不抛(默认走 sqliteStore.getDb,fail-safe)', () => {
    const m = createWalCheckpointMaintenance();
    expect(typeof m.runOnce).toBe('function');
    expect(() => m.runOnce()).not.toThrow();
  });
});
