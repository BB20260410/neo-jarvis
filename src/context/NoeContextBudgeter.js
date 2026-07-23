// @ts-check
// NoeContextBudgeter — system prompt 注入段的统一编排（B7：上下文工程通电第一步）。
//
// 问题：VoiceSession 里十余段 `sys += ...`（人物库/承诺/预取/工具/动作/身份/视觉/记忆…）无预算管理，
//   注入全开时本地小模型的 context 被系统提示挤爆，回复质量反而下降。
// 方案：各段 add() 进 composer（保持加入顺序输出，预算内与旧拼接**逐字一致**）；超预算时按
//   keep 等级整段裁剪（小=先丢；同级后加先丢），绝不截半句。被丢段记入 dropped 供观测。
//
// keep 等级约定（语义重要性，丢弃从低到高）：
//   2 记忆召回（锦上添花） 3 预取池/人物卡 4 人物库/承诺 5 背景视觉
//   6 自我认知/工具结果 7 动作结果/身份验证 8 认人结果/视觉规则/纠错规则（防幻觉关键）

/** 粗估 token：约 4 字符 ≈ 1 token（与 NoeTrajectoryCompactor 同口径）。 */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

/**
 * 兜底数值为非负有限整数：NaN/Infinity/负数/非数 → fallback（默认 0）。
 * 用于 compose / calculateRemainingBudget 返回前的最后兜底，确保上游永不收到 NaN/Infinity/负数，
 * 守住"items 缺失或为空时 used / total / remaining 仍为非负有限数"的不变量。
 */
function toSafeNonNegativeInt(n, fallback = 0) {
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : fallback;
}

/**
 * 从 messages + totalTokens 估算剩余可用 token 预算（供 compose 前的窗口计算）。
 * 全部走 guard：永不返 NaN/负数/undefined；非数组/非字符串/非数都安全降级。
 * 边界约定：
 *   - messages 非数组（null/undefined/string/object）→ 当作 []
 *   - messages 为空数组 → 走 reserveTokens 分支
 *   - totalTokens 非正有限数（0/负/NaN/Infinity）→ 走 reserveTokens 分支
 *   - systemPrompt 非字符串 → 视为 ''
 *   - reserveTokens 非正有限数 → 兜底 1000
 *   - 剩余预算 < reserveTokens → 仍返回 reserveTokens（保底响应空间，避免返 0）
 * @param {{messages?: Array<unknown>, totalTokens?: number, systemPrompt?: string, reserveTokens?: number}} [opts]
 * @returns {number} 非负整数（≥ 1）
 */
export function calculateRemainingBudget({
  messages,
  totalTokens,
  systemPrompt,
  reserveTokens,
} = {}) {
  // 兜底 reserveTokens：必须是正有限整数
  const safeReserve =
    Number.isFinite(reserveTokens) && reserveTokens > 0 ? Math.trunc(reserveTokens) : 1000;
  // 兜底 totalTokens：0/负/NaN/Infinity → 0（强制走 reserve 分支）
  const safeTotal =
    Number.isFinite(totalTokens) && totalTokens > 0 ? Math.trunc(totalTokens) : 0;
  // 兜底 messages：必须为数组
  const safeMessages = Array.isArray(messages) ? messages : [];
  // 兜底 systemPrompt：必须为字符串
  const safeSystem = typeof systemPrompt === 'string' ? systemPrompt : '';
  // 估算 messages 已用 token（容错各种形态：string / {content:string} / 其他）
  const usedByMessages = safeMessages.reduce((sum, m) => {
    if (m == null) return sum;
    if (typeof m === 'string') return sum + estimateTokens(m);
    if (typeof m === 'object' && typeof m.content === 'string') {
      return sum + estimateTokens(m.content);
    }
    return sum + estimateTokens(String(m));
  }, 0);
  const usedBySystem = estimateTokens(safeSystem);
  const used = usedByMessages + usedBySystem;
  // 显式守卫①：空输入短路（messages=[] 且 systemPrompt='' → 零占用），remaining 取上限（safeTotal>0 表达“全部预算可用”，否则回退 reserve）
  if (safeMessages.length === 0 && safeSystem === '') {
    return toSafeNonNegativeInt(safeTotal > 0 ? safeTotal : safeReserve, safeReserve);
  }
  // 显式守卫②：单条消息 token 数 ≥ 总预算（已含 system 占用）→ 标记为不可装入，返 reserve 作下限（绝不抛异常，绝不返 0）
  if (safeMessages.length === 1 && safeTotal > 0 && used >= safeTotal) {
    return toSafeNonNegativeInt(safeReserve, safeReserve);
  }
  // 上限未知或非正 → 直接给 reserve
  if (safeTotal === 0) return safeReserve;
  // 已用 ≥ 上限 → 至少给 reserve（绝不返 0，避免下游把空预算当合法）
  if (used >= safeTotal) return safeReserve;
  // 剩余预算与保底取大（再用 toSafeNonNegativeInt 兜底，确保上游永不收到 NaN/Infinity/负数）
  return toSafeNonNegativeInt(Math.max(safeReserve, safeTotal - used), safeReserve);
}

