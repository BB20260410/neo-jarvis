import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildNoeSelfKnowledgeBlock, detectCosyVoiceStatus } from '../../src/context/NoeSelfKnowledge.js';

const oldEnv = {};
const keys = ['NOE_COSYVOICE_ROOT', 'NOE_COSYVOICE3_MLX_MODEL', 'NOE_COSYVOICE3_MLX_PYTHON'];

function rememberEnv() {
  for (const key of keys) oldEnv[key] = process.env[key];
}

function restoreEnv() {
  for (const key of keys) {
    if (oldEnv[key] === undefined) delete process.env[key];
    else process.env[key] = oldEnv[key];
  }
}

describe('detectCosyVoiceStatus', () => {
  let dir = '';

  afterEach(() => {
    restoreEnv();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('prefers CosyVoice3 MLX fp16 when model and runtime are present', () => {
    rememberEnv();
    dir = mkdtempSync(join(tmpdir(), 'noe-cosyvoice3-'));
    const modelDir = join(dir, 'model');
    const oldRoot = join(dir, 'old');
    const py = join(dir, 'python');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(join(modelDir, 'model.safetensors'), '');
    writeFileSync(py, '');
    process.env.NOE_COSYVOICE3_MLX_MODEL = modelDir;
    process.env.NOE_COSYVOICE3_MLX_PYTHON = py;
    process.env.NOE_COSYVOICE_ROOT = oldRoot;
    const status = detectCosyVoiceStatus();
    expect(status).toMatchObject({ available: true, engine: 'CosyVoice3 MLX fp16', model: 'Fun-CosyVoice3-0.5B-2512-fp16' });
    expect(buildNoeSelfKnowledgeBlock({ only: ['voice'], maxDetailChars: 160 })).toContain('CosyVoice3 MLX fp16');
  });

  it('falls back to legacy CosyVoice SFT detection when MLX fp16 is absent', () => {
    rememberEnv();
    dir = mkdtempSync(join(tmpdir(), 'noe-cosyvoice-old-'));
    const oldModel = join(dir, 'pretrained_models', 'CosyVoice-300M-SFT');
    mkdirSync(oldModel, { recursive: true });
    writeFileSync(join(oldModel, 'llm.pt'), '');
    process.env.NOE_COSYVOICE3_MLX_MODEL = join(dir, 'missing-mlx');
    process.env.NOE_COSYVOICE3_MLX_PYTHON = join(dir, 'missing-python');
    process.env.NOE_COSYVOICE_ROOT = dir;
    const status = detectCosyVoiceStatus();
    expect(status).toMatchObject({ available: true, engine: 'CosyVoice-300M-SFT', model: 'CosyVoice-300M-SFT' });
  });
});
