import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  assignLocalCouncilRoles,
  assertLocalCouncilLedgerSafe,
  classifyLocalModelCallIssue,
  cleanLocalCouncilReviewRounds,
  cleanVisibleLocalCouncilAnswer,
  discoverLocalModelProviders,
  evaluateLocalCouncilQuorum,
  runLocalModelCouncil,
  selectLocalCouncilModels,
} from '../../src/room/NoeLocalModelCouncil.js';

const MODELS = [
  { provider: 'lmstudio', id: 'qwen/qwen3.6-35b-a3b', baseUrl: 'http://lm.local/v1', paramB: 35 },
  { provider: 'lmstudio', id: 'qwen3.6-27b-architect-polaris-mxfp8-mlx', baseUrl: 'http://lm.local/v1', paramB: 27 },
  { provider: 'lmstudio', id: 'qwen-3-vl-8b-instruct', baseUrl: 'http://lm.local/v1', paramB: 8, vision: true },
  { provider: 'lmstudio', id: 'gemma-4-26b-a4b-it-qat-mlx', baseUrl: 'http://lm.local/v1', paramB: 26 },
  { provider: 'ollama', id: 'gemma3:4b', baseUrl: 'http://ollama.local', paramB: 4 },
  { provider: 'ollama', id: 'qwen2.5:7b', baseUrl: 'http://ollama.local', paramB: 7 },
];

function jsonResponse(body, ok = true, status = ok ? 200 : 500) {
  return { ok, status, text: async () => JSON.stringify(body) };
}

function vote(modelKey, decision = 'approve') {
  return { modelKey, decision, status: decision === 'unavailable' ? 'unavailable' : 'available' };
}

function combinations(items, size, start = 0, prefix = []) {
  if (prefix.length === size) return [prefix];
  const out = [];
  for (let i = start; i < items.length; i += 1) out.push(...combinations(items, size, i + 1, [...prefix, items[i]]));
  return out;
}

