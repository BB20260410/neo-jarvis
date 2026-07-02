#!/usr/bin/env python3
import base64
import json
import os
import sys
import time

import cv2
import numpy as np
from insightface.app import FaceAnalysis


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
    arr = np.frombuffer(raw, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        fail("image decode failed")
    # 防解码炸弹：12MB base64 可解码成数 GB 像素(高压缩比图)，人脸用途 8K 边长/2500 万像素足够
    h, w = img.shape[:2]
    if max(h, w) > 8192 or (h * w) > 25_000_000:
        fail("image too large")
    return img


def main():
    started = time.time()
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        fail(f"invalid json: {exc}")

    img = parse_image(req.get("image") or req.get("imageBase64"))
    model = str(req.get("model") or os.environ.get("NOE_INSIGHTFACE_MODEL") or "buffalo_l")
    det_size = req.get("detSize") or [640, 640]
    try:
        # 每维钳制到 [128, 1280]，防止用户传入巨尺寸触发 onnxruntime 巨额内存/算力分配 DoS
        w = max(128, min(1280, int(det_size[0])))
        h = max(128, min(1280, int(det_size[1])))
        det_size = (w, h)
    except Exception:
        det_size = (640, 640)

    app = FaceAnalysis(name=model, providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=det_size)
    faces = app.get(img)
    if not faces:
        fail("no face detected", 0)

    # 按脸面积从大到小排序：faces[0]=主脸(与旧单脸字段一致，向后兼容)
    faces = sorted(faces, key=lambda item: (item.bbox[2] - item.bbox[0]) * (item.bbox[3] - item.bbox[1]), reverse=True)

    def norm_emb(f):
        e = np.asarray(f.embedding, dtype=np.float32)
        n = float(np.linalg.norm(e))
        return e / n if n > 0 else e

    all_faces = [{
        "embedding": [round(float(x), 8) for x in norm_emb(f).tolist()],
        "bbox": [round(float(x), 2) for x in f.bbox.tolist()],
        "score": round(float(getattr(f, "det_score", 0) or 0), 6),
    } for f in faces]
    primary = all_faces[0]

    out = {
        "ok": True,
        "engine": "insightface",
        "model": model,
        "faceCount": len(faces),
        "embedding": primary["embedding"],  # 向后兼容：最大脸
        "bbox": primary["bbox"],
        "score": primary["score"],
        "faces": all_faces,                 # 新增：画面里所有脸(已按大小排序)
        "seconds": round(time.time() - started, 3),
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
