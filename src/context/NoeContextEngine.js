// ============================================================================
// ⚠️ @deprecated — LegacyNoeContextEngine 已废弃（2026-06-10 裁决：标废弃，不删除）
//
// 零接线证据：本文件运行时零引用，唯一 import 方是测它自己的
//   tests/unit/noe-context-engine.test.js（grep 全仓核实）。
// 真实活引擎：src/context/NoeTurnContextEngine.js（server.js:166 import）。
//
// 确认无回头需求后可整体删除（连带 tests/unit/noe-context-engine.test.js），
// 删除需 owner 确认（项目纪律：不删除用户已有文件）。
//
// 提醒：若日后要给新引擎加 uiSignals / acuiCards 聊天注入，直接调共享 builder
// （NoeGatewayProtocol.buildUiSignalsContextBlock / NoeAcuiCardStore.buildNoeAcuiCardsContextBlock）
// 的 contextBlock 并补 redactSensitiveText 脱敏即可，不要回头接这个文件——
// 本文件所谓"独有件"实为这两个共享 builder 的 4 行转调，无收编价值。
// ============================================================================
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { buildNoeAcuiCardsContextBlock } from '../runtime/NoeAcuiCardStore.js';
import { buildUiSignalsContextBlock } from '../runtime/NoeGatewayProtocol.js';
import {
  buildNoeContextSufficiencyBlock,
  evaluateNoeContextSufficiency,
} from './NoeContextSufficiencyGatherer.js';
import { buildNoeSelfKnowledgeBlock } from './NoeSelfKnowledge.js';
import { compactTrajectory } from './NoeTrajectoryCompactor.js';

export const NOE_CONTEXT_ENGINE_SCHEMA_VERSION = 1;

function clean(value, max = 4000) {
  return String(value || '').trim().slice(0, max);
}

function estimateTokens(text = '') {
  return Math.ceil(clean(text, 200_000).length / 4);
}

export class NoeContextEngine {
  constructor({ name = 'base-context-engine' } = {}) {
    this.name = name;
  }

  async ingest() {
    return { ok: true, ingested: false };
  }

  async assemble() {
    return {
      schemaVersion: NOE_CONTEXT_ENGINE_SCHEMA_VERSION,
      engine: this.name,
      messages: [],
      estimatedTokens: 0,
      systemPromptAddition: '',
      promptAuthority: 'untrusted-context',
      sources: [],
    };
  }

  shouldCompact({ estimatedTokens = 0, budgetTokens = 8000 } = {}) {
    return estimatedTokens > budgetTokens;
  }

  async compact(bundle = {}, opts = {}) {
    // 实现轨迹滑动压缩：超长对话把早期轮次摘要、保护尾部高保真（Hermes context_compressor）。
    const result = await compactTrajectory(bundle.messages || [], opts);
    return { ...bundle, messages: result.messages, compactedCount: result.compactedCount, compacted: result.compacted };
  }

  async afterTurn() {
    return { ok: true };
  }
}

export class LegacyNoeContextEngine extends NoeContextEngine {
  constructor({ memory = null, focus = null, fileIndex = null, prefetch = null, personCards = null, commitments = null } = {}) {
    super({ name: 'legacy-noe-context-engine' });
    this.memory = memory;
    this.focus = focus;
    this.fileIndex = fileIndex;
    // 以下三者注入式可选:未注入则完全 no-op,不改现有行为。
    this.prefetch = prefetch;       // NoePrefetchStore — 预取池
    this.personCards = personCards; // NoePersonCards — 人物关系卡
    this.commitments = commitments; // NoeCommitmentStore — 到期承诺
  }

