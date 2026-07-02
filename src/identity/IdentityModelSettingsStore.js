import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, renameSync, copyFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DIR = join(homedir(), '.noe-panel');
const FILE = join(DIR, 'identity-model-settings.json');
const VOICE_ENGINES = new Set(['campplus', 'voice-lite']);

function cleanVoiceEngine(value) {
  const v = String(value || '').trim().toLowerCase();
  return VOICE_ENGINES.has(v) ? v : 'campplus';
}

function cleanBool(value, fallback = true) {
  return typeof value === 'boolean' ? value : fallback;
}

function cleanState(data = {}) {
  return {
    version: 1,
    voice: {
      enabled: cleanBool(data?.voice?.enabled, true),
      engine: cleanVoiceEngine(data?.voice?.engine),
    },
    face: {
      enabled: cleanBool(data?.face?.enabled, true),
    },
    updatedAt: data?.updatedAt || new Date().toISOString(),
  };
}

export class IdentityModelSettingsStore {
  constructor({ file = FILE } = {}) {
    this.file = file;
    this.state = cleanState();
    this._load();
  }

  _ensureDir() {
    const dir = this.file.slice(0, this.file.lastIndexOf('/'));
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  _backup() {
    if (!existsSync(this.file)) return;
    try { copyFileSync(this.file, `${this.file}.bak-latest`); chmodSync(`${this.file}.bak-latest`, 0o600); } catch {}
  }

  _load() {
    if (!existsSync(this.file)) return;
    try { this.state = cleanState(JSON.parse(readFileSync(this.file, 'utf-8'))); }
    catch (e) {
      try { copyFileSync(this.file, `${this.file}.corrupted-${Date.now()}.bak`); } catch {}
      console.warn('[identity-model-settings] load failed:', e instanceof Error ? e.message : String(e));
    }
  }

  _save() {
    this._ensureDir();
    this._backup();
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    try { chmodSync(tmp, 0o600); } catch {}
    renameSync(tmp, this.file);
  }

  status(extra = {}) {
    return cleanState({ ...this.state, ...extra });
  }

  update(input = {}) {
    const patch = input || {};
    if (patch.voiceEnabled !== undefined || patch.voice?.enabled !== undefined) {
      this.state.voice.enabled = cleanBool(patch.voiceEnabled ?? patch.voice?.enabled, this.state.voice.enabled);
    }
    if (patch.voiceEngine !== undefined || patch.voice?.engine !== undefined) {
      this.state.voice.engine = cleanVoiceEngine(patch.voiceEngine ?? patch.voice?.engine);
    }
    if (patch.faceEnabled !== undefined || patch.face?.enabled !== undefined) {
      this.state.face.enabled = cleanBool(patch.faceEnabled ?? patch.face?.enabled, this.state.face.enabled);
    }
    this.state.updatedAt = new Date().toISOString();
    this._save();
    return this.status();
  }

  setVoiceEnabled(enabled) { return this.update({ voiceEnabled: enabled === true }); }
  setFaceEnabled(enabled) { return this.update({ faceEnabled: enabled === true }); }
  setVoiceEngine(engine) { return this.update({ voiceEngine: engine }); }
  voiceEnabled() { return this.state.voice.enabled === true; }
  faceEnabled() { return this.state.face.enabled === true; }
  voiceEngine() { return cleanVoiceEngine(this.state.voice.engine); }
}

export const defaultIdentityModelSettingsStore = new IdentityModelSettingsStore();
