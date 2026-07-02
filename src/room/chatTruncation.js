// @ts-check
// 多 AI 房（debate / arena / squad / cross_verify）共用的「输出截断感知」工具。
//
// 背景：adapter.chat() 被 finish_reason=length / max_tokens 截断时，reply 是半截未收尾文本。
// SoloChatDispatcher 早有 isIncompleteChatResult 守门（截断直接报错不保存），但多 AI 编排器
// 一直直接消费 result.reply（提案 / 互评 verdict / 集群方案 / 签字 JSON），把半截输出当完整结论，
// 会污染共识、让截断的签字 JSON 蒙混过签。本模块抽出统一判定 + 标注，供各编排器复用。
//
// 与 SoloChatDispatcher.isIncompleteChatResult / VoiceSession.isIncompleteBrainResult 同口径。

/**
 * 判定一次 chat 结果是否被截断 / 未收尾。
 * @param {{incomplete?:boolean,truncated?:boolean,continuationRequired?:boolean,completionStatus?:string,finishReason?:string,finish_reason?:string}} [result]
 * @returns {boolean}
 */
export function isIncompleteChatResult(result = {}) {
  if (!result || typeof result !== 'object') return false;
  const finishReason = String(result.finishReason || result.finish_reason || '').trim().toLowerCase();
  const completionStatus = String(result.completionStatus || '').trim().toLowerCase();
  return result.incomplete === true
    || result.truncated === true
    || result.continuationRequired === true
    || completionStatus === 'incomplete_length'
    || finishReason === 'length'
    || finishReason === 'max_tokens';
}

/**
 * 取截断原因（用于日志 / 广播 / 标注），缺省回退 'length'。
 * @param {{finishReason?:string,finish_reason?:string,completionStatus?:string}} [result]
 * @returns {string}
 */
export function truncationFinishReason(result = {}) {
  if (!result || typeof result !== 'object') return 'length';
  const finishReason = String(result.finishReason || result.finish_reason || '').trim();
  if (finishReason) return finishReason;
  const completionStatus = String(result.completionStatus || '').trim();
  if (completionStatus) return completionStatus;
  return 'length';
}

/**
 * 给被截断的 reply 追加显式标注。
 * 关键作用：被消费方（_parseAck/JSON.parse、judge 合成、最终共识）能直接看见「这是半截输出」，
 * 而且追加的中文标注会让任何 JSON 解析失败 —— 截断的签字 JSON 因此无法被当成有效 verdict 蒙混过签，
 * 而是降级为「解析失败 = 不同意」，不再把半截结论当完整。
 * @param {string} reply
 * @param {{finishReason?:string,finish_reason?:string,completionStatus?:string}} [result]
 * @returns {string}
 */
export function markTruncatedReply(reply, result = {}) {
  if (!result || typeof result !== 'object') result = {};
  // 边界守卫：reply 为 null / undefined / 非字符串（对象 / 数字 / boolean 等）时回退为空串，
  //          避免 String({}) / String(42) 产生 "[object Object]" / "42" 这种畸形标注污染下游解析链路
  //          （_parseAck / JSON.parse / judge 合成会把它们当半截内容继续处理）。
  const text = (reply == null || typeof reply !== 'string') ? '' : reply;
  const reason = truncationFinishReason(result);
  return `${text}\n\n[⚠️ 输出被截断（finish_reason=${reason}），以上内容不完整，请勿当作完整结论。]`;
}

/**
 * 按字符数 limit 截断单条 reply，并在被截断时追加显式标注。
 * 边界守卫：
 *   - text 为 null / undefined / 非字符串 → 返回 ''（避免 String({}) / String(42) 污染下游解析）
 *   - text 为空字符串 → 返回 ''（没有内容可截断，无需标注）
 *   - limit 不是有限正数（NaN / Infinity / 负数 / 0）→ 返回 ''（非法预算不能进入主逻辑）
 *   - text.length <= limit → 返回原文本（无需标注）
 *   - text.length > limit → 返回前 limit 个字符 + 截断标注
 *
 * @param {string} text
 * @param {number} limit
 * @param {{finishReason?:string,finish_reason?:string,completionStatus?:string}} [result]
 * @returns {string}
 */
