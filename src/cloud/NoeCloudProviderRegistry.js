// @ts-check
import { normalizeNoeTaskOutput } from './NoeTaskOutput.js';
import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';
import { MiniMaxChatAdapter } from '../room/MiniMaxChatAdapter.js';
import { probeNoeProviderHealth } from '../secrets/NoeProviderHealth.js';
import { resolveNoeProviderSecret } from '../secrets/NoeProviderSecrets.js';

function clean(value, max = 1000) {
  return redactSensitiveText(String(value ?? '').trim()).slice(0, max);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function extractJson(value) {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || {});
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const object = raw.match(/\{[\s\S]*\}/);
  if (object) {
    try { return JSON.parse(object[0]); } catch {}
  }
  return null;
}

function safeMissionId(value) {
  return clean(value || 'cloud-patch-plan', 160).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120) || 'cloud-patch-plan';
}

function evidencePackText(evidencePack = {}) {
  return clean(JSON.stringify(evidencePack, null, 2), 60_000);
}

function buildPatchPlanPrompt({ missionId, evidencePack = {}, objective = '' } = {}) {
  const safeId = safeMissionId(missionId || evidencePack.missionId);
  return [
    '你是 Neo/Noe 的 Cloud Change Lead。你只负责根据只读 EvidencePack 生成 patch plan JSON。',
    '本地 Local Autonomy Core 才负责 apply/test/verify/rollback；你不能声称已经修改、测试、发布或删除。',
    '禁止输出 secret、token、cookie、OAuth、.env 内容。禁止要求读取完整私密仓库。',
    '只输出 JSON，不要 Markdown，不要解释。',
    '',
    'JSON schema:',
    '{"kind":"noe_patch_plan","providerId":"minimax-m3","objective":"string","operations":[{"id":"string","op":"write_file","path":"output/noe-mission-poc/<missionId>/safe-patch.txt","content":"string"}],"risks":[],"evidenceRefs":[]}',
    '',
    '规则:',
    `- missionId 固定为 ${safeId}`,
    `- path 必须位于 output/noe-mission-poc/${safeId}/`,
    '- 本轮只允许 op=write_file；不得 delete/move/chmod/shell/publish/external_write。',
    '- content 只写一个可验证的 PoC 文本，不得包含 secret-like 字符串。',
    '',
    'Objective:',
    clean(objective || evidencePack.objective || 'generate safe cloud patch plan', 4000),
    '',
    'Read-only EvidencePack:',
    evidencePackText(evidencePack),
  ].join('\n');
}

function normalizePatchPlan(plan = {}, { missionId = '', providerId = 'minimax-m3', objective = '' } = {}) {
  const safeId = safeMissionId(missionId);
  const operations = asArray(plan.operations).map((operation, index) => ({
    id: clean(operation?.id || `write-safe-patch-${index + 1}`, 120),
    op: clean(operation?.op || '', 80),
    path: clean(operation?.path || '', 500),
    content: clean(operation?.content || '', 20_000),
  }));
  const blockers = [];
  if (plan.kind !== 'noe_patch_plan') blockers.push('patch_plan_kind_invalid');
  if (!operations.length) blockers.push('patch_plan_operations_required');
  const safePrefix = `output/noe-mission-poc/${safeId}/`;
  for (const operation of operations) {
    if (operation.op !== 'write_file') blockers.push(`unsupported_operation:${operation.op || 'missing'}`);
    if (!operation.path.startsWith(safePrefix)) blockers.push(`operation_path_outside_safe_prefix:${operation.path || 'missing'}`);
    if (!operation.content) blockers.push(`operation_content_required:${operation.id}`);
  }
  return {
    ok: blockers.length === 0,
    blockers,
    patchPlan: {
      kind: 'noe_patch_plan',
      providerId: clean(plan.providerId || providerId, 120),
      objective: clean(plan.objective || objective, 4000),
      operations,
      risks: asArray(plan.risks).map((item) => clean(item, 500)).filter(Boolean).slice(0, 20),
      evidenceRefs: asArray(plan.evidenceRefs).map((item) => clean(item, 500)).filter(Boolean).slice(0, 20),
    },
  };
}

