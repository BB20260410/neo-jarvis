import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createTaskReportbackQueue } from '../../src/cognition/NoeTaskReportbackQueue.js';

describe('NoeTaskReportbackQueue', () => {
  it('records accepted/running/done events and consumes undelivered reportbacks', () => {
    let t = 1_780_000_000_000;
    let seq = 0;
    const q = createTaskReportbackQueue({ now: () => t += 100, idGen: () => `id-${++seq}`, speechLeaseMs: 1_000 });

    const accepted = q.add({ goalId: 'g-voice', title: '主人委托：排查语音', status: 'accepted', summary: '已接单' });
    const running = q.add({ goalId: 'g-voice', title: '主人委托：排查语音', status: 'running', kind: 'act', stepIndex: 0, summary: '行动执行中' });
    const done = q.add({ goalId: 'g-voice', title: '主人委托：排查语音', status: 'done', kind: 'act', stepIndex: 0, summary: '行动完成' });

    expect(accepted.speak).toBe(false);
    expect(done.speak).toBe(true);
    expect(q.current({ limit: 1 })[0]).toMatchObject({ id: done.id, status: 'done' });

    const items = q.consume({ limit: 10 });
    expect(items.map((x) => x.id)).toEqual([accepted.id, running.id, done.id]);
    expect(q.consume({ limit: 10 })).toHaveLength(0); // 租约期内不重复投递给其它页面/轮询
    t += 31_000;
    expect(q.consume({ limit: 10 }).map((x) => x.id)).toEqual([done.id]); // 租约过期后才允许重试
    q.markSpoken(done.id, { ok: true, at: t += 100 });
    expect(q.consume({ limit: 10 })).toHaveLength(0);
  });

  it('leases only one terminal speech report at a time across consumers', () => {
    let t = 1_780_000_005_000;
    let seq = 0;
    const q = createTaskReportbackQueue({ now: () => t += 100, idGen: () => `lease-${++seq}`, speechLeaseMs: 10_000 });
    const first = q.add({ goalId: 'g-1', title: '第一条', status: 'done', summary: '完成一' });
    const second = q.add({ goalId: 'g-2', title: '第二条', status: 'done', summary: '完成二' });

    expect(q.consume({ limit: 10 }).map((x) => x.id)).toEqual([first.id]);
    expect(q.consume({ limit: 10 })).toHaveLength(0);
    q.markSpoken(first.id, { ok: true, at: t += 100 });
    expect(q.consume({ limit: 10 }).map((x) => x.id)).toEqual([second.id]);
  });

  it('lets a server speech worker claim only new speech items', () => {
    let t = 1_780_000_020_000;
    let seq = 0;
    const q = createTaskReportbackQueue({ now: () => t += 100, idGen: () => `speech-${++seq}`, speechLeaseMs: 10_000 });
    q.add({ goalId: 'g-old', title: '旧完成', status: 'done', summary: '旧任务' });
    const workerStartedAt = t + 1;
    q.add({ goalId: 'g-run', title: '运行中', status: 'running', summary: '不该播' });
    const fresh = q.add({ goalId: 'g-new', title: '新完成', status: 'done', summary: '新任务' });

    const claimed = q.consumeSpeech({ since: workerStartedAt });
    expect(claimed.map((x) => x.id)).toEqual([fresh.id]);
    expect(q.consumeSpeech({ since: workerStartedAt })).toHaveLength(0);
    q.markSpoken(fresh.id, { ok: true, at: t += 100 });
    expect(q.consume({ limit: 10 }).map((x) => x.goalId)).toEqual(['g-old', 'g-run']);
  });

  it('keeps system repair terminal reportbacks visible but silent by default', () => {
    let t = 1_780_000_006_000;
    const q = createTaskReportbackQueue({ now: () => t += 100, idGen: () => 'repair-done' });
    const done = q.add({ goalId: 'g-repair', title: '系统自修复：任务回报链路', status: 'done', summary: '已完成' });

    expect(done.speak).toBe(false);
    expect(q.consume({ limit: 10 }).map((x) => x.id)).toEqual([done.id]);
    t += 31_000;
    expect(q.consume({ limit: 10 })).toHaveLength(0);
  });

  it('persists with private permissions and redacts secret-looking text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-task-reportbacks-'));
    const file = join(dir, 'task-reportbacks.json');
    try {
      const q = createTaskReportbackQueue({ file, idGen: () => 'fixed' });
      q.add({
        goalId: 'g-secret',
        title: '主人委托：检查配置',
        status: 'failed',
        summary: 'apiKey: "sk-test-secret-123456789" Bearer abcdefghijklmnopqrstuvwxyz',
      });
      expect(statSync(file).mode & 0o777).toBe(0o600);

      const reloaded = createTaskReportbackQueue({ file });
      const current = reloaded.current({ limit: 1 })[0];
      expect(current.summary).toContain('[REDACTED]');
      expect(JSON.stringify(current)).not.toContain('sk-test-secret');
      expect(JSON.stringify(current)).not.toContain('abcdefghijklmnopqrstuvwxyz');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks failed speech attempts as handled so terminal reports do not loop forever', () => {
    let t = 1_780_000_010_000;
    const q = createTaskReportbackQueue({ now: () => t += 100, idGen: () => 'speech-fail' });
    const done = q.add({ goalId: 'g-voice', title: '系统自修复：语音链路', status: 'done', summary: '已完成' });

    expect(q.consume({ limit: 10 }).map((x) => x.id)).toEqual([done.id]);
    const marked = q.markSpoken(done.id, { ok: false, error: 'play_start_timeout', at: t += 100, systemSpeechFallback: { attempted: true, command: 'afplay', provider: 'minimax' } });

    expect(marked.spokenAt).toBe(null);
    expect(marked.speechFailedAt).toBe(t);
    expect(marked.speechError).toContain('play_start_timeout');
    expect(marked.systemSpeechFallbackAt).toBe(t);
    expect(marked.systemSpeechFallback).toMatchObject({ attempted: true, command: 'afplay', provider: 'minimax' });
    expect(q.consume({ limit: 10 })).toHaveLength(0);
  });
});
