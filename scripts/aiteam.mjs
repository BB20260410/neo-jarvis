#!/usr/bin/env node
// aiteam — "AI 外包班组长":把一项活路由给最合适的辅助模型(Gemini/M3/MiMo),
//   内置重试 + 跨厂回退,结果落盘只回一行指针,专为"给 Claude 主循环减负、用掉闲置额度"而生。
//
// 用法:
//   node scripts/aiteam.mjs --task "问题/指令" [--vendor auto|gemini|m3|mimo] [--in <喂给它的文件>]
//        [--repo <让 gemini agentic 读的仓目录>] [--out <落盘 md 路径>] [--label 名字]
//
// 路由(auto):给了 --repo → gemini(它能 agentic 读真代码);否则 → m3(周全);要快可 --vendor mimo。
// 回退链:gemini→m3→mimo;m3→mimo→gemini;mimo→m3→gemini。任一成功即停。
// 只烧辅助模型额度,绝不动 Claude;只读/分析,不替你改任何文件(产出是文本/补丁建议,由 Claude 审用)。
import { MiniMaxChatAdapter } from '../src/room/MiniMaxChatAdapter.js';
import { OpenAICompatChatAdapter } from '../src/room/OpenAICompatChatAdapter.js';
import { resolveNoeProviderSecret } from '../src/secrets/NoeProviderSecrets.js';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

