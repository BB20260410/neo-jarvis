#!/usr/bin/env node
// @ts-check
/**
 * multimodel — 三路并行多模型执行 + 交叉验证 + 综合裁决
 *
 * 用法（CLI）:
 *   node scripts/multimodel.mjs --task "..." [--mode review|design|verify|implement] \
 *     [--repo <仓库目录>] [--in <文件>] [--out <输出>] [--label <名>]
 *
 * 用法（编程）:
 *   import { multimodel } from './scripts/multimodel.mjs'
 *   const result = await multimodel(task, { mode: 'review', repo: '...' })
 *
 * 模型分工（质量优先不计 Token/时间）:
 *   M3 (thinking ON)  — 深度语义推理 / 逻辑推导 / 设计批判 / 找盲区
 *   Codex (GPT-5.5)   — 读真实代码 / 执行验证 / 代码 bug / 证据链
 *   Claude 子代理      — 编排 + 最终裁决（由主循环 Agent 工具派发）
 *
 * mode 策略（四模式均含 Phase0 前提质疑）:
 *   review   → Phase0 → M3 ∥ Codex 并行审 → 双向强制质疑
 *   design   → Phase0 → M3 ∥ Codex 并行方案 → 双向强制质疑 → 共识防幻觉
 *   verify   → Phase0 → Codex 实测 ∥ M3 逻辑反推 → 双向强制质疑 → 共识防幻觉
 *   implement→ Phase0 → M3 出 plan → Codex dry-run → 共识防幻觉
 */

import { MiniMaxChatAdapter } from '../src/room/MiniMaxChatAdapter.js';
import { resolveNoeProviderSecret } from '../src/secrets/NoeProviderSecrets.js';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ───── CLI 参数解析 ─────
function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const IS_CLI = process.argv[1]?.endsWith('multimodel.mjs');

// ───── M3 调用（thinking 始终开启）─────
async function callM3(prompt) {
  const s = resolveNoeProviderSecret('minimax'); // 同步，无需 await
  if (!s?.value) return { ok: false, err: 'no minimax key', text: '' };
  const adapter = new MiniMaxChatAdapter({
    apiKey: s.value,
    baseUrl: process.env.MINIMAX_BASE_URL,
    model: 'MiniMax-M3',
    thinking: undefined, // undefined = ON；'disabled' = 关
  });
  try {
    const r = await adapter._doChat(
      [{ role: 'user', content: prompt }],
      { noAbort: true, thinking: undefined } // 不设超时，不限 maxCompletionTokens
    );
    const text = (r?.reply || '').trim();
    return text.length > 0 ? { ok: true, text } : { ok: false, err: 'empty reply', text: '' };
  } catch (e) {
    return { ok: false, err: String(e?.message || e).slice(0, 200), text: '' };
  }
}

// ───── M3 快速调用（thinking OFF，用于分类/前提质疑等轻量任务）─────
async function callM3Fast(prompt) {
  const s = resolveNoeProviderSecret('minimax');
  if (!s?.value) return { ok: false, err: 'no minimax key', text: '' };
  const adapter = new MiniMaxChatAdapter({
    apiKey: s.value,
    baseUrl: process.env.MINIMAX_BASE_URL,
    model: 'MiniMax-M3',
    thinking: 'disabled',
  });
  try {
    const r = await adapter._doChat(
      [{ role: 'user', content: prompt }],
      { noAbort: true, thinking: 'disabled' }
    );
    const text = (r?.reply || '').trim();
    return text.length > 0 ? { ok: true, text } : { ok: false, err: 'empty reply', text: '' };
  } catch (e) {
    return { ok: false, err: String(e?.message || e).slice(0, 200), text: '' };
  }
}

const CODEX_TIMEOUT_MS = Number(process.env.CODEX_TIMEOUT_MS) || 1_200_000; // 默认 20 分钟（质量优先不切断深任务，可 env 覆盖）