const DEFAULT_PROVIDERS = [
  {
    id: 'mock-minimax-m3',
    provider: 'mock',
    model: 'MiniMax-M3',
    capabilityTags: ['code_reasoning', 'patch_generation', 'high_reliability', 'mock'],
    mock: true,
  },
  {
    id: 'minimax-m3',
    provider: 'minimax',
    model: 'MiniMax-M3',
    capabilityTags: ['code_reasoning', 'patch_generation', 'cloud_change_lead'],
    envRefs: ['MINIMAX_API_KEY'],
    mock: false,
  },
  {
    id: 'openai-auto',
    provider: 'openai',
    model: 'auto',
    capabilityTags: ['code_reasoning', 'patch_generation', 'long_context'],
    envRefs: ['OPENAI_API_KEY', 'CODEX_API_KEY'],
    mock: false,
  },
  {
    id: 'anthropic-auto',
    provider: 'anthropic',
    model: 'auto',
    capabilityTags: ['code_reasoning', 'patch_generation', 'long_context'],
    envRefs: ['ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'],
    mock: false,
  },
  {
    id: 'google-auto',
    provider: 'google',
    model: 'auto',
    capabilityTags: ['long_context', 'code_reasoning'],
    envRefs: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    mock: false,
  },
];

export class NoeCloudProviderRegistry {
  constructor({
    providers = DEFAULT_PROVIDERS,
    resolveSecret = resolveNoeProviderSecret,
    fetchImpl = globalThis.fetch,
    env = process.env,
    runner = null,
  } = {}) {
    this.providers = providers.map((provider) => ({ ...provider }));
    this.resolveSecret = resolveSecret;
    this.fetchImpl = fetchImpl;
    this.env = env;
    this.runner = runner;
  }

  list() {
    return this.providers.map((provider) => ({
      id: provider.id,
      provider: provider.provider,
      model: provider.model,
      capabilityTags: asArray(provider.capabilityTags),
      mock: provider.mock === true,
    }));
  }

  resolve({ providerId = '', capabilityTags = [], allowMock = true } = {}) {
    const wanted = asArray(capabilityTags).map((tag) => clean(tag, 80));
    return this.providers.find((provider) => {
      if (providerId && provider.id !== providerId) return false;
      if (!allowMock && provider.mock) return false;
      const tags = new Set(asArray(provider.capabilityTags));
      return wanted.every((tag) => tags.has(tag));
    }) || null;
  }

  preflight(providerId = 'mock-minimax-m3') {
    const provider = this.resolve({ providerId, allowMock: true });
    if (!provider) return { ok: false, providerId, reason: 'provider_not_registered' };
    if (provider.mock === true) return { ok: true, providerId: provider.id, provider: provider.provider, model: provider.model, mock: true };
    const resolution = this.resolveSecret?.(provider.provider, { env: this.env });
    return {
      ok: resolution?.ok === true,
      providerId: provider.id,
      provider: provider.provider,
      model: provider.model,
      mock: false,
      source: resolution?.source || 'unconfigured',
      sourceRef: resolution?.ok ? clean(resolution.sourceRef || '', 160) : '',
      configured: resolution?.ok === true,
      secretValuesReturned: false,
    };
  }

  async preflightLive(providerId = 'mock-minimax-m3') {
    const basic = this.preflight(providerId);
    if (!basic.ok || basic.mock === true) return basic;
    const health = await probeNoeProviderHealth(basic.provider, {
      env: this.env,
      fetchImpl: this.fetchImpl,
      secretResolver: this.resolveSecret,
    });
    return {
      ...basic,
      ok: health.ok === true,
      reachable: health.reachable === true,
      authOk: health.authOk === true,
      status: health.status || (health.ok ? 'reachable' : 'unavailable'),
      httpStatus: health.httpStatus || 0,
      modelCount: health.modelCount || 0,
      selectedModelListed: health.selectedModelListed,
      endpoint: clean(health.endpoint || '', 500),
      error: health.ok ? '' : clean(health.error || '', 500),
      secretValuesReturned: false,
    };
  }

  async generatePatchPlan({ providerId = 'mock-minimax-m3', evidencePack = {}, objective = '' } = {}) {
    const preflight = this.preflight(providerId);
    if (!preflight.ok) {
      return normalizeNoeTaskOutput({
        ok: false,
        provenance: 'cloud',
        provider: preflight.provider,
        model: preflight.model,
        brainRoute: 'cloud_change_lead',
        text: `provider unavailable: ${preflight.reason || preflight.source}`,
        finishReason: 'unavailable',
      });
    }
    if (preflight.provider === 'minimax' && preflight.mock !== true) {
      return this.generateMiniMaxPatchPlan({ preflight, evidencePack, objective });
    }
    if (preflight.mock !== true) {
      return normalizeNoeTaskOutput({
        ok: false,
        provenance: 'cloud',
        provider: preflight.provider,
        model: preflight.model,
        brainRoute: 'cloud_change_lead',
        text: `provider generation not implemented: ${preflight.provider}`,
        finishReason: 'unavailable',
      });
    }
    const missionId = clean(evidencePack.missionId || 'mock-cloud-poc', 160);
    const target = `output/noe-mission-poc/${missionId}/safe-patch.txt`;
    const patchPlan = {
      kind: 'noe_patch_plan',
      providerId: preflight.providerId,
      objective: clean(objective || evidencePack.objective || 'mock cloud patch plan', 4000),
      operations: [
        {
          id: 'write-safe-patch-proof',
          op: 'write_file',
          path: target,
          content: `mock cloud patch generated for ${missionId}\nprovider=${preflight.providerId}\n`,
        },
      ],
    };
    return normalizeNoeTaskOutput({
      ok: true,
      text: JSON.stringify(patchPlan, null, 2),
      patchPlan,
      provenance: 'cloud',
      provider: preflight.provider,
      model: preflight.model,
      brainRoute: 'cloud_change_lead',
      finishReason: 'stop',
      claimedSucceeded: true,
    });
  }

