// v0.54 Sprint 4 — Webhook 配置持久化
// 文件：~/.noe-panel/webhooks.json
//
// Webhook 用于把房状态变化（done/error/auto_paused）推到外部 URL：
//   - discord 格式：嵌入 embed 卡片
//   - slack 格式：用 attachments
//   - json 格式：原始 event payload + 用户自定义 headers
//
// 路径沙箱：URL 必须 https://（除 localhost 测试用）

import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';
import { atomicWriteJson, readJsonWithCorruptBackup } from '../state/atomicJsonFile.js';

const DIR = join(homedir(), '.noe-panel');
const FILE = join(DIR, 'webhooks.json');

export const VALID_FORMATS = ['discord', 'slack', 'json'];
export const VALID_EVENTS = [
  'room_done',          // debate_done / squad_done / arena_done
  'room_error',         // *_error
  'room_auto_paused',   // 连续失败自动暂停
];

const MAX_WEBHOOKS = 20;
const MAX_NAME = 80;
const MAX_URL = 2048;
const MAX_HEADERS = 10;
const MAX_HEADER_VAL = 1024;

function sanitizeUrl(u) {
  if (typeof u !== 'string' || !u) return null;
  if (u.length > MAX_URL) return null;
  if (!/^https?:\/\//i.test(u)) return null;
  // https 强制，仅 localhost / 127.0.0.1 允许 http（测试）
  if (/^http:\/\//i.test(u)) {
    if (!/^http:\/\/(localhost|127\.0\.0\.1)(:|\/)/i.test(u)) return null;
  }
  return u;
}

function sanitizeHeaders(h) {
  if (!h || typeof h !== 'object') return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(h)) {
    if (n >= MAX_HEADERS) break;
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(k)) continue;
    if (typeof v !== 'string' || v.length > MAX_HEADER_VAL) continue;
    if (/[\r\n]/.test(v)) continue;  // 防 header injection
    // 黑名单常见敏感 header（panel 不该转发）
    const lk = k.toLowerCase();
    if (['host', 'content-length', 'authorization'].includes(lk)) {
      // 允许 Authorization 但仅当用户主动配（用户清楚自己在干嘛）
      if (lk !== 'authorization') continue;
    }
    out[k] = v;
    n++;
  }
  return out;
}

function sanitize(input, { allowId = false } = {}) {
  if (!input || typeof input !== 'object') return null;
  const url = sanitizeUrl(input.url);
  if (!url) return null;
  const name = String(input.name || '').slice(0, MAX_NAME).trim();
  if (!name) return null;
  const format = VALID_FORMATS.includes(input.format) ? input.format : 'json';
  let events = Array.isArray(input.events)
    ? input.events.filter((e) => VALID_EVENTS.includes(e))
    : [...VALID_EVENTS];
  if (events.length === 0) events = [...VALID_EVENTS];
  let roomFilter = input.roomFilter;
  if (roomFilter !== '*' && !Array.isArray(roomFilter)) roomFilter = '*';
  if (Array.isArray(roomFilter)) {
    roomFilter = roomFilter.filter((s) => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s)).slice(0, 50);
    if (roomFilter.length === 0) roomFilter = '*';
  }
  const headers = sanitizeHeaders(input.headers);
  const out = {
    name, url, format, events, roomFilter, headers,
    enabled: input.enabled !== false,
  };
  if (allowId && typeof input.id === 'string') out.id = input.id;
  return out;
}

export class WebhookStore {
  constructor({ file = FILE } = {}) {
    this.file = file; // 测试可注入隔离文件；默认行为不变
    this.items = [];
    this._ensureDir();
    this._load();
  }

  _ensureDir() {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true, mode: 0o700 });
  }

  _load() {
    const data = readJsonWithCorruptBackup(this.file, { label: 'webhooks' });
    if (!data) return; // 不存在或损坏（损坏已自动备份）→ 保持空列表
    try {
      if (Array.isArray(data?.webhooks)) {
        for (const w of data.webhooks) {
          const clean = sanitize(w, { allowId: true });
          if (!clean) continue;
          this.items.push({
            id: typeof w.id === 'string' && w.id ? w.id : 'wh-' + randomUUID().slice(0, 8),
            ...clean,
            createdAt: w.createdAt || new Date().toISOString(),
            stats: w.stats || { lastFireAt: null, successCount: 0, errorCount: 0, lastError: null },
          });
          if (this.items.length >= MAX_WEBHOOKS) break;
        }
      }
    } catch (e) {
      console.warn('[webhooks] load failed:', e.message);
    }
  }

  _save() {
    try {
      // 强健工程：原子写+一代备份（bumpStats 每次推送都落盘，高频写最易撞上半写损坏）
      atomicWriteJson(this.file, { version: 1, webhooks: this.items });
    } catch (e) {
      console.warn('[webhooks] save failed:', e.message);
    }
  }

  list({ mask = true } = {}) {
    if (!mask) return this.items;
    // 默认隐藏 URL 中 token / secret 段
    return this.items.map((w) => ({
      ...w,
      url: maskWebhookUrl(w.url),
    }));
  }

  get(id) { return this.items.find((w) => w.id === id) || null; }

  create(input) {
    if (this.items.length >= MAX_WEBHOOKS) throw new Error(`Webhook 已达上限 ${MAX_WEBHOOKS}`);
    const clean = sanitize(input);
    if (!clean) throw new Error('webhook 不合法：url 必须 https:// + name 必填');
    const item = {
      id: 'wh-' + randomUUID().slice(0, 8),
      ...clean,
      createdAt: new Date().toISOString(),
      stats: { lastFireAt: null, successCount: 0, errorCount: 0, lastError: null },
    };
    this.items.push(item);
    this._save();
    return item;
  }

  update(id, patch) {
    const i = this.items.findIndex((w) => w.id === id);
    if (i < 0) return null;
    const merged = { ...this.items[i], ...patch };
    const clean = sanitize(merged);
    if (!clean) throw new Error('webhook 不合法');
    this.items[i] = { ...this.items[i], ...clean };
    this._save();
    return this.items[i];
  }

  delete(id) {
    const i = this.items.findIndex((w) => w.id === id);
    if (i < 0) return false;
    this.items.splice(i, 1);
    this._save();
    return true;
  }

  /** 内部：dispatcher 推送完后调，更新 stats（不验证字段，trusted） */
  bumpStats(id, success, error = null) {
    const w = this.get(id);
    if (!w) return;
    w.stats.lastFireAt = new Date().toISOString();
    if (success) w.stats.successCount++;
    else { w.stats.errorCount++; w.stats.lastError = String(error || '').slice(0, 200); }
    this._save();
  }
}

export function maskWebhookUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    // 把 path 里超过 8 字符的段替换成 4...4 形式
    const segs = u.pathname.split('/').map((s) => {
      if (s.length > 12) return s.slice(0, 4) + '...' + s.slice(-4);
      return s;
    });
    u.pathname = segs.join('/');
    // token / key query 参数也掩码
    for (const [k, v] of u.searchParams.entries()) {
      if (/token|key|secret|sig/i.test(k) && v.length > 8) {
        u.searchParams.set(k, v.slice(0, 4) + '...' + v.slice(-4));
      }
    }
    // M4 修复：URL userinfo（user:password@）含凭据，掩码 path/query 后 u.toString() 仍会明文带出，需清掉。
    if (u.username || u.password) { u.username = ''; u.password = ''; }
    return u.toString();
  } catch {
    return url;
  }
}

export const webhookStore = new WebhookStore();
