import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cancelNoeSocialDraft,
  createNoeSocialDraft,
  listNoeSocialDrafts,
  markNoeSocialDraftExternalSideEffect,
  readNoeSocialDraft,
} from '../../src/runtime/NoeSocialPublishQueue.js';

describe('NoeSocialPublishQueue', () => {
  it('creates redacted local drafts without external side effects', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-social-drafts-'));
    try {
      const created = createNoeSocialDraft({
        dir,
        draft: {
          id: 'draft-1',
          platform: 'x',
          content: 'hello tp-unitsecret000000000000000000000000000000',
          rollbackPlan: 'delete or correct post',
        },
      });

      expect(created).toMatchObject({
        ok: true,
        id: 'draft-1',
        state: 'draft',
        externalSideEffectPerformed: false,
      });
      const text = readFileSync(created.path, 'utf8');
      expect(text).toContain('"externalSideEffectPerformed": false');
      expect(text).not.toContain('tp-unitsecret');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists and cancels drafts without publishing anything', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-social-drafts-'));
    try {
      createNoeSocialDraft({ dir, draft: { id: 'draft-1', platform: 'x', content: 'hello' } });
      const listed = listNoeSocialDrafts({ dir });
      expect(listed.drafts).toEqual([
        expect.objectContaining({ id: 'draft-1', state: 'draft', externalSideEffectPerformed: false }),
      ]);

      const cancelled = cancelNoeSocialDraft({ dir, id: 'draft-1', reason: 'test-cancel' });
      expect(cancelled).toMatchObject({ ok: true, id: 'draft-1', state: 'cancelled' });
      const read = readNoeSocialDraft({ dir, id: 'draft-1' });
      expect(read.record).toMatchObject({
        state: 'cancelled',
        reason: 'test-cancel',
        publish: expect.objectContaining({ externalSideEffectPerformed: false }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects missing content and symlinked queue directories', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-drafts-'));
    const outside = mkdtempSync(join(tmpdir(), 'noe-social-drafts-outside-'));
    try {
      expect(createNoeSocialDraft({ dir: root, draft: { id: 'empty' } })).toMatchObject({
        ok: false,
        error: 'social_draft_content_required',
      });

      mkdirSync(join(root, 'drafts'), { recursive: true });
      symlinkSync(outside, join(root, 'drafts/link'));
      expect(() => createNoeSocialDraft({
        dir: join(root, 'drafts/link'),
        draft: { id: 'draft-1', content: 'hello' },
      })).toThrow('social_draft_symlink_path_denied');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // Task 0.2 Step1: externalSideEffectPerformed must persist to disk so a re-run can detect
  // a prior external publish and refuse to publish the same draft twice.
  it('persists externalSideEffectPerformed=true back to disk (anti double-publish)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-social-drafts-'));
    try {
      createNoeSocialDraft({ dir, draft: { id: 'pub-1', platform: 'douyin', content: 'hello' } });
      const before = readNoeSocialDraft({ dir, id: 'pub-1' });
      expect(before.record.publish.externalSideEffectPerformed).toBe(false);
      expect(before.record.state).toBe('draft');

      const marked = markNoeSocialDraftExternalSideEffect({
        dir,
        id: 'pub-1',
        publishRef: 'https://creator.douyin.com/published/abc',
        reason: 'final_publish_confirmed',
      });
      expect(marked).toMatchObject({ ok: true, id: 'pub-1', state: 'published', externalSideEffectPerformed: true });

      // Re-read from disk: the flag and state must survive process restart.
      const after = readNoeSocialDraft({ dir, id: 'pub-1' });
      expect(after.record.publish.externalSideEffectPerformed).toBe(true);
      expect(after.record.state).toBe('published');
      expect(after.record.publish.publishedAt).not.toBe('');
      // sha256 must stay consistent with the rewritten record.
      expect(after.record.sha256).toBe(marked.sha256);
      // Listing reflects the persisted flag too.
      const listed = listNoeSocialDrafts({ dir });
      expect(listed.drafts).toEqual([
        expect.objectContaining({ id: 'pub-1', state: 'published', externalSideEffectPerformed: true }),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marking is idempotent and never reverts a published draft to false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-social-drafts-'));
    try {
      createNoeSocialDraft({ dir, draft: { id: 'pub-2', platform: 'douyin', content: 'hello' } });
      markNoeSocialDraftExternalSideEffect({ dir, id: 'pub-2', publishRef: 'ref-1' });
      const second = markNoeSocialDraftExternalSideEffect({ dir, id: 'pub-2', publishRef: 'ref-2' });
      expect(second.ok).toBe(true);
      const after = readNoeSocialDraft({ dir, id: 'pub-2' });
      expect(after.record.publish.externalSideEffectPerformed).toBe(true);
      expect(after.record.state).toBe('published');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Task 0.2 Step2: createNoeSocialDraft must refuse to clobber an already-published draft.
  it('refuses to overwrite a draft whose state is no longer draft (anti-clobber)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-social-drafts-'));
    try {
      createNoeSocialDraft({ dir, draft: { id: 'pub-3', platform: 'douyin', content: 'first' } });
      markNoeSocialDraftExternalSideEffect({ dir, id: 'pub-3', publishRef: 'ref-1' });

      const clobber = createNoeSocialDraft({ dir, draft: { id: 'pub-3', platform: 'douyin', content: 'second' } });
      expect(clobber).toMatchObject({ ok: false, error: 'social_draft_already_published' });

      // Original published record is intact, NOT reset to a fresh draft.
      const after = readNoeSocialDraft({ dir, id: 'pub-3' });
      expect(after.record.state).toBe('published');
      expect(after.record.publish.externalSideEffectPerformed).toBe(true);
      expect(after.record.content).toBe('first');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
