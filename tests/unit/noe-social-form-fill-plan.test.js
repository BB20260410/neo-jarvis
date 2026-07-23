import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoeSocialDraft } from '../../src/runtime/NoeSocialPublishQueue.js';
import { buildNoeSocialFormFillPlan } from '../../src/runtime/NoeSocialFormFillPlan.js';

function createDraft(dir, overrides = {}) {
  return createNoeSocialDraft({
    dir,
    draft: {
      id: overrides.id || 'draft-1',
      platform: overrides.platform || 'douyin',
      content: Object.prototype.hasOwnProperty.call(overrides, 'content') ? overrides.content : 'visible content',
      metadata: {
        title: overrides.title || 'visible title',
        mediaFiles: overrides.mediaFiles || ['clips/demo.mp4'],
      },
    },
  });
}

describe('NoeSocialFormFillPlan', () => {
  it('generates a browser form-fill script without clicking final publish controls', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-'));
    try {
      const draft = createDraft(draftDir);
      const out = buildNoeSocialFormFillPlan({
        draftDir,
        realExecute: true,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserApp: 'Google Chrome',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/creator-micro/content/upload', title: 'Douyin' } },
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-form-fill-plan',
        plannedOnly: false,
        platform: 'douyin',
        browser: {
          app: 'Google Chrome',
          activeHost: 'creator.douyin.com',
          matchesPlatform: true,
          cookiesReadByNoe: false,
          passwordReadByNoe: false,
          pageContentReadByNoe: false,
        },
        automation: {
          language: 'jxa',
          scriptGenerated: true,
          mediaHandledByScript: false,
          finalButtonClicked: false,
          formSubmitted: false,
        },
        publishPerformed: false,
        externalSideEffectPerformed: false,
      });
      expect(out.automation.script).toContain('Application(appName)');
      expect(out.automation.script).toContain('tab.execute');
      expect(out.automation.script).toContain('frontChromeLikeWindow(windows)');
      expect(out.automation.browserJavascript).toContain('!excluded.includes(el)');
      expect(out.automation.browserJavascript).toContain('el !== titleField');
      expect(out.automation.browserJavascript).toContain('titleEchoMatched');
      expect(out.automation.browserJavascript).toContain('contentEchoMatched');
      expect(out.automation.browserJavascript).toContain('sameField');
      expect(out.automation.script).not.toContain('.click(');
      expect(out.automation.script).not.toContain('.submit(');
      expect(out.nextFreedomActions).toEqual([
        expect.objectContaining({
          stepId: 'run_form_fill_script',
          actionId: 'noe.freedom.macos.applescript.run',
        }),
      ]);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks form-fill action generation when the browser host does not match the platform', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-'));
    try {
      const draft = createDraft(draftDir);
      const out = buildNoeSocialFormFillPlan({
        draftDir,
        args: {
          draftId: draft.id,
          platform: 'xiaohongshu',
          browserState: { activeBrowser: { url: 'https://example.test/creator', title: 'Other' } },
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('form_fill_browser_host_mismatch');
      expect(out.nextFreedomActions.map((action) => action.actionId)).toContain('noe.freedom.browser.open');
      expect(out.nextFreedomActions.map((action) => action.actionId)).not.toContain('noe.freedom.macos.applescript.run');
      expect(out.authority).toMatchObject({
        canPublishExternally: false,
        canPressFinalPublish: false,
        bypassesNoeGovernance: false,
      });
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('redacts secret-like values before embedding draft content in generated scripts', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-'));
    try {
      const draft = createDraft(draftDir, {
        content: 'content with tp-unitsecret000000000000000000000000000000',
        title: 'title with sk-unitsecret000000000000000000000000000000',
      });
      const out = buildNoeSocialFormFillPlan({
        draftDir,
        args: {
          draftId: draft.id,
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
      });

      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain('tp-unitsecret');
      expect(serialized).not.toContain('sk-unitsecret');
      expect(serialized).toContain('[redacted-api-key]');
      expect(serialized).toContain('[redacted-openai-key]');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks missing draft or content before offering a script run action', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-'));
    try {
      const missingDraft = buildNoeSocialFormFillPlan({
        draftDir,
        args: {
          draftId: 'missing',
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
      });
      expect(missingDraft.ok).toBe(false);
      expect(missingDraft.blockers).toEqual(expect.arrayContaining([
        'social_draft_not_found',
        'form_fill_content_required',
      ]));
      expect(missingDraft.nextFreedomActions.map((action) => action.actionId)).not.toContain('noe.freedom.macos.applescript.run');

      const empty = createDraft(draftDir, { id: 'empty', content: '' });
      expect(empty.ok).toBe(false);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('accepts a host-only browser state for live form-fill evidence', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-'));
    try {
      const draft = createDraft(draftDir, { platform: 'xiaohongshu' });
      const out = buildNoeSocialFormFillPlan({
        draftDir,
        args: {
          draftId: draft.id,
          platform: 'xiaohongshu',
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
      rmSync(draftDir, { recursive: true, force: true });
    }
  });
});
