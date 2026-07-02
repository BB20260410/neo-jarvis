// NoeMemoryConsolidator — 记忆「梦境/睡眠整合」的确定性核心(纯逻辑规划器)。
//
// 灵感:BaiLongma consolidator(合并语义重复/降级陈旧/保护身份级/矛盾保留)+ OpenClaw dreaming
//   (recall-heat 晋升)。本模块只【产出整合计划】,不碰 DB:给一组记忆记录 → 返回
//   { merges, downgrades, promotions, skippedProtected }。由调用方用 MemoryCore 已有的
//   merge/hide(软删可恢复:visibility/merged_into)落地。可选 async llmConsolidate 钩子做语义去重。
//
// 纯逻辑、注入式时钟、无 I/O、无副作用,可独立单测。
// Adapted from BaiLongma (MIT) src/memory/consolidator.js 的整合策略,去掉 LLM/DB 改为纯规划。

const DEFAULT_PROTECTED_SALIENCE = 5;      // 身份级信念:绝不自动合并/降级
const DEFAULT_PROMOTION_MIN_HITS = 3;      // 被≥3 次不同查询命中 → 晋升候选(OpenClaw recall-heat)
const DEFAULT_STALE_MAX_HITS = 0;          // 从未被命中
const DEFAULT_STALE_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 天未更新视为陈旧

function clean(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max);
}

/** 把记录的显著性归一到 1-5(显式 salience 优先,否则由 confidence/hitCount 估)。 */
export function deriveSalience(rec = {}) {
  if (Number.isFinite(rec.salience)) return Math.max(1, Math.min(5, Math.trunc(rec.salience)));
  let s = 3;
  if (Number.isFinite(rec.confidence)) s = rec.confidence >= 0.85 ? 4 : rec.confidence < 0.3 ? 2 : 3;
  if ((rec.hitCount || 0) >= DEFAULT_PROMOTION_MIN_HITS) s = Math.min(5, s + 1);
  return Math.max(1, Math.min(5, s));
}

/** 身份级/受保护记录:绝不自动合并或降级。 */
export function isProtected(rec = {}, protectedScopes = []) {
  if (rec.protected === true) return true;
  if (deriveSalience(rec) >= DEFAULT_PROTECTED_SALIENCE) return true;
  if (rec.scope && protectedScopes.includes(rec.scope)) return true;
  return false;
}

/** 内容归一(用于精确/近似去重判定):去空白、小写、去标点。 */
function normContent(rec = {}) {
  return clean(rec.content || rec.text || rec.title || '', 2000)
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '');
}

/**
 * 产出整合计划(确定性规则;可选 LLM 钩子做语义去重)。
 * @param {object[]} memories 记忆记录数组(shape: {id, content/text/title, salience?, confidence?, hitCount?, uniqueQueryCount?, lastHitAt?, updatedAt?, expiresAt?, scope?, protected?})
 * @param {object} [opts]
 * @param {number} [opts.nowMs]
 * @param {string[]} [opts.protectedScopes] 永不动的 scope(如 identity/person)
 * @param {number} [opts.staleAgeMs]
 * @param {(groups:object[])=>Promise<object[]>} [opts.llmConsolidate] 可选:对未精确命中的组做语义去重,返回额外 merges
 * @returns {Promise<{merges:object[], downgrades:object[], promotions:object[], skippedProtected:number, scanned:number}>}
 */
