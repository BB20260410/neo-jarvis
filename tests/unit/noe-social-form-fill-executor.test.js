import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNoeSocialDraft } from '../../src/runtime/NoeSocialPublishQueue.js';
import {
  executeNoeSocialFormFill,
  scriptContainsFinalPublishAction,
} from '../../src/runtime/NoeSocialFormFillExecutor.js';

function createDraft(dir, overrides = {}) {
  return createNoeSocialDraft({
    dir,
    draft: {
      id: overrides.id || 'draft-1',
      platform: overrides.platform || 'douyin',
      content: Object.prototype.hasOwnProperty.call(overrides, 'content') ? overrides.content : 'visible content',
      metadata: {
        title: overrides.title || 'visible title',
        mediaFiles: overrides.mediaFiles || [],
      },
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

describe('NoeSocialFormFillExecutor', () => {
  it('executes the generated form-fill script through osascript without exposing raw stdout', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-exec-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFormFill({
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
                titleFilled: true,
                contentFilled: true,
                titleEchoMatched: true,
                contentEchoMatched: true,
                sameField: false,
                finalButtonClicked: false,
                formSubmitted: false,
              },
            }),
          }),
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-form-fill-execute',
        plannedOnly: false,
        executionAttempted: true,
        execution: {
          command: 'osascript',
          language: 'JavaScript',
          stdoutReturned: false,
          finalButtonClicked: false,
          formSubmitted: false,
          browser: {
            ok: true,
            app: 'Google Chrome',
            result: {
              host: 'creator.douyin.com',
              titleFilled: true,
              contentFilled: true,
              titleEchoMatched: true,
              contentEchoMatched: true,
              sameField: false,
              finalButtonClicked: false,
              formSubmitted: false,
            },
          },
        },
        publishPerformed: false,
        externalSideEffectPerformed: false,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('osascript');
      expect(calls[0].args[0]).toBe('-l');
      expect(calls[0].args[1]).toBe('JavaScript');
      expect(calls[0].args[2]).toBe('-e');
      expect(calls[0].args[3]).not.toContain('.click(');
      expect(calls[0].args[3]).not.toContain('.submit(');
      expect(JSON.stringify(out)).not.toContain('"stdout":');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('dry-runs the execution action without spawning osascript', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-exec-'));
    const calls = [];
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFormFill({
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
        adapter: 'social-form-fill-execute',
        plannedOnly: true,
        executionAttempted: false,
      });
      expect(out.nextFreedomActions[0]).toMatchObject({
        actionId: 'noe.freedom.social.form_fill.execute',
      });
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('rejects scripts containing final publish style actions', () => {
    expect(scriptContainsFinalPublishAction('document.querySelector("button").click()')).toBe(true);
    expect(scriptContainsFinalPublishAction('form.requestSubmit()')).toBe(true);
    expect(scriptContainsFinalPublishAction('el.dispatchEvent(new Event("input"))')).toBe(false);
  });

  it('blocks execution when browser output reports host mismatch', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-exec-'));
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFormFill({
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
              result: { ok: false, error: 'form_fill_host_mismatch', host: 'example.test', finalButtonClicked: false, formSubmitted: false },
            }),
          }),
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('form_fill_host_mismatch');
      expect(out.execution.browser.result).toMatchObject({
        ok: false,
        error: 'form_fill_host_mismatch',
        finalButtonClicked: false,
        formSubmitted: false,
      });
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('blocks execution when required fields were not filled', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-exec-'));
    try {
      const draft = createDraft(draftDir);
      const out = await executeNoeSocialFormFill({
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
                titleFilled: true,
                contentFilled: false,
                titleEchoMatched: true,
                contentEchoMatched: false,
                sameField: false,
                finalButtonClicked: false,
                formSubmitted: false,
              },
            }),
          }),
        },
      });

      expect(out.ok).toBe(false);
      expect(out.blockers).toContain('form_fill_content_field_not_filled');
      expect(out.blockers).toContain('form_fill_content_echo_mismatch');
      expect(out.execution.browser.result).toMatchObject({
        titleFilled: true,
        contentFilled: false,
        titleEchoMatched: true,
        contentEchoMatched: false,
        finalButtonClicked: false,
        formSubmitted: false,
      });
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });
});
