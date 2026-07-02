import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoeSocialDraft } from '../../src/runtime/NoeSocialPublishQueue.js';
import { buildNoeSocialMediaUploadPlan } from '../../src/runtime/NoeSocialMediaUploadPlan.js';

function createDraft(dir, mediaFiles = []) {
  return createNoeSocialDraft({
    dir,
    draft: {
      id: 'media-draft',
      platform: 'douyin',
      content: 'ready content',
      metadata: { title: 'ready', mediaFiles },
    },
  });
}

describe('NoeSocialMediaUploadPlan', () => {
  it('checks media metadata and generates a read-only selector probe script', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-media-upload-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-media-upload-drafts-'));
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      const draft = createDraft(draftDir, ['clips/demo.mp4']);

      const out = buildNoeSocialMediaUploadPlan({
        root,
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/creator-micro/content/upload', title: 'Douyin' } },
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-media-upload-plan',
        plannedOnly: false,
        platform: 'douyin',
        browser: {
          activeHost: 'creator.douyin.com',
          matchesPlatform: true,
          cookiesReadByNoe: false,
          passwordReadByNoe: false,
          pageContentReadByNoe: false,
        },
        readiness: {
          mediaReady: true,
          browserReady: true,
          readyForSelectorProbe: true,
          finalPublishAllowedByThisTool: false,
        },
        externalSideEffectPerformed: false,
        publishPerformed: false,
        fileContentRead: false,
      });
      expect(out.media.files[0]).toMatchObject({
        ref: 'clips/demo.mp4',
        kind: 'video',
        exists: true,
        isFile: true,
        contentRead: false,
      });
      expect(out.selectorProbe.script).toContain('querySelectorAll');
      expect(out.selectorProbe.script).toContain('input[type=\\\"file\\\"]');
      expect(out.selectorProbe.script).not.toContain('.click(');
      expect(out.selectorProbe.script).not.toContain('.submit(');
      expect(out.selectorProbe.script).not.toContain('files =');
      expect(out.selectorProbe).toMatchObject({
        fileSelected: false,
        uploadStarted: false,
        finalButtonClicked: false,
        formSubmitted: false,
      });
      expect(out.nextFreedomActions).toEqual([
        expect.objectContaining({
          stepId: 'probe_upload_selectors',
          actionId: 'noe.freedom.macos.applescript.run',
        }),
      ]);
      expect(JSON.stringify(out)).not.toContain('video-bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks missing media before offering selector probe execution', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-media-upload-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-media-upload-drafts-'));
    try {
      const draft = createDraft(draftDir, ['missing.mp4']);
      const out = buildNoeSocialMediaUploadPlan({
        root,
        draftDir,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('media_file_not_found:missing.mp4');
      expect(out.nextFreedomActions.map((action) => action.actionId)).not.toContain('noe.freedom.macos.applescript.run');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks outside-root media paths and browser host mismatch by default', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-media-upload-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'noe-media-upload-outside-'));
    try {
      const mediaPath = join(outside, 'outside.png');
      writeFileSync(mediaPath, 'image-bytes', 'utf8');
      const out = buildNoeSocialMediaUploadPlan({
        root,
        args: {
          requireDraft: false,
          platform: 'xiaohongshu',
          mediaFiles: [mediaPath],
          browserState: { activeBrowser: { url: 'https://example.test/dashboard', title: 'Other' } },
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toEqual(expect.arrayContaining([
        `media_path_outside_root:${mediaPath}`,
        'media_upload_browser_host_mismatch',
      ]));
      expect(out.nextFreedomActions.map((action) => action.actionId)).toContain('noe.freedom.browser.open');
      expect(out.nextFreedomActions.map((action) => action.actionId)).not.toContain('noe.freedom.macos.applescript.run');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('can build a selector probe from explicit media without requiring a draft', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-media-upload-root-'));
    try {
      mkdirSync(join(root, 'images'));
      writeFileSync(join(root, 'images', 'demo.png'), 'image-bytes', 'utf8');
      const out = buildNoeSocialMediaUploadPlan({
        root,
        args: {
          requireDraft: false,
          platform: 'xiaohongshu',
          mediaFiles: ['images/demo.png'],
          browserState: { activeBrowser: { url: 'https://creator.xiaohongshu.com/publish', title: 'XHS' } },
        },
      });

      expect(out.ok).toBe(true);
      expect(out.draft).toMatchObject({ ok: false, error: 'draft_id_missing' });
      expect(out.media.files[0]).toMatchObject({ kind: 'image', contentRead: false });
      expect(out.authority).toMatchObject({
        canSelectFiles: false,
        canStartUpload: false,
        canPublishExternally: false,
        canPressFinalPublish: false,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('accepts a host-only browser state so live ledgers do not need raw browser URLs', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-media-upload-root-'));
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      const out = buildNoeSocialMediaUploadPlan({
        root,
        args: {
          requireDraft: false,
          platform: 'xiaohongshu',
          mediaFiles: ['clips/demo.mp4'],
          browserState: { activeBrowser: { host: 'creator.xiaohongshu.com', urlPresent: true, urlSha256: 'sha' } },
        },
      });

      expect(out.ok).toBe(true);
      expect(out.browser).toMatchObject({
        activeHost: 'creator.xiaohongshu.com',
        matchesPlatform: true,
      });
      expect(JSON.stringify(out)).not.toContain('https://creator.xiaohongshu.com');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
