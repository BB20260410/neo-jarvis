// @ts-check
// OcrClient — 屏幕读字（卡③）：spawn 独立 venv 的 RapidOCR（scripts/noe-ocr.py），读出截图里的具体文字。
// 补 VLM 的短板：语义模型懂画面但可能读不准小字/长串（路径/代码/数字），OCR 逐行精确读。
// 接法与 InsightFaceClient 同款（spawn + stdin/stdout JSON）；按 owner 纪律不设超时（跑模型不许超时误杀），
// 进程退出/启动失败会自然 reject，不会无限等一个已死的子进程。
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const DEFAULT_PY = join(homedir(), '.noe-panel', 'ocr-venv', 'bin', 'python');
const SCRIPT = join(ROOT, 'scripts', 'noe-ocr.py');

export class OcrClient {
  constructor({ python = process.env.NOE_OCR_PYTHON || DEFAULT_PY, script = SCRIPT, spawnFn = spawn } = {}) {
    this.python = python;
    this.script = script;
    this._spawn = spawnFn; // 注入位：测试喂假子进程
  }

  status() {
    return { ok: existsSync(this.python) && existsSync(this.script), engine: 'rapidocr', python: this.python, script: this.script };
  }

  /**
   * 识别一张图里的文字。
   * @param {Buffer|string} image png/jpeg Buffer 或 base64 字符串
   * @returns {Promise<{ok: true, text: string, lines: Array<{text, score, box}>, count: number}>}
   */
  recognize(image) {
    const st = this.status();
    if (!st.ok) return Promise.reject(new Error(`OCR runtime 未安装（${this.python}）`));
    const b64 = Buffer.isBuffer(image) ? image.toString('base64') : String(image || '');
    if (!b64) return Promise.reject(new Error('image required'));
    if (b64.length > 30_000_000) return Promise.reject(new Error('image too large'));
    return new Promise((resolveOcr, rejectOcr) => {
      const child = this._spawn(this.python, [this.script], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
      child.on('error', (err) => rejectOcr(err));
      child.on('close', (code) => {
        let parsed = null;
        try { parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}'); } catch { /* 落到统一报错 */ }
        if (parsed?.ok && Array.isArray(parsed.lines)) return resolveOcr(parsed);
        const msg = parsed?.error || stderr.split('\n').find((line) => line.trim()) || `OCR exit ${code}`;
        return rejectOcr(new Error(msg));
      });
      child.stdin.end(JSON.stringify({ image: b64 }));
    });
  }
}

export const defaultOcrClient = new OcrClient();
