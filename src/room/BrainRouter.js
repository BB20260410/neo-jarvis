// BrainRouter — 多模型「大脑/手脚」分工路由（用户定制分工 + 省 token 核心）
//
//   local 闲聊/苦力（摘要/分类/格式化/翻译/陪聊）→ 本地 ollama 优先 → LM Studio 自动 fallback，零成本
//   mid   一般问答/中文写作               → MiniMax（已订阅）
//   code  写代码/工具/技术执行/重构/debug/真实操作 → Codex (GPT)
//   deep  深推理/规划/架构/拍板/审查/长文/复盘  → Claude
//
// 纯启发式分类（关键词正则 + 长度），零延迟。local 免配额；mid/code/deep 标 paid。
// 本地档返回 fallbacks 备用链（ollama→lmstudio），由调用方在主 adapter 失败时依次重试。
//
// 可扩展（2026-06-14 重构，默认行为逐字不变）：
//   分类「策略」此前写死在 route() 的 if-else 链里——加新档/调规则要改核心函数。
//   现把「信号探针 signalProbes」「有序判定规则 rules」「付费档 paidTiers」抽成可注入实现：
//   - signalProbes：{ key → (ctx)=>命中明细 }，结果挂进 result.signals，供 rules.match 与调用方读。
//   - rules：有序数组 [{ tier, reason, match(ctx), useFallbackChain }]，自上而下第一条命中即生效；
//     最后一条必须无条件命中（默认兜底）。match 收到 { text, requiresExec, signals, map, fallbacks }。
//   - 默认 signalProbes/rules/paidTiers 与历史 route() 完全等价，注入即可加新档，无需改本文件。

// 写代码 / 工具 / 技术执行 / 真实操作 → Codex（GPT 有手，最终执行权）
const CODE_PATTERNS = [
  /\b(shell|bash|zsh|cmd|powershell|terminal)\b/i,
  /\b(file\.(read|write|delete|move)|apply_patch|patch\.apply|tool_calls?)\b/i,
  /\b(rm\s+-rf|unlink|chmod|chown|kill\s+-9|git\s+(push|commit|merge)|npm\s+(publish|install)|deploy)\b/i,
  /写代码|实现.*(功能|接口|模块|方法)|重构|refactor|coding|debug|调试|修.*bug|fix.*bug|算法|algorithm|跑.*脚本|执行命令|运行命令|读文件|写文件|删除文件|移动文件|真实执行|外发|上传|发布|部署/i,
  /python|javascript|typescript|golang|\brust\b|写.{0,4}(脚本|程序|代码|函数|爬虫|插件|工具|命令行)|批量(改|处理|重命名|删除|移动|下载|转换)|改文件名|文件重命名|自动化(脚本|处理|任务)/i,
];
// 深度推理 / 规划 / 架构 / 拍板 / 审查 / 长文 → Claude
const DEEP_PATTERNS = [
  /深入分析|deep.?dive|论证|权衡|trade.?off|对比.*方案|利弊|为什么.*而不是/i,
  /架构设计|技术方案|technical.?design|规划|roadmap|策略|路线图|决策|拍板|定夺/i,
  /审查|review|审计|audit|复盘|retrospective|评估|长文|总结报告|深度.*(分析|思考|推理)|复杂.*(规划|推理|分析)/i,
];
// 琐碎 / 苦力 / 闲聊 / 情感陪伴 → 本地 abliterated（无审查·秒回·免费）
const TRIVIAL_PATTERNS = [
  /^(你好|hi|hello|嗨|在吗|在不在|谢谢|多谢|嗯+|好的|ok|okay|收到|哈喽|早|晚安)/i,
  /摘要|总结|概括|summar|分类|classif|归类|格式化|format|提取.*关键|关键词|extract|纠错|剥.*markdown|闲聊|陪.*聊|安慰|鼓励/i,
  /复述|重复一遍|确认一下|是不是|对吗|对不对/,
  /好累|累了|很累|有点累|困了|烦死|郁闷|无聊|难过|不开心|开心|想你|陪我|抱抱|心情|怎么样|聊聊|聊天/,
];
// 中文创作 / 写作 / 润色 / 翻译 → MiniMax M3（中文笔力强；区别于上面的纯苦力小任务）
const MID_PATTERNS = [
  /写.{0,8}(文案|文章|故事|小说|诗歌?|散文|随笔|游记|邮件|私信|文档|稿子?|演讲稿?|公众号|推文|朋友圈|短信|祝福|标语|slogan|歌词|剧本|台词)/,
  /创作|撰写|起草|润色|改写|扩写|续写|仿写|翻译|帮我(写|翻|润)|中文写作|文笔|写一段|写个故事/,
];

// owner 2026-06-17：取消本地 abliterated，local 档(闲聊/情感/苦力/默认)改 MiniMax-M2.7-highspeed（秒回·已订阅，
//   owner 授权 aux 配额尽管烧）；research/reasoning 走 deep(claude)不在 local 档不受影响。fallback 退 lmstudio 本地兜底。
const DEFAULT_TIER_MAP = Object.freeze({ local: 'minimax-highspeed', mid: 'minimax', code: 'codex', deep: 'claude' });
const DEFAULT_PAID_TIERS = Object.freeze(['local', 'mid', 'code', 'deep']); // local 改走 MiniMax（已订阅·非按量烧）

function hits(patterns, t) { return patterns.filter((p) => p.test(t)).map((p) => p.source); }

