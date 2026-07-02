#!/usr/bin/env node
// @ts-check
// 生成 self-improve bench 的合成任务 fixtures（一次性脚手架；产物已入库，重跑会幂等覆盖）。
// 每个任务 = 一份「故意引入小 bug 的纯函数模块」+ 一组「探针（输入 + 期望输出）」。
// 任务 = fixture，绝不改真仓代码。
//
// 【P0 反 reward-hack 重构（三方审命脉）】判分不再由候选可达的进程自报：
//   - test.mjs 改成【任务无关的通用采样壳】：只 import ./subject.js、对父进程喂进来的【输入】调用
//     目标函数、把【返回值 / 抛错】以结构化 JSON 写到一段哨兵包裹的 stdout 块。它【不判对错、不读
//     nonce、不打印任何"通过信号"】。
//   - 期望输出（oracle）只存在 task.json 的 probes[].expect，由【父进程评测器】持有并比对；候选
//     subject 在子进程里【完全够不到】期望值，也没有任何可伪造的"转绿凭证"。
//   - 因此：ps 偷 nonce / process.exit 污染 / Array.prototype 污染 这三类攻击全部失效（无 nonce 可偷、
//     子进程 exit code 不参与判定、判定在父进程独立 realm 跑）。
//
// 三类覆盖：bug_fix（逻辑/差一/运算符）/ boundary（空值/边界/除零）/ feature（小特性补全）。
// 每任务四件套：subject.buggy.js（错的，candidate 起点）/ subject.fixed.js（对的，仅 evaluator 内部
// 用，绝不喂候选）/ test.mjs（通用采样壳）/ task.json（含 export 函数名 + probes 期望）。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {Object} Probe
 * @property {string} name
 * @property {any[]} args   调用目标函数的实参
 * @property {any} expect   期望返回值（oracle，仅父进程评测器持有）
 *
 * @typedef {Object} Task
 * @property {string} id
 * @property {'bug_fix'|'boundary'|'feature'} category
 * @property {string} title
 * @property {string} summary
 * @property {string} exportName  subject 导出的目标函数名
 * @property {string} signature   公开给候选的函数签名/约束（不含期望值）
 * @property {string} buggy
 * @property {string} fixed
 * @property {Probe[]} probes
 */

const header = '// @ts-check\n// 合成 self-improve bench 任务模块（fixture，非真仓代码）。\n';

// 通用采样壳（任务无关、防 reward-hack 重构版）。
// 关键点：
//  - 不判对错、不自报"通过信号"。只把函数对父进程给定【输入】的真实返回值/抛错结构化输出。
//  - 输入从 __probe_inputs.json 读（只含函数名 + 实参，【无期望值】；oracle 只在父进程）。
//  - 【认证 token（防伪造采样块）】父进程把一次性随机 token 写进 __bench_token（临时文件）。采样壳在
//    【import subject 之前】把 token 读出来并【立即 unlink】，于是候选 subject 的顶层代码（import 期间
//    才执行）既读不到该文件（已删）、也读不到采样壳的模块局部 token 变量。采样壳用 token 对结果算
//    HMAC(sha256(token + json)) 一起输出。
//  - 父进程验证 mac 命中【且】用 oracle 比对内容才判绿。候选若顶层 process.exit 前自印一个伪造块、
//    或污染 stdout/JSON：它【算不出合法 mac】（token 它够不到）=> 父进程弃用伪造块 => 判不绿。
//    它给真返回值才能通过 oracle，而给真返回值=就是正确实现。token 不在 argv/env/命令行，ps 也偷不到。
const TEST_SHELL = `${header}// 通用采样壳：不判分、不自报。先读并删 token（认证用，非"通过凭证"），再 import subject 采样。
import { readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BEGIN = '<<<NOE_BENCH_SAMPLES_BEGIN>>>';
const END = '<<<NOE_BENCH_SAMPLES_END>>>';

// —— 在 import subject 之前完成：读 token + 立即 unlink（subject 顶层届时已够不到该文件）——
const tokenUrl = new URL('./__bench_token', import.meta.url);
const inputsUrl = new URL('./__probe_inputs.json', import.meta.url);
let TOKEN = '';
try { TOKEN = readFileSync(tokenUrl, 'utf8'); } catch {}
try { unlinkSync(tokenUrl); } catch {}
const write = process.stdout.write.bind(process.stdout); // 私有引用，规避 subject 改 process.stdout

function emit(payload) {
  const json = JSON.stringify(payload);
  const mac = createHash('sha256').update(TOKEN + json).digest('hex');
  write('\\n' + BEGIN + '\\n' + JSON.stringify({ mac, json }) + '\\n' + END + '\\n');
}

async function main() {
  let spec;
  try {
    spec = JSON.parse(readFileSync(inputsUrl, 'utf8'));
  } catch (err) {
    emit({ ok: false, error: 'probe_inputs_unreadable:' + String(err && err.message || err) });
    return;
  }
  let subject;
  try {
    subject = await import('./subject.js');
  } catch (err) {
    emit({ ok: false, error: 'subject_import_failed:' + String(err && err.message || err) });
    return;
  }
  const fn = subject && subject[spec.exportName];
  if (typeof fn !== 'function') {
    emit({ ok: false, error: 'export_missing:' + String(spec.exportName) });
    return;
  }
  const samples = [];
  for (const inp of Array.isArray(spec.inputs) ? spec.inputs : []) {
    try {
      const value = fn.apply(null, Array.isArray(inp.args) ? inp.args : []);
      samples.push({ name: String(inp.name), returned: value });
    } catch (err) {
      samples.push({ name: String(inp.name), threw: String(err && err.message || err) });
    }
  }
  emit({ ok: true, exportName: String(spec.exportName), samples });
}

main();
`;

