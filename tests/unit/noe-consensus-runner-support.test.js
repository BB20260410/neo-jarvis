import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  buildNoeCodexOutFile,
  buildNoeConsensusPrompt,
  buildNoeConsensusM3Options,
  runNoeConsensusRound,
} from '../../src/room/NoeConsensusRunner.js';

const participantRuntimeSource = readFileSync(join(process.cwd(), 'src/room/NoeConsensusParticipantRuntime.js'), 'utf8');

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'noe-consensus-runner-'));
}

function raw(model, decision = 'approve_with_changes', extra = {}) {
  const authority = model === 'codex' ? 'writer_integrator' : model === 'm3' ? 'suggestion_only' : model === 'claude' ? 'readonly_source_reviewer' : 'advisory';
  return JSON.stringify({
    model,
    decision,
    confidence: 0.88,
    authority,
    canWrite: model === 'codex',
    firstClass: model === 'claude' ? true : undefined,
    blockers: [],
    recommended_first_slice: ['runner'],
    verification_required: ['test:noe:consensus'],
    consensus_vote: 'yes',
    ...extra,
  }, null, 2);
}

function rawForActiveExecutor(model, activeExecutor, decision = 'approve_with_changes', extra = {}) {
  const canWrite = model === activeExecutor;
  const authority = canWrite ? 'active_executor' : model === 'm3' ? 'suggestion_only' : 'advisory';
  return raw(model, decision, { authority, canWrite, ...extra });
}

