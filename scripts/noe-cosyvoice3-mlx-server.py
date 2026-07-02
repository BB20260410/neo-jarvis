#!/usr/bin/env python3
# Noe 本地 CosyVoice3 MLX fp16 中文 TTS 常驻服务。
# 用法: ~/.noe-voice/mlx-audio-plus/bin/python scripts/noe-cosyvoice3-mlx-server.py [port] [model_dir]
# POST /tts {text, voice, speed} -> {audio: base64 wav, format: wav}
import base64
import contextlib
import io
import json
import os
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HOME = os.path.expanduser('~')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8125
MODEL_DIR = sys.argv[2] if len(sys.argv) > 2 else os.environ.get(
    'NOE_COSYVOICE3_MLX_MODEL',
    f'{HOME}/.noe-voice/cosyvoice3-mlx/Fun-CosyVoice3-0.5B-2512-fp16',
)
REF_AUDIO = os.environ.get(
    'NOE_COSYVOICE3_REF_AUDIO',
    f'{HOME}/.noe-voice/cosyvoice/asset/zero_shot_prompt.wav',
)
REF_TEXT = os.environ.get(
    'NOE_COSYVOICE3_REF_TEXT',
    'You are a helpful assistant.<|endofprompt|>希望你以后能够做的比我还好呦。',
)
DEFAULT_VOICE = os.environ.get('NOE_COSYVOICE_VOICE', '中文女')
MAX_TEXT_CHARS = int(os.environ.get('NOE_COSYVOICE3_MAX_TEXT_CHARS', '4000'))
DEFAULT_MAX_TOKENS = int(os.environ.get('NOE_COSYVOICE3_MAX_TOKENS', '1200'))

if not os.path.isfile(os.path.join(MODEL_DIR, 'model.safetensors')):
    print(f'[noe-cosyvoice3-mlx] 模型未就位: {MODEL_DIR}（缺 model.safetensors）', flush=True)
    sys.exit(2)
if not os.path.isfile(REF_AUDIO):
    print(f'[noe-cosyvoice3-mlx] 参考音频未就位: {REF_AUDIO}', flush=True)
    sys.exit(2)

from mlx_audio.tts.generate import generate_audio  # noqa: E402
from mlx_audio.tts.utils import load_model  # noqa: E402

print(f'[noe-cosyvoice3-mlx] loading {MODEL_DIR} ...', flush=True)
MODEL = load_model(model_path=MODEL_DIR)
SAMPLE_RATE = getattr(MODEL, 'sample_rate', 24000)
MODEL_NAME = Path(MODEL_DIR).name
LOCK = threading.Lock()
print(f'[noe-cosyvoice3-mlx] ready on http://127.0.0.1:{PORT} model={MODEL_NAME} sr={SAMPLE_RATE}', flush=True)


def json_bytes(value):
    return json.dumps(value, ensure_ascii=False).encode('utf-8')


def clamp_float(value, default, lo, hi):
    try:
        num = float(value)
    except (TypeError, ValueError):
        num = default
    return min(hi, max(lo, num))


def clamp_int(value, default, lo, hi):
    try:
        num = int(value)
    except (TypeError, ValueError):
        num = default
    return min(hi, max(lo, num))


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._ok({
            'ok': True,
            'engine': 'cosyvoice3-mlx',
            'precision': 'fp16',
            'model': MODEL_NAME,
            'sampleRate': SAMPLE_RATE,
            'voices': [DEFAULT_VOICE],
        })

    def do_POST(self):
        if self.path != '/tts':
            return self._err(404, 'not found')
        try:
            size = int(self.headers.get('Content-Length', 0))
            if size <= 0 or size > 256 * 1024:
                return self._err(413, 'text too large or empty')
            body = json.loads(self.rfile.read(size))
            text = str(body.get('text') or '').strip()[:MAX_TEXT_CHARS]
            if not text:
                return self._err(400, 'text required')
            speed = clamp_float(body.get('speed'), 1.0, 0.5, 2.0)
            max_tokens = clamp_int(body.get('maxTokens') or body.get('max_tokens'), DEFAULT_MAX_TOKENS, 256, 4000)
            started = time.time()
            with tempfile.TemporaryDirectory(prefix='noe-cosyvoice3-') as tmp:
                prefix = os.path.join(tmp, 'tts')
                out_file = f'{prefix}.wav'
                with LOCK:
                    # mlx-audio prints input text to stdout; keep TTS payloads out of logs.
                    hidden = io.StringIO()
                    with contextlib.redirect_stdout(hidden), contextlib.redirect_stderr(hidden):
                        generate_audio(
                            text=text,
                            model=MODEL,
                            ref_audio=REF_AUDIO,
                            ref_text=REF_TEXT,
                            lang_code='zh',
                            voice=body.get('voice') or DEFAULT_VOICE,
                            speed=speed,
                            max_tokens=max_tokens,
                            file_prefix=prefix,
                            audio_format='wav',
                            join_audio=True,
                            play=False,
                            verbose=False,
                            stt_model=None,
                        )
                if not os.path.isfile(out_file) or os.path.getsize(out_file) <= 44:
                    return self._err(500, 'empty synthesis')
                with open(out_file, 'rb') as f:
                    wav = f.read()
            self._ok({
                'audio': base64.b64encode(wav).decode('ascii'),
                'format': 'wav',
                'engine': 'cosyvoice3-mlx',
                'model': MODEL_NAME,
                'durationMs': round((time.time() - started) * 1000),
            })
        except Exception as exc:  # noqa: BLE001
            self._err(500, str(exc))

    def _ok(self, value):
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json_bytes(value))

    def _err(self, code, msg):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json_bytes({'error': msg}))

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