/** @type {Task[]} */
const tasks = [
  // ——— bug_fix ———
  {
    id: 'sum-positive',
    category: 'bug_fix',
    title: '只累加正数',
    summary: '差一/条件写错：应只累加 > 0 的项，buggy 累加了所有项。',
    exportName: 'sumPositive',
    signature: 'sumPositive(nums: number[]): number — 只累加 > 0 的项之和；空集为 0。',
    buggy: `${header}export function sumPositive(nums) {
  let total = 0;
  for (const n of nums) {
    total += n; // BUG: 未过滤非正数
  }
  return total;
}
`,
    fixed: `${header}export function sumPositive(nums) {
  let total = 0;
  for (const n of nums) {
    if (n > 0) total += n;
  }
  return total;
}
`,
    probes: [
      { name: 'mixed', args: [[1, -2, 3, -4, 5]], expect: 9 },
      { name: 'all-neg', args: [[-1, -2, -3]], expect: 0 },
      { name: 'empty', args: [[]], expect: 0 },
      { name: 'zeros', args: [[0, 0, 2]], expect: 2 },
    ],
  },
  {
    id: 'is-even',
    category: 'bug_fix',
    title: '判偶数运算符写反',
    summary: '运算符写错：buggy 用 === 1 当偶数判定，应为 === 0。',
    exportName: 'isEven',
    signature: 'isEven(n: number): boolean — n 为偶数返回 true。',
    buggy: `${header}export function isEven(n) {
  return n % 2 === 1; // BUG: 写成了判奇
}
`,
    fixed: `${header}export function isEven(n) {
  return n % 2 === 0;
}
`,
    probes: [
      { name: '4', args: [4], expect: true },
      { name: '7', args: [7], expect: false },
      { name: '0', args: [0], expect: true },
      { name: 'neg2', args: [-2], expect: true },
    ],
  },
  {
    id: 'last-index-of',
    category: 'bug_fix',
    title: '取最后一次出现下标',
    summary: '循环方向错：buggy 返回首次出现，应返回最后一次。',
    exportName: 'lastIndexOf',
    signature: 'lastIndexOf(arr: any[], value: any): number — 返回 value 最后一次出现的下标，无则 -1。',
    buggy: `${header}export function lastIndexOf(arr, value) {
  for (let i = 0; i < arr.length; i += 1) {
    if (arr[i] === value) return i; // BUG: 正向返回首个
  }
  return -1;
}
`,
    fixed: `${header}export function lastIndexOf(arr, value) {
  for (let i = arr.length - 1; i >= 0; i -= 1) {
    if (arr[i] === value) return i;
  }
  return -1;
}
`,
    probes: [
      { name: 'dup', args: [[1, 2, 3, 2, 1], 2], expect: 3 },
      { name: 'single', args: [[9], 9], expect: 0 },
      { name: 'absent', args: [[1, 2], 5], expect: -1 },
      { name: 'last', args: [[4, 4, 4], 4], expect: 2 },
    ],
  },
  {
    id: 'percent-format',
    category: 'bug_fix',
    title: '百分比格式化',
    summary: '少乘 100：buggy 直接拼 %，0.25 应得 "25%"。',
    exportName: 'toPercent',
    signature: 'toPercent(ratio: number): string — 把比例格式化为百分比字符串，如 0.25 => "25%"。',
    buggy: `${header}export function toPercent(ratio) {
  return ratio + '%'; // BUG: 忘记 *100
}
`,
    fixed: `${header}export function toPercent(ratio) {
  return Math.round(ratio * 100) + '%';
}
`,
    probes: [
      { name: 'quarter', args: [0.25], expect: '25%' },
      { name: 'half', args: [0.5], expect: '50%' },
      { name: 'whole', args: [1], expect: '100%' },
      { name: 'zero', args: [0], expect: '0%' },
    ],
  },
  {
    id: 'merge-defaults',
    category: 'bug_fix',
    title: '合并默认值方向写反',
    summary: '展开顺序错：buggy 让 defaults 覆盖 overrides，应反过来。',
    exportName: 'withDefaults',
    signature: 'withDefaults(overrides: object, defaults: object): object — overrides 覆盖 defaults。',
    buggy: `${header}export function withDefaults(overrides, defaults) {
  return { ...overrides, ...defaults }; // BUG: defaults 覆盖了 overrides
}
`,
    fixed: `${header}export function withDefaults(overrides, defaults) {
  return { ...defaults, ...overrides };
}
`,
    probes: [
      { name: 'merge', args: [{ a: 2, c: 9 }, { a: 1, b: 1 }], expect: { a: 2, b: 1, c: 9 } },
      { name: 'override-only', args: [{ x: 5 }, {}], expect: { x: 5 } },
      { name: 'default-only', args: [{}, { y: 7 }], expect: { y: 7 } },
    ],
  },
  {
    id: 'clamp',
    category: 'bug_fix',
    title: 'clamp 边界比较写反',
    summary: 'min/max 用反：buggy 把 Math.max/min 写颠倒，clamp 失效。',
    exportName: 'clamp',
    signature: 'clamp(value: number, min: number, max: number): number — 把 value 夹到 [min, max]。',
    buggy: `${header}export function clamp(value, min, max) {
  return Math.min(min, Math.max(max, value)); // BUG: min/max 用反
}
`,
    fixed: `${header}export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
`,
    probes: [
      { name: 'inside', args: [5, 0, 10], expect: 5 },
      { name: 'below', args: [-3, 0, 10], expect: 0 },
      { name: 'above', args: [99, 0, 10], expect: 10 },
      { name: 'edge', args: [10, 0, 10], expect: 10 },
    ],
  },
  {
    id: 'word-count',
    category: 'bug_fix',
    title: '分词忽略多余空格',
    summary: '正则错：buggy 按单空格 split 导致空串计入，应按 \\\\s+ 且去空。',
    exportName: 'wordCount',
    signature: 'wordCount(text: string): number — 统计词数，忽略首尾/连续空白。',
    buggy: `${header}export function wordCount(text) {
  if (text === '') return 0;
  return text.split(' ').length; // BUG: 连续空格/首尾空格会多计
}
`,
    fixed: `${header}export function wordCount(text) {
  const words = text.trim().split(/\\s+/).filter(Boolean);
  return words.length;
}
`,
    probes: [
      { name: 'simple', args: ['hello world'], expect: 2 },
      { name: 'extra-space', args: ['a   b  c'], expect: 3 },
      { name: 'trim', args: ['  lead trail  '], expect: 2 },
      { name: 'empty', args: [''], expect: 0 },
    ],
  },
  // ——— boundary ———
  {
    id: 'safe-divide',
    category: 'boundary',
    title: '除零保护',
    summary: '边界：除数为 0 应返回 0（或约定值），buggy 直接除得 Infinity/NaN。',
    exportName: 'safeDivide',
    signature: 'safeDivide(a: number, b: number): number — b===0 返回 0，否则 a/b。',
    buggy: `${header}export function safeDivide(a, b) {
  return a / b; // BUG: b===0 未处理
}
`,
    fixed: `${header}export function safeDivide(a, b) {
  if (b === 0) return 0;
  return a / b;
}
`,
    probes: [
      { name: 'normal', args: [10, 2], expect: 5 },
      { name: 'zero-denominator', args: [5, 0], expect: 0 },
      { name: 'zero-numerator', args: [0, 4], expect: 0 },
      { name: 'neg', args: [-6, 3], expect: -2 },
    ],
  },
  {
    id: 'first-or-default',
    category: 'boundary',
    title: '空数组取首元素',
    summary: '边界：空/非数组应回退 fallback，buggy 直接 arr[0] 得 undefined。',
    exportName: 'firstOrDefault',
    signature: 'firstOrDefault(arr: any[], fallback: any): any — 非数组/空返回 fallback，否则首元素。',
    buggy: `${header}export function firstOrDefault(arr, fallback) {
  return arr[0]; // BUG: 空数组/非数组未回退
}
`,
    fixed: `${header}export function firstOrDefault(arr, fallback) {
  if (!Array.isArray(arr) || arr.length === 0) return fallback;
  return arr[0];
}
`,
    probes: [
      { name: 'has', args: [[7, 8], 0], expect: 7 },
      { name: 'empty', args: [[], 42], expect: 42 },
      { name: 'not-array', args: [null, 'x'], expect: 'x' },
      { name: 'zero-elem', args: [[0], 99], expect: 0 },
    ],
  },
  {
    id: 'truncate',
    category: 'boundary',
    title: '截断字符串边界',
    summary: '边界：长度 <= max 不应加省略号，buggy 总是切片加 …。',
    exportName: 'truncate',
    signature: 'truncate(text: string, max: number): string — 超过 max 才切片加 …，否则原样。',
    buggy: `${header}export function truncate(text, max) {
  return text.slice(0, max) + '…'; // BUG: 未判断是否真的超长
}
`,
    fixed: `${header}export function truncate(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}
`,
    probes: [
      { name: 'long', args: ['abcdef', 3], expect: 'abc…' },
      { name: 'exact', args: ['abc', 3], expect: 'abc' },
      { name: 'short', args: ['ab', 5], expect: 'ab' },
      { name: 'empty', args: ['', 3], expect: '' },
    ],
  },
  {
    id: 'parse-int-default',
    category: 'boundary',
    title: '解析整数带兜底',
    summary: '边界：非法/空输入应回退 fallback，buggy 直接返回 NaN。',
    exportName: 'parseIntOr',
    signature: 'parseIntOr(value: string, fallback: number): number — 解析失败返回 fallback。',
    buggy: `${header}export function parseIntOr(value, fallback) {
  return parseInt(value, 10); // BUG: NaN 未兜底
}
`,
    fixed: `${header}export function parseIntOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) ? fallback : n;
}
`,
    probes: [
      { name: 'ok', args: ['42', 0], expect: 42 },
      { name: 'bad', args: ['abc', -1], expect: -1 },
      { name: 'empty', args: ['', 7], expect: 7 },
      { name: 'leading', args: ['10px', 0], expect: 10 },
    ],
  },
  {
    id: 'avg',
    category: 'boundary',
    title: '平均值空集保护',
    summary: '边界：空数组应返回 0 而非 NaN（0/0），buggy 未防。',
    exportName: 'average',
    signature: 'average(nums: number[]): number — 算术平均；空集返回 0。',
    buggy: `${header}export function average(nums) {
  const sum = nums.reduce((a, b) => a + b, 0);
  return sum / nums.length; // BUG: 空数组 => NaN
}
`,
    fixed: `${header}export function average(nums) {
  if (nums.length === 0) return 0;
  const sum = nums.reduce((a, b) => a + b, 0);
  return sum / nums.length;
}
`,
    probes: [
      { name: 'basic', args: [[2, 4, 6]], expect: 4 },
      { name: 'single', args: [[5]], expect: 5 },
      { name: 'empty', args: [[]], expect: 0 },
      { name: 'neg', args: [[-2, 2]], expect: 0 },
    ],
  },
  {
    id: 'get-nested',
    category: 'boundary',
    title: '安全取嵌套字段',
    summary: '边界：路径中途为 null 应回退，buggy 直接链式访问会抛错。',
    exportName: 'getNested',
    signature: 'getNested(obj: object, keys: string[], fallback: any): any — 路径中途为 null/undefined 返回 fallback。',
    buggy: `${header}export function getNested(obj, keys, fallback) {
  let cur = obj;
  for (const k of keys) {
    cur = cur[k]; // BUG: cur 为 null/undefined 时抛 TypeError
  }
  return cur;
}
`,
    fixed: `${header}export function getNested(obj, keys, fallback) {
  let cur = obj;
  for (const k of keys) {
    if (cur == null) return fallback;
    cur = cur[k];
  }
  return cur == null ? fallback : cur;
}
`,
    probes: [
      { name: 'deep', args: [{ a: { b: { c: 1 } } }, ['a', 'b', 'c'], 0], expect: 1 },
      { name: 'missing-mid', args: [{ a: {} }, ['a', 'b', 'c'], 'd'], expect: 'd' },
      { name: 'null-root', args: [null, ['a'], 'r'], expect: 'r' },
      { name: 'leaf-null', args: [{ a: null }, ['a'], 'f'], expect: 'f' },
    ],
  },
  // ——— feature ———
  {
    id: 'pluralize',
    category: 'feature',
    title: '补全复数后缀',
    summary: '小特性：count===1 用单数，其余加 s；buggy 永远不加 s。',
    exportName: 'pluralize',
    signature: 'pluralize(count: number, word: string): string — count===1 单数，否则词尾加 s。',
    buggy: `${header}export function pluralize(count, word) {
  return count + ' ' + word; // BUG: 未实现复数
}
`,
    fixed: `${header}export function pluralize(count, word) {
  return count + ' ' + (count === 1 ? word : word + 's');
}
`,
    probes: [
      { name: 'one', args: [1, 'cat'], expect: '1 cat' },
      { name: 'many', args: [3, 'cat'], expect: '3 cats' },
      { name: 'zero', args: [0, 'dog'], expect: '0 dogs' },
      { name: 'neg', args: [2, 'box'], expect: '2 boxs' },
    ],
  },
  {
    id: 'classify-sign',
    category: 'feature',
    title: '补全零分支',
    summary: '小特性：返回 positive/negative/zero；buggy 漏了 zero 分支返回了 negative。',
    exportName: 'classifySign',
    signature: 'classifySign(n: number): string — 返回 "positive" / "negative" / "zero"。',
    buggy: `${header}export function classifySign(n) {
  if (n > 0) return 'positive';
  return 'negative'; // BUG: 漏了 0 => zero
}
`,
    fixed: `${header}export function classifySign(n) {
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'zero';
}
`,
    probes: [
      { name: 'pos', args: [5], expect: 'positive' },
      { name: 'neg', args: [-3], expect: 'negative' },
      { name: 'zero', args: [0], expect: 'zero' },
    ],
  },
  {
    id: 'initials',
    category: 'feature',
    title: '生成姓名缩写',
    summary: '小特性：取每个单词首字母大写拼接；buggy 只返回了首词首字母。',
    exportName: 'initials',
    signature: 'initials(name: string): string — 每个单词首字母大写拼接。',
    buggy: `${header}export function initials(name) {
  return name[0].toUpperCase(); // BUG: 只取了第一个字母
}
`,
    fixed: `${header}export function initials(name) {
  return name
    .trim()
    .split(/\\s+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join('');
}
`,
    probes: [
      { name: 'two', args: ['john doe'], expect: 'JD' },
      { name: 'three', args: ['a b c'], expect: 'ABC' },
      { name: 'one', args: ['madonna'], expect: 'M' },
      { name: 'spaces', args: ['  mary  jane '], expect: 'MJ' },
    ],
  },
];

