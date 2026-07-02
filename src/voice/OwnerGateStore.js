import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { DEFAULT_WAKE_WORDS, OwnerGate } from './OwnerGate.js';

const DIR = join(homedir(), '.noe-panel');
const FILE = join(DIR, 'owner-gate.json');

function splitList(value) {
  return Array.isArray(value)
    ? value.map((s) => String(s || '').trim()).filter(Boolean)
    : String(value || '').split(/[,\n，、]/).map((s) => s.trim()).filter(Boolean);
}

function cleanList(value, fallback = []) {
  const rows = splitList(value).map((s) => s.slice(0, 80)).filter(Boolean);
  return rows.length ? [...new Set(rows)] : fallback;
}

function envConfig(env = process.env) {
  const passphrases = cleanList(env.NOE_OWNER_PASSPHRASES || env.NOE_OWNER_PASSPHRASE || '', []);
  const wakeWords = cleanList(env.NOE_OWNER_WAKE_WORDS || '', [...DEFAULT_WAKE_WORDS]);
  return { enabled: env.NOE_OWNER_GATE === '1' || passphrases.length > 0, wakeWords, passphrases };
}

export class OwnerGateStore {
  constructor({ file = FILE, env = process.env } = {}) {
    this.file = file;
    this.config = envConfig(env);
    this._load();
  }

  _ensureDir() { const dir = this.file.slice(0, this.file.lastIndexOf('/')); if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 }); }
  _backup() { if (existsSync(this.file)) { try { copyFileSync(this.file, `${this.file}.bak-latest`); chmodSync(`${this.file}.bak-latest`, 0o600); } catch {} } }

  _load() {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf-8'));
      this.config = {
        enabled: data?.enabled === true,
        wakeWords: cleanList(data?.wakeWords, [...DEFAULT_WAKE_WORDS]),
        passphrases: cleanList(data?.passphrases, []),
      };
    } catch (e) {
      try { copyFileSync(this.file, `${this.file}.corrupted-${Date.now()}.bak`); } catch {}
      console.warn('[owner-gate] load failed:', e.message);
    }
  }

  _save() {
    this._ensureDir();
    this._backup();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, ...this.config }, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, this.file);
  }

  publicConfig() {
    return {
      enabled: this.config.enabled,
      wakeWords: [...this.config.wakeWords],
      passphrases: [],
      passphrasesConfigured: this.config.passphrases.length > 0,
      passphraseCount: this.config.passphrases.length,
      secretValuesReturned: false,
    };
  }

  update(input = {}) {
    const hasPassphrases = Object.hasOwn(input, 'passphrases');
    this.config = {
      enabled: input.enabled === true,
      wakeWords: cleanList(input.wakeWords, [...DEFAULT_WAKE_WORDS]),
      passphrases: hasPassphrases ? cleanList(input.passphrases, []) : [...this.config.passphrases],
    };
    this._save();
    return this.publicConfig();
  }

  status() {
    return { enabled: this.config.enabled, wakeWords: this.config.wakeWords.length, passphrases: this.config.passphrases.length };
  }

  check(text, opts = {}) {
    return new OwnerGate(this.config).check(text, opts);
  }
}

export const defaultOwnerGateStore = new OwnerGateStore();
