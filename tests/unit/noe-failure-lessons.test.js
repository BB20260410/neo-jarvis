import { describe, it, expect, vi } from 'vitest';
import {
  classifyFailureRootCause,
  buildFailureLesson,
  createNoeFailureLessons,
} from '../../src/cognition/NoeFailureLessons.js';

describe('classifyFailureRootCause（确定性根因归一，恒 unverified）', () => {
  it('各类别命中', () => {
    expect(classifyFailureRootCause('error 61 wss://chatgpt.com connect refused').category).toBe('network');
    expect(classifyFailureRootCause('operation timed out').category).toBe('timeout');
    expect(classifyFailureRootCause('patch_path_policy_protected:tests/x').category).toBe('permission_policy');
    expect(classifyFailureRootCause('no_patch_plan_in_reply').category).toBe('patch_apply');
    expect(classifyFailureRootCause('runtime_verification failed: 3 tests failed').category).toBe('verify_test');
    expect(classifyFailureRootCause('adapter returned empty reply').category).toBe('model_adapter');
    expect(classifyFailureRootCause('ENOENT: file missing').category).toBe('not_found');
  });
  it('空 → unknown；未匹配 → other；全部 verified:false', () => {
    expect(classifyFailureRootCause('').category).toBe('unknown');
    expect(classifyFailureRootCause('完全无关的一句话').category).toBe('other');
    expect(classifyFailureRootCause('error 61').verified).toBe(false);
    expect(classifyFailureRootCause('').verified).toBe(false);
  });
});

describe('buildFailureLesson（type=feedback，根因未验证）', () => {
  it('title/body 明示未验证根因，scope/sourceType/confidence 正确', () => {
    const lesson = buildFailureLesson(
      { action: 'noe.self_evolution.implementation', status: 'failed', failure_reason: 'no_patch_plan', payload: { goalId: 'g-1' } },
      { now: () => 1_700_000_000_000 },
    );
    expect(lesson.scope).toBe('feedback');
    expect(lesson.sourceType).toBe('failure_lesson');
    expect(lesson.confidence).toBe('unverified');
    expect(lesson.title).toContain('未验证');
    expect(lesson.body).toContain('根因未验证');
    expect(lesson.body).toContain('noe.self_evolution.implementation');
    expect(lesson.body).toContain('g-1');
    expect(lesson.rootCause.category).toBe('patch_apply');
    expect(lesson.tags).toContain('rootcause:patch_apply');
  });
  it('failure_reason 中的 secret 被脱敏（不入正文原值）', () => {
    const lesson = buildFailureLesson(
      { action: 'x', status: 'failed', error: 'auth failed token=sk-ABCDEFGH12345678 boom' },
      { now: () => 1 },
    );
    expect(lesson.body).not.toContain('sk-ABCDEFGH12345678');
  });
});

describe('createNoeFailureLessons.observe', () => {
  it('非失败 act → 不写记忆', () => {
    const memoryWrite = vi.fn(() => ({ id: 'm' }));
    const fl = createNoeFailureLessons({ memoryWrite, now: () => 1000 });
    expect(fl.observe({ action: 'x', status: 'done' })).toMatchObject({ ok: true, created: false, reason: 'not_failed' });
    expect(memoryWrite).not.toHaveBeenCalled();
  });

  it('失败 act → 写 type=feedback failure_lesson 记忆，返回 created+memoryId', () => {
    const memoryWrite = vi.fn(() => ({ id: 'mem-9' }));
    const fl = createNoeFailureLessons({ memoryWrite, now: () => 1000 });
    const r = fl.observe({ action: 'noe.self_evolution.implementation', status: 'failed', failure_reason: 'no_patch_plan' });
    expect(r).toMatchObject({ ok: true, created: true, memoryId: 'mem-9' });
    expect(memoryWrite).toHaveBeenCalledTimes(1);
    const entry = memoryWrite.mock.calls[0][0];
    expect(entry.scope).toBe('feedback');
    expect(entry.sourceType).toBe('failure_lesson');
    expect(entry.confidence).toBe('unverified');
  });

  it('去重：同 action+根因类别 cooldown 内只写一次', () => {
    let t = 1000;
    const memoryWrite = vi.fn(() => ({ id: 'm' }));
    const fl = createNoeFailureLessons({ memoryWrite, now: () => t, cooldownMs: 30 * 60_000 });
    fl.observe({ action: 'a', status: 'failed', error: 'error 61 network' });
    t += 60_000; // 1min 后同类失败
    const r2 = fl.observe({ action: 'a', status: 'failed', error: 'error 61 network again' });
    expect(r2).toMatchObject({ created: false, deduped: true });
    expect(memoryWrite).toHaveBeenCalledTimes(1);
    t += 31 * 60_000; // 过 cooldown
    const r3 = fl.observe({ action: 'a', status: 'failed', error: 'error 61 network' });
    expect(r3.created).toBe(true);
    expect(memoryWrite).toHaveBeenCalledTimes(2);
  });

  it('不同根因类别不互相去重', () => {
    const memoryWrite = vi.fn(() => ({ id: 'm' }));
    const fl = createNoeFailureLessons({ memoryWrite, now: () => 1000 });
    fl.observe({ action: 'a', status: 'failed', error: 'error 61 network' });
    fl.observe({ action: 'a', status: 'failed', error: 'operation timed out' }); // 不同类别
    expect(memoryWrite).toHaveBeenCalledTimes(2);
  });

  it('memoryWrite 未注入 → memory_write_unavailable', () => {
    const fl = createNoeFailureLessons({ now: () => 1000 });
    expect(fl.observe({ action: 'x', status: 'failed', error: 'boom' })).toMatchObject({ ok: false, reason: 'memory_write_unavailable' });
  });
});
