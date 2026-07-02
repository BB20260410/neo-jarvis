import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoeSocialDraft, markNoeSocialDraftExternalSideEffect } from '../../src/runtime/NoeSocialPublishQueue.js';
import {
  buildNoeSocialFinalPublishExecuteScript,
  executeNoeSocialFinalPublish,
  finalPublishScriptContainsUnsafeAction,
} from '../../src/runtime/NoeSocialFinalPublishExecutor.js';

function createDraft(dir, overrides = {}) {
  return createNoeSocialDraft({
    dir,
    draft: {
      id: overrides.id || 'final-publish-draft',
      platform: overrides.platform || 'douyin',
      content: Object.prototype.hasOwnProperty.call(overrides, 'content') ? overrides.content : 'ready content',
      metadata: {
        title: overrides.title || 'ready title',
        mediaFiles: overrides.mediaFiles || ['clips/demo.mp4'],
      },
    },
  });
}

// Task 0.2 Step4: prior-stage evidence is now required by default. This mirrors the real summary
// the freedom chain injects after the form-fill + media-upload stages complete (createDraft uses a
// single media file, so both stages are required).
function chainStageEvidence(completedStages = ['form_fill_execute', 'media_upload_execute']) {
  return {
    ok: true,
    kind: 'social_publish_stage_summary',
    completedStages,
    failedStages: [],
    secretValuesReturned: false,
  };
}

function fakeSpawnWithStdout({ calls, stdout, code = 0 }) {
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (stdout) child.stdout.emit('data', stdout);
      child.emit('close', code, null);
    });
    return child;
  };
}

