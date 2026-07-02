import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_PY = join(homedir(), '.noe-voice', 'bin', 'python');
const DEFAULT_MODEL_DIR = join(homedir(), '.cache', 'modelscope', 'hub', 'models', 'iic', 'speech_campplus_sv_zh-cn_16k-common');
const SCRIPT = join(ROOT, 'scripts', 'campp-speaker-embed.py');
const _MODEL_FILE = join(DEFAULT_MODEL_DIR, 'campplus_cn_common.bin');
const DEFAULT_TIMEOUT_MS = Math.max(5_000, Number(process.env.NOE_CAMPP_TIMEOUT_MS || 30_000));

function audioBase64(input) {
  const buf = Buffer.from(input || []);
  if (!buf.length) throw new Error('audio buffer required');
  if (buf.length > 15_000_000) throw new Error('audio too large');
  return buf.toString('base64');
}

function campPlusEnv({ env = process.env, modelDir } = {}) {
  const out = {
    NOE_CAMPP_MODEL_DIR: modelDir,
    PYTHONUNBUFFERED: '1',
    OMP_NUM_THREADS: env.OMP_NUM_THREADS || '1',
    MKL_NUM_THREADS: env.MKL_NUM_THREADS || '1',
    OPENBLAS_NUM_THREADS: env.OPENBLAS_NUM_THREADS || '1',
    VECLIB_MAXIMUM_THREADS: env.VECLIB_MAXIMUM_THREADS || '1',
    NUMEXPR_NUM_THREADS: env.NUMEXPR_NUM_THREADS || '1',
  };
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'VIRTUAL_ENV', 'PYTHONPATH']) {
    if (env[key]) out[key] = env[key];
  }
  return out;
}

function parseEmbedStdout(stdout = '') {
  let parsed = null;
  try { parsed = JSON.parse(String(stdout || '').trim().split('\n').pop() || '{}'); } catch {}
  return parsed;
}

export class CampPlusVoiceClient {
  constructor({ python = process.env.NOE_CAMPP_PYTHON || DEFAULT_PY, script = SCRIPT, modelDir = process.env.NOE_CAMPP_MODEL_DIR || DEFAULT_MODEL_DIR, timeoutMs = DEFAULT_TIMEOUT_MS, spawnImpl = spawn, env = process.env } = {}) {
    this.python = python;
    this.script = script;
    this.modelDir = modelDir;
    this.timeoutMs = timeoutMs;
    this.spawnImpl = spawnImpl;
    this.env = env;
  }

  status() {
    const modelFile = join(this.modelDir, 'campplus_cn_common.bin');
    return {
      ok: existsSync(this.python) && existsSync(this.script) && existsSync(modelFile),
      engine: 'campplus',
      model: 'iic/speech_campplus_sv_zh-cn_16k-common',
      python: this.python,
      script: this.script,
      modelDir: this.modelDir,
      modelReady: existsSync(modelFile),
      modelFile,
      timeoutMs: this.timeoutMs,
    };
  }

  embedAudio(audioBuffer, opts = {}) {
    const st = this.status();
    if (!st.ok) throw new Error('CAM++ voice runtime not installed');
    const modelDir = opts.modelDir || this.modelDir;
    const input = JSON.stringify({ audio: audioBase64(audioBuffer), modelDir });
    const maxBuffer = Number(opts.maxBuffer) || 4 * 1024 * 1024;
    const timeoutMs = Number(opts.timeoutMs) || this.timeoutMs;
    const childEnv = campPlusEnv({ env: opts.env || this.env, modelDir });
    return new Promise((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = this.spawnImpl(this.python, [this.script], {
          stdio: ['pipe', 'pipe', 'pipe'],
          env: childEnv,
        });
      } catch (e) {
        rejectPromise(e);
        return;
      }
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
        finish(rejectPromise, new Error('CAM++ voice runtime timed out'));
      }, timeoutMs);
      child.stdout?.on?.('data', (chunk) => {
        stdout += String(chunk);
        if (Buffer.byteLength(stdout) > maxBuffer) {
          try { child.kill('SIGKILL'); } catch {}
          finish(rejectPromise, new Error('CAM++ voice runtime output too large'));
        }
      });
      child.stderr?.on?.('data', (chunk) => {
        stderr += String(chunk);
        if (stderr.length > 20_000) stderr = stderr.slice(-20_000);
      });
      child.on?.('error', (error) => finish(rejectPromise, error));
      child.on?.('close', (code, signal) => {
        const parsed = parseEmbedStdout(stdout);
        if (parsed?.ok && Array.isArray(parsed.embedding)) return finish(resolvePromise, parsed);
        if (signal === 'SIGKILL') return finish(rejectPromise, new Error('CAM++ voice runtime timed out'));
        const firstErr = String(stderr || '').split('\n').find((line) => line.trim());
        return finish(rejectPromise, new Error(parsed?.error || firstErr || `CAM++ exit ${code}`));
      });
      child.stdin?.end?.(input, 'utf8');
    });
  }
}

export const defaultCampPlusVoiceClient = new CampPlusVoiceClient();
