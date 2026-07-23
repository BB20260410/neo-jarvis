import { describe, it, expect } from 'vitest';
import { VisionSession } from '../../src/vision/VisionSession.js';

describe('VisionSession', () => {
  it('并发重入保护（H2）：3 个并发 glance 只截屏+VLM 一次', async () => {
    let captures = 0;
    let describes = 0;
    const vs = new VisionSession({
      capturer: { capture: async () => { captures++; await new Promise((r) => setTimeout(r, 20)); return Buffer.from('frame'); } },
      vlmClient: { describe: async () => { describes++; return '用户在写代码'; } },
      mode: 'screen',
    });
    const [a, b, c] = await Promise.all([vs.glance(), vs.glance(), vs.glance()]);
    expect(captures).toBe(1);
    expect(describes).toBe(1);
    expect(a.summary).toBe('用户在写代码');
    expect(b.summary).toBe('用户在写代码');
    expect(c.summary).toBe('用户在写代码');
  });

  it('串行 glance 各自执行（in-flight 已清）', async () => {
    let captures = 0;
    const vs = new VisionSession({
      capturer: { capture: async () => { captures++; return Buffer.from('frame' + captures); } },
      vlmClient: { describe: async () => 'desc' },
      mode: 'screen',
    });
    await vs.glance();
    await vs.glance({ force: true });
    expect(captures).toBe(2);
  });

  it('变化检测：同一帧第二次 glance 跳过 VLM', async () => {
    let describes = 0;
    const vs = new VisionSession({
      capturer: { capture: async () => Buffer.from('same-frame') },
      vlmClient: { describe: async () => { describes++; return 'desc'; } },
      mode: 'screen',
    });
    await vs.glance();
    const second = await vs.glance();
    expect(describes).toBe(1);
    expect(second.skipped).toBe('no_change');
  });

  it('latest() 返回最近摘要，未 glance 前为 null', async () => {
    const vs = new VisionSession({
      capturer: { capture: async () => Buffer.from('x') },
      vlmClient: { describe: async () => '看到终端' },
      mode: 'screen',
    });
    expect(vs.latest()).toBe(null);
    await vs.glance();
    expect(vs.latest().summary).toBe('看到终端');
    expect(vs.latest().mode).toBe('screen');
    expect(vs.latest().situation).toMatchObject({ activity: 'coding', stale: false });
  });

  it('摄像头模式没有帧时不退回屏幕截图', async () => {
    let captures = 0;
    let describes = 0;
    const vs = new VisionSession({
      capturer: { capture: async () => { captures++; return Buffer.from('screen'); } },
      vlmClient: { describe: async () => { describes++; return '不应调用'; } },
      mode: 'camera',
    });
    const out = await vs.glance({ force: true });
    expect(out).toMatchObject({ summary: '', at: null, mode: 'camera', skipped: 'no_camera_frame' });
    expect(captures).toBe(0);
    expect(describes).toBe(0);
    expect(vs.latest()).toBe(null);
  });

  it('ambient status exposes opt-in mode and clears camera frame when disabled', () => {
    const vs = new VisionSession({ mode: 'off', vlmClient: { unload: async () => true } });
    const enabled = vs.configureAmbient({ enabled: true, mode: 'both', screenSampleMs: 6000, cameraFrameMs: 1500, source: 'test' });
    expect(enabled).toMatchObject({
      enabled: true,
      mode: 'both',
      localOnly: true,
      requiresCameraFramePush: true,
      cameraFrameReady: false,
      screenSampleMs: 6000,
      cameraFrameMs: 1500,
      source: 'test',
    });
    vs.pushFrame(Buffer.from('camera'), 'jpeg');
    expect(vs.ambientStatus().cameraFrameReady).toBe(true);

    const disabled = vs.configureAmbient({ enabled: false, source: 'test-off' });
    expect(disabled).toMatchObject({ enabled: false, mode: 'off', cameraFrameReady: false, source: 'test-off' });
    expect(vs.getCameraFrame()).toBeNull();
    expect(vs.latest()).toBeNull();
  });

  it('图片附件描述不切换视觉模式，并进入 latest 供对话使用', async () => {
    let described = 0;
    const vs = new VisionSession({
      vlmClient: { describe: async (_buf, prompt) => { described++; expect(prompt).toContain('图片附件'); return '一张菜单截图'; } },
      mode: 'off',
    });
    const out = await vs.describeAttachment(Buffer.from('image'), { name: 'menu.jpg', format: 'jpeg' });
    expect(described).toBe(1);
    expect(vs.mode).toBe('off');
    expect(out.mode).toBe('attachment');
    expect(vs.latest().summary).toContain('menu.jpg');
    expect(vs.latest().summary).toContain('一张菜单截图');
    expect(vs.latest().mode).toBe('attachment');
    expect(vs.latest().situation).toMatchObject({ mode: 'attachment' });
  });

  it('ambient status includes the latest structured situation', async () => {
    const vs = new VisionSession({
      capturer: { capture: async () => Buffer.from('x') },
      vlmClient: { describe: async () => '用户在多个窗口之间频繁切换任务' },
      mode: 'screen',
    });
    await vs.glance();
    const status = vs.ambientStatus();
    expect(status.latest.situation).toMatchObject({
      activity: 'task_switching',
      attention: 'distracted',
      possibleNeed: 'task_refocus',
      shouldInterrupt: true,
    });
    expect(status.situation).toEqual(status.latest.situation);
  });

  it('ambientTick respects sample cadence and force bypasses it', async () => {
    let captures = 0;
    let describes = 0;
    const vs = new VisionSession({
      capturer: { capture: async () => { captures++; return Buffer.from(`frame-${captures}`); } },
      vlmClient: { describe: async () => { describes++; return `用户在写代码 ${describes}`; } },
      mode: 'screen',
    });
    vs.configureAmbient({ enabled: true, mode: 'screen', screenSampleMs: 5000, source: 'unit' });

    const first = await vs.ambientTick({ now: 1000 });
    expect(first).toMatchObject({ sampled: true, lastSampleAt: 1000, nextSampleAt: 6000 });
    expect(captures).toBe(1);
    expect(describes).toBe(1);

    const skipped = await vs.ambientTick({ now: 2000 });
    expect(skipped).toMatchObject({ sampled: false, skipped: 'ambient_not_due', lastSampleAt: 1000, nextSampleAt: 6000 });
    expect(captures).toBe(1);
    expect(describes).toBe(1);

    const forced = await vs.ambientTick({ force: true, now: 2000 });
    expect(forced).toMatchObject({ sampled: true, lastSampleAt: 2000, nextSampleAt: 7000 });
    expect(captures).toBe(2);
    expect(describes).toBe(2);

    const status = vs.ambientStatus(3000);
    expect(status).toMatchObject({
      sampleIntervalMs: 5000,
      ambientDue: false,
      lastAmbientSampleAt: 2000,
      nextAmbientSampleAt: 7000,
      lastAmbientSkipped: null,
    });
  });
});
