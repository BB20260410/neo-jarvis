import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoeSocialDraft } from '../../src/runtime/NoeSocialPublishQueue.js';
import {
  buildNoeSocialMediaUploadExecuteScript,
  executeNoeSocialMediaUpload,
  mediaUploadScriptContainsFinalPublishAction,
} from '../../src/runtime/NoeSocialMediaUploadExecutor.js';

function createDraft(dir, mediaFiles = ['clips/demo.mp4']) {
  return createNoeSocialDraft({
    dir,
    draft: {
      id: 'media-upload-draft',
      platform: 'douyin',
      content: 'ready content',
      metadata: { title: 'ready title', mediaFiles },
    },
  });
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

describe('NoeSocialMediaUploadExecutor', () => {
  it('executes a controlled single-file media upload without final publish', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-drafts-'));
    const calls = [];
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialMediaUpload({
        root,
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
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
                url: 'https://creator.douyin.com/creator-micro/content/upload',
                targetType: 'file_input',
                selector: 'input[type=file]',
                clickedUploadControl: true,
                finalButtonClicked: false,
                formSubmitted: false,
              },
              verification: {
                ok: true,
                fileSelected: true,
                selectedFileCount: 1,
                uploadPageReached: true,
                finalButtonClicked: false,
                formSubmitted: false,
              },
              clipboardOverwritten: true,
              mediaDialogAttempted: true,
              fileSelected: true,
              uploadStarted: true,
              permissionPromptDismissedCount: 1,
              clickRetriedAfterPermissionPrompt: true,
              geolocationShimInstalled: true,
              geolocationShimError: '',
              finalButtonClicked: false,
              formSubmitted: false,
            }),
          }),
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-media-upload-execute',
        plannedOnly: false,
        mediaSelectionAttempted: true,
        externalSideEffectPerformed: true,
        publishPerformed: false,
        fileContentRead: false,
        selectedMedia: {
          ref: 'clips/demo.mp4',
          kind: 'video',
          contentRead: false,
        },
        execution: {
          command: 'osascript',
          language: 'JavaScript',
          stdoutReturned: false,
          fileSelected: true,
          uploadStarted: true,
          clipboardOverwritten: true,
          finalButtonClicked: false,
          formSubmitted: false,
          browser: {
            ok: true,
            clipboardOverwritten: true,
            verification: {
              fileSelected: true,
              selectedFileCount: 1,
              uploadPageReached: true,
            },
            permissionPromptDismissedCount: 1,
            clickRetriedAfterPermissionPrompt: true,
            geolocationShimInstalled: true,
            result: {
              host: 'creator.douyin.com',
              urlPresent: true,
              urlSha256: expect.any(String),
              targetType: 'file_input',
              targetForbidden: false,
              forbiddenHits: [],
              clickedUploadControl: true,
              finalButtonClicked: false,
              formSubmitted: false,
            },
          },
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('osascript');
      expect(calls[0].args[3]).toContain('clickPoint');
      expect(calls[0].args[3]).toContain('command -v cliclick');
      expect(calls[0].args[3]).toContain("doShellScript(cliclickPath + ' c:'");
      expect(calls[0].args[3]).toContain('setTheClipboardTo(mediaFilePath)');
      expect(calls[0].args[3]).toContain('dismissBrowserPermissionPrompt');
      expect(calls[0].args[3]).toContain('clickRetriedAfterPermissionPrompt');
      expect(calls[0].args[3]).toContain('geolocationShimInstalled');
      expect(calls[0].args[3]).toContain("keystroke('v'");
      expect(calls[0].args[3]).toContain('frontChromeLikeWindow(windows)');
      expect(calls[0].args[3]).toContain('selectedFileCount');
      expect(calls[0].args[3]).toContain('targetForbidden');
      expect(calls[0].args[3]).toContain('forbiddenHits');
      expect(calls[0].args[3]).toContain('const target = fileInput || labelForFileInput || fileInputProxy || uploadZone');
      expect(calls[0].args[3]).not.toContain('const target = uploadZone || fileInput');
      expect(calls[0].args[3]).not.toContain('fileInput.click()');
      expect(calls[0].args[3]).not.toContain('.submit(');
      expect(calls[0].args[3]).not.toContain('requestSubmit(');
      expect(JSON.stringify(out)).not.toContain('"stdout":');
      expect(JSON.stringify(out)).not.toContain('video-bytes');
      expect(JSON.stringify(out)).not.toContain('creator-micro/content/upload');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('dry-runs controlled media upload without spawning osascript', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-drafts-'));
    const calls = [];
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialMediaUpload({
        root,
        draftDir,
        realExecute: false,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: { spawn: () => { calls.push('spawned'); } },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-media-upload-execute',
        plannedOnly: true,
        mediaSelectionAttempted: false,
        externalSideEffectPerformed: false,
        publishPerformed: false,
      });
      expect(out.nextFreedomActions[0]).toMatchObject({
        actionId: 'noe.freedom.social.media_upload.execute',
      });
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks multi-file uploads until a controlled multi-select executor exists', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-drafts-'));
    const calls = [];
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'one.mp4'), 'one', 'utf8');
      writeFileSync(join(root, 'clips', 'two.mp4'), 'two', 'utf8');
      const draft = createDraft(draftDir, ['clips/one.mp4', 'clips/two.mp4']);
      const out = await executeNoeSocialMediaUpload({
        root,
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: { spawn: () => { calls.push('spawned'); } },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('media_upload_single_file_required');
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks when the browser reports upload selector failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-drafts-'));
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialMediaUpload({
        root,
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: {
          spawn: fakeSpawnWithStdout({
            calls: [],
            stdout: JSON.stringify({
              ok: false,
              app: 'Google Chrome',
              result: { ok: false, error: 'media_upload_selector_not_found', host: 'creator.douyin.com' },
              verification: { ok: true, fileSelected: false, selectedFileCount: 0 },
              mediaDialogAttempted: false,
              fileSelected: false,
              uploadStarted: false,
              finalButtonClicked: false,
              formSubmitted: false,
            }),
          }),
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('media_upload_selector_not_found');
      expect(out.blockers).toContain('media_upload_file_selection_not_confirmed');
      expect(out.execution).toMatchObject({
        fileSelected: false,
        uploadStarted: false,
        finalButtonClicked: false,
        formSubmitted: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks when the browser target has publish/post semantics', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-drafts-'));
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialMediaUpload({
        root,
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: { activeBrowser: { host: 'creator.douyin.com' } },
        },
        deps: {
          spawn: fakeSpawnWithStdout({
            calls: [],
            stdout: JSON.stringify({
              ok: false,
              app: 'Google Chrome',
              result: {
                ok: false,
                error: 'media_upload_target_forbidden_publish_semantics',
                host: 'creator.douyin.com',
                targetForbidden: true,
                forbiddenHits: ['publish'],
                finalButtonClicked: false,
                formSubmitted: false,
              },
              verification: { ok: true, fileSelected: false, selectedFileCount: 0 },
              mediaDialogAttempted: false,
              fileSelected: false,
              uploadStarted: false,
              finalButtonClicked: false,
              formSubmitted: false,
            }),
          }),
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('media_upload_target_forbidden_publish_semantics');
      expect(out.execution.fileSelected).toBe(false);
      expect(out.execution.finalButtonClicked).toBe(false);
      expect(out.execution.formSubmitted).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  // Task 0.2 Step3: being "on the upload page" with ZERO selected files and ZERO post-upload
  // media evidence must NOT count as a successful upload.
  it('blocks success when on the upload page but no file or media evidence was confirmed', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-drafts-'));
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialMediaUpload({
        root,
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: {
          spawn: fakeSpawnWithStdout({
            calls: [],
            // Browser claims success purely because the URL reached the upload page, but 0 files.
            stdout: JSON.stringify({
              ok: true,
              app: 'Google Chrome',
              result: {
                ok: true,
                host: 'creator.douyin.com',
                url: 'https://creator.douyin.com/creator-micro/content/upload',
                targetType: 'file_input',
                selector: 'input[type=file]',
                clickedUploadControl: true,
                finalButtonClicked: false,
                formSubmitted: false,
              },
              verification: {
                ok: true,
                fileSelected: true,
                selectedFileCount: 0,
                uploadPageReached: true,
                uploadedMediaDetected: false,
                finalButtonClicked: false,
                formSubmitted: false,
              },
              clipboardOverwritten: true,
              mediaDialogAttempted: true,
              fileSelected: true,
              uploadStarted: true,
              finalButtonClicked: false,
              formSubmitted: false,
            }),
          }),
        },
      });

      expect(out.ok).toBe(false);
      expect(out.externalSideEffectPerformed).toBe(false);
      expect(out.blockers).toContain('media_upload_file_selection_not_confirmed');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('accepts post-upload editor evidence when the site clears input.files after consuming the file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-drafts-'));
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialMediaUpload({
        root,
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        deps: {
          spawn: fakeSpawnWithStdout({
            calls: [],
            stdout: JSON.stringify({
              ok: true,
              app: 'Google Chrome',
              result: {
                ok: true,
                host: 'creator.douyin.com',
                url: 'https://creator.douyin.com/creator-micro/content/upload',
                targetType: 'file_input_proxy',
                selector: '.upload-wrapper',
                clickedUploadControl: true,
                finalButtonClicked: false,
                formSubmitted: false,
              },
              verification: {
                ok: true,
                fileSelected: true,
                selectedFileCount: 0,
                uploadPageReached: true,
                uploadedMediaDetected: true,
                fileNameVisible: true,
                videoCount: 2,
                visibleImageCount: 4,
                publishSurfaceReady: true,
                finalButtonClicked: false,
                formSubmitted: false,
              },
              clipboardOverwritten: true,
              mediaDialogAttempted: true,
              fileSelected: true,
              uploadStarted: true,
              finalButtonClicked: false,
              formSubmitted: false,
            }),
          }),
        },
      });

      expect(out.ok).toBe(true);
      expect(out.blockers).toEqual([]);
      expect(out.execution.fileSelected).toBe(true);
      expect(out.execution.browser.verification).toMatchObject({
        selectedFileCount: 0,
        uploadedMediaDetected: true,
        fileNameVisible: true,
        videoCount: 2,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  // The generated browser verification script must require selected-file count or post-upload media evidence, not URL alone.
  it('generated upload verification requires file count or post-upload media evidence', () => {
    const script = buildNoeSocialMediaUploadExecuteScript({
      browserApp: 'Google Chrome',
      expectedHosts: ['creator.douyin.com'],
      mediaFilePath: '/tmp/demo.mp4',
    });
    // URL alone must not be enough; accepted evidence is selectedFileCount or uploadedMediaDetected.
    expect(script).toContain('selectedFileCount > 0');
    expect(script).toContain('uploadedMediaDetected');
    expect(script).toContain('fileNameVisible');
    expect(script).toContain('targetForbidden');
    expect(script).toContain('forbiddenHits');
    expect(script).toContain('const target = fileInput || labelForFileInput || fileInputProxy || uploadZone');
    expect(script).toContain('rect.width >= 4');
    expect(script).toContain("Number(style.opacity || '1') > 0.01");
    expect(script).toContain('dismissBrowserPermissionPrompt');
    expect(script).toContain('blocked_by_noe_upload_automation');
    expect(script).not.toContain('selectedFileCount > 0 || uploadPageReached');
    expect(script).not.toContain('const target = uploadZone || fileInput');
  });

  it('flags final publish style automation but allows controlled upload clicks', () => {
    const script = buildNoeSocialMediaUploadExecuteScript({
      browserApp: 'Google Chrome',
      expectedHosts: ['creator.douyin.com'],
      mediaFilePath: '/tmp/demo.mp4',
    });

    expect(mediaUploadScriptContainsFinalPublishAction(script)).toBe(false);
    expect(mediaUploadScriptContainsFinalPublishAction('document.querySelector("form").submit()')).toBe(true);
    expect(mediaUploadScriptContainsFinalPublishAction('form.requestSubmit()')).toBe(true);
  });
});
