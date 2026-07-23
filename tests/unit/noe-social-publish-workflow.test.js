import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNoeSocialPublishWorkflow } from '../../src/runtime/NoeSocialPublishWorkflow.js';
import { markNoeSocialDraftExternalSideEffect, readNoeSocialDraft } from '../../src/runtime/NoeSocialPublishQueue.js';

describe('NoeSocialPublishWorkflow', () => {
  it('dry-runs a social publishing workflow without writing a draft or publishing', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-workflow-'));
    try {
      const out = prepareNoeSocialPublishWorkflow({
        args: {
          id: 'dry-douyin',
          platform: 'douyin',
          title: 'demo',
          content: 'hello',
          mediaFiles: ['clips/demo.mp4'],
        },
        draftDir,
      });

      expect(out).toMatchObject({
        ok: true,
        plannedOnly: true,
        platform: 'douyin',
        creatorHost: 'creator.douyin.com',
        externalSideEffectPerformed: false,
        publishPerformed: false,
        secretValuesReturned: false,
        valid: true,
        wouldWriteDraft: true,
      });
      expect(out.steps.map((step) => step.id)).toEqual([
        'browser_state_probe',
        'open_creator_console',
        'create_local_publish_draft',
        'upload_media_or_fill_form',
        'pre_publish_check',
        'rollback_plan',
      ]);
      expect(out.nextFreedomActions.map((action) => action.actionId)).toEqual([
        'noe.freedom.browser.state_probe',
        'noe.freedom.browser.open',
        'noe.freedom.social.draft.create',
        'noe.freedom.macos.applescript.run',
      ]);
      expect(existsSync(join(draftDir, 'dry-douyin.json'))).toBe(false);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('creates a local draft on real execution while avoiding external platform side effects', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-workflow-'));
    try {
      const out = prepareNoeSocialPublishWorkflow({
        args: {
          id: 'real-xhs',
          platform: 'xiaohongshu',
          title: 'note',
          content: 'publish draft with tp-unitsecret000000000000000000000000000000',
          tags: ['旅行', 'AI'],
          mediaFiles: ['images/a.png'],
        },
        realExecute: true,
        draftDir,
      });

      expect(out).toMatchObject({
        ok: true,
        plannedOnly: false,
        platform: 'xiaohongshu',
        draftWritten: true,
        externalSideEffectPerformed: false,
        publishPerformed: false,
        secretValuesReturned: false,
        authority: { canPublishExternally: false, bypassesNoeGovernance: false },
      });
      expect(out.draft).toMatchObject({ id: 'real-xhs', ref: 'real-xhs.json', state: 'draft' });
      const draft = readFileSync(join(draftDir, out.draft.ref), 'utf8');
      expect(draft).toContain('"externalSideEffectPerformed": false');
      expect(draft).toContain('"tags"');
      expect(draft).toContain('"旅行"');
      expect(draft).not.toContain('tp-unitsecret');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  // Task 0.2 Step2: workflow.prepare must NOT overwrite an already-published draft of the same id.
  it('refuses to overwrite a previously published draft on re-prepare (anti double-publish)', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-workflow-'));
    try {
      const first = prepareNoeSocialPublishWorkflow({
        args: { id: 'reuse-id', platform: 'douyin', title: 'first', content: 'first content' },
        realExecute: true,
        draftDir,
      });
      expect(first.draftWritten).toBe(true);

      // Simulate the draft having actually been published externally.
      markNoeSocialDraftExternalSideEffect({ dir: draftDir, id: 'reuse-id', publishRef: 'https://creator.douyin.com/published/1' });

      const second = prepareNoeSocialPublishWorkflow({
        args: { id: 'reuse-id', platform: 'douyin', title: 'second', content: 'second content' },
        realExecute: true,
        draftDir,
      });
      expect(second.ok).toBe(false);
      expect(second.draftWritten).toBe(false);
      expect(second.blockers).toContain('social_draft_already_published');

      // On-disk record stays the published one, not clobbered back to a fresh draft.
      const after = readNoeSocialDraft({ dir: draftDir, id: 'reuse-id' });
      expect(after.record.state).toBe('published');
      expect(after.record.publish.externalSideEffectPerformed).toBe(true);
      expect(after.record.content).toBe('first content');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks real execution without content before writing a draft', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-workflow-'));
    try {
      const out = prepareNoeSocialPublishWorkflow({
        args: { id: 'missing-content', platform: 'douyin', content: '' },
        realExecute: true,
        draftDir,
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('social_workflow_content_required');
      expect(out.draftWritten).toBeUndefined();
      expect(existsSync(join(draftDir, 'missing-content.json'))).toBe(false);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('falls back to a generic platform and warns on mismatched browser state', () => {
    const out = prepareNoeSocialPublishWorkflow({
      args: {
        platform: 'custom-platform',
        creatorUrl: 'https://example.test/creator',
        content: 'hello',
        browserState: {
          activeBrowser: {
            url: 'https://not-douyin.test/dashboard?token=hidden',
            title: 'Other',
          },
        },
      },
    });

    expect(out).toMatchObject({
      ok: true,
      platform: 'custom-platform',
      platformLabel: 'Generic Social Platform',
      creatorHost: 'example.test',
    });
    expect(out.warnings).not.toContain('social_workflow_browser_host_mismatch');
    expect(JSON.stringify(out)).not.toContain('hidden');

    const douyin = prepareNoeSocialPublishWorkflow({
      args: {
        platform: 'douyin',
        content: 'hello',
        browserState: { activeBrowser: { url: 'https://example.test/dashboard', title: 'Other' } },
      },
    });
    expect(douyin.warnings).toContain('social_workflow_browser_host_mismatch');
  });
});