/**
 * 预算分配函数：将 totalBudget 按 messages 的预估 token 数进行比例分配。
 * 防御性处理：
 *   - messages 非数组（null/undefined/string/object）或为空数组 → 返回零分配结果 {entries: [], used: 0, remaining: 0}
 *   - totalBudget 非正有限数（0/负/NaN/Infinity）→ 返回零分配结果 {entries: [], used: 0, remaining: 0}
 * 预算充足时按原始用量分配并返剩余；预算不足时按比例截断分配（先保 0 再按比例），永不返 NaN/Infinity/负数。
 * @param {Array<unknown>} messages
 * @param {number} totalBudget
 * @returns {{entries: Array<{index: number, tokens: number}>, used: number, remaining: number}}
 */
export function allocateBudget(messages, totalBudget) {
  // 防御①：messages 非数组或为空 → 视为零分配
  if (!Array.isArray(messages) || messages.length === 0) {
    return { entries: [], used: 0, remaining: 0 };
  }
  // 防御②：totalBudget 非正有限数（0/负/NaN/Infinity）→ 视为零预算
  if (!(Number.isFinite(totalBudget) && totalBudget > 0)) {
    return { entries: [], used: 0, remaining: 0 };
  }
  // 估算每条消息的 token 数（与 calculateRemainingBudget 同口径：string / {content:string} / 其他）
  const items = messages.map((m, index) => {
    let text = '';
    if (typeof m === 'string') text = m;
    else if (m != null && typeof m === 'object' && typeof m.content === 'string') text = m.content;
    else if (m != null) text = String(m);
    return { index, tokens: toSafeNonNegativeInt(estimateTokens(text), 0) };
  });
  const totalUsed = items.reduce((s, it) => s + it.tokens, 0);
  // 总用量 ≤ 预算 → 全量分配，剩余返回
  if (totalUsed <= totalBudget) {
    return {
      entries: items,
      used: toSafeNonNegativeInt(totalUsed, 0),
      remaining: toSafeNonNegativeInt(totalBudget - totalUsed, 0),
    };
  }
  // 总用量 > 预算 → 按比例截断分配（保底 0）
  const entries = items.map((it) => ({
    index: it.index,
    tokens: toSafeNonNegativeInt(Math.floor((it.tokens / totalUsed) * totalBudget), 0),
  }));
  const used = entries.reduce((s, e) => s + e.tokens, 0);
  return {
    entries,
    used: toSafeNonNegativeInt(used, 0),
    remaining: toSafeNonNegativeInt(totalBudget - used, 0),
  };
}

