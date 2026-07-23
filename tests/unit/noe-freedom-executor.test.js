import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildNoeFreedomCatalog, runNoeFreedomAction } from '../../src/runtime/NoeFreedomExecutor.js';
import { SHELL_BIN } from '../../src/runtime/NoeFreedomAdapters.js';
import { NoeSecretBroker } from '../../src/secrets/NoeSecretBroker.js';
import { writeNoeFreedomRunLedgerFile } from '../../src/runtime/NoeFreedomRunLedger.js';
import { createNoeSocialDraft } from '../../src/runtime/NoeSocialPublishQueue.js';

const auth = {
  mode: 'owner_supervised_unrestricted',
  ownerPresent: true,
  allowlistAccepted: true,
  rollbackPlan: 'test rollback plan',
};

function trustManifest(operation, scopes = {}, rollbackPlan = 'test rollback plan') {
  return {
    id: `${operation}-trust`,
    operation,
    executionModes: ['dry_run', 'owner_supervised_unrestricted'],
    scopes,
    rollbackPlan,
    evidence: { required: true, secretValuesDenied: true },
  };
}

function allowlist(operation, scopes = {}) {
  return {
    id: `${operation}-allowlist`,
    scopes: {
      operations: [operation],
      ...scopes,
    },
  };
}

