// @ts-check
// rooms-chat-ui.js — Chat 房 1v1 渲染/发送（renderChatRoom/buildChatMessageEl/sendChatMessage/abortChat）（从 app.js 外迁；app.js 模块化第12批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, escapeHtml, renderMarkdown, toast } = core;

    function renderChatRoom(room) {
      window.PanelRoomsChatMedia?.ensureChatMediaDraftRoom?.(room?.id || window.PanelRoomsCore.roomState.activeId);
      window.PanelRoomsChatMedia?.renderChatMediaDraft?.();
      // 卡⑤ session rotate：后端标了 rotateSuggested（对话超 token 阈值）才亮"轮换交接"按钮
      const rotateBtn = $('#btnChatRotate');
      if (rotateBtn) rotateBtn.style.display = room.rotateSuggested ? 'inline-flex' : 'none';
      const msgWrap = $('#chatRoomMessages');
      if (!msgWrap) return;
      msgWrap.innerHTML = '';
      const conv = room.conversation || [];
      if (conv.length === 0) {
        const enabled = (room.members || []).find(m => m.enabled !== false);
        msgWrap.innerHTML = `<div class="chat-room-empty">和 <b>${escapeHtml(enabled?.displayName || '?')}</b> 开始 1v1 对话。<br>
          下面输入框输入消息，Enter 或点 [发送] 即可；也可以拖入图片/视频。<br>
          <span style="font-size:11px;">注：媒体会保存到本机，模型会拿到本地路径并用自己的原生能力读取。</span></div>`;
        return;
      }
      for (const m of conv) {
        msgWrap.appendChild(buildChatMessageEl(m));
      }
      // 滚到底
      msgWrap.scrollTop = msgWrap.scrollHeight;
    }

    function buildChatMessageEl(m) {
      const div = document.createElement('div');
      const isUser = m.from === 'user';
      // v0.54 Sprint 5.5：forward 注入的结论 context 加专属 class
      const isForwardCtx = m.fromForward === true || m.from === 'forward-context';
      div.className = 'chat-room-msg'
        + (isUser ? ' user' : '')
        + (m.error ? ' error' : '')
        + (m.thinking ? ' chat-room-msg-thinking' : '')
        + (isForwardCtx ? ' chat-room-msg-forward-ctx' : '');
      if (m.thinking) div.dataset.thinking = '1';
      const time = m.at ? new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
      const avatar = isUser ? '👤' : (isForwardCtx ? '📌' : (m.displayName?.match(/\p{Emoji}/u)?.[0] || '🤖'));
      const name = isUser ? '我' : (m.displayName || m.from);
      const badge = isForwardCtx ? '<span class="chat-room-forward-badge">上轮结论 · 自动作为对话 context</span>' : '';
      div.innerHTML = `
        <div class="chat-room-msg-avatar">${avatar}</div>
        <div>
          <div class="chat-room-msg-bubble"></div>
          <div class="chat-room-msg-meta">${escapeHtml(name)} · ${time}${m.tokensOut ? ' · ' + m.tokensOut + ' tok' : ''}${badge}</div>
        </div>`;
      div.querySelector('.chat-room-msg-bubble').innerHTML = m.thinking
        ? '思考中…'
        : ((isUser ? escapeHtml(m.content || '').replace(/\n/g, '<br>') : renderMarkdown(m.content || ''))
          + (window.PanelRoomsChatMedia?.renderChatAttachments?.(m.attachments || []) || ''));
      window.PanelRoomsChatMedia?.hydrateChatAttachmentPreviews?.(div);
      return div;
    }

    async function sendChatMessage() {
      const input = $('#chatRoomInput');
      const text = (input?.value || '').trim();
      window.PanelRoomsChatMedia?.ensureChatMediaDraftRoom?.(window.PanelRoomsCore.roomState.activeId);
      const attachments = (window.PanelRoomsChatMedia?.getDraft?.() || []).map(a => ({ id: a.id }));
      if (!text && attachments.length === 0) return;
      if (!window.PanelRoomsCore.roomState.activeId) return;
      input.value = '';
      $('#btnChatAbort').style.display = 'inline-flex';
      try {
        const r = await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}/chat`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, attachments }),
        }).then(x => x.json());
        if (!r.ok) {
          toast('发送失败：' + (r.error || ''), 'error');
          $('#btnChatAbort').style.display = 'none'; // 请求被拒，不会有 WS 回来，复位「中止」按钮
        } else {
          window.PanelRoomsChatMedia?.clearChatMediaDraft?.();
        }
        // 成功(r.ok)时保持显示，等 WS 事件（room_done 等）复位
      } catch (e) {
        toast('发送失败：' + e.message, 'error');
        $('#btnChatAbort').style.display = 'none'; // 请求失败（网络断/server 重启），否则按钮永久卡显示
      }
    }

    async function abortChat() {
      if (!window.PanelRoomsCore.roomState.activeId) return;
      await fetch(`/api/rooms/${window.PanelRoomsCore.roomState.activeId}/abort`, { method: 'POST' });
      $('#btnChatAbort').style.display = 'none';
    }

    window.PanelRoomsChat = {
      renderChatRoom,
      buildChatMessageEl,
      sendChatMessage,
      abortChat,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
