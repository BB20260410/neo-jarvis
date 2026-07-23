export function fakeRequestFactory({
  executeStatus = 409,
  editorStatus = 409,
  directEditorStatus = 200,
  mediaUploadFound = true,
  mediaUploadStatus = 200,
} = {}) {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, options });
    if (path === '/') return { status: 200, json: { ok: true } };
    if (path === '/api/noe/freedom/session/start') {
      return {
        status: 200,
        json: {
          ok: true,
          session: {
            sessionId: 'freedom-session-social-dom-unit',
            mode: options.body?.mode || 'developer_unrestricted',
            ownerPresent: options.body?.ownerPresent === true,
            secretValuesReturned: false,
          },
        },
      };
    }
    if (path === '/api/noe/freedom/dry-run') {
      const includeMedia = options.body?.args?.includeDomMediaPickerAction === true;
      const requiredProbeRoles = ['read_title', 'content', 'tags'];
      if (includeMedia) requiredProbeRoles.push('media_upload');
      requiredProbeRoles.push('creator_publish_entry');
      const actions = [
        { type: 'read_title' },
        { type: 'probe_by_hints', role: 'content', probeTarget: 'field', hints: ['正文'] },
        { type: 'probe_by_hints', role: 'tags', probeTarget: 'field', hints: ['标签'] },
      ];
      if (includeMedia) {
        actions.push({ type: 'probe_by_hints', role: 'media_upload', probeTarget: 'clickable', hints: ['上传'] });
      }
      actions.push({ type: 'probe_by_hints', role: 'creator_publish_entry', probeTarget: 'clickable', hints: ['发布笔记'] });
      return {
        status: 200,
        json: {
          ok: true,
          runtime: {
            nextFreedomActions: [
              {
                stepId: 'probe_dom_recipe_targets',
                actionId: 'noe.freedom.browser.dom.execute',
                args: {
                  browserApp: 'Google Chrome',
                  expectedHost: 'creator.xiaohongshu.com',
                  expectedHosts: ['creator.xiaohongshu.com'],
                  pageProbe: {
                    targetSurface: 'creator_publish_editor',
                    requiresLoginSession: true,
                    requiredProbeRoles,
                    expectedHosts: ['creator.xiaohongshu.com'],
                  },
                  actions,
                },
              },
            ],
          },
        },
      };
    }
    if (path !== '/api/noe/freedom/execute') return { status: 404, json: { ok: false } };

    const requestActions = Array.isArray(options.body?.args?.actions) ? options.body.args.actions : [];
    const hasMediaProbe = requestActions.some((action) => action.role === 'media_upload');
    if (options.body?.action === 'noe.freedom.social.media_upload.execute') return fakeControlledMediaUpload({ status: mediaUploadStatus });
    if (options.body?.action === 'noe.freedom.social.draft.create') return fakeDraftCreate(options);
    if (options.body?.action === 'noe.freedom.social.form_fill.execute') return fakeFormFill(options);
    if (options.body?.action === 'noe.freedom.browser.open') return fakeOpen(options);
    if (options.body?.runId?.startsWith('social-dom-post-upload-field-probe-')) return fakePostUploadFieldProbe();
    if (options.body?.runId?.startsWith('social-dom-post-fill-field-probe-')) return fakePostUploadFieldProbe();
    if (options.body?.runId?.startsWith('social-dom-direct-editor-probe-')) {
      return fakeDirectEditorProbe({ directEditorStatus, hasMediaProbe, mediaUploadFound });
    }
    if (requestActions.some((action) => action.type === 'click_by_hints' && action.role === 'creator_publish_entry')) {
      return fakeCreatorEntryClick();
    }
    if (options.body?.runId?.startsWith('social-dom-editor-probe-')) {
      return fakeEditorProbe({ editorStatus, hasMediaProbe, mediaUploadFound });
    }
    return fakeInitialProbe({ executeStatus, hasMediaProbe, mediaUploadFound });
  };
  return { request, calls };
}

function fakeDraftCreate(options = {}) {
  return {
    status: 200,
    json: {
      ok: true,
      blockers: [],
      runtime: {
        adapter: 'social-draft-create',
        id: options.body?.args?.id || 'live-form-fill-xiaohongshu-1',
        ref: `${options.body?.args?.id || 'live-form-fill-xiaohongshu-1'}.json`,
        platform: options.body?.args?.platform || 'xiaohongshu',
        externalSideEffectPerformed: false,
      },
    },
  };
}

