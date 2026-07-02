// @ts-check
// NoeOwnerBehaviorPredictor — owner 行为预测最小闭环（codex 建议的功能性自我意识项）。
//
// 问题：期望账本此前只对「世界/自己」下注（反刍念头、深思预测），从不对「外部的 owner」下注。
//   功能性自我意识更贴近的一环是：Noe 能在 owner 交互后预测「owner 下一步会怎么做」，并被 owner
//   的真实后续行为硬纠正——这给的是「对他者的预期 + 校准误差」，比内心独白更接近"我知道我在和谁互动"。
//
// 设计（最小可行，零 LLM，复用 NoeExpectationLedger.add/open/resolve → 自动进 Brier）：
//   每次 owner 交互（episodic timeline 的 type:'interaction'，即 owner 真说了话/真交办）时，
//   ① 先结算：扫开放的 owner_pred 预测，若这条新交互文本命中某条预测的主题 token → resolve(id,1)；
//      若 owner 明确取消/否定交办后的 followup → resolve(id,0) 并可触发 surprise 学习。
//      （明确 outcome → 进 Brier；沉默/换话题仍靠 7 天 sweep/人工裁决兜底）。
//   ② 再预测：从这条交互确定性抽「主题」（owner 提到的项目/名词）+「是否交办」，立 owner-behavior 类
//      expectation：claim 内嵌稳定 token `[owner-pred:topic:<主题>]` / `[owner-pred:followup]`，
//      claim=「owner 接下来还会再提到/谈论 <主题>」/「owner 会要求实测/回报/采纳」。
//
// 诚实·边界（最小版↔扩展位）：
//   - 最小版不把「没做/没再提」强判落空(0)——与判证宪法一致（"仅没检索到证据≠落空"）。
//     只有 owner 明确说取消/不用/先停/拒绝 followup 时，才把「交办后会要求实测/回报/采纳」结算为 0。
//   - 主题抽取是粗粒度关键词（zh 连续块/ascii 词 + 停用词过滤），不接 NER/项目库——留扩展位：
//     注入 subjectExtractor 可换更强的项目别名识别。
//   - 概率 p 是固定先验（topic 0.55 弱、followup 0.75 强），非学习值——留扩展位：可后续按历史命中率自适应。
//   - 全程 fail-open：ledger 缺失/任一调用抛错都静默退回，绝不阻断对话/反刍闭环。

import { clamp } from './_mathUtils.js';

const HOUR = 3600_000;
const DAY = 24 * HOUR;

const TOKEN_PREFIX = 'owner-pred';
const FOLLOWUP_TOKEN = `[${TOKEN_PREFIX}:followup]`;
const topicToken = (subject) => `[${TOKEN_PREFIX}:topic:${subject}]`;

// owner 交互里「交办/布置任务」的确定性标记 → 立 followup 预测（会要求实测/回报/采纳）。
const DELEGATION_RE = /(?:帮我|替我|去(?:做|办|查|跑|改|写|加|修|实现|验证)|交办|布置|安排|搞定|落实|实现一下|做一下|加一个|改一下|提个?\s*pr|跑(?:个|一?下)?\s*测|上线|部署|发布)/i;
// owner 后续「兑现 followup」的确定性信号（要求实测/回报/采纳/通过/完成）。
const FOLLOWUP_SETTLE_RE = /(?:实测|测一?下|跑(?:个|一?下)?\s*测|测试|验证|回报|汇报|报告进?展|采纳|通过|批准|合并|merge|done|搞定了|做完了?|完成了?|怎么样了|进展(?:如何|怎样)?|结果呢)/i;
// owner 明确否定/取消 followup 的确定性信号。只用于 followup 预测，不用于 topic「会再提到」预测。
const FOLLOWUP_FAIL_RE = /(?:(?:不用|不必|不要|别|先别|暂时别|无需)\s*(?:测|测试|验证|跑测|回报|汇报|报告|继续|做|改|修|查|跑|实现|采纳|合并|merge)|(?:取消|撤销|放弃|作废|先停|暂停|停掉|终止|不做了|别做了|不用做了|算了|先放(?:一)?放|不用了|不需要了)|(?:cancel(?:led|ed)?|abort(?:ed)?|stop|reject(?:ed)?|den(?:y|ied)|no need|not needed))/i;

