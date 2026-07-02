// A3 死前留痕：心跳落盘 + exit 遗言 + 启动报告（硬死=有心跳无遗言 → warn 最后心跳数据）。
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { analyzeLastExit, installProcessVitals } from '../../src/runtime/NoeProcessVitals.js';

function fakeProc() {
  const p = new EventEmitter();
  p.pid = 12345;
  p.memoryUsage = () => ({ rss: 200 * 1024 * 1024, heapUsed: 80 * 1024 * 1024 });
  p.uptime = () => 360;
  return p;
}

function tmpFile() {
  return join(mkdtempSync(join(tmpdir(), 'vitals-')), 'last-exit.json');
}

describe('analyzeLastExit', () => {
  it('无记录=首次运行；exited code=0 正常；code≠0 异常', () => {
    expect(analyzeLastExit(null).kind).toBe('first_run');
    expect(analyzeLastExit({ status: 'exited', code: 0 }).kind).toBe('clean_exit');
    expect(analyzeLastExit({ status: 'exited', code: 1 }).kind).toBe('error_exit');
  });

  it('running 无遗言 = 硬死，报告带最后心跳', () => {
    const r = analyzeLastExit({ status: 'running', lastVitals: { at: 'T', rss: 500 * 1024 * 1024, heapUsed: 1024 * 1024, uptimeSec: 600 } });
    expect(r.kind).toBe('hard_death');
    expect(r.message).toContain('疑 OOM/SIGKILL');
    expect(r.message).toContain('500MB');
    expect(r.message).toContain('10min');
  });
});

describe('installProcessVitals', () => {
  it('启动写 running+心跳；exit 同步写遗言', () => {
    const file = tmpFile();
    const proc = fakeProc();
    const logs = [];
    const { report, stop } = installProcessVitals({ file, proc, intervalMs: 999999, log: (m) => logs.push(m), warn: (m) => logs.push(m), now: () => 'T0' });
    expect(report.kind).toBe('first_run');
    const running = JSON.parse(readFileSync(file, 'utf-8'));
    expect(running.status).toBe('running');
    expect(running.lastVitals.rss).toBe(200 * 1024 * 1024);
    proc.emit('exit', 0);
    const exited = JSON.parse(readFileSync(file, 'utf-8'));
    expect(exited.status).toBe('exited');
    expect(exited.code).toBe(0);
    stop();
  });

  it('上次硬死（running 残留）→ 这次启动 warn', () => {
    const file = tmpFile();
    writeFileSync(file, JSON.stringify({ status: 'running', lastVitals: { at: 'T-1', rss: 1, heapUsed: 1, uptimeSec: 60 } }));
    const warns = [];
    const { report, stop } = installProcessVitals({ file, proc: fakeProc(), intervalMs: 999999, log: () => {}, warn: (m) => warns.push(m) });
    expect(report.kind).toBe('hard_death');
    expect(warns.length).toBe(1);
    stop();
  });
});