export function truncateReply(text, limit, result = {}) {
  if (text == null || typeof text !== 'string') return '';
  if (text === '') return '';
  if (!Number.isFinite(limit)) return '';
  if (limit <= 0) return '';
  if (text.length <= limit) return text;
  const reason = truncationFinishReason(result);
  const head = text.slice(0, limit);
  return `${head}\n\n[⚠️ 输出被截断（finish_reason=${reason}），以上内容不完整，请勿当作完整结论。]`;
}

/**
 * 估算单条消息的 token 数（纯函数，无副作用，不依赖任何模块状态）。
 * 边界守卫：
 *   - message 不是对象 → 返回 0
 *   - content 为 null / undefined / 非字符串 / 空字符串 / 纯空白 → 返回 0
 *   - tokenCounter 抛错或返回非有限数（含 NaN / Infinity / ≤ 0）→ 返回 0
 *   - 否则返回 tokenCounter 估算结果（不与 maxTokens 比对，由调用方决定）
 *
 * 默认估算：字符数 / 2 向上取整（与 truncateMessagesByTokens 历史口径一致）。
 *
 * @param {{content?: string | null}} message
 * @param {(text: string) => number} [tokenCounter]
 * @returns {number}
 */
export function estimateMessageTokens(message, tokenCounter) {
  if (!message || typeof message !== 'object') return 0;
  const text = message.content;
  if (text == null || typeof text !== 'string') return 0;
  if (text.trim() === '') return 0;
  const counter = typeof tokenCounter === 'function'
    ? tokenCounter
    : (t) => {
        const s = String(t == null ? '' : t);
        return Math.ceil(s.length / 2);
      };
  let tokens;
  try {
    tokens = counter(text);
  } catch {
    return 0;
  }
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return tokens;
}

/**
 * 按 token 预算裁剪消息列表（多 AI 房共用的上下文窗口裁剪）。
 * 边界守卫：
 *   - messages 非数组 / 空数组：返回 []
 *   - maxTokens 不是有限正数：返回 []
 *   - 单条消息不是对象 / content 为空字符串 / null / undefined：跳过
 *   - 单条消息 token 计数超过 maxTokens：跳过（避免把超长半截消息直接送给下游解析链路）
 *   - 自定义 tokenCounter 抛错或返回非有限数：跳过该消息
 *
 * @param {Array<{role?: string, content?: string | null}>} messages
 * @param {number} maxTokens
 * @param {(text: string) => number} [tokenCounter] 默认按字符数 / 2 估算
 * @returns {Array<{role?: string, content?: string | null}>}
 */
