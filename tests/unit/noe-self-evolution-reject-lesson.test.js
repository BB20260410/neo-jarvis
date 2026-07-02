import { describe, it, expect, vi } from 'vitest';
import {
  buildSelfEvolutionRejectLessonSummary,
  createSelfEvolutionRejectLessonRecorder,
} from '../../src/room/NoeSelfEvolutionRejectLesson.js';

describe('buildSelfEvolutionRejectLessonSummary（脱敏装配）', () => {
  it('含 objective / reviewer decision / errors，不含 rawOutputRef 等敏感引用', () => {
    const s = buildSelfEvolutionRejectLessonSummary({
      objective: '改进 src/x.js 并发',
      reviews: [
        { model: 'm3', decision: 'reject', rawOutputRef: 'output/secret-raw.json' },
        { model: 'local-qwen', decision: 'approve' },
      ],
      errors: ['目标模糊', '无测试'],
    });
    expect(s).toContain('改进 src/x.js 并发');
    expect(s).toContain('m3:reject');
    expect(s).toContain('目标模糊');
    expect(s).not.toContain('secret-raw'); // 脱敏：绝不带 rawOutputRef
    expect(s.length).toBeLessThanOrEqual(400);
  });
  it('空输入兜底为「自我进化」', () => {
    expect(buildSelfEvolutionRejectLessonSummary()).toContain('自我进化');
  });
  // 多模型审 P0-1：errors 来自 validateNoePostReview 可能拼进 ref/diff/token，必须脱敏闭合，绝不写进 memory/episode。
  it('脱敏闭合：errors 含 文件ref / diff / secret token 也不外泄', () => {
    const s = buildSelfEvolutionRejectLessonSummary({
      objective: '改进 x',
      reviews: [{ model: 'm3', decision: 'reject' }],
      errors: ['missing_reviewer:output/raw-secret.json', 'token SECRET=sk-test-abc123def456ghi', 'diff: +const leakedSecretVar=1'],
    });
    expect(s).not.toContain('raw-secret.json');
    expect(s).not.toContain('sk-test-abc123def456ghi');
    expect(s).not.toContain('leakedSecretVar');
  });
});

describe('createSelfEvolutionRejectLessonRecorder', () => {
  it('调 memoryWrite + recordEpisode，传脱敏 summary + 正确 kind', () => {
    const memoryWrite = vi.fn(() => ({ id: 'mem-1' }));
    const recordEpisode = vi.fn();
    const rec = createSelfEvolutionRejectLessonRecorder({ memoryWrite, recordEpisode, now: () => 1000 });
    const r = rec({ cycleId: 'c-1', goalId: 'g-1', objective: '改进 src/x.js', reviews: [{ model: 'm3', decision: 'reject' }], errors: ['无测试'] });
    expect(memoryWrite).toHaveBeenCalledTimes(1);
    expect(memoryWrite.mock.calls[0][0].kind).toBe('self_evolution_reject_lesson');
    expect(memoryWrite.mock.calls[0][0].projectId).toBe('noe'); // P0-1: 必须写 noe，否则 recall 搜 noe 召回恒 0（闭环不通电）
    expect(memoryWrite.mock.calls[0][0].sourceType).toBe('self_evolution_reject_lesson'); // P2-4: 精确召回锚点
    expect(memoryWrite.mock.calls[0][0].text).toContain('无测试');
    expect(recordEpisode).toHaveBeenCalledTimes(1);
    expect(r.ok).toBe(true);
    expect(r.memoryId).toBe('mem-1');
  });
  it('memoryWrite 抛错不阻断飞轮（episode 仍记）', () => {
    const memoryWrite = vi.fn(() => { throw new Error('db lock'); });
    const recordEpisode = vi.fn();
    const rec = createSelfEvolutionRejectLessonRecorder({ memoryWrite, recordEpisode });
    expect(() => rec({ cycleId: 'c-2', objective: 'x' })).not.toThrow();
    expect(recordEpisode).toHaveBeenCalledTimes(1);
  });
  it('无回调注入也不崩（全 null）', () => {
    const rec = createSelfEvolutionRejectLessonRecorder({});
    expect(() => rec({ cycleId: 'c-3', objective: 'x' })).not.toThrow();
  });
});
