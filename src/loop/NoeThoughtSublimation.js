// @ts-check
// NoeThoughtSublimation — 反刍念头升华成主动行为/牵挂（内在世界·支柱③+⑥，同一升华模块的两个出口）。
//
// InnerMonologue 的既定克制原则：念头只写回时间线，「不直接说给 owner，偶尔才由别的机制升华成
// 主动行为/记忆」（InnerMonologue.js 头注释）——本模块就是那个"别的机制"。
// 从反刍 thought 文本里用确定性正则识别两类值得升华的念头（形态参考 NoeCommitmentExtractor 的
// SELF_PROMISE_PATTERNS + 置信度门槛；LLM 判定留注入位默认 null）：
//   ① 想说/该提醒（"想跟主人说… / 该提醒主人…"）→ 升华成"要说的话"（支柱③）
//   ② 牵挂（"不知道主人…怎么样了 / 主人还没…"）→ 升华成"持续牵挂"（支柱⑥）
// 两个出口走同一条既有通道，不造新说话口：commitmentStore.add(category:'open_loop',
// sensitivity:'care') —— 入店即出现在 self-state「牵挂着」（NoeSelfModel #commitments 零额外接线）；
// 到点后由 proactiveTick 既有 due 通道在冷却允许时自然说出口（复用既有克制与收口）。
//
// 克制（防唠叨，与 InnerMonologue 防反刍螺旋同源）：
//   - 置信度门槛防误判；否定句（"不用提醒主人"）直接不升华
//   - dedupeKey 防同一念头反复入店（复用 commitmentDedupeKey 归一）
//   - 自生 open 承诺上限默认 2 条（text 前缀 SELF_MARK 可识别；store.add 只收
//     text/category/sensitivity/dueWindow 无 meta 位，故用前缀标记，不改 store schema）
//   - dueWindow 给保守延迟（想说 30min / 牵挂 2h 后才可被提起；latest 走 store 默认 24h 兜底窗）
// 注入式全可 fake；store 缺失/抛错 fail-open 静默跳过，绝不影响反刍主流程；不设任何模型超时。
// env 门控（NOE_INNER_SPEAK=1 默认 OFF）在 server.js 装配点，本模块不读 env。

import { commitmentDedupeKey } from '../runtime/NoeCommitmentExtractor.js';

/** 自生承诺的可识别 text 前缀标记（与 NoeCommitmentExtractor 的「Noe 承诺：」同款约定）。 */
export const SELF_MARK = 'Noe 心声：';

// [正则, 置信度]——只匹配明确指向 owner 的念头；置信度形态参考 SELF_PROMISE_PATTERNS。
/** @type {Array<[RegExp, number]>} 出口①：想说/该提醒。 */
const SPEAK_PATTERNS = [
  [/想(?:跟|和|对)主人(?:说|聊|提|讲)/, 0.85],
  [/(?:该|得|要|应该)(?:找个?时候|找机会)?提醒主人/, 0.85],
  [/(?:记得|别忘了?)(?:跟|和|对)主人(?:说|提)/, 0.8],
];
/** @type {Array<[RegExp, number]>} 出口②：牵挂。 */
const CARE_PATTERNS = [
  [/不知道主人[^，。！？!?\n]{0,30}(?:怎么样|如何|好不好|顺不顺利|了没)/, 0.85],
  [/主人(?:还没|怎么还没|好久没|很久没)[^，。！？!?\n]{1,30}/, 0.75],
  [/(?:惦记|挂念|担心)(?:着)?主人/, 0.8],
];

// 否定/打消念头不升华（"不用提醒主人""先不打扰主人"——念头自己已经决定不说）。
const NEGATION_RE = /(?:不用|不必|没必要|先不|不想|别去?)(?:急着|马上|现在)?(?:提醒|打扰|惦记|担心)?主人/;

/**
 * 确定性判定：念头是否值得升华、属于哪个出口（纯函数零额度，LLM 升级位留 createThoughtSublimation 注入）。
 * @param {string} thought 反刍念头文本
 * @returns {{kind:'speak'|'care', confidence:number}|null}
 */
export function classifyThought(thought) {
  const text = String(thought || '');
  if (!text || NEGATION_RE.test(text)) return null;
  for (const [re, confidence] of SPEAK_PATTERNS) {
    if (re.test(text)) return { kind: 'speak', confidence };
  }
  for (const [re, confidence] of CARE_PATTERNS) {
    if (re.test(text)) return { kind: 'care', confidence };
  }
  return null;
}

