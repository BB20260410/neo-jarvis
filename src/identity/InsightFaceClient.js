import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_PY = join(homedir(), '.noe-panel', 'insightface-venv', 'bin', 'python');
const DEFAULT_MODEL_DIR = join(homedir(), '.insightface', 'models', 'buffalo_l');
const SCRIPT = join(ROOT, 'scripts', 'insightface-embed.py');

function cleanImage(value) {
  const text = String(value || '');
  if (!text) throw new Error('image base64 required');
  if (text.length > 12_000_000) throw new Error('image too large');
  return text;
}

export class InsightFaceClient {
  constructor({ python = process.env.NOE_INSIGHTFACE_PYTHON || DEFAULT_PY, script = SCRIPT, timeoutMs = Number(process.env.NOE_INSIGHTFACE_TIMEOUT_MS) || 90_000 } = {}) {
    this.python = python;
    this.script = script;
    this.timeoutMs = timeoutMs;
  }

  status() {
    return {
      ok: existsSync(this.python) && existsSync(this.script),
      engine: 'insightface',
      python: this.python,
      script: this.script,
      modelDir: DEFAULT_MODEL_DIR,
      modelReady: existsSync(join(DEFAULT_MODEL_DIR, 'w600k_r50.onnx')) && existsSync(join(DEFAULT_MODEL_DIR, 'det_10g.onnx')),
    };
  }

  embedImage(image, opts = {}) {
    const st = this.status();
    if (!st.ok) return Promise.reject(new Error('InsightFace runtime not installed'));
    const MAX_OUT = 2 * 1024 * 1024; // 审计 §3.4 P0-2：stdout/stderr 上限，防大图/慢模型无界拼接 OOM
    return new Promise((resolveEmbed, rejectEmbed) => {
      const child = spawn(this.python, [this.script], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      let killTimer = null;
      // 审计 §3.4 P0-3：SIGTERM 后若进程卡在 ONNX 加载不退出，2s 补 SIGKILL 防 close 不来导致 fd 泄漏
      const hardKill = () => {
        try { child.kill('SIGTERM'); } catch { /* 进程可能已退出 */ }
        if (!killTimer) {
          killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }, 2000);
          if (killTimer.unref) killTimer.unref();
        }
      };
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(arg);
      };
      const timer = setTimeout(() => { hardKill(); settle(rejectEmbed, new Error('InsightFace timeout')); }, this.timeoutMs);
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString('utf8');
        if (stdout.length > MAX_OUT) { hardKill(); settle(rejectEmbed, new Error('InsightFace output too large')); }
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8');
        if (stderr.length > MAX_OUT) stderr = stderr.slice(-MAX_OUT); // 限长防 stderr 刷屏 OOM
      });
      child.on('error', (err) => { if (killTimer) clearTimeout(killTimer); settle(rejectEmbed, err); });
      child.on('close', (code) => {
        if (killTimer) clearTimeout(killTimer); // 进程已退出，撤销 SIGKILL 兜底
        let parsed = null;
        try { parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}'); } catch {}
        if (parsed?.ok && Array.isArray(parsed.embedding)) return settle(resolveEmbed, parsed);
        const msg = parsed?.error || stderr.split('\n').find((line) => line.trim()) || `InsightFace exit ${code}`;
        return settle(rejectEmbed, new Error(msg));
      });
      child.stdin.end(JSON.stringify({ image: cleanImage(image), model: opts.model || 'buffalo_l', detSize: opts.detSize || [640, 640] }));
    });
  }
}

export const defaultInsightFaceClient = new InsightFaceClient();
