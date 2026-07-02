#!/usr/bin/env python3
# Noe 本地 Qwen3-TTS VoiceDesign 中文 TTS 常驻服务 —— 志玲嗲软音色（seed 锁定），替代 CosyVoice-SFT 本地档。
# 用法: ~/.noe-voice/bin/python scripts/noe-qwen-tts-server.py [port]
# POST /tts {text, instruct?, speed?} → {audio: base64 wav, format: wav}; GET / → {ok, model, seed}
# 跑在主 venv（~/.noe-voice，mlx-audio）。模型常驻预加载；每次合成前 mx.random.seed(SEED) 锁死音色。
import sys, os, json, base64, threading, tempfile, glob

os.environ.setdefault('HF_ENDPOINT', 'https://hf-mirror.com')
for _k in ('https_proxy', 'http_proxy', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'all_proxy'):
    os.environ.pop(_k, None)

from http.server import BaseHTTPRequestHandler, HTTPServer
import mlx.core as mx
from mlx_audio.tts.utils import load_model
from mlx_audio.tts.generate import generate_audio

HOME = os.path.expanduser('~')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8126
MODEL_DIR = os.environ.get('NOE_QWEN_TTS_MODEL', f'{HOME}/.noe-voice/qwen3-tts/mlx-1.7B-VoiceDesign-bf16')
SEED = int(os.environ.get('NOE_QWEN_TTS_SEED', '52013'))
DESC = os.environ.get('NOE_QWEN_TTS_DESC',
                      '嗲声嗲气的台湾甜美女声，音色软糯黏人、语调温柔缓慢，像贴着耳朵轻声说话，亲切又带点羞涩。')

if not os.path.isdir(MODEL_DIR):
    print(f'[noe-qwen-tts] 模型未就位: {MODEL_DIR}', flush=True)
    sys.exit(2)

print(f'[noe-qwen-tts] loading {MODEL_DIR} ...', flush=True)
MODEL = load_model(MODEL_DIR)
LOCK = threading.Lock()
TMP = tempfile.mkdtemp(prefix='noe-qwen-tts-')
print(f'[noe-qwen-tts] ready on http://127.0.0.1:{PORT} seed={SEED}', flush=True)


def synth(text, instruct, speed):
    # mlx 推理非线程安全 + 共享 tmp 文件 → 串行
    with LOCK:
        for f in glob.glob(TMP + '/out*.wav'):
            try:
                os.remove(f)
            except OSError:
                pass
        mx.random.seed(SEED)
        generate_audio(text=text, model=MODEL, lang_code='zh', instruct=instruct, speed=speed,
                       output_path=TMP, file_prefix='out', audio_format='wav',
                       save=True, verbose=False, stt_model=None)
        files = sorted(glob.glob(TMP + '/out*.wav'))
        if not files:
            raise RuntimeError('no audio generated')
        with open(files[0], 'rb') as fh:
            return fh.read()


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._json(200, {'ok': True, 'model': os.path.basename(MODEL_DIR), 'seed': SEED, 'voice': 'zhiling-vd'})

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length', 0))
            if n <= 0 or n > 100 * 1024:
                return self._json(413, {'error': 'text too large or empty'})
            body = json.loads(self.rfile.read(n))
            text = (body.get('text') or '').strip()
            if not text:
                return self._json(400, {'error': 'text required'})
            instruct = body.get('instruct') or DESC  # 默认锁死嗲软音色；传 instruct 可覆盖(会改音色)
            speed = min(2.0, max(0.5, float(body.get('speed', 1.0))))
            wav = synth(text[:4000], instruct, speed)
            self._json(200, {'audio': base64.b64encode(wav).decode(), 'format': 'wav'})
        except Exception as exc:  # noqa: BLE001
            self._json(500, {'error': str(exc)})

    def _json(self, code, obj):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(obj, ensure_ascii=False).encode())

    def log_message(self, fmt, *args):
        pass


if __name__ == '__main__':
    HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