// ───── Codex 调用 ─────
async function callCodex(prompt, opts = {}) {
  const { repo = process.cwd(), allowWrite = false } = opts;
  const sandbox = allowWrite ? 'workspace-write' : 'read-only'; // auto 无效！
  return new Promise((res) => {
    const args = [
      'exec', '-s', sandbox,
      '--ephemeral',
      '--dangerously-bypass-approvals-and-sandbox',
      prompt,
    ];
    const child = spawn('codex', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    let out = '';
    let err = '';
    const killer = setTimeout(() => {
      child.kill('SIGTERM');
      res({ ok: false, err: `codex timeout after ${CODEX_TIMEOUT_MS}ms`, text: out.trim() });
    }, CODEX_TIMEOUT_MS);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(killer); res({ ok: false, err: String(e.message), text: '' }); });
    child.on('close', (code) => {
      clearTimeout(killer);
      const text = out.trim();
      res(code === 0 && text.length > 50
        ? { ok: true, text }
        : { ok: false, err: `exit=${code} stderr=${err.slice(0, 300)}`, text });
    });
  });
}

// ───── Phase 0：前提质疑（M3 快速，找任务描述里最可能的错误假设）─────
async function questionPremises(task) {
  const r = await callM3Fast(
    `找出以下任务描述中最可能是错误的 1-3 个隐含假设。每条一行，格式：\n假设：... → 若错则：...\n\n任务：${task.slice(0, 800)}`
  );
  return r.ok && r.text.length > 20 ? r.text : null;
}

// ───── 双向强制质疑（必须找错误，不接受礼貌性通过）─────
async function runCrossVerify(original, resultA, labelA, resultB, labelB) {
  const makePrompt = (target, targetLabel) =>
    `你是严格的批判者，任务是找出以下结论的漏洞。

原始任务：
${original.slice(0, 600)}

需要批判的结论（来自 ${targetLabel}）：
${target.slice(0, 3500)}

必须回答以下三项（不可省略）：
1. 至少 1 个具体错误或站不住脚的论点（需给出反证或理由，不能泛泛质疑）
2. 至少 1 个重要遗漏（这个结论忽略了什么关键点？）
3. 你的独立判断（如果不看 ${targetLabel} 的结论，你的看法有何不同？）

约束：
- 第 1 和第 2 项必须有具体内容，哪怕很小
- 若穷尽所有角度确实找不到，显式写"无实质错误：[从哪些角度找过]"
- 禁止礼貌性通过（如"结论很好，补充一点..."这类回答不合格）`;

  const [aCritB, bCritA] = await Promise.allSettled([
    callM3(makePrompt(resultB, labelB)),       // M3 批 Codex
    callCodex(makePrompt(resultA, labelA)),    // Codex 批 M3
  ]);
  return {
    [`M3批${labelB}`]: aCritB.status === 'fulfilled' ? aCritB.value : { ok: false, err: String(aCritB.reason), text: '' },
    [`Codex批${labelA}`]: bCritA.status === 'fulfilled' ? bCritA.value : { ok: false, err: String(bCritA.reason), text: '' },
  };
}

// ───── 共识防幻觉：两路一致时让 M3(thinking) 强制反驳 ─────
async function challengeConsensus(fullTask, mainResults) {
  const okEntries = Object.entries(mainResults).filter(([, r]) => r.ok);
  if (okEntries.length < 2) return null;
  const summary = okEntries.map(([k, r]) => `[${k}]\n${r.text.slice(0, 1800)}`).join('\n\n');
  return callM3(
    `以下是两个独立来源对同一任务的结论，可能存在共同的错误前提。\n假设这些结论有根本性错误，给出最有力的 1-3 条反驳论证（要具体，不要泛泛）：\n\n${summary.slice(0, 4000)}\n\n原始任务：${fullTask.slice(0, 400)}`
  );
}

