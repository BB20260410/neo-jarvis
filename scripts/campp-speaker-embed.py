#!/usr/bin/env python3
import base64
import io
import json
import os
import resource
import sys
import time

import numpy as np
import soundfile as sf
import torch
import torch.nn.functional as F
import torchaudio.functional as AF
from modelscope.models.audio.sv.DTDNN import SpeakerVerificationCAMPPlus


MODEL_ID = "iic/speech_campplus_sv_zh-cn_16k-common"
MODEL_DIR = os.environ.get(
    "NOE_CAMPP_MODEL_DIR",
    os.path.expanduser("~/.cache/modelscope/hub/models/iic/speech_campplus_sv_zh-cn_16k-common"),
)
MODEL_FILE = "campplus_cn_common.bin"
TARGET_SR = 16000


def fail(message, code=1):
    print(json.dumps({"ok": False, "error": str(message)}, ensure_ascii=False))
    sys.exit(code)


def decode_audio(value):
    if not isinstance(value, str) or not value:
        fail("audio base64 required")
    if "," in value[:120]:
        value = value.split(",", 1)[1]
    try:
        return base64.b64decode(value, validate=False)
    except Exception as exc:
        fail(f"invalid audio base64: {exc}")


def read_audio(raw):
    try:
        data, sr = sf.read(io.BytesIO(raw), dtype="float32")
    except Exception as exc:
        fail(f"audio decode failed: {exc}")
    if getattr(data, "ndim", 1) == 2:
        data = data.mean(axis=1)
    data = np.asarray(data, dtype=np.float32)
    if data.size < int(sr * 0.45):
        fail("voice sample too short or silent")
    rms = float(np.sqrt(np.mean(np.square(data)))) if data.size else 0.0
    if rms < 0.002:
        fail("voice sample too short or silent")
    audio = torch.from_numpy(data)
    if sr != TARGET_SR:
        audio = AF.resample(audio, sr, TARGET_SR)
    return audio, sr, rms


def main():
    started = time.time()
    try:
        req = json.loads(sys.stdin.read() or "{}")
    except Exception as exc:
        fail(f"invalid json: {exc}")

    model_dir = str(req.get("modelDir") or MODEL_DIR)
    if not os.path.exists(os.path.join(model_dir, MODEL_FILE)):
        fail(f"CAM++ model not found: {model_dir}")

    audio, source_sr, rms = read_audio(decode_audio(req.get("audio") or req.get("wav") or req.get("audioBase64")))
    model = SpeakerVerificationCAMPPlus(
        model_dir,
        {"sample_rate": TARGET_SR, "fbank_dim": 80, "emb_size": 192},
        device="cpu",
        pretrained_model=MODEL_FILE,
    )
    with torch.no_grad():
        emb = model(audio.numpy())
        emb = F.normalize(emb, p=2, dim=1)[0].detach().cpu().numpy()

    out = {
        "ok": True,
        "engine": "campplus",
        "model": MODEL_ID,
        "embedding": [round(float(x), 8) for x in emb.tolist()],
        "embeddingDim": int(emb.size),
        "sampleRate": int(source_sr),
        "targetSampleRate": TARGET_SR,
        "durationSeconds": round(float(audio.numel()) / TARGET_SR, 3),
        "rms": round(rms, 6),
        "seconds": round(time.time() - started, 3),
        "maxrssBytes": int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss),
    }
    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
