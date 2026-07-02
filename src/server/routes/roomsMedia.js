// @ts-check
// Noe — rooms-advanced 域 routes ③：房间媒体附件 + chat (S23)
// 从 server.js 提取 3 条路由（拆前行号 2957-3240）：POST /api/rooms/:id/media + GET /api/rooms/:id/media/:mediaId
// + POST /api/rooms/:id/chat，行为完全一致。三条必须同模块：chat 经 resolveRoomMediaRefs → roomMediaPublic。
// media helper 全家（5 组常量 + 纯函数）整体随迁模块顶层；roomMediaStorageDir 依赖 server.js 的
// ROOM_MEDIA_DIR（deps 注入），故移入 register 闭包内，其余 helper 与拆前逐字一致。
// roomStore/safeSlice/send500/ROOM_MEDIA_DIR/soloChatDispatcher 走 deps 注入。

import { createHash, randomUUID } from 'crypto';
import { existsSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, sep } from 'path';
import { requireOwnerToken } from '../auth/owner-token.js';

const ROOM_MEDIA_MAX_BYTES = 120 * 1024 * 1024;
const ROOM_MEDIA_MAX_PER_MESSAGE = 8;
const ROOM_MEDIA_ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
]);
const ROOM_MEDIA_EXT_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};
const ROOM_MEDIA_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
};

function roomMediaKind(mime) {
  return String(mime || '').startsWith('video/') ? 'video' : 'image';
}

function roomMediaHeaderName(req) {
  const raw = req.headers['x-file-name'] || 'media';
  try { return decodeURIComponent(String(raw)); } catch { return String(raw); }
}

function roomMediaSafeName(name) {
  const cleaned = String(name || 'media')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return cleaned || 'media';
}

function parseMultipartHeaderParams(value = '') {
  const params = {};
  for (const part of String(value || '').split(';').slice(1)) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim().toLowerCase();
    let val = part.slice(idx + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    params[key] = val;
  }
  return params;
}

function parseMultipartHeaders(text = '') {
  const headers = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key) headers[key] = value;
  }
  return headers;
}

function roomMediaExtractMultipart(buffer, contentType = '') {
  const boundaryMatch = String(contentType || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = (boundaryMatch?.[1] || boundaryMatch?.[2] || '').trim();
  if (!boundary || boundary.length > 200) return { error: 'multipart boundary invalid' };
  const delimiter = Buffer.from(`--${boundary}`, 'latin1');
  const nextDelimiter = Buffer.from(`\r\n--${boundary}`, 'latin1');
  let cursor = buffer.indexOf(delimiter);
  while (cursor >= 0) {
    let headerStart = cursor + delimiter.length;
    if (buffer[headerStart] === 45 && buffer[headerStart + 1] === 45) break;
    if (buffer[headerStart] === 13 && buffer[headerStart + 1] === 10) headerStart += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n', 'latin1'), headerStart);
    if (headerEnd < 0) break;
    const headers = parseMultipartHeaders(buffer.slice(headerStart, headerEnd).toString('latin1'));
    const dataStart = headerEnd + 4;
    const dataEnd = buffer.indexOf(nextDelimiter, dataStart);
    if (dataEnd < 0) break;
    const disposition = headers['content-disposition'] || '';
    const params = parseMultipartHeaderParams(disposition);
    const fieldName = String(params.name || '').toLowerCase();
    const fileName = params.filename || params['filename*'] || '';
    const looksLikeFile = Boolean(fileName)
      || ['file', 'media', 'attachment', 'upload'].includes(fieldName)
      || String(headers['content-type'] || '').startsWith('image/')
      || String(headers['content-type'] || '').startsWith('video/');
    if (looksLikeFile) {
      return {
        buffer: buffer.slice(dataStart, dataEnd),
        originalName: fileName || fieldName || 'media',
        mime: headers['content-type'] || '',
      };
    }
    cursor = buffer.indexOf(delimiter, dataEnd + nextDelimiter.length);
  }
  return { error: 'multipart file field not found' };
}

function roomMediaExtractUpload(req, buffer) {
  const contentType = String(req.headers['content-type'] || '');
  if (/multipart\/form-data/i.test(contentType)) {
    return roomMediaExtractMultipart(buffer, contentType);
  }
  return {
    buffer,
    originalName: roomMediaHeaderName(req),
    mime: contentType,
  };
}

function roomMediaDetectMime(buffer, declaredMime, fileName) {
  const declared = String(declaredMime || '').split(';')[0].trim().toLowerCase();
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buffer.subarray(8, 16).toString('ascii').toLowerCase();
    return brand.includes('qt') ? 'video/quicktime' : 'video/mp4';
  }
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'video/webm';
  const ext = String(fileName || '').toLowerCase().split('.').pop();
  if (ROOM_MEDIA_EXT_MIME[ext]) return ROOM_MEDIA_EXT_MIME[ext];
  return ROOM_MEDIA_ALLOWED_MIME.has(declared) ? declared : '';
}

