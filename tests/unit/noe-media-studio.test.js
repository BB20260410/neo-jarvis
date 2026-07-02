import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MiniMaxVideoClient } from '../../src/media/MiniMaxVideoClient.js';
import { NoeMediaStudio, mediaFileSlug } from '../../src/media/NoeMediaStudio.js';

// P1 媒体接线测试：client/fetch 全注入不真调不烧额度；落盘走真 tmp 目录验证字节与权限。

const FIXED_TS = Date.UTC(2026, 5, 10, 12, 0, 0);

describe('mediaFileSlug', () => {
  it('时间戳 + prompt 头部清洗（只留汉字英数，其余折叠成 _）', () => {
    const slug = mediaFileSlug('一只猫: 在/太空…walking!', FIXED_TS);
    expect(slug).toBe('20260610120000-一只猫_在_太空_walking');
  });

  it('空 prompt 只剩时间戳；超长截断不超 24 字符头部', () => {
    expect(mediaFileSlug('', FIXED_TS)).toBe('20260610120000');
    const slug = mediaFileSlug('x'.repeat(100), FIXED_TS);
    expect(slug.length).toBeLessThanOrEqual(14 + 1 + 24);
  });

  it('纯符号 prompt 清洗成空后回退纯时间戳（不留悬空连字符）', () => {
    expect(mediaFileSlug('!!!///:::', FIXED_TS)).toBe('20260610120000');
  });
});

describe('NoeMediaStudio', () => {
  let dir;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'noe-media-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function makeStudio(overrides = {}) {
    return new NoeMediaStudio({ baseDir: dir, now: () => FIXED_TS, ...overrides });
  }

  it('configured：任一 client 有 key 即 true，全无 / 全未注入为 false', () => {
    expect(makeStudio().configured()).toBe(false);
    expect(makeStudio({ imageClient: { configured: () => false } }).configured()).toBe(false);
    expect(makeStudio({ musicClient: { configured: () => true } }).configured()).toBe(true);
  });

  it('image：默认请求 base64 直返（绕 OSS 下载）；url 与 base64 混合均能落盘，文件名带序号，权限 0600', async () => {
    let seenOpts = null;
    const studio = makeStudio({
      imageClient: { generate: async (_p, opts) => { seenOpts = opts; return { images: [{ url: 'https://x/u1.png', base64: null }, { url: null, base64: Buffer.from('img2').toString('base64') }], id: 'img-id' }; } },
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('img1') }),
    });
    const r = await studio.image('一只猫');
    expect(seenOpts.responseFormat).toBe('base64');
    expect(r.ok).toBe(true);
    expect(r.id).toBe('img-id');
    expect(r.files).toHaveLength(2);
    expect(r.files[0]).toContain(join('images', '20260610120000-一只猫-1.png'));
    expect(readFileSync(r.files[0], 'utf-8')).toBe('img1');
    expect(readFileSync(r.files[1], 'utf-8')).toBe('img2');
    expect(statSync(r.files[0]).mode & 0o777).toBe(0o600);
  });

  it('image：下载非 2xx 抛错不留半截产物记录', async () => {
    const studio = makeStudio({
      imageClient: { generate: async () => ({ images: [{ url: 'https://x/u1.png', base64: null }], id: null }) },
      fetchImpl: async () => ({ ok: false, status: 403 }),
    });
    await expect(studio.image('猫')).rejects.toThrow(/下载失败.*403/);
  });

  it('image：未注入 client 报错', async () => {
    await expect(makeStudio().image('猫')).rejects.toThrow(/未注入/);
  });

  it('下载 0 字节（200 但传输中断）→ 抛错不落坏件', async () => {
    const studio = makeStudio({
      imageClient: { generate: async () => ({ images: [{ url: 'https://oss/x.png', base64: null }], id: null }) },
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }),
    });
    await expect(studio.image('猫')).rejects.toThrow(/0 字节|传输中断/);
  });

  it('下载前检查 content-length 并拒绝超大媒体', async () => {
    const studio = makeStudio({
      musicClient: { generate: async () => ({ audioUrl: 'https://oss/huge.mp3', audioBase64: null }) },
      fetchImpl: async () => ({
        ok: true,
        headers: { get: (k) => (String(k).toLowerCase() === 'content-length' ? String(51 * 1024 * 1024) : null) },
        arrayBuffer: async () => Buffer.from('should-not-read'),
      }),
    });
    await expect(studio.music('超大音频')).rejects.toThrow(/媒体下载过大/);
  });

  it('music：base64 直落盘 mp3；outputFormat=wav 时扩展名 wav', async () => {
    const studio = makeStudio({
      musicClient: { generate: async () => ({ audioUrl: null, audioBase64: Buffer.from('song').toString('base64') }) },
    });
    const r = await studio.music('钢琴雨夜', { outputFormat: 'wav' });
    expect(r.files[0].endsWith('.wav')).toBe(true);
    expect(readFileSync(r.files[0], 'utf-8')).toBe('song');
    const r2 = await studio.music('钢琴雨夜');
    expect(r2.files[0].endsWith('.mp3')).toBe(true);
  });

  it('同秒同 prompt 二次生成不覆盖（自增后缀保住每件产物）', async () => {
    const studio = makeStudio({
      musicClient: { generate: async () => ({ audioUrl: null, audioBase64: Buffer.from('s').toString('base64') }) },
    });
    const a = await studio.music('同一首');
    const b = await studio.music('同一首');   // now 固定→slug 同名，必须不覆盖
    expect(a.files[0]).not.toBe(b.files[0]);
    expect(b.files[0]).toMatch(/-2\.mp3$/);
    expect(existsSync(a.files[0]) && existsSync(b.files[0])).toBe(true);
  });

  it('music：audioUrl 路真走下载', async () => {
    let fetched = null;
    const studio = makeStudio({
      musicClient: { generate: async () => ({ audioUrl: 'https://x/a.mp3', audioBase64: null }) },
      fetchImpl: async (url) => { fetched = String(url); return { ok: true, arrayBuffer: async () => Buffer.from('au') }; },
    });
    const r = await studio.music('海浪');
    expect(fetched).toBe('https://x/a.mp3');
    expect(readFileSync(r.files[0], 'utf-8')).toBe('au');
  });

  it('下载默认带直连 dispatcher 绕全局代理（国内 OSS 走代理 TLS 必断）；注入 null 则不带', async () => {
    let seenInit = null;
    const fetchImpl = async (_url, init) => { seenInit = init; return { ok: true, arrayBuffer: async () => Buffer.from('b') }; };
    const withDefault = makeStudio({
      musicClient: { generate: async () => ({ audioUrl: 'https://oss/a.mp3', audioBase64: null }) },
      fetchImpl,
    });
    await withDefault.music('浪');
    expect(seenInit.dispatcher).toBeTruthy();

    const viaGlobal = makeStudio({
      musicClient: { generate: async () => ({ audioUrl: 'https://oss/a.mp3', audioBase64: null }) },
      fetchImpl,
      downloadDispatcher: null,
    });
    await viaGlobal.music('浪');
    expect(seenInit.dispatcher).toBeUndefined();
  });

  it('videoCreate 透传 taskId；videoPoll pending 不落盘、fail 标 ok:false', async () => {
    const studio = makeStudio({
      videoClient: {
        createTask: async () => ({ taskId: 't-7' }),
        queryTask: async (id) => (id === 'pend' ? { status: 'pending', fileId: null } : { status: 'fail', fileId: null }),
      },
    });
    expect((await studio.videoCreate('猫走路')).taskId).toBe('t-7');
    expect(await studio.videoPoll('pend')).toMatchObject({ ok: true, status: 'pending' });
    expect(await studio.videoPoll('failed')).toMatchObject({ ok: false, status: 'fail' });
  });

  it('videoPoll success：file_id→download_url→下载→落盘 mp4，文件名含完整 taskId', async () => {
    const studio = makeStudio({
      videoClient: {
        queryTask: async () => ({ status: 'success', fileId: 'f-1' }),
        retrieveFile: async (fid) => { expect(fid).toBe('f-1'); return { downloadUrl: 'https://x/v.mp4' }; },
      },
      fetchImpl: async () => ({ ok: true, arrayBuffer: async () => Buffer.from('vid') }),
    });
    const r = await studio.videoPoll('task-9988776655');
    expect(r.status).toBe('success');
    expect(r.files[0].endsWith('.mp4')).toBe(true);
    expect(r.files[0]).toContain('videos');
    expect(r.files[0]).toContain('task-9988776655');   // 完整 taskId 不被截断，唯一性不削弱
    expect(readFileSync(r.files[0], 'utf-8')).toBe('vid');
  });

  it('videoPoll success 但缺 file_id → 明确返回 fail，不把 null 喂进 retrieveFile', async () => {
    let retrieved = false;
    const studio = makeStudio({
      videoClient: {
        queryTask: async () => ({ status: 'success', fileId: null }),
        retrieveFile: async () => { retrieved = true; return { downloadUrl: 'x' }; },
      },
    });
    const r = await studio.videoPoll('t-x');
    expect(r).toMatchObject({ ok: false, status: 'fail', reason: 'success 但无 file_id' });
    expect(retrieved).toBe(false);
  });
});

