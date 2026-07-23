// @ts-check
// NoeCapabilityBattery — 阶段一B 能力题库(北极星尺子的数据+打分层)。
//
// 问题:「绿测试」只答「没弄坏」,答不了「Neo 越进化越能干了吗」。需要一套 held-out 自改任务,定期重跑,
//   量「通过率随难度/随时间」——这才是真正的适应度函数。题库用自带 fixture(不碰真实仓库、确定性、安全)。
// 打分:补丁可 apply(replace 的 from 在 content 精确命中一次,或 write_file)且产出含预期标记 → pass。
//   这直接量到我实测的能力画像:结构化任务本地精确命中(pass)、复杂内部逻辑编造 from(applicable=false→fail)。
// 纯函数、fail-open、可独立单测。runner(scripts/noe-capability-battery.mjs)用真实本地 implementer 离线跑。

/**
 * held-out 自改任务集。tier: easy(结构化/签名) / medium(内部逻辑) / hard(跨点重构) / test(补测试)。
 * content 是自带 fixture;objective 喂 implementer;expectMarker 是产出必须含的标记(粗判"对没对")。
 */
export const CAPABILITY_BATTERY = Object.freeze([
  {
    id: 'jsdoc-signature',
    tier: 'easy',
    file: 'battery/calc.js',
    content: 'export function clamp(v, lo, hi) {\n  return Math.max(lo, Math.min(hi, v));\n}\n',
    objective: '为 clamp 函数补 JSDoc 类型注解(@param/@returns),不改逻辑',
    expectMarker: '@param',
  },
  {
    id: 'guard-clause',
    tier: 'easy',
    file: 'battery/parse.js',
    content: 'export function firstLine(text) {\n  return text.split("\\n")[0];\n}\n',
    objective: '在 firstLine 开头加防御:text 非字符串时返回空串',
    expectMarker: 'typeof',
  },
  {
    id: 'default-param',
    tier: 'medium',
    file: 'battery/retry.js',
    content: 'export function retry(fn, times) {\n  for (let i = 0; i < times; i++) {\n    try { return fn(); } catch {}\n  }\n  throw new Error("exhausted");\n}\n',
    objective: '给 retry 的 times 参数加默认值 3,并在 times 非正整数时兜底为 3',
    expectMarker: 'times',
  },
  {
    id: 'extract-const',
    tier: 'medium',
    file: 'battery/limit.js',
    content: 'export function cap(n) {\n  return Math.min(n, 1000);\n}\n',
    objective: '把魔法数 1000 抽成命名常量 MAX_CAP 并用它',
    expectMarker: 'MAX_CAP',
  },
  {
    id: 'null-safety',
    tier: 'hard',
    file: 'battery/pick.js',
    content: 'export function pickName(user) {\n  return user.profile.name;\n}\n',
    objective: '让 pickName 对 user 或 user.profile 缺失时安全返回空串(可选链或防御)',
    expectMarker: '?.',
  },
  {
    id: 'add-test',
    tier: 'test',
    file: 'battery/sum.js',
    content: 'export function sum(arr) {\n  return arr.reduce((a, b) => a + b, 0);\n}\n',
    objective: '为 sum 函数写一个 vitest 单元测试(import from vitest,放 tests/)',
    expectMarker: 'describe(',
  },
]);

function countOccurrences(haystack, needle) {
  if (!needle) return -1;
  return String(haystack).split(String(needle)).length - 1;
}

/**
 * 给一个 patchPlan 对某题打分。可 apply(from 精确命中一次 / write_file)且产出含预期标记 → pass。
 * @param {{id?:string, tier?:string, expectMarker?:string}} task
 * @param {{operations?:Array<any>}|null} patchPlan
 * @param {string} content 目标文件当前内容(replace 的 from 要在此精确命中)
 */
export function scorePatchAgainstTask(task, patchPlan, content, opts = {}) {
  const ops = (patchPlan && Array.isArray(patchPlan.operations)) ? patchPlan.operations : [];
  const marker = (task && task.expectMarker) ? String(task.expectMarker) : '';
  const fuzzyMatch = typeof opts.fuzzyMatch === 'function' ? opts.fuzzyMatch : null;
  if (!ops.length) return { id: task && task.id, tier: task && task.tier, pass: false, applicable: false, strictApplicable: false, viaFuzzy: false, markerOk: false, reason: 'empty_operations' };
  // strictApplicable = from 精确命中(模型精度);applicable = 含 fuzzy 救的落地率(生产真实)。两条都记,分清"模型有多准" vs "生产能落多少"。
  let strictApplicable = false;
  let applicable = false;
  let viaFuzzy = false;
  let producedText = '';
  for (const op of ops) {
    if (op && op.op === 'write_file' && typeof op.content === 'string') {
      strictApplicable = true; applicable = true; producedText += op.content;
    } else if (op && op.op === 'replace' && typeof op.from === 'string') {
      if (countOccurrences(content, op.from) === 1) {
        strictApplicable = true; applicable = true; producedText += String(op.to || '');
      } else if (fuzzyMatch) {
        // strict 不命中(from 格式微差/编造)→ 试 fuzzy(仿生产 NOE_FUZZY_PATCH):唯一相似命中→算落地(via fuzzy)
        let m = null;
        try { m = fuzzyMatch(content, op.from); } catch { m = null; }
        if (m && m.matched === true) { applicable = true; viaFuzzy = true; producedText += String(op.to || ''); }
      }
    }
  }
  const markerOk = marker ? producedText.includes(marker) : true;
  return {
    id: task && task.id,
    tier: task && task.tier,
    pass: applicable && markerOk,
    applicable,
    strictApplicable,
    viaFuzzy,
    markerOk,
    reason: !applicable ? 'not_applicable(from编造/歧义/空,fuzzy也救不了)' : (!markerOk ? 'marker_missing(可apply但没达标)' : (viaFuzzy ? 'pass(靠fuzzy救)' : 'pass')),
  };
}

/** 聚合一次题库跑分:总通过率 + 按 tier 分档(暴露"能做简单不能做难")。 */
export function summarizeBatteryRun(results = []) {
  const rows = Array.isArray(results) ? results : [];
  const total = rows.length;
  const passed = rows.filter((r) => r && r.pass).length;
  // strictPass = 不靠 fuzzy 就通过(模型精度);passed = 含 fuzzy 落地(生产真实)。分清两者。
  const strictPassed = rows.filter((r) => r && r.pass && r.strictApplicable === true).length;
  const byTier = {};
  for (const r of rows) {
    const tier = (r && r.tier) || 'unknown';
    const b = byTier[tier] || (byTier[tier] = { total: 0, passed: 0, strictPassed: 0 });
    b.total += 1;
    if (r && r.pass) b.passed += 1;
    if (r && r.pass && r.strictApplicable === true) b.strictPassed += 1;
  }
  for (const tier of Object.keys(byTier)) {
    const b = byTier[tier];
    b.passRate = b.total ? b.passed / b.total : 0;
    b.strictPassRate = b.total ? b.strictPassed / b.total : 0;
  }
  return { total, passed, strictPassed, passRate: total ? passed / total : 0, strictPassRate: total ? strictPassed / total : 0, byTier };
}
