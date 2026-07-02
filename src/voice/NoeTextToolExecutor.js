// @ts-check
/**
 * NoeTextToolExecutor — 执行 NoeTextToolProtocol 解析出的工具调用（VCP 吸收 H3，附带 M3 结果格式化思路）。
 *
 * 职责：薄编排。对每个 call 调用注入的 invokeTool（由接入点包装 ToolRegistry.invoke / Freedom 执行链 /
 *   McpAggregator.callTool + 权限门），错误隔离，把结果格式化成 AI 易读文本块回灌大脑续写。
 *
 * 安全（H3 子代理审 + multimodel 审加固）：
 *   - 执行器自身【零执行权】——不直接碰 ToolRegistry/fs/shell，只调注入的 invokeTool；权限门由 invokeTool 把关。
 *   - 工具结果回灌前过 redact 脱敏（防工具返回的 token/cookie/header 被喂进模型上下文）。
 *   - orchestrate 跨轮 executed ledger：相同 (toolId,args) 不重复执行（防模型复读标记块造成重复副作用）。
 *   - maxRounds 上限 + 残留标记块 strip：防无限回读。
 */

import { parseTextToolCalls } from './NoeTextToolProtocol.js';

/**
 * 执行一组解析出的工具调用。
 * @param {Array<{toolId:string, args?:object}>} calls
 * @param {object} deps
 * @param {(toolId:string, args:object, opts:{realExecute:boolean}) => Promise<any>} deps.invokeTool
 * @param {number} [deps.maxResultChars]
 * @param {boolean} [deps.realExecute]
 * @param {(s:string)=>string} [deps.redact] 脱敏函数（默认恒等；接入时注入 redactSensitiveText）
 * @param {(msg:string)=>void} [deps.log]
 * @returns {Promise<{results:Array<{toolId:string, ok:boolean, summary:string}>, feedbackText:string}>}
 */
export async function runTextToolCalls(calls, {
  invokeTool,
  maxResultChars = 1200,
  realExecute = false,
  redact = (s) => s,
  log = () => {},
} = {}) {
  if (typeof invokeTool !== 'function') throw new TypeError('runTextToolCalls: invokeTool 必须是函数');
  const results = [];
  for (const call of (Array.isArray(calls) ? calls : [])) {
    if (!call || !call.toolId) continue;
    let ok = false;
    let summary = '';
    try {
      const res = await invokeTool(call.toolId, call.args || {}, { realExecute });
      ok = !(res && res.ok === false);
      summary = summarizeResult(res, maxResultChars, redact);
    } catch (e) {
      ok = false;
      summary = summarizeResult('执行出错: ' + String((e && e.message) || e).slice(0, 200), maxResultChars, redact);
      log('[text-tool-exec] ' + call.toolId + ' 失败');
    }
    results.push({ toolId: call.toolId, ok, summary });
  }
  return { results, feedbackText: buildFeedbackText(results) };
}

/**
 * 把工具结果渲染成 AI 易读文本（替代裸 JSON.stringify().slice 截断，VCP 吸收 M3）。
 * 喂回模型前过 redact 脱敏（H3 multimodel 审 #6）。
 * @param {any} res
 * @param {number} [maxChars]
 * @param {(s:string)=>string} [redact]
 * @returns {string}
 */
export function summarizeResult(res, maxChars = 1200, redact = (s) => s) {
  if (res == null) return '(无返回)';
  let text;
  if (typeof res === 'string') {
    text = res;
  } else if (typeof res === 'object') {
    const pick = res.text ?? res.message ?? res.summary ?? res.result ?? res.data ?? res;
    try { text = typeof pick === 'string' ? pick : JSON.stringify(pick); } catch { text = String(pick); }
  } else {
    text = String(res);
  }
  try { text = String(redact(text)); } catch { /* redact 失败用原文，至少截断 */ }
  if (text.length > maxChars) text = text.slice(0, maxChars) + '…(已截断)';
  return text;
}

/**
 * 把多个工具结果拼成回灌大脑的反馈文本。
 * @param {Array<{toolId:string, ok:boolean, summary:string}>} results
 * @returns {string}
 */
export function buildFeedbackText(results) {
  if (!results || !results.length) return '';
  const blocks = results.map((r) => `【工具 ${r.toolId} ${r.ok ? '结果' : '失败'}】\n${r.summary}`);
  return ['【工具执行结果，请据此继续回复（勿再输出标记块）】', ...blocks].join('\n\n');
}

/**
 * 回读循环核心：解析大脑回复里的工具标记 → 执行 → 把结果回灌让大脑续写最终回复。
 * 可单测的纯编排（接入 SoloChatDispatcher/VoiceSession 时直接调用，传入真实 invokeTool + regenerate + redact）。
 * @param {string} reply
 * @param {object} deps
 * @param {string[]} [deps.allowedToolIds] 白名单（防大脑幻觉未授权工具）
 * @param {(toolId:string, args:object, opts:object) => Promise<any>} deps.invokeTool
 * @param {(feedbackText:string, ctx:{stripped:string, calls:any[], results:any[]}) => Promise<string>} deps.regenerate
 * @param {number} [deps.maxCalls]
 * @param {number} [deps.maxRounds]
 * @param {boolean} [deps.realExecute]
 * @param {(s:string)=>string} [deps.redact]
 * @param {(msg:string)=>void} [deps.log]
 * @returns {Promise<{used:boolean, reply:string, calls?:any[], feedbackText?:string}>}
 */
export async function orchestrateTextToolTurn(reply, {
  allowedToolIds = [],
  invokeTool,
  regenerate,
  maxCalls = 3,
  maxRounds = 2,
  realExecute = false,
  redact = (s) => s,
  log = () => {},
} = {}) {
  let current = String(reply == null ? '' : reply);
  let used = false;
  let lastCalls;
  let lastFeedback;
  const executed = new Set(); // H3 multimodel 审 #7：跨轮已执行指纹，防模型复读造成重复副作用
  const rounds = Math.max(1, maxRounds);
  for (let round = 0; round < rounds; round++) {
    const { calls, stripped } = parseTextToolCalls(current, { allowedToolIds, maxCalls });
    if (!calls.length) break; // 无工具调用 → 收敛退出（零侵入）
    const fresh = calls.filter((c) => {
      const k = c.toolId + '|' + JSON.stringify(c.args || {});
      if (executed.has(k)) return false;
      executed.add(k);
      return true;
    });
    if (!fresh.length) break; // 全是已执行过的重复调用 → 收敛，不重复副作用
    if (typeof invokeTool !== 'function') throw new TypeError('orchestrateTextToolTurn: invokeTool 必须是函数');
    if (typeof regenerate !== 'function') throw new TypeError('orchestrateTextToolTurn: regenerate 必须是函数');
    const { results, feedbackText } = await runTextToolCalls(fresh, { invokeTool, realExecute, redact, log });
    current = String((await regenerate(feedbackText, { stripped, calls: fresh, results })) ?? '');
    used = true;
    lastCalls = fresh;
    lastFeedback = feedbackText;
  }
  // 死循环硬护栏（H3 审 #4）：达 maxRounds 仍含标记块 → strip 掉绝不再执行
  const tail = parseTextToolCalls(current, { allowedToolIds, maxCalls });
  if (tail.calls.length) {
    log('[text-tool-orch] 达 maxRounds 仍含工具标记，strip 后返回纯文本(防死循环)');
    current = tail.stripped;
  }
  return { used, reply: current, calls: lastCalls, feedbackText: lastFeedback };
}
