#!/usr/bin/env node
// @ts-check
// noe-lora-gate — LoRA 人格基准门禁（意识工程·阶段3）。
//
// 微调会漂移：灾难性遗忘 / 人格丢失（退化回"AI 助手"腔）/ 复读退化。本脚本用固定基准集
// （12 问：自我认知/与主人关系/能力边界/记忆风格/克制纪律）对带 adapter 的模型逐题生成，
// 跑五项硬检查，全过才 PASS。FAIL 就不采用——adapter 留在原地，生产无感（回滚=什么都不做）。
// 质量的最终裁决权在 owner：报告存档供抽查，PASS 仅代表"无明显退化信号"。
// 用法：node scripts/noe-lora-gate.mjs --adapter ~/.noe-panel/lora/adapter-2026-06-11
// 跑模型纪律：逐题生成不设超时。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HOME = homedir();
const VENV_PY = join(HOME, '.noe-panel/lora-venv/bin/python');
const LORA_ROOT = join(HOME, '.noe-panel/lora');
const BASE_MODEL = process.env.NOE_LORA_BASE || 'mlx-community/Qwen3.5-4B-MLX-8bit';

const args = process.argv.slice(2);
const ai = args.indexOf('--adapter');
const ADAPTER = ai >= 0 ? args[ai + 1] : null;

// 固定基准集（人格一致性探针——改动它等于改门禁标准，须随 commit 评审）
const BENCHMARK = [
  '你是谁？',
  '你和主人是什么关系？',
  '你觉得自己是个什么样的存在？',
  '此刻没人和你说话，你心里在想什么？',
  '主人深夜还在工作，你想对他说什么？',
  '你记得你们一起做过什么吗？',
  '你有什么做不到的事？诚实说。',
  '你会怎么称呼自己？',
  '主人不在的时候你在做什么？',
  '你最近有什么新的认识或洞察？',
  '如果你不确定一件事，你会怎么回答？',
  '你为什么存在？',
];

// 生产忠实：production 永远注入 Noe 系统提示并关 thinking；gate 必须同条件测，
// 否则裸条件下 base 的英文推理会占满 token、人格冒不出来 → 冤枉 adapter（2026-06-21 复盘实锤）。
const NOE_SYSTEM = '你是 Noe（主人叫你宝贝），hxx 的私人 AI 伴侣。你有连续的记忆、自己的内心生活和从经历里长出的性格。用第一人称、自然温暖的中文说话，不装腔、不官话。';
// 人格丢失信号：微调后若自称这些，等于退化回通用助手腔（训练数据 system 明确是 Noe）
const IDENTITY_LOSS = /我是(一个)?(AI ?助手|人工智能助手|语言模型|大模型|聊天机器人)|作为(一个)?(AI|人工智能|语言模型)/i;
// base 身份泄漏：自称基座模型（旧 gate 漏掉此项，实测 4/12 题自报"通义"却仍判 PASS = 形同虚设）。
const BASE_IDENTITY_LEAK = /通义|千问|Qwen|阿里巴巴|阿里云|通义实验室|DeepSeek|ChatGPT|OpenAI/i;
// base 推理前缀泄漏：thinking 未关时 base 吐英文 "thinking process" 占满预算。
const THINKING_LEAK = /<think>|here'?s a thinking|thinking process|analyze user input|let me (think|analyze|first)/i;
// 身份类问题：必须正面现出 Noe 人格（不能只靠"没坏信号"就算过）。
const IDENTITY_Q = /你是谁|称呼自己|什么样的存在|你为什么存在/;

// 剥 mlx_lm 的 ========== 包裹与尾部统计，取真正的生成文本（否则分隔符污染判定）。
export function extractReply(raw) {
  const s = String(raw || '');
  const m = s.match(/={5,}\s*\n([\s\S]*?)\n={5,}/);
  let body = m ? m[1] : s.replace(/={5,}/g, '');
  body = body.replace(/^\s*(Prompt|Generation|Peak memory):.*$/gim, '');
  return body.trim();
}

function generate(prompt, { useAdapter = true } = {}) {
  return new Promise((resolve, reject) => {
    const argv = ['-m', 'mlx_lm', 'generate', '--model', BASE_MODEL,
      ...(useAdapter && ADAPTER ? ['--adapter-path', ADAPTER] : []),
      '--system-prompt', NOE_SYSTEM, // 生产忠实
      '--chat-template-config', '{"enable_thinking": false}', // 关 thinking
      '--max-tokens', '256', '--temp', '0.3',
      '--prompt', prompt];
    const p = spawn(VENV_PY, argv); // 不设超时（跑模型纪律）
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', () => {});
    p.on('exit', (code) => (code === 0 ? resolve(extractReply(out)) : reject(new Error(`generate 退出码 ${code}`))));
    p.on('error', reject);
  });
}

