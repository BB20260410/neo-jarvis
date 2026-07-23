// @ts-check
// P0.4 反向 probe：cycle 重启续跑。
// 机制要点：cycle stage 由 evaluateNoeSelfEvolutionLoop 求值器从持久化(DB)的 cycle 字段算出。
// 进程重启后（close + 重开同一 .db 文件 + 新 store）必须从「正确 stage」续跑、不丢已完成阶段进度，
// 且不得盲信持久层里被篡改/损坏的 stage 字段。
//
// 反向边界（机制失效会触发红）：
//   把伪造的 stage='complete' 直接写进 DB（模拟持久层被篡改），重启后再求值，
//   stage 必须被「重算」回真实阻塞态、绝不留在 'complete'。若 store 改成盲信存库 stage 字段 → 本测试红。

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, initSqlite, getDb } from '../../src/storage/SqliteStore.js';
import { NoeSelfEvolutionCycleStore } from '../../src/room/NoeSelfEvolutionCycleStore.js';
import { buildNoeConsensusLedger } from '../../src/room/NoeConsensusLedger.js';

let tmp;
let dbPath;
let store;

// mkdtempSync 隔离真实文件操作：每例独立临时 .db，避免污染 ~/.noe-panel/panel.db。
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'noe-p04-resume-'));
  dbPath = join(tmp, 'panel.db');
  initSqlite(dbPath);
  store = new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
});

afterEach(() => {
  close();
  rmSync(tmp, { recursive: true, force: true });
});

// 真实地模拟「进程重启」：关闭连接 → 重开同一磁盘文件 → 全新 store 实例。
function restartAndOpenStore() {
  close();
  initSqlite(dbPath);
  return new NoeSelfEvolutionCycleStore({ projectId: 'noe' });
}

// 一个真实可通过 draft 校验、consensus 合法、但 implementation 尚未完成的部分进度 cycle。
function partialProgressCycle(cycleId, goalId) {
  const evidenceRef = 'output/noe-multimodel/rx/brief.md';
  const vote = (m) => ({
    model: m,
    decision: 'approve_with_changes',
    authority: m === 'm3' ? 'suggestion_only' : m === 'codex' ? 'writer_integrator' : 'advisory',
    canWrite: m === 'codex',
    firstClass: m === 'claude' ? true : undefined,
    consensusVote: 'yes',
    recommendedFirstSlice: ['first safe slice'],
    verificationRequired: ['focused verification'],
    rawOutputRef: `output/noe-multimodel/rx/${m}.txt`,
    evidenceRef,
  });
  const ledger = buildNoeConsensusLedger({
    roundId: 'rx',
    goal: '部分进度续跑',
    evidenceRef,
    votes: [vote('codex'), vote('claude'), vote('m3')],
    implementation: {
      writer: 'codex',
      authorizationRequired: true,
      runtimeVerificationRequired: true,
      rollbackRequired: true,
      memoryWritebackAckRequired: true,
    },
  }, { createdAt: '2026-06-07T00:00:00.000Z' });
  return {
    goal: '部分进度续跑',
    goalId,
    cycleId,
    ledger,
    authorization: { consensusApproved: true, scope: 's', costClass: 'local_or_user_approved_model_calls' },
    rollback: { planRef: 'output/noe-multimodel/rx/rollback.md' },
    // implementation.done 缺省 → 求值器停在 implementation_ready（中段，未完成）
    implementation: { writer: 'codex', diffRef: 'output/noe-multimodel/rx/diff.patch', touchedFiles: ['src/x.js'] },
  };
}

describe('P0.4 cycle 重启续跑 — 反向 probe', () => {
  it('部分进度 cycle 重启后从正确中段 stage 续跑、不丢已完成阶段进度', () => {
    const w = store.upsert(partialProgressCycle('c-prog', 'goal-prog'));
    expect(w.ok).toBe(true);
    // 求值器从真实进度算出中段 stage（consensus 已过、implementation 未完成）。
    expect(w.stage).toBe('implementation_ready');

    const store2 = restartAndOpenStore();
    const resumed = store2.getByCycleId('c-prog');
    // 续跑：stage 不丢、不被重置成 draft/consensus_blocked。
    expect(resumed).not.toBeNull();
    expect(resumed.stage).toBe('implementation_ready');
    // 已完成阶段进度（consensus ledger）必须随持久化存活，不被吞。
    expect(resumed.ledger).toBeTruthy();
    expect(resumed.goalId).toBe('goal-prog');
  });

  it('重启后 advance 重算把中段进度推进到下一真实 stage（续跑非回退）', () => {
    store.upsert(partialProgressCycle('c-adv', 'goal-adv'));
    const store2 = restartAndOpenStore();
    // 补上 implementation 完成 + runtime 缺失 → 求值器应推进到 runtime_verification_required。
    const adv = store2.advance('c-adv', { implementation: { done: true, writer: 'codex', diffRef: 'output/noe-multimodel/rx/diff.patch', touchedFiles: ['src/x.js'] } });
    expect(adv.ok).toBe(true);
    expect(adv.stage).toBe('runtime_verification_required');
    // 续跑确未回退到起点。
    expect(adv.stage).not.toBe('consensus_blocked');
  });

  // 反向 probe 核心：持久层被篡改/损坏，写入伪造的 stage='complete'。
  // 机制正常 = 重启续跑时由求值器从真实字段「重算」stage，绝不盲信存库的 'complete'。
  // 若 store 退化成直接信任 DB 里的 stage 列 → 下面断言会红。
  it('伪造的 stage=complete 脏行重启后被求值器重算回真实阻塞态（机制失效即红）', () => {
    const now = Date.now();
    // 一个证据完全缺失（连 consensus 都没有）却被标成 complete 的伪造行。
    const forged = {
      schemaVersion: 1,
      cycleId: 'c-forge',
      createdAt: new Date(now).toISOString(),
      goal: '伪造完成',
      goalId: 'goal-forge',
      stage: 'complete',
    };
    getDb().prepare(`
      INSERT INTO noe_self_evolution_cycles(cycle_id, project_id, goal_id, stage, cycle_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run('c-forge', 'noe', 'goal-forge', 'complete', JSON.stringify(forged), now, now);

    // 确认脏行确实以 complete 落库（probe 前提成立）。
    const rawStage = getDb().prepare('SELECT stage FROM noe_self_evolution_cycles WHERE cycle_id = ?').get('c-forge').stage;
    expect(rawStage).toBe('complete');

    // 重启 + 续跑（advance 触发重算，等价于求值器对持久态重新求 stage）。
    const store2 = restartAndOpenStore();
    const resumed = store2.advance('c-forge', {});

    // 反向断言：伪造的 complete 被推翻，stage 被重算回真实阻塞态。
    expect(resumed.ok).toBe(true);
    expect(resumed.stage).not.toBe('complete');
    expect(resumed.stage).toBe('consensus_blocked');

    // 重算后的 stage 也已被持久回库（下次重启读到的是真相而非伪造值）。
    const persistedStage = getDb().prepare('SELECT stage FROM noe_self_evolution_cycles WHERE cycle_id = ?').get('c-forge').stage;
    expect(persistedStage).toBe('consensus_blocked');
  });
});
