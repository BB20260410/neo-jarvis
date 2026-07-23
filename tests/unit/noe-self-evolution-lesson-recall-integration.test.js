import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { createSelfEvolutionRejectLessonRecorder } from '../../src/room/NoeSelfEvolutionRejectLesson.js';
import { createSelfEvolutionLessonRecall } from '../../src/room/NoeSelfEvolutionLessonRecall.js';

// 改动3 端到端集成（真 MemoryCore + 隔离临时 sqlite，非 mock）：
//   两路审 P0-1 实测——recorder 不传 projectId 写到 'default'、recall 搜 'noe' → 召回恒 0、闭环不通电。
//   单测 stub recall 掩盖了这个跨组件契约缺口（"机制存在≠活着"）。本集成测试钉住 projectId 链路真通。
let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'noe-selfevo-recall-integ-'));
  initSqlite(path.join(dir, 'panel.db'));
});
afterEach(() => {
  close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('改动3 端到端集成（真 MemoryCore，防 projectId 断层被 mock 掩盖）', () => {
  it('P0-1 闭环真通：recorder 写 reject lesson → 同 projectId(noe) 真召回 → 近重复判 similar', () => {
    const mem = new MemoryCore();
    const recorder = createSelfEvolutionRejectLessonRecorder({ memoryWrite: (e) => mem.write(e), now: () => 1000 });
    const w = recorder({ cycleId: 'c-1', goalId: 'g-1', objective: '优化 NoeActPipeline 的并发调度算法', reviews: [{ model: 'm3', decision: 'reject' }], errors: ['无测试'] });
    expect(w.memoryId).toBeTruthy(); // 写入成功且拿到 id

    const recall = createSelfEvolutionLessonRecall({ recall: (i) => mem.recall(i), projectId: 'noe', now: () => 2000 });
    const r = recall('优化 NoeActPipeline 并发调度算法逻辑');
    expect(r.lessonsConsidered).toBeGreaterThanOrEqual(1); // P0-1 修复证明：projectId 匹配，真召回到 lesson
    expect(r.similar).toBe(true); // 近重复 → hard block
  });

  it('反向 probe：projectId 不匹配则召不回（坐实 P0-1 曾是真隐患，非臆测）', () => {
    const mem = new MemoryCore();
    const recorder = createSelfEvolutionRejectLessonRecorder({ memoryWrite: (e) => mem.write(e), now: () => 1000 });
    recorder({ cycleId: 'c-1', objective: '优化 NoeActPipeline 的并发调度算法', reviews: [], errors: [] });
    const recallWrong = createSelfEvolutionLessonRecall({ recall: (i) => mem.recall(i), projectId: 'some-other-project', now: () => 2000 });
    expect(recallWrong('优化 NoeActPipeline 并发调度算法逻辑').lessonsConsidered).toBe(0);
  });

  it('反向 probe：不同主题真召回但不判近重复（放行，不饿死飞轮）', () => {
    const mem = new MemoryCore();
    const recorder = createSelfEvolutionRejectLessonRecorder({ memoryWrite: (e) => mem.write(e), now: () => 1000 });
    recorder({ cycleId: 'c-1', objective: '优化 NoeActPipeline 的并发调度算法', reviews: [], errors: [] });
    const recall = createSelfEvolutionLessonRecall({ recall: (i) => mem.recall(i), projectId: 'noe', now: () => 2000 });
    expect(recall('修复 NoeMemoryCore 的 FTS 召回越界 bug').similar).toBe(false);
  });

  it('P1-1: sourceTypes 原生过滤——非 lesson（含 self_evolution_reject 文本但 sourceType 不同）不被召回淹没真 lesson', () => {
    const mem = new MemoryCore();
    // 干扰项：一条 manual 记录，body 含 self_evolution_reject 文本 + 与真 lesson 同主题（模拟"前 8 条挤占"场景）
    mem.write({ projectId: 'noe', sourceType: 'manual', body: 'self_evolution_reject 随手记：优化 NoeActPipeline 的并发调度算法', tags: ['note'] });
    // 真 reject lesson
    const recorder = createSelfEvolutionRejectLessonRecorder({ memoryWrite: (e) => mem.write(e), now: () => 1000 });
    recorder({ cycleId: 'c-1', objective: '优化 NoeActPipeline 的并发调度算法', reviews: [], errors: [] });
    const recall = createSelfEvolutionLessonRecall({ recall: (i) => mem.recall(i), projectId: 'noe', now: () => 2000 });
    const r = recall('优化 NoeActPipeline 并发调度算法逻辑');
    expect(r.lessonsConsidered).toBe(1); // sourceTypes 原生过滤：只真 lesson 参与，干扰 manual 被 SQL 滤掉
    expect(r.similar).toBe(true);
  });
});
