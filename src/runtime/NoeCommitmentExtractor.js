// NoeCommitmentExtractor — T7 承诺抽取流水线（E 类/波次6 接线）。
//
// 治「说过就忘」：Noe 回复里说了「我会X / 回头帮你X / 稍后X」却没有任何系统记下 → 永远不会真做。
// 本模块从 **Noe 自己的回复** 抽自我承诺喂 NoeCommitmentStore（到点 proactiveTick 主动提起）。
// 注意边界：用户显式的「提醒我X」由 NoeActionBridge(detectAction) 真执行建提醒——那是用户指令通道；
//   这里只管 Noe 的自我承诺，二者分工不重叠（防双写）。
// 确定性正则、零额度、置信度门槛防幻觉、text 归一 dedupe 防重复入库；LLM 升级位留 extract 注入。

const SELF_PROMISE_PATTERNS = [
  // [正则, 置信度]——只匹配第一人称自我承诺；句末截断到标点
  [/我(?:会|将)(?:帮你|给你|为你)?([^，。！？!?\n]{2,60})/, 0.85],
  [/我(?:答应|保证)(?:你)?([^，。！？!?\n]{2,60})/, 0.9],
  [/(?:回头|稍后|晚点|等会儿?|一会儿?)我?(?:再)?(?:帮你|给你)?([^，。！？!?\n]{2,60})/, 0.75],
];

const NEGATION_RE = /我(?:不会|没法|无法|不能|做不到)/;

/** 归一 dedupe key：去空白/标点差异。 */
export function commitmentDedupeKey(text) {
  return String(text || '').replace(/[\s，。！？!?、,.]/g, '').toLowerCase();
}

/**
 * 从 Noe 回复文本抽自我承诺（确定性，不调 LLM）。
 * @returns {Array<{text:string, confidence:number, dueWindow:{earliestMs:number,latestMs:number}}>}
 */
export function extractCommitments(replyText, { now = Date.now() } = {}) {
  const text = String(replyText || '');
  if (!text || NEGATION_RE.test(text)) return [];
  const out = [];
  const seen = new Set();
  for (const [re, confidence] of SELF_PROMISE_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const body = m[1].trim();
    if (body.length < 2) continue;
    const full = `Noe 承诺：${m[0].trim()}`;
    const key = commitmentDedupeKey(full);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      text: full,
      confidence,
      // 给 Noe 10 分钟先自己做完；24h 窗兜底（错过窗 CommitmentStore.due 仍会提，不漏）
      dueWindow: { earliestMs: now + 10 * 60000, latestMs: now + 24 * 3600000 },
    });
  }
  return out;
}

/**
 * 建抽取钩子：ingest(replyText) → 过置信度门槛 → 对 store 现有 open 项去重 → add。
 * @param {object} deps { store(NoeCommitmentStore), extract, minConfidence=0.7, maxPerReply=2, now }
 */
export function createCommitmentExtractionHook({ store, extract = extractCommitments, minConfidence = 0.7, maxPerReply = 2, now = () => Date.now() } = {}) {
  if (!store?.add) throw new TypeError('createCommitmentExtractionHook 需要 NoeCommitmentStore');
  return function ingest(replyText) {
    const found = extract(String(replyText || ''), { now: now() })
      .filter((c) => c.confidence >= minConfidence)
      .slice(0, maxPerReply);
    if (!found.length) return { added: 0, skipped: 0 };
    const existing = new Set((typeof store.list === 'function' ? store.list({ status: 'open' }) : []).map((c) => commitmentDedupeKey(c.text)));
    let added = 0;
    let skipped = 0;
    for (const c of found) {
      const key = commitmentDedupeKey(c.text);
      if (existing.has(key)) { skipped += 1; continue; }
      try {
        store.add({ text: c.text, category: 'reminder', dueWindow: c.dueWindow });
        existing.add(key);
        added += 1;
      } catch { skipped += 1; }
    }
    return { added, skipped };
  };
}
