import { describe, expect, it } from 'vitest';
import { MiniMaxVideoClient } from '../../src/media/MiniMaxVideoClient.js';

// 波次5 P2 测试：视频客户端（fetch/sleep 注入，不真调不烧钱）。API 形状按官方文档。

function makeClient(routes, extra = {}) {
  return new MiniMaxVideoClient({
    apiKey: 'k',
    fetchImpl: async (url) => ({ json: async () => routes(String(url)) }),
    sleep: async () => {},
    ...extra,
  });
}

describe('MiniMaxVideoClient', () => {
  it('createTask 返回 task_id，请求打到 /video_generation', async () => {
    let posted = null;
    const c = new MiniMaxVideoClient({
      apiKey: 'k',
      fetchImpl: async (url, init) => { posted = { url: String(url), body: JSON.parse(init.body) }; return { json: async () => ({ task_id: 't-1', base_resp: { status_code: 0 } }) }; },
    });
    const r = await c.createTask('一只猫在太空行走');
    expect(r.taskId).toBe('t-1');
    expect(posted.url).toContain('/video_generation');
    expect(posted.body.model).toBe('video-01');
    expect(posted.body.prompt).toContain('太空');
  });

  it('queryTask 归一 status：Success→success / Fail→fail / 其他→pending', async () => {
    const c = makeClient(() => ({ status: 'Processing', base_resp: { status_code: 0 } }));
    expect((await c.queryTask('t')).status).toBe('pending');
    const c2 = makeClient(() => ({ status: 'Success', file_id: 'f-9', base_resp: { status_code: 0 } }));
    const q = await c2.queryTask('t');
    expect(q.status).toBe('success');
    expect(q.fileId).toBe('f-9');
  });

  it('generateAndWait 轮询到 success 返回 fileId', async () => {
    let polls = 0;
    const c = makeClient((url) => {
      if (url.includes('/query/')) {
        polls += 1;
        return polls < 3 ? { status: 'Processing', base_resp: { status_code: 0 } } : { status: 'Success', file_id: 'f-1', base_resp: { status_code: 0 } };
      }
      return { task_id: 't-1', base_resp: { status_code: 0 } };
    });
    const r = await c.generateAndWait('日落海面');
    expect(r).toEqual({ taskId: 't-1', fileId: 'f-1' });
    expect(polls).toBe(3);
  });

  it('任务 fail 抛错；abortSignal 可主动停（不设硬超时的安全阀）', async () => {
    const cf = makeClient((url) => (url.includes('/query/') ? { status: 'Fail', base_resp: { status_code: 0 } } : { task_id: 't', base_resp: { status_code: 0 } }));
    await expect(cf.generateAndWait('x')).rejects.toThrow(/任务失败/);
    const ctrl = new AbortController();
    ctrl.abort();
    const ca = makeClient((url) => (url.includes('/query/') ? { status: 'Processing', base_resp: { status_code: 0 } } : { task_id: 't', base_resp: { status_code: 0 } }));
    await expect(ca.generateAndWait('x', { abortSignal: ctrl.signal })).rejects.toThrow(/中止/);
  });

  it('错误体白名单：只透 status_code/status_msg，不带原始计费字段', async () => {
    const c = makeClient(() => ({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' }, billing_secret: 'LEAK' }));
    let err;
    try { await c.createTask('x'); } catch (e) { err = e; }
    expect(err.message).toContain('1008');
    expect(err.message).not.toContain('LEAK');
  });

  it('未配 key / 空 prompt 抛错', async () => {
    const c = new MiniMaxVideoClient({ secretResolver: () => ({ ok: false }), fetchImpl: async () => ({}) });
    await expect(c.createTask('x')).rejects.toThrow(/未配置/);
    const c2 = makeClient(() => ({}));
    await expect(c2.createTask('  ')).rejects.toThrow(/为空/);
  });
});
