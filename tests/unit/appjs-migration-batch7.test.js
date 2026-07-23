// @ts-check
// S24 模块化第7批（chatMedia 媒体附件外迁 rooms-chat-media-ui.js）结构级防回归
// 风格对齐 appjs-migration-batch6.test.js：源码文本断言，钉死接线不被静默破坏
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const MODULE_FILE = 'public/src/web/rooms-chat-media-ui.js';
const PUBLIC_FNS = [
  'chatMediaMimeForFile',
  'chatMediaKind',
  'chatMediaFormatBytes',
  'ensureChatMediaDraftRoom',
  'clearChatMediaDraft',
  'renderChatMediaDraft',
  'renderChatAttachments',
  'hydrateChatAttachmentPreviews',
  'uploadChatMediaFile',
  'ingestChatMediaFiles',
  'appendMediaContextToTaskInput',
  'ingestTaskMediaFiles',
  'getDraft',
  'isAcceptedMediaFile',
];

describe('app.js 模块化第7批接线', () => {
  const appJs = read('public/app.js');
  const mainJs = read('public/main.js');
  const src = read(MODULE_FILE);

  it('外迁模块存在、走 PanelCore 桥、暴露 window.PanelRoomsChatMedia 全部公开函数', () => {
    expect(src).toContain('window.PanelCore');
    expect(src).toContain('window.PanelRoomsChatMedia = {');
    for (const sym of PUBLIC_FNS) expect(src, `${MODULE_FILE} 缺 ${sym}`).toContain(sym);
    // 外迁文件不得直接引用 app.js 闭包内符号 roomState（必须经 core.roomState）
    expect(/[^.]roomState\./.test(src.replace(/core\.roomState\./g, '')), `${MODULE_FILE} 裸引 roomState`).toBe(false);
  });

  it('main.js import 第7批模块（带 cache-bust）', () => {
    expect(mainJs).toContain("./src/web/rooms-chat-media-ui.js?v=appjs-migration-batch7-20260610");
  });

  it('app.js 不再保留 chatMedia 实现，只留外迁标记', () => {
    for (const gone of [
      'let chatMediaDraft',
      'const CHAT_MEDIA_ACCEPT_MIME',
      'const chatMediaPreviewCache',
      'function chatMediaMimeForFile',
      'function renderChatMediaDraft',
      'async function uploadChatMediaFile',
      'async function ingestChatMediaFiles',
      'async function ingestTaskMediaFiles',
    ]) {
      expect(appJs, `app.js 残留 ${gone}`).not.toContain(gone);
    }
    expect(appJs.match(/（模块化第7批）==========/g)?.length).toBe(1);
  });

  it('外迁调用点全部改经 window.PanelRoomsChatMedia 安全访问（第12批起 chat 渲染在 rooms-chat-ui、绑定块在 rooms-actions-ui）', () => {
    const chatSrc = read('public/src/web/rooms-chat-ui.js');
    const actionsSrc = read('public/src/web/rooms-actions-ui.js');
    // renderChatRoom / sendChatMessage 各一处 ensureChatMediaDraftRoom
    expect(chatSrc.match(/window\.PanelRoomsChatMedia\?\.ensureChatMediaDraftRoom\?\.\(/g)?.length).toBe(2);
    expect(chatSrc).toContain('window.PanelRoomsChatMedia?.renderChatMediaDraft?.()');
    // buildChatMessageEl：附件 HTML 渲染保持 '' 兜底，预览异步注水
    expect(chatSrc).toContain("(window.PanelRoomsChatMedia?.renderChatAttachments?.(m.attachments || []) || '')");
    expect(chatSrc).toContain('window.PanelRoomsChatMedia?.hydrateChatAttachmentPreviews?.(div)');
    // sendChatMessage：读草稿走 getDraft 活引用，发送成功后清空
    expect(chatSrc).toContain('(window.PanelRoomsChatMedia?.getDraft?.() || []).map(a => ({ id: a.id }))');
    expect(chatSrc).toContain('window.PanelRoomsChatMedia?.clearChatMediaDraft?.()');
    // 绑定块（第12批随 rooms-actions-ui 出走）：file input + chat 拖放/粘贴 = 3 处；topic 拖放/粘贴 = 2 处；MIME 判断走最小接口
    expect(actionsSrc.match(/window\.PanelRoomsChatMedia\?\.ingestChatMediaFiles\?\.\(/g)?.length).toBe(3);
    expect(actionsSrc.match(/window\.PanelRoomsChatMedia\?\.ingestTaskMediaFiles\?\.\(/g)?.length).toBe(2);
    expect(actionsSrc).toContain('window.PanelRoomsChatMedia?.isAcceptedMediaFile?.(file)');
    // 定义已外迁，不允许残留裸调用（前缀必须是 . 或 ?.）
    expect(/[^.?]ingestChatMediaFiles\(/.test(appJs)).toBe(false);
    expect(/[^.?]ingestTaskMediaFiles\(/.test(appJs)).toBe(false);
    expect(/[^.?]clearChatMediaDraft\(/.test(appJs)).toBe(false);
    expect(appJs.includes('chatMediaDraft.map')).toBe(false);
  });
});
