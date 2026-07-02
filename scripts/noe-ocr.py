#!/usr/bin/env python3
# noe-ocr — RapidOCR 屏幕读字（卡③）。stdin JSON {image: base64} → stdout JSON {ok, text, lines}。
# 跑在独立 venv ~/.noe-panel/ocr-venv（rapidocr-onnxruntime，PP-OCR 中英模型内置），不污染全局。
# 由 src/vision/OcrClient.js spawn 调用，与 insightface-embed.py 同款接法。
import base64
import json
import sys

import numpy as np


def fail(message, code=1):
    print(json.dumps({"ok": False, "error": str(message)}, ensure_ascii=False))
    sys.exit(code)


def parse_image(value):
    if not isinstance(value, str) or not value:
        fail("image base64 required")
    if "," in value[:80]:
        value = value.split(",", 1)[1]
    try:
        raw = base64.b64decode(value, validate=False)
    except Exception as exc:
        fail(f"invalid image base64: {exc}")
    import cv2
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        fail("image decode failed")
    return img


def main():
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        fail(f"invalid json: {exc}")
        return
    img = parse_image(payload.get("image"))
    try:
        from rapidocr_onnxruntime import RapidOCR
        engine = RapidOCR()
        result, elapse = engine(img)
    except Exception as exc:
        fail(f"ocr failed: {exc}")
        return
    lines = []
    for item in result or []:
        try:
            box, text, score = item[0], str(item[1]), float(item[2])
        except Exception:
            continue
        lines.append({
            "text": text,
            "score": round(score, 4),
            # box = 4 顶点 [[x,y]×4]，取整方便前端画框
            "box": [[round(float(p[0])), round(float(p[1]))] for p in box],
        })
    print(json.dumps({
        "ok": True,
        "text": "\n".join(l["text"] for l in lines),
        "lines": lines,
        "count": len(lines),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
