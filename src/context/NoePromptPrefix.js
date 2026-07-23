// NoePromptPrefix — 稳定前缀 / 易变块切分，锁住 prompt 的可缓存前缀以命中 provider 的 prefix cache。
//
// 背景：Anthropic / OpenAI 的 prompt prefix caching 只对「逐字节相同的前缀」命中。一旦 system prompt
//   顶部混入 当前时间 / 日期 / cwd / sessionId / 时间戳 这类每轮都变的内容，整段前缀指纹就变，
//   缓存全失效，长 prompt 每轮重算 → 多烧 30–60% 输入 token。
// 方案：把易变行从稳定正文里剥出来，集中塞进末尾的 <runtime>…</runtime> 块。稳定前缀从此逐轮不变可缓存，
//   易变信息仍在（只是挪到尾部，落在缓存边界之后）。
//
// 纯函数、无 I/O、无副作用，可独立单测。识别规则注入式（patterns / extraPatterns 可覆盖或追加）。
// 接线（把它接进真实 prompt 组装链路）属碰核心，留 owner 决策；本模块只提供可单测的纯能力。

// 默认「易变行」识别规则：命中任一即视为易变。偏好「宁可多剥一点」，调用方可用 patterns 完全替换。
export const DEFAULT_VOLATILE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/,                 // ISO 日期 2026-06-09
  /\b\d{1,2}:\d{2}:\d{2}\b/,               // 时刻 HH:MM:SS（比例/章节几乎不会三段，误伤低）
  /\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i,        // 12 小时制 9:30 PM
  /\b(?:time|clock)\b[^\n]*?\d{1,2}:\d{2}/i, // 「time/clock」标签上下文里的 HH:MM（避免误伤比例 1:30 / 章节 1:15）
  /today'?s? date/i,                       // "Today's date is …"
  /current (date|time)/i,
  /\btimestamp\b/i,
  /session[\s_-]?id/i,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, // UUID
  /\bcwd\b|working directory|current directory/i,
  /\bpid\b\s*[:=]/i,
  /\b1\d{9,12}\b/,                          // 类 unix 时间戳（10–13 位、以 1 开头）
  /\b(uptime|elapsed|now is)\b/i,
];

function isVolatileLine(line, patterns) {
  for (const re of patterns) {
    if (re.test(line)) return true;
  }
  return false;
}

/**
 * 把一段 prompt 切成「稳定前缀」+「易变 <runtime> 块」。
 *
 * @param {string} text 原始 prompt 文本。
 * @param {object} [opts]
 * @param {RegExp[]} [opts.patterns] 完全替换默认识别规则。
 * @param {RegExp[]} [opts.extraPatterns] 在默认规则之外追加。
 * @param {string} [opts.tag] 包裹易变块的标签名（默认 'runtime'）。
 * @returns {{
 *   stablePrefix: string,
 *   runtimeBlock: string,
 *   volatileLines: string[],
 *   combined: string,
 *   stableRatio: number,
 * }}
 */
export function splitStablePrefix(text, opts = {}) {
  const tag = opts.tag || 'runtime';
  const rawPatterns = Array.isArray(opts.patterns)
    ? opts.patterns
    : [...DEFAULT_VOLATILE_PATTERNS, ...(Array.isArray(opts.extraPatterns) ? opts.extraPatterns : [])];
  // 去掉调用方可能传入的 /g 标志：带 g 的正则 .test() 会推进 lastIndex，循环复用同一实例时造成交替漏判。
  const patterns = rawPatterns.map((re) =>
    (re instanceof RegExp && re.global ? new RegExp(re.source, re.flags.replace(/g/g, '')) : re));

  const src = typeof text === 'string' ? text : '';
  if (!src) {
    return { stablePrefix: '', runtimeBlock: '', volatileLines: [], combined: '', stableRatio: 1 };
  }

  const lines = src.split(/\r?\n/);
  const stableLines = [];
  const volatileLines = [];
  for (const line of lines) {
    if (line.trim() && isVolatileLine(line, patterns)) {
      // 保留原行（含缩进），不改 runtime 块内容字面；稳定前缀压缩易变行空洞是设计意图。
      volatileLines.push(line);
    } else {
      stableLines.push(line);
    }
  }

  const totalNonEmpty = lines.filter((l) => l.trim()).length;
  const stableRatio = totalNonEmpty === 0
    ? 1
    : (totalNonEmpty - volatileLines.length) / totalNonEmpty;

  // 无易变行：原样返回，保证前缀逐字节不变（这正是缓存命中的前提）。
  if (volatileLines.length === 0) {
    return { stablePrefix: src, runtimeBlock: '', volatileLines: [], combined: src, stableRatio: 1 };
  }

  const stablePrefix = stableLines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  const runtimeBlock = `<${tag}>\n${volatileLines.join('\n')}\n</${tag}>`;
  const combined = [stablePrefix, runtimeBlock].filter(Boolean).join('\n\n');

  return { stablePrefix, runtimeBlock, volatileLines, combined, stableRatio };
}

/**
 * 主动组装可缓存 prompt：调用方在构造时就把稳定段与易变段分开传入，
 * 比事后用 splitStablePrefix 剥离更可靠（不依赖正则猜测）。
 *
 * @param {string|string[]} stable 稳定段（数组按 \n\n 连接）。
 * @param {string|string[]} volatile 易变段（数组按 \n 连接）。
 * @param {object} [opts]
 * @param {string} [opts.tag] 易变块标签名（默认 'runtime'）。
 * @returns {{ stablePrefix: string, runtimeBlock: string, combined: string }}
 */
export function buildCacheablePrompt(stable, volatile, opts = {}) {
  const tag = opts.tag || 'runtime';
  const stableText = (Array.isArray(stable) ? stable : [stable])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join('\n\n');
  const volatileText = (Array.isArray(volatile) ? volatile : [volatile])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .join('\n');

  const runtimeBlock = volatileText ? `<${tag}>\n${volatileText}\n</${tag}>` : '';
  const combined = [stableText, runtimeBlock].filter(Boolean).join('\n\n');
  return { stablePrefix: stableText, runtimeBlock, combined };
}
