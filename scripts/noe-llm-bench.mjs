#!/usr/bin/env node
// noe-llm-bench — 本地 LLM 基准实测：TTFT（首 token 延迟）+ 生成速度（tok/s）+ prefill 吞吐。
// 用途：设计文档《AI自我意识实现方案》§9 的"估"数字全部要被本脚本的实测覆盖（先测后信，宪法第 5 条）；
//      只用于手动 benchmark / 显式实验，不自动改变 Noe 三角色模型策略。
// 用法：
//   node scripts/noe-llm-bench.mjs --models "qwen3.6-35b-a3b-mlx,gemma-4-31b-it-qat" \
//     [--base http://127.0.0.1:1234/v1] [--ctx 1k,8k] [--gen 256] [--out docs/基准_M5Max_模型实测.md]
// 纪律：跑模型不设任何超时（LM Studio JIT 首加载 7-180s 正常）；纯 Node 零新依赖（fetch 内置）。

import { writeFileSync } from 'node:fs';

function parseArgs(argv) {
  const args = { base: 'http://127.0.0.1:1234/v1', ctx: '1k,8k', gen: 256, models: '', out: '' };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--models') args.models = argv[++i] || '';
    else if (k === '--base') args.base = argv[++i] || args.base;
    else if (k === '--ctx') args.ctx = argv[++i] || args.ctx;
    else if (k === '--gen') args.gen = Number(argv[++i]) || args.gen;
    else if (k === '--out') args.out = argv[++i] || '';
  }
  return args;
}

const FILLER = 'The quick brown fox jumps over the lazy dog while the river flows quietly past the old mill. ';

// 目标 token 数 → 拼一段填充文本（≈4 chars/token 英文经验值；实际 prompt_tokens 以 usage 回报为准）
function buildPrompt(targetTokens) {
  const chars = Math.max(200, targetTokens * 4);
  const body = FILLER.repeat(Math.ceil(chars / FILLER.length)).slice(0, chars);
  return `${body}\n\n请用一句中文总结上文大意。`;
}

function parseCtxList(s) {
  return String(s).split(',').map((x) => x.trim().toLowerCase()).filter(Boolean).map((x) => {
    const n = parseFloat(x);
    return x.endsWith('k') ? Math.round(n * 1000) : Math.round(n);
  }).filter((n) => Number.isFinite(n) && n > 0);
}

async function chatOnce({ base, model, prompt, maxTokens, stream }) {
  const body = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0,
    stream,
  };
  const t0 = performance.now();
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);

  if (!stream) {
    const j = await res.json();
    const t1 = performance.now();
    return {
      totalMs: t1 - t0,
      promptTokens: j?.usage?.prompt_tokens ?? null,
      completionTokens: j?.usage?.completion_tokens ?? null,
    };
  }

  // 流式：首个含内容的 chunk 时刻 = TTFT；按 chunk 计数近似 token 数（LM Studio 按 token 推流）
  let ttftMs = null;
  let chunks = 0;
  let usage = null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const j = JSON.parse(payload);
        if (j?.usage) usage = j.usage;
        const delta = j?.choices?.[0]?.delta?.content;
        if (delta) {
          chunks++;
          if (ttftMs === null) ttftMs = performance.now() - t0;
        }
      } catch { /* 非 JSON 行忽略 */ }
    }
  }
  const totalMs = performance.now() - t0;
  return { ttftMs, totalMs, chunks, usage };
}

