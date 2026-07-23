// @ts-check
// /api/noe/media/* — MiniMax 媒体生成端点（图像/音乐/视频），接 NoeMediaStudio 落盘。
//
// 生成烧 MiniMax 配额 → 全部 requireOwnerToken；key 未配置返 501（同 proactive 模式）。
// 视频是异步任务制：POST 提交拿 taskId，GET /video/:taskId 轮询，success 自动落盘。
// 图像/音乐同步等完（分钟级，不设硬超时）。opts 白名单透传，不直接 spread body。

import { requireOwnerToken } from '../auth/owner-token.js';

const MAX_PROMPT = 2000;
const MAX_LYRICS = 3500;
const MAX_FRAME_B64 = 10_000_000;   // image-to-video 首帧 base64 上限 ~10MB
const TASK_ID_RE = /^[\w-]{1,80}$/;

function cleanPrompt(v) {
  const s = String(v || '').trim();
  return s.length > 0 && s.length <= MAX_PROMPT ? s : '';
}

export function registerNoeMediaRoutes(app, { studio, sendError } = {}) {
  const ensureConfigured = (res) => {
    if (studio?.configured?.()) return true;
    res.status(501).json({ ok: false, error: 'MiniMax key 未配置，媒体生成不可用' });
    return false;
  };

  app.post('/api/noe/media/image', requireOwnerToken, async (req, res) => {
    try {
      if (!ensureConfigured(res)) return undefined;
      const body = req.body || {};
      const prompt = cleanPrompt(body.prompt);
      if (!prompt) return res.status(400).json({ ok: false, error: `prompt required（非空且 ≤${MAX_PROMPT} 字符）` });
      const result = await studio.image(prompt, {
        aspectRatio: typeof body.aspectRatio === 'string' ? body.aspectRatio : undefined,
        n: body.n,
        promptOptimizer: body.promptOptimizer,
      });
      return res.json(result);
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/media/music', requireOwnerToken, async (req, res) => {
    try {
      if (!ensureConfigured(res)) return undefined;
      const body = req.body || {};
      const prompt = cleanPrompt(body.prompt);
      if (!prompt) return res.status(400).json({ ok: false, error: `prompt required（非空且 ≤${MAX_PROMPT} 字符）` });
      if (body.lyrics && (typeof body.lyrics !== 'string' || body.lyrics.length > MAX_LYRICS)) {
        return res.status(400).json({ ok: false, error: `lyrics 非法（string ≤${MAX_LYRICS} 字符）` });
      }
      const result = await studio.music(prompt, {
        lyrics: body.lyrics,
        instrumental: body.instrumental === true,
        lyricsOptimizer: body.lyricsOptimizer === true,
        outputFormat: body.outputFormat === 'wav' ? 'wav' : undefined,
      });
      return res.json(result);
    } catch (e) { return sendError(res, e); }
  });

  app.post('/api/noe/media/video', requireOwnerToken, async (req, res) => {
    try {
      if (!ensureConfigured(res)) return undefined;
      const body = req.body || {};
      const prompt = cleanPrompt(body.prompt);
      if (!prompt) return res.status(400).json({ ok: false, error: `prompt required（非空且 ≤${MAX_PROMPT} 字符）` });
      if (body.firstFrameImage && (typeof body.firstFrameImage !== 'string' || body.firstFrameImage.length > MAX_FRAME_B64)) {
        return res.status(413).json({ ok: false, error: 'firstFrameImage 过大（base64 ≤10MB）' });
      }
      const result = await studio.videoCreate(prompt, {
        firstFrameImage: body.firstFrameImage || undefined,
      });
      return res.json(result);
    } catch (e) { return sendError(res, e); }
  });

  app.get('/api/noe/media/video/:taskId', requireOwnerToken, async (req, res) => {
    try {
      if (!ensureConfigured(res)) return undefined;
      const taskId = String(req.params?.taskId || '');
      if (!TASK_ID_RE.test(taskId)) return res.status(400).json({ ok: false, error: 'taskId 非法' });
      const result = await studio.videoPoll(taskId);
      return res.json(result);
    } catch (e) { return sendError(res, e); }
  });
}
