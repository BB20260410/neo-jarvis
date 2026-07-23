import { describe, it, expect, vi } from 'vitest';
import {
  classifyAgainstRejectLessons,
  createSelfEvolutionLessonRecall,
  extractObjectiveFromSummary,
} from '../../src/room/NoeSelfEvolutionLessonRecall.js';

// 改动3 v1：autoseed 立项前召回近期 reject lesson，只「近重复」(≥3 topic 重叠+高分)才 hard block，
//   中度同类放行（owner 要别饿死飞轮、少加限制）。blocker 分级+advisory 留 v2。
const REJECT_BODY = '自我进化 cycle 被复核拒绝（优化 NoeActPipeline 的并发调度算法）。复核：m3:reject。blocker：无测试。';

describe('classifyAgainstRejectLessons（改动3 v1 近重复判据·纯函数）', () => {
  it('近重复（charDice≥0.6）→ similar:true + near_duplicate_rejected', () => {
    const r = classifyAgainstRejectLessons('优化 NoeActPipeline 并发调度算法逻辑', [{ id: 'm1', body: REJECT_BODY }]);
    expect(r.similar).toBe(true);
    expect(r.reason).toBe('near_duplicate_rejected');
    expect(r.score).toBeGreaterThanOrEqual(0.6);
    expect(r.lessonObjective).toContain('NoeActPipeline'); // 从 summary 括号内提被拒 objective
  });
  it('不同主题 → similar:false（放行）', () => {
    expect(classifyAgainstRejectLessons('修复 NoeMemoryCore 的 FTS 召回 bug', [{ id: 'm1', body: REJECT_BODY }]).similar).toBe(false);
  });
  it('中度同类（<3 topic 重叠）→ similar:false（v1 只拦近重复,放行中度,不饿死）', () => {
    expect(classifyAgainstRejectLessons('优化 NoeGoalSystem 的目标调度', [{ id: 'm1', body: REJECT_BODY }]).similar).toBe(false);
  });
  it('objective 太薄（<6 字）→ objective_too_thin（放行）', () => {
    expect(classifyAgainstRejectLessons('改进自己', [{ id: 'm1', body: REJECT_BODY }]).reason).toBe('objective_too_thin');
  });
  it('lessons 空 → similar:false', () => {
    expect(classifyAgainstRejectLessons('优化 NoeActPipeline 并发调度算法', []).similar).toBe(false);
  });
});

describe('createSelfEvolutionLessonRecall（工厂·召回 + 时间窗 + fail-open）', () => {
  it('召回近期同类（tags LIKE q）→ similar:true，懒调用', () => {
    const recall = vi.fn(() => [{ id: 'm1', body: REJECT_BODY, tags: ['self_evolution_reject'], createdAt: 1000 }]);
    const f = createSelfEvolutionLessonRecall({ recall, now: () => 2000 });
    expect(recall).not.toHaveBeenCalled(); // 工厂不立即召回
    const r = f('优化 NoeActPipeline 并发调度算法逻辑');
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ q: 'self_evolution_reject' }));
    expect(r.similar).toBe(true);
  });
  it('老 learning（超 14 天窗）被过滤 → similar:false（不永久压制）', () => {
    const old = 1000;
    const recall = vi.fn(() => [{ id: 'm1', body: REJECT_BODY, createdAt: old }]);
    const f = createSelfEvolutionLessonRecall({ recall, now: () => old + 15 * 24 * 60 * 60_000, windowMs: 14 * 24 * 60 * 60_000 });
    expect(f('优化 NoeActPipeline 并发调度算法逻辑').similar).toBe(false);
  });
  it('recall 抛错 → fail-open（similar:false, recall_failed，不阻断飞轮）', () => {
    const f = createSelfEvolutionLessonRecall({ recall: () => { throw new Error('db lock'); } });
    expect(f('优化 NoeActPipeline 并发调度算法').reason).toBe('recall_failed');
    expect(f('优化 NoeActPipeline 并发调度算法').similar).toBe(false);
  });
  it('recall 未注入 → recall_unavailable（不崩）', () => {
    expect(createSelfEvolutionLessonRecall({})('x').reason).toBe('recall_unavailable');
  });
});

// 两路审修复（multimodel P1-2/P2-4 + 主线裁断）：阈值 0.6→0.85 防误杀 + tags 精确过滤防误召回 + 正则防嵌套括号。
describe('改动3 审修复 probe', () => {
  it('P1-2 防误杀：不同文件同类工作（charDice~0.58 < 0.85）放行', () => {
    const body = '自我进化 cycle 被复核拒绝（优化 src/foo.js 性能）。';
    expect(classifyAgainstRejectLessons('改进自身：优化 src/bar.js 性能', [{ id: 'm1', body }]).similar).toBe(false);
  });
  it('P1-2 防误杀：补测试（修上次 missing_tests blocker，charDice~0.82 < 0.85）放行', () => {
    const body = '自我进化 cycle 被复核拒绝（优化 ActPipeline 并发调度）。';
    expect(classifyAgainstRejectLessons('为 ActPipeline 并发调度补测试', [{ id: 'm1', body }]).similar).toBe(false);
  });
  it('P1-2 仍拦真近重复（charDice 0.889 ≥ 0.85）', () => {
    const body = '自我进化 cycle 被复核拒绝（优化 NoeActPipeline 的并发调度算法）。';
    expect(classifyAgainstRejectLessons('优化 NoeActPipeline 并发调度算法逻辑', [{ id: 'm1', body }]).similar).toBe(true);
  });
  it('P2-4 防误召回：召回的非 reject-lesson 记录（tags 无 self_evolution_reject）不参与判定', () => {
    const recall = vi.fn(() => [{ id: 'x', body: '自我进化 cycle 被复核拒绝（优化 NoeActPipeline 的并发调度算法）。', tags: ['other'], createdAt: 1000 }]);
    const f = createSelfEvolutionLessonRecall({ recall, now: () => 2000 });
    expect(f('优化 NoeActPipeline 并发调度算法逻辑').similar).toBe(false);
  });
  it('P1-3 正则防御：objective 含嵌套全角括号不截断', () => {
    const body = '自我进化 cycle 被复核拒绝（修复 A（B）里的并发调度 bug）。复核：m3:reject。';
    expect(extractObjectiveFromSummary(body)).toContain('并发调度');
  });
  it('P1-1（multimodel 重审）：召回传 sourceTypes 原生过滤，防 limit:8 被非 lesson 淹没截断真 lesson', () => {
    const recall = vi.fn(() => []);
    createSelfEvolutionLessonRecall({ recall, projectId: 'noe' })('优化 NoeActPipeline 并发调度算法');
    expect(recall).toHaveBeenCalledWith(expect.objectContaining({ sourceTypes: ['self_evolution_reject_lesson'] }));
  });
});
