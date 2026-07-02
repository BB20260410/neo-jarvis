import { describe, expect, it } from 'vitest';
import { runNoeSocialDomLiveProbe } from '../../scripts/noe-social-dom-live-probe.mjs';
import { fakeRequestFactory } from './helpers/noe-social-dom-live-probe-fake.js';

describe('noe-social-dom-live-probe script', () => {
  it('blocks live owner-token access unless explicitly acknowledged', async () => {
    const { request, calls } = fakeRequestFactory();
    const out = await runNoeSocialDomLiveProbe({
      request,
      requireOwnerTokenAck: true,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: false,
      },
    });

    expect(out.ok).toBe(false);
    expect(out.tokenPolicy).toMatchObject({
      policyBlocked: true,
      ackReadOwnerToken: false,
      secretValueReturned: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('dry-runs a read-only probe contract without executing browser automation', async () => {
    const { request, calls } = fakeRequestFactory();
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: false,
      },
    });

    expect(out.ok).toBe(true);
    expect(out.checks.map((check) => check.id)).toEqual([
      'root_reachable',
      'probe_step_generated',
      'probe_step_is_read_only',
      'probe_step_has_page_readiness_contract',
    ]);
    expect(calls.map((call) => call.path)).toEqual(['/', '/api/noe/freedom/dry-run']);
    expect(JSON.stringify(out)).not.toContain('secret');
  });

  it('requires explicit owner-present acknowledgement before executing the live probe', async () => {
    const { request, calls } = fakeRequestFactory();
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        ackOwnerPresent: false,
      },
    });

    expect(out.ok).toBe(false);
    expect(out.checks.find((check) => check.id === 'execute_ack_owner_present_required')).toMatchObject({ ok: false });
    expect(calls.map((call) => call.path)).not.toContain('/api/noe/freedom/execute');
  });

  it('requires owner-present acknowledgement before opening the creator page', async () => {
    const { request, calls } = fakeRequestFactory();
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: false,
        openCreator: true,
        ackOwnerPresent: false,
      },
    });

    expect(out.ok).toBe(false);
    expect(out.checks.find((check) => check.id === 'open_creator_ack_owner_present_required')).toMatchObject({ ok: false });
    expect(calls.filter((call) => call.path === '/api/noe/freedom/execute')).toHaveLength(0);
  });

  it('opens the creator page in the requested browser before read-only probing', async () => {
    const { request, calls } = fakeRequestFactory({ executeStatus: 200 });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        openCreator: true,
        openWaitMs: 0,
        ackOwnerPresent: true,
        requireReady: true,
      },
    });

    expect(out.ok).toBe(true);
    expect(out.openSummary.runtime).toMatchObject({
      adapter: 'browser-open',
      host: 'creator.xiaohongshu.com',
      browserApp: 'Google Chrome',
      browserOpenAttempted: true,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
    });
    const executeCalls = calls.filter((call) => call.path === '/api/noe/freedom/execute');
    expect(executeCalls.map((call) => call.options.body.action)).toEqual([
      'noe.freedom.browser.open',
      'noe.freedom.browser.dom.execute',
    ]);
    expect(executeCalls[0].options.body.args).toMatchObject({
      url: 'https://creator.xiaohongshu.com/',
      browserApp: 'Google Chrome',
      priorStageEvidence: {
        ownerExplicitConfirmationRef: 'owner_explicit_confirmation_2026-06-19_publish_delete_test',
        openOnly: true,
        noUpload: true,
        noFormFill: true,
        finalPublishExcluded: true,
      },
    });
    expect(executeCalls[0].options.body.args.priorStageEvidence.browserSnapshot).not.toHaveProperty('url');
    expect(executeCalls[0].options.body.authorization.reason).toContain('owner_explicit_confirmation_2026-06-19');
  });

  it('executes only the read-only probe step and accepts structured not-ready evidence', async () => {
    const { request, calls } = fakeRequestFactory({ executeStatus: 409 });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        ackOwnerPresent: true,
        requireReady: false,
      },
    });

    expect(out.ok).toBe(true);
    expect(out.executeSummary.runtime).toMatchObject({
      adapter: 'browser-dom-execute',
      pageReadiness: {
        ok: false,
        targetSurface: 'creator_publish_editor',
        foundRoles: ['read_title', 'content', 'creator_publish_entry'],
        missingRoles: ['tags'],
      },
      secretValuesReturned: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    });
    const executeCall = calls.find((call) => call.path === '/api/noe/freedom/execute');
    expect(executeCall.options.body).toMatchObject({
      action: 'noe.freedom.browser.dom.execute',
      realExecute: true,
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
        rollbackPlan: expect.stringContaining('read-only'),
      },
    });
    expect(executeCall.options.body.authorization.allowlistAccepted).toBeUndefined();
    expect(Object.keys(executeCall.options.body.evidenceRefs || {})).toEqual(expect.arrayContaining([
      'priorStageEvidence',
      'rawOutputRef',
      'snapshot',
      'rollbackPlan',
      'ownerAuthorization',
      'portBoundary',
      'secretLeakRisk',
    ]));
    expect(executeCall.options.body.args).toMatchObject({
      priorStageEvidence: { ok: true, secretValuesReturned: false },
      snapshot: { kind: 'browser_dom_page_readiness_contract' },
      portBoundary: { panelHost: expect.any(String), panelPort: expect.any(Number) },
      secretLeakRisk: {
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        secretValuesReturned: false,
        pageContentReadByNoe: false,
      },
    });
    expect(executeCall.options.body.args.actions.map((action) => action.type)).toEqual([
      'read_title',
      'probe_by_hints',
      'probe_by_hints',
      'probe_by_hints',
    ]);
    expect(JSON.stringify(executeCall.options.body.args.actions)).not.toContain('set_by_hints');
    expect(JSON.stringify(executeCall.options.body.args.actions)).not.toContain('"value"');
  });

  it('does not enter the editor unless the entry was probed first', async () => {
    const { request, calls } = fakeRequestFactory();
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: false,
        enterEditor: true,
        ackOwnerPresent: true,
      },
    });

    expect(out.ok).toBe(false);
    expect(out.checks.find((check) => check.id === 'enter_editor_requires_initial_probe')).toMatchObject({ ok: false });
    expect(calls.filter((call) => call.path === '/api/noe/freedom/execute')).toHaveLength(0);
  });

  it('clicks only creator_publish_entry and then runs a read-only editor field probe', async () => {
    const { request, calls } = fakeRequestFactory({ executeStatus: 409, editorStatus: 200 });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        enterEditor: true,
        enterWaitMs: 0,
        ackOwnerPresent: true,
      },
    });

    expect(out.ok).toBe(true);
    expect(out.enterSummary.runtime.actions).toEqual([
      { type: 'read_title', role: 'read_title', found: true, probed: false, clicked: false },
      { type: 'click_by_hints', role: 'creator_publish_entry', found: true, probed: false, clicked: true },
    ]);
    expect(out.editorProbeSummary.runtime.pageReadiness).toMatchObject({
      ok: true,
      foundRoles: ['read_title', 'content', 'tags'],
      missingRoles: [],
    });
    const executeCalls = calls.filter((call) => call.path === '/api/noe/freedom/execute');
    expect(executeCalls.map((call) => call.options.body.runId.split('-').slice(0, 4).join('-'))).toEqual([
      'social-dom-live-probe',
      'social-dom-enter-editor',
      'social-dom-editor-probe',
    ]);
    expect(executeCalls[1].options.body.args.actions).toEqual([
      { type: 'read_title' },
      { type: 'click_by_hints', role: 'creator_publish_entry', hints: ['发布笔记'] },
    ]);
    const editorProbeCall = executeCalls[2];
    expect(editorProbeCall.options.body.args.actions.map((action) => action.role || action.type)).toEqual([
      'read_title',
      'content',
      'tags',
    ]);
    expect(JSON.stringify(editorProbeCall.options.body.args.actions)).not.toContain('creator_publish_entry');
    expect(JSON.stringify(editorProbeCall.options.body.args.actions)).not.toContain('set_by_hints');
    expect(JSON.stringify(editorProbeCall.options.body.args.actions)).not.toContain('"value"');
  });

  it('falls back to a known editor URL when entry click does not expose editor fields', async () => {
    const { request, calls } = fakeRequestFactory({ executeStatus: 409, editorStatus: 409, directEditorStatus: 200 });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        enterEditor: true,
        enterWaitMs: 0,
        ackOwnerPresent: true,
      },
    });

    expect(out.ok).toBe(true);
    expect(out.checks.map((check) => check.id)).toContain('open_known_editor_url_after_entry_not_ready');
    expect(out.checks.map((check) => check.id)).toContain('direct_editor_field_probe_returns_readiness');
    expect(out.directEditorOpenSummary.runtime).toMatchObject({
      adapter: 'browser-open',
      host: 'creator.xiaohongshu.com',
      browserOpenAttempted: true,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
    });
    expect(out.directEditorProbeSummary.runtime).toMatchObject({
      urlPresent: true,
      urlSha256: expect.any(String),
      pageReadiness: {
        ok: true,
        foundRoles: ['read_title', 'content', 'tags'],
        missingRoles: [],
      },
    });
    const executeCalls = calls.filter((call) => call.path === '/api/noe/freedom/execute');
    expect(executeCalls.map((call) => call.options.body.runId?.split('-').slice(0, 4).join('-') || call.options.body.action)).toEqual([
      'social-dom-live-probe',
      'social-dom-enter-editor',
      'social-dom-editor-probe',
      'social-dom-open-editor',
      'social-dom-direct-editor',
    ]);
    expect(executeCalls[3].options.body).toMatchObject({
      action: 'noe.freedom.browser.open',
      args: {
        url: 'https://creator.xiaohongshu.com/publish/post',
        browserApp: 'Google Chrome',
        priorStageEvidence: {
          ok: true,
          browserSnapshot: {
            sha256: expect.any(String),
            kind: 'browser_url_title_snapshot',
            host: 'creator.xiaohongshu.com',
            urlSha256: expect.any(String),
            titleSha256: expect.any(String),
          },
        },
        snapshot: {
          kind: 'browser_dom_page_readiness_contract',
          beforeBrowserSnapshot: {
            sha256: expect.any(String),
            kind: 'browser_url_title_snapshot',
            host: 'creator.xiaohongshu.com',
            urlSha256: expect.any(String),
            titleSha256: expect.any(String),
          },
        },
      },
    });
    expect(executeCalls[3].options.body.args.priorStageEvidence.browserSnapshot).not.toHaveProperty('url');
    expect(executeCalls[3].options.body.args.priorStageEvidence.browserSnapshot).not.toHaveProperty('title');
    expect(executeCalls[3].options.body.args.snapshot.beforeBrowserSnapshot).not.toHaveProperty('url');
    expect(executeCalls[3].options.body.args.snapshot.beforeBrowserSnapshot).not.toHaveProperty('title');
    expect(executeCalls[4].options.body.args.expectedUrlPrefixes).toEqual(['https://creator.xiaohongshu.com/publish/post']);
    expect(executeCalls[4].options.body.args.pageProbe.expectedUrlPrefixes).toEqual(['https://creator.xiaohongshu.com/publish/post']);
    expect(executeCalls[3].options.body.evidenceRefs.priorStageEvidence).toContain('browser_snapshot_sha256:');
    expect(executeCalls[3].options.body.evidenceRefs.snapshot).toContain('browser_snapshot_sha256:');
    expect(JSON.stringify(executeCalls[4].options.body.args.actions)).not.toContain('set_by_hints');
    expect(JSON.stringify(executeCalls[4].options.body.args.actions)).not.toContain('"value"');
  });

  it('can require media upload readiness without requiring title/content/tag fields', async () => {
    const { request, calls } = fakeRequestFactory({ executeStatus: 409, editorStatus: 409, directEditorStatus: 200 });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        enterEditor: true,
        enterWaitMs: 0,
        ackOwnerPresent: true,
        requireMediaUploadReady: true,
      },
    });

    expect(out.ok).toBe(true);
    expect(out.requireMediaUploadReady).toBe(true);
    expect(out.checks.find((check) => check.id === 'media_upload_ready')).toMatchObject({
      ok: true,
      evidence: {
        foundRoles: ['read_title', 'content', 'tags', 'media_upload'],
      },
    });
    const dryRunCall = calls.find((call) => call.path === '/api/noe/freedom/dry-run');
    expect(dryRunCall.options.body.args.includeDomMediaPickerAction).toBe(true);
    const executeCalls = calls.filter((call) => call.path === '/api/noe/freedom/execute');
    expect(JSON.stringify(executeCalls.at(-1).options.body.args.actions)).toContain('media_upload');
    expect(JSON.stringify(executeCalls.at(-1).options.body.args.actions)).not.toContain('set_by_hints');
    expect(JSON.stringify(executeCalls.at(-1).options.body.args.actions)).not.toContain('"value"');
  });

  it('keeps an earlier editor media-upload readiness when the direct editor fallback is worse', async () => {
    const { request } = fakeRequestFactory({ executeStatus: 409, editorStatus: 409, directEditorStatus: 409 });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        enterEditor: true,
        enterWaitMs: 0,
        ackOwnerPresent: true,
        requireMediaUploadReady: true,
      },
    });

    expect(out.ok).toBe(true);
    expect(out.directEditorProbeSummary.runtime.pageReadiness.foundRoles).not.toContain('media_upload');
    expect(out.checks.find((check) => check.id === 'media_upload_ready')).toMatchObject({
      ok: true,
      evidence: {
        foundRoles: expect.arrayContaining(['media_upload']),
        missingRoles: ['tags'],
      },
    });
  });

  it('fails media upload readiness when the upload entry is not found', async () => {
    const { request } = fakeRequestFactory({
      executeStatus: 409,
      editorStatus: 409,
      directEditorStatus: 200,
      mediaUploadFound: false,
    });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        enterEditor: true,
        enterWaitMs: 0,
        ackOwnerPresent: true,
        requireMediaUploadReady: true,
      },
    });

    expect(out.ok).toBe(false);
    expect(out.checks.find((check) => check.id === 'media_upload_ready')).toMatchObject({
      ok: false,
      evidence: {
        missingRoles: ['media_upload'],
      },
    });
  });

  it('requires a separate acknowledgement before controlled media upload', async () => {
    const { request, calls } = fakeRequestFactory({ executeStatus: 409, editorStatus: 409, directEditorStatus: 200 });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        enterEditor: true,
        enterWaitMs: 0,
        ackOwnerPresent: true,
        uploadAfterMediaReady: true,
        mediaFiles: ['clips/demo.mp4'],
      },
    });

    expect(out.ok).toBe(false);
    expect(out.checks.find((check) => check.id === 'controlled_media_upload_ack_required')).toMatchObject({ ok: false });
    expect(calls.some((call) => call.options.body?.action === 'noe.freedom.social.media_upload.execute')).toBe(false);
  });

  it('runs controlled media upload and then probes fields without final publish', async () => {
    const { request, calls } = fakeRequestFactory({ executeStatus: 409, editorStatus: 409, directEditorStatus: 200 });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        enterEditor: true,
        enterWaitMs: 0,
        ackOwnerPresent: true,
        uploadAfterMediaReady: true,
        ackUploadSideEffect: true,
        mediaFiles: ['clips/demo.mp4'],
      },
    });

    expect(out.ok).toBe(true);
    expect(out.uploadAfterMediaReady).toBe(true);
    expect(out.mediaUploadSummary.runtime).toMatchObject({
      adapter: 'social-media-upload-execute',
      mediaSelectionAttempted: true,
      externalSideEffectPerformed: true,
      publishPerformed: false,
      fileContentRead: false,
      execution: {
        fileSelected: true,
        uploadStarted: true,
        finalButtonClicked: false,
        formSubmitted: false,
      },
    });
    expect(out.postUploadProbeSummary.runtime.pageReadiness).toMatchObject({
      ok: true,
      foundRoles: ['read_title', 'content', 'tags', 'media_upload'],
      missingRoles: [],
    });
    const uploadCall = calls.find((call) => call.options.body?.action === 'noe.freedom.social.media_upload.execute');
    expect(uploadCall.options.body).toMatchObject({
      realExecute: true,
      args: {
        requireDraft: false,
        mediaFiles: ['clips/demo.mp4'],
        browserState: {
          activeBrowser: {
            host: 'creator.xiaohongshu.com',
            urlPresent: true,
            urlSha256: expect.any(String),
            titlePresent: true,
          },
        },
        priorStageEvidence: {
          stageContract: {
            operation: 'social_media_upload_execute_before_text_fields',
            mediaUploadBeforeTextFieldsAllowed: true,
            requiredPreActionRoles: ['media_upload'],
            postUploadFieldProbeRequired: true,
            finalPublishExcluded: true,
            formSubmitExcluded: true,
          },
        },
        snapshot: {
          stageContract: {
            textFieldsExpectedAfterUpload: true,
          },
        },
      },
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
    });
    expect(uploadCall.options.body.args.browserState.activeBrowser).not.toHaveProperty('url');
    expect(uploadCall.options.body.args.browserState.activeBrowser).not.toHaveProperty('title');
    expect(uploadCall.options.body.args.priorStageEvidence.domStateBeforeAction).not.toHaveProperty('url');
    expect(uploadCall.options.body.args.priorStageEvidence.domStateBeforeAction).toMatchObject({
      urlPresent: true,
      urlSha256: expect.any(String),
      noFinalPublishActionTouched: true,
    });
    const postUploadProbeCall = calls.find((call) => call.options.body?.runId?.startsWith('social-dom-post-upload-field-probe-'));
    expect(JSON.stringify(postUploadProbeCall.options.body.args.actions)).not.toContain('set_by_hints');
    expect(JSON.stringify(postUploadProbeCall.options.body.args.actions)).not.toContain('"value"');
    expect(JSON.stringify(postUploadProbeCall.options.body.args.actions)).not.toContain('final_publish');
  });

  it('continues controlled media upload when only the earlier editor probe found the upload entry', async () => {
    const { request, calls } = fakeRequestFactory({ executeStatus: 409, editorStatus: 409, directEditorStatus: 409 });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        enterEditor: true,
        enterWaitMs: 0,
        ackOwnerPresent: true,
        uploadAfterMediaReady: true,
        ackUploadSideEffect: true,
        mediaFiles: ['clips/demo.mp4'],
      },
    });

    expect(out.ok).toBe(true);
    expect(out.directEditorProbeSummary.runtime.pageReadiness.foundRoles).not.toContain('media_upload');
    expect(out.checks.find((check) => check.id === 'controlled_media_upload_executed_without_publish')).toMatchObject({ ok: true });
    const uploadCall = calls.find((call) => call.options.body?.action === 'noe.freedom.social.media_upload.execute');
    expect(uploadCall).toBeTruthy();
    expect(uploadCall.options.body.args.priorStageEvidence.domStateBeforeAction.pageReadiness.foundRoles).toContain('media_upload');
  });

  it('skips draft creation and form fill when controlled media upload is blocked', async () => {
    const { request, calls } = fakeRequestFactory({
      executeStatus: 409,
      editorStatus: 409,
      directEditorStatus: 200,
      mediaUploadStatus: 409,
    });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        enterEditor: true,
        enterWaitMs: 0,
        ackOwnerPresent: true,
        uploadAfterMediaReady: true,
        fillAfterUpload: true,
        ackUploadSideEffect: true,
        mediaFiles: ['clips/demo.mp4'],
      },
    });

    expect(out.ok).toBe(false);
    expect(out.checks.find((check) => check.id === 'controlled_form_fill_requires_successful_media_upload')).toMatchObject({
      ok: false,
      evidence: {
        mediaUploadOk: false,
      },
    });
    expect(calls.some((call) => call.options.body?.action === 'noe.freedom.social.draft.create')).toBe(false);
    expect(calls.some((call) => call.options.body?.action === 'noe.freedom.social.form_fill.execute')).toBe(false);
  });

  it('can create a local draft and fill fields after controlled media upload without final publish', async () => {
    const { request, calls } = fakeRequestFactory({ executeStatus: 409, editorStatus: 409, directEditorStatus: 200 });
    const out = await runNoeSocialDomLiveProbe({
      request,
      options: {
        platform: 'xiaohongshu',
        browserApp: 'Google Chrome',
        title: 'title',
        content: 'content',
        tags: ['NoeProbe'],
        execute: true,
        enterEditor: true,
        enterWaitMs: 0,
        ackOwnerPresent: true,
        uploadAfterMediaReady: true,
        fillAfterUpload: true,
        ackUploadSideEffect: true,
        mediaFiles: ['clips/demo.mp4'],
      },
    });

    expect(out.ok).toBe(true);
    expect(out.fillAfterUpload).toBe(true);
    expect(out.draftCreateSummary.runtime).toMatchObject({
      adapter: 'social-draft-create',
      externalSideEffectPerformed: false,
    });
    expect(out.formFillSummary.runtime).toMatchObject({
      adapter: 'social-form-fill-execute',
      executionAttempted: true,
      externalSideEffectPerformed: false,
      publishPerformed: false,
      execution: {
        finalButtonClicked: false,
        formSubmitted: false,
        browser: {
          titleFilled: true,
          contentFilled: true,
          titleEchoMatched: true,
          contentEchoMatched: true,
          sameField: false,
          finalButtonClicked: false,
          formSubmitted: false,
        },
      },
    });
    expect(out.postFillProbeSummary.runtime.pageReadiness).toMatchObject({
      ok: true,
      foundRoles: ['read_title', 'content', 'tags', 'media_upload'],
      missingRoles: [],
    });
    const executeCalls = calls.filter((call) => call.path === '/api/noe/freedom/execute');
    expect(executeCalls.map((call) => call.options.body.action)).toContain('noe.freedom.social.draft.create');
    expect(executeCalls.map((call) => call.options.body.action)).toContain('noe.freedom.social.form_fill.execute');
    const formFillCall = executeCalls.find((call) => call.options.body.action === 'noe.freedom.social.form_fill.execute');
    expect(formFillCall.options.body).toMatchObject({
      realExecute: true,
      args: {
        browserState: {
          activeBrowser: {
            host: 'creator.xiaohongshu.com',
            urlPresent: true,
            urlSha256: expect.any(String),
            titlePresent: true,
          },
        },
      },
      authorization: {
        mode: 'developer_unrestricted',
        ownerPresent: true,
      },
    });
    expect(formFillCall.options.body.args.browserState.activeBrowser).not.toHaveProperty('url');
    expect(formFillCall.options.body.args.browserState.activeBrowser).not.toHaveProperty('title');
    expect(formFillCall.options.body.args.priorStageEvidence.domStateBeforeAction).not.toHaveProperty('url');
    expect(JSON.stringify(formFillCall.options.body.args)).not.toContain('final_publish');
    expect(JSON.stringify(formFillCall.options.body.args)).not.toContain('publishPerformed');
    expect(JSON.stringify(formFillCall.options.body)).not.toContain('publish_delete_live_test');
    expect(JSON.stringify(formFillCall.options.body)).toContain('form_fill_only');
  });
});
