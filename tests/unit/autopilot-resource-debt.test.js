import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nextScheduleRun } from '../../src/autopilot/AutopilotScheduleStore.js';
import { rotateJsonlIfLarge } from '../../src/autopilot/AutopilotStore.js';

// R2-P1（2026-07-03）：自愈资源债——schedule 无上界 do-while 补齐 + 日志无轮转。
describe('nextScheduleRun 一步跳算（无上界循环根治）', () => {
  it('正常：base 刚过期 → 跳一个 interval 到未来', () => {
    const next = nextScheduleRun({ scheduleKind: 'interval', intervalMs: 1000, nextRunAt: 5000 }, 5500);
    expect(next).toBe(6000);
  });

  it('停机数天 + interval=1s：一步算出且瞬间完成（旧 do-while 会迭代百万次）', () => {
    const base = 1_000_000;
    const ref = base + 7 * 24 * 3600 * 1000; // 停机 7 天
    const t0 = Date.now();
    const next = nextScheduleRun({ scheduleKind: 'interval', intervalMs: 1000, nextRunAt: base }, ref);
    const elapsed = Date.now() - t0;
    expect(next).toBeGreaterThan(ref);
    expect(next).toBe(base + (Math.floor((ref - base) / 1000) + 1) * 1000);
    expect(elapsed).toBeLessThan(50); // 常数时间，绝不是百万次循环
  });

  it('base 已在未来 → 跳 0 步返回 base', () => {
    expect(nextScheduleRun({ scheduleKind: 'interval', intervalMs: 1000, nextRunAt: 9000 }, 5000)).toBe(9000);
  });

  it('once schedule 返回 null', () => {
    expect(nextScheduleRun({ scheduleKind: 'once', intervalMs: 1000, nextRunAt: 1 }, 5000)).toBeNull();
  });
});

describe('rotateJsonlIfLarge 日志轮转', () => {
  it('超阈值 → 轮转为 .1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-log-'));
    try {
      const file = join(dir, 'log.jsonl');
      writeFileSync(file, 'x'.repeat(200));
      expect(rotateJsonlIfLarge(file, 100)).toBe(true);
      expect(existsSync(`${file}.1`)).toBe(true);
      expect(existsSync(file)).toBe(false); // 轮转后原文件让位，下次 append 重建
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('未超阈值 → 不动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-log2-'));
    try {
      const file = join(dir, 'log.jsonl');
      writeFileSync(file, 'x'.repeat(50));
      expect(rotateJsonlIfLarge(file, 100)).toBe(false);
      expect(existsSync(file)).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('文件不存在 → 安全返回 false', () => {
    expect(rotateJsonlIfLarge(join(tmpdir(), 'nope-does-not-exist.jsonl'), 100)).toBe(false);
  });
});