let written = 0;
for (const task of tasks) {
  const dir = join(HERE, task.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'subject.buggy.js'), task.buggy);
  writeFileSync(join(dir, 'subject.fixed.js'), task.fixed);
  writeFileSync(join(dir, 'test.mjs'), TEST_SHELL);
  writeFileSync(join(dir, 'task.json'), JSON.stringify({
    schemaVersion: 2,
    id: task.id,
    category: task.category,
    title: task.title,
    summary: task.summary,
    source: 'synthetic',
    subjectFile: 'subject.js',
    testFile: 'test.mjs',
    buggyFile: 'subject.buggy.js',
    fixedFile: 'subject.fixed.js',
    export: task.exportName,
    signature: task.signature,
    probes: task.probes,
  }, null, 2) + '\n');
  written += 1;
}

writeFileSync(join(HERE, 'manifest.json'), JSON.stringify({
  schemaVersion: 2,
  id: 'noe-selfimprove-bench-v1',
  source: 'synthetic',
  generatedBy: 'evals/neo/selfimprove-bench/_generate_tasks.mjs',
  categories: { bug_fix: tasks.filter((t) => t.category === 'bug_fix').length, boundary: tasks.filter((t) => t.category === 'boundary').length, feature: tasks.filter((t) => t.category === 'feature').length },
  taskCount: tasks.length,
  tasks: tasks.map((t) => ({ id: t.id, category: t.category, title: t.title })),
}, null, 2) + '\n');

console.log(`wrote ${written} tasks + manifest -> ${HERE}`);
