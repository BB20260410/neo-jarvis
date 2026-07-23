// 搜索总结大脑被 finish_reason=length / max_tokens 截断时，reply 是半截未收尾文本——
// 绝不能当成正式总结返回（会被语音念出半句、写进长期记忆=污染）。与 VoiceSession.isIncompleteBrainResult 同口径。
export function isIncompleteChatResult(out = {}) {
  if (!out || typeof out !== 'object') return false;
  const finishReason = String(out.finishReason || out.finish_reason || '').trim().toLowerCase();
  const completionStatus = String(out.completionStatus || '').trim().toLowerCase();
  return out.incomplete === true
    || out.truncated === true
    || out.continuationRequired === true
    || completionStatus === 'incomplete_length'
    || finishReason === 'length'
    || finishReason === 'max_tokens';
}

const LOCAL_FILE_RE = /在哪|哪里|找.{0,8}文件|定位|搜.{0,8}文件|有没有.{0,8}文件|文件.{0,4}在/;
const RESEARCH_RE = /搜一?下|搜索|查一?下|查查|帮我查|上网搜|联网|最新|研究一?下|调研|research|search/i;
const DEEP_RE = /深度研究|深入研究|系统研究|调研|研究一?下|research/i;

function cleanQuery(text) {
  let q = String(text || '').trim();
  q = q.replace(/^[\s，。,.!?！？]*(请|麻烦|帮我|幫我|给我)?\s*/i, '');
  q = q.replace(/^(noe|neo|诺伊|诺依|宝贝|贾维斯)\s*/i, '');
  q = q.replace(/^(上网|联网|网络)?\s*(搜一下|搜一搜|搜索一下|搜索|搜|查一下|查一查|查查|查|帮我查|研究一下|研究一研究|研究|调研一下|调研|了解一下)\s*/i, '');
  q = q.replace(/(^|[^A-Za-z0-9])N\s*O(?=[^A-Za-z0-9]|$)/g, '$1Noe');
  q = q.replace(/^(一下|一下子)\s*/i, '');
  q = q.replace(/[，。,.!?！？\s]+$/g, '').trim();
  return (q || String(text || '').trim()).slice(0, 240);
}

export function detectResearchIntent(text) {
  const raw = String(text || '').trim();
  if (!raw || LOCAL_FILE_RE.test(raw)) return null;
  if (!RESEARCH_RE.test(raw)) return null;
  const query = cleanQuery(raw);
  if (!query) return null;
  return { type: 'research', mode: DEEP_RE.test(raw) ? 'deep' : 'search', query, text: raw };
}

function compact(s, n = 220) {
  return cleanSearchText(s, n);
}

function normalizeForQuality(s) {
  return cleanSearchText(s, 1200).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function decodeEntities(s) {
  const map = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
  return String(s || '').replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => map[m] || m)
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(Number(d)); } catch { return ' '; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, hx) => { try { return String.fromCodePoint(parseInt(hx, 16)); } catch { return ' '; } });
}

export function cleanSearchText(value, max = 360) {
  return decodeEntities(String(value || ''))
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<img\b[^，。！？,;\n\r]*/gi, ' ')
    .replace(/<\/?[a-z][^>]*>/gi, ' ')
    .replace(/\b(?:src|href|fmt|size|width|height|w|h)=['"]?[^，。！？\s]+/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[\u0000-\u001f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function cleanItems(results, maxResults = 5) {
  return (Array.isArray(results) ? results : []).slice(0, maxResults).map((r) => ({
    ...r,
    title: cleanSearchText(r?.title, 140),
    snippet: cleanSearchText(r?.snippet, 280),
    date: cleanSearchText(r?.date, 40),
    source: cleanSearchText(r?.source, 40),
  })).filter((r) => r.title || r.snippet);
}

export function assessSearchSummaryQuality(text, results, { maxChars = 560 } = {}) {
  const raw = String(text || '').trim();
  const clean = cleanSearchText(raw, maxChars + 80);
  const reasons = [];
  if (!clean) reasons.push('empty');
  if (clean.length < 18) reasons.push('too_short');
  if (clean.length > maxChars) reasons.push('too_long_for_tts');
  if (/<img|<\/?[a-z]|https?:\/\/|\b(?:src|href)=/i.test(raw)) reasons.push('dirty_markup_or_url');
  if (/(^|\n)\s*(?:\d+[.)、]|[-*])\s+/.test(raw) || /(?:标题|摘要|链接|url|来源)[:：]/i.test(raw)) reasons.push('title_list_style');
  if (!/(结论|总体|目前看|可以先|我先|初步|最直接|没有统一|不确定|还不能|建议|复核)/.test(clean)) reasons.push('no_clear_conclusion');
  if (!/(不确定|分歧|口径|来源|复核|初步|可能|变化|更新|没有统一|还不能|建议)/.test(clean)) reasons.push('no_uncertainty_or_caveat');

  const norm = normalizeForQuality(clean);
  const repeatedTitles = cleanItems(results, 5).filter((r) => {
    const title = normalizeForQuality(r.title);
    return title.length >= 8 && norm.includes(title.slice(0, Math.min(24, title.length)));
  }).length;
  if (repeatedTitles >= 2) reasons.push('repeats_result_titles');
  return { ok: reasons.length === 0, text: clean, reasons };
}