describe('NoeLocalModelCouncil', () => {
  it('clamps review rounds to the supported local discussion range', () => {
    expect(cleanLocalCouncilReviewRounds(undefined)).toBe(1);
    expect(cleanLocalCouncilReviewRounds(0)).toBe(1);
    expect(cleanLocalCouncilReviewRounds(2)).toBe(2);
    expect(cleanLocalCouncilReviewRounds(99)).toBe(3);
  });

  it('classifies local provider readiness failures for ledger health summaries', () => {
    expect(classifyLocalModelCallIssue('lmstudio HTTP 400: {"error":"Model unloaded."}')).toBe('model_unloaded');
    expect(classifyLocalModelCallIssue('lmstudio HTTP 500: Internal Server Error')).toBe('provider_server_error');
    expect(classifyLocalModelCallIssue('raw_json_parse_failed')).toBe('invalid_json_response');
  });

  it('discovers real LM Studio and Ollama models from provider APIs', async () => {
    const fetchImpl = async (url) => {
      if (String(url) === 'http://lm.local/v1/models') return jsonResponse({ data: [{ id: 'qwen/qwen3.6-35b-a3b' }, { id: 'qwen3.6-27b' }, { id: 'gemma-4-26b-a4b-it-qat-mlx' }, { id: 'gemma-4-26b-a4b-it-qat-assistant' }, { id: 'text-embedding-nomic-embed-text-v1.5' }] });
      if (String(url) === 'http://ollama.local/api/tags') return jsonResponse({ models: [{ name: 'gemma3:4b', capabilities: ['completion'] }, { name: 'embed:latest', capabilities: ['embedding'] }] });
      return jsonResponse({ error: 'nope' }, false, 404);
    };
    const out = await discoverLocalModelProviders({ fetchImpl, env: { LM_STUDIO_BASE_URL: 'http://lm.local/v1', OLLAMA_BASE_URL: 'http://ollama.local' } });

    expect(out.providers.map((p) => [p.id, p.available])).toEqual([['lmstudio', true], ['ollama', true]]);
    expect(out.models.map((m) => m.id)).toEqual(['qwen/qwen3.6-35b-a3b', 'qwen3.6-27b', 'gemma-4-26b-a4b-it-qat-mlx', 'gemma3:4b']);
    expect(out.models.map((m) => m.id)).not.toContain('text-embedding-nomic-embed-text-v1.5');
    expect(out.models.map((m) => m.id)).not.toContain('gemma-4-26b-a4b-it-qat-assistant');
    expect(out.recommendedRoles.reasoner.id).toBe('qwen/qwen3.6-35b-a3b');
  });

  it('assigns reasoner critic synthesizer and vision reviewer from discovered models', () => {
    const roles = assignLocalCouncilRoles(MODELS, { requiresVision: true });

    expect(roles.reasoner.id).toBe('qwen/qwen3.6-35b-a3b');
    expect(roles.critic.provider).toBe('ollama');
    expect(roles.synthesizer).toBeTruthy();
    expect(roles.visionReviewer.id).toContain('vl');
  });

  it('selects council participants across providers before filling same-provider slots', () => {
    const selected = selectLocalCouncilModels(MODELS, 3);

    expect(selected[0].provider).toBe('lmstudio');
    expect(selected.some((m) => m.provider === 'ollama')).toBe(true);
    expect(selected.filter((m) => m.provider === 'ollama')).toHaveLength(1);
    expect(selected).toHaveLength(3);
  });

  it('applies dynamic quorum across unavailable combinations', () => {
    const keys = ['a', 'b', 'c', 'd'];
    for (const missing of combinations(keys, 1)) {
      const available = keys.filter((k) => !missing.includes(k));
      const result = evaluateLocalCouncilQuorum(keys.map((k) => missing.includes(k) ? vote(k, 'unavailable') : vote(k, available.indexOf(k) < 2 ? 'approve' : 'reject')));
      expect(result.ok, missing.join(',')).toBe(true);
      expect(result.threshold).toBe(2);
      expect(result.availableCount).toBe(3);
    }
    for (const missing of combinations(keys, 2)) {
      const available = keys.filter((k) => !missing.includes(k));
      const result = evaluateLocalCouncilQuorum(keys.map((k) => missing.includes(k) ? vote(k, 'unavailable') : vote(k, available[0] === k ? 'approve' : 'reject')));
      expect(result.ok, missing.join(',')).toBe(false);
      expect(result.errors).toContain('insufficient_approvals:1/2');
    }
    for (const missing of combinations(keys, 3)) {
      const result = evaluateLocalCouncilQuorum(keys.map((k) => missing.includes(k) ? vote(k, 'unavailable') : vote(k, 'approve')));
      expect(result.ok, missing.join(',')).toBe(false);
      expect(result.errors).toContain('insufficient_available_models:1');
    }
  });

  it('stops council when fewer than two local models are available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    try {
      const out = await runLocalModelCouncil({ goal: 'test', roundId: 'one-model' }, { root: dir, discovery: { providers: [], models: [MODELS[0]] } });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('local_council_requires_two_models:1');
      expect(out.ledgerPath).toBe('output/noe-local-council/one-model/ledger.json');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes raw outputs and a redacted ledger for real provider calls', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    const fakeSecret = ['tp', 'testsecret000000000000000000000000000000'].join('-');
    const fetchImpl = async (url, opts = {}) => {
      const body = JSON.parse(opts.body || '{}');
      const prompt = JSON.stringify(body.messages || []);
      if (prompt.includes('交叉审阅者')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve_with_changes', risks: [`risk ${fakeSecret}`], evidence_gaps: ['gap'], accepted_points: ['point'], confidence: 0.6 }) } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
      if (String(url).endsWith('/chat/completions')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok ${fakeSecret}`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) } }], usage: { prompt_tokens: 1, completion_tokens: 2 } });
      if (String(url).endsWith('/api/chat')) return jsonResponse({ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.7 }) }, prompt_eval_count: 1, eval_count: 2 });
      return jsonResponse({ error: 'unexpected' }, false, 404);
    };
    try {
      const out = await runLocalModelCouncil({ goal: '落地本地 council', roundId: 'redacted-ledger' }, { root: dir, fetchImpl, discovery: { providers: [], models: MODELS.slice(0, 2) } });
      const ledger = JSON.parse(readFileSync(join(dir, out.ledgerPath), 'utf8'));
      const safe = assertLocalCouncilLedgerSafe(ledger);

      expect(out.ok).toBe(true);
      expect(ledger.participants.every((p) => p.rawOutputRef && p.rawOutputSha256)).toBe(true);
      expect(ledger.modelHealth.every((item) => item.ready === true && item.issue === '')).toBe(true);
      expect(ledger.discussion).toMatchObject({ reviewMode: 'ring-cross-review', reviewRoundsRequested: 1, reviewRoundsCompleted: 1, crossReviewCount: 2 });
      expect(ledger.crossReviews).toHaveLength(2);
      expect(ledger.crossReviews.every((r) => r.rawOutputRef.includes('cross-review-r1-'))).toBe(true);
      expect(ledger.crossReviews.every((r) => r.decision === 'approve_with_changes')).toBe(true);
      expect(JSON.stringify(ledger)).not.toContain(fakeSecret);
      expect(safe.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tries backup local models when an initially selected model becomes unavailable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    const fetchImpl = async (url, opts = {}) => {
      const body = JSON.parse(opts.body || '{}');
      const prompt = JSON.stringify(body.messages || []);
      if (body.model === 'gemma3:4b') return jsonResponse({ error: 'Internal Server Error' }, false, 500);
      if (prompt.includes('成员摘要')) return jsonResponse({ choices: [{ message: { content: 'backup final' } }], usage: {} });
      if (prompt.includes('交叉审阅者')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', risks: [], evidence_gaps: [], accepted_points: ['backup ok'], confidence: 0.7 }) } }], usage: {} });
      if (String(url).endsWith('/api/chat')) return jsonResponse({ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) }, prompt_eval_count: 1, eval_count: 2 });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) } }], usage: {} });
    };
    try {
      const out = await runLocalModelCouncil({ goal: 'backup model', roundId: 'backup-model', maxParticipants: 2 }, { root: dir, fetchImpl, discovery: { providers: [], models: MODELS } });
      const ledger = JSON.parse(readFileSync(join(dir, out.ledgerPath), 'utf8'));

      expect(out.ok).toBe(true);
      expect(out.warnings).toContain('local_council_backup_participants_used');
      expect(ledger.participants).toHaveLength(3);
      expect(out.crossReviewCount).toBe(2);
      expect(ledger.quorum).toMatchObject({ availableCount: 2, threshold: 2, approvedCount: 2 });
      expect(ledger.selection.backupForUnavailable).toHaveLength(1);
      expect(ledger.selection.backupForUnavailable[0].backupFor).toContain('ollama:gemma3:4b');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('raises too-small token budgets so JSON council responses are not truncated by caller input', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    const seen = [];
    const fetchImpl = async (url, opts = {}) => {
      const body = JSON.parse(opts.body || '{}');
      seen.push({ url: String(url), model: body.model, maxTokens: body.max_tokens ?? body.options?.num_predict });
      const prompt = JSON.stringify(body.messages || []);
      if (prompt.includes('成员摘要')) return jsonResponse({ choices: [{ message: { content: 'token floor final' } }], usage: {} });
      if (prompt.includes('交叉审阅者')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', risks: [], evidence_gaps: [], accepted_points: [], confidence: 0.7 }) } }], usage: {} });
      if (String(url).endsWith('/api/chat')) return jsonResponse({ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) }, prompt_eval_count: 1, eval_count: 2 });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) } }], usage: {} });
    };
    try {
      const out = await runLocalModelCouncil({
        goal: 'token floor',
        roundId: 'token-floor',
        maxTokens: 32,
        reviewMaxTokens: 48,
        synthesisMaxTokens: 64,
      }, { root: dir, fetchImpl, discovery: { providers: [], models: MODELS.slice(0, 2) } });

      expect(out.ok).toBe(true);
      expect(seen.filter((item) => !String(item.url).includes('/api/chat')).map((item) => item.maxTokens)).toEqual(expect.arrayContaining([512, 640]));
      expect(Math.min(...seen.map((item) => item.maxTokens))).toBeGreaterThanOrEqual(512);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not run cross review when fewer than two models are available', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    const fetchImpl = async (url) => {
      if (String(url).endsWith('/chat/completions')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', answer: 'ok', risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) } }], usage: {} });
      return jsonResponse({ error: 'unexpected' }, false, 404);
    };
    try {
      const out = await runLocalModelCouncil({ goal: 'single available review skip', roundId: 'single-review-skip' }, { root: dir, fetchImpl, discovery: { providers: [], models: [MODELS[0]] } });
      const ledger = JSON.parse(readFileSync(join(dir, out.ledgerPath), 'utf8'));

      expect(out.ok).toBe(false);
      expect(ledger.crossReviews).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleans internal thought markers from visible final answers', () => {
    const cleaned = cleanVisibleLocalCouncilAnswer('<|channel>thought\\nprivate reasoning\\n<|channel>final\\n最终答案');

    expect(cleaned).toBe('最终答案');
    expect(cleaned).not.toContain('<|channel>thought');
  });

  it('extracts visible finalAnswer fields from fenced synthesis JSON', () => {
    const cleaned = cleanVisibleLocalCouncilAnswer('```json\n{"decision":"approve","finalAnswer":"最终中文答案","confidence":0.9}\n```');

    expect(cleaned).toBe('最终中文答案');
    expect(cleaned).not.toContain('```');
    expect(cleaned).not.toContain('"decision"');
  });

  it('blocks synthesis when a synthesizer returns thought-only content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    const fetchImpl = async (url, opts = {}) => {
      const body = JSON.parse(opts.body || '{}');
      const prompt = JSON.stringify(body.messages || []);
      if (prompt.includes('成员摘要')) return jsonResponse({ choices: [{ message: { content: '<|channel>thought\\nonly hidden reasoning' } }], usage: {} });
      if (prompt.includes('交叉审阅者')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', risks: [], evidence_gaps: [], accepted_points: [], confidence: 0.6 }) } }], usage: {} });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', answer: 'visible member answer', risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) } }], usage: {} });
    };
    try {
      const out = await runLocalModelCouncil({ goal: 'thought only synthesis', roundId: 'thought-only-synthesis' }, { root: dir, fetchImpl, discovery: { providers: [], models: MODELS.slice(0, 2) } });
      const ledger = JSON.parse(readFileSync(join(dir, out.ledgerPath), 'utf8'));

      expect(out.ok).toBe(false);
      expect(ledger.finalAnswer).toBe('');
      expect(ledger.blockers).toContain('synthesis_visible_answer_missing');
      expect(JSON.stringify(ledger)).not.toContain('<|channel>thought');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a usable approved participant when the assigned synthesizer was not parseable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    const fetchImpl = async (url, opts = {}) => {
      const body = JSON.parse(opts.body || '{}');
      const prompt = JSON.stringify(body.messages || []);
      if (prompt.includes('成员摘要')) return jsonResponse({ choices: [{ message: { content: `final from ${body.model}` } }], usage: {} });
      if (prompt.includes('交叉审阅者')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', risks: [], evidence_gaps: [], accepted_points: [], confidence: 0.6 }) } }], usage: {} });
      if (body.model === MODELS[1].id) return jsonResponse({ choices: [{ message: { content: 'not json' } }], usage: {} });
      if (String(url).endsWith('/api/chat')) return jsonResponse({ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) }, prompt_eval_count: 1, eval_count: 2 });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) } }], usage: {} });
    };
    try {
      const out = await runLocalModelCouncil({ goal: 'synth fallback', roundId: 'synth-fallback' }, { root: dir, fetchImpl, discovery: { providers: [], models: MODELS.slice(0, 3) } });
      const ledger = JSON.parse(readFileSync(join(dir, out.ledgerPath), 'utf8'));

      expect(out.ok).toBe(true);
      expect(ledger.synthesis.modelKey).toBe(`${MODELS[2].provider}:${MODELS[2].id}`);
      expect(ledger.finalAnswer).toBe(`final from ${MODELS[2].id}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not embed provider reasoning-only raw API objects into parsed ledger fields', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    const fetchImpl = async (url, opts = {}) => {
      const body = JSON.parse(opts.body || '{}');
      const prompt = JSON.stringify(body.messages || []);
      if (prompt.includes('交叉审阅者')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', risks: [], evidence_gaps: [], accepted_points: [], confidence: 0.6 }) } }], usage: {} });
      if (body.model === MODELS[0].id) return jsonResponse({ choices: [{ message: { content: '', reasoning_content: 'private chain of thought' } }], usage: {} });
      if (String(url).endsWith('/api/chat')) return jsonResponse({ message: { content: JSON.stringify({ decision: 'approve', answer: 'visible answer', risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) }, prompt_eval_count: 1, eval_count: 2 });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', answer: 'visible answer', risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) } }], usage: {} });
    };
    try {
      const out = await runLocalModelCouncil({ goal: 'raw reasoning only', roundId: 'raw-reasoning-only' }, { root: dir, fetchImpl, discovery: { providers: [], models: MODELS.slice(0, 3) } });
      const ledger = JSON.parse(readFileSync(join(dir, out.ledgerPath), 'utf8'));
      const reasoner = ledger.participants.find((p) => p.modelKey === `${MODELS[0].provider}:${MODELS[0].id}`);

      expect(reasoner.parsed).toBeNull();
      expect(reasoner.status).toBe('unavailable');
      expect(reasoner.decision).toBe('unavailable');
      expect(reasoner.errors).toContain('raw_json_parse_failed');
      expect(reasoner.health).toMatchObject({ ready: false, issue: 'invalid_json_response' });
      expect(ledger.modelHealth.find((item) => item.modelKey === `${MODELS[0].provider}:${MODELS[0].id}`)).toMatchObject({ ready: false, issue: 'invalid_json_response' });
      expect(JSON.stringify(ledger.participants)).not.toContain('private chain of thought');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses backup models when selected local models return reasoning-only content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    const fetchImpl = async (url, opts = {}) => {
      const body = JSON.parse(opts.body || '{}');
      const prompt = JSON.stringify(body.messages || []);
      if (body.model === MODELS[0].id) return jsonResponse({ choices: [{ message: { content: '', reasoning_content: 'private reasoning only' } }], usage: {} });
      if (String(url).endsWith('/api/chat') && prompt.includes('成员摘要')) return jsonResponse({ message: { content: 'backup visible final' }, prompt_eval_count: 1, eval_count: 2 });
      if (prompt.includes('成员摘要')) return jsonResponse({ choices: [{ message: { content: 'backup visible final' } }], usage: {} });
      if (prompt.includes('交叉审阅者')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', risks: [], evidence_gaps: [], accepted_points: ['backup'], confidence: 0.7 }) } }], usage: {} });
      if (String(url).endsWith('/api/chat')) return jsonResponse({ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) }, prompt_eval_count: 1, eval_count: 2 });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) } }], usage: {} });
    };
    try {
      const out = await runLocalModelCouncil({ goal: 'reasoning backup', roundId: 'reasoning-backup', maxParticipants: 2 }, { root: dir, fetchImpl, discovery: { providers: [], models: MODELS } });
      const ledger = JSON.parse(readFileSync(join(dir, out.ledgerPath), 'utf8'));

      expect(out.ok).toBe(true);
      expect(out.warnings).toContain('local_council_backup_participants_used');
      expect(ledger.participants.find((p) => p.modelKey === `${MODELS[0].provider}:${MODELS[0].id}`)).toMatchObject({ status: 'unavailable', decision: 'unavailable' });
      expect(ledger.selection.backupForUnavailable[0].backupFor).toBe(`${MODELS[0].provider}:${MODELS[0].id}`);
      expect(ledger.quorum).toMatchObject({ availableCount: 2, threshold: 2, approvedCount: 2 });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runs multiple cross-review rounds and feeds review summaries into synthesis', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    let synthesisPrompt = '';
    const fetchImpl = async (url, opts = {}) => {
      const body = JSON.parse(opts.body || '{}');
      const prompt = JSON.stringify(body.messages || []);
      if (prompt.includes('成员摘要')) {
        synthesisPrompt = prompt;
        return jsonResponse({ choices: [{ message: { content: 'multi-round final' } }], usage: {} });
      }
      if (prompt.includes('交叉审阅者')) {
        return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve_with_changes', risks: [`risk from ${body.model}`], evidence_gaps: [], accepted_points: ['accepted'], confidence: 0.7 }) } }], usage: {} });
      }
      if (String(url).endsWith('/api/chat')) return jsonResponse({ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) }, prompt_eval_count: 1, eval_count: 2 });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) } }], usage: {} });
    };
    try {
      const out = await runLocalModelCouncil({ goal: 'two round council', roundId: 'two-round-council', reviewRounds: 2 }, { root: dir, fetchImpl, discovery: { providers: [], models: MODELS.slice(0, 3) } });
      const ledger = JSON.parse(readFileSync(join(dir, out.ledgerPath), 'utf8'));

      expect(out.ok).toBe(true);
      expect(out.reviewRounds).toBe(2);
      expect(out.crossReviewCount).toBe(6);
      expect(ledger.discussion).toMatchObject({ reviewRoundsRequested: 2, reviewRoundsCompleted: 2, crossReviewCount: 6 });
      expect(ledger.crossReviews.map((r) => r.round)).toEqual([1, 1, 1, 2, 2, 2]);
      expect(synthesisPrompt).toContain('交叉审阅摘要');
      expect(synthesisPrompt).toContain('risk from');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports when participant count is above the default without claiming a hard cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-local-council-'));
    const fetchImpl = async (url, opts = {}) => {
      const body = JSON.parse(opts.body || '{}');
      const prompt = JSON.stringify(body.messages || []);
      if (prompt.includes('成员摘要') && String(url).endsWith('/api/chat')) return jsonResponse({ message: { content: 'five model final' }, prompt_eval_count: 1, eval_count: 2 });
      if (prompt.includes('成员摘要')) return jsonResponse({ choices: [{ message: { content: 'five model final' } }], usage: {} });
      if (prompt.includes('交叉审阅者')) return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', risks: [], evidence_gaps: [], accepted_points: [], confidence: 0.7 }) } }], usage: {} });
      if (String(url).endsWith('/api/chat')) return jsonResponse({ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) }, prompt_eval_count: 1, eval_count: 2 });
      return jsonResponse({ choices: [{ message: { content: JSON.stringify({ decision: 'approve', answer: `${body.model} ok`, risks: [], evidence_gaps: [], actions: [], confidence: 0.8 }) } }], usage: {} });
    };
    try {
      const models = [...MODELS, { provider: 'ollama', id: 'deepseek-r1:8b', baseUrl: 'http://ollama.local', paramB: 8 }];
      const out = await runLocalModelCouncil({ goal: 'five participants', roundId: 'five-participants', maxParticipants: 5 }, { root: dir, fetchImpl, discovery: { providers: [], models } });

      expect(out.ok).toBe(true);
      expect(out.participants).toHaveLength(5);
      expect(out.warnings).toEqual(['local_council_participants_above_default_4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
