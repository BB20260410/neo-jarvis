import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { orchestrateNoeSocialPublish } from '../../src/runtime/NoeSocialPublishOrchestrator.js';

describe('NoeSocialPublishOrchestrator', () => {
  it('dry-runs a complete social publish action chain without writing a draft or publishing', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-orchestrator-'));
    try {
      const out = orchestrateNoeSocialPublish({
        draftDir,
        args: {
          id: 'dry-orchestrated',
          platform: 'douyin',
          title: 'demo',
          content: 'hello',
          mediaFiles: ['clips/demo.mp4'],
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/?token=secret-value', title: 'Douyin' } },
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-publish-orchestrator',
        plannedOnly: true,
        platform: 'douyin',
        externalSideEffectPerformed: false,
        publishPerformed: false,
        secretValuesReturned: false,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
        authority: {
          canUseLoggedInAccounts: true,
          canFillForms: false,
          canUploadFiles: false,
          canPublishExternally: false,
          requiresSeparateFinalPublishAction: true,
          bypassesNoeGovernance: false,
        },
      });
      expect(out.actionChain.map((item) => item.actionId)).toEqual([
        'noe.freedom.account.connection_inventory',
        'noe.freedom.browser.open',
        'noe.freedom.social.workflow.prepare',
        'noe.freedom.social.preflight.run',
        'noe.freedom.browser.dom.execute',
        'noe.freedom.browser.dom.execute',
        'noe.freedom.social.form_fill.plan',
        'noe.freedom.social.form_fill.execute',
        'noe.freedom.social.media_upload.prepare',
        'noe.freedom.social.media_upload.execute',
        'noe.freedom.social.final_publish.execute',
        'noe.freedom.browser.state_probe',
      ]);
      expect(out.actionChain.find((item) => item.stepId === 'execute_final_publish')).toMatchObject({
        externalSideEffectPerformed: true,
        publishPerformed: true,
        args: {
          requirePriorStageEvidence: true,
        },
      });
      expect(out.checks.domRecipe).toMatchObject({
        ok: true,
        platform: 'douyin',
        probeActionCount: 3,
        actionCount: 3,
        expectedHost: 'creator.douyin.com',
        includeMediaPickerAction: false,
        includeFinalPublishAction: false,
        externalSideEffectPerformed: false,
        publishPerformed: false,
        generated: true,
      });
      expect(out.actionChain.find((item) => item.stepId === 'execute_dom_recipe_fields')).toMatchObject({
        actionId: 'noe.freedom.browser.dom.execute',
        externalSideEffectPerformed: false,
        publishPerformed: false,
      });
      expect(out.actionChain.find((item) => item.stepId === 'probe_dom_recipe_targets')).toMatchObject({
        actionId: 'noe.freedom.browser.dom.execute',
        externalSideEffectPerformed: false,
        publishPerformed: false,
      });
      expect(existsSync(join(draftDir, 'dry-orchestrated.json'))).toBe(false);
      expect(JSON.stringify(out)).not.toContain('secret-value');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('creates a local draft during real execution but does not upload or press final publish', () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-orchestrator-'));
    try {
      const out = orchestrateNoeSocialPublish({
        draftDir,
        realExecute: true,
        args: {
          id: 'real-orchestrated',
          platform: 'douyin',
          title: 'demo',
          content: 'hello',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
      });

      expect(out).toMatchObject({
        ok: true,
        plannedOnly: false,
        workflow: {
          draftWritten: true,
          publishPerformed: false,
        },
        checks: {
          accountInventory: { matchedPlatforms: ['douyin'] },
          preflight: { ok: true },
          formFillPlan: { ok: true, scriptGenerated: true },
          mediaUploadPlan: null,
        },
        externalSideEffectPerformed: true,
        publishPerformed: false,
      });
      expect(out.nextFreedomActions.map((item) => item.actionId)).toContain('noe.freedom.social.final_publish.execute');
      expect(out.nextFreedomActions.map((item) => item.actionId)).toContain('noe.freedom.browser.dom.execute');
      const domProbe = out.nextFreedomActions.find((item) => item.stepId === 'probe_dom_recipe_targets');
      expect(domProbe.args.actions).toEqual([
        { type: 'read_title' },
        { type: 'probe_by_hints', role: 'title', probeTarget: 'field', hints: ['title', '标题', '作品标题'] },
        { type: 'probe_by_hints', role: 'content', probeTarget: 'field', hints: ['description', 'desc', '描述', '简介', '作品描述', '文案'] },
      ]);
      const domRecipe = out.nextFreedomActions.find((item) => item.stepId === 'execute_dom_recipe_fields');
      expect(domRecipe.args).toMatchObject({
        browserApp: 'Google Chrome',
        expectedHost: 'creator.douyin.com',
        actions: [
          { type: 'read_title' },
          { type: 'set_by_hints', role: 'title', value: 'demo' },
          { type: 'set_by_hints', role: 'content', value: 'hello' },
        ],
      });
      const draft = readFileSync(join(draftDir, 'real-orchestrated.json'), 'utf8');
      expect(draft).toContain('"externalSideEffectPerformed": false');
      expect(JSON.stringify(out)).not.toMatch(/password.*plain|secret-value/i);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('can exclude final publish action while keeping post-state probe', () => {
    const out = orchestrateNoeSocialPublish({
      args: {
        id: 'no-final',
        platform: 'douyin',
        title: 'demo',
        content: 'hello',
        includeFinalPublish: false,
      },
    });

    expect(out.actionChain.map((item) => item.actionId)).not.toContain('noe.freedom.social.final_publish.execute');
    expect(out.actionChain.at(-1)).toMatchObject({
      actionId: 'noe.freedom.browser.state_probe',
    });
  });

  it('builds DOM probe and fill actions for tags-only social drafts', () => {
    const out = orchestrateNoeSocialPublish({
      args: {
        id: 'tags-only',
        platform: 'xiaohongshu',
        content: 'hello',
        tags: ['旅行', 'AI'],
        includeFinalPublish: false,
      },
    });

    expect(out.checks.domRecipe).toMatchObject({
      platform: 'xiaohongshu',
      probeActionCount: 3,
      actionCount: 3,
      actionRoles: ['read_title', 'content', 'tags'],
      requiredProbeRoles: ['read_title', 'content', 'tags'],
      pageProbe: {
        expectedHost: 'creator.xiaohongshu.com',
        requiresLoginSession: true,
        targetSurface: 'creator_publish_editor',
        fieldRoles: ['content', 'tags'],
      },
    });
    const domProbe = out.nextFreedomActions.find((item) => item.stepId === 'probe_dom_recipe_targets');
    expect(domProbe.args.actions.find((item) => item.role === 'tags')).toMatchObject({
      type: 'probe_by_hints',
      probeTarget: 'field',
    });
    const domFill = out.nextFreedomActions.find((item) => item.stepId === 'execute_dom_recipe_fields');
    expect(domFill.args.actions.find((item) => item.role === 'tags')).toMatchObject({
      type: 'set_by_hints',
      value: '旅行 AI',
    });
    expect(out.actionChain.find((item) => item.stepId === 'create_or_refresh_local_draft').args.tags).toEqual(['旅行', 'AI']);
    expect(JSON.stringify(domProbe)).not.toContain('旅行');
  });

  it('adds media picker and final publish DOM actions only when explicitly requested', () => {
    const out = orchestrateNoeSocialPublish({
      args: {
        id: 'dom-publish',
        platform: 'douyin',
        title: 'demo',
        content: 'hello',
        mediaFiles: ['clips/demo.mp4'],
        includeDomMediaPickerAction: true,
        includeDomFinalPublishAction: true,
      },
    });

    const domStep = out.actionChain.find((item) => item.stepId === 'execute_dom_recipe_fields');
    expect(domStep).toMatchObject({
      actionId: 'noe.freedom.browser.dom.execute',
      externalSideEffectPerformed: true,
      publishPerformed: true,
    });
    expect(domStep.purpose).toContain('final publish click');
    expect(domStep.args.actions.map((item) => item.role)).toEqual([
      undefined,
      'title',
      'content',
      'media_upload',
      'final_publish',
    ]);
    expect(out.checks.domRecipe).toMatchObject({
      actionCount: 5,
      actionRoles: ['read_title', 'title', 'content', 'media_upload', 'final_publish'],
      probeActionCount: 5,
      includeMediaPickerAction: true,
      includeFinalPublishAction: true,
      externalSideEffectPerformed: true,
      publishPerformed: true,
    });
    expect(out.nextFreedomActions.find((item) => item.stepId === 'execute_dom_recipe_fields').args.actions.at(-1)).toMatchObject({
      type: 'click_by_hints',
      role: 'final_publish',
    });
    expect(out.actionChain.map((item) => item.stepId).filter((item) => item === 'execute_final_publish')).toEqual([]);
  });
});
