// @ts-check
// NoePanelLogTail — bounded, redacted panel log tail diagnostics.
//
// Adapted from OpenClaw `logs.tail` / bounded output-tail ideas: callers get a
// cursor, byte and line caps are enforced before rendering, and every returned
// line is redacted. This module is read-only and never reads owner-token files.

import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { redactSensitiveText } from './NoeContextScrubber.js';

export const NOE_PANEL_LOG_TAIL_SCHEMA_VERSION = 1;
export const DEFAULT_PANEL_LOG_TAIL_LIMIT = 200;
export const DEFAULT_PANEL_LOG_TAIL_BYTES = 64 * 1024;
export const MAX_PANEL_LOG_TAIL_LIMIT = 1000;
export const MAX_PANEL_LOG_TAIL_BYTES = 256 * 1024;

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clean(value = '', max = 4000) {
  return String(value || '').replace(/\r/g, '').trim().slice(0, max);
}

function utf8SafeTail(buffer, maxBytes) {
  const chars = Array.from(buffer.toString('utf8'));
  const kept = [];
  let bytes = 0;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const ch = chars[i] || '';
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (bytes + chBytes > maxBytes) break;
    kept.push(ch);
    bytes += chBytes;
  }
  return kept.reverse().join('');
}

export function defaultNoePanelLogPath({ port = 51835, env = process.env } = {}) {
  return resolve(String(env.PANEL_RESTART_LOG || `/tmp/noe-panel-${Number(port) || 51835}.log`));
}

