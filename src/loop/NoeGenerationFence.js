// NoeGenerationFence — 自动回复「代际栅栏」，防止并发回复连击竞态。
//
// 问题：用户在同一会话/渠道连发多条消息时，多个异步 LLM 回复因生成耗时不同，
//   旧回复可能在新回复之后才落地，造成「旧覆盖新 / 错乱连击」。
// 方案：按 会话×渠道×账号 维护一个单调递增的 generation 计数器。每次开始一轮前台回复
//   都 begin() 拿到 snapshot；投递前用 shouldSuppress() 判断是否已有更新的一代在跑或已投递，
//   是则静默压制本（旧）代，只让最新一代可见投递。
//
// 纯逻辑、无 I/O、无副作用，可独立单测。
// Adapted from OpenClaw (MIT) src/auto-reply/dispatch.ts ForegroundReplyFence
//   — github.com/openclaw/openclaw

function fencePart(value) {
  if (value === undefined || value === null) return '';
  const text = String(value).trim();
  return text;
}

/**
 * 由会话/渠道/账号字段拼出稳定的 fence key。
 * 任一关键维度缺失则返回 ''（调用方应视为「无法栅栏」，按默认放行处理）。
 */
export function resolveFenceKey(parts = {}) {
  const session = fencePart(parts.sessionKey ?? parts.session ?? parts.conversationId);
  const channel = fencePart(
    parts.channel ?? parts.surface ?? parts.provider ?? parts.originatingChannel,
  );
  const target = fencePart(
    parts.to ?? parts.nativeChannelId ?? parts.from ?? parts.peer,
  );
  const account = fencePart(parts.accountId ?? parts.account) || 'default';
  if (!session && !channel && !target) return '';
  return [session || '-', channel || '-', target || '-', account].join('::');
}

/**
 * 创建一个代际栅栏实例。
 * @returns {{
 *   begin: (key: string) => ({key: string, generation: number}|null),
 *   shouldSuppress: (snapshot: object|null|undefined) => boolean,
 *   markDelivered: (snapshot: object|null|undefined) => boolean,
 *   release: (snapshot: object|null|undefined) => void,
 *   activeCount: (key: string) => number,
 *   size: () => number,
 *   reset: () => void,
 * }}
 */
export function createGenerationFence() {
  /** @type {Map<string, {generation:number, visibleDeliveryGeneration:number, active:Map<number,number>}>} */
  const byKey = new Map();

  function stateFor(key) {
    let state = byKey.get(key);
    if (!state) {
      state = { generation: 0, visibleDeliveryGeneration: 0, active: new Map() };
      byKey.set(key, state);
    }
    return state;
  }

  function hasNewerActiveGeneration(state, generation) {
    for (const [gen, count] of state.active) {
      if (gen > generation && count > 0) return true;
    }
    return false;
  }

  function decActive(state, generation) {
    const count = state.active.get(generation) || 0;
    if (count <= 1) state.active.delete(generation);
    else state.active.set(generation, count - 1);
  }

  function maybeCleanup(key, state) {
    if (state.active.size === 0) {
      // 无在途代际时，保留 generation/visibleDeliveryGeneration 历史会无限增长 key；
      // 但只要无在途即可安全清除整条记录（下次 begin 从 0 重新计数对正确性无影响：
      // 同一 key 不再有更旧的在途回复可被「连击」）。
      byKey.delete(key);
    }
  }

  return {
    /**
     * 开始一轮前台回复，返回快照；key 为空则返回 null（调用方默认放行不压制）。
     * ⚠️ 约束：每个 begin 快照必须恰好被消费一次（shouldSuppress → markDelivered/release）。
     *   当某 key 无在途代际时记录会被清除以防内存增长；若复用已 release/delivered 的旧快照，
     *   或在清除后才迟到 shouldSuppress，会因代际重置而误判。dispatch 调用层须保证一快照一生命周期。
     */
    begin(key) {
      if (!key) return null;
      const state = stateFor(key);
      state.generation += 1;
      state.active.set(state.generation, (state.active.get(state.generation) || 0) + 1);
      return { key, generation: state.generation };
    },

    /** 投递前判断：是否应压制本代（已有更新一代在跑，或已有更新一代可见投递过）。 */
    shouldSuppress(snapshot) {
      if (!snapshot || !snapshot.key) return false;
      const state = byKey.get(snapshot.key);
      if (!state) return false;
      if (state.visibleDeliveryGeneration > snapshot.generation) return true;
      if (hasNewerActiveGeneration(state, snapshot.generation)) return true;
      return false;
    },

    /** 标记本代已可见投递；返回 true 表示成功标记（未被更新一代抢先）。 */
    markDelivered(snapshot) {
      if (!snapshot || !snapshot.key) return false;
      const state = byKey.get(snapshot.key);
      if (!state) return false;
      const suppressed = state.visibleDeliveryGeneration > snapshot.generation
        || hasNewerActiveGeneration(state, snapshot.generation);
      if (state.visibleDeliveryGeneration < snapshot.generation) {
        state.visibleDeliveryGeneration = snapshot.generation;
      }
      decActive(state, snapshot.generation);
      maybeCleanup(snapshot.key, state);
      return !suppressed;
    },

    /** 释放本代（放弃投递/出错），不更新可见投递代。 */
    release(snapshot) {
      if (!snapshot || !snapshot.key) return;
      const state = byKey.get(snapshot.key);
      if (!state) return;
      decActive(state, snapshot.generation);
      maybeCleanup(snapshot.key, state);
    },

    /** 某 key 当前在途代际总数（测试/诊断用）。 */
    activeCount(key) {
      const state = byKey.get(key);
      if (!state) return 0;
      let total = 0;
      for (const count of state.active.values()) total += count;
      return total;
    },

    size() { return byKey.size; },
    reset() { byKey.clear(); },
  };
}
