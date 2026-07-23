#!/usr/bin/env python3
# Noe 本地 whisper STT 常驻服务（mlx-whisper，模型只 load 一次，零成本零外发）
# 用法: ~/.noe-voice/bin/python scripts/noe-whisper-server.py [port] [model]
# POST 一个 16kHz mono PCM wav 字节流 → 返回 {"text": "..."}
import sys
import io
import json
import wave
import numpy as np
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import mlx_whisper

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
MODEL = sys.argv[2] if len(sys.argv) > 2 else 'mlx-community/whisper-large-v3-turbo'

print(f'[noe-whisper] loading {MODEL} ...', flush=True)
# 预热：load 模型一次，避免首个请求慢
mlx_whisper.transcribe(np.zeros(16000, dtype=np.float32), path_or_hf_repo=MODEL)
print(f'[noe-whisper] ready on http://127.0.0.1:{PORT}', flush=True)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        # 健康检查
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'ok': True, 'model': MODEL}).encode())

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length', 0))
            if n <= 0 or n > 25 * 1024 * 1024:  # 25MB 上限，防畸形 Content-Length 撑爆内存
                self.send_response(413)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'error': 'audio too large or empty'}).encode())
                return
            body = self.rfile.read(n)
            with wave.open(io.BytesIO(body), 'rb') as w:
                frames = w.readframes(w.getnframes())
            audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
            r = mlx_whisper.transcribe(audio, path_or_hf_repo=MODEL)
            out = json.dumps({'text': (r.get('text') or '').strip()}).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(out)
        except Exception as e:  # noqa
            self.send_response(500)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}).encode())

    def log_message(self, *args):
        pass  # 静音访问日志


if __name__ == '__main__':
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