// 主题抽取停用词（2 字虚词/泛词 + ascii 噪声词）：当主题会污染预测命中，直接丢。
const STOPWORDS = new Set([
  '这个', '那个', '一下', '一个', '什么', '怎么', '可以', '需要', '应该', '现在', '今天', '明天',
  '我们', '你们', '他们', '自己', '这样', '那样', '没有', '不是', '就是', '还有', '已经', '然后',
  '主人', '帮我', '替我', '去做', '一些', '东西', '问题', '时候', '地方', '这里', '那里', '一直',
  '继续', '回来', '看下', '看看', '一起', '随便', '聊聊', '说的', '我说', '的话', '进度', '怎样',
  'the', 'and', 'for', 'you', 'are', 'this', 'that', 'with', 'have', 'noe', 'pls', 'plz', 'the',
]);
// 高频功能字：含这些字的 2 字 bigram 基本是连接/指代噪声，不当内容主题（宁缺勿滥）。
const FUNCTION_CHARS = new Set([..."的了是我你他她它这那就都很啊呢吗把被让给和与及或而且并也还又再去来到在跟向从对于把将让叫请帮替着过得地之其此该说看做要会能可应该想"]);

/**
 * 确定性抽 owner 交互里的「主题 subject」+「是否交办」。零 LLM，宁缺勿滥。
 * - 主题（关键取舍 = 内容 bigram，与 NoeExpectationResolver.bigrams 同哲学）：中文没有分词，定长 head
 *   切在不同字上跨轮对不上；故对每个中文连续块取**全部 2 字滑窗 bigram**，滤掉含高频功能字的 bigram +
 *   停用词，再按出现顺序去重取前 maxTopics 个。recurring 的项目核心（息刻/卡牌/登录…）必在两轮 bigram 中
 *   复现 → 子串匹配能稳定命中。ascii 取整词。**诚实边界**：bigram 仍偏粗、会漏掉只出现一次于句中的真主题，
 *   也可能选到非项目名的内容 bigram——这是无分词器下的 MVP 取舍，闭环正确性不靠完美 NLP；留 subjectExtractor
 *   扩展位换分词/NER/项目别名库做精准主题。
 * - 交办：命中 DELEGATION_RE。
 * @param {string} text
 * @param {{maxTopics?: number, isDelegation?: boolean|null}} [opts]
 * @returns {{topics: string[], delegation: boolean}}
 */
export function extractOwnerSubjects(text, { maxTopics = 2, isDelegation = null } = {}) {
  const raw = String(text || '').trim();
  if (!raw) return { topics: [], delegation: false };
  const delegation = isDelegation === true || (isDelegation == null && DELEGATION_RE.test(raw));
  const tokens = [];
  const seen = new Set();
  const limit = Math.max(1, Math.min(5, maxTopics));
  const push = (norm) => {
    if (!norm || norm.length < 2) return;
    if (STOPWORDS.has(norm)) return;
    if (/^\d+$/.test(norm)) return;
    if (seen.has(norm)) return;
    seen.add(norm);
    tokens.push(norm);
  };
  // 顺序扫描中文块（出 bigram）与 ascii 词，保持出现顺序。
  const re = /[一-龥]{2,}|[A-Za-z][A-Za-z0-9_-]{2,23}/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (tokens.length >= limit) break;
    const block = m[0];
    if (/[A-Za-z]/.test(block)) { push(block.toLowerCase()); continue; }
    for (let i = 0; i < block.length - 1 && tokens.length < limit; i += 1) {
      const bg = block.slice(i, i + 2);
      if (FUNCTION_CHARS.has(bg[0]) || FUNCTION_CHARS.has(bg[1])) continue;
      push(bg);
    }
  }
  return { topics: tokens, delegation };
}

/**
 * owner 行为预测器。注入 ledger（NoeExpectationLedger 的 add/open/resolve）+ now。
 * @param {{
 *   ledger?: {add: Function, open: Function, resolve: Function}|null,
 *   now?: () => number,
 *   topicDueMs?: number,        // topic 预测到期窗（默认 2 天）
 *   followupDueMs?: number,     // followup 预测到期窗（默认 12 小时）
 *   topicP?: number,            // topic 预测主观概率（弱先验）
 *   followupP?: number,         // followup 预测主观概率（强先验；默认 0.75，落空 surprise=2bit）
 *   maxTopicsPerTurn?: number,  // 每轮最多立几条 topic 预测
 *   openScanLimit?: number,     // 结算时扫多少条开放预测
 *   subjectExtractor?: Function, // 扩展位：换更强的主题抽取（默认 extractOwnerSubjects）
 *   goalSystem?: {harvestSurprise?: Function}|null, // 明确 followup 落空时把 surprise 接入好奇目标
 * }} [deps]
 */