export function truncateMessagesByTokens(messages, maxTokens, tokenCounter, reserveForResponse = 0) {
  // 显式短路 1：messages 为 null / undefined / 非数组 / 空数组 → 直接返回 []，
  //          避免空输入进入长度估算与截断主逻辑时产生死循环或空结果抖动。
  //          单条非对象 / content 缺失 / token 越界 / counter 异常 → 跳过，
  //          确保输出永远是「合法消息的子集」，全量非法时安全降级为 []。
  if (!Array.isArray(messages) || messages.length === 0) return [];
  // 显式短路 2：maxTokens 不是有限正数（含 NaN / Infinity / 负数 / 0）→ 直接返回 []，
  //          避免非法预算进入裁剪主逻辑时触发下溢或循环不收敛。
  if (!Number.isFinite(maxTokens)) return [];
  if (maxTokens <= 0) return [];
  // 显式短路 3：单条消息（messages.length === 1）显式前置校验
  //          —— 在进入主循环前显式拦截「单条非对象 / content 缺失 / 空内容」输入，
  //          让「单条非法输入直接降级为 []」成为显式契约，而不是依赖循环内的 continue 隐式跳过。
  //          单条合法消息继续走下方主循环统一规范化与 token 校验，不在此分支返回结果，
  //          避免与「按尾部逐条回填」的裁剪主循环产生重复路径。
  if (messages.length === 1) {
    const sole = messages[0];
    if (!sole || typeof sole !== 'object') return [];
    const soleText = sole.content;
    if (soleText == null || soleText === '' || typeof soleText !== 'string') return [];
  }
  // 边界守卫 3：reserveForResponse 不是有限非负数时回退为 0，避免 budget 计算下溢成负数。
  if (!Number.isFinite(reserveForResponse) || reserveForResponse < 0) reserveForResponse = 0;
  // 预算：上下文消息可用额度 = maxTokens 减去给响应预留的 token 数。
  const budget = maxTokens - reserveForResponse;
  // 边界守卫 4：budget 必须是非负数，否则直接返回 []。
  //          —— 防止 reserveForResponse >= maxTokens 导致 budget 下溢成负数，
  //          在退化场景下仍然返回结构稳定的最小结果（空数组）。
  if (budget <= 0) return [];
  // 早返回短路：先算出全部合法消息的 token 估算总和；若总额已 ≤ 预算，直接返回规范化后的输入（深拷贝），
  //          跳过按尾部逐条回填的裁剪循环。
  const normalized = [];
  let total = 0;
  for (const msg of messages) {
    const tokens = estimateMessageTokens(msg, tokenCounter);
    if (tokens <= 0) continue;
    if (tokens > maxTokens) continue;
    total += tokens;
    normalized.push({ role: msg.role, content: msg.content });
  }
  if (total <= budget) return normalized;
  // 总和超预算或单条超预算被过滤后剩余仍超预算：退化到原逐条尾部回填裁剪逻辑。
  // 边界守卫 6：role=system 消息在裁剪循环里「永不被丢弃」——
  //          system 消息通常承载角色设定 / 工具约束 / 安全护栏，丢失后下游 LLM 会失去关键上下文。
  //          当遇到 role=system 消息时无条件 unshift（即使其 token 数已超过 remaining，契约优先于预算），
  //          不计入 remaining 扣减，避免「为了凑预算把 system 当普通消息丢掉」。
  //          「早返回短路」（total <= budget）路径天然保留全部合法消息（含 system），无需特殊处理。
  let remaining = budget;
  const kept = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const tokens = estimateMessageTokens(msg, tokenCounter);
    if (tokens <= 0) continue;
    if (tokens > maxTokens) continue;
    // 边界守卫 6 实现：role=system 消息无条件保留，不参与 remaining 扣减。
    if (msg.role === 'system') {
      kept.unshift(msg);
      continue;
    }
    if (tokens > remaining) break;
    remaining -= tokens;
    kept.unshift(msg);
  }
  return kept;
}

/**
 * 安全裁剪文本（带省略号）。
 *
 * 边界 / 空值防御：
 *   - text 非字符串（null / undefined / 对象 / 数字 / boolean 等）→ 返回 ''
 *   - length 不是有限数（NaN / Infinity / -Infinity）→ 返回原 text
 *   - length <= 0 或负数 → 返回原 text
 *   - text.length <= length → 返回原 text（无需裁剪）
 *   - 否则走内部 _appendTruncationEllipsis 纯函数拼接省略号，移除重复字符串拼接
 *
 * @param {unknown} text
 * @param {number} length
 * @param {string} [ellipsis='…']
 * @returns {string}
 */
export function truncate(text, length, ellipsis = '…') {
  if (typeof text !== 'string') return '';
  if (!Number.isFinite(length) || length <= 0) return text;
  const safeLength = Math.floor(length);
  // 按 Unicode 码点（而非 UTF-16 单元）裁剪，避免把 emoji / 代理对半切。
  const codePoints = Array.from(text);
  if (codePoints.length <= safeLength) return text;
  const safeEllipsis = typeof ellipsis === 'string' ? ellipsis : '…';
  return codePoints.slice(0, safeLength).join('') + safeEllipsis;
}

/**
 * 内部小纯函数：把裁剪后的文本与省略号拼接。
 * 调用前应保证 text.length > length 且 length 是非负整数。
 * 抽出它是为了让所有调用点共用同一段拼接逻辑，避免重复字符串拼接散落在各处。
 * @param {string} text
 * @param {number} length
 * @param {string} ellipsis
 * @returns {string}
 */
function _appendTruncationEllipsis(text, length, ellipsis) {
  return text.slice(0, length) + ellipsis;
}