export async function planConsolidation(memories = [], opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const protectedScopes = Array.isArray(opts.protectedScopes) ? opts.protectedScopes : [];
  const staleAgeMs = Number.isFinite(opts.staleAgeMs) ? opts.staleAgeMs : DEFAULT_STALE_AGE_MS;

  const recs = (Array.isArray(memories) ? memories : []).filter((r) => r && r.id != null && r.hidden !== true);
  const merges = [];
  const downgrades = [];
  const promotions = [];
  let skippedProtected = 0;

  // 1) 精确/近似去重 → 合并(保 salience 最高、其次最近)。受保护记录不进合并。
  const byContent = new Map();
  for (const r of recs) {
    if (isProtected(r, protectedScopes)) continue;
    const contentKey = normContent(r);
    if (!contentKey) continue;
    const scopeKey = clean(r.scope || 'project', 80) || 'project';
    const key = `${scopeKey}\u0000${contentKey}`;
    if (!byContent.has(key)) byContent.set(key, []);
    byContent.get(key).push(r);
  }
  const mergedIds = new Set();
  for (const group of byContent.values()) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) =>
      (deriveSalience(b) - deriveSalience(a)) || ((b.updatedAt || 0) - (a.updatedAt || 0)));
    const keep = sorted[0];
    const drops = sorted.slice(1);
    merges.push({
      keepId: keep.id,
      dropIds: drops.map((d) => d.id),
      mergedSalience: Math.max(...group.map(deriveSalience)),
      reason: 'exact_or_near_duplicate',
    });
    for (const d of drops) mergedIds.add(d.id);
  }

  // 2) 陈旧低价值 → 降级(不删)。受保护/已被合并的跳过。
  for (const r of recs) {
    if (mergedIds.has(r.id)) continue;
    if (isProtected(r, protectedScopes)) { skippedProtected += 1; continue; }
    const expired = r.expiresAt && r.expiresAt <= nowMs;
    const updatedAt = r.updatedAt || r.lastHitAt || 0;
    const old = updatedAt > 0 && (nowMs - updatedAt) > staleAgeMs;
    const coldAndOld = (r.hitCount || 0) <= DEFAULT_STALE_MAX_HITS && old;
    const cur = deriveSalience(r);
    if ((expired || coldAndOld) && cur > 1) {
      downgrades.push({ id: r.id, fromSalience: cur, toSalience: cur - 1, reason: expired ? 'expired' : 'stale_cold' });
    }
  }

  // 3) recall-heat 晋升:被多次不同查询高频命中 → 标记晋升(写显式记忆核由调用方决定)。
  // 审计 §3.3 P0-5：MemoryCore.rowToMemory 不产出 uniqueQueryCount（恒 undefined），原 `||0`
  // 使所有候选 uniq=0、晋升永不触发（死代码）。缺失时回退 hitCount（recall 命中累加）做 recall-heat
  // 代理，让晋升逻辑真正生效；显式传 uniqueQueryCount 的调用方（纯函数测试）行为不变。
  for (const r of recs) {
    const uniq = Number.isFinite(r.uniqueQueryCount) ? r.uniqueQueryCount : (Number(r.hitCount) || 0);
    if (uniq >= DEFAULT_PROMOTION_MIN_HITS && deriveSalience(r) < 5) {
      promotions.push({ id: r.id, reason: 'recall_heat', uniqueQueryCount: uniq });
    }
  }

  // 4) 可选 LLM 语义去重(对"内容不同但语义重复"的组),追加 merges。LLM 钩子由调用方注入(走 aiteam→M3)。
  if (typeof opts.llmConsolidate === 'function') {
    // 安全闸用全集的受保护 id 判定(不能只看 candidates,否则 LLM 想 drop 受保护记录时漏检)。
    const protectedIds = new Set(recs.filter((r) => isProtected(r, protectedScopes)).map((r) => r.id));
    const candidates = recs.filter((r) => !mergedIds.has(r.id) && !isProtected(r, protectedScopes));
    try {
      const extra = await opts.llmConsolidate(candidates);
      if (Array.isArray(extra)) {
        for (const m of extra) {
          if (m && m.keepId != null && Array.isArray(m.dropIds) && m.dropIds.length) {
            // 安全闸:LLM 不得合并/丢弃任何受保护记录(keep 或 drop 命中受保护都拒)。
            const touchesProtected = protectedIds.has(m.keepId) || m.dropIds.some((id) => protectedIds.has(id));
            if (!touchesProtected) merges.push({ ...m, reason: m.reason || 'llm_semantic_duplicate' });
          }
        }
      }
    } catch { /* LLM 失败不影响确定性计划 */ }
  }

  return { merges, downgrades, promotions, skippedProtected, scanned: recs.length };
}

/**
 * 梦境/睡眠整合调度骨架。进程内 setInterval(不是系统 cron),**默认 enabled=false**——
 *   必须显式开启(后台周期性可能调 LLM,需 owner 授权)。所有依赖注入式,可不靠真实定时器单测(直接调 tick)。
 * @param {object} deps
 * @param {()=>Promise<object[]>|object[]} deps.loadCandidates 取候选记忆(如 MemoryCore 的高频/陈旧记忆)
 * @param {(plan:object)=>Promise<any>|any} deps.applyPlan 应用计划(merge→MemoryCore.merge,downgrade/promote 由调用方落地)
 * @param {object} [deps.planOpts] 透传给 planConsolidation(protectedScopes / llmConsolidate 等)
 * @param {boolean} [deps.enabled=false]
 */
export function createConsolidationLoop({
  loadCandidates, applyPlan, planFn = planConsolidation, planOpts = {},
  intervalMs = 30 * 60 * 1000, firstDelayMs = 5 * 60 * 1000,
  enabled = false, now = () => Date.now(), log = () => {},
} = {}) {
  let timer = null; let started = false; let running = false;
  async function tick() {
    if (running) return { skipped: 'overlap' }; // 防重入(上一轮没跑完)
    running = true;
    try {
      const candidates = await loadCandidates();
      const plan = await planFn(candidates || [], { nowMs: now(), ...planOpts });
      const applied = typeof applyPlan === 'function' ? await applyPlan(plan) : null;
      log(`[dream] scanned=${plan.scanned} merges=${plan.merges.length} downgrades=${plan.downgrades.length} promotions=${plan.promotions.length}`);
      return { ok: true, plan, applied };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    } finally {
      running = false;
    }
  }
  return {
    tick, // 手动触发(测试/调试/owner 手动整合)
    isEnabled: () => enabled,
    isRunning: () => started,
    start() {
      if (started || !enabled) return false; // 默认 OFF:enabled 才会真跑后台循环
      started = true;
      timer = setTimeout(() => { tick(); timer = setInterval(tick, intervalMs); }, firstDelayMs);
      if (timer?.unref) timer.unref(); // 不阻塞进程退出
      return true;
    },
    stop() { if (timer) { clearTimeout(timer); clearInterval(timer); } timer = null; started = false; },
  };
}