function fakeFormFill() {
  return {
    status: 200,
    json: {
      ok: true,
      blockers: [],
      runtime: {
        adapter: 'social-form-fill-execute',
        plannedOnly: false,
        executionAttempted: true,
        externalSideEffectPerformed: false,
        publishPerformed: false,
        execution: {
          finalButtonClicked: false,
          formSubmitted: false,
          browser: {
            ok: true,
            app: 'Google Chrome',
            result: {
              ok: true,
              host: 'creator.xiaohongshu.com',
              titleFilled: true,
              contentFilled: true,
              titleEchoMatched: true,
              contentEchoMatched: true,
              titleTag: 'input',
              contentTag: 'textarea',
              sameField: false,
              mediaHandled: false,
              finalButtonClicked: false,
              formSubmitted: false,
            },
            finalButtonClicked: false,
            formSubmitted: false,
          },
        },
      },
    },
  };
}

function fakeControlledMediaUpload({ status = 200 } = {}) {
  const ok = status === 200;
  return {
    status,
    json: {
      ok,
      blockers: ok ? [] : ['review_brain_blocked'],
      runtime: {
        adapter: ok ? 'social-media-upload-execute' : '',
        plannedOnly: false,
        mediaSelectionAttempted: ok,
        externalSideEffectPerformed: ok,
        publishPerformed: false,
        fileContentRead: false,
        selectedMedia: ok ? {
          ref: 'clips/demo.mp4',
          kind: 'video',
          contentRead: false,
        } : null,
        execution: {
          fileSelected: ok,
          uploadStarted: ok,
          finalButtonClicked: false,
          formSubmitted: false,
          browser: {
            result: {
              targetType: ok ? 'file_input' : '',
              clickedUploadControl: ok,
            },
          },
        },
      },
    },
  };
}

function fakePostUploadFieldProbe() {
  return {
    status: 200,
    json: {
      ok: true,
      blockers: [],
      runtime: {
        adapter: 'browser-dom-execute',
        host: 'creator.xiaohongshu.com',
        url: 'https://creator.xiaohongshu.com/publish/post',
        title: 'XHS Editor After Upload',
        actionCount: 4,
        actions: [
          { type: 'read_title', role: '', found: true, clicked: false, probed: false },
          { type: 'probe_by_hints', role: 'content', found: true, clicked: false, probed: true },
          { type: 'probe_by_hints', role: 'tags', found: true, clicked: false, probed: true },
          { type: 'probe_by_hints', role: 'media_upload', found: true, clicked: false, probed: true },
        ],
        pageReadiness: {
          ok: true,
          hostMatched: true,
          targetSurface: 'creator_publish_editor',
          targetSurfaceReady: true,
          loginSessionLikely: true,
          foundRoles: ['read_title', 'content', 'tags', 'media_upload'],
          missingRoles: [],
        },
        secretValuesReturned: false,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
      },
    },
  };
}

function fakeOpen(options = {}) {
  const url = options.body.args.url || 'https://creator.xiaohongshu.com/';
  const host = new URL(url).host;
  return {
    status: 200,
    json: {
      ok: true,
      blockers: [],
      runtime: {
        adapter: 'browser-open',
        host,
        browserApp: options.body.args.browserApp || '',
        browserOpenAttempted: true,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
      },
    },
  };
}

function fakeDirectEditorProbe({ directEditorStatus, hasMediaProbe, mediaUploadFound }) {
  const foundRoles = ['read_title', 'content', 'tags'];
  const missingRoles = [];
  if (hasMediaProbe && mediaUploadFound) foundRoles.push('media_upload');
  else if (hasMediaProbe) missingRoles.push('media_upload');
  const mediaUploadActionFound = directEditorStatus === 200 && mediaUploadFound;
  const actions = [
    { type: 'read_title', role: '', found: true, clicked: false, probed: false },
    { type: 'probe_by_hints', role: 'content', found: true, clicked: false, probed: true },
    { type: 'probe_by_hints', role: 'tags', found: true, clicked: false, probed: true },
  ];
  if (hasMediaProbe) {
    actions.push({ type: 'probe_by_hints', role: 'media_upload', found: mediaUploadActionFound, clicked: false, probed: mediaUploadActionFound });
  }
  return {
    status: directEditorStatus,
    json: {
      ok: directEditorStatus === 200,
      blockers: directEditorStatus === 200 ? [] : ['freedom_runtime_failed'],
      runtime: {
        adapter: 'browser-dom-execute',
        host: 'creator.xiaohongshu.com',
        url: 'https://creator.xiaohongshu.com/publish/post?token=secret-value',
        title: 'XHS Direct Editor',
        actionCount: actions.length,
        actions,
        pageReadiness: {
          ok: directEditorStatus === 200 && missingRoles.length === 0,
          hostMatched: true,
          targetSurface: 'creator_publish_editor',
          targetSurfaceReady: directEditorStatus === 200 && missingRoles.length === 0,
          loginSessionLikely: true,
          foundRoles: directEditorStatus === 200 ? foundRoles : ['read_title'],
          missingRoles: directEditorStatus === 200 ? missingRoles : ['content', 'tags'],
        },
        secretValuesReturned: false,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
      },
    },
  };
}

