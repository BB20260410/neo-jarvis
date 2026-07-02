// @ts-check
// Robust JSON extraction for local-model replies.
// Handles <think> blocks, markdown fences, prose before/after JSON, and multiple
// balanced JSON spans without returning raw secret-bearing text.

function text(value = '') {
  return String(value || '');
}

export function stripNoeLlmThinking(value = '') {
  return text(value)
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .trim();
}

function fencedBlocks(value = '') {
  const out = [];
  const re = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(value))) {
    const block = text(m[1]).trim();
    if (block) out.push({ source: 'fenced', text: block });
  }
  return out;
}

function balancedJsonSpans(value = '') {
  const s = text(value);
  const out = [];
  for (let start = 0; start < s.length; start += 1) {
    if (s[start] !== '{' && s[start] !== '[') continue;
    const stack = [];
    let inString = false;
    let escaped = false;
    for (let i = start; i < s.length; i += 1) {
      const ch = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        if (stack.length) inString = true;
        continue;
      }
      if (ch === '{' || ch === '[') {
        stack.push(ch);
        continue;
      }
      if (ch !== '}' && ch !== ']') continue;
      if (!stack.length) break;
      const open = stack.at(-1);
      if ((open === '{' && ch !== '}') || (open === '[' && ch !== ']')) break;
      stack.pop();
      if (!stack.length) {
        out.push({ source: 'balanced', text: s.slice(start, i + 1) });
        break;
      }
    }
  }
  return out;
}

// BAML SAP（借 schema-aligned parsing 理念）：parse 失败时做最安全高频的确定性修补——删尾随逗号
// （LLM 最常见 JSON 错误，如 {"a":1,} / [1,2,]）。不做单引号→双引号/补引号/类型强转/字段别名
// （有误改字符串内容、过度纠正掩盖真失败的风险，裁决明确警告）。修补后必须 JSON.parse 成功才返回，
// 否则显式落 null——绝不静默兜造数据（合「不伪造结果」纪律）。
function repairTrailingCommas(s) {
  return text(s).replace(/,(\s*[}\]])/g, '$1');
}

function parseCandidate(candidate, repair = false) {
  try {
    return { ok: true, value: JSON.parse(candidate.text), source: candidate.source };
  } catch {
    if (repair) {
      const fixed = repairTrailingCommas(candidate.text);
      if (fixed !== candidate.text) {
        try { return { ok: true, value: JSON.parse(fixed), source: `${candidate.source}_repaired` }; }
        catch { /* 修补后仍解析失败 → 落 null，不兜造 */ }
      }
    }
    return null;
  }
}

export function parseNoeLlmJson(value = '', { repair = process.env.NOE_SAP_REPAIR === '1' } = {}) {
  const cleaned = stripNoeLlmThinking(value);
  const candidates = [
    { source: 'full', text: cleaned },
    ...fencedBlocks(cleaned),
    ...balancedJsonSpans(cleaned),
  ].filter((item) => item.text);
  const seen = new Set();
  const unique = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.text)) continue;
    seen.add(candidate.text);
    unique.push(candidate);
  }
  // 第一轮：原样解析（最可信，无修补）——OFF 时只走这轮，行为与原逐字一致（零回归）。
  for (const candidate of unique) {
    const parsed = parseCandidate(candidate, false);
    if (parsed) return parsed;
  }
  // 第二轮：env NOE_SAP_REPAIR ON 时，确定性修补（删尾逗号）后再解析（兜底，默认 OFF）。
  if (repair) {
    for (const candidate of unique) {
      const parsed = parseCandidate(candidate, true);
      if (parsed) return parsed;
    }
  }
  return { ok: false, value: null, source: '', error: 'json_parse_failed' };
}

export function parseNoeLlmJsonValue(value = '', fallback = null) {
  const parsed = parseNoeLlmJson(value);
  return parsed.ok ? parsed.value : fallback;
}
