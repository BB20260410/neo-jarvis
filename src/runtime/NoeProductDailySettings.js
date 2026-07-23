// @ts-check
/**
 * Minimal daily product settings: model base URL + model id + voice toggle.
 * File-backed; public DTO never echoes API keys / tokens / .env material.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, copyFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

export const PRODUCT_DAILY_SETTINGS_SCHEMA = 'neo.product.daily-settings.v1';
export const DEFAULT_PRODUCT_SETTINGS_FILE = join(homedir(), '.noe-panel', 'product-daily-settings.json');

const SECRET_KEY_RE = /^(api[_-]?key|token|secret|password|authorization|owner[_-]?token|panel[_-]?owner)$/i;
const SECRET_VALUE_RE = /\b(sk-[A-Za-z0-9_-]{16,}|xai-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,})\b/i;

/**
 * @param {unknown} v
 * @param {number} max
 */
function cleanText(v, max) {
  return String(v ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').trim().slice(0, max);
}

/**
 * @param {unknown} value
 * @param {boolean} [fallback]
 */
function cleanBool(value, fallback = true) {
  if (typeof value === 'boolean') return value;
  if (value === '1' || value === 1 || value === 'true') return true;
  if (value === '0' || value === 0 || value === 'false') return false;
  return fallback;
}

/**
 * Normalize incoming payload into stored state (secrets stripped, never persisted as model fields).
 * @param {object} [data]
 */
export function cleanProductDailySettings(data = {}) {
  const raw = data && typeof data === 'object' ? data : {};
  // Reject nested secret bags if client accidentally posts them.
  const modelBaseUrl = cleanText(raw.modelBaseUrl ?? raw.baseUrl ?? raw.model_base_url, 500);
  const modelId = cleanText(raw.modelId ?? raw.model ?? raw.model_id, 200);
  // Voice: accept flat or nested
  const voiceEnabled = cleanBool(
    raw.voiceEnabled ?? raw.voice_enabled ?? raw.voice?.enabled,
    true,
  );
  return {
    version: 1,
    schema: PRODUCT_DAILY_SETTINGS_SCHEMA,
    modelBaseUrl,
    modelId,
    voiceEnabled,
    updatedAt: cleanText(raw.updatedAt, 40) || new Date().toISOString(),
  };
}

/**
 * Public DTO for UI/API — never includes secret-like keys or values.
 * @param {object} [state]
 */
export function toPublicProductSettingsDto(state = {}) {
  const clean = cleanProductDailySettings(state);
  const dto = {
    schema: PRODUCT_DAILY_SETTINGS_SCHEMA,
    modelBaseUrl: clean.modelBaseUrl,
    modelId: clean.modelId,
    voiceEnabled: clean.voiceEnabled,
    updatedAt: clean.updatedAt,
  };
  // Defensive: strip any unexpected keys that look like secrets if caller passed through.
  for (const key of Object.keys(state || {})) {
    if (SECRET_KEY_RE.test(key)) {
      // never copy
      continue;
    }
  }
  // Scrub accidental secret substrings from URL/id fields (do not return raw).
  if (SECRET_VALUE_RE.test(dto.modelBaseUrl)) {
    dto.modelBaseUrl = '[REDACTED]';
  }
  if (SECRET_VALUE_RE.test(dto.modelId)) {
    dto.modelId = '[REDACTED]';
  }
  return dto;
}

/**
 * True if a public DTO (or any object) appears free of secret material on happy path.
 * @param {object} dto
 */
export function productSettingsDtoHasNoSecrets(dto = {}) {
  const keys = Object.keys(dto || {});
  for (const k of keys) {
    if (SECRET_KEY_RE.test(k)) return false;
    const v = dto[k];
    if (typeof v === 'string' && SECRET_VALUE_RE.test(v)) return false;
  }
  return true;
}

export class NoeProductDailySettingsStore {
  /**
   * @param {{ file?: string }} [opts]
   */
  constructor({ file = DEFAULT_PRODUCT_SETTINGS_FILE } = {}) {
    this.file = file;
    this.state = cleanProductDailySettings();
    this._load();
  }

  _ensureDir() {
    const dir = dirname(this.file);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  _backup() {
    if (!existsSync(this.file)) return;
    try {
      copyFileSync(this.file, `${this.file}.bak-latest`);
      chmodSync(`${this.file}.bak-latest`, 0o600);
    } catch { /* ignore */ }
  }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      this.state = cleanProductDailySettings(JSON.parse(readFileSync(this.file, 'utf-8')));
    } catch (e) {
      try {
        copyFileSync(this.file, `${this.file}.corrupted-${Date.now()}-${process.pid}.bak`);
      } catch { /* ignore */ }
      console.warn('[product-daily-settings] load failed:', e instanceof Error ? e.message : String(e));
    }
  }

  _save() {
    this._ensureDir();
    this._backup();
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch { /* ignore */ }
    renameSync(tmp, this.file);
  }

  /**
   * @param {object} [extra]
   */
  status(extra = {}) {
    return toPublicProductSettingsDto({ ...this.state, ...extra });
  }

  /**
   * @param {object} [input]
   */
  update(input = {}) {
    const next = cleanProductDailySettings({
      ...this.state,
      ...input,
      updatedAt: new Date().toISOString(),
    });
    this.state = next;
    this._save();
    return this.status();
  }

  load() {
    this._load();
    return this.status();
  }
}

export const defaultProductDailySettingsStore = new NoeProductDailySettingsStore();