// 默认信号探针：键名/产出与历史 route() 内联计算逐字一致（codeHits/deepHits/trivialHits/midHits）。
// 注入 signalProbes 可新增/覆盖探针，结果统一挂进 result.signals。
export const DEFAULT_SIGNAL_PROBES = Object.freeze({
  codeHits: (ctx) => hits(CODE_PATTERNS, ctx.text),
  deepHits: (ctx) => hits(DEEP_PATTERNS, ctx.text),
  trivialHits: (ctx) => hits(TRIVIAL_PATTERNS, ctx.text),
  midHits: (ctx) => hits(MID_PATTERNS, ctx.text),
});

// 默认有序判定规则：自上而下第一条 match 命中即生效，最后一条无条件命中（默认兜底）。
// 顺序/理由/档位/fallback 用法与历史 route() 的 if-else 链完全等价：
//   code(requiresExec||codeHits) → deep → local(trivial) → mid → local(默认)。
export const DEFAULT_BRAIN_ROUTER_RULES = Object.freeze([
  Object.freeze({
    tier: 'code',
    reason: '写代码/工具/技术执行/真实操作 → Codex',
    match: (ctx) => ctx.requiresExec || ctx.signals.codeHits.length > 0,
  }),
  Object.freeze({
    tier: 'deep',
    reason: '深度推理/规划/架构/拍板/审查/长文 → Claude',
    match: (ctx) => ctx.signals.deepHits.length > 0,
  }),
  Object.freeze({
    tier: 'local',
    reason: '闲聊/情感/苦力 → 本地 abliterated（无审查·秒回·免费，ollama 优先 LM Studio 备用）',
    match: (ctx) => ctx.signals.trivialHits.length > 0,
    useFallbackChain: true, // 仅本地档带 fallback 链
  }),
  Object.freeze({
    tier: 'mid',
    reason: '中文创作/写作/润色/翻译 → MiniMax M3',
    match: (ctx) => ctx.signals.midHits.length > 0,
  }),
  Object.freeze({
    tier: 'local',
    reason: '默认/拿不准 → 本地 abliterated（无审查·秒回·免费），不擅自上云烧配额',
    match: () => true,
    useFallbackChain: true,
  }),
]);

/**
 * @param {object} opts
 * @param {object} [opts.tierMap] {local,mid,code,deep} → adapterId
 * @param {string[]} [opts.localFallbacks] 本地备用链（如 ['lmstudio']），ollama 失败时依次试
 * @param {(id:string)=>boolean} [opts.hasAdapter]
 * @param {Array<{tier:string,reason:string,match:(ctx:object)=>boolean,useFallbackChain?:boolean}>} [opts.rules]
 *   有序判定规则（默认 DEFAULT_BRAIN_ROUTER_RULES）；自上而下第一条 match 命中即生效，
 *   最后一条应无条件命中作兜底。加新档/改规则注入此处，无需改 route() 本体。
 * @param {Record<string,(ctx:object)=>any>} [opts.signalProbes] 信号探针（默认 DEFAULT_SIGNAL_PROBES）；
 *   产出挂进 result.signals，供 rule.match 与调用方读。
 * @param {string[]} [opts.paidTiers] 标记为付费的档位（默认 ['mid','code','deep']）。
 */
export function createBrainRouter({
  tierMap = {},
  localFallbacks = [],
  hasAdapter = () => true,
  rules = DEFAULT_BRAIN_ROUTER_RULES,
  signalProbes = DEFAULT_SIGNAL_PROBES,
  paidTiers = DEFAULT_PAID_TIERS,
} = {}) {
  const map = { ...DEFAULT_TIER_MAP, ...tierMap };
  const fallbacks = (Array.isArray(localFallbacks) ? localFallbacks : []).filter(Boolean);
  const ruleList = (Array.isArray(rules) && rules.length ? rules : DEFAULT_BRAIN_ROUTER_RULES);
  const probes = signalProbes && typeof signalProbes === 'object' ? signalProbes : DEFAULT_SIGNAL_PROBES;
  const paid = new Set(Array.isArray(paidTiers) ? paidTiers : DEFAULT_PAID_TIERS); // local 本地免配额

  // 返回第一个在池中的候选 + 剩余备用链；都不在池则返回 primary（让端点报不可用）
  function pick(primary, chain = []) {
    const candidates = [primary, ...chain];
    const available = candidates.filter((id) => hasAdapter(id));
    const head = available[0] || primary;
    return { adapterId: head, fallbacks: available.slice(1), downgraded: head !== primary };
  }

  return {
    route(input = {}) {
      const t = String(input.text ?? input.query ?? input.content ?? '').trim();
      const requiresExec = Boolean(input.requiresTools || input.requiresShell || input.requiresFileSystem);
      const probeCtx = { text: t, requiresExec, input };
      const signals = { length: t.length, requiresExec };
      for (const [key, probe] of Object.entries(probes)) {
        signals[key] = typeof probe === 'function' ? probe(probeCtx) : probe;
      }

      const ctx = { text: t, requiresExec, signals, map, fallbacks, input };
      // 自上而下第一条命中；兜底由最后一条 match:()=>true 保证，理论上不会落空。
      let matched = ruleList.find((rule) => {
        try { return typeof rule?.match === 'function' && rule.match(ctx); } catch { return false; }
      }) || ruleList[ruleList.length - 1] || DEFAULT_BRAIN_ROUTER_RULES[DEFAULT_BRAIN_ROUTER_RULES.length - 1];

      const tier = matched.tier;
      const reason = matched.reason;
      const primary = map[tier] ?? tier;
      const picked = matched.useFallbackChain ? pick(primary, fallbacks) : pick(primary);

      return {
        tier,
        adapterId: picked.adapterId,
        fallbacks: picked.fallbacks,
        paid: paid.has(tier),
        downgraded: picked.downgraded,
        reason,
        signals,
        tierMap: map,
      };
    },
  };
}
