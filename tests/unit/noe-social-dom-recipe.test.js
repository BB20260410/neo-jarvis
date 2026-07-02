import { describe, expect, it } from 'vitest';
import {
  buildNoeSocialDomRecipeAction,
  buildNoeSocialDomRecipePack,
  buildNoeSocialDomRecipeProbeAction,
  socialDomRecipeForPlatform,
} from '../../src/runtime/NoeSocialDomRecipe.js';

describe('NoeSocialDomRecipe', () => {
  it('builds platform field recipes as browser DOM actions without publish by default', () => {
    const action = buildNoeSocialDomRecipeAction({
      platform: 'douyin',
      browserApp: 'Google Chrome',
      expectedHost: 'creator.douyin.com',
      title: '标题',
      content: '正文',
    });

    expect(action).toMatchObject({
      stepId: 'dom_recipe_douyin_active_page',
      actionId: 'noe.freedom.browser.dom.execute',
      mode: 'developer_unrestricted',
      args: {
        browserApp: 'Google Chrome',
        expectedHost: 'creator.douyin.com',
        actions: [
          { type: 'read_title' },
          { type: 'set_by_hints', role: 'title', hints: ['title', '标题', '作品标题'], value: '标题' },
          { type: 'set_by_hints', role: 'content', value: '正文' },
        ],
      },
      recipe: {
        platform: 'douyin',
        includeMediaPicker: false,
        includeFinalPublishAction: false,
      },
    });
    expect(action.args.actions.map((item) => item.role)).not.toContain('final_publish');
  });

  it('only adds media picker and final publish clicks when explicitly requested', () => {
    const action = buildNoeSocialDomRecipeAction({
      platform: 'bilibili',
      expectedHost: 'member.bilibili.com',
      title: '标题',
      mediaFiles: ['/tmp/demo.mp4'],
      includeMediaPicker: true,
      includeFinalPublishAction: true,
    });

    expect(action.args.actions.map((item) => item.role)).toEqual([
      undefined,
      'title',
      'media_upload',
      'final_publish',
    ]);
    expect(action.args.actions.find((item) => item.role === 'media_upload')).toMatchObject({
      type: 'click_by_hints',
      hints: ['上传', '选择文件', '视频', 'upload'],
    });
    expect(action.recipe).toMatchObject({
      includeMediaPicker: true,
      includeFinalPublishAction: true,
      mediaCount: 1,
    });
  });

  it('builds tag field probes and fill actions for creator pages', () => {
    const pack = buildNoeSocialDomRecipePack({
      platform: 'xiaohongshu',
      title: 'note',
      content: 'body',
      tags: ['旅行', 'AI'],
      mediaFiles: ['/tmp/demo.png'],
      includeMediaPicker: true,
    });

    expect(pack.requiredProbeRoles).toEqual([
      'read_title',
      'title',
      'content',
      'tags',
      'media_upload',
    ]);
    expect(pack.pageProbe).toMatchObject({
      expectedHost: 'creator.xiaohongshu.com',
      requiresLoginSession: true,
      targetSurface: 'creator_publish_editor',
      titleRead: true,
      requiredProbeRoles: ['read_title', 'title', 'content', 'tags', 'media_upload'],
      fieldRoles: ['title', 'content', 'tags'],
      clickableRoles: ['media_upload'],
    });
    expect(pack.actions[0].args).toMatchObject({
      expectedHosts: ['creator.xiaohongshu.com'],
      pageProbe: {
        targetSurface: 'creator_publish_editor',
        requiredProbeRoles: ['read_title', 'title', 'content', 'tags', 'media_upload'],
      },
    });
    expect(pack.actions[0].args.actions.find((item) => item.role === 'tags')).toMatchObject({
      type: 'probe_by_hints',
      probeTarget: 'field',
      hints: ['tag', 'tags', '话题', '标签', '添加话题', '添加标签'],
    });
    expect(pack.actions[1].args.actions.find((item) => item.role === 'tags')).toMatchObject({
      type: 'set_by_hints',
      value: '旅行 AI',
    });
    expect(JSON.stringify(pack.actions[0])).not.toContain('旅行');
    expect(JSON.stringify(pack.actions[0])).not.toContain('body');
  });

  it('builds recipe packs from platform presets', () => {
    const pack = buildNoeSocialDomRecipePack({
      platform: 'youtube',
      title: 'Demo',
      content: 'Description',
    });

    expect(pack).toMatchObject({
      platform: 'youtube',
      platformLabel: 'YouTube Studio',
      expectedHosts: ['studio.youtube.com'],
      secretValuesReturned: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      publishPerformed: false,
    });
    expect(pack.actions).toHaveLength(2);
    expect(pack.actions[0].recipe.probeOnly).toBe(true);
    expect(pack.actions[0].args.expectedHost).toBe('studio.youtube.com');
    expect(pack.actions[0].args.actions.map((item) => item.type)).toEqual([
      'read_title',
      'probe_by_hints',
      'probe_by_hints',
    ]);
    expect(pack.actions[1].args.expectedHost).toBe('studio.youtube.com');
    expect(pack.actions[1].args.actions.map((item) => item.type)).toEqual([
      'read_title',
      'set_by_hints',
      'set_by_hints',
    ]);
  });

  it('builds probe-only actions that never carry field values', () => {
    const action = buildNoeSocialDomRecipeProbeAction({
      platform: 'douyin',
      expectedHost: 'creator.douyin.com',
      title: '标题',
      content: '秘密正文内容',
      mediaFiles: ['/tmp/demo.mp4'],
      includeMediaPicker: true,
      includeFinalPublishAction: true,
    });

    expect(action.recipe).toMatchObject({
      probeOnly: true,
      includeMediaPicker: true,
      includeFinalPublishAction: true,
    });
    expect(action.args.actions).toEqual([
      { type: 'read_title' },
      { type: 'probe_by_hints', role: 'title', probeTarget: 'field', hints: ['title', '标题', '作品标题'] },
      { type: 'probe_by_hints', role: 'content', probeTarget: 'field', hints: ['description', 'desc', '描述', '简介', '作品描述', '文案'] },
      { type: 'probe_by_hints', role: 'media_upload', probeTarget: 'clickable', hints: ['上传', '选择文件', '视频', '添加视频', 'upload'] },
      { type: 'probe_by_hints', role: 'final_publish', probeTarget: 'clickable', hints: ['发布', '立即发布', 'publish'] },
    ]);
    expect(JSON.stringify(action)).not.toContain('秘密正文内容');
  });

  it('can add a read-only creator publish entry probe without adding a click action', () => {
    const action = buildNoeSocialDomRecipeProbeAction({
      platform: 'douyin',
      expectedHost: 'creator.douyin.com',
      content: '正文',
      includeCreatorEntryProbe: true,
    });

    expect(action.args.actions.at(-1)).toMatchObject({
      type: 'probe_by_hints',
      role: 'creator_publish_entry',
      probeTarget: 'clickable',
      hints: ['发布作品', '发布视频', '上传视频', '上传', '创作', '投稿'],
    });
    expect(action.args.actions.map((item) => item.type)).not.toContain('click_by_hints');
    expect(action.recipe).toMatchObject({
      probeOnly: true,
      includeCreatorEntryProbe: true,
    });
  });

  it('can probe media picker readiness without requiring a local media file', () => {
    const action = buildNoeSocialDomRecipeProbeAction({
      platform: 'douyin',
      expectedHost: 'creator.douyin.com',
      content: '正文',
      includeMediaPicker: true,
      mediaFiles: [],
    });

    expect(action.args.actions.find((item) => item.role === 'media_upload')).toMatchObject({
      type: 'probe_by_hints',
      role: 'media_upload',
      probeTarget: 'clickable',
      hints: ['上传', '选择文件', '视频', '添加视频', 'upload'],
    });
    expect(action.args.actions.map((item) => item.type)).not.toContain('click_by_hints');
    expect(JSON.stringify(action.args.actions)).not.toContain('"value"');
  });

  it('falls back for custom platforms without granting publish authority', () => {
    const recipe = socialDomRecipeForPlatform('custom-platform');
    const pack = buildNoeSocialDomRecipePack({
      platform: 'custom-platform',
      expectedHost: 'custom.example.test',
      content: 'hello',
    });

    expect(recipe).toMatchObject({
      platform: 'custom-platform',
      titleHints: ['title', '标题'],
      contentHints: ['content', 'description', '正文', '描述'],
    });
    expect(pack.actions[1]).toMatchObject({
      actionId: 'noe.freedom.browser.dom.execute',
      args: {
        expectedHost: 'custom.example.test',
      },
      recipe: {
        platform: 'custom-platform',
        includeFinalPublishAction: false,
      },
    });
  });
});
