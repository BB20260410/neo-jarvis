// @ts-check
// VoiceStreamEarlyTts — LLM 流式早鸟首句探测器（方向三·语音延迟终局：首声再提前 1-2 秒）。
//
// 现状（C9）：整段大脑生成完 → 才合成首句 TTS → 续播。首声 = 全文生成时间 + 首句合成时间。
// 本模块：大脑边吐字边喂 push()，首句一成形立即返回——调用方并行启动 TTS，与剩余生成重叠；
//   本地大脑 5-15s 出全文、MiniMax TTS 1-2s，重叠后合成时间被完全藏进生成时间 ⇒ 首声提前 1-2s。
// 安全设计（不冒说错话的险）：
//   - 句界/长度/占比判据与 VoiceSession.splitFirstSentence 同口径——早鸟句必须与最终
//     splitFirstSentence(整段).first 逐字一致才会被采用（对账在 VoiceSession 收尾处），
//     质检重试/复读重试换了答案就丢早鸟音频走旧路，最多浪费一次 TTS 调用，绝不放错音频。
//   - 流里出现 reasoning 泄漏标记（<think / harmony <|channel）→ 永久放弃早鸟（这类输出
//     要靠整段 sanitize 清洗，前缀不可信）。
//   - sanitize 注入式：调用方传入与整段管线同一个清洗函数，保证前缀口径一致。

const REASONING_LEAK_RE = /<think|<\|channel|<\|message/i;
const SENTENCE_BOUNDARY_RE = /[。！？!?…；;\n]/g;

/**
 * @param {object} [opts]
 * @param {(s: string) => string} [opts.sanitize] 与整段管线同款的输出清洗函数（默认原样返回）
 * @param {number} [opts.minTotal] 已清洗前缀至少多长才考虑切句（与 splitFirstSentence 的 40 同口径）
 * @param {number} [opts.minCut] 首句最短长度（防"嗯。"碎句开播，同口径 6）
 * @param {number} [opts.maxRatio] 首句占比上限（同口径 0.7；前缀只会更短于全文，满足即全文必满足）
 * @returns {{push: (chunk: string) => string|null, sentence: () => string|null}}
 *   push 喂增量文本；首句首次成形时返回该句（之后恒返 null）；sentence() 查询已成形句。
 */
export function createEarlySentenceDetector({ sanitize = (s) => String(s || ''), minTotal = 40, minCut = 6, maxRatio = 0.7 } = {}) {
  let raw = '';
  let dead = false;
  let fired = null;
  return {
    push(chunk) {
      if (dead || fired) return null;
      raw += String(chunk || '');
      if (REASONING_LEAK_RE.test(raw)) { dead = true; return null; }
      const clean = sanitize(raw);
      if (clean.length < minTotal) return null;
      SENTENCE_BOUNDARY_RE.lastIndex = 0;
      let m;
      let cut = -1;
      while ((m = SENTENCE_BOUNDARY_RE.exec(clean))) {
        const pos = m.index + 1;
        if (pos >= minCut) { cut = pos; break; }
      }
      if (cut < 0) return null;
      // 保证 cut ≤ maxRatio×当前前缀长 ⇒ 全文只会更长，最终 splitFirstSentence 的 70% 判据必然也过
      if (cut > clean.length * maxRatio) return null;
      const first = clean.slice(0, cut).trim();
      const rest = clean.slice(cut).trim();
      if (!first || !rest) return null;
      fired = first;
      return first;
    },
    sentence() { return fired; },
  };
}
