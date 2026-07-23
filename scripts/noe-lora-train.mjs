#!/usr/bin/env node
// @ts-check
// noe-lora-train — LoRA 微调管线（意识工程·阶段3，全本地零配额）。
//
// 流程：合并 ~/.noe-panel/sft/*.jsonl → 洗牌（确定性种子）→ 9:1 切 train/valid →
//       mlx_lm lora 训练（QLoRA on 8bit 基座）→ 产出 adapter →（--fuse 时）融合成完整模型目录。
// 用法：
//   node scripts/noe-lora-train.mjs                 # 攒够 500 对才真跑（防欠拟合烧机）
//   node scripts/noe-lora-train.mjs --min 20 --iters 40   # 小样本冒烟（验证管线，不求质量）
//   node scripts/noe-lora-train.mjs --fuse          # 训练后融合，输出可被 mlx_lm server / LM Studio 加载的模型目录
// 训练后必须跑 scripts/noe-lora-gate.mjs 过人格基准门禁，PASS 才采用（采用路径见 gate 输出）。
// 跑模型纪律：训练/生成不设任何超时。
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { sftFileChannel } from '../src/memory/NoeSftHarvester.js';

const HOME = homedir();
const VENV_PY = join(HOME, '.noe-panel/lora-venv/bin/python');
const SFT_DIR = process.env.NOE_SFT_DIR || join(HOME, '.noe-panel/sft'); // NOE_SFT_DIR：冒烟/测试用临时目录覆盖
const LORA_ROOT = join(HOME, '.noe-panel/lora');
const BASE_MODEL = process.env.NOE_LORA_BASE || 'mlx-community/Qwen3.5-4B-MLX-8bit';

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
};
const MIN_PAIRS = Number(flag('min', 500));
const FUSE = args.includes('--fuse');
// 质量超参（2026-06-21 复盘：旧默认 rank8/lr1e-5/无 mask-prompt → adapter 近 no-op，人格全靠 system prompt）。
// 提升：--mask-prompt（只在 assistant token 上算 loss，人格信号不被 prompt 稀释）+ rank 16 + lr 5e-5 + ~2 epoch。
const RANK = Number(flag('rank', 16));
const SCALE = Number(flag('scale', 20));
const LR = flag('lr', '5e-5');
const NUM_LAYERS = String(flag('num-layers', 16));
const MASK_PROMPT = !args.includes('--no-mask'); // 默认开 mask-prompt（持久化人格的关键）
const TAG = flag('tag', new Date().toISOString().slice(0, 10)); // 默认日期；--tag 可指定（避免覆盖旧 adapter）

/** 确定性洗牌（mulberry32，种子固定 → 同数据同切分，可复现）。 */
function shuffle(arr, seed = 20260611) {
  let s = seed >>> 0;
  const rand = () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function run(cmd, argv, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: 'inherit', ...opts }); // 不设超时（跑模型纪律）
    p.on('exit', (code) => (code === 0 ? resolve(0) : reject(new Error(`${cmd} 退出码 ${code}`))));
    p.on('error', reject);
  });
}

/**
 * 加载人格 LoRA 训练对（纯函数，可单测）。P0-①（三方审）：人格/权重通道**只吃 persona**——
 * ① 文件级：只读 sft-*.jsonl，跳过 sft-project-*.jsonl（sftFileChannel 判，与 harvester 落盘对账）；
 * ② 行级双保险：即便历史/混入文件里夹了 split==='project' 的行，也逐行剔除（绝不让工程复盘进权重人格）。
 * 行校验沿用原口径（messages 数组且 ≥3）。坏行/被剔除的 project 行计入 dropped 供观测。
 * @param {string} sftDir
 * @returns {{ valid: string[], bad: number, droppedProject: number, projectFiles: number }}
 */
export function loadPersonaTrainingPairs(sftDir) {
  const all = readdirSync(sftDir).filter((f) => f.endsWith('.jsonl')).sort();
  const personaFiles = all.filter((f) => sftFileChannel(f) === 'persona');
  const projectFiles = all.length - personaFiles.length;
  const lines = personaFiles.flatMap((f) => readFileSync(join(sftDir, f), 'utf-8').split('\n').filter(Boolean));
  /** @type {string[]} */
  const valid = [];
  let bad = 0;
  let droppedProject = 0;
  for (const line of lines) {
    let j;
    try { j = JSON.parse(line); } catch { bad += 1; continue; }
    if (!Array.isArray(j?.messages) || j.messages.length < 3) { bad += 1; continue; }
    if (j.split === 'project') { droppedProject += 1; continue; } // 行级双保险：project 绝不进人格训练集
    valid.push(line);
  }
  return { valid, bad, droppedProject, projectFiles };
}