  async generateMiniMaxPatchPlan({ preflight = {}, evidencePack = {}, objective = '' } = {}) {
    const providerId = preflight.providerId || 'minimax-m3';
    const missionId = safeMissionId(evidencePack.missionId || 'minimax-cloud-poc');
    const secretResolution = this.resolveSecret?.('minimax', { env: this.env });
    const apiKey = secretResolution?.value || '';
    if (!apiKey && typeof this.runner !== 'function') {
      return normalizeNoeTaskOutput({
        ok: false,
        provenance: 'cloud',
        provider: 'minimax',
        model: preflight.model || 'MiniMax-M3',
        brainRoute: 'cloud_change_lead',
        text: 'MiniMax M3 API key unavailable for cloud patch planning.',
        finishReason: 'unavailable',
      });
    }
    const prompt = buildPatchPlanPrompt({ missionId, evidencePack, objective });
    let rawResponse = null;
    let rawReply = '';
    try {
      if (typeof this.runner === 'function') {
        rawResponse = await this.runner({ providerId, prompt, evidencePack, objective, model: preflight.model || 'MiniMax-M3' });
        rawReply = typeof rawResponse === 'string' ? rawResponse : clean(rawResponse?.reply || rawResponse?.content || rawResponse?.text || '', 100_000);
      } else {
        const adapter = new MiniMaxChatAdapter({
          apiKey,
          baseUrl: this.env.MINIMAX_BASE_URL,
          model: this.env.MINIMAX_MODEL || preflight.model || 'MiniMax-M3',
          maxCompletionTokens: 4096,
          reasoningSplit: true,
        });
        rawResponse = await adapter._doChat([{ role: 'user', content: prompt }], {
          model: this.env.MINIMAX_MODEL || preflight.model || 'MiniMax-M3',
          temperature: 0,
          maxCompletionTokens: 4096,
          noAbort: true,
          reasoningSplit: true,
        });
        rawReply = clean(rawResponse?.reply || '', 100_000);
      }
      const finishReason = clean(rawResponse?.finishReason || rawResponse?.finish_reason || rawResponse?.raw?.choices?.[0]?.finish_reason || 'stop', 80);
      if (finishReason === 'length' || rawResponse?.truncated === true) {
        return normalizeNoeTaskOutput({
          ok: false,
          text: rawReply,
          provenance: 'cloud',
          provider: 'minimax',
          model: preflight.model || 'MiniMax-M3',
          brainRoute: 'cloud_change_lead',
          finishReason: 'length',
          truncated: true,
          incomplete: true,
        });
      }
      const parsed = extractJson(rawReply);
      const normalized = normalizePatchPlan(parsed || {}, {
        missionId,
        providerId,
        objective: objective || evidencePack.objective || '',
      });
      if (!parsed || !normalized.ok) {
        return normalizeNoeTaskOutput({
          ok: false,
          text: rawReply,
          provenance: 'cloud',
          provider: 'minimax',
          model: preflight.model || 'MiniMax-M3',
          brainRoute: 'cloud_change_lead',
          finishReason,
          claimedSucceeded: false,
          evidenceRefs: [],
          patchPlan: normalized.patchPlan,
        });
      }
      return normalizeNoeTaskOutput({
        ok: true,
        text: JSON.stringify(normalized.patchPlan, null, 2),
        patchPlan: normalized.patchPlan,
        evidenceRefs: normalized.patchPlan.evidenceRefs,
        provenance: 'cloud',
        provider: 'minimax',
        model: preflight.model || 'MiniMax-M3',
        brainRoute: 'cloud_change_lead',
        finishReason,
        claimedSucceeded: false,
      });
    } catch (error) {
      return normalizeNoeTaskOutput({
        ok: false,
        text: clean(error?.message || error, 1000),
        provenance: 'cloud',
        provider: 'minimax',
        model: preflight.model || 'MiniMax-M3',
        brainRoute: 'cloud_change_lead',
        finishReason: 'error',
        claimedSucceeded: false,
      });
    }
  }
}

export { DEFAULT_PROVIDERS, buildPatchPlanPrompt, normalizePatchPlan };