// ───── 综合输出（分类展示：主结论 / 分歧日志 / 对立假设）─────
function buildSynthesis(task, results, mode, premises) {
  const lines = [`# multimodel 综合报告\n**任务**: ${task.slice(0, 200)}\n**模式**: ${mode}\n`];

  if (premises) {
    lines.push(`## Phase 0 — 前提质疑\n${premises}\n`);
  }

  const mainResults = {};
  const crossResults = {};
  const adversarialResults = {};
  for (const [label, r] of Object.entries(results)) {
    if (label.startsWith('M3批') || label.startsWith('Codex批')) crossResults[label] = r;
    else if (label.includes('对立假设')) adversarialResults[label] = r;
    else mainResults[label] = r;
  }

  for (const [label, r] of Object.entries(mainResults)) {
    lines.push(`## ${label}`);
    lines.push(r.ok ? r.text : `> ⚠️ 调用失败: ${r.err}`);
    lines.push('');
  }

  if (Object.keys(crossResults).length > 0) {
    lines.push('## 分歧日志（交叉强制质疑）');
    for (const [label, r] of Object.entries(crossResults)) {
      lines.push(`### ${label}`);
      lines.push(r.ok ? r.text : `> ⚠️ 失败: ${r.err}`);
      lines.push('');
    }
  }

  if (Object.keys(adversarialResults).length > 0) {
    lines.push('## 对立假设检查（共识防幻觉）');
    for (const [label, r] of Object.entries(adversarialResults)) {
      lines.push(`### ${label}`);
      lines.push(r.ok ? r.text : `> ⚠️ 失败: ${r.err}`);
      lines.push('');
    }
  }

  const allTexts = Object.values(results).filter(r => r.ok);
  const verdict = allTexts.length >= 2 ? 'multi-source' : allTexts.length === 1 ? 'single-source' : 'all-failed';
  lines.push(`---\n**覆盖率**: ${allTexts.length}/${Object.keys(results).length} 路成功 | **verdict**: ${verdict}`);

  return { verdict, synthesis: lines.join('\n'), bySource: results, successCount: allTexts.length };
}

// ───── 模式自动检测 ─────
const VALID_MODES = ['review', 'design', 'verify', 'implement'];

function detectModeRegex(task) {
  const signals = [
    ['review',    /审查|审阅|找.?bug|检查|有没有.?问题|是否.?合理|是否.?最优|review|audit|critique|漏洞/i],
    ['verify',    /验证|确认|是否.?(正确|可行|存在)|核实|检验|check if|confirm|is (this|it|the).{0,30}correct|是不是|能否/i],
    ['implement', /实现|实施|写代码|开发|实作|落地|implement|create|build/i],
    ['design',    /设计(一个|新|方案|系统|架构)|架构(方案|设计)|如何做|怎么做|规划|思路|选型|how (to|should)|design (a|an|the)|architect/i],
  ];
  for (const [mode, re] of signals) {
    if (re.test(task)) return /** @type {any} */ (mode);
  }
  return 'review';
}

async function detectMode(task) {
  const r = await callM3Fast(
    `判断下面任务最适合哪种模式，只回答一个英文单词：\nreview=审查/找bug\ndesign=设计新方案\nverify=验证声明\nimplement=实现功能\n\n任务：${task.slice(0, 600)}\n\n只回答 review/design/verify/implement 中的一个：`
  );
  if (r.ok) {
    const word = r.text.toLowerCase().split(/\s/)[0];
    if (VALID_MODES.includes(word)) {
      console.log(`[multimodel] M3 判断模式 → ${word}`);
      return /** @type {any} */ (word);
    }
  }
  const fallback = detectModeRegex(task);
  console.log(`[multimodel] 正则兜底模式 → ${fallback}`);
  return fallback;
}

// ───── 核心编排 ─────
/**
 * @param {string} task
 * @param {{
 *   mode?: 'review'|'design'|'verify'|'implement'|'auto',
 *   repo?: string,
 *   inFile?: string,
 *   out?: string,
 *   label?: string,
 *   enableCrossVerify?: boolean,
 * }} opts
 */