export function redactPanelLogLine(value = '') {
  let text = redactSensitiveText(String(value || ''));
  text = text
    .replace(/((?:api[_-]?key|authorization|bearer|cookie|credential|password|private[_-]?key|refresh[_-]?token|secret|session[_-]?token|token|owner[-_ ]?token)\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{12,}\b/g, '[redacted-jwt]')
    .replace(/\b[0-9a-f]{32,}\b/gi, '[redacted-hex-token]')
    .replace(/([?&#][^=]*?(?:token|key|secret|password|code|auth|session|credential|jwt)[^=]*=)[^&#\s]+/gi, '$1[redacted]');
  return clean(text, 4000);
}

function readSlice(file, start, length) {
  const fd = openSync(file, 'r');
  try {
    let prefix = '';
    if (start > 0) {
      const one = Buffer.alloc(1);
      const n = readSync(fd, one, 0, 1, start - 1);
      prefix = one.toString('utf8', 0, n);
    }
    const buffer = Buffer.alloc(length);
    const readBytes = readSync(fd, buffer, 0, length, start);
    return { prefix, text: buffer.toString('utf8', 0, readBytes) };
  } finally {
    closeSync(fd);
  }
}

export function collectNoePanelLogTail({
  file = defaultNoePanelLogPath(),
  cursor = undefined,
  limit = DEFAULT_PANEL_LOG_TAIL_LIMIT,
  maxBytes = DEFAULT_PANEL_LOG_TAIL_BYTES,
  now = new Date(),
} = {}) {
  const target = resolve(String(file || defaultNoePanelLogPath()));
  const effectiveLimit = clampInt(limit, DEFAULT_PANEL_LOG_TAIL_LIMIT, 1, MAX_PANEL_LOG_TAIL_LIMIT);
  const effectiveMaxBytes = clampInt(maxBytes, DEFAULT_PANEL_LOG_TAIL_BYTES, 1, MAX_PANEL_LOG_TAIL_BYTES);
  const generatedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();

  if (!existsSync(target)) {
    return {
      schemaVersion: NOE_PANEL_LOG_TAIL_SCHEMA_VERSION,
      ok: true,
      status: 'missing',
      generatedAt,
      file: target,
      cursor: 0,
      size: 0,
      lines: [],
      lineCount: 0,
      truncated: false,
      reset: false,
      policy: {
        readOnly: true,
        bounded: true,
        redacted: true,
        secretValuesReturned: false,
        actionsPerformed: false,
      },
      limits: { limit: effectiveLimit, maxBytes: effectiveMaxBytes },
      warnings: [`log_file_missing:${basename(target)}`],
    };
  }

  let size = 0;
  try {
    size = statSync(target).size;
  } catch (error) {
    return {
      schemaVersion: NOE_PANEL_LOG_TAIL_SCHEMA_VERSION,
      ok: false,
      status: 'blocked',
      generatedAt,
      file: target,
      cursor: 0,
      size: 0,
      lines: [],
      lineCount: 0,
      truncated: false,
      reset: false,
      policy: {
        readOnly: true,
        bounded: true,
        redacted: true,
        secretValuesReturned: false,
        actionsPerformed: false,
      },
      limits: { limit: effectiveLimit, maxBytes: effectiveMaxBytes },
      warnings: [],
      error: clean(error?.message || error, 600),
    };
  }

  const numericCursor = Number(cursor);
  const hasCursor = Number.isFinite(numericCursor);
  let start = hasCursor ? Math.max(0, Math.floor(numericCursor)) : Math.max(0, size - effectiveMaxBytes);
  let reset = false;
  let truncated = start > 0;

  if (hasCursor && start > size) {
    reset = true;
    start = Math.max(0, size - effectiveMaxBytes);
    truncated = start > 0;
  } else if (hasCursor && size - start > effectiveMaxBytes) {
    reset = true;
    start = Math.max(0, size - effectiveMaxBytes);
    truncated = true;
  }

  if (size === 0 || start >= size) {
    return {
      schemaVersion: NOE_PANEL_LOG_TAIL_SCHEMA_VERSION,
      ok: true,
      status: 'ok',
      generatedAt,
      file: target,
      cursor: size,
      size,
      lines: [],
      lineCount: 0,
      truncated,
      reset,
      policy: {
        readOnly: true,
        bounded: true,
        redacted: true,
        secretValuesReturned: false,
        actionsPerformed: false,
      },
      limits: { limit: effectiveLimit, maxBytes: effectiveMaxBytes },
      warnings: [],
    };
  }

  const length = Math.max(0, size - start);
  const { prefix, text } = readSlice(target, start, length);
  let body = text;
  if (Buffer.byteLength(body, 'utf8') > effectiveMaxBytes) {
    body = utf8SafeTail(Buffer.from(body, 'utf8'), effectiveMaxBytes);
    truncated = true;
  }

  let lines = body.split('\n');
  if (start > 0 && prefix !== '\n') lines = lines.slice(1);
  if (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  const lineTruncated = lines.length > effectiveLimit;
  if (lineTruncated) lines = lines.slice(lines.length - effectiveLimit);
  lines = lines.map(redactPanelLogLine);

  return {
    schemaVersion: NOE_PANEL_LOG_TAIL_SCHEMA_VERSION,
    ok: true,
    status: 'ok',
    generatedAt,
    file: target,
    cursor: size,
    size,
    lines,
    lineCount: lines.length,
    truncated: truncated || lineTruncated,
    reset,
    policy: {
      readOnly: true,
      bounded: true,
      redacted: true,
      secretValuesReturned: false,
      actionsPerformed: false,
    },
    limits: { limit: effectiveLimit, maxBytes: effectiveMaxBytes },
    warnings: [],
  };
}

export function compactPanelLogTail(report = {}) {
  return {
    ok: report.ok === true,
    status: report.status || 'unknown',
    file: report.file || '',
    cursor: Number(report.cursor) || 0,
    size: Number(report.size) || 0,
    lineCount: Number(report.lineCount) || 0,
    truncated: report.truncated === true,
    reset: report.reset === true,
    lines: Array.isArray(report.lines) ? report.lines : [],
    limits: report.limits || {},
    warnings: Array.isArray(report.warnings) ? report.warnings : [],
    secretValuesReturned: false,
    actionsPerformed: false,
  };
}