export function createOwnerBehaviorPredictor({
  ledger = null,
  now = Date.now,
  topicDueMs = 2 * DAY,
  followupDueMs = 12 * HOUR,
  topicP = 0.55,
  followupP = 0.75,
  maxTopicsPerTurn = 2,
  openScanLimit = 60,
  subjectExtractor = extractOwnerSubjects,
  goalSystem = null,
} = {}) {
  const ready = () => Boolean(ledger?.add && ledger?.open && ledger?.resolve);

  /** 取开放的 owner_pred 预测（按 claim 内嵌 token 识别，不污染其它来源的账目）。 */
  function openOwnerPredictions() {
    try {
      return (ledger.open({ limit: Math.max(1, Math.min(500, openScanLimit)) }) || [])
        .filter((row) => row && typeof row.claim === 'string' && row.claim.includes(`[${TOKEN_PREFIX}:`));
    } catch { return []; }
  }

  /**
   * 结算阶段：用「这条新 owner 交互文本」去命中开放的 owner_pred 预测。
   * - topic 预测：新文本含同一主题 token → 应验（owner 真又提到了）。
   * - followup 预测：新文本命中 FOLLOWUP_SETTLE_RE → 应验；命中 FOLLOWUP_FAIL_RE → 落空。
   * 不命中就留账（交给 7 天 sweep / 人工裁决），绝不因沉默或换话题强判 0。
   * @returns {{resolved: number, ids: number[]}}
   */
  function settleFromOwnerText(text) {
    if (!ready()) return { resolved: 0, ids: [] };
    const raw = String(text || '');
    if (!raw.trim()) return { resolved: 0, ids: [] };
    const t = now();
    const opens = openOwnerPredictions();
    if (!opens.length) return { resolved: 0, ids: [] };
    const followupHit = FOLLOWUP_SETTLE_RE.test(raw);
    const followupFail = FOLLOWUP_FAIL_RE.test(raw);
    const lower = raw.toLowerCase();
    const ids = [];
    for (const row of opens) {
      const claim = String(row.claim || '');
      let hit = false;
      let outcome = 1;
      const tm = claim.match(/\[owner-pred:topic:([^\]]+)\]/);
      if (tm && tm[1]) {
        const subj = tm[1];
        hit = /[A-Za-z]/.test(subj) ? lower.includes(subj.toLowerCase()) : raw.includes(subj);
      } else if (claim.includes(FOLLOWUP_TOKEN)) {
        // 明确取消/不用测试一类文本里常同时含「测试」，失败优先，避免误判为兑现 followup。
        // P1[0]（修三方审查 minor）：fail 落空前校验该 followup 新鲜度——chronic/无关的 fail 词(owner 说"取消那个会议"指别的事)
        //   不该结算掉过老的 followup。created_at 距今 > followupDueMs*2 视为已过窗(由 sweep 兜底过期)，不再 fail 判，
        //   避免无关 fail 词污染 Brier + 误立 owner_prediction 假 surprise；应验(followupHit)正向兑现无害不受此限。
        const fresh = Number.isFinite(Number(row.created_at)) && (t - Number(row.created_at)) <= 2 * Math.max(HOUR, Number(followupDueMs) || 12 * HOUR);
        const failNow = followupFail && fresh;
        hit = failNow || followupHit;
        outcome = failNow ? 0 : 1;
      }
      if (!hit) continue;
      try {
        const resolvedRow = ledger.resolve(row.id, outcome, t);
        if (resolvedRow) {
          ids.push(Number(row.id));
          if (outcome === 0 && goalSystem && typeof goalSystem.harvestSurprise === 'function') {
            try { goalSystem.harvestSurprise({ claim: row.claim, surprise: resolvedRow.surprise, origin: 'owner_prediction' }); } // P1-C：owner 明确否定 followup = owner 真实负反馈（门 b 非噪声）
            catch { /* 好奇立项失败不阻断 owner 预测结算 */ }
          }
        }
      } catch { /* 单条结算失败不阻断其余 */ }
    }
    return { resolved: ids.length, ids };
  }

  /**
   * 预测阶段：从这条 owner 交互立 owner-behavior 预测（topic + followup）。
   * 重复主题由 ledger.add 的相似度去重兜底（同主题已有开放预测则返回 null，不重复入账）。
   * @returns {{predicted: number, ids: number[]}}
   */
  function predictFromOwnerText(text, { isDelegation = null } = {}) {
    if (!ready()) return { predicted: 0, ids: [] };
    const raw = String(text || '');
    if (!raw.trim()) return { predicted: 0, ids: [] };
    let subjects;
    try { subjects = subjectExtractor(raw, { maxTopics: maxTopicsPerTurn, isDelegation }); }
    catch { return { predicted: 0, ids: [] }; }
    const t = now();
    const ids = [];
    if (subjects?.delegation) {
      try {
        const id = ledger.add({
          claim: `owner 交办后，接下来会要求我实测/回报/采纳 ${FOLLOWUP_TOKEN}`,
          p: clamp(Number(followupP) || 0.75, 0.05, 0.95),
          dueAt: t + Math.max(HOUR, Number(followupDueMs) || 12 * HOUR),
          source: 'owner_pred',
          // 步骤5 三方审查改判（修 SERIOUS）：followup 赌的是【owner 的未来言语行为】，不是【Noe 是否完成任务】。
          //   owner 沉默（既不说"回报/采纳"也不说"取消"）是 under-determined（无法判定预测对错），不是"预测落空"——
          //   标 0 不参与决定性判 FAILED，避免"owner 交办后我真做完但 owner 没明说 → 误判 FAILED 污染 Brier + 立假研究目标 + 失真自我认知"。
          //   owner 沉默的 followup 正确归宿是 7 天 sweep 成 NULL（不计分），而非判 FAILED。
          verifiable: 0,
        });
        if (id != null) ids.push(Number(id));
      } catch { /* followup 入账失败不阻断 topic */ }
    }
    for (const subj of (subjects?.topics || [])) {
      if (!subj) continue;
      try {
        const id = ledger.add({
          claim: `owner 接下来还会再提到/谈论「${subj}」${topicToken(subj)}`,
          p: clamp(Number(topicP) || 0.55, 0.05, 0.95),
          dueAt: t + Math.max(HOUR, Number(topicDueMs) || 2 * DAY),
          source: 'owner_pred',
          verifiable: 0, // 步骤5：话题是否再提是弱信号(话题自然转移不算预测落空)，标 0 不参与决定性判 FAILED，降噪
        });
        if (id != null) ids.push(Number(id));
      } catch { /* 单条 topic 入账失败不阻断其余 */ }
    }
    return { predicted: ids.length, ids };
  }

  /**
   * 总入口：每次 owner 交互调一次。先结算旧预测（owner 兑现了吗）→ 再立新预测。
   * 顺序很关键：先结算再预测，避免「本轮刚立的预测被本轮自己命中」的自我应验。
   * @param {{text: string, isDelegation?: boolean|null}} interaction
   * @returns {{resolved: number, predicted: number, resolvedIds: number[], predictedIds: number[]}}
   */
  function observeOwnerInteraction({ text = '', isDelegation = null } = {}) {
    if (!ready()) return { resolved: 0, predicted: 0, resolvedIds: [], predictedIds: [] };
    const settled = settleFromOwnerText(text);
    const predicted = predictFromOwnerText(text, { isDelegation });
    return {
      resolved: settled.resolved,
      predicted: predicted.predicted,
      resolvedIds: settled.ids,
      predictedIds: predicted.ids,
    };
  }

  return { observeOwnerInteraction, settleFromOwnerText, predictFromOwnerText, openOwnerPredictions };
}

