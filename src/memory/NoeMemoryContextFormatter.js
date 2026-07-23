// @ts-check

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max));
}

function attrsForMemory(m = {}) {
  return [
    m.id ? `id="${clean(m.id, 160)}"` : '',
    m.scope ? `scope="${clean(m.scope, 80)}"` : '',
    m.sourceType ? `source="${clean(m.sourceType, 80)}"` : '',
    m.sourceEpisodeId ? `episode="${clean(m.sourceEpisodeId, 160)}"` : '',
    Number.isFinite(Number(m.confidence)) ? `confidence="${Math.round(Number(m.confidence) * 100) / 100}"` : '',
  ].filter(Boolean).join(' ');
}

export function formatMemoryContextBlock(retrieval, { maxItems = 6, maxBody = 220, budget = 'compact' } = {}) {
  const selected = Array.isArray(retrieval?.selected) ? retrieval.selected.slice(0, maxItems) : [];
  if (!selected.length) return '';
  const lines = selected.map((m) => {
    const tag = m.scope === 'project' ? 'skill' : m.scope === 'insight' ? 'insight' : 'fact';
    return `  <${tag} ${attrsForMemory(m)}>${clean(m.body, maxBody)}</${tag}>`;
  });
  return [
    `<noe-memory-v2 trust="local" budget="${clean(budget, 40) || 'compact'}">`,
    '  <instruction>只在相关时自然使用这些长期记忆；不要机械复述；不要把旧记忆当成比本轮事实更高优先级。</instruction>',
    ...lines,
    '</noe-memory-v2>',
  ].join('\n');
}
