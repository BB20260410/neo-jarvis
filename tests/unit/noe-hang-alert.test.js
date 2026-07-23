import { describe, expect, it } from 'vitest';
import { createHangAlertMonitor } from '../../src/autopilot/NoeHangAlert.js';

function makeMonitor(alertAfterMs = 1000) {
  let clock = 1000;
  const mon = createHangAlertMonitor({ now: () => clock, alertAfterMs });
  return { mon, advance: (ms) => { clock += ms; } };
}

describe('NoeHangAlert', () => {
  it('start/done 管理任务', () => {
    const { mon } = makeMonitor();
    expect(mon.start('job1')).toBe(true);
    expect(mon.start('')).toBe(false);
    expect(mon.size()).toBe(1);
    expect(mon.done('job1')).toBe(true);
    expect(mon.size()).toBe(0);
  });

  it('无心跳超阈值才告警，且绝不从监控里移除（不杀）', () => {
    const { mon, advance } = makeMonitor(1000);
    mon.start('job1');
    expect(mon.check()).toEqual([]); // 刚开始
    advance(500);
    expect(mon.check()).toEqual([]); // 未超
    advance(600); // 累计 1100 > 1000
    const stale = mon.check();
    expect(stale).toHaveLength(1);
    expect(stale[0].taskId).toBe('job1');
    expect(stale[0].firstAlert).toBe(true);
    expect(mon.size()).toBe(1); // 告警但不移除（不杀）
  });

  it('心跳续命：beat 后重新计时，告警清除', () => {
    const { mon, advance } = makeMonitor(1000);
    mon.start('job1');
    advance(1100);
    expect(mon.check()).toHaveLength(1); // 告警
    mon.beat('job1'); // 续命
    advance(500);
    expect(mon.check()).toEqual([]); // 续命后未超
    advance(600);
    const stale = mon.check();
    expect(stale[0].firstAlert).toBe(true); // beat 清了 alerted，再次告警是首次
  });

  it('firstAlert 只在首次告警为 true，后续为 false（防刷屏）', () => {
    const { mon, advance } = makeMonitor(1000);
    mon.start('job1');
    advance(1100);
    expect(mon.check()[0].firstAlert).toBe(true);
    advance(100);
    expect(mon.check()[0].firstAlert).toBe(false); // 已告警过
  });

  it('beat 不存在的任务返回 false', () => {
    const { mon } = makeMonitor();
    expect(mon.beat('missing')).toBe(false);
  });

  it('runningMs 反映总运行时长', () => {
    const { mon, advance } = makeMonitor(1000);
    mon.start('job1');
    advance(3000);
    expect(mon.check()[0].runningMs).toBe(3000);
  });
});
