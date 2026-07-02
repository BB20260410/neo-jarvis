#!/usr/bin/env python3
# Noe 本地 Kokoro TTS 常驻服务（kokoro-onnx，英文降级档，按需启动，零外发零成本）
# 用法: ~/.noe-voice/bin/python scripts/noe-kokoro-server.py [port] [model] [voices]
# POST /tts {text, voice, speed} → {audio: base64 wav, format: wav}
# 注意：Kokoro 中文弱，只用于英文/系统提示；中文走 MiniMax。
import sys
import io
import os
import json
import base64
import wave
import numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from kokoro_onnx import Kokoro

HOME = os.path.expanduser('~')
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8124
MODEL = sys.argv[2] if len(sys.argv) > 2 else f'{HOME}/.noe-voice/kokoro-v1.0.onnx'
VOICES = sys.argv[3] if len(sys.argv) > 3 else f'{HOME}/.noe-voice/voices-v1.0.bin'

print(f'[noe-kokoro] loading {MODEL} ...', flush=True)
kokoro = Kokoro(MODEL, VOICES)
print(f'[noe-kokoro] ready on http://127.0.0.1:{PORT}', flush=True)


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
        self.wfile.write(json.dumps({'ok': True}).encode())

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length', 0))
            if n <= 0 or n > 100 * 1024:
                return self._err(413, 'text too large or empty')
            body = json.loads(self.rfile.read(n))
            text = (body.get('text') or '').strip()
            if not text:
                return self._err(400, 'text required')
            voice = body.get('voice', 'af_heart')
            speed = float(body.get('speed', 1.0))
            samples, sr = kokoro.create(text, voice=voice, speed=speed, lang='en-us')
            wav = pcm_to_wav(samples, sr)
            out = json.dumps({'audio': base64.b64encode(wav).decode(), 'format': 'wav'}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(out)
        except Exception as e:  # noqa
            self._err(500, str(e))

    def _err(self, code, msg):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'error': msg}).encode())

    def log_message(self, *args):
        pass


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
