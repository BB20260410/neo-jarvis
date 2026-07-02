#!/usr/bin/env python3
# Noe 本地 CosyVoice 中文 TTS 常驻服务（卡②：断网/MiniMax 不可用时中文不哑的兜底档）。
# 用法: ~/.noe-voice/cosyvoice/.venv/bin/python scripts/noe-cosyvoice-server.py [port] [model_dir]
# POST /tts {text, voice, speed} → {audio: base64 wav, format: wav}；GET / → {ok, model, voices}
# 跑在 CosyVoice 官方 repo 的独立 venv（~/.noe-voice/cosyvoice），模型 CosyVoice-300M-SFT（预置"中文女"等音色）。
import sys
import io
import os
import json
import base64
import wave

HOME = os.path.expanduser('~')
COSY_ROOT = os.environ.get('NOE_COSYVOICE_ROOT', f'{HOME}/.noe-voice/cosyvoice')
sys.path.insert(0, COSY_ROOT)
sys.path.insert(0, f'{COSY_ROOT}/third_party/Matcha-TTS')

import numpy as np  # noqa: E402
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer  # noqa: E402

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8125
MODEL_DIR = sys.argv[2] if len(sys.argv) > 2 else f'{COSY_ROOT}/pretrained_models/CosyVoice-300M-SFT'
DEFAULT_VOICE = os.environ.get('NOE_COSYVOICE_VOICE', '中文女')

# 前置检查：目录/关键文件不在就清晰报错退出——否则 CosyVoice 会把路径当 modelscope model id 去线上请求，报错难懂
if not os.path.isfile(os.path.join(MODEL_DIR, 'llm.pt')):
    print(f'[noe-cosyvoice] 模型未就位: {MODEL_DIR}（缺 llm.pt；先按 docs 下载 CosyVoice-300M-SFT）', flush=True)
    sys.exit(2)

print(f'[noe-cosyvoice] loading {MODEL_DIR} ...', flush=True)
from cosyvoice.cli.cosyvoice import CosyVoice  # noqa: E402
cosyvoice = CosyVoice(MODEL_DIR, load_jit=False, load_trt=False, fp16=False)
VOICES = cosyvoice.list_available_spks()
SR = cosyvoice.sample_rate
print(f'[noe-cosyvoice] ready on http://127.0.0.1:{PORT} voices={VOICES} sr={SR}', flush=True)


def pcm_to_wav(samples, sr):
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((np.clip(samples, -1, 1) * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'ok': True, 'model': MODEL_DIR.rsplit('/', 1)[-1], 'voices': VOICES}, ensure_ascii=False).encode())

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length', 0))
            if n <= 0 or n > 100 * 1024:
                return self._err(413, 'text too large or empty')
            body = json.loads(self.rfile.read(n))
            text = (body.get('text') or '').strip()
            if not text:
                return self._err(400, 'text required')
            voice = body.get('voice') or DEFAULT_VOICE
            if voice not in VOICES:
                voice = DEFAULT_VOICE if DEFAULT_VOICE in VOICES else VOICES[0]
            speed = float(body.get('speed', 1.0))
            speed = min(2.0, max(0.5, speed))
            chunks = []
            for out in cosyvoice.inference_sft(text, voice, stream=False, speed=speed):
                chunks.append(out['tts_speech'].numpy().flatten())
            samples = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.float32)
            if samples.size == 0:
                return self._err(500, 'empty synthesis')
            wav = pcm_to_wav(samples, SR)
            out = json.dumps({'audio': base64.b64encode(wav).decode(), 'format': 'wav'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(out)
        except Exception as exc:  # noqa: BLE001
            self._err(500, str(exc))

    def _err(self, code, msg):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'error': msg}, ensure_ascii=False).encode())

    def log_message(self, fmt, *args):  # 安静点，错误已在响应里
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
