import { randomUUID } from 'node:crypto';
import { cleanVisibleModelText } from '../runtime/NoeContextScrubber.js';

export const NOE_MEMORY_PROVIDER_MANAGER_SCHEMA_VERSION = 1;

const RESERVED_MEMORY_TOOL_NAMES = new Set([
  'noe.memory.write',
  'noe.memory.recall',
  'noe.memory.search',
  'memory.write',
  'memory.recall',
  'memory.search',
]);

function clean(value, max = 1000) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizeToolNames(provider = {}) {
  const raw = Array.isArray(provider.tools) ? provider.tools : [];
  return raw.map((tool) => clean(typeof tool === 'string' ? tool : tool?.name, 160)).filter(Boolean);
}

function isExternalProvider(provider = {}) {
  return provider.external !== false && provider.kind !== 'local';
}

export function scrubExternalMemoryText(value = '') {
  const out = cleanVisibleModelText(String(value ?? ''));
  return {
    text: out.text.slice(0, 4000),
    stripped: out.stripped,
  };
}

export class NoeMemoryProviderManager {
  constructor({
    localMemory = null,
    providers = [],
    externalEnabled = false,
    maxExternalProviders = 1,
    maxSyncBatch = 8,
    logger = console,
  } = {}) {
    this.localMemory = localMemory;
    this.externalEnabled = externalEnabled === true;
    this.maxExternalProviders = Math.max(0, Math.trunc(Number(maxExternalProviders) || 0));
    this.maxSyncBatch = Math.max(1, Math.trunc(Number(maxSyncBatch) || 8));
    this.logger = logger;
    this.providers = [];
    this.syncQueue = [];
    this.lastDrain = null;
    for (const provider of providers) this.registerProvider(provider);
  }

  registerProvider(provider = {}) {
    const id = clean(provider.id || provider.name, 120);
    if (!id) throw new Error('memory_provider_id_required');
    const toolNames = normalizeToolNames(provider);
    const shadowedTool = toolNames.find((tool) => RESERVED_MEMORY_TOOL_NAMES.has(tool));
    if (shadowedTool) {
      throw new Error(`memory_provider_tool_shadow_rejected:${shadowedTool}`);
    }
    const normalized = {
      ...provider,
      id,
      tools: toolNames,
      external: isExternalProvider(provider),
    };
    if (normalized.external) {
      const externalCount = this.providers.filter((item) => item.external).length;
      if (externalCount >= this.maxExternalProviders) throw new Error('memory_provider_single_external_limit');
    }
    this.providers.push(normalized);
    return normalized;
  }

  externalProviders() {
    return this.providers.filter((provider) => provider.external);
  }

  recallLocal(args = {}) {
    const recalled = this.localMemory?.recall ? this.localMemory.recall(args) : [];
    return {
      ok: true,
      source: 'local',
      memories: Array.isArray(recalled) ? recalled : [],
      externalEnabled: this.externalEnabled,
      externalProviders: this.externalProviders().map((provider) => provider.id),
    };
  }

  async recallExternal(args = {}) {
    if (!this.externalEnabled) return { ok: true, skipped: true, reason: 'external_memory_disabled', memories: [] };
    const provider = this.externalProviders()[0];
    if (!provider?.recall) return { ok: true, skipped: true, reason: 'external_memory_provider_unavailable', memories: [] };
    const raw = await provider.recall(args);
    const memories = (Array.isArray(raw) ? raw : [])
      .map((item = {}) => {
        const scrubbed = scrubExternalMemoryText(item.text || item.body || item.content || item.title || '');
        return {
          id: clean(item.id, 160) || `external-${randomUUID()}`,
          providerId: provider.id,
          scope: clean(item.scope, 120),
          text: scrubbed.text,
          stripped: scrubbed.stripped,
          score: Number.isFinite(Number(item.score)) ? Number(item.score) : null,
        };
      })
      .filter((item) => item.text);
    return { ok: true, skipped: memories.length === 0, providerId: provider.id, memories };
  }

  writeLocal(input = {}) {
    const written = this.localMemory?.write ? this.localMemory.write(input) : null;
    if (this.externalEnabled && this.externalProviders().some((provider) => provider.upsert)) {
      this.syncQueue.push({
        id: `memory-sync-${randomUUID()}`,
        op: 'upsert',
        input,
        localId: written?.id || clean(input.id, 160) || null,
        queuedAt: new Date().toISOString(),
      });
    }
    return {
      ok: true,
      memory: written,
      syncQueued: this.syncQueue.length,
      externalEnabled: this.externalEnabled,
    };
  }

  enqueueSync(item = {}) {
    const id = clean(item.id, 160) || `memory-sync-${randomUUID()}`;
    this.syncQueue.push({ ...item, id, queuedAt: item.queuedAt || new Date().toISOString() });
    return { ok: true, id, syncQueued: this.syncQueue.length };
  }

  async drainSync({ maxItems = this.maxSyncBatch } = {}) {
    if (!this.externalEnabled) {
      return { ok: true, skipped: true, reason: 'external_memory_disabled', processed: 0, remaining: this.syncQueue.length };
    }
    const provider = this.externalProviders()[0];
    if (!provider?.upsert) {
      return { ok: true, skipped: true, reason: 'external_memory_provider_unavailable', processed: 0, remaining: this.syncQueue.length };
    }
    const limit = Math.max(1, Math.min(this.maxSyncBatch, Math.trunc(Number(maxItems) || this.maxSyncBatch)));
    const batch = this.syncQueue.splice(0, limit);
    const results = [];
    for (const item of batch) {
      try {
        const output = await provider.upsert(item);
        results.push({ id: item.id, ok: true, output });
      } catch (e) {
        results.push({ id: item.id, ok: false, error: clean(e?.message || e, 500) });
        this.logger?.warn?.('[noe-memory-provider] sync failed:', e?.message || e);
      }
    }
    this.lastDrain = {
      at: new Date().toISOString(),
      providerId: provider.id,
      processed: batch.length,
      remaining: this.syncQueue.length,
    };
    return { ok: results.every((item) => item.ok), providerId: provider.id, processed: batch.length, remaining: this.syncQueue.length, results };
  }

  status() {
    return {
      schemaVersion: NOE_MEMORY_PROVIDER_MANAGER_SCHEMA_VERSION,
      externalEnabled: this.externalEnabled,
      maxExternalProviders: this.maxExternalProviders,
      maxSyncBatch: this.maxSyncBatch,
      providers: this.providers.map((provider) => ({
        id: provider.id,
        external: provider.external,
        tools: provider.tools,
        hasRecall: typeof provider.recall === 'function',
        hasUpsert: typeof provider.upsert === 'function',
      })),
      syncQueued: this.syncQueue.length,
      lastDrain: this.lastDrain,
    };
  }
}

export function createNoeMemoryProviderManager(opts = {}) {
  return new NoeMemoryProviderManager(opts);
}