/** 校验（LLM 等外部）判定结果形状；非法返 null（防幻觉判定污染入店）。 */
function normalizeVerdict(raw) {
  const kind = raw && typeof raw === 'object' ? raw.kind : null;
  const confidence = raw && typeof raw === 'object' ? raw.confidence : null;
  if (kind !== 'speak' && kind !== 'care') return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { kind, confidence };
}

/**
 * 建升华器：sublimate(thought) → 判定命中且不重复、未超自生上限 → commitmentStore.add。
 * @param {object} [deps]
 * @param {{add:Function, list:Function}|null} [deps.commitmentStore] NoeCommitmentStore（缺失则 fail-open 零调用）
 * @param {(thought:string)=>({kind:'speak'|'care',confidence:number}|null)} [deps.classify] 判定函数（默认确定性正则）
 * @param {((thought:string)=>Promise<object|null>)|null} [deps.llmClassify] LLM 判定注入位（默认 null 纯确定性；
 *   仅在确定性未命中后兜底调用，不设超时——跑模型纪律；抛错/形状非法按未命中处理）
 * @param {number} [deps.minConfidence] 置信度门槛
 * @param {number} [deps.maxSelfOpen] 自生 open 承诺上限（防唠叨）
 * @param {number} [deps.speakDelayMs] 出口①最早可提起延迟（保守打扰预算，owner 可调）
 * @param {number} [deps.careDelayMs] 出口②最早可提起延迟
 * @param {() => number} [deps.now] 注入时钟
 * @returns {(thought:string)=>Promise<{sublimated:boolean, kind?:string, commitmentId?:string|null, reason?:string}>}
 */
export function createThoughtSublimation({
  commitmentStore = null,
  classify = classifyThought,
  llmClassify = null,
  minConfidence = 0.7,
  maxSelfOpen = 2,
  speakDelayMs = 30 * 60000,
  careDelayMs = 2 * 3600000,
  now = () => Date.now(),
} = {}) {
  return async function sublimate(thought) {
    const text = String(thought || '').trim();
    if (!text) return { sublimated: false, reason: 'empty' };
    // dedupe 与上限都依赖 list——add/list 任一缺失即 fail-open 零调用（绝不盲入库）
    if (typeof commitmentStore?.add !== 'function' || typeof commitmentStore?.list !== 'function') {
      return { sublimated: false, reason: 'no_store' };
    }

    let verdict = null;
    try { verdict = normalizeVerdict(classify(text)); } catch { verdict = null; }
    if (!verdict && typeof llmClassify === 'function') {
      try { verdict = normalizeVerdict(await llmClassify(text)); } catch { verdict = null; }
    }
    if (!verdict || verdict.confidence < minConfidence) return { sublimated: false, reason: 'no_match' };

    const fullText = `${SELF_MARK}${text.slice(0, 200)}`;
    try {
      const open = commitmentStore.list({ status: 'open' }) || [];
      // dedupe：同一念头（归一后）已在店里 → 跳过（防反刍同题反复入库）
      const key = commitmentDedupeKey(fullText);
      if (open.some((c) => commitmentDedupeKey(c?.text) === key)) return { sublimated: false, reason: 'duplicate' };
      // 自生上限：只数 SELF_MARK 前缀的自生项，不挤占用户/回复抽取来源的承诺
      const selfOpenCount = open.filter((c) => typeof c?.text === 'string' && c.text.startsWith(SELF_MARK)).length;
      if (selfOpenCount >= maxSelfOpen) return { sublimated: false, reason: 'cap' };

      const delay = verdict.kind === 'speak' ? speakDelayMs : careDelayMs;
      const rec = commitmentStore.add({
        text: fullText,
        category: 'open_loop',
        sensitivity: 'care',
        // latest 不给：走 store 默认 earliest+24h 兜底窗（错过一次心跳仍会提，不漏）
        dueWindow: { earliestMs: now() + delay },
      });
      return { sublimated: true, kind: verdict.kind, commitmentId: rec?.id ?? null };
    } catch {
      // fail-open：升华失败（store 落盘/list 抛错等）静默跳过，绝不影响反刍主流程
      return { sublimated: false, reason: 'store_error' };
    }
  };
}