// owner 交互文本里「Noe 自己写的 interaction 经历」的标记前缀：这些不是 owner 真说的话，
// 不能当预测来源（否则 Noe 拿自己写的留痕当 owner 行为，自说自话污染账本）。
const SELF_AUTHORED_SUMMARY_RE = /^(?:主人发出显式|我做成了|我刚才离线|我做了|我处理了|Noe )/;

/**
 * owner 交互观察器（最小驱动）：从情景时间线读「owner 真交互」的 interaction 经历（自上次水位线起），
 * 逐条喂 predictor.observeOwnerInteraction（先结算旧预测 → 再立新预测）。水位线存 kv，重启续读。
 *
 * 为什么读 timeline 而非改对话入口：owner 交互已被各对话入口统一记成 type:'interaction' 经历
 * （NoeTurnContextEngine / NoeDelegationExtractor），心跳顺风车读取 = 注入式 + 单 writer + 不碰前台
 * 派发文件 + OFF 时整块不注册零回归。与既有 expectation/harvest 心跳作业同款「作业读 store」哲学。
 *
 * 注：本观察器自身不需要时钟——结算/预测的「现在」由 predictor 内部时钟决定，时序顺序由 ep.ts 排序保证。
 * @param {{
 *   timeline?: {recent: Function}|null,
 *   predictor?: {observeOwnerInteraction: Function}|null,
 *   kv?: {get: Function, set: Function}|null,
 *   watermarkKey?: string,
 *   scanLimit?: number,
 *   maxPerTick?: number,
 *   delegationHint?: (ep: object) => boolean, // 判一条经历是否「交办」（默认看 summary）
 * }} [deps]
 */
