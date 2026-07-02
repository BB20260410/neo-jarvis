// @ts-check
// NoeStepExpectationBridge — 阶段1：修活好奇回路供给端（治 R5/R5b）。
//
// 根因（多模型研究 DB 实证）：source='surprise' 恒 0、outcome=0 恒 0——「被现实打脸→惊奇→学习」引擎从没
//   接通，真根因是判证供给端永远没有 outcome=0 喂进来。
//
// 解法：act/research step 真失败 → 登记预测→resolve(outcome=0)→surprise→harvestSurprise(action_failure)。
//
// ⚠️ 三方复盘（M3/Claude/codex）整改（批次A，治 reward hacking + 污染缺陷）：
//   RH-1：**排除「系统自拦」**——安全门/无 executor/预算/上下文不足/审批/自进化门 都是系统行为，不是「被现实
//         打脸」。把它们当 surprise 会奖励「Neo 故意提会被拦的 act」。只认真执行后的失败（executor 跑了但失败）。
//   RH-2：**stepHash+failureClass 多键去重 + 限速**——不只靠脆弱的 textSimilarity（措辞变化可绕过）。同一
//         (失败主题, 失败类) 短窗内只产一次 surprise，防 Neo 用不同措辞反复刷分。
//   EDGE-9：predictedP 不再恒 0.8——真执行失败才到这（系统拦已排除），但仍按「这步是否本就高基率会失败」温和。
//   CAL-10（在 NoeExpectationLedger）：source='step_prediction' 排除 Brier/calibration 口径（伪预测不污染自知之明）。
//
// ⚠️ 仍未根除（批次B，待重新设计）：learningHook（surprise 目标 done→产 lesson→写 memory→验 recall）、
//   信息层 epistemic 源（owner 否定事实预测 / 读到与 worldModel 矛盾）。执行层失败多为工具/网络噪声，
//   不是该学的地方——彻底根除靠批次B。本文件只是「不有害的供给旁路」，flag NOE_STEP_EXPECTATION_RESOLVE 默认 OFF。
//
// 纪律：注入式，fail-open，纯增量。

// RH-1（三方复盘整改：旧版裸子串 not_met/budget/dry_run 会误杀含这些词的真失败；blocked 终态本就是系统门）：
//   系统门 = ActPipeline 结构化拦截 code（精确/前缀匹配，非自由文本子串）。
const SYSTEM_GATE_CODES = ['blocked_safety', 'executor_not_registered', 'context_sufficiency_not_met', 'self_evolution_gate_blocked', 'budget_blocked', 'awaiting_approval', 'dry_run'];
// 瞬时环境噪声（网络/IO/限流/5xx）：工具环境抖动不是认知缺口，不该产 surprise（M3 漏洞 B）。
const TRANSIENT_RE = /\b(timeout|etimedout|econnreset|econnrefused|enetunreach|esockettimedout|socket hang up|rate.?limit|too many requests|429|50[234]|network|temporarily unavailable|fetch failed|connection (?:reset|refused|closed))\b/i;
// P1-E（修三方审查 minor）：中文瞬时错误——\b 词边界对中文无效，英文 RE 漏判本地模型/中文工具的瞬时噪声，
//   同样不是认知缺口、不该产 surprise（中文无词边界，子串语义已足够明确）。
const TRANSIENT_ZH_RE = /超时|网络(?:异常|错误|不稳定|波动|连接失败)|连接(?:失败|中断|重置|超时|被拒|不上)|服务(?:暂(?:时)?不可用|不可用|繁忙)|稍后(?:再试|重试)|请(?:稍后|重试|过会)|请求(?:过于)?频繁|访问(?:过于)?频繁|限流|系统(?:繁忙|忙碌)|暂(?:时)?(?:无法连接|不可用)/;

/**
 * 失败结构化分类（治 RH-1 裸子串误杀 + transient 噪声污染 + RH-2 措辞绕过去重）。
 * @returns {'system_gate'|'transient'|'real'} 枚举桶——同步骤不同措辞落同桶，去重才生效。
 */
function classifyFailure(reason, terminal) {
  const r = String(reason || '').trim();
  const low = r.toLowerCase();
  if (terminal === 'blocked') return 'system_gate'; // blocked = 系统门拦截（!acted/!approval），非被现实打脸
  for (const code of SYSTEM_GATE_CODES) { if (low === code || low.startsWith(code)) return 'system_gate'; } // 防系统 code 漏进 failed 路
  // Claude 复盘：budget 拦截的 failureReason 是自由文本「budget blocked: <metric>」(带空格)，精确码 budget_blocked 匹配不上→宽匹配防假 surprise(违 RH-1 防刷意图)
  if (/\b(?:budget|quota)[\s_-]*(?:blocked|exceeded|denied|over|cap|limit|reached)|over[\s_-]?(?:budget|quota)/i.test(low)) return 'system_gate';
  if (TRANSIENT_RE.test(r) || TRANSIENT_ZH_RE.test(r)) return 'transient';
  return 'real'; // 真实执行失败：命令真跑了但退出码非零/断言/解析失败，值得学
}

