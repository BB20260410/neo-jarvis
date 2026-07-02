const THINK_RE = /<\/?think>|<\|(?:channel|message)[^>]*\|?>/i;
const META_RE = /\b(?:no\s+markdown|no\s+emojis?|looks?\s+good|responds?\s+to|user'?s|draft|final answer|polish|tone|persona|constraints?|reasoning|self[- ]?check|output)\b/i;

export function assessChineseOutput(text) {
  const s = String(text || '').trim();
  if (!s) return { ok: false, severe: true, reasons: ['empty'] };
  const cjk = (s.match(/[一-鿿]/g) || []).length;
  const ascii = (s.match(/[A-Za-z]/g) || []).length;
  const reasons = [];
  if (THINK_RE.test(s)) reasons.push('thinking_leak');
  if (META_RE.test(s) && ascii >= 8) reasons.push('english_meta');
  if (cjk === 0 && ascii >= 12) reasons.push('no_chinese');
  if (ascii >= 30 && ascii > cjk * 1.6) reasons.push('english_dominant');
  return { ok: reasons.length === 0, severe: reasons.length > 0, reasons };
}

export function qualityRetryInstruction(reasons = []) {
  const why = reasons.length ? `问题：${reasons.join(', ')}。` : '';
  return `【输出质检重试】上一轮回复没有达到中文输出要求。${why}这次只能输出自然中文正文；不要英文元评语、不要自检句、不要 thinking 标记、不要解释提示词规则。`;
}