function arg(name, def = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const MODE = arg('mode', '');
// 预设搭配（2026-06-10 实测得出的最佳用法）：review→M3 禁thinking 审代码;deepread→Gemini agentic 读真代码
const MODE_PROMPTS = {
  review: '你是严格的代码审查者。审查附带代码,找出真实 bug、边界漏洞、逻辑/语义问题、可改进点。每条须具体:问题→触发条件→后果→改法。不要泛泛夸奖;没问题的部分就明说没问题。',
  deepread: '在本仓库里 agentic 阅读相关真实代码后回答。禁止编造行号/函数名;先列出你实际读了哪些文件作为佐证,再回答:',
  explain: '用简洁中文解释附带代码:它做什么、关键设计、潜在风险点。',
};
const TASK = arg('task') || MODE_PROMPTS[MODE] || '';
const VENDOR = arg('vendor', 'auto');
const INFILE = arg('in');
const REPO = arg('repo');
const OUT = arg('out', `/tmp/aiteam-${Date.now()}.md`);
const LABEL = arg('label', 'aiteam');
if (!TASK) { console.error('需要 --task 或 --mode review|deepread|explain'); process.exit(2); }

const ctx = INFILE ? `\n\n=== 附带材料(${INFILE}) ===\n${(() => { try { const t = readFileSync(INFILE, 'utf8'); return t.length > 120000 ? t.slice(0, 120000) + '\n...[截断]' : t; } catch { return '(读不到)'; } })()}` : '';
const PROMPT = (MODE_PROMPTS[MODE] && arg('task')) ? `${MODE_PROMPTS[MODE]}\n\n${arg('task')}${ctx}` : `${TASK}${ctx}`;

function runGemini() {
  return new Promise((res) => {
    const args = ['--skip-trust', '--approval-mode', 'plan', '--output-format', 'text', '-m', 'gemini-3.1-pro-preview', '--prompt', PROMPT];
    const child = spawn('gemini', args, { cwd: REPO || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => res({ ok: false, err: String(e?.message || e).slice(0, 160) }));
    child.on('close', (code) => {
      const clean = out.split('\n').filter((l) => !/Gaxios|ECONNRESET|at async|node:|Symbol\(|MCP issues|admin controls|streamGenerate|proxy:|Authorization|x-goog/.test(l)).join('\n').trim();
      res(code === 0 && clean.length > 40 ? { ok: true, text: clean } : { ok: false, err: `gemini exit=${code} 有效输出${clean.length}字(可能未登录/代理超时)` });
    });
  });
}
async function runM3() {
  const s = resolveNoeProviderSecret('minimax');
  if (!s?.value) return { ok: false, err: 'no minimax key' };
  // 2026-06-19 策略更新：thinking 默认开启（质量优先，不计时间成本）。
  // AITEAM_M3_THINK=0 可显式关闭（唯一降级逃生口），不设 maxCompletionTokens 上限。
  const think = process.env.AITEAM_M3_THINK === '0' ? 'disabled' : undefined;
  const a = new MiniMaxChatAdapter({ apiKey: s.value, baseUrl: process.env.MINIMAX_BASE_URL, model: 'MiniMax-M3', thinking: think });
  try { const r = await a._doChat([{ role: 'user', content: PROMPT }], { noAbort: true, thinking: think }); const t = (r?.reply || '').trim(); return t.length > 0 ? { ok: true, text: t } : { ok: false, err: 'empty reply' }; } catch (e) { return { ok: false, err: String(e?.message || e).slice(0, 160) }; }
}
async function runMiMo() {
  const s = resolveNoeProviderSecret('xiaomi');
  if (!s?.value) return { ok: false, err: 'no xiaomi key' };
  const a = new OpenAICompatChatAdapter({ id: 'xiaomi-mimo', displayName: 'Xiaomi MiMo', apiKey: s.value, baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1', model: 'mimo-v2.5-pro', timeout: 0, temperature: 0.3, maxTokens: 4096 });
  try { const r = await a._doChat([{ role: 'user', content: PROMPT }], { noAbort: true, model: 'mimo-v2.5-pro', temperature: 0.3, maxTokens: 4096 }); const t = (r?.reply || '').trim(); return t.length > 0 ? { ok: true, text: t } : { ok: false, err: 'empty reply' }; } catch (e) { return { ok: false, err: String(e?.message || e).slice(0, 160) }; }
}
// 2026-06-19: 新增 Codex(GPT-5.5) vendor — 本地代码读取 / 真实验证
function runCodex() {
  return new Promise((res) => {
    const args = [
      'exec', '-s', 'read-only', // auto 无效，合法值: read-only|workspace-write|danger-full-access
      '--ephemeral',
      '--dangerously-bypass-approvals-and-sandbox',
      PROMPT,
    ];
    const child = spawn('codex', args, { cwd: REPO || process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', (e) => res({ ok: false, err: String(e?.message || e).slice(0, 160) }));
    child.on('close', (code) => {
      const text = out.trim();
      res(code === 0 && text.length > 20 ? { ok: true, text } : { ok: false, err: `codex exit=${code} 输出=${text.length}字` });
    });
  });
}
// 2026-06-19: 路由更新 — 默认三路改为 M3(thinking)+Codex; MiMo/Gemini 保留但退出默认链
const RUN = { gemini: runGemini, m3: runM3, mimo: runMiMo, codex: runCodex };
const CHAIN = {
  auto: REPO ? ['codex', 'm3'] : ['m3', 'codex'],   // 有 repo → Codex 读真代码优先；否则 M3
  codex: ['codex', 'm3'], m3: ['m3', 'codex'],
  gemini: ['gemini', 'm3', 'codex'], mimo: ['mimo', 'm3', 'codex'], // 向后兼容
};

(async () => {
  const chain = CHAIN[VENDOR] || CHAIN.auto;
  for (const v of chain) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const t0 = Date.now();
      const r = await RUN[v]();
      if (r.ok) {
        mkdirSync(dirname(OUT), { recursive: true });
        writeFileSync(OUT, `# aiteam:${LABEL} (vendor=${v})\n\n${r.text}`);
        console.log(`[aiteam] ${LABEL} ✓ ${v} ${Date.now() - t0}ms ${r.text.length}字 -> ${OUT}`);
        process.exit(0);
      }
      console.log(`[aiteam] ${LABEL} ✗ ${v} 第${attempt}次失败(${Date.now() - t0}ms)${r.err ? ' — ' + r.err : ''}`);
    }
  }
  console.error(`[aiteam] ${LABEL} 全链路失败(${chain.join('→')})`);
  process.exit(1);
})();
