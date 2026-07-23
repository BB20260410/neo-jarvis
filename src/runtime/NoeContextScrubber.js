import { createHash } from 'node:crypto';

const SECRET_PATTERNS = [
  {
    pattern: /(MINIMAX_API_KEY|OBSIDIAN_API_KEY|OPENAI_API_KEY|XIAOMI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY)\s*[:=]\s*["']?[^"'\s]+/gi,
    replacement: '$1=[redacted]',
  },
  {
    pattern: /(Authorization:\s*Bearer\s+)(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: '$1[redacted]',
  },
  {
    pattern: /(X-Panel-Owner-Token["':\s]+)[0-9a-f]{24,}/gi,
    replacement: '$1[redacted]',
  },
  { pattern: /sk-[A-Za-z0-9_-]{20,}/g, replacement: '[redacted-openai-key]' },
  { pattern: /sk_(live|test)_[A-Za-z0-9]{16,}/g, replacement: '[redacted-stripe-key]' },
  { pattern: /AIza[A-Za-z0-9_-]{20,}/g, replacement: '[redacted-google-key]' },
  // tp- 形态含 ._~+=-（2026-07-02 吸收 NoeConsensusLedger 旧模式做全仓单源；不含 / 防误伤路径）
  { pattern: /tp-[A-Za-z0-9._~+=-]{20,}/gi, replacement: '[redacted-api-key]' },
  { pattern: /\?t=[0-9a-f]{24,}/gi, replacement: '?t=[redacted]' },
  // 通用第三方 token 形态(按值匹配,补具名 env key 之外的缺口;已验证对时间戳/版本号/手机号/普通文本零误伤)
  { pattern: /\b[0-9]{6,}:[A-Za-z0-9_-]{30,}\b/g, replacement: '[redacted-telegram-token]' },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, replacement: '[redacted-jwt]' },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replacement: '[redacted-github-token]' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/gi, replacement: '[redacted-slack-token]' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[redacted-aws-key]' },
  { pattern: /(?<![?&])\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API[_-]?KEY))\s*=\s*["']?[^"'\s]{6,}/gi, replacement: '$1=[redacted]' },
  { pattern: /github_pat_[A-Za-z0-9_]{20,}/g, replacement: '[redacted-github-pat]' },
  // P4-3：按敏感 key 名整值抹除——browser/cua 执行器证据里的 cookie jar / DOM 快照 / Set-Cookie 头会以
  //   JSON-key（"cookie":"…"）或冒号（password: …）形态出现，原「值模式 + KEY=value」漏这两类，接执行器前必补。
  // ① JSON-key 形：{"set-cookie":"…"} / {"password":"…"} / {"token":"…"} → 抹值留 key。
  // （不含 authorization：既有 `Authorization: Bearer` 专模式 + `KEY=value` 模式已正确处理，避免二次抹掉 "Bearer"）
  {
    pattern: /("(?:set-)?cookie"|"password"|"passwd"|"secret"|"credential"|"api[_-]?key"|"session(?:[_-]?token)?"|"refresh[_-]?token"|"access[_-]?token"|"otp"|"private[_-]?key")(\s*:\s*)"[^"]*"/gi,
    replacement: '$1$2"[redacted]"',
  },
  // ② 冒号形（DOM 文本 / HTTP 头，非 = 号）：Set-Cookie: … / password: … → 抹值留 key。
  {
    pattern: /\b(set-cookie|cookie|password|passwd|credential|api[_-]?key|session[_-]?token|refresh[_-]?token|access[_-]?token)(\s*:\s*)(?!\[redacted)[^\s,;}"']{4,}/gi,
    replacement: '$1$2[redacted]',
  },
];

const HIDDEN_BLOCKS = [
  ['memory-context', /<memory-context\b[^>]*>[\s\S]*?<\/memory-context>/gi],
  ['noe-hidden-context', /<noe-hidden-context\b[^>]*>[\s\S]*?<\/noe-hidden-context>/gi],
  ['context-pack', /<context-pack\b[^>]*>[\s\S]*?<\/context-pack>/gi],
  ['system-context', /<system-context\b[^>]*>[\s\S]*?<\/system-context>/gi],
  ['think', /<think\b[^>]*>[\s\S]*?<\/think>/gi],
];

function cleanString(value) {
  return String(value || '');
}

function sha1(value) {
  return createHash('sha1').update(cleanString(value), 'utf8').digest('hex');
}

export function redactSensitiveText(value = '') {
  let text = cleanString(value);
  for (const rule of SECRET_PATTERNS) text = text.replace(rule.pattern, rule.replacement);
  return text;
}

// 只判断「文本是否含 secret-like 内容」而不改写——给落盘前守门用（如 local council ledger）。
//   与 redactSensitiveText 共用同一份 SECRET_PATTERNS（全仓单源，2026-07-02 P0 单源化）。
export function textContainsSecretLike(value = '') {
  const text = cleanString(value);
  return SECRET_PATTERNS.some(({ pattern }) => new RegExp(pattern.source, pattern.flags.replace(/g/g, '')).test(text));
}

// 提取文本中所有 secret-like 片段的原始匹配值集合。仅供内存比对「补丁是否引入了原本没有的新 secret」，
//   调用方不得把返回值落盘/回显/入日志（值是明文 secret）。比计数差稳：能挡「删旧+加新」net 持平对冲。
export function extractSecretLikeValues(value = '') {
  const text = cleanString(value);
  const found = new Set();
  for (const rule of SECRET_PATTERNS) {
    const matches = text.match(rule.pattern);
    if (matches) for (const m of matches) found.add(m);
  }
  return found;
}

export function stripHiddenContextBlocks(value = '') {
  let text = cleanString(value);
  const stripped = [];
  for (const [kind, pattern] of HIDDEN_BLOCKS) {
    text = text.replace(pattern, (match) => {
      stripped.push({ kind, sha1: sha1(match), length: match.length });
      return '';
    });
  }
  return { text, stripped };
}

export function stripInternalChannels(value = '') {
  let text = cleanString(value).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
  const stripped = [];
  text = text.replace(/<\|channel\>\s*(thought|analysis|reasoning)\b[\s\S]*?(?=<\|channel\>\s*(final|answer)\b|$)/gi, (match, channel) => {
    stripped.push({ kind: `channel:${String(channel || '').toLowerCase()}`, sha1: sha1(match), length: match.length });
    return '';
  });
  text = text.replace(/<\|channel\>\s*(final|answer)\b/gi, '');
  text = text.replace(/^\s*(analysis|reasoning|thought)\s*:\s*/gim, '');
  return { text, stripped };
}

export function cleanVisibleModelText(value = '') {
  const hidden = stripHiddenContextBlocks(value);
  const channels = stripInternalChannels(hidden.text);
  return {
    text: redactSensitiveText(channels.text).trim(),
    stripped: [...hidden.stripped, ...channels.stripped],
  };
}

export class StreamingContextScrubber {
  constructor({ maxBuffered = 32_768 } = {}) {
    this.maxBuffered = Math.max(1024, Number(maxBuffered) || 32_768);
    this.buffer = '';
    this.stripped = [];
    this.discarding = null;
  }

  push(chunk = '') {
    this.buffer += cleanString(chunk);
    if (this.buffer.length > this.maxBuffered) this.buffer = this.buffer.slice(-this.maxBuffered);
    return '';
  }

  finish() {
    const { text, stripped } = cleanVisibleModelText(this.buffer);
    this.stripped.push(...stripped);
    this.buffer = '';
    return { text, stripped: [...this.stripped] };
  }
}
