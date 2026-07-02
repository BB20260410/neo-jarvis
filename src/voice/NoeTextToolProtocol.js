// @ts-check
/**
 * NoeTextToolProtocol — 本地模型纯文本工具调用协议（VCP 吸收 H3，独立实现，不拷 VCP 源码）。
 *
 * 痛点：Neo 本地大脑(gemma/qwen)对 35+ FREEDOM 工具 + 聚合 MCP 工具"看得见够不着"——
 *   工具元数据注入给大脑看，但无"回读"回路把大脑'我要调 X'的意图接回 ToolRegistry。
 *   本地 chat adapter 全部无原生 function-calling。
 *
 * 方案：给无 FC 的本地大脑一条纯文本标记通道，解析出 {toolId,args} 交给 NoeTextToolExecutor 过权限门执行。
 *   本模块是【纯函数解析 + prompt 构建】，零副作用、零执行权。
 *
 * 安全（H3 子代理审 + multimodel 审加固）：
 *   - fail-closed 白名单：allowedToolIds 为空 = 全拒（防接入忘传白名单致大脑可调任意工具）；'*' 哨兵显式放行所有（仅调试）。
 *   - toolId 字符白名单 [a-zA-Z0-9._-]：纵深防御，挡路径穿越(../)等。
 *   - maxCalls 封顶防刷。
 *
 * 标记语法（Neo 自有，非拷 VCP）：
 *   <<<NOE_TOOL>>>
 *   tool: <工具ID>
 *   args: {"key": "value"}        // 支持多行 JSON（本地小模型常见输出形态）
 *   <<<END_NOE_TOOL>>>
 */

const TOOL_BLOCK_RE = /<<<NOE_TOOL>>>([\s\S]*?)<<<END_NOE_TOOL>>>/g;
const TOOL_ID_RE = /^[a-zA-Z0-9._-]+$/;

/** 参数键名归一化（小写 + 去下划线/连字符），用于模糊匹配容错。 */
export function normalizeArgKey(k) {
  return String(k == null ? '' : k).toLowerCase().replace(/[_-]/g, '');
}

/**
 * 从大脑回复文本解析工具调用标记块。纯函数，无副作用、无执行权。
 * @param {string} replyText
 * @param {{ allowedToolIds?: string[], maxCalls?: number }} [opts]
 * @returns {{ calls: Array<{toolId:string, args:object, raw:string}>, rejected: Array<{name:string, reason:string}>, stripped: string }}
 */
export function parseTextToolCalls(replyText, { allowedToolIds = [], maxCalls = 3 } = {}) {
  const text = String(replyText == null ? '' : replyText);
  const allowList = (Array.isArray(allowedToolIds) ? allowedToolIds : []).map((t) => String(t));
  const allowAll = allowList.includes('*'); // 显式哨兵才放行所有（仅调试）
  const allow = new Set(allowList);
  const calls = [];
  const rejected = [];
  const seen = new Set();
  let m;
  TOOL_BLOCK_RE.lastIndex = 0;
  while ((m = TOOL_BLOCK_RE.exec(text)) !== null) {
    const raw = m[0];
    const body = m[1] || '';
    const toolMatch = body.match(/^[ \t]*tool[ \t]*:[ \t]*(.+?)[ \t]*$/im);
    const toolId = toolMatch ? toolMatch[1].trim() : '';
    if (!toolId) { rejected.push({ name: '(empty)', reason: 'no_tool_name' }); continue; }
    if (!TOOL_ID_RE.test(toolId)) { rejected.push({ name: toolId, reason: 'invalid_tool_id' }); continue; }
    // fail-closed：白名单为空或不含该 id 则拒（'*' 哨兵显式放行所有）
    if (!allowAll && !allow.has(toolId)) { rejected.push({ name: toolId, reason: 'not_in_allowlist' }); continue; }
    const dedupKey = toolId + '|' + body.trim();
    if (seen.has(dedupKey)) { rejected.push({ name: toolId, reason: 'duplicate' }); continue; }
    // args：从 args: 之后第一个 { 到最后一个 } 截取整个 JSON 对象（支持多行 JSON）
    let args = {};
    const argsIdx = body.search(/^[ \t]*args[ \t]*:/im);
    if (argsIdx >= 0) {
      const after = body.slice(argsIdx).replace(/^[ \t]*args[ \t]*:/im, '');
      const start = after.indexOf('{');
      const end = after.lastIndexOf('}');
      if (start >= 0 && end > start) {
        try {
          const parsed = JSON.parse(after.slice(start, end + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            args = parsed;
          } else {
            rejected.push({ name: toolId, reason: 'args_not_object' });
            continue;
          }
        } catch {
          rejected.push({ name: toolId, reason: 'args_invalid_json' });
          continue;
        }
      } else if (after.trim()) {
        rejected.push({ name: toolId, reason: 'args_invalid_json' });
        continue;
      }
    }
    if (calls.length >= Math.max(0, maxCalls)) { rejected.push({ name: toolId, reason: 'over_max_calls' }); continue; }
    seen.add(dedupKey);
    calls.push({ toolId, args, raw });
  }
  const stripped = text.replace(TOOL_BLOCK_RE, '').replace(/\n{3,}/g, '\n\n').trim();
  return { calls, rejected, stripped };
}

/**
 * 构建注入 system prompt 的协议说明 + 可见工具清单（含 example 范例，VCP 吸收 M2 思路）。
 * @param {Array<{id?:string, toolId?:string, description?:string, title?:string, example?:string}>} tools
 * @param {{ maxTools?: number }} [opts]
 * @returns {string} 空串表示无工具可注入
 */
export function buildTextToolProtocolPrompt(tools = [], { maxTools = 12 } = {}) {
  const list = (Array.isArray(tools) ? tools : [])
    .filter((t) => t && (t.id || t.toolId))
    .slice(0, Math.max(0, maxTools));
  if (!list.length) return '';
  const lines = list.map((t) => {
    const id = t.id || t.toolId;
    const desc = t.description || t.title || '';
    const ex = t.example ? `\n    范例 args: ${t.example}` : '';
    return `- ${id}：${desc}${ex}`;
  });
  return [
    '【工具调用协议】需要用工具时，在回复中单独输出一个标记块（不需要工具就正常回复、别输出标记块）：',
    '<<<NOE_TOOL>>>',
    'tool: <下面列表里的工具ID>',
    'args: {"参数名": "值"}',
    '<<<END_NOE_TOOL>>>',
    '系统执行后会把结果回灌给你，你再据结果继续回复。一轮最多 3 个调用，只能用下列工具：',
    ...lines,
  ].join('\n');
}