export function createContextComposer({
  budgetTokens = Number(process.env.NOE_CONTEXT_BUDGET_TOKENS) || 6000,
  separator = '\n\n',
} = {}) {
  // 边界：0 预算合法（视为'全部裁掉'），NaN/Infinity/负数回退默认 6000
  const budget = Number.isFinite(budgetTokens) && budgetTokens >= 0 ? Math.trunc(budgetTokens) : 6000;
  // 边界：separator 非字符串（null/number/object 等）回退默认 '\n\n'，避免 null+text 退化成 'null'+text 污染 token 估算与最终拼接
  const sep = typeof separator === 'string' ? separator : '\n\n';
  /** @type {Array<{id: string, text: string, keep: number}>} */
  const parts = [];
  return {
    /**
     * 注册一段注入文本；空文本忽略。
     * @param {string} id 段标识（dropped 观测用）
     * @param {string} text 段内容（不含分隔符）
     * @param {{keep?: number}} [opts] keep 1-9，越大越不容易被裁
     */
    add(id, text, { keep = 5 } = {}) {
      const clean = String(text || '');
      if (!clean.trim()) return;
      const k = Number.isFinite(keep) ? Math.min(9, Math.max(1, Math.trunc(keep))) : 5;
      parts.push({ id: String(id || `part-${parts.length}`), text: clean, keep: k });
    },

    /**
     * 组装：预算内按加入顺序全量输出；超预算按 keep 升序整段裁（同级后加先丢）。
     * 不抛错、不返回 undefined；总返回结构化结果，便于调用方判定分配成败：
     *   - status='empty'   : 未注册任何非空段（add 的全空/未调用）
     *   - status='ok'      : 全部段装下，ok=true
     *   - status='overflow': 有段被裁，ok=false（被裁段 id 全在 dropped 里）
     * 零预算下所有非空段必然被裁 → status='overflow'，dropped.length === parts.length。
     * @returns {{text: string, dropped: string[], usedTokens: number, budgetTokens: number, ok: boolean, status: 'empty'|'ok'|'overflow'}}
     */
    compose() {
      const alive = [...parts];
      const dropped = [];
      // 短路①：items 为空时直接返回零占用结果（无注册段，无需进入 reduce/while）
      if (parts.length === 0) {
        return { text: '', dropped: [], usedTokens: 0, budgetTokens: budget, ok: false, status: 'empty' };
      }
      // 边界守卫①：0/负总预算短路（顶部构造期已把 NaN/Infinity/负数拍回 6000，此处防御外部直接改 budget 字段/绕过构造器）
      if (!(Number.isFinite(budget) && budget > 0)) {
        for (const p of parts) dropped.push(p.id);
        return { text: '', dropped, usedTokens: 0, budgetTokens: budget, ok: false, status: parts.length === 0 ? 'empty' : 'overflow' };
      }
      // 审计 §3.3 P2①：维护 running used，避免 while 每轮 + return 各重算一次全量 reduce（drop 时只减去被删项）
      // 边界守卫③：item 形态异常（p 非对象 / p.text 非字符串 / 估算结果 NaN/负数）→ 视作 0 token，避免 NaN 下传污染 used 与裁剪决策
      const tokenOf = (p) => {
        if (p == null || typeof p.text !== 'string') return 0;
        const n = estimateTokens(sep + p.text);
        return Number.isFinite(n) && n >= 0 ? n : 0;
      };
      // 短路②：单 item 字符数 >= 总预算 → 整段丢，跳过 keep 比较（与 while 内 guard② 语义一致，仅提前到 reduce 之前）
      if (parts.length === 1 && tokenOf(parts[0]) >= budget) {
        return { text: '', dropped: [parts[0].id], usedTokens: 0, budgetTokens: budget, ok: false, status: 'overflow' };
      }
      let used = alive.reduce((n, p) => n + tokenOf(p), 0);
      while (alive.length && used > budget) {
        // 边界守卫②：单 item 已超预算 → 整段丢，跳过 keep 比较，避免任何 NaN 下传与未捕获异常
        if (alive.length === 1) {
          used -= tokenOf(alive[0]);
          dropped.push(alive[0].id);
          alive.splice(0, 1);
          break;
        }
        let idx = 0;
        for (let i = 1; i < alive.length; i += 1) {
          if (alive[i].keep <= alive[idx].keep) idx = i; // <= 让同级里后加入的先丢
        }
        used -= tokenOf(alive[idx]);
        dropped.push(alive[idx].id);
        alive.splice(idx, 1);
      }
      const text = alive.map((p) => sep + p.text).join('');
      // 边界：0 预算/所有段都超长 → dropped 含全部 id，status='overflow'，text=''
      const status = parts.length === 0 ? 'empty' : (dropped.length === 0 ? 'ok' : 'overflow');
      return { text, dropped, usedTokens: toSafeNonNegativeInt(Math.min(used, budget), 0), budgetTokens: toSafeNonNegativeInt(budget, 0), ok: dropped.length === 0, status };
    },
  };
}
