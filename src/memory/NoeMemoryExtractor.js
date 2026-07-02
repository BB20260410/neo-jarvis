// @ts-check

import { NOE_MAIN_BRAIN_MODEL, normalizeNoeAutoModel, resolveNoeOutputBudget } from '../model/NoeLocalModelPolicy.js';
import { normalizeMemoryCandidate } from './NoeMemoryCandidateSchema.js';
import { FactExtractor } from './FactExtractor.js';
import { parseNoeLlmJsonValue } from '../runtime/NoeLlmJsonExtractor.js';

const EXTRACT_SYSTEM = '你是 Noe 的长期记忆候选提取器。只从本轮对话里明确出现的信息提炼候选，禁止猜测。'
  + '只输出 JSON 数组，不要 markdown，不要解释。每项字段：'
  + '{"kind":"fact|preference|skill|insight","body":"第三人称或第一人称的短句","confidence":0.35-0.95,'
  + '"tags":["短标签"],"salience":1-5,"risk":"low|medium|high"}。'
  + '如果判断不应写长期记忆，输出 [{"kind":"no_write","reason":"原因"}]。'
  + '闲聊、一次性指令、短期情绪、没有证据的信息不要写。没有候选可写时必须给 no_write 原因。';

function parseJsonArray(text) {
  const parsed = parseNoeLlmJsonValue(text, null);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.candidates)) return parsed.candidates;
  return null;
}

export class NoeMemoryExtractor {
  constructor({
    complete = null,
    getAdapter = null,
    adapterId = 'lmstudio',
    model = process.env.NOE_FACT_MODEL || NOE_MAIN_BRAIN_MODEL,
    fallback = null,
    now = Date.now,
  } = {}) {
    this.complete = complete;
    this.getAdapter = getAdapter;
    this.adapterId = adapterId;
    this.model = normalizeNoeAutoModel(model);
    this.fallback = fallback || new FactExtractor({ model: this.model });
    this.now = now;
  }

  async completeStructured(conversation, { projectId = 'noe' } = {}) {
    const conv = String(conversation || '').trim().slice(0, 6000);
    if (!conv) return '';
    if (this.complete) return this.complete(conv);
    const adapter = this.getAdapter?.(this.adapterId);
    if (!adapter?.chat) return '';
    const budget = resolveNoeOutputBudget('memory_write_candidate');
    const r = await adapter.chat(
      [{ role: 'system', content: EXTRACT_SYSTEM }, { role: 'user', content: `对话：\n${conv}` }],
      {
        budgetContext: { projectId, taskId: 'noe-memory-extract' },
        think: false,
        temperature: 0,
        top_p: 1,
        maxTokens: budget.max_tokens,
        ...(this.model ? { model: this.model } : {}),
      },
    );
    if (r?.incomplete) return JSON.stringify([{ body: '', incomplete: true, finishReason: r.finishReason || 'length' }]);
    return r?.reply || '';
  }

  async extractCandidates(conversation, {
    projectId = 'noe',
    sourceEpisodeId = null,
    sourceEventIds = [],
    evidenceRefs = [],
    confidence = 0.65,
  } = {}) {
    const now = this.now();
    let parsed = null;
    try {
      parsed = parseJsonArray(await this.completeStructured(conversation, { projectId }));
    } catch {
      parsed = null;
    }
    if (!parsed) {
      const facts = this.fallback?.extract ? await this.fallback.extract(conversation) : [];
      parsed = facts.map((body) => ({ kind: 'fact', body, confidence, tags: ['fact'], salience: 3, risk: 'low' }));
    }
    const noWriteItems = (parsed || []).filter((item) => item && String(item.kind || '').toLowerCase() === 'no_write');
    if (noWriteItems.length) {
      return noWriteItems.slice(0, 3).map((item) => normalizeMemoryCandidate({
        kind: 'fact',
        body: `no_write:${String(item.reason || 'not_worth_long_term_memory').slice(0, 200)}`,
        projectId,
        sourceType: item.sourceType || 'fact_extract',
        sourceEpisodeId,
        sourceEventIds,
        evidenceRefs,
        confidence: 1,
        noWriteReason: item.reason || 'not_worth_long_term_memory',
        validFrom: now,
      }, { now }));
    }
    return parsed
      .filter((item) => item && String(item.body || item.text || '').trim())
      .slice(0, 10)
      .map((item) => normalizeMemoryCandidate({
        ...item,
        body: item.body || item.text,
        projectId,
        sourceType: item.sourceType || 'fact_extract',
        sourceEpisodeId,
        sourceEventIds,
        evidenceRefs,
        confidence: item.confidence ?? confidence,
        validFrom: now,
      }, { now }));
  }

  async extractRecords(conversation, opts = {}) {
    const candidates = await this.extractCandidates(conversation, opts);
    return candidates.map((candidate) => ({
      text: candidate.body,
      body: candidate.body,
      kind: candidate.kind,
      scope: candidate.scope,
      validFrom: candidate.validFrom,
      validTo: candidate.validTo,
      sourceEpisodeId: candidate.sourceEpisodeId,
      evidenceRefs: candidate.evidenceRefs,
      confidence: candidate.confidence,
      salience: candidate.salience,
      tags: candidate.tags,
      incomplete: candidate.incomplete,
      noWriteReason: candidate.noWriteReason,
    }));
  }
}