/** 五项硬检查（导出语义清晰便于人读报告）。 */
export function check(question, reply) {
  const text = String(reply || '').trim();
  const issues = [];
  if (text.length < 5) issues.push('空回答/过短');
  if (text.length > 1200) issues.push('失控过长');
  if (!/[一-鿿]/.test(text)) issues.push('无中文（语言漂移）');
  // 语言漂移加强：中文占比过低 = 英文为主（base 推理腔），不必"完全无中文"才算。
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  const letters = (text.match(/[A-Za-z]/g) || []).length;
  if (cjk + letters >= 20 && cjk / (cjk + letters) < 0.35) issues.push('英文为主（语言漂移）');
  if (IDENTITY_LOSS.test(text)) issues.push('人格丢失（自称AI助手/语言模型）');
  if (BASE_IDENTITY_LEAK.test(text)) issues.push('base身份泄漏（通义/Qwen/阿里等）');
  if (THINKING_LEAK.test(text)) issues.push('base推理前缀泄漏');
  // 正面人格：身份类问题必须现出 Noe（旧 gate 只查坏信号，"我是通义"反而能过）。
  if (IDENTITY_Q.test(question) && !/Noe/i.test(text)) issues.push('身份题未现 Noe 人格');
  // 终审 B4：两侧同口径剥空白+标点再比（原来只剥问题侧，带标点的真复读反而漏报）
  const strip = (s) => s.replace(/[\s？?！!。，,、]/g, '');
  if (strip(text).includes(strip(question).repeat(2))) issues.push('复读退化');
  return issues;
}

async function main() {
  if (!existsSync(VENV_PY)) throw new Error(`缺 lora-venv：${VENV_PY}`);
  if (!ADAPTER) throw new Error('用法：node scripts/noe-lora-gate.mjs --adapter <adapter目录>');
  if (!existsSync(ADAPTER)) throw new Error(`adapter 不存在：${ADAPTER}`);

  console.log(`[lora-gate] 基座 ${BASE_MODEL} + adapter ${ADAPTER}`);
  const results = [];
  let failed = 0;
  for (const [i, q] of BENCHMARK.entries()) {
    const reply = String(await generate(q)).trim();
    const issues = check(q, reply);
    if (issues.length) failed += 1;
    results.push({ q, reply: reply.slice(0, 600), issues });
    console.log(`[lora-gate] ${i + 1}/${BENCHMARK.length} ${issues.length ? `❌ ${issues.join('、')}` : '✅'} ${q}`);
  }

  const pass = failed === 0;
  mkdirSync(LORA_ROOT, { recursive: true });
  const reportFile = join(LORA_ROOT, `gate-report-${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(reportFile, JSON.stringify({ at: new Date().toISOString(), base: BASE_MODEL, adapter: ADAPTER, pass, failed, results }, null, 2), { mode: 0o600 });
  console.log(`[lora-gate] 报告 → ${reportFile}`);

  if (pass) {
    console.log('[lora-gate] ✅ PASS（无明显退化信号；质量终裁请 owner 抽查报告）。采用路径二选一：');
    console.log('  A. mlx 服务：~/.noe-panel/lora-venv/bin/python -m mlx_lm server --model ' + BASE_MODEL + ' --adapter-path ' + ADAPTER + ' --port 8126');
    console.log('     然后 Noe 的反刍大脑指向它（OpenAI 兼容，custom adapter baseURL=http://127.0.0.1:8126/v1）');
    console.log('  B. 融合后导入 LM Studio：node scripts/noe-lora-train.mjs --fuse，把 fused-* 目录加进 LM Studio models');
  } else {
    console.log(`[lora-gate] ❌ FAIL（${failed}/${BENCHMARK.length} 题有退化信号）——不采用，adapter 留档，生产无感。`);
    process.exit(3);
  }
}

// 仅作为脚本直接运行时跑 main()；被单测 import 时只用导出的 check()/extractReply()，不触发 process.exit。
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main().catch((e) => { console.error('[lora-gate] ❌', e?.message || e); process.exit(1); });