export function createOwnerInteractionWatcher({
  timeline = null,
  predictor = null,
  kv = null,
  watermarkKey = 'noe.ownerPrediction.lastTs',
  scanLimit = 30,
  maxPerTick = 8,
  delegationHint = (ep) => /主人交办|帮我|替我|交给你|去办|去做|去查|去跑/.test(String(ep?.summary || '')),
  correctionBridge = null, // 阶段1 P1：owner 否定 Neo 事实判断→harvestSurprise(owner_correction)（NOE_OWNER_CORRECTION，默认 OFF）
} = {}) {
  function readWatermark() {
    try { const v = Number(kv?.get?.(watermarkKey)); return Number.isFinite(v) ? v : 0; } catch { return 0; }
  }
  function writeWatermark(ts) {
    try { kv?.set?.(watermarkKey, Number(ts) || 0); } catch { /* 水位线写失败下跳重读，不阻断 */ }
  }

  /**
   * 一跳：读新 interaction 经历 → 喂 predictor。
   * @returns {{scanned: number, observed: number, predicted: number, resolved: number, skipped: number}}
   */
  function tick() {
    if (!timeline?.recent || !predictor?.observeOwnerInteraction) {
      return { scanned: 0, observed: 0, predicted: 0, resolved: 0, skipped: 0, reason: 'disabled' };
    }
    const since = readWatermark();
    let eps = [];
    try {
      eps = (timeline.recent({ limit: Math.max(1, Math.min(200, scanLimit)), types: ['interaction'] }) || [])
        .filter((e) => e && Number(e.ts) > since)
        .sort((a, b) => Number(a.ts) - Number(b.ts)); // 旧→新，保证结算/预测顺序与真实时序一致
    } catch { eps = []; }
    if (!eps.length) return { scanned: 0, observed: 0, predicted: 0, resolved: 0, skipped: 0 };
    const limit = Math.max(1, Math.min(100, maxPerTick));
    let observed = 0; let predicted = 0; let resolved = 0; let skipped = 0; let maxTs = since;
    for (const ep of eps.slice(0, limit)) {
      const ts = Number(ep.ts) || 0;
      if (ts > maxTs) maxTs = ts;
      const summary = String(ep.summary || '');
      // Noe 自己写的留痕不当 owner 来源（防自说自话）；用经历的 summary 当 owner 文本。
      if (!summary.trim() || SELF_AUTHORED_SUMMARY_RE.test(summary)) {
        // 交办类自留痕（"主人交办我去办…"）是 NoeDelegationExtractor 写的，summary 里含 owner 任务——
        // 仍当一次 owner 行为信号喂入（但去掉前缀），因为它确实代表 owner 真交办了。
        if (/^主人交办/.test(summary)) {
          const r = predictor.observeOwnerInteraction({ text: summary.replace(/^主人交办我去办[:：]?/, ''), isDelegation: true });
          observed += 1; predicted += Number(r?.predicted) || 0; resolved += Number(r?.resolved) || 0;
        } else {
          skipped += 1;
        }
        continue;
      }
      let isDelegation = null;
      try { isDelegation = delegationHint(ep) === true ? true : null; } catch { isDelegation = null; }
      const r = predictor.observeOwnerInteraction({ text: summary, isDelegation });
      observed += 1;
      predicted += Number(r?.predicted) || 0;
      resolved += Number(r?.resolved) || 0;
      // 阶段1 P1：同一条 owner 文本也喂 correctionBridge——含「不对/其实是」等事实纠正→surprise(owner_correction)
      try { correctionBridge?.onOwnerInteraction?.({ text: summary }); } catch { /* 纠正检测失败不阻断 owner 预测 */ }
    }
    if (maxTs > since) writeWatermark(maxTs);
    return { scanned: eps.length, observed, predicted, resolved, skipped };
  }

  return { tick, readWatermark };
}
