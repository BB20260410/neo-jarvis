// @ts-check
// TTS 文本归一化：剥 markdown / emoji / 折叠空白，让任何 TTS 引擎都不念出符号。
//
// 背景（吸收自 asgeirtj/system_prompts_leaks 的 Sesame/语音陪伴「只输出口语词、无 emoji/无旁白」模式）：
// 原 MiniMaxTtsClient.cleanText 只在 MiniMax 主音色内部生效；VoiceSession._synthesize 的回退链
// （Kokoro/CosyVoice/Gateway 兜底引擎）直接拿 reply 原文，会念出 emoji/markdown 符号——真实 bug。
// 抽成共享纯函数，由 _synthesize 在回退链入口统一过一次，所有引擎都干净。
//
// 纯函数、fail-open：异常时回退原文（宁可念点符号也绝不让合成哑掉/抛错阻断回复）。

/**
 * 把回复文本归一化成「适合任何 TTS 引擎念」的纯口语文本：
 * 剥 markdown 符号(* # ` _ ~ >)、markdown 链接([文字](url)→文字)、emoji，折叠空白。
 * 保留中文标点（承载句读节奏）。
 * @param {string} text
 * @returns {string} 归一化文本；输入异常时 fail-open 回退原始字符串
 */
export function normalizeTtsText(text) {
  const raw = String(text ?? '');
  try {
    return raw
      .replace(/[*#`_~>]/g, '')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      // FE0F(变体选择符)/200D(ZWJ) 是组合用字符，alternation 写法避免 no-misleading-character-class
      .replace(/(?:[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]|\uFE0F|\u200D)/gu, '')
      .replace(/\s+/g, ' ')
      .trim();
  } catch {
    return raw.trim();
  }
}
