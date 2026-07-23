// HardwareFit — 硬件扫描 + 荐模型（帮 M5 Max 用户回答"我这机器该下哪个模型/哪个量化"）。
// 设计移植自 Odysseus hwfit（MIT，源自 github.com/AlexsJones/llmfit）：
//   sysctl 探测 Apple Silicon → GPU 预算 → 量化降级阶梯荐模型。
// 关键改进：不搬 Odysseus 会过时的 hf_models.json 静态库，改【实时查本机 Ollama】，3-5 年不腐。零依赖。
import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execFileP = promisify(execFile);

async function sysctl(key) {
  try { const { stdout } = await execFileP('sysctl', ['-n', key]); return stdout.trim(); } catch { return ''; }
}

// 探测硬件。Apple Silicon 走 sysctl（只读，非 shell，无注入）；其他平台尽力用 os.totalmem。
export async function detectHardware() {
  const out = { platform: process.platform, chip: '', ramGb: 0, gpuBudgetGb: 0, unified: false };
  if (process.platform === 'darwin') {
    out.chip = await sysctl('machdep.cpu.brand_string');
    const mem = Number(await sysctl('hw.memsize'));
    out.ramGb = mem ? Math.round(mem / 1024 ** 3) : Math.round(os.totalmem() / 1024 ** 3);
    out.unified = /Apple/i.test(out.chip);
    // GPU 预算占统一内存比例（Odysseus 策略）：>64→80% / 16-64→75% / ≤16→67%
    const frac = out.ramGb > 64 ? 0.80 : out.ramGb > 16 ? 0.75 : 0.67;
    out.gpuBudgetGb = Math.round(out.ramGb * frac);
    const wired = Number(await sysctl('iogpu.wired_limit_mb')); // 用户自设的 Metal 工作集上限(可选覆盖)
    if (wired > 0) out.gpuBudgetGb = Math.round(wired / 1024);
  } else {
    out.chip = os.cpus()?.[0]?.model || process.platform;
    out.ramGb = Math.round(os.totalmem() / 1024 ** 3);
    out.gpuBudgetGb = Math.round(out.ramGb * 0.5);
  }
  return out;
}

// 量化阶梯：每参数近似字节(bpw)，含 KV/激活 overhead 余量。Q8→Q2 由高到低。
const QUANTS = [
  { name: 'Q8_0', bpw: 1.06 }, { name: 'Q6_K', bpw: 0.82 }, { name: 'Q5_K_M', bpw: 0.70 },
  { name: 'Q4_K_M', bpw: 0.58 }, { name: 'Q3_K_M', bpw: 0.46 }, { name: 'Q2_K', bpw: 0.36 },
];
const OVERHEAD = 1.2;

// 给定模型参数量(B) + GPU 预算(GB)，选最高能装下的量化。
export function pickQuant(paramsB, budgetGb) {
  for (const q of QUANTS) {
    const needGb = Math.round(paramsB * q.bpw * OVERHEAD * 10) / 10;
    if (needGb <= budgetGb) return { quant: q.name, needGb, fits: true };
  }
  const last = QUANTS[QUANTS.length - 1];
  return { quant: null, needGb: Math.round(paramsB * last.bpw * OVERHEAD * 10) / 10, fits: false };
}

// 实时查本机 Ollama 已装模型（替代会过时的静态库）。
export async function listOllamaModels(fetchImpl = globalThis.fetch, base = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434') {
  try {
    const sig = (() => { try { return AbortSignal.timeout(5000); } catch { return undefined; } })();
    const resp = await fetchImpl(`${String(base).replace(/\/+$/, '')}/api/tags`, { signal: sig });
    if (!resp.ok) return [];
    const data = await resp.json();
    return (data.models || []).map((m) => ({ name: m.name, sizeGb: m.size ? Math.round((m.size / 1024 ** 3) * 10) / 10 : 0, params: m?.details?.parameter_size || '' }));
  } catch { return []; }
}

// 综合：硬件 + 已装模型 + 各规模荐量化 → 报告。
export async function recommend({ fetchImpl = globalThis.fetch } = {}) {
  const hw = await detectHardware();
  const installed = await listOllamaModels(fetchImpl);
  const sizes = [3, 7, 8, 14, 30, 32, 70, 120];
  const fitTable = sizes.map((b) => ({ paramsB: b, ...pickQuant(b, hw.gpuBudgetGb) }));
  const maxFit = [...fitTable].reverse().find((f) => f.fits);
  const summary = hw.unified
    ? `${hw.chip}，统一内存 ${hw.ramGb}GB（GPU 预算约 ${hw.gpuBudgetGb}GB）。最大可跑约 ${maxFit?.paramsB || '?'}B 模型（建议 ${maxFit?.quant || '需更小模型'}）。本机已装 ${installed.length} 个 Ollama 模型。`
    : `${hw.chip || hw.platform}，内存 ${hw.ramGb}GB（预算约 ${hw.gpuBudgetGb}GB）。已装 ${installed.length} 个 Ollama 模型。`;
  return { hardware: hw, installedModels: installed, fitTable, summary };
}
