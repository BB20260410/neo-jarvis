#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SherpaSttClient } from '../src/voice/SherpaSttClient.js';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-ecosystem-install-2026-06-12');
const OUT_JSON = resolve(OUT_DIR, 'sherpa-capability-check.json');
const SHERPA_ROOT = resolve(homedir(), '.noe-voice/models/sherpa');
mkdirSync(OUT_DIR, { recursive: true });

function moduleStatus() {
  try {
    const sherpa = require('sherpa-onnx-node');
    return {
      ok: true,
      exports: Object.keys(sherpa).filter((name) => /Recognizer|Spotter|Vad|Voice|Offline|Online|Tts|Speaker|Embedding/i.test(name)).sort(),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

const client = new SherpaSttClient();
const addon = moduleStatus();
const checks = [
  {
    id: 'asr_stt',
    ok: client.ready(),
    modelDir: client.modelDir,
    missing: Object.values(client._asrFiles()).filter((file) => !existsSync(file)),
  },
  {
    id: 'kws',
    ok: client.kwsReady(),
    modelDir: client.kwsDir,
    missing: Object.values(client._kwsFiles()).filter((file) => !existsSync(file)),
  },
  { id: 'vad', ok: addon.ok && addon.exports.some((name) => /Vad/i.test(name)), evidence: addon.exports.filter((name) => /Vad/i.test(name)) },
  { id: 'tts', ok: addon.ok && addon.exports.some((name) => /Tts|Voice/i.test(name)), evidence: addon.exports.filter((name) => /Tts|Voice/i.test(name)) },
  { id: 'speaker', ok: addon.ok && addon.exports.some((name) => /Speaker|Embedding/i.test(name)), evidence: addon.exports.filter((name) => /Speaker|Embedding/i.test(name)) },
];

const report = {
  ok: addon.ok,
  generatedAt: new Date().toISOString(),
  package: addon,
  sherpaRoot: SHERPA_ROOT,
  checks,
  noPythonSttAdded: true,
  downloadSuggestion: 'Download official sherpa-onnx ASR/KWS/VAD/TTS/speaker models under ~/.noe-voice/models/sherpa, then rerun node scripts/noe-sherpa-capability-check.mjs.',
};
writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = addon.ok ? 0 : 1;
