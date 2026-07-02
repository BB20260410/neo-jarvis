import { describe, expect, it } from 'vitest';
import {
  buildImageRequest,
  parseImageResponse,
  MiniMaxImageClient,
} from '../../src/media/MiniMaxImageClient.js';

describe('buildImageRequest', () => {
  it('默认字段', () => {
    expect(buildImageRequest('一只猫')).toEqual({
      model: 'image-01', prompt: '一只猫', aspect_ratio: '1:1',
      response_format: 'url', n: 1, prompt_optimizer: true,
    });
  });
  it('空 prompt 抛错', () => {
    expect(() => buildImageRequest('   ')).toThrow(/prompt 为空/);
  });
  it('n 夹在 1..9', () => {
    expect(buildImageRequest('x', { n: 0 }).n).toBe(1);
    expect(buildImageRequest('x', { n: 20 }).n).toBe(9);
  });
  it('responseFormat 仅 url/base64', () => {
    expect(buildImageRequest('x', { responseFormat: 'base64' }).response_format).toBe('base64');
    expect(buildImageRequest('x', { responseFormat: 'bogus' }).response_format).toBe('url');
  });
});

describe('parseImageResponse', () => {
  it('解析 image_urls', () => {
    const r = parseImageResponse({ id: 'g1', data: { image_urls: ['http://a/1.png'] }, base_resp: { status_code: 0 } });
    expect(r.images).toEqual([{ url: 'http://a/1.png', base64: null }]);
    expect(r.id).toBe('g1');
  });
  it('解析 image_base64', () => {
    const r = parseImageResponse({ data: { image_base64: ['QQ=='] } });
    expect(r.images).toEqual([{ url: null, base64: 'QQ==' }]);
  });
  it('status_code!=0 抛错且不泄露原始错误体', () => {
    let err;
    try {
      parseImageResponse({ base_resp: { status_code: 1004, status_msg: 'auth failed', raw_billing: 'SECRET-LEAK' } });
    } catch (e) { err = e; }
    expect(err.statusCode).toBe(1004);
    expect(err.message).toContain('1004');
    expect(err.message).toContain('auth failed');
    expect(err.message).not.toContain('SECRET-LEAK');
  });
  it('无图返回抛错', () => {
    expect(() => parseImageResponse({ data: {}, base_resp: { status_code: 0 } })).toThrow(/无返回/);
  });
});

describe('MiniMaxImageClient', () => {
  it('注入 apiKey → configured', () => {
    const c = new MiniMaxImageClient({ apiKey: 'k', fetchImpl: async () => ({}) });
    expect(c.configured()).toBe(true);
    expect(c.secretStatus.source).toBe('caller');
  });

  it('未配 key → generate 抛错', async () => {
    const c = new MiniMaxImageClient({ secretResolver: () => ({ ok: false }), fetchImpl: async () => ({}) });
    expect(c.configured()).toBe(false);
    await expect(c.generate('x')).rejects.toThrow(/未配置/);
  });

  it('generate 用注入 fetch 返回 images，请求头带 Bearer', async () => {
    let seen = null;
    const fetchImpl = async (url, init) => {
      seen = { url, init };
      return { json: async () => ({ data: { image_urls: ['http://a/x.png'] }, base_resp: { status_code: 0 } }) };
    };
    const c = new MiniMaxImageClient({ apiKey: 'k', fetchImpl });
    const r = await c.generate('赛博城市', { aspectRatio: '16:9' });
    expect(r.images[0].url).toBe('http://a/x.png');
    expect(seen.init.headers.Authorization).toBe('Bearer k');
    expect(JSON.parse(seen.init.body)).toMatchObject({ model: 'image-01', aspect_ratio: '16:9' });
  });

  it('默认不设硬超时（feedback_no_model_timeout）', () => {
    const c = new MiniMaxImageClient({ apiKey: 'k' });
    expect(c.timeoutMs).toBe(null);
  });
});