async function main() {
  if (!existsSync(VENV_PY)) throw new Error(`缺 lora-venv：${VENV_PY}（pip install mlx-lm socksio）`);
  if (!existsSync(SFT_DIR)) throw new Error(`缺训练数据目录 ${SFT_DIR}（先开 NOE_SFT_HARVEST=1 攒数据）`);

  // 1) 合并 persona 周文件 → 行级校验（P0-①：只吃人格通道；坏行/project 行丢弃并计数，绝不喂权重人格）
  const { valid, bad, droppedProject, projectFiles } = loadPersonaTrainingPairs(SFT_DIR);
  console.log(`[lora-train] 人格训练对：${valid.length} 条有效${bad ? `（丢弃坏行 ${bad}）` : ''}`
    + `${droppedProject ? `（剔除混入的 project 行 ${droppedProject}）` : ''}`
    + `${projectFiles ? ` · 另有 ${projectFiles} 个 project 留档文件不参与人格训练` : ''}`);
  if (valid.length < MIN_PAIRS) {
    console.log(`[lora-train] 不足 ${MIN_PAIRS} 对，不训（继续攒；冒烟用 --min 20）`);
    process.exit(2);
  }

  // 2) 洗牌 + 9:1 切分（valid 至少 4 条，mlx-lm 要求 valid 集非空）
  const shuffled = shuffle(valid);
  const cut = Math.max(4, Math.floor(shuffled.length * 0.1));
  const dataDir = join(LORA_ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'valid.jsonl'), shuffled.slice(0, cut).join('\n') + '\n');
  writeFileSync(join(dataDir, 'train.jsonl'), shuffled.slice(cut).join('\n') + '\n');

  // 3) 训练（iters 缺省按数据量自适应：约 2 epoch，上限 2000）
  const tag = TAG;
  const adapterPath = join(LORA_ROOT, `adapter-${tag}`);
  const iters = String(flag('iters', Math.min(2000, Math.max(60, (shuffled.length - cut) * 2))));
  // lora 超参经 config 传（rank/scale/dropout 无 CLI flag）。
  const configPath = join(LORA_ROOT, `lora-config-${tag}.yaml`);
  writeFileSync(configPath, `lora_parameters:\n  rank: ${RANK}\n  scale: ${SCALE}\n  dropout: 0.05\n`);
  // 终审 B3：断点续训——同日中断重跑时若已有 checkpoint，自动从最后一份续（mlx_lm 每
  // save-every 步存 adapters.safetensors），数小时训练不必从头来。
  const ckpt = join(adapterPath, 'adapters.safetensors');
  const resume = existsSync(ckpt) ? ['--resume-adapter-file', ckpt] : [];
  if (resume.length) console.log(`[lora-train] 检测到 checkpoint，续训：${ckpt}`);
  console.log(`[lora-train] 基座 ${BASE_MODEL} · iters=${iters} · rank=${RANK} · lr=${LR} · num-layers=${NUM_LAYERS} · mask-prompt=${MASK_PROMPT} · adapter → ${adapterPath}`);
  await run(VENV_PY, ['-m', 'mlx_lm', 'lora',
    '--model', BASE_MODEL, '--train', '--data', dataDir,
    '--iters', iters, '--batch-size', '1', '--grad-checkpoint',
    '--learning-rate', String(LR), '--num-layers', NUM_LAYERS,
    ...(MASK_PROMPT ? ['--mask-prompt'] : []),
    '-c', configPath,
    '--save-every', '200', '--adapter-path', adapterPath, ...resume]);

  // 4) 可选融合（fused 目录可被 mlx_lm server / LM Studio 直接加载）
  if (FUSE) {
    const fusedPath = join(LORA_ROOT, `fused-${tag}`);
    await run(VENV_PY, ['-m', 'mlx_lm', 'fuse', '--model', BASE_MODEL, '--adapter-path', adapterPath, '--save-path', fusedPath]);
    console.log(`[lora-train] 已融合 → ${fusedPath}`);
  }

  console.log(`[lora-train] ✅ 完成。下一步（必做）：node scripts/noe-lora-gate.mjs --adapter ${adapterPath}`);
}

// 仅在被直接执行时跑训练；被 import（单测）时只暴露纯函数，不触发 mlx_lm。
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => { console.error('[lora-train] ❌', e?.message || e); process.exit(1); });
}