export function formatSearchReply(query, results, { voice = false, maxResults = 5 } = {}) {
  const items = cleanItems(results, maxResults);
  if (!items.length) return voice ? `主人，我没搜到和 ${query} 直接相关的结果。` : `没有搜到和「${query}」直接相关的结果。`;
  if (voice) {
    return formatSearchSpeechFallback(query, items, { maxResults });
  }
  const lines = items.map((r, i) => {
    const meta = [r.source, r.date].filter(Boolean).join(' · ');
    return `${i + 1}. ${compact(r.title, 120)}${meta ? ` (${meta})` : ''}\n${compact(r.snippet, 220)}\n${r.url || ''}`;
  });
  return `【联网搜索】${query}\n\n${lines.join('\n\n')}`;
}

export function formatSearchSpeechFallback(query, results, { maxResults = 5 } = {}) {
  const items = cleanItems(results, maxResults);
  if (!items.length) return `主人，我没搜到和 ${query} 直接相关的结果。`;
  const clues = items.slice(0, 4).map((r) => compact(`${r.title}。${r.snippet}`, 110)).filter(Boolean);
  const lead = clues[0] || `${query} 相关资料`;
  const more = clues.slice(1, 3).join('；');
  return `主人，我先给你结论：搜索结果里最直接的信息是，${lead}。${more ? `另外还看到：${more}。` : ''}这些来源口径可能不完全一致，我建议把它当作初步搜索结论，再用官方或权威来源复核。`;
}

export async function summarizeSearchResults(chat, query, results, { maxResults = 5, personaName = '主人' } = {}) {
  const items = cleanItems(results, maxResults);
  if (!items.length) return `主人，我没搜到和 ${query} 直接相关的结果。`;
  if (typeof chat === 'function') {
    const evidence = items.map((r, i) => `${i + 1}. 标题：${r.title}\n摘要：${r.snippet}\n日期：${r.date || '未知'}\n来源：${r.source || '搜索'}`).join('\n\n');
    try {
      const out = await chat([
        { role: 'system', content: `你是 Noe 的搜索结果总结器。只用给定搜索结果回答用户问题。必须中文、自然口语、3 到 5 句话。先给结论，再说依据和不确定性；如果结果分歧或来源不权威，就直接说没有统一第一，不要硬选一个冠军。不要逐条复读，不要读 URL，不要输出 HTML/img/src/href，不要编造搜索结果没有的信息。称呼用户为${personaName}。` },
        { role: 'user', content: `用户问题：${query}\n\n搜索结果：\n${evidence}` },
      ], { think: false, noAbort: true, maxCompletionTokens: 900 });
      // 截断兜底（Task 0.5 Step1）：finish_reason=length 时 reply 是半截，丢弃走规则兜底（绝不返回/落账半句模型输出）
      if (isIncompleteChatResult(out)) return formatSearchSpeechFallback(query, items, { maxResults });
      const text = cleanSearchText(out?.reply, 760);
      const candidate = text.startsWith(personaName) ? text : `${personaName}，${text}`;
      if (assessSearchSummaryQuality(candidate, items).ok) return candidate;
    } catch { /* 总结失败走规则兜底 */ }
  }
  return formatSearchSpeechFallback(query, items, { maxResults });
}

export function formatDeepResearchReply(out, { voice = false } = {}) {
  const report = String(out?.report || '').trim();
  const sources = Array.isArray(out?.sources) ? out.sources : [];
  if (voice) return compact(report, 900) || '主人，研究流程跑完了，但没有形成有效报告。';
  const src = sources.slice(0, 6).map((s, i) => `${i + 1}. ${s.title || s.url}\n${s.url || ''}`).join('\n');
  return `${report || '研究流程跑完了，但没有形成有效报告。'}${src ? `\n\n来源：\n${src}` : ''}`;
}
