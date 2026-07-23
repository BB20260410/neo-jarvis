// @ts-check
// NoeBackgroundReviewHook — 把孤儿 NoeBackgroundReview（proposal-only 后台复盘）接到「对话收尾」。
//
// 设计原则（codex 硬约束）：
//   · 只在「对话收尾 / 任务完成」这类离散动作后触发（当前接 chat 房 /api/rooms/:id/rotate），
//     绝不接每个 heartbeat（避免高频烧本地大脑）。
//   · 输出保持 proposal-only：本 hook 只调 runner.run（runner 只把可审计报告原子写到
//     output/noe-background-review/ 沙箱目录），不直接执行任何副作用；下游 NoeProposalInbox
//     自动把报告里的 proposals 收为 background_review 源，apply 仍走既有 owner 审批的 gated 路径。
//   · 注入式（DI）：runner / enabled / now / logger 全从参数传入，便于确定性单测（不触网、不依赖真实时钟）。
//   · OFF（enabled !== true 或 runner 缺失）= 完全 no-op：不调 runner、不写盘、零副作用 → 零回归。
//   · 错误隔离：afterConversation 全程 try/catch + 永不 throw——后台复盘是旁路，绝不破坏对话收尾主路径。
//
// env 门控由调用方（server.js NOE_BACKGROUND_REVIEW=1）决定是否构造并注入本 hook。

const MIN_TRIGGER_MESSAGES = 2; // 至少要有一来一回才值得复盘（runner 内部 shouldRunBackgroundReview 还会再过滤信号量）

function asMessages(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((m) => m && typeof m === 'object' && m.content != null)
    .map((m) => ({
      role: m.role === 'user' ? 'user' : 'assistant',
      content: String(m.content),
    }));
}

/**
 * 创建对话收尾后台复盘 hook。
 *
 * @param {object} [opts]
 * @param {boolean} [opts.enabled] 是否启用（默认随 runner 是否存在；显式 false 强制 OFF）。
 * @param {{ run: (args: { messages: Array<any>, context?: object, dryRun?: boolean, persist?: boolean }) => Promise<any> } | null} [opts.runner]
 *        NoeBackgroundReviewRunner 实例（注入）。缺失即 OFF。
 * @param {(...args: any[]) => void} [opts.logger] 失败日志（注入，默认静默）。
 * @returns {{ enabled: boolean, afterConversation: (input?: { messages?: Array<any>, context?: object }) => Promise<{ ok: boolean, skipped?: boolean, reason?: string, triggered?: boolean, reviewId?: string|null, reportRef?: string|null, error?: string }> }}
 */
export function createNoeBackgroundReviewHook({
  enabled = undefined,
  runner = null,
  logger = null,
} = {}) {
  const hasRunner = !!(runner && typeof runner.run === 'function');
  // enabled 未显式给值时，以 runner 是否可用为准；显式 false 一律 OFF。
  const on = enabled === false ? false : (enabled === true ? hasRunner : hasRunner);

  return {
    enabled: on,
    /**
     * 对话收尾后触发后台复盘（proposal-only）。OFF/无 runner/对话过短 → 直接跳过不产任何副作用。
     * 永不 throw：失败只返回 { ok:false }，由调用方 fire-and-forget 调用即可。
     */
    async afterConversation(input = {}) {
      if (!on || !hasRunner) {
        return { ok: true, skipped: true, reason: 'background_review_off' };
      }
      const messages = asMessages(input.messages);
      if (messages.length < MIN_TRIGGER_MESSAGES) {
        return { ok: true, skipped: true, reason: 'background_review_conversation_too_short' };
      }
      try {
        // proposal-only：dryRun + persist——runner 只写可审计报告（沙箱目录），不执行任何副作用。
        // 报告落地后由 NoeProposalInbox（background_review 源）自动收为待审批提案。
        const result = await runner.run({
          messages,
          context: input.context && typeof input.context === 'object' ? input.context : {},
          dryRun: true,
          persist: true,
        });
        return {
          ok: result?.ok !== false,
          skipped: result?.skipped === true,
          triggered: true,
          reason: result?.reason || null,
          reviewId: result?.reviewId || null,
          reportRef: result?.reportRef || null,
        };
      } catch (e) {
        try { logger?.('[noe-background-review] afterConversation failed:', e?.message || String(e)); } catch { /* 日志失败忽略 */ }
        return { ok: false, triggered: false, error: e?.message || String(e) };
      }
    },
  };
}
