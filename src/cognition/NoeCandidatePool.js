// @ts-check
/**
 * NoeCandidatePool — 多源候选池 + advisory frame（ROADMAP P2.1+P2.2 切片A）。
 *
 * 痛点：owner-seed 现在是 directive——owner 的话直接 goalSystem.add() 成目标、下拍激活，Neo 无法
 *   "自主打分→采纳或拒绝→记拒绝理由"。且三源(owner/self-discovered/system)各自直接 add，无统一池。
 *
 * 方案：三源候选先进池，统一打分，score≥阈值采纳(升格为目标)，否则拒绝并记理由(mind.html 可读)。
 *   advisory：owner 候选也先进池——但 owner 权重最高(1.0)，几乎总过阈值(≈directive 体验)，
 *   只在明显矛盾/低可行时才拒绝且必留理由、可被 owner 推翻。
 *
 * 安全/纪律：纯逻辑 + DI(store/promote 注入)，零执行权。flag NOE_CANDIDATE_POOL 由【调用方】门控：
 *   OFF → 调用方走现状 directive(本模块根本不被调，零回归)；ON → owner seed 改走本池(owner kickstart)。
 *   改 owner seed 语义(directive→advisory)是信任模型变更，点火权属 owner。
 */

// 源权重：owner 最高(advisory 下你的话仍压一切)；system_repair 次之(故障修复要紧)；自生源递减。
const DEFAULT_SOURCE_WEIGHT = Object.freeze({
  owner: 1.0,
  system_repair: 0.95,
  self_evolution: 0.9,
  reflection: 0.6,
  drive: 0.4,
});

/**
 * @param {object} deps
 * @param {{ insert:(c:object)=>void, update:(id:string,patch:object)=>void, get:(id:string)=>object|null, list:(filter?:object)=>object[] }} deps.store 候选池存储(DI)
 * @param {(candidate:object)=>(string|null)} [deps.promote] 采纳时升格为目标(包装 goalSystem.add)，返回 goalId
 * @param {Record<string,number>} [deps.sourceWeight]
 * @param {number} [deps.acceptThreshold] 采纳阈值，默认 0.45（owner×默认 base 0.6=0.6>阈值，基本总过）
 * @param {() => number} [deps.now]
 * @param {(msg:string)=>void} [deps.log]
 */
export function createCandidatePool({
  store,
  promote = null,
  sourceWeight = DEFAULT_SOURCE_WEIGHT,
  acceptThreshold = 0.45,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  if (!store || typeof store.insert !== 'function') throw new TypeError('createCandidatePool: store(含 insert/update/get/list) 必须注入');
  let seq = 0;

  /** 打分：源权重 × baseScore(候选自报可行性/价值，夹 0..1，默认中性 0.6)。 */
  function scoreCandidate(c) {
    const w = Object.prototype.hasOwnProperty.call(sourceWeight, c?.source) ? sourceWeight[c.source] : 0.3;
    const base = Number.isFinite(c?.baseScore) ? Math.max(0, Math.min(1, c.baseScore)) : 0.6;
    return Math.round(w * base * 1000) / 1000;
  }

  /** 候选进池(pending)。 */
  function submit(candidate = {}) {
    const id = candidate.id || `cand-${now()}-${seq++}`;
    const c = {
      id,
      source: candidate.source || 'unknown',
      title: String(candidate.title || ''),
      why: String(candidate.why || ''),
      baseScore: candidate.baseScore,
      score: 0,
      decision: 'pending',
      reject_reason: '',
      created_at: now(),
      decided_at: null,
    };
    c.score = scoreCandidate(c);
    store.insert(c);
    return c;
  }

  /** 对 pending 候选打分决策：≥阈值采纳(升格目标)，否则拒绝记理由。幂等(非 pending 直接返回)。 */
  function decide(id) {
    const c = store.get(id);
    if (!c || c.decision !== 'pending') return c || null;
    const score = scoreCandidate(c);
    if (score >= acceptThreshold) {
      let goalId = null;
      try { goalId = typeof promote === 'function' ? promote(c) : null; } catch (e) { log('[candidate-pool] promote 失败: ' + ((e && e.message) || e)); }
      store.update(id, { decision: 'accepted', score, decided_at: now(), goal_id: goalId });
      return { ...c, decision: 'accepted', score, goal_id: goalId };
    }
    const reason = `score ${score} < 阈值 ${acceptThreshold}（source=${c.source}，baseScore=${c.baseScore ?? '默认'}）`;
    store.update(id, { decision: 'rejected', score, decided_at: now(), reject_reason: reason });
    return { ...c, decision: 'rejected', score, reject_reason: reason };
  }

  /** owner 推翻拒绝：强制采纳一个已 rejected 的候选(记 owner override)。 */
  function ownerOverride(id) {
    const c = store.get(id);
    if (!c) return null;
    let goalId = null;
    try { goalId = typeof promote === 'function' ? promote(c) : null; } catch (e) { log('[candidate-pool] override promote 失败: ' + ((e && e.message) || e)); }
    store.update(id, { decision: 'accepted', decided_at: now(), goal_id: goalId, reject_reason: '', overridden_by_owner: true });
    return { ...c, decision: 'accepted', goal_id: goalId, overridden_by_owner: true };
  }

  function list(filter = {}) { return store.list(filter); }

  return { submit, decide, ownerOverride, list, scoreCandidate };
}

export { DEFAULT_SOURCE_WEIGHT };