function roomMediaPublic(roomId, attachment) {
  return {
    ...attachment,
    url: `/api/rooms/${encodeURIComponent(roomId)}/media/${encodeURIComponent(attachment.id)}`,
  };
}

function resolveRoomMediaRefs(room, refs) {
  const raw = Array.isArray(refs) ? refs : [];
  const ids = raw.map(x => String(typeof x === 'string' ? x : (x?.id || '')).trim()).filter(Boolean);
  if (ids.length > ROOM_MEDIA_MAX_PER_MESSAGE) {
    return { error: `一次消息最多附加 ${ROOM_MEDIA_MAX_PER_MESSAGE} 个媒体文件` };
  }
  const byId = new Map((room.mediaAttachments || []).map(a => [a.id, a]));
  const attachments = [];
  const missing = [];
  for (const id of ids) {
    const a = byId.get(id);
    if (!a || !a.path || !existsSync(a.path)) missing.push(id);
    else attachments.push(roomMediaPublic(room.id, a));
  }
  if (missing.length) return { error: `附件不存在或已丢失：${missing.join(', ')}` };
  return { attachments };
}

// media 3 条路由 + roomMediaStorageDir（闭包持有注入的 ROOM_MEDIA_DIR）：server.js 原 2957-3240 位置调用
export function registerRoomsMediaRoutes(app, deps) {
  const { roomStore, safeSlice, send500, ROOM_MEDIA_DIR, soloChatDispatcher } = deps;

  function roomMediaSafeRoomId(room) {
    return String(room?.id || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_');
  }

  function roomMediaProjectAttachmentsDir(room, { ensure = false } = {}) {
    const cwd = typeof room?.cwd === 'string' ? room.cwd.trim() : '';
    if (cwd) {
      try {
        const cwdReal = realpathSync(cwd);
        const homeReal = realpathSync(homedir());
        if (cwdReal !== homeReal && statSync(cwdReal).isDirectory()) {
          const attachmentsDir = join(cwdReal, 'attachments');
          if (ensure) mkdirSync(attachmentsDir, { recursive: true, mode: 0o700 });
          return attachmentsDir;
        }
      } catch {}
    }
    return '';
  }

  function roomMediaFallbackDir(room) {
    return join(ROOM_MEDIA_DIR, roomMediaSafeRoomId(room));
  }

  function roomMediaStorageDir(room) {
    const attachmentsDir = roomMediaProjectAttachmentsDir(room, { ensure: true });
    if (attachmentsDir) {
      return {
        dir: attachmentsDir,
        storageScope: 'room_project_attachments',
        relativePathPrefix: 'attachments',
      };
    }
    const fallbackDir = roomMediaFallbackDir(room);
    mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
    return {
      dir: fallbackDir,
      storageScope: 'panel_data_room_media_fallback',
      relativePathPrefix: '',
    };
  }

  function roomMediaAllowedStorageRoots(room) {
    return [
      roomMediaProjectAttachmentsDir(room),
      roomMediaFallbackDir(room),
    ].filter(Boolean);
  }

  function roomMediaResolveStoredPath(room, filePath) {
    if (typeof filePath !== 'string' || !filePath) return '';
    const fileReal = realpathSync(filePath);
    const roots = roomMediaAllowedStorageRoots(room)
      .map((dir) => {
        try { return realpathSync(dir); } catch { return ''; }
      })
      .filter(Boolean);
    const allowed = roots.some((root) => fileReal === root || fileReal.startsWith(`${root}${sep}`));
    return allowed ? fileReal : '';
  }

  app.post('/api/rooms/:id/media', requireOwnerToken, async (req, res) => {
    try {
      const r = roomStore.get(req.params.id);
      if (!r) return res.status(404).json({ error: 'room not found' });
      const chunks = [];
      let total = 0;
      let tooLarge = false;
      for await (const chunk of req) {
        total += chunk.length;
        if (total > ROOM_MEDIA_MAX_BYTES) {
          tooLarge = true;
          chunks.length = 0;
        } else if (!tooLarge) {
          chunks.push(chunk);
        }
      }
      if (tooLarge) return res.status(413).json({ error: '文件过大（单个媒体上限 120MB）' });
      if (total <= 0) return res.status(400).json({ error: 'empty upload body' });
      const upload = roomMediaExtractUpload(req, Buffer.concat(chunks));
      if (upload.error) return res.status(400).json({ error: upload.error });
      const buffer = upload.buffer;
      if (!buffer?.length) return res.status(400).json({ error: 'empty upload file' });
      const originalName = safeSlice(upload.originalName || roomMediaHeaderName(req), 180);
      const mime = roomMediaDetectMime(buffer, upload.mime || req.headers['content-type'], originalName);
      if (!ROOM_MEDIA_ALLOWED_MIME.has(mime)) {
        return res.status(415).json({ error: '只支持 PNG/JPG/WebP/GIF/MP4/MOV/WebM' });
      }
      const id = randomUUID();
      const ext = ROOM_MEDIA_MIME_EXT[mime] || 'bin';
      const safeName = roomMediaSafeName(originalName);
      const storage = roomMediaStorageDir(r);
      const fileName = `${id}.${ext}`;
      const filePath = join(storage.dir, fileName);
      writeFileSync(filePath, buffer, { flag: 'wx', mode: 0o600 });
      const attachment = {
        id,
        name: originalName || safeName,
        safeName,
        kind: roomMediaKind(mime),
        mime,
        size: buffer.length,
        sha256: createHash('sha256').update(buffer).digest('hex'),
        path: filePath,
        relativePath: storage.relativePathPrefix ? `${storage.relativePathPrefix}/${fileName}` : '',
        storageScope: storage.storageScope,
        createdAt: new Date().toISOString(),
      };
      const mediaAttachments = [...(r.mediaAttachments || []), attachment].slice(-500);
      roomStore.update(r.id, { mediaAttachments });
      const publicAttachment = roomMediaPublic(r.id, attachment);
      res.json({ ok: true, attachment: publicAttachment, media: publicAttachment });
    } catch (e) {
      send500(res, e, 'room media upload');
    }
  });

  app.get('/api/rooms/:id/media/:mediaId', requireOwnerToken, (req, res) => {
    try {
      const r = roomStore.get(req.params.id);
      if (!r) return res.status(404).json({ error: 'room not found' });
      const attachment = (r.mediaAttachments || []).find(a => a.id === req.params.mediaId);
      if (!attachment || !attachment.path || !existsSync(attachment.path)) {
        return res.status(404).json({ error: 'media not found' });
      }
      const resolvedPath = roomMediaResolveStoredPath(r, attachment.path);
      if (!resolvedPath) return res.status(404).json({ error: 'media not found' });
      res.setHeader('Content-Type', attachment.mime || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=300');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(resolvedPath);
    } catch (e) {
      send500(res, e, 'room media read');
    }
  });

  // v0.48 chat 模式：用户发一条消息触发一次 AI 回应
  app.post('/api/rooms/:id/chat', requireOwnerToken, async (req, res) => {
    const r = roomStore.get(req.params.id);
    if (!r) return res.status(404).json({ error: 'room not found' });
    if (r.mode !== 'chat') return res.status(400).json({ error: 'room mode != chat' });
    const text = String(req.body?.text || '').trim();
    const resolved = resolveRoomMediaRefs(r, req.body?.attachments);
    if (resolved.error) return res.status(400).json({ error: resolved.error });
    const attachments = resolved.attachments || [];
    if (!text && attachments.length === 0) return res.status(400).json({ error: 'text or attachment required' });
    if (text.length > 64000) return res.status(413).json({ error: '文本过长（>64000 字符）' });   // v0.52 极限 6 万字
    // v0.51 T-39 fix: 检查 dispatcher 是否正在处理上一条（前端可禁按钮，但兜底返 409）
    if (soloChatDispatcher.activeAborts?.has(req.params.id)) {
      return res.status(409).json({ error: '上一条消息还在处理中，先等回复或 abort' });
    }
    // 异步执行，HTTP 先返
    res.json({ ok: true, started: true });
    soloChatDispatcher.sendMessage(req.params.id, text, { attachments }).catch(e => {
      console.warn('chat sendMessage failed:', e.message);
    });
  });
}