describe('NoeSocialFinalPublishExecutor', () => {
  it('executes a controlled final publish click and records rollback evidence', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          priorStageEvidence: chainStageEvidence(),
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: {
          spawn: fakeSpawnWithStdout({
            calls,
            stdout: JSON.stringify({
              ok: true,
              app: 'Google Chrome',
              result: {
                ok: true,
                host: 'creator.douyin.com',
                selector: 'button.publish',
                clickedLabel: '发布',
                clickedTag: 'button',
                submitDisabled: '',
                finalButtonClicked: true,
                formSubmitted: false,
                pageContentReadByNoe: false,
              },
              postPublishProbe: {
                ok: true,
                url: 'https://creator.douyin.com/published/123?token=secret-value#session=abc',
                title: 'Douyin Creator Center',
                finalButtonClicked: false,
                formSubmitted: false,
              },
              publishPerformed: true,
              finalButtonClicked: true,
              formSubmitted: false,
              pageContentReadByNoe: false,
            }),
          }),
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-final-publish-execute',
        plannedOnly: false,
        executionAttempted: true,
        externalSideEffectPerformed: true,
        publishPerformed: true,
        secretValuesReturned: false,
        browser: {
          activeHost: 'creator.douyin.com',
          cookiesReadByNoe: false,
          passwordReadByNoe: false,
          pageContentReadByNoe: false,
        },
        execution: {
          command: 'osascript',
          language: 'JavaScript',
          stdoutReturned: false,
          publishPerformed: true,
          finalButtonClicked: true,
          formSubmitted: false,
          pageContentReadByNoe: false,
          browser: {
            ok: true,
            result: {
              host: 'creator.douyin.com',
              clickedLabel: '发布',
              clickedTag: 'button',
              submitDisabled: '',
              finalButtonClicked: true,
              formSubmitted: false,
              pageContentReadByNoe: false,
            },
            postPublishProbe: {
              url: 'https://creator.douyin.com/published/123?token=%5Bredacted%5D#[redacted]',
              title: 'Douyin Creator Center',
            },
          },
        },
        rollbackEvidence: {
          requiredAfterPublish: true,
          platform: 'douyin',
          evidenceStatus: 'verified',
          missingEvidence: [],
          postUrlRef: 'https://creator.douyin.com/published/123?token=%5Bredacted%5D#[redacted]',
          verifiedByNoe: true,
          secretValuesReturned: false,
        },
      });
      expect(out.rollbackEvidence.nextFreedomActions[0]).toMatchObject({
        actionId: 'noe.freedom.browser.state_probe',
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('osascript');
      expect(calls[0].args[3]).toContain('.click()');
      expect(calls[0].args[3]).not.toContain('.submit(');
      expect(calls[0].args[3]).not.toContain('requestSubmit(');
      expect(JSON.stringify(out)).not.toContain('"stdout":');
      expect(JSON.stringify(out)).not.toContain('secret-value');
      expect(JSON.stringify(out)).not.toContain('session=abc');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a confirmed publish cannot persist the local side-effect marker', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      chmodSync(draft.path, 0o400);
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          priorStageEvidence: chainStageEvidence(),
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: {
          spawn: fakeSpawnWithStdout({
            calls,
            stdout: JSON.stringify({
              ok: true,
              app: 'Google Chrome',
              result: {
                ok: true,
                host: 'creator.douyin.com',
                selector: 'button.publish',
                clickedLabel: '发布',
                clickedTag: 'button',
                submitDisabled: '',
                finalButtonClicked: true,
                formSubmitted: false,
                pageContentReadByNoe: false,
              },
              postPublishProbe: {
                ok: true,
                url: 'https://creator.douyin.com/published/123',
                title: 'Douyin Creator Center',
              },
              publishPerformed: true,
              finalButtonClicked: true,
              formSubmitted: false,
              pageContentReadByNoe: false,
            }),
          }),
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('final_publish_external_side_effect_marker_persist_failed');
      expect(out.externalSideEffectPerformed).toBe(true);
      expect(out.publishAttempted).toBe(true);
      expect(out.publishVerified).toBe(true);
      expect(out.publishPerformed).toBe(true);
      expect(out.rollbackEvidence).toMatchObject({
        evidenceStatus: 'verified',
        verifiedByNoe: true,
      });
      expect(out.draftExternalSideEffectPersisted).toBe(false);
      expect(calls).toHaveLength(1);
    } finally {
      chmodSync(join(draftDir, 'final-publish-draft.json'), 0o600);
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('dry-runs final publish without spawning osascript', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: false,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          priorStageEvidence: chainStageEvidence(),
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: { spawn: () => { calls.push('spawned'); } },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-final-publish-execute',
        plannedOnly: true,
        executionAttempted: false,
        externalSideEffectPerformed: false,
        publishPerformed: false,
      });
      expect(out.nextFreedomActions[0]).toMatchObject({
        actionId: 'noe.freedom.social.final_publish.execute',
      });
      expect(out.rollbackEvidence).toMatchObject({
        evidenceStatus: 'pending_probe',
        missingEvidence: ['final_publish_not_confirmed', 'post_publish_url_missing', 'post_publish_title_missing'],
        verifiedByNoe: false,
      });
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks final publish when required prior stage evidence is missing', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          requirePriorStageEvidence: true,
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: { spawn: () => { calls.push('spawned'); } },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('final_publish_prior_stage_evidence_required');
      expect(out.blockers).toContain('final_publish_prior_stage_missing:form_fill_execute');
      expect(out.blockers).toContain('final_publish_prior_stage_missing:media_upload_execute');
      expect(out.priorStageEvidence).toMatchObject({
        required: true,
        ok: false,
        requiredStages: ['form_fill_execute', 'media_upload_execute'],
        completedStages: [],
        missingStages: ['form_fill_execute', 'media_upload_execute'],
      });
      expect(out.executionAttempted).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('accepts required prior stage evidence for form fill and media upload before final publish', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: false,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          requirePriorStageEvidence: true,
          priorStageEvidence: {
            ok: true,
            kind: 'social_publish_stage_summary',
            completedStages: ['form_fill_execute', 'media_upload_execute'],
            failedStages: [],
            secretValuesReturned: false,
          },
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: { spawn: () => { calls.push('spawned'); } },
      });

      expect(out.ok).toBe(true);
      expect(out.priorStageEvidence).toMatchObject({
        required: true,
        ok: true,
        source: 'social_publish_stage_summary',
        requiredStages: ['form_fill_execute', 'media_upload_execute'],
        completedStages: ['form_fill_execute', 'media_upload_execute'],
        missingStages: [],
      });
      expect(out.nextFreedomActions[0]).toMatchObject({
        actionId: 'noe.freedom.social.final_publish.execute',
      });
      expect(JSON.stringify(out)).not.toContain('secret-value');
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks host mismatch before trying to click publish', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://example.test/', title: 'Wrong' } },
        },
        deps: { spawn: () => { calls.push('spawned'); } },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('final_publish_browser_host_mismatch');
      expect(out.executionAttempted).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks when the browser cannot confirm the final publish click', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          priorStageEvidence: chainStageEvidence(),
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: {
          spawn: fakeSpawnWithStdout({
            calls: [],
            stdout: JSON.stringify({
              ok: false,
              app: 'Google Chrome',
              result: { ok: false, error: 'final_publish_button_not_found', host: 'creator.douyin.com' },
              postPublishProbe: { ok: true, url: 'https://creator.douyin.com/', title: 'Douyin' },
              publishPerformed: false,
              finalButtonClicked: false,
              formSubmitted: false,
            }),
          }),
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('final_publish_button_not_found');
      expect(out.blockers).toContain('final_publish_click_not_confirmed');
      expect(out.execution).toMatchObject({
        publishPerformed: false,
        finalButtonClicked: false,
        formSubmitted: false,
      });
      expect(out.rollbackEvidence).toMatchObject({
        evidenceStatus: 'pending_probe',
        verifiedByNoe: false,
      });
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('rejects a Xiaohongshu final publish result if the clicked element is not the custom publish button', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    try {
      const draft = createDraft(draftDir, { platform: 'xiaohongshu' });
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'xiaohongshu',
          priorStageEvidence: chainStageEvidence(),
          browserState: { activeBrowser: { url: 'https://creator.xiaohongshu.com/publish/publish', title: 'XHS' } },
        },
        deps: {
          spawn: fakeSpawnWithStdout({
            calls: [],
            stdout: JSON.stringify({
              ok: true,
              app: 'Google Chrome',
              result: {
                ok: true,
                host: 'creator.xiaohongshu.com',
                clickedLabel: '发布',
                clickedTag: 'button',
                submitDisabled: '',
                finalButtonClicked: true,
                formSubmitted: false,
              },
              postPublishProbe: { ok: true, url: 'https://creator.xiaohongshu.com/publish/publish', title: 'XHS' },
              publishPerformed: true,
              finalButtonClicked: true,
              formSubmitted: false,
            }),
          }),
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('final_publish_xhs_clicked_tag_mismatch:button');
      expect(out.publishPerformed).toBe(false);
      expect(out.draftExternalSideEffectPersisted).toBe(false);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('does not treat a Xiaohongshu editor URL as verified post-publish evidence', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    try {
      const draft = createDraft(draftDir, { platform: 'xiaohongshu' });
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'xiaohongshu',
          priorStageEvidence: chainStageEvidence(),
          browserState: { activeBrowser: { url: 'https://creator.xiaohongshu.com/publish/publish', title: 'XHS' } },
        },
        deps: {
          spawn: fakeSpawnWithStdout({
            calls: [],
            stdout: JSON.stringify({
              ok: true,
              app: 'Google Chrome',
              result: {
                ok: true,
                host: 'creator.xiaohongshu.com',
                clickedLabel: '发布',
                clickedTag: 'xhs-publish-btn',
                submitDisabled: 'false',
                nativeClickRequired: true,
                nativeClickPerformed: true,
                finalButtonClicked: true,
                formSubmitted: false,
              },
              postPublishProbe: { ok: true, url: 'https://creator.xiaohongshu.com/publish/publish', title: '小红书创作服务平台' },
              publishPerformed: true,
              finalButtonClicked: true,
              formSubmitted: false,
            }),
          }),
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('final_publish_post_publish_url_not_verified');
      expect(out.externalSideEffectPerformed).toBe(true);
      expect(out.publishAttempted).toBe(true);
      expect(out.publishVerified).toBe(false);
      expect(out.publishPerformed).toBe(false);
      expect(out.draftExternalSideEffectPersisted).toBe(true);
      expect(out.rollbackEvidence).toMatchObject({
        evidenceStatus: 'pending_probe',
        missingEvidence: expect.arrayContaining(['final_publish_not_confirmed', 'post_publish_url_not_verified']),
        verifiedByNoe: false,
      });
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  // Task 0.2 Step4: prior-stage evidence must be required by DEFAULT for a real publish — a caller
  // must not be able to skip the chain just by omitting requirePriorStageEvidence.
  it('blocks a real publish by default when no prior-stage evidence is supplied', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          // NOTE: requirePriorStageEvidence intentionally omitted.
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: { spawn: () => { calls.push('spawned'); } },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('final_publish_prior_stage_evidence_required');
      expect(out.executionAttempted).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  // Task 0.2 Step4: requireDraft:false must not become an escape hatch that lets a publish run with
  // no real draft AND no chain-injected stage evidence.
  it('does not let requireDraft:false bypass prior-stage evidence for a real publish', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    const calls = [];
    try {
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: true,
        args: {
          draftId: 'no-such-draft',
          platform: 'douyin',
          requireDraft: false,
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: { spawn: () => { calls.push('spawned'); } },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('final_publish_prior_stage_evidence_required');
      expect(out.executionAttempted).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  // Task 0.2 Step4: explicitly opting out (requirePriorStageEvidence:false) is still allowed for the
  // owner-driven path, so we don't break the legitimate "I already verified manually" flow.
  it('still allows an explicit opt-out of prior-stage evidence', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: false,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          requirePriorStageEvidence: false,
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: { spawn: () => { calls.push('spawned'); } },
      });

      expect(out.ok).toBe(true);
      expect(out.priorStageEvidence.required).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('flags unsafe form submit automation while allowing controlled final publish click', () => {
    const script = buildNoeSocialFinalPublishExecuteScript({
      browserApp: 'Google Chrome',
      platform: 'douyin',
      expectedHosts: ['creator.douyin.com'],
    });

    expect(finalPublishScriptContainsUnsafeAction(script)).toBe(false);
    expect(finalPublishScriptContainsUnsafeAction('document.querySelector("form").submit()')).toBe(true);
    expect(finalPublishScriptContainsUnsafeAction('form.requestSubmit()')).toBe(true);
  });

  it('targets the Xiaohongshu custom publish component instead of the sidebar entry', () => {
    const script = buildNoeSocialFinalPublishExecuteScript({
      browserApp: 'Google Chrome',
      platform: 'xiaohongshu',
      expectedHosts: ['creator.xiaohongshu.com'],
    });

    expect(script).toContain('xhs-publish-btn');
    expect(script).toContain('submit-disabled');
    expect(script).toContain('\\"platform\\":\\"xiaohongshu\\"');
    expect(script).toContain('final_publish_xhs_publish_button_not_ready');
    expect(script).toContain('nativeClickRequired');
    expect(script).toContain('command -v cliclick');
    expect(script).toContain("doShellScript(cliclickPath + ' c:'");
    expect(script).toContain('xhs_split_button_submit_region');
    expect(script).toContain('* 0.593');
    expect(script).toContain('menu-container');
    expect(script).toContain('发布笔记');
    expect(finalPublishScriptContainsUnsafeAction(script)).toBe(false);
  });

  it('keeps the scroll-to-bottom helper gated to Xiaohongshu', () => {
    const script = buildNoeSocialFinalPublishExecuteScript({
      browserApp: 'Google Chrome',
      platform: 'douyin',
      expectedHosts: ['creator.douyin.com'],
    });

    expect(script).toContain("if (payload.platform === 'xiaohongshu')");
    expect(script).toContain('\\"platform\\":\\"douyin\\"');
    expect(finalPublishScriptContainsUnsafeAction(script)).toBe(false);
  });

  it('allows a longer post-publish probe delay for real platform navigation', () => {
    const script = buildNoeSocialFinalPublishExecuteScript({
      browserApp: 'Google Chrome',
      platform: 'xiaohongshu',
      expectedHosts: ['creator.xiaohongshu.com'],
      postPublishProbeDelaySeconds: 8,
    });

    expect(script).toContain('delay(8);');
  });

  // codex post-review: 已发布 draft 必须阻断重复 final publish（:350 之前是 warnings 不挡 :434 osascript 点击）
  it('blocks a repeat final publish on an already-published draft (no spawn)', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      markNoeSocialDraftExternalSideEffect({ dir: draftDir, id: draft.id });
      const out = await executeNoeSocialFinalPublish({
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          priorStageEvidence: chainStageEvidence(),
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: { spawn: () => { calls.push('spawned'); } },
      });
      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('draft_already_has_external_side_effect');
      expect(out.executionAttempted).toBe(false);
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });
});