describe('Noe consensus runner support modules', () => {
  it('builds prompts with role-specific authority and hard boundaries', () => {
    const prompt = buildNoeConsensusPrompt({
      model: 'm3',
      goal: 'self evolution',
      evidenceRef: 'output/noe-multimodel/r/brief.md',
      evidenceText: 'evidence',
    });

    expect(prompt).toContain('"authority": "suggestion_only"');
    expect(prompt).toContain('No artificial model timeout');
    expect(prompt).toContain('51735 is reserved');
    expect(prompt).toContain('You are not being asked to rubber-stamp approval');
    expect(prompt).toContain('reject means this model does not authorize the current goal or claim; use consensus_vote=no');
    expect(prompt).toContain('If decision is approve or approve_with_changes, consensus_vote must be yes');
    expect(prompt).toContain('Codex may provide an automatic supplemental fallback review');
    expect(prompt).toContain('Core participants counted in this round: Codex, Claude, M3');
    expect(prompt).toContain('M3 finding scope is limited to actionable_risk, evidence_gap, and product_language_issue');
    expect(prompt).toContain('Quality profile: exhaustive.');
    expect(prompt).toContain('Token cost is not the limiting factor');
    expect(prompt).toContain('Classify findings as P0/P1/P2');
    expect(prompt).toContain('For live 51835, sealed holdout, owner-token, or restart claims');
    expect(prompt).not.toContain('Xiaomi MiMo is optional advisory evidence');
  });

  it('builds non-core advisory prompts without making them default quorum members', () => {
    const prompt = buildNoeConsensusPrompt({
      model: 'xiaomi',
      goal: 'self evolution',
      evidenceRef: 'output/noe-multimodel/r/brief.md',
      evidenceText: 'evidence',
    });

    expect(prompt).toContain('"model": "xiaomi"');
    expect(prompt).toContain('"authority": "advisory"');
    expect(prompt).toContain('"canWrite": false');
    expect(prompt).toContain('This is an explicit non-core advisory profile');
    expect(prompt).toContain('A non-core advisory participant must not be counted in quorum unless requiredModels explicitly includes it');
  });

  it('builds Claude prompts that allow independent rejection instead of blind approval', () => {
    const prompt = buildNoeConsensusPrompt({
      model: 'claude',
      goal: 'health audit',
      evidenceRef: 'output/noe-multimodel/r/brief.md',
      evidenceText: 'voice-ear failed with zero-byte outputs',
    });

    expect(prompt).toContain('Return one JSON object only. No Markdown, prose, tool calls, or follow-up questions.');
    expect(prompt).toContain('Do not assume approve or consensus_vote=yes');
    expect(prompt).toContain('For health audits, failed live verification is a valid reason to reject a full-health claim');
    expect(prompt).toContain('"firstClass": true');
  });

  it('sanitizes built-in model CLI spawn environment instead of inheriting full process env', () => {
    expect(participantRuntimeSource).toContain("import { buildNoeSafeChildProcessEnv } from '../security/NoeHostExecEnv.js'");
    expect(participantRuntimeSource).toContain('env: buildNoeSafeChildProcessEnv(process.env');
    expect(participantRuntimeSource).not.toContain('env: { ...process.env');
  });

  it('builds Claude active-executor prompts without making Codex the writer', () => {
    const claudePrompt = buildNoeConsensusPrompt({
      model: 'claude',
      goal: 'self evolution',
      evidenceRef: 'output/noe-multimodel/r/brief.md',
      evidenceText: 'evidence',
      activeExecutor: 'claude',
    });
    const codexPrompt = buildNoeConsensusPrompt({
      model: 'codex',
      goal: 'self evolution',
      evidenceRef: 'output/noe-multimodel/r/brief.md',
      evidenceText: 'evidence',
      activeExecutor: 'claude',
    });

    expect(claudePrompt).toContain('"authority": "active_executor"');
    expect(claudePrompt).toContain('"canWrite": true');
    expect(codexPrompt).toContain('"authority": "advisory"');
    expect(codexPrompt).toContain('"canWrite": false');
    expect(codexPrompt).toContain('Active executor for this round: claude');
  });

  it('writes a valid Claude active-executor ledger when explicitly selected', async () => {
    const root = makeRoot();
    const runners = Object.fromEntries(['codex', 'claude', 'm3'].map((model) => [
      model,
      async () => rawForActiveExecutor(model, 'claude', 'approve_with_changes', {
        firstClass: model === 'claude' ? true : undefined,
      }),
    ]));

    const result = await runNoeConsensusRound({
      roundId: 'claude-executor-run',
      goal: 'Noe self evolution with Claude executor',
      evidenceText: 'evidence',
      activeExecutor: 'claude',
      executorSelection: { selectedBy: 'user', reason: 'codex_quota_unavailable' },
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });
    const ledger = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/claude-executor-run/ledger.json'), 'utf8'));

    expect(result.ok).toBe(true);
    expect(ledger.implementation).toMatchObject({
      writer: 'claude',
      activeExecutor: 'claude',
      executorSelection: { selectedBy: 'user' },
    });
    expect(ledger.boundaries).toContain('active_executor_single_writer');
    expect(ledger.boundaries).not.toContain('codex_only_writer');
  });

  it('does not treat unavailable Codex as writer when Claude is the active executor', async () => {
    const root = makeRoot();
    const runners = {
      codex: async () => { throw new Error('codex unavailable'); },
      claude: async () => rawForActiveExecutor('claude', 'claude'),
      m3: async () => rawForActiveExecutor('m3', 'claude'),
    };

    const result = await runNoeConsensusRound({
      roundId: 'claude-executor-codex-unavailable',
      goal: 'Noe self evolution with Claude executor',
      evidenceText: 'evidence',
      activeExecutor: 'claude',
      executorSelection: { selectedBy: 'user', reason: 'codex_unavailable' },
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    expect(result.ok).toBe(true);
    expect(result.validation.consensus.unavailable).toEqual(['codex']);
    expect(result.validation.errors).not.toContain('codex_must_not_write_when_not_active_executor');
    const ledger = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/claude-executor-codex-unavailable/ledger.json'), 'utf8'));
    expect(ledger.votes.find((vote) => vote.model === 'codex')).toMatchObject({
      decision: 'unavailable',
      canWrite: false,
      authority: 'advisory',
    });
  });

  it('blocks when the selected active executor is unavailable', async () => {
    const root = makeRoot();
    const runners = {
      codex: async () => rawForActiveExecutor('codex', 'claude'),
      claude: async () => { throw new Error('claude unavailable'); },
      m3: async () => rawForActiveExecutor('m3', 'claude'),
    };

    const result = await runNoeConsensusRound({
      roundId: 'claude-executor-unavailable',
      goal: 'Noe self evolution with Claude executor',
      evidenceText: 'evidence',
      activeExecutor: 'claude',
      executorSelection: { selectedBy: 'user', reason: 'claude_requested' },
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    expect(result.ok).toBe(false);
    expect(result.validation.errors).toContain('active_executor_unavailable:claude');
  });

  it('dry-runs by writing brief and manifest without raw outputs', async () => {
    const root = makeRoot();
    const result = await runNoeConsensusRound({
      roundId: 'dry-run',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: false,
    }, { root });

    expect(result.status).toBe('dry_run');
    expect(existsSync(join(root, 'output/noe-multimodel/dry-run/brief.md'))).toBe(true);
    expect(existsSync(join(root, 'output/noe-multimodel/dry-run/manifest.json'))).toBe(true);
    expect(existsSync(join(root, 'output/noe-multimodel/dry-run/evidence.md'))).toBe(true);
    expect(existsSync(join(root, 'output/noe-multimodel/dry-run/evidence-pack.md'))).toBe(true);
    expect(existsSync(join(root, 'output/noe-multimodel/dry-run/disagreements.md'))).toBe(true);
    expect(existsSync(join(root, 'output/noe-multimodel/dry-run/staleness-ledger.md'))).toBe(true);
    expect(existsSync(join(root, 'output/noe-multimodel/dry-run/verifier-notes.md'))).toBe(true);
    expect(existsSync(join(root, 'output/noe-multimodel/dry-run/final-handoff.md'))).toBe(true);
    expect(existsSync(join(root, 'output/noe-multimodel/dry-run/codex.txt'))).toBe(false);
    const brief = readFileSync(join(root, 'output/noe-multimodel/dry-run/brief.md'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/dry-run/manifest.json'), 'utf8'));
    const handoff = readFileSync(join(root, 'output/noe-multimodel/dry-run/final-handoff.md'), 'utf8');
    expect(brief).toContain('## Quality Profile');
    expect(brief).toContain('Quality profile: exhaustive.');
    expect(manifest.qualityProfile).toBe('exhaustive');
    expect(manifest.supportFiles).toMatchObject({
      evidence: 'output/noe-multimodel/dry-run/evidence.md',
      evidencePack: 'output/noe-multimodel/dry-run/evidence-pack.md',
      disagreements: 'output/noe-multimodel/dry-run/disagreements.md',
      stalenessLedger: 'output/noe-multimodel/dry-run/staleness-ledger.md',
      verifierNotes: 'output/noe-multimodel/dry-run/verifier-notes.md',
      finalHandoff: 'output/noe-multimodel/dry-run/final-handoff.md',
    });
    expect(handoff).toContain('status: dry_run');
    expect(manifest.qualityInstructions).toEqual(expect.arrayContaining([
      expect.stringContaining('Token cost is not the limiting factor'),
    ]));
  });

  it('allows a standard quality profile when explicitly requested', async () => {
    const root = makeRoot();
    await runNoeConsensusRound({
      roundId: 'standard-quality',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      qualityProfile: 'standard',
      runModels: false,
    }, { root });

    const brief = readFileSync(join(root, 'output/noe-multimodel/standard-quality/brief.md'), 'utf8');
    const manifest = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/standard-quality/manifest.json'), 'utf8'));

    expect(brief).toContain('Quality profile: standard.');
    expect(brief).not.toContain('Token cost is not the limiting factor');
    expect(manifest.qualityProfile).toBe('standard');
  });

  it('records provider secret source status in manifests without secret values', async () => {
    const root = makeRoot();
    await runNoeConsensusRound({
      roundId: 'secret-manifest',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: false,
    }, {
      root,
      secretResolver(provider) {
        if (provider === 'minimax') return {
          ok: true,
          value: 'secret-value-must-not-leak',
          source: 'keychain sk-source-secret-that-must-not-leak',
          sourceRef: 'MINIMAX_API_KEY=sk-ref-secret-that-must-not-leak',
        };
        return { ok: false, source: 'unconfigured' };
      },
    });
    const manifest = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/secret-manifest/manifest.json'), 'utf8'));
    const m3 = manifest.participants.find((item) => item.model === 'm3');
    const xiaomi = manifest.participants.find((item) => item.model === 'xiaomi');

    expect(m3.secretStatus).toMatchObject({
      provider: 'minimax',
      configured: true,
      source: 'keychain [redacted-openai-key]',
      sourceRef: 'MINIMAX_API_KEY=[redacted]',
    });
    expect(xiaomi).toBeUndefined();
    expect(JSON.stringify(manifest)).not.toContain('secret-value-must-not-leak');
    expect(JSON.stringify(manifest)).not.toContain('sk-source-secret-that-must-not-leak');
    expect(JSON.stringify(manifest)).not.toContain('sk-ref-secret-that-must-not-leak');
  });

  it('does not claim built-in M3 thinking options when M3 uses an injected runner', async () => {
    const root = makeRoot();
    await runNoeConsensusRound({
      roundId: 'injected-m3-runner',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: false,
    }, {
      root,
      runners: {
        m3: async () => raw('m3'),
      },
    });
    const manifest = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/injected-m3-runner/manifest.json'), 'utf8'));
    const m3 = manifest.participants.find((item) => item.model === 'm3');

    expect(m3.runner).toBe('injected_runner');
    expect(m3.modelOptions).toBeUndefined();
  });

  it('uses MiniMax-M3 maximum adaptive thinking profile for built-in exhaustive M3 consensus calls', async () => {
    const root = makeRoot();
    const seen = [];
    vi.stubGlobal('fetch', async (url, init) => {
      seen.push({ url, body: JSON.parse(init.body), headers: init.headers });
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: raw('m3') }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    });
    try {
      const result = await runNoeConsensusRound({
        roundId: 'm3-adaptive-thinking',
        goal: 'Noe self evolution',
        evidenceText: 'evidence',
        runModels: true,
        costAcknowledged: true,
      }, {
        root,
        runners: {
          codex: async () => raw('codex'),
          claude: async () => raw('claude'),
        },
        secretResolver(provider) {
          if (provider === 'minimax') return { ok: true, value: 'secret-value-must-not-leak', source: 'test', sourceRef: 'MINIMAX_API_KEY' };
          return { ok: false, source: 'unconfigured' };
        },
      });
      const manifest = JSON.parse(readFileSync(join(root, 'output/noe-multimodel/m3-adaptive-thinking/manifest.json'), 'utf8'));
      const m3 = manifest.participants.find((item) => item.model === 'm3');

      expect(result.ok).toBe(true);
      expect(seen).toHaveLength(1);
      expect(seen[0].body).toMatchObject({
        model: 'MiniMax-M3',
        max_completion_tokens: 524288,
        reasoning_split: true,
        service_tier: 'priority',
        thinking: { type: 'adaptive' },
      });
      expect(buildNoeConsensusM3Options()).toMatchObject({
        model: 'MiniMax-M3',
        noAbort: true,
        maxCompletionTokens: 524288,
        reasoningSplit: true,
        serviceTier: 'priority',
        thinking: { type: 'adaptive' },
      });
      expect(m3.modelOptions).toMatchObject({
        model: 'MiniMax-M3',
        thinking: { type: 'adaptive' },
        maxCompletionTokens: 524288,
        reasoningSplit: true,
        serviceTier: 'priority',
        noAbort: true,
      });
      expect(JSON.stringify(manifest)).not.toContain('secret-value-must-not-leak');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('redacts secret-like model output before writing raw outputs and ledger', async () => {
    const root = makeRoot();
    const fakeSecret = 'tp-unit-redacted-secret-that-must-not-be-stored';
    const runners = Object.fromEntries(['codex', 'claude', 'm3'].map((model) => [
      model,
      async () => raw(model, 'approve_with_changes', {
        blockers: model === 'm3' ? [`saw ${fakeSecret}`] : [],
      }),
    ]));

    await runNoeConsensusRound({
      roundId: 'secret-redaction-run',
      goal: 'Noe self evolution',
      evidenceText: 'evidence',
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    const rawText = readFileSync(join(root, 'output/noe-multimodel/secret-redaction-run/m3.txt'), 'utf8');
    const ledgerText = readFileSync(join(root, 'output/noe-multimodel/secret-redaction-run/ledger.json'), 'utf8');
    expect(rawText).not.toContain(fakeSecret);
    expect(ledgerText).not.toContain(fakeSecret);
    expect(rawText).toContain('[redacted-api-key]');
    expect(ledgerText).toContain('[redacted-api-key]');
  });

  it('redacts secret-like evidence text before writing shared docs or prompting models', async () => {
    const root = makeRoot();
    const fakeSecret = 'sk-evidence-secret-that-must-not-be-stored-1234567890';
    const seenPrompts = [];
    const runners = Object.fromEntries(['codex', 'claude', 'm3'].map((model) => [
      model,
      async (args) => {
        seenPrompts.push(args.prompt);
        return raw(model);
      },
    ]));

    await runNoeConsensusRound({
      roundId: 'evidence-redaction-run',
      goal: 'Noe self evolution',
      evidenceText: `direct evidence ${fakeSecret}`,
      runModels: true,
      costAcknowledged: true,
    }, { root, runners });

    for (const prompt of seenPrompts) expect(prompt).not.toContain(fakeSecret);
    const sharedText = [
      'brief.md',
      'evidence.md',
      'evidence-pack.md',
      'manifest.json',
    ].map((file) => readFileSync(join(root, 'output/noe-multimodel/evidence-redaction-run', file), 'utf8')).join('\n');
    expect(sharedText).not.toContain(fakeSecret);
    expect(sharedText).toContain('[redacted-openai-key]');
  });

  it('builds the Codex CLI output path inside the round directory', () => {
    const rawOutputFile = '/tmp/noe/output/noe-multimodel/r/codex.txt';

    expect(buildNoeCodexOutFile(rawOutputFile)).toBe('/tmp/noe/output/noe-multimodel/r/codex.txt.codex-out.txt');
    expect(buildNoeCodexOutFile('')).toBe('');
  });
});