function fakeCreatorEntryClick() {
  return {
    status: 200,
    json: {
      ok: true,
      blockers: [],
      runtime: {
        adapter: 'browser-dom-execute',
        host: 'creator.xiaohongshu.com',
        title: 'XHS Creator',
        actionCount: 2,
        actions: [
          { type: 'read_title', role: '', found: true, clicked: false },
          { type: 'click_by_hints', role: 'creator_publish_entry', found: true, clicked: true },
        ],
        secretValuesReturned: false,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
      },
    },
  };
}

function fakeEditorProbe({ editorStatus, hasMediaProbe, mediaUploadFound }) {
  const foundRoles = editorStatus === 200 ? ['read_title', 'content', 'tags'] : ['read_title', 'content'];
  const missingRoles = editorStatus === 200 ? [] : ['tags'];
  if (hasMediaProbe && mediaUploadFound) foundRoles.push('media_upload');
  else if (hasMediaProbe) missingRoles.push('media_upload');
  const actions = [
    { type: 'read_title', role: '', found: true, clicked: false, probed: false },
    { type: 'probe_by_hints', role: 'content', found: true, clicked: false, probed: true },
    { type: 'probe_by_hints', role: 'tags', found: editorStatus === 200, clicked: false, probed: editorStatus === 200 },
  ];
  if (hasMediaProbe) {
    actions.push({ type: 'probe_by_hints', role: 'media_upload', found: mediaUploadFound, clicked: false, probed: mediaUploadFound });
  }
  return {
    status: editorStatus,
    json: {
      ok: editorStatus === 200,
      blockers: editorStatus === 200 ? [] : ['freedom_runtime_failed'],
      runtime: {
        adapter: 'browser-dom-execute',
        host: 'creator.xiaohongshu.com',
        title: 'XHS Editor',
        actionCount: actions.length,
        actions,
        pageReadiness: {
          ok: editorStatus === 200 && missingRoles.length === 0,
          hostMatched: true,
          targetSurface: 'creator_publish_editor',
          targetSurfaceReady: editorStatus === 200 && missingRoles.length === 0,
          loginSessionLikely: true,
          foundRoles,
          missingRoles,
        },
        secretValuesReturned: false,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
      },
    },
  };
}

function fakeInitialProbe({ executeStatus, hasMediaProbe, mediaUploadFound }) {
  return {
    status: executeStatus,
    json: {
      ok: executeStatus === 200,
      blockers: executeStatus === 200 ? [] : ['freedom_runtime_failed'],
      runtime: {
        adapter: 'browser-dom-execute',
        host: 'creator.xiaohongshu.com',
        title: 'XHS Creator',
        actionCount: hasMediaProbe ? 4 : 3,
        actions: [
          { type: 'read_title', role: '', found: true, clicked: false, probed: false },
          { type: 'probe_by_hints', role: 'content', found: true, clicked: false, probed: true },
          ...(hasMediaProbe ? [{ type: 'probe_by_hints', role: 'media_upload', found: mediaUploadFound, clicked: false, probed: mediaUploadFound }] : []),
          { type: 'probe_by_hints', role: 'creator_publish_entry', found: true, clicked: false, probed: true },
        ],
        pageReadiness: {
          ok: executeStatus === 200,
          hostMatched: true,
          targetSurface: 'creator_publish_editor',
          targetSurfaceReady: executeStatus === 200,
          loginSessionLikely: true,
          foundRoles: executeStatus === 200
            ? ['read_title', 'content', 'tags', ...(hasMediaProbe && mediaUploadFound ? ['media_upload'] : []), 'creator_publish_entry']
            : ['read_title', 'content', ...(hasMediaProbe && mediaUploadFound ? ['media_upload'] : []), 'creator_publish_entry'],
          missingRoles: executeStatus === 200
            ? (hasMediaProbe && !mediaUploadFound ? ['media_upload'] : [])
            : ['tags', ...(hasMediaProbe && !mediaUploadFound ? ['media_upload'] : [])],
        },
        secretValuesReturned: false,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
      },
    },
  };
}