describe('NoeFreedomExecutor', () => {
  it('publishes developer unrestricted maximum-permission profile in the catalog', () => {
    const catalog = buildNoeFreedomCatalog();

    expect(catalog.developerMode).toMatchObject({
      mode: 'developer_unrestricted',
      skipsTrustManifestAndAllowlist: true,
      canUseLoggedInAccounts: true,
      canControlAllOwnerAuthorizedAccounts: true,
      canUseBrowserLoggedInSessions: true,
      canUseSecretRefs: true,
      canUseKeychainSecretRefs: true,
      canUseEnvSecretRefs: true,
      canUseSshAgentAndConfiguredKeys: true,
      canRunLocalShell: true,
      canRunSsh: true,
      canRunMacAutomation: true,
      canOpenBrowserAccounts: true,
      canPublishExternally: true,
      canUploadFiles: true,
      canUseToolMarketplace: true,
      hardVetoes: [
        'system_root_delete',
        'codex_runtime_delete',
        'secret_plaintext_output',
      ],
    });
    expect(catalog.developerMode.allowedCapabilityPrefixes).toEqual(expect.arrayContaining([
      'shell.',
      'ssh.',
      'secret.',
      'desktop.',
      'browser.',
      'automation.',
      'social.',
      'network.',
      'tool.',
      'workflow.',
    ]));
    expect(JSON.stringify(catalog.developerMode)).not.toMatch(/sk-|tp-|AIza|password=|cookie=/i);
  });

  it('dry-runs unrestricted shell without executing and redacts secret-like args', async () => {
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo tp-unitsecret000000000000000000000000000000' },
      realExecute: false,
    });

    expect(out.ok).toBe(true);
    expect(out.dryRunOnly).toBe(true);
    expect(out.runtime).toMatchObject({ plannedOnly: true, wouldExecute: 'noe.freedom.shell.execute' });
    expect(JSON.stringify(out)).not.toContain('tp-unitsecret');
  });

  it('adds safe semantic context to Freedom action evidence without collecting command text', async () => {
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: {
        command: 'echo tp-unitsecret000000000000000000000000000000',
        goalTitle: 'settle owner-visible delivery evidence',
        expectedClaim: 'owner expects delivery evidence to be visible',
        stepText: 'write readiness audit with delivery evidence',
      },
      authorization: {
        mode: 'dry_run',
        reason: 'prove semantic context for expectation calibration',
      },
      realExecute: false,
    });

    expect(out.ok).toBe(true);
    expect(out.evidence.semanticTrace.goal.join(' ')).toContain('settle owner-visible delivery evidence');
    expect(out.evidence.semanticTrace.expectation.join(' ')).toContain('owner expects delivery evidence to be visible');
    expect(out.evidence.semanticTrace.checkpoint.join(' ')).toContain('write readiness audit with delivery evidence');
    expect(out.evidence.semanticTrace.summary.join(' ')).toContain('prove semantic context for expectation calibration');
    expect(JSON.stringify(out.evidence.semanticTrace)).not.toContain('tp-unitsecret');
    expect(JSON.stringify(out.evidence.semanticTrace)).not.toContain('echo');
  });

  it('blocks real execution without explicit owner-supervised authorization', async () => {
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo should-not-run' },
      realExecute: true,
      authorization: { mode: 'dry_run' },
    });

    expect(out.ok).toBe(false);
    expect(out.blockers).toContain('owner_supervised_unrestricted_required_for_real_execute');
    expect(out.runtime).toBe(null);
  });

  it('adds Review Brain preflight metadata for high-risk real actions before final execution', async () => {
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.social.final_publish.execute',
      args: { platform: 'douyin', draftId: '' },
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
        reason: 'unit test high-risk publish preflight',
      },
    });

    expect(out.reviewBrainPreflight).toMatchObject({
      required: true,
      brain: {
        role: 'review',
        model: 'qwen/qwen3.6-27b',
        loadModel: 'qwen/qwen3.6-27b@4bit',
      },
      request: {
        responseFormat: 'json_schema_when_possible',
        max_tokens: 4096,
      },
    });
    expect(out.reviewBrainPreflight.request.user.requiredChecks).toContain('rollbackPlan');
    expect(JSON.stringify(out.reviewBrainPreflight)).not.toMatch(/token=|sk-|cookie=/i);
  });

  it('redacts secrets embedded in the review brain preflight reason before it reaches the model or HTTP response', async () => {
    // reason 会喂给本地复核脑 messages 且随 result.reviewBrainPreflight 经 /api/noe/freedom/execute 响应回传，
    // 必须先脱敏（owner 宪法「防外泄照修」）。对抗审查复现的 med 脱敏缺口返工。
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.social.final_publish.execute',
      args: { platform: 'douyin', draftId: '' },
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
        reason: 'authorize publish with sk-reasonsecret000000000000000000000000000000 key',
      },
    });

    expect(out.reviewBrainPreflight.request.user.reason).not.toContain('sk-reasonsecret');
    expect(out.reviewBrainPreflight.request.user.reason).toContain('[redacted');
    expect(JSON.stringify(out.reviewBrainPreflight)).not.toContain('sk-reasonsecret');
  });

  it('blocks real execution without trust manifest and allowlist even when owner auth is present', async () => {
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo should-not-run' },
      realExecute: true,
      authorization: auth,
    });

    expect(out.ok).toBe(false);
    expect(out.blockers).toContain('trust_manifest_required_for_real_execute');
    expect(out.blockers).toContain('allowlist_required_for_real_execute');
    expect(out.runtime).toBe(null);
  });

  it('developer unrestricted mode executes without trust manifest or allowlist', async () => {
    const fakeSpawn = () => {
      const listeners = {};
      return {
        stdout: { on(event, cb) { if (event === 'data') cb('developer ok\n'); } },
        stderr: { on() {} },
        on(event, cb) { listeners[event] = cb; if (event === 'close') queueMicrotask(() => cb(0, null)); },
      };
    };

    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo developer ok' },
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
      deps: { spawn: fakeSpawn },
    });

    expect(out.ok).toBe(true);
    expect(out.runtime).toMatchObject({ ok: true, stdout: 'developer ok' });
    expect(out.trust).toBe(null);
    expect(out.allowlist).toBe(null);
    expect(out.warnings).toContain('developer_unrestricted_mode_active');
  });

  it('persists browser DOM execution ledgers without typed DOM values', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-browser-dom-ledger-'));
    try {
      const fakeSpawn = () => {
        const listeners = {};
        return {
          stdout: {
            on(event, cb) {
              if (event === 'data') {
                cb(JSON.stringify({
                  ok: true,
                  browserApp: 'Google Chrome',
                  pageResult: JSON.stringify({
                    ok: true,
                    host: 'example.test',
                    url: 'https://example.test/form?token=secret-value',
                    title: 'Account Form',
                    actions: [
                      { index: 0, type: 'set_value', selector: '#token', ok: true, found: true, focused: true, valueSet: true },
                    ],
                    cookiesReadByNoe: false,
                    passwordReadByNoe: false,
                    pageContentReadByNoe: false,
                  }),
                }));
              }
            },
          },
          stderr: { on() {} },
          on(event, cb) { listeners[event] = cb; if (event === 'close') queueMicrotask(() => cb(0, null)); },
        };
      };

      const out = await runNoeFreedomAction({
        actionId: 'noe.freedom.browser.dom.execute',
        args: {
          browserApp: 'Google Chrome',
          expectedHost: 'example.test',
          actions: [{ type: 'set_value', selector: '#token', value: 'plain-dom-secret' }],
        },
        realExecute: true,
        authorization: {
          mode: 'developer_unrestricted',
          ownerPresent: true,
        },
        persistLedger: true,
        runId: 'browser-dom-ledger-test',
        root,
        deps: { spawn: fakeSpawn },
      });

      expect(out.ok).toBe(true);
      expect(out.runLedger).toMatchObject({
        ref: 'output/noe-freedom-runs/browser-dom-ledger-test/ledger.json',
      });
      const ledger = readFileSync(join(root, out.runLedger.ref), 'utf8');
      expect(ledger).toContain('noe.freedom.browser.dom.execute');
      expect(ledger).toContain('"value": "[redacted]"');
      expect(ledger).not.toContain('plain-dom-secret');
      expect(ledger).not.toContain('secret-value');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('marks rollback plan present in ledgers when the plan is supplied through args', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-args-rollback-plan-'));
    try {
      const out = await runNoeFreedomAction({
        actionId: 'noe.freedom.shell.execute',
        args: {
          command: 'printf dry-run-only',
          rollbackPlan: 'manual cleanup after external action',
        },
        realExecute: false,
        authorization: {
          mode: 'developer_unrestricted',
          ownerPresent: true,
        },
        persistLedger: true,
        runId: 'args-rollback-plan-ledger-test',
        root,
      });

      expect(out.runLedger).toMatchObject({
        ref: 'output/noe-freedom-runs/args-rollback-plan-ledger-test/ledger.json',
      });
      const ledger = JSON.parse(readFileSync(join(root, out.runLedger.ref), 'utf8'));
      expect(ledger.authorization.rollbackPlanPresent).toBe(true);
      expect(ledger.rollback.plan).toBe('manual cleanup after external action');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('developer unrestricted mode executes Freedom chains through child action authorization and ledgers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-chain-'));
    try {
      const calls = [];
      const fakeSpawn = (command, args) => {
        calls.push({ command, args });
        const output = args[1].includes('second') ? 'chain-second-ok' : 'chain-first-ok';
        return {
          stdout: { on(event, cb) { if (event === 'data') cb(output); } },
          stderr: { on() {} },
          on(event, cb) { if (event === 'close') queueMicrotask(() => cb(0, null)); },
        };
      };

      const out = await runNoeFreedomAction({
        actionId: 'noe.freedom.chain.execute',
        args: {
          runIdPrefix: 'chain-child',
          persistChildLedgers: true,
          stopOnError: true,
          steps: [
            {
              stepId: 'first',
              actionId: 'noe.freedom.shell.execute',
              args: { command: 'printf first tp-unitsecret000000000000000000000000000000' },
            },
            {
              stepId: 'second',
              actionId: 'noe.freedom.shell.execute',
              args: { command: 'printf second' },
            },
          ],
        },
        realExecute: true,
        authorization: {
          mode: 'developer_unrestricted',
          ownerPresent: true,
          sessionId: 'freedom-session-chain-test',
        },
        root,
        persistLedger: true,
        runId: 'chain-exec-test',
        deps: { spawn: fakeSpawn },
      });

      expect(out.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(out.runtime).toMatchObject({
        adapter: 'freedom-chain',
        ok: true,
        executedSteps: 2,
        persistChildLedgers: true,
      });
      expect(out.runtime.childResults.map((item) => item.actionId)).toEqual([
        'noe.freedom.shell.execute',
        'noe.freedom.shell.execute',
      ]);
      expect(out.runtime.childResults.every((item) => item.runLedger?.ref)).toBe(true);
      expect(out.runtime.childResults.every((item) => item.authorization?.sessionId === 'freedom-session-chain-test')).toBe(true);
      expect(out.runtime.childResults.every((item) => item.authorization?.mode === 'developer_unrestricted')).toBe(true);
      expect(out.runLedger).toMatchObject({
        ref: 'output/noe-freedom-runs/chain-exec-test/ledger.json',
      });
      const ledger = readFileSync(join(root, out.runLedger.ref), 'utf8');
      expect(ledger).toContain('noe.freedom.chain.execute');
      expect(ledger).toContain('chain-first-ok');
      expect(ledger).not.toContain('tp-unitsecret');
      const childLedger = readFileSync(join(root, out.runtime.childResults[0].runLedger.ref), 'utf8');
      expect(childLedger).toContain('"sessionId": "freedom-session-chain-test"');
      expect(childLedger).not.toContain('tp-unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('summarizes social publish chain stages and pending rollback evidence', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-chain-summary-draft-'));
    try {
      createNoeSocialDraft({
        dir: draftDir,
        draft: {
          id: 'stage-draft',
          platform: 'douyin',
          content: 'visible content',
          metadata: {
            title: 'visible title',
            mediaFiles: [],
          },
        },
      });

      const out = await runNoeFreedomAction({
        actionId: 'noe.freedom.chain.execute',
        args: {
          stopOnError: false,
          steps: [
            {
              stepId: 'execute_form_fill',
              actionId: 'noe.freedom.social.form_fill.execute',
              args: {
                draftId: 'stage-draft',
                platform: 'douyin',
                browserState: { activeBrowser: { url: 'https://creator.douyin.com/?token=secret-value', title: 'Douyin' } },
              },
            },
            {
              stepId: 'execute_final_publish',
              actionId: 'noe.freedom.social.final_publish.execute',
              externalSideEffectPerformed: true,
              publishPerformed: true,
              args: {
                draftId: 'stage-draft',
                platform: 'douyin',
                requirePriorStageEvidence: true,
                browserState: { activeBrowser: { url: 'https://creator.douyin.com/?token=secret-value', title: 'Douyin' } },
              },
            },
          ],
        },
        realExecute: false,
        deps: { socialDraftDir: draftDir },
      });

      expect(out.ok).toBe(true);
      expect(out.runtime.socialPublishStageSummary).toMatchObject({
        kind: 'social_publish_stage_summary',
        ok: true,
        stageCount: 2,
        completedStepIds: ['execute_form_fill', 'execute_final_publish'],
        failedStepIds: [],
        blockedAtStepId: '',
        publishStepPresent: true,
        publishAttempted: false,
        publishConfirmed: false,
        externalSideEffectPlanned: true,
        externalSideEffectPerformed: false,
        rollbackEvidence: {
          evidenceStatus: 'pending_probe',
          verifiedByNoe: false,
          missingEvidence: [
            'final_publish_not_confirmed',
            'post_publish_url_missing',
            'post_publish_title_missing',
          ],
        },
        secretValuesReturned: false,
      });
      expect(out.runtime.socialPublishStageSummary.stages.at(-1).runtime.priorStageEvidence).toMatchObject({
        required: true,
        ok: true,
        requiredStages: ['form_fill_execute'],
        missingStages: [],
      });
      expect(out.runtime.socialPublishStageSummary.stages.at(-1).runtime.priorStageEvidence.completedStages).toEqual(expect.arrayContaining([
        'form_fill_execute',
      ]));
      expect(out.runtime.socialPublishStageSummary.stages.map((item) => item.stage)).toEqual([
        'form_fill_execute',
        'final_publish_execute',
      ]);
      expect(out.runtime.socialPublishStageSummary.stages.at(-1)).toMatchObject({
        declaredExternalSideEffectPerformed: true,
        declaredPublishPerformed: true,
      });
      expect(JSON.stringify(out)).not.toContain('secret-value');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('surfaces final publish prior-stage gate blockers at the top level', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-gate-'));
    try {
      createNoeSocialDraft({
        dir: draftDir,
        draft: {
          id: 'missing-prior-stage-draft',
          platform: 'douyin',
          content: 'visible content',
          metadata: {
            title: 'visible title',
            mediaFiles: ['clips/demo.mp4'],
          },
        },
      });

      const out = await runNoeFreedomAction({
        actionId: 'noe.freedom.social.final_publish.execute',
        args: {
          draftId: 'missing-prior-stage-draft',
          draftDir,
          platform: 'douyin',
          requirePriorStageEvidence: true,
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        realExecute: false,
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('final_publish_prior_stage_evidence_required');
      expect(out.blockers).toContain('final_publish_prior_stage_missing:form_fill_execute');
      expect(out.blockers).toContain('final_publish_prior_stage_missing:media_upload_execute');
      expect(out.blockers).not.toContain('freedom_runtime_failed');
      expect(out.runtime.priorStageEvidence.errors).toEqual(expect.arrayContaining(out.blockers));
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('summarizes real DOM recipe probe readiness for social publish chains', async () => {
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({
          ok: true,
          browserApp: 'Google Chrome',
          pageResult: JSON.stringify({
            ok: false,
            host: 'creator.xiaohongshu.com',
            url: 'https://creator.xiaohongshu.com/publish/post?token=secret-value',
            title: 'XHS Creator',
            expectedHosts: ['creator.xiaohongshu.com'],
            pageReadiness: {
              ok: false,
              hostMatched: true,
              expectedHosts: ['creator.xiaohongshu.com'],
              targetSurface: 'creator_publish_editor',
              targetSurfaceReady: false,
              requiresLoginSession: true,
              loginSessionLikely: true,
              login: { passwordFieldPresent: false, loginPromptPresent: false },
              requiredRoles: ['read_title', 'content', 'tags', 'media_upload'],
              foundRoles: ['read_title', 'content', 'tags'],
              missingRoles: ['media_upload'],
              fieldRoles: ['content', 'tags'],
              clickableRoles: ['media_upload'],
              titleRead: true,
              secretValuesReturned: false,
            },
            actions: [
              { index: 0, type: 'read_title', ok: true, found: true },
              { index: 1, type: 'probe_by_hints', role: 'content', probeTarget: 'field', ok: true, found: true, matchedByHints: true, probed: true },
              { index: 2, type: 'probe_by_hints', role: 'tags', probeTarget: 'field', ok: true, found: true, matchedByHints: true, probed: true },
              { index: 3, type: 'probe_by_hints', role: 'media_upload', probeTarget: 'clickable', ok: false, found: false, error: 'browser_dom_element_not_found' },
            ],
            cookiesReadByNoe: false,
            passwordReadByNoe: false,
            pageContentReadByNoe: false,
          }),
        }));
        child.emit('close', 0, null);
      });
      return child;
    };

    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.chain.execute',
      args: {
        stopOnError: false,
        steps: [
          {
            stepId: 'probe_dom_recipe_targets',
            actionId: 'noe.freedom.browser.dom.execute',
            args: {
              browserApp: 'Google Chrome',
              expectedHost: 'creator.xiaohongshu.com',
              actions: [
                { type: 'read_title' },
                { type: 'probe_by_hints', role: 'content', probeTarget: 'field', hints: ['正文'] },
                { type: 'probe_by_hints', role: 'tags', probeTarget: 'field', hints: ['标签'] },
                { type: 'probe_by_hints', role: 'media_upload', probeTarget: 'clickable', hints: ['上传'] },
              ],
            },
          },
        ],
      },
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
      deps: { spawn: fakeSpawn },
    });

    expect(out.ok).toBe(false);
    expect(out.runtime.socialPublishStageSummary.domRecipeProbe).toMatchObject({
      ok: false,
      stageCount: 1,
      requiredRoles: ['read_title', 'content', 'tags', 'media_upload'],
      foundRoles: ['read_title', 'content', 'tags'],
      missingRoles: ['media_upload'],
      hosts: ['creator.xiaohongshu.com'],
      titleSha256s: [expect.any(String)],
      pageReadiness: {
        ok: false,
        targetSurfaces: ['creator_publish_editor'],
        hostMatched: true,
        targetSurfaceReady: false,
        loginSessionLikely: true,
      },
      errors: ['browser_dom_element_not_found', 'browser_dom_target_surface_not_ready'],
      secretValuesReturned: false,
    });
    expect(JSON.stringify(out.runtime.socialPublishStageSummary.domRecipeProbe)).not.toContain('XHS Creator');
    expect(out.runtime.socialPublishStageSummary.stages[0].runtime.domProbe).toMatchObject({
      ok: false,
      missingRoles: ['media_upload'],
      pageReadiness: {
        ok: false,
        targetSurfaceReady: false,
        missingRoles: ['media_upload'],
      },
    });
    expect(JSON.stringify(out)).not.toContain('secret-value');
  });

  it('stops Freedom chains before later steps when a child action hits a developer hard veto', async () => {
    const calls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.chain.execute',
      args: {
        stopOnError: true,
        steps: [
          {
            stepId: 'delete_codex',
            actionId: 'noe.freedom.shell.execute',
            args: { command: 'rm -rf ~/.codex' },
          },
          {
            stepId: 'after_block',
            actionId: 'noe.freedom.shell.execute',
            args: { command: 'printf should-not-run' },
          },
        ],
      },
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
      deps: { spawn: () => { calls.push('spawned'); } },
    });

    expect(out.ok).toBe(false);
    expect(out.blockers).toContain('freedom_chain_step_failed:delete_codex');
    expect(out.runtime).toMatchObject({
      adapter: 'freedom-chain',
      ok: false,
      stoppedEarly: true,
      executedSteps: 1,
    });
    expect(out.runtime.childResults[0].blockers).toContain(`developer_hard_veto_protected_delete:${homedir()}/.codex`);
    expect(calls).toHaveLength(0);
  });

  it('resumes next Freedom actions from a verified run ledger through the chain executor', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-resume-'));
    try {
      const source = writeNoeFreedomRunLedgerFile({
        root,
        runId: 'source-with-next-actions',
        result: {
          id: 'freedom-source',
          ok: true,
          dryRunOnly: true,
          realExecute: false,
          tool: {
            id: 'noe.freedom.social.publish_orchestrate',
            operation: 'noe.freedom.social.publish_orchestrate',
            capability: 'social.publish_orchestrate',
            riskLevel: 'high',
          },
          authorization: { mode: 'dry_run' },
          trust: null,
          allowlist: null,
          argsPreview: {},
          blockers: [],
          warnings: [],
          runtime: {
            ok: true,
            nextFreedomActions: [
              { stepId: 'first', actionId: 'noe.freedom.shell.execute', args: { command: 'printf resume-first' } },
              { stepId: 'second', actionId: 'noe.freedom.shell.execute', args: { command: 'printf resume-second tp-unitsecret000000000000000000000000000000' } },
            ],
            secretValuesReturned: false,
          },
          rollback: { strategy: 'none', plan: '' },
          evidence: { sha256: 'c'.repeat(64), refs: {} },
        },
      });
      const calls = [];
      const fakeSpawn = (command, args) => {
        calls.push({ command, args });
        const output = args[1].includes('second') ? 'resume-second' : 'resume-first';
        return {
          stdout: { on(event, cb) { if (event === 'data') cb(output); } },
          stderr: { on() {} },
          on(event, cb) { if (event === 'close') queueMicrotask(() => cb(0, null)); },
        };
      };

      const out = await runNoeFreedomAction({
        actionId: 'noe.freedom.run.resume_next_actions',
        args: {
          ledgerRef: source.ref,
          runIdPrefix: 'resume-child',
          persistChildLedgers: true,
        },
        realExecute: true,
        authorization: {
          mode: 'developer_unrestricted',
          ownerPresent: true,
        },
        root,
        persistLedger: true,
        runId: 'resume-parent',
        deps: { spawn: fakeSpawn },
      });

      expect(out.ok).toBe(true);
      expect(calls).toHaveLength(2);
      expect(out.runtime).toMatchObject({
        adapter: 'freedom-ledger-resume-next-actions',
        sourceLedgerRef: 'output/noe-freedom-runs/source-with-next-actions/ledger.json',
        sourceRunId: 'source-with-next-actions',
        resumedStepCount: 2,
      });
      expect(out.runtime.chain.runtime.childResults.every((item) => item.runLedger?.ref)).toBe(true);
      expect(out.runLedger).toMatchObject({
        ref: 'output/noe-freedom-runs/resume-parent/ledger.json',
      });
      const ledger = readFileSync(join(root, out.runLedger.ref), 'utf8');
      expect(ledger).toContain('freedom-ledger-resume-next-actions');
      expect(ledger).not.toContain('tp-unitsecret');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks resume when the ledger ref is missing, escaped, or has no next actions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-resume-blocked-'));
    try {
      const noActions = writeNoeFreedomRunLedgerFile({
        root,
        runId: 'source-without-next-actions',
        result: {
          id: 'freedom-source-no-actions',
          ok: true,
          dryRunOnly: true,
          realExecute: false,
          tool: {
            id: 'noe.freedom.social.publish_orchestrate',
            operation: 'noe.freedom.social.publish_orchestrate',
            capability: 'social.publish_orchestrate',
            riskLevel: 'high',
          },
          authorization: { mode: 'dry_run' },
          trust: null,
          allowlist: null,
          argsPreview: {},
          blockers: [],
          warnings: [],
          runtime: { ok: true, secretValuesReturned: false },
          rollback: { strategy: 'none', plan: '' },
          evidence: { sha256: 'd'.repeat(64), refs: {} },
        },
      });
      const escaped = await runNoeFreedomAction({
        actionId: 'noe.freedom.run.resume_next_actions',
        args: { ledgerRef: '../ledger.json' },
        realExecute: false,
      });
      const missingNext = await runNoeFreedomAction({
        actionId: 'noe.freedom.run.resume_next_actions',
        args: { ledgerRef: noActions.ref },
        root,
        realExecute: false,
      });

      expect(escaped.ok).toBe(false);
      expect(escaped.blockers[0]).toContain('freedom_resume_ledger_read_failed:freedom_run_ledger_ref_path_traversal');
      expect(missingNext.ok).toBe(false);
      expect(missingNext.blockers).toContain('freedom_resume_next_actions_missing');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('developer unrestricted mode can open browser account URLs without trust manifest or allowlist', async () => {
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      return {
        stdout: { on() {} },
        stderr: { on() {} },
        on(event, cb) { if (event === 'close') queueMicrotask(() => cb(0, null)); },
      };
    };

    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.browser.open',
      args: { url: 'https://accounts.example.test/settings' },
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
      deps: { spawn: fakeSpawn },
    });

    expect(out.ok).toBe(true);
    expect(out.runtime).toMatchObject({
      adapter: 'browser-open',
      browserOpenAttempted: true,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
    });
    expect(out.trust).toBe(null);
    expect(out.allowlist).toBe(null);
    expect(calls).toEqual([
      { command: 'open', args: ['https://accounts.example.test/settings'] },
    ]);
  });

  it('developer unrestricted mode can run AppleScript automation without trust manifest or allowlist', async () => {
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      return {
        stdout: { on(event, cb) { if (event === 'data') cb('front-app\n'); } },
        stderr: { on() {} },
        on(event, cb) { if (event === 'close') queueMicrotask(() => cb(0, null)); },
      };
    };

    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.macos.applescript.run',
      args: { script: 'tell application "System Events" to get name of first process' },
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
      deps: { spawn: fakeSpawn },
    });

    expect(out.ok).toBe(true);
    expect(out.runtime).toMatchObject({
      adapter: 'macos-applescript',
      language: 'AppleScript',
      desktopAutomationAttempted: true,
      stdout: 'front-app',
    });
    expect(out.trust).toBe(null);
    expect(out.allowlist).toBe(null);
    expect(calls[0].command).toBe('osascript');
  });

  it('developer unrestricted mode blocks protected deletes embedded in AppleScript shell calls', async () => {
    const calls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.macos.applescript.run',
      args: { script: 'do shell script "rm -rf ~/.codex"' },
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
      deps: { spawn: () => { calls.push('spawned'); } },
    });

    expect(out.ok).toBe(false);
    expect(out.blockers).toContain(`developer_hard_veto_protected_delete:${homedir()}/.codex`);
    expect(out.runtime).toBe(null);
    expect(calls).toHaveLength(0);
  });

  it('developer unrestricted mode still blocks protected system or Codex deletes', async () => {
    const calls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'rm -rf ~/.codex' },
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
      deps: { spawn: () => { calls.push('spawned'); } },
    });

    expect(out.ok).toBe(false);
    expect(out.blockers).toContain(`developer_hard_veto_protected_delete:${homedir()}/.codex`);
    expect(out.runtime).toBe(null);
    expect(calls).toHaveLength(0);
  });

  it('developer unrestricted mode still blocks wildcard root deletes', async () => {
    const calls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'sudo rm -rf /*' },
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
      deps: { spawn: () => { calls.push('spawned'); } },
    });

    expect(out.ok).toBe(false);
    expect(out.blockers).toContain('developer_hard_veto_protected_delete:/');
    expect(out.runtime).toBe(null);
    expect(calls).toHaveLength(0);
  });

  it('executes shell through an injectable spawn adapter and records non-secret evidence', async () => {
    const operation = 'noe.freedom.shell.execute';
    const fakeSpawn = () => {
      const listeners = {};
      const child = {
        stdout: { on(event, cb) { if (event === 'data') cb('hello\n'); } },
        stderr: { on() {} },
        on(event, cb) { listeners[event] = cb; if (event === 'close') queueMicrotask(() => cb(0, null)); },
      };
      return child;
    };
    const out = await runNoeFreedomAction({
      actionId: operation,
      args: { command: 'echo hello' },
      realExecute: true,
      authorization: auth,
      trustManifest: trustManifest(operation, { commands: ['echo hello'] }),
      allowlist: allowlist(operation, { commands: ['echo hello'] }),
      deps: { spawn: fakeSpawn },
    });

    expect(out.ok).toBe(true);
    expect(out.runtime).toMatchObject({ ok: true, exitCode: 0, stdout: 'hello' });
    expect(out.evidence).toMatchObject({ dryRunOnly: false });
    expect(out.evidence.sha256).toHaveLength(64);
  });

  it('inspects env files with redacted values only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-env-'));
    try {
      const operation = 'noe.freedom.env.inspect';
      writeFileSync(join(root, '.env'), 'XIAOMI_API_KEY=tp-unitsecret000000000000000000000000000000\nPUBLIC_NAME=noe\n');
      const out = await runNoeFreedomAction({
        actionId: operation,
        args: { path: '.env' },
        realExecute: true,
        authorization: { ...auth, rollbackPlan: 'readonly' },
        trustManifest: trustManifest(operation, { paths: [root] }, 'readonly'),
        allowlist: allowlist(operation, { paths: [root] }),
        root,
      });

      expect(out.ok).toBe(true);
      expect(out.runtime.entries.map((item) => item.key)).toContain('XIAOMI_API_KEY');
      expect(out.runtime.secretValuesReturned).toBe(false);
      expect(JSON.stringify(out)).not.toContain('tp-unitsecret');
      expect(out.runtime.entries.find((item) => item.key === 'XIAOMI_API_KEY').valuePreview).toContain('[redacted');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns keychain secret refs without returning secret values', async () => {
    const operation = 'noe.freedom.keychain.read';
    const out = await runNoeFreedomAction({
      actionId: operation,
      args: { account: 'MINIMAX_API_KEY', service: 'Neo Jarvis Noe model API keys' },
      realExecute: true,
      authorization: { ...auth, rollbackPlan: 'readonly' },
      trustManifest: trustManifest(operation, { secrets: ['keychain:Neo Jarvis Noe model API keys:MINIMAX_API_KEY'] }, 'readonly'),
      allowlist: allowlist(operation, { secrets: ['keychain:Neo Jarvis Noe model API keys:MINIMAX_API_KEY'] }),
      deps: {
        // 注入整个 broker 并固定 platform=darwin：本测试测的是"redact 语义"，不是平台可用性；
        // 只注入 spawnSync 时 broker 仍读真实 process.platform，CI ubuntu 走 macos_keychain_unavailable 分支挂测试
        secretBroker: new NoeSecretBroker({
          spawnSyncImpl: () => ({ status: 0, stdout: 'sk-unitsecret000000000000000000000000000000', stderr: '' }),
          platform: 'darwin',
        }),
      },
    });

    expect(out.ok).toBe(true);
    expect(out.runtime).toMatchObject({
      present: true,
      value: '[redacted]',
      secretValuesReturned: false,
    });
    expect(out.runtime.secretRef).toContain('keychain:');
    expect(JSON.stringify(out)).not.toContain('sk-unitsecret');
  });

  it('keychain read on non-darwin platform reports macos_keychain_unavailable (no spawn attempted)', async () => {
    const operation = 'noe.freedom.keychain.read';
    const out = await runNoeFreedomAction({
      actionId: operation,
      args: { account: 'MINIMAX_API_KEY', service: 'Neo Jarvis Noe model API keys' },
      realExecute: true,
      authorization: { ...auth, rollbackPlan: 'readonly' },
      trustManifest: trustManifest(operation, { secrets: ['keychain:Neo Jarvis Noe model API keys:MINIMAX_API_KEY'] }, 'readonly'),
      allowlist: allowlist(operation, { secrets: ['keychain:Neo Jarvis Noe model API keys:MINIMAX_API_KEY'] }),
      deps: {
        secretBroker: new NoeSecretBroker({
          spawnSyncImpl: () => { throw new Error('不应该在非 darwin 上调 security'); },
          platform: 'linux',
        }),
      },
    });
    expect(out.ok).toBe(false);
    expect(JSON.stringify(out)).toContain('macos_keychain_unavailable');
  });

  it('lists desktop inventory metadata without reading file contents', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-desktop-'));
    try {
      const operation = 'noe.freedom.desktop.inventory';
      writeFileSync(join(root, 'note.txt'), 'private content should not appear');
      const out = await runNoeFreedomAction({
        actionId: operation,
        args: { path: root },
        realExecute: true,
        authorization: { ...auth, rollbackPlan: 'readonly' },
        trustManifest: trustManifest(operation, { paths: [root] }, 'readonly'),
        allowlist: allowlist(operation, { paths: [root] }),
      });

      expect(out.ok).toBe(true);
      expect(out.runtime.entries).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'note.txt', type: 'file' }),
      ]));
      expect(out.runtime.contentRead).toBe(false);
      expect(JSON.stringify(out)).not.toContain('private content');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('publishes through a social adapter only after authorization', async () => {
    const calls = [];
    const operation = 'noe.freedom.social.publish';
    const out = await runNoeFreedomAction({
      actionId: operation,
      args: { url: 'https://example.test/webhook', content: 'hello world' },
      realExecute: true,
      authorization: auth,
      trustManifest: trustManifest(operation, { hosts: ['example.test'], networkMethods: ['POST'] }),
      allowlist: allowlist(operation, { hosts: ['example.test'], networkMethods: ['POST'] }),
      deps: {
        fetch: async (url, init) => {
          calls.push({ url, init });
          return { ok: true, status: 200, text: async () => 'ok' };
        },
      },
    });

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(out.runtime).toMatchObject({ ok: true, status: 200 });
  });

  it('developer unrestricted mode uploads referenced files without trust manifest or allowlist', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-upload-'));
    try {
      writeFileSync(join(root, 'payload.txt'), 'developer-upload-content', 'utf8');
      const calls = [];
      const out = await runNoeFreedomAction({
        actionId: 'noe.freedom.network.upload',
        args: { url: 'https://example.test/upload', filePath: 'payload.txt', contentType: 'text/plain' },
        realExecute: true,
        authorization: {
          mode: 'developer_unrestricted',
          ownerPresent: true,
        },
        root,
        deps: {
          fetch: async (url, init) => {
            calls.push({ url, init });
            return { ok: true, status: 200, text: async () => 'ok' };
          },
        },
      });

      expect(out.ok).toBe(true);
      expect(out.trust).toBe(null);
      expect(out.allowlist).toBe(null);
      expect(out.runtime).toMatchObject({
        adapter: 'network-upload',
        fileUploaded: true,
        fileRef: 'payload.txt',
        fileBytes: Buffer.byteLength('developer-upload-content'),
        fileContentReturned: false,
      });
      expect(calls[0].init.body.toString()).toBe('developer-upload-content');
      expect(JSON.stringify(out)).not.toContain('developer-upload-content');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dry-runs social publish through the adapter without calling fetch', async () => {
    const calls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.social.publish',
      args: { url: 'https://example.test/webhook', content: 'hello world' },
      realExecute: false,
      deps: {
        fetch: async () => { calls.push('called'); },
      },
    });

    expect(out.ok).toBe(true);
    expect(out.runtime).toMatchObject({
      adapter: 'social-publish',
      plannedOnly: true,
      sideEffectPerformed: false,
      host: 'example.test',
    });
    expect(calls).toHaveLength(0);
  });

  it('installs marketplace manifests to a controlled directory with redaction', async () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'noe-marketplace-'));
    try {
      const operation = 'noe.freedom.tool_marketplace.install';
      const out = await runNoeFreedomAction({
        actionId: operation,
        args: {
          manifest: {
            id: 'demo-tool',
            command: 'node demo.js',
            apiKey: 'tp-unitsecret000000000000000000000000000000',
          },
        },
        realExecute: true,
        authorization: auth,
        trustManifest: trustManifest(operation, { marketplaceTools: ['demo-tool'] }),
        allowlist: allowlist(operation, { marketplaceTools: ['demo-tool'] }),
        deps: { marketplaceDir },
      });

      expect(out.ok).toBe(true);
      const installed = readFileSync(out.runtime.path, 'utf8');
      expect(installed).toContain('demo-tool');
      expect(installed).not.toContain('tp-unitsecret');
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  it('developer unrestricted mode executes installed marketplace tools without trust manifest or allowlist', async () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'noe-marketplace-developer-execute-'));
    try {
      const install = await runNoeFreedomAction({
        actionId: 'noe.freedom.tool_marketplace.install',
        args: {
          manifest: {
            id: 'demo-tool',
            command: 'printf developer-marketplace-ok',
          },
        },
        realExecute: true,
        authorization: {
          mode: 'developer_unrestricted',
          ownerPresent: true,
        },
        deps: { marketplaceDir },
      });
      expect(install.ok).toBe(true);

      const calls = [];
      const fakeSpawn = (command, args) => {
        calls.push({ command, args });
        return {
          stdout: { on(event, cb) { if (event === 'data') cb('developer-marketplace-ok'); } },
          stderr: { on() {} },
          on(event, cb) { if (event === 'close') queueMicrotask(() => cb(0, null)); },
        };
      };

      const out = await runNoeFreedomAction({
        actionId: 'noe.freedom.tool_marketplace.execute',
        args: { id: 'demo-tool' },
        realExecute: true,
        authorization: {
          mode: 'developer_unrestricted',
          ownerPresent: true,
        },
        deps: { marketplaceDir, spawn: fakeSpawn },
      });

      expect(out.ok).toBe(true);
      expect(out.trust).toBe(null);
      expect(out.allowlist).toBe(null);
      expect(out.runtime).toMatchObject({
        adapter: 'tool-marketplace-execute',
        id: 'demo-tool',
        stdout: 'developer-marketplace-ok',
        secretValuesReturned: false,
      });
      expect(calls).toEqual([
        // SHELL_BIN 与生产同款推导：macOS=/bin/zsh、CI ubuntu=/bin/bash（写死 zsh 在 ubuntu 必挂）
        { command: SHELL_BIN, args: ['-lc', 'printf developer-marketplace-ok'] },
      ]);
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  // B1.3 freedom Review Brain 阻断(high)：高风险/critical real execute 必须真实调用 review brain
  // 并等待 approve/block verdict，block 时不得继续 runtime。修"声称的复核没生效"(正确性)。
  function spyingSpawn(calls, output = 'review-gate-ran\n') {
    return () => {
      calls.push('spawned');
      return {
        stdout: { on(event, cb) { if (event === 'data') cb(output); } },
        stderr: { on() {} },
        on(event, cb) { if (event === 'close') queueMicrotask(() => cb(0, null)); },
      };
    };
  }

  it('blocks high-risk real execution and skips runtime when Review Brain verdict is block', async () => {
    const calls = [];
    const reviewCalls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo should-be-review-blocked' },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      deps: {
        spawn: spyingSpawn(calls),
        reviewBrain: async ({ request }) => {
          reviewCalls.push(request);
          return { verdict: 'block', blockers: ['missing rollback evidence'], confidence: 0.9 };
        },
      },
    });

    expect(out.ok).toBe(false);
    // 真实调用了 review brain（携带 preflight request，不是空壳）
    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0].user.requiredChecks).toContain('rollbackPlan');
    // block verdict 必须落成 blocker 且不走 runtime
    expect(out.blockers).toContain('review_brain_blocked');
    expect(out.blockers.some((b) => b.includes('missing rollback evidence'))).toBe(true);
    expect(out.runtime).toBe(null);
    expect(calls).toHaveLength(0);
    // verdict 落到 preflight 上供审计
    expect(out.reviewBrainPreflight.verdict).toMatchObject({ verdict: 'block' });
    expect(JSON.stringify(out)).not.toMatch(/token=|sk-|cookie=/i);
  });

  it('blocks high-risk real execution when Review Brain verdict is revise', async () => {
    const calls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo should-be-revise-blocked' },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      deps: {
        spawn: spyingSpawn(calls),
        reviewBrain: async () => ({ verdict: 'revise', risks: ['needs snapshot first'] }),
      },
    });

    expect(out.ok).toBe(false);
    expect(out.blockers).toContain('review_brain_revise_required');
    expect(out.runtime).toBe(null);
    expect(calls).toHaveLength(0);
  });

  it('allows high-risk real execution to proceed to runtime when Review Brain verdict is approve', async () => {
    const calls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo review-approved' },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      deps: {
        spawn: spyingSpawn(calls, 'review-approved\n'),
        reviewBrain: async () => ({ verdict: 'approve', confidence: 0.8 }),
      },
    });

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(out.runtime).toMatchObject({ ok: true, stdout: 'review-approved' });
    expect(out.reviewBrainPreflight.verdict).toMatchObject({ verdict: 'approve' });
  });

  it('records a non-silent skip marker (never fakes approved) when no Review Brain is wired yet', async () => {
    // 设计取舍：B1.3 修的是"声称的复核没生效"(verdict 不被遵守)，不是新增"必须有复核器否则全锁"
    // 的拦截（owner 宪法明确不要过度权限拦截）。未接线 review brain 时保持历史现状不阻断（不比
    // bug 前更宽松=非新增绕过），但必须显式留 skippedReason 审计标记，绝不静默伪装成 approved。
    // 生产路由接线 reviewBrain client 后此降级分支不再触发。
    const calls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo no-review-brain-wired' },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      deps: { spawn: spyingSpawn(calls, 'no-review-brain-wired\n') },
    });

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    // 显式审计：标记为未接线，verdict 仍为 null（没有伪造成 approve）
    expect(out.reviewBrainPreflight.required).toBe(true);
    expect(out.reviewBrainPreflight.skippedReason).toBe('review_brain_not_wired');
    expect(out.reviewBrainPreflight.verdict).toBe(null);
  });

  it('fails closed when Review Brain throws or returns an unparseable verdict (never fail-open)', async () => {
    const thrownCalls = [];
    const thrown = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo review-brain-threw' },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      deps: {
        spawn: spyingSpawn(thrownCalls),
        reviewBrain: async () => { throw new Error('review brain offline'); },
      },
    });

    expect(thrown.ok).toBe(false);
    expect(thrown.blockers).toContain('review_brain_unavailable_for_high_risk_real_execute');
    expect(thrown.runtime).toBe(null);
    expect(thrownCalls).toHaveLength(0);

    const garbageCalls = [];
    const garbage = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo review-brain-garbage' },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      deps: {
        spawn: spyingSpawn(garbageCalls),
        reviewBrain: async () => ({ reply: 'I think it is probably fine, no JSON here' }),
      },
    });

    expect(garbage.ok).toBe(false);
    expect(garbage.blockers).toContain('review_brain_verdict_unparseable');
    expect(garbage.runtime).toBe(null);
    expect(garbageCalls).toHaveLength(0);
  });

  it('parses an approve verdict delivered as a JSON string reply from the Review Brain', async () => {
    const calls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo review-reply-json' },
      realExecute: true,
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
      deps: {
        spawn: spyingSpawn(calls, 'review-reply-json\n'),
        // brainChat 形态：返回 { reply: '<json string>' }
        reviewBrain: async () => ({ reply: '{"verdict":"approve","confidence":0.7}' }),
      },
    });

    expect(out.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(out.reviewBrainPreflight.verdict).toMatchObject({ verdict: 'approve' });
  });

  it('does not require a Review Brain verdict for dry-run plans (no external side effect)', async () => {
    const reviewCalls = [];
    const out = await runNoeFreedomAction({
      actionId: 'noe.freedom.shell.execute',
      args: { command: 'echo dry-run-no-review' },
      realExecute: false,
      deps: {
        reviewBrain: async () => { reviewCalls.push('called'); return { verdict: 'block' }; },
      },
    });

    expect(out.ok).toBe(true);
    expect(out.dryRunOnly).toBe(true);
    // dry-run 无副作用，不应触发 review brain 阻断
    expect(reviewCalls).toHaveLength(0);
    expect(out.runtime).toMatchObject({ plannedOnly: true });
  });
});