describe('MiniMaxVideoClient.retrieveFile（本轮补的步骤③）', () => {
  it('请求打到 /files/retrieve 并返回 download_url', async () => {
    let url = null;
    const c = new MiniMaxVideoClient({
      apiKey: 'k',
      fetchImpl: async (u) => { url = String(u); return { json: async () => ({ file: { download_url: 'https://dl/x.mp4' }, base_resp: { status_code: 0 } }) }; },
    });
    const r = await c.retrieveFile('f-9');
    expect(url).toContain('/files/retrieve?file_id=f-9');
    expect(r.downloadUrl).toBe('https://dl/x.mp4');
  });

  it('错误码走白名单错误；无 download_url 明确报错；空 file_id 拒绝', async () => {
    const cErr = new MiniMaxVideoClient({ apiKey: 'k', fetchImpl: async () => ({ json: async () => ({ base_resp: { status_code: 1004, status_msg: 'no auth' } }) }) });
    await expect(cErr.retrieveFile('f')).rejects.toThrow(/1004/);
    const cEmpty = new MiniMaxVideoClient({ apiKey: 'k', fetchImpl: async () => ({ json: async () => ({ file: {}, base_resp: { status_code: 0 } }) }) });
    await expect(cEmpty.retrieveFile('f')).rejects.toThrow(/download_url/);
    const cNoId = new MiniMaxVideoClient({ apiKey: 'k', fetchImpl: async () => ({ json: async () => ({}) }) });
    await expect(cNoId.retrieveFile('')).rejects.toThrow(/file_id 为空/);
  });
});