  async assemble({
    goal = '',
    projectId = 'noe',
    query = '',
    limit = 8,
    budgetTokens = 6000,
    requiredContext = [],
    maxGatherRounds = 1,
    uiSignals = [],
    acuiCards = [],
    nowMs = Date.now(),
    personAlias = '',
    includeSelfKnowledge = true,
  } = {}) {
    const q = clean(query || goal, 1000);
    const sources = [];
    const parts = [];
    // 自我能力认知:让大脑始终知道"我有声纹/视觉/记忆/梦境/多模型…等真实能力",被问到能如实答。
    if (includeSelfKnowledge) {
      const sk = buildNoeSelfKnowledgeBlock();
      if (sk) { sources.push({ kind: 'selfKnowledge' }); parts.push(sk); }
    }
    const memories = this.memory?.recall ? this.memory.recall({ q, projectId, limit }) : [];
    if (Array.isArray(memories) && memories.length) {
      sources.push({ kind: 'memory', count: memories.length, text: memories.map((item) => redactSensitiveText(item.text || item.content || item.title || '')).join(' ') });
      parts.push(`<memory-context>\n${memories.map((item) => `- ${redactSensitiveText(item.text || item.content || item.title || '')}`).join('\n')}\n</memory-context>`);
    }
    const focusItems = this.focus?.list ? this.focus.list({ projectId, state: 'active', limit }) : [];
    if (Array.isArray(focusItems) && focusItems.length) {
      sources.push({ kind: 'focus', count: focusItems.length, text: focusItems.map((item) => redactSensitiveText(item.title || item.text || item.summary || '')).join(' ') });
      parts.push(`当前焦点：\n${focusItems.map((item) => `- ${redactSensitiveText(item.title || item.text || item.id || '')}`).join('\n')}`);
    }
    const fileStats = this.fileIndex?.stats ? this.fileIndex.stats() : null;
    if (fileStats) {
      sources.push({ kind: 'fileIndex', count: Number(fileStats.total || fileStats.files || 0) || 0 });
      parts.push(`本地文件索引状态：${JSON.stringify(fileStats)}`);
    }
    const uiSignalBlock = buildUiSignalsContextBlock(uiSignals);
    if (uiSignalBlock) {
      sources.push({ kind: 'uiSignals', count: uiSignals.length });
      parts.push(uiSignalBlock);
    }
    const acuiCardBlock = buildNoeAcuiCardsContextBlock(acuiCards);
    if (acuiCardBlock) {
      sources.push({ kind: 'acuiCards', count: acuiCards.length });
      parts.push(acuiCardBlock);
    }
    // 预取池:未过期的高频环境数据,问就秒回(store 未注入则 no-op)。
    const prefetchBlock = this.prefetch?.toContextBlock ? this.prefetch.toContextBlock(nowMs) : '';
    if (prefetchBlock) {
      sources.push({ kind: 'prefetch' });
      parts.push(prefetchBlock);
    }
    // 人物关系卡:按别名命中则注入"你正在和X对话,关系…偏好…"(无别名/未命中则 no-op)。
    const personCard = personAlias && this.personCards?.getByAlias ? this.personCards.getByAlias(personAlias) : null;
    const personHint = personCard && this.personCards?.toContextHint ? this.personCards.toContextHint(personCard) : '';
    if (personHint) {
      sources.push({ kind: 'personCard' });
      parts.push(redactSensitiveText(personHint));
    }
    // 到期承诺:落入时间窗的未完成承诺提醒(store 未注入则 no-op)。
    const dueCommitments = this.commitments?.due ? this.commitments.due(nowMs) : [];
    if (Array.isArray(dueCommitments) && dueCommitments.length) {
      sources.push({ kind: 'commitments', count: dueCommitments.length });
      parts.push(`<due-commitments>\n${dueCommitments.slice(0, 8).map((c) => `- ${redactSensitiveText(c.text || '')}`).join('\n')}\n</due-commitments>`);
    }
    const baseVisible = redactSensitiveText(parts.join('\n\n')).trim();
    const contextSufficiency = Array.isArray(requiredContext) && requiredContext.length
      ? evaluateNoeContextSufficiency({
        goal,
        contextBundle: {
          messages: baseVisible ? [{ role: 'system', content: baseVisible }] : [],
          sources,
          systemPromptAddition: baseVisible,
        },
        requiredContext,
        maxRounds: maxGatherRounds,
      })
      : null;
    if (contextSufficiency) sources.push({ kind: 'contextSufficiency', count: contextSufficiency.missingContext.length });
    const visible = [
      baseVisible,
      contextSufficiency ? buildNoeContextSufficiencyBlock(contextSufficiency) : '',
    ].filter(Boolean).join('\n\n');
    const estimated = estimateTokens(visible);
    const bundle = {
      schemaVersion: NOE_CONTEXT_ENGINE_SCHEMA_VERSION,
      engine: this.name,
      messages: visible ? [{ role: 'system', content: visible }] : [],
      estimatedTokens: estimated,
      systemPromptAddition: visible,
      promptAuthority: 'local-untrusted-context',
      sources,
      contextSufficiency,
      compactRecommended: this.shouldCompact({ estimatedTokens: estimated, budgetTokens }),
    };
    return bundle;
  }
}

export function createLegacyNoeContextEngine(deps = {}) {
  return new LegacyNoeContextEngine(deps);
}