async function benchModel({ base, model, ctxTokens, genTokens }) {
  const rows = [];
  for (const ctx of ctxTokens) {
    const prompt = buildPrompt(ctx);
    // 预热（触发 JIT 加载 + 该上下文长度的首次编译），不计入 TTFT
    process.stdout.write(`  [${model}] ctx≈${ctx} 预热（JIT 可能数分钟）… `);
    const warmT0 = performance.now();
    await chatOnce({ base, model, prompt, maxTokens: 8, stream: false });
    const warmMs = performance.now() - warmT0;
    process.stdout.write(`${(warmMs / 1000).toFixed(1)}s\n`);

    // 非流式：拿权威 usage（prompt/completion tokens）+ 总时长
    const plain = await chatOnce({ base, model, prompt, maxTokens: genTokens, stream: false });
    // 流式：拿 TTFT 与生成段时长
    const streamed = await chatOnce({ base, model, prompt, maxTokens: genTokens, stream: true });

    const compTok = plain.completionTokens ?? streamed.chunks ?? genTokens;
    const genMs = streamed.totalMs - (streamed.ttftMs ?? 0);
    const genTps = genMs > 0 ? (streamed.chunks || compTok) / (genMs / 1000) : null;
    const prefillTps = streamed.ttftMs && plain.promptTokens ? plain.promptTokens / (streamed.ttftMs / 1000) : null;
    rows.push({
      model,
      ctxTarget: ctx,
      promptTokens: plain.promptTokens,
      completionTokens: compTok,
      warmupMs: Math.round(warmMs),
      ttftMs: streamed.ttftMs === null ? null : Math.round(streamed.ttftMs),
      genTps: genTps === null ? null : Math.round(genTps * 10) / 10,
      prefillTps: prefillTps === null ? null : Math.round(prefillTps),
      totalMs: Math.round(streamed.totalMs),
    });
    console.log(`  [${model}] ctx≈${ctx} → TTFT ${rows.at(-1).ttftMs}ms · 生成 ${rows.at(-1).genTps} tok/s · prefill ≈${rows.at(-1).prefillTps} tok/s`);
  }
  return rows;
}

function toMarkdown(allRows, { base, gen }) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = [
    `# M5 Max 本地模型基准实测　${date}`,
    '',
    `> 脚本：\`node scripts/noe-llm-bench.mjs\`；端点 ${base}；生成 ${gen} token；temperature 0。`,
    '> TTFT=流式首 token 延迟（预热后，不含 JIT 加载）；生成速度按流式 chunk 计数（≈token）；',
    '> prefill 吞吐 = prompt_tokens / TTFT（近似，含调度开销，偏保守）。',
    '',
    '| 模型 | 目标 ctx | 实际 prompt tok | TTFT (ms) | 生成 (tok/s) | prefill (tok/s) | 预热含加载 (ms) |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const r of allRows) {
    if (r.error) {
      lines.push(`| ${r.model} | ${r.ctxTarget ?? '—'} | — | — | — | — | ❌ ${r.error.slice(0, 80)} |`);
    } else {
      lines.push(`| ${r.model} | ≈${r.ctxTarget} | ${r.promptTokens ?? '—'} | ${r.ttftMs ?? '—'} | ${r.genTps ?? '—'} | ${r.prefillTps ?? '—'} | ${r.warmupMs} |`);
    }
  }
  lines.push('', '结论（手动 benchmark）由读者按质量/速度裁定；当前运行时策略是 Q35-6 主脑、Q27-4 复核、G26-4 兜底，benchmark 不会自动改写默认配置。', '');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv);
  const models = args.models.split(',').map((s) => s.trim()).filter(Boolean);
  if (!models.length) {
    console.error('用法：node scripts/noe-llm-bench.mjs --models "modelA,modelB" [--base url] [--ctx 1k,8k] [--gen 256] [--out 文件.md]');
    process.exit(1);
  }
  const ctxTokens = parseCtxList(args.ctx);
  console.log(`基准开始：${models.length} 个模型 × ctx ${ctxTokens.join('/')} × 生成 ${args.gen} tok（端点 ${args.base}，无超时）`);
  const allRows = [];
  for (const model of models) {
    try {
      allRows.push(...await benchModel({ base: args.base, model, ctxTokens, genTokens: args.gen }));
    } catch (e) {
      console.error(`  [${model}] ❌ ${e?.message}`);
      allRows.push({ model, error: String(e?.message || e) });
    }
  }
  const md = toMarkdown(allRows, { base: args.base, gen: args.gen });
  console.log(`\n${md}`);
  if (args.out) {
    writeFileSync(args.out, md);
    writeFileSync(args.out.replace(/\.md$/, '.json'), JSON.stringify(allRows, null, 2));
    console.log(`已写入 ${args.out}（含同名 .json 原始数据）`);
  }
}

main().catch((e) => { console.error('基准失败：', e); process.exit(1); });