/** 失败的稳定指纹（去重用）：归一化 stepText 取前 80 字。 */
function stepFingerprint(stepText) {
  return String(stepText || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * @param {object} opts
 * @param {{add:Function, resolve:Function}} opts.expectationLedger
 * @param {{harvestSurprise:Function}} opts.goalSystem
 * @param {() => number} [opts.now]
 * @param {number} [opts.surpriseThreshold]
 * @param {number} [opts.predictedP] 「这步会成功」的预测概率（默认 0.8）
 * @param {number} [opts.dedupWindowMs] 同指纹去重窗口（默认 6h）
 * @param {number} [opts.maxPerHour] 每小时 surprise 上限（限速防刷，默认 6）
 */
export function createStepExpectationBridge({
  expectationLedger,
  goalSystem,
  now = Date.now,
  surpriseThreshold = 2,
  predictedP = 0.8,
  dedupWindowMs = 6 * 3600 * 1000,
  maxPerHour = 6,
} = {}) {
  const recent = new Map(); // fingerprint:failureClass → lastTs（去重）
  const hourly = []; // 最近 surprise 时间戳（限速）

  function onStepFailed({ stepText, kind, terminal, failureReason } = {}) {
    if (process.env.NOE_STEP_EXPECTATION_RESOLVE !== '1') return null;
    if (kind !== 'act' && kind !== 'research') return null;
    if (terminal !== 'failed' && terminal !== 'blocked') return null;
    // RH-1（结构化分类）：系统门 + 瞬时噪声都不是「被现实打脸」，skip；只留真实执行失败产 surprise。
    const reason = String(failureReason || '');
    const klass = classifyFailure(reason, terminal);
    if (klass === 'system_gate') return { skipped: 'system_gate', failureReason: reason.slice(0, 60) };
    if (klass === 'transient') return { skipped: 'transient', failureReason: reason.slice(0, 60) };
    if (!expectationLedger?.add || !expectationLedger?.resolve || !goalSystem?.harvestSurprise) return null;
    try {
      const fp = stepFingerprint(stepText);
      // RH-2：失败类用结构化枚举(klass)而非 reason 前40字——同步骤不同措辞落同桶，去重才生效。
      const key = `${fp}::${klass}`;
      const t = now();
      // RH-2：同 (指纹, 失败类) 窗内去重——防措辞变化绕过 textSimilarity 反复刷。
      const last = recent.get(key);
      if (last && t - last < dedupWindowMs) return { skipped: 'deduped', key };
      // RH-2：每小时限速——防一波失败刷爆 surprise 账本。
      while (hourly.length && t - hourly[0] > 3600 * 1000) hourly.shift();
      if (hourly.length >= maxPerHour) return { skipped: 'rate_limited' };

      // LH-topic-garbage（三方 P2）：claim 原是「完成步骤：X」过程残渣，learningHook 拿它产 lesson 必 SKIP。
      //   改成含失败原因的认知落差形式，让 learningHook 能产「我以为这步会成功，实际因 X 失败」的执行教训 lesson。
      const claim = `我以为能完成「${String(stepText || '').slice(0, 100)}」，结果失败了：${reason.slice(0, 60) || '执行未成'}`.trim();
      if (claim.length < 8) return null;
      const id = expectationLedger.add({ claim, p: predictedP, dueAt: t, source: 'step_prediction' });
      if (!id) return null; // ledger 侧去重命中
      const r = expectationLedger.resolve(id, 0, t, 'auto');
      if (!r) return null;
      if (recent.size >= 1000) recent.delete(recent.keys().next().value); // F8：防 recent Map 无界增长（Map 保插入序，删最旧）
      recent.set(key, t);
      const surprise = Number(r.surprise) || 0;
      if (surprise < surpriseThreshold) return { expectationId: id, surprise, curiosityGoalId: null };
      hourly.push(t);
      const curiosityGoalId = goalSystem.harvestSurprise({ claim: r.claim, surprise, origin: 'action_failure' });
      return { expectationId: id, surprise, curiosityGoalId };
    } catch { return null; }
  }

  return { onStepFailed };
}