export async function multimodel(task, opts = {}) {
  const {
    mode: rawMode = 'auto',
    repo = process.cwd(),
    inFile,
    out,
    label = 'multimodel',
    enableCrossVerify = true,
  } = opts;

  const mode = rawMode === 'auto' ? await detectMode(task) : rawMode;

  const ctx = inFile
    ? (() => {
      try {
        const t = readFileSync(inFile, 'utf8');
        return `\n\n=== 附带材料 (${inFile}) ===\n${t.length > 80000 ? t.slice(0, 80000) + '\n...[截断]' : t}`;
      } catch { return ''; }
    })()
    : '';

  const fullTask = task + ctx;
  const results = {};
  let premises = null;

  // ─── Phase 0：design/implement 在此触发；review/verify 在各自分支内触发
  if (mode === 'design' || mode === 'implement') {
    console.log(`[multimodel:${label}] Phase 0 — 前提质疑...`);
    premises = await questionPremises(fullTask);
    if (premises) console.log(`[multimodel:${label}] 前提质疑完成`);
  }

  if (mode === 'review') {
    // Phase 0：review 同样需要，防止"这段代码有 bug"本身是误判
    console.log(`[multimodel:${label}] Phase 0 — 前提质疑...`);
    premises = await questionPremises(fullTask);

    console.log(`[multimodel:${label}] review — M3(thinking) ∥ Codex 并行审查...`);
    const [m3r, cr] = await Promise.allSettled([
      callM3(`你是严格的代码/方案审查者（侧重语义、逻辑、产品视角）。\n\n${fullTask}`),
      callCodex(`As a senior engineer, review the following and find real bugs, logic errors, missing edge cases. For each issue include evidenceRef (file:line or test):\n\n${fullTask}`, { repo }),
    ]);
    results['M3审查(thinking)'] = m3r.status === 'fulfilled' ? m3r.value : { ok: false, err: String(m3r.reason), text: '' };
    results['Codex审查'] = cr.status === 'fulfilled' ? cr.value : { ok: false, err: String(cr.reason), text: '' };

    if (enableCrossVerify && results['M3审查(thinking)'].ok && results['Codex审查'].ok) {
      console.log(`[multimodel:${label}] 双向强制质疑...`);
      const xr = await runCrossVerify(fullTask, results['M3审查(thinking)'].text, 'M3', results['Codex审查'].text, 'Codex');
      Object.assign(results, xr);
    }

  } else if (mode === 'design') {
    console.log(`[multimodel:${label}] design — M3 ∥ Codex 并行独立给方案...`);
    const [m3r, cr] = await Promise.allSettled([
      callM3(`从架构/产品/逻辑角度，给出你对以下问题的最佳方案（独立思考）：\n\n${fullTask}`),
      callCodex(`From a software engineering perspective, propose the best solution. Be specific:\n\n${fullTask}`, { repo }),
    ]);
    results['M3方案(thinking)'] = m3r.status === 'fulfilled' ? m3r.value : { ok: false, err: String(m3r.reason), text: '' };
    results['Codex方案'] = cr.status === 'fulfilled' ? cr.value : { ok: false, err: String(cr.reason), text: '' };

    // 强制双向质疑：M3 批 Codex 方案 + Codex 批 M3 方案
    if (enableCrossVerify && results['M3方案(thinking)'].ok && results['Codex方案'].ok) {
      console.log(`[multimodel:${label}] 双向强制质疑...`);
      const xr = await runCrossVerify(fullTask, results['M3方案(thinking)'].text, 'M3方案', results['Codex方案'].text, 'Codex方案');
      Object.assign(results, xr);
    }

    // 共识防幻觉
    if ([results['M3方案(thinking)'], results['Codex方案']].filter(r => r.ok).length >= 2) {
      console.log(`[multimodel:${label}] 共识防幻觉检查...`);
      const adversarial = await challengeConsensus(fullTask, { 'M3方案': results['M3方案(thinking)'], 'Codex方案': results['Codex方案'] });
      if (adversarial) results['对立假设检查(thinking)'] = adversarial;
    }

  } else if (mode === 'verify') {
    // Phase 0：防止验证方向本身错误（如"函数 X 存在吗"但其实问题在 Y）
    console.log(`[multimodel:${label}] Phase 0 — 前提质疑...`);
    premises = await questionPremises(fullTask);

    console.log(`[multimodel:${label}] verify — Codex 实测 ∥ M3 逻辑反推...`);
    const [cr, m3r] = await Promise.allSettled([
      callCodex(`Verify whether the following claim is true. Read actual code and run commands. For each finding include evidenceRef (file:line or test output):\n\n${fullTask}`, { repo }),
      callM3(`用纯逻辑推理找出以下声明的漏洞、反例或边界情况（不依赖运行代码）：\n\n${fullTask}`),
    ]);
    results['Codex实测'] = cr.status === 'fulfilled' ? cr.value : { ok: false, err: String(cr.reason), text: '' };
    results['M3逻辑反推(thinking)'] = m3r.status === 'fulfilled' ? m3r.value : { ok: false, err: String(m3r.reason), text: '' };

    // 双向质疑：实测结论和逻辑推理互相批判（一路有证据但可能读错，另一路有逻辑但无实证）
    if (enableCrossVerify && results['Codex实测'].ok && results['M3逻辑反推(thinking)'].ok) {
      console.log(`[multimodel:${label}] 双向强制质疑...`);
      const xr = await runCrossVerify(fullTask, results['Codex实测'].text, 'Codex实测', results['M3逻辑反推(thinking)'].text, 'M3推理');
      Object.assign(results, xr);
    }

    // 共识防幻觉
    if ([results['Codex实测'], results['M3逻辑反推(thinking)']].filter(r => r.ok).length >= 2) {
      console.log(`[multimodel:${label}] 共识防幻觉检查...`);
      const adversarial = await challengeConsensus(fullTask, { 'Codex实测': results['Codex实测'], 'M3推理': results['M3逻辑反推(thinking)'] });
      if (adversarial) results['对立假设检查(thinking)'] = adversarial;
    }

  } else if (mode === 'implement') {
    // 串行：M3 出 plan → Codex read-only 验证可行性（真实实施由 owner 执行）
    console.log(`[multimodel:${label}] implement — M3 出 plan...`);
    const m3r = await callM3(
      `你是技术方案设计者。给出详细改动建议（只给文字建议和伪代码，不直接改文件）：\n\n${fullTask}`
    );
    results['M3改动建议(thinking)'] = m3r;

    if (m3r.ok) {
      console.log(`[multimodel:${label}] Codex read-only 验证可行性...`);
      const cr = await callCodex(
        `Read the codebase (read-only) and verify whether this plan is feasible. Find potential conflicts, missing steps, or implementation issues. Include evidenceRef:\n\nPLAN:\n${m3r.text}\n\nORIGINAL TASK:\n${fullTask}`,
        { repo, allowWrite: false }
      );
      results['Codex可行性验证'] = cr;

      // 共识防幻觉：M3 plan + Codex validation 都通过时，让 M3 反驳这个串行共识
      if (cr.ok) {
        console.log(`[multimodel:${label}] 共识防幻觉检查...`);
        const adversarial = await challengeConsensus(fullTask, { 'M3建议': m3r, 'Codex验证': cr });
        if (adversarial) results['对立假设检查(thinking)'] = adversarial;
      }
    }
  }

  const summary = buildSynthesis(task, results, mode, premises);

  const outPath = out || `/tmp/multimodel-${label}-${Date.now()}.md`;
  mkdirSync(dirname(resolve(outPath)), { recursive: true });
  writeFileSync(outPath, summary.synthesis);
  console.log(`[multimodel:${label}] ✓ ${summary.successCount}路成功 → ${outPath}`);

  return { ...summary, outPath };
}

// ───── CLI 入口 ─────
if (IS_CLI) {
  const task = arg('task');
  const mode = arg('mode', 'auto');
  const repo = arg('repo', process.cwd());
  const inFile = arg('in') || undefined;
  const out = arg('out') || undefined;
  const label = arg('label', 'cli');

  if (!task) {
    console.error('用法: node scripts/multimodel.mjs --task "..." [--mode review|design|verify|implement] [--repo <仓库>] [--in <文件>] [--out <输出>] [--label <名>]');
    process.exit(2);
  }

  multimodel(task, { mode, repo, inFile, out, label, enableCrossVerify: true })
    .then(r => {
      console.log(`\n结果已写入: ${r.outPath}`);
      process.exit(r.successCount > 0 ? 0 : 1);
    })
    .catch(e => {
      console.error('[multimodel] 致命错误:', e);
      process.exit(1);
    });
}
