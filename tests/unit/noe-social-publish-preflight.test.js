import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoeSocialDraft } from '../../src/runtime/NoeSocialPublishQueue.js';
import {
  inspectNoeSocialMediaFiles,
  runNoeSocialPublishPreflight,
} from '../../src/runtime/NoeSocialPublishPreflight.js';

describe('NoeSocialPublishPreflight', () => {
  it('checks draft, media metadata, and browser platform state before form automation', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-preflight-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-preflight-drafts-'));
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      const draft = createNoeSocialDraft({
        dir: draftDir,
        draft: {
          id: 'douyin-ready',
          platform: 'douyin',
          content: 'ready content',
          metadata: { title: 'ready', mediaFiles: ['clips/demo.mp4'] },
        },
      });

      const out = runNoeSocialPublishPreflight({
        root,
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: {
            activeBrowser: { url: 'https://creator.douyin.com/creator-micro/content/upload', title: 'Douyin' },
          },
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-publish-preflight',
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
          contentPresent: true,
          draftReady: true,
          mediaReady: true,
          browserReady: true,
          readyForAutomation: true,
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
      expect(out.nextFreedomActions.map((action) => action.stepId)).toContain('fill_creator_form_after_owner_review');
      expect(JSON.stringify(out)).not.toContain('video-bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks missing drafts and missing media while suggesting preparation actions', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-preflight-root-'));
    try {
      const out = runNoeSocialPublishPreflight({
        root,
        args: {
          draftId: 'missing-draft',
          platform: 'douyin',
          content: 'fallback content',
          mediaFiles: ['missing.mp4'],
          browserState: {},
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toEqual(expect.arrayContaining([
        'social_draft_not_found',
        'media_file_not_found:missing.mp4',
      ]));
      expect(out.warnings).toContain('browser_state_not_provided');
      expect(out.nextFreedomActions.map((action) => action.actionId)).toEqual(expect.arrayContaining([
        'noe.freedom.browser.state_probe',
        'noe.freedom.browser.open',
        'noe.freedom.social.workflow.prepare',
      ]));
      expect(out.nextFreedomActions.map((action) => action.actionId)).not.toContain('noe.freedom.social.publish');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not allow media paths outside the trusted root unless explicitly requested', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-preflight-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'noe-social-preflight-outside-'));
    try {
      const file = join(outside, 'outside.png');
      writeFileSync(file, 'image-bytes', 'utf8');

      const blocked = inspectNoeSocialMediaFiles({ root, mediaFiles: [file] });
      expect(blocked.ok).toBe(false);
      expect(blocked.errors[0]).toContain('media_path_outside_root');
      expect(blocked.files[0]).toMatchObject({ contentRead: false, insideRoot: false });

      const allowed = inspectNoeSocialMediaFiles({ root, mediaFiles: [file], allowOutsideRoot: true });
      expect(allowed.ok).toBe(true);
      expect(allowed.files[0]).toMatchObject({
        exists: true,
        isFile: true,
        kind: 'image',
        contentRead: false,
      });
      expect(JSON.stringify(allowed)).not.toContain('image-bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('warns on browser host mismatch instead of treating it as final publish authorization', () => {
    const out = runNoeSocialPublishPreflight({
      args: {
        platform: 'xiaohongshu',
        requireDraft: false,
        content: 'content only',
        browserState: { activeBrowser: { url: 'https://example.test/dashboard', title: 'Other' } },
      },
    });

    expect(out.ok).toBe(true);
    expect(out.warnings).toContain('browser_host_mismatch');
    expect(out.readiness.browserReady).toBe(false);
    expect(out.readiness.readyForAutomation).toBe(false);
    expect(out.authority).toMatchObject({
      canPublishExternally: false,
      canPressFinalPublish: false,
      bypassesNoeGovernance: false,
    });
  });
});
