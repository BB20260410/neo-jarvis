// @ts-check
// rooms-chat-media-ui.js — Chat 房媒体附件（草稿托盘/上传/渲染/任务上下文注入）（从 app.js 外迁；app.js 模块化第7批 2026-06-10）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号；boot 延迟初始化避时序 bug。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { $, toast, escapeHtml } = core;

    // ===== v0.48 Chat 房 1v1 渲染 =====
    const CHAT_MEDIA_MAX_FILES = 8;
    const CHAT_MEDIA_MAX_BYTES = 120 * 1024 * 1024;
    const CHAT_MEDIA_ACCEPT_MIME = new Set([
      'image/png', 'image/jpeg', 'image/webp', 'image/gif',
      'video/mp4', 'video/quicktime', 'video/webm',
    ]);
    const CHAT_MEDIA_EXT_MIME = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
    };
    let chatMediaDraft = [];
    let chatMediaDraftRoomId = null;
    const chatMediaPreviewCache = new Map();

    function chatMediaMimeForFile(file) {
      const direct = String(file?.type || '').toLowerCase();
      if (CHAT_MEDIA_ACCEPT_MIME.has(direct)) return direct;
      const ext = String(file?.name || '').toLowerCase().split('.').pop();
      return CHAT_MEDIA_EXT_MIME[ext] || direct;
    }

    function chatMediaKind(mime) {
      return String(mime || '').startsWith('video/') ? 'video' : 'image';
    }

    function chatMediaFormatBytes(n) {
      const size = Number(n) || 0;
      if (size >= 1024 * 1024) return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`;
      if (size >= 1024) return `${(size / 1024).toFixed(0)} KB`;
      return `${size} B`;
    }

    function ensureChatMediaDraftRoom(roomId) {
      if (chatMediaDraftRoomId === roomId) return;
      clearChatMediaDraft();
      chatMediaDraftRoomId = roomId || null;
    }

    function clearChatMediaDraft() {
      for (const a of chatMediaDraft) {
        if (a.previewUrl) {
          try { URL.revokeObjectURL(a.previewUrl); } catch {}
        }
      }
      chatMediaDraft = [];
      renderChatMediaDraft();
    }

    function renderChatMediaDraft() {
      const tray = $('#chatMediaTray');
      if (!tray) return;
      tray.classList.toggle('has-items', chatMediaDraft.length > 0);
      tray.innerHTML = chatMediaDraft.map(a => `
        <div class="chat-media-draft-card" data-chat-media-id="${escapeHtml(a.id)}">
          <div class="chat-media-draft-preview" data-chat-draft-preview="${escapeHtml(a.id)}">${a.kind === 'video' ? '视频' : '图片'}</div>
          <div class="chat-media-draft-meta">
            <span class="chat-media-draft-name" title="${escapeHtml(a.name || '')}">${escapeHtml(a.name || 'media')}</span>
            <span>${escapeHtml(chatMediaFormatBytes(a.size))}</span>
            <button class="chat-media-remove" data-remove-chat-media="${escapeHtml(a.id)}" title="移除">×</button>
          </div>
        </div>`).join('');
      tray.querySelectorAll('[data-chat-draft-preview]').forEach(preview => {
        const item = chatMediaDraft.find(a => a.id === preview.dataset.chatDraftPreview);
        if (!item?.previewUrl) return;
        const el = document.createElement(item.kind === 'video' ? 'video' : 'img');
        el.src = item.previewUrl;
        if (item.kind === 'video') {
          el.controls = true;
          el.muted = true;
          el.preload = 'metadata';
        }
        preview.replaceChildren(el);
      });
      tray.querySelectorAll('[data-remove-chat-media]').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.removeChatMedia;
          const item = chatMediaDraft.find(a => a.id === id);
          if (item?.previewUrl) {
            try { URL.revokeObjectURL(item.previewUrl); } catch {}
          }
          chatMediaDraft = chatMediaDraft.filter(a => a.id !== id);
          renderChatMediaDraft();
        });
      });
    }

    function renderChatAttachments(attachments = []) {
      if (!Array.isArray(attachments) || attachments.length === 0) return '';
      return `<div class="chat-attachments">${attachments.map(a => `
        <div class="chat-attachment-card">
          <div class="chat-attachment-preview" data-chat-media-url="${escapeHtml(a.url || '')}" data-chat-media-kind="${escapeHtml(a.kind || chatMediaKind(a.mime))}">
            ${escapeHtml((a.kind || chatMediaKind(a.mime)) === 'video' ? '视频附件' : '图片附件')}
          </div>
          <div class="chat-attachment-meta">
            <span class="chat-attachment-kind">${escapeHtml(a.kind || chatMediaKind(a.mime))}</span>
            <span class="chat-attachment-name" title="${escapeHtml(a.name || '')}">${escapeHtml(a.name || 'media')}</span>
            <span>${escapeHtml(chatMediaFormatBytes(a.size))}</span>
          </div>
        </div>`).join('')}</div>`;
    }

    async function hydrateChatAttachmentPreviews(root) {
      const previews = [...(root?.querySelectorAll?.('[data-chat-media-url]') || [])];
      for (const preview of previews) {
        const url = preview.dataset.chatMediaUrl || '';
        if (!url || preview.dataset.loaded === '1') continue;
        preview.dataset.loaded = '1';
        try {
          let objectUrl = chatMediaPreviewCache.get(url);
          if (!objectUrl) {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            objectUrl = URL.createObjectURL(await r.blob());
            chatMediaPreviewCache.set(url, objectUrl);
          }
          const kind = preview.dataset.chatMediaKind === 'video' ? 'video' : 'image';
          const el = document.createElement(kind === 'video' ? 'video' : 'img');
          el.src = objectUrl;
          if (kind === 'video') {
            el.controls = true;
            el.muted = true;
            el.preload = 'metadata';
          }
          preview.replaceChildren(el);
        } catch {
          preview.textContent = '预览加载失败';
        }
      }
    }

    async function uploadChatMediaFile(file) {
      const mime = chatMediaMimeForFile(file);
      const r = await fetch(`/api/rooms/${core.roomState.activeId}/media`, {
        method: 'POST',
        headers: {
          'Content-Type': mime || 'application/octet-stream',
          'X-File-Name': encodeURIComponent(file.name || 'media'),
        },
        body: file,
      }).then(x => x.json());
      if (!r.ok) throw new Error(r.error || 'upload failed');
      return r.attachment;
    }

    async function ingestChatMediaFiles(files) {
      if (!core.roomState.activeId) return;
      ensureChatMediaDraftRoom(core.roomState.activeId);
      const candidates = [...files].filter(file => CHAT_MEDIA_ACCEPT_MIME.has(chatMediaMimeForFile(file)));
      if (candidates.length === 0) {
        toast('只支持 PNG/JPG/WebP/GIF/MP4/MOV/WebM', 'warn');
        return;
      }
      const slots = CHAT_MEDIA_MAX_FILES - chatMediaDraft.length;
      if (slots <= 0) {
        toast(`最多同时附加 ${CHAT_MEDIA_MAX_FILES} 个媒体文件`, 'warn');
        return;
      }
      for (const file of candidates.slice(0, slots)) {
        if (file.size > CHAT_MEDIA_MAX_BYTES) {
          toast(`${file.name} 超过 120MB，已跳过`, 'error', 4000);
          continue;
        }
        const previewUrl = URL.createObjectURL(file);
        try {
          const attachment = await uploadChatMediaFile(file);
          chatMediaDraft.push({
            ...attachment,
            kind: attachment.kind || chatMediaKind(attachment.mime || chatMediaMimeForFile(file)),
            previewUrl,
          });
          renderChatMediaDraft();
          toast(`已附加 ${file.name}`, 'success', 1600);
        } catch (e) {
          try { URL.revokeObjectURL(previewUrl); } catch {}
          toast(`上传 ${file.name} 失败：${e.message}`, 'error', 5000);
        }
      }
      if (candidates.length > slots) toast(`只添加前 ${slots} 个，超过上限的已忽略`, 'warn', 3000);
    }

    function appendMediaContextToTaskInput(textarea, attachments) {
      if (!textarea || !attachments.length) return;
      const block = attachments.map((a, idx) => [
        `[媒体附件 ${idx + 1}] ${a.name || a.id}`,
        `类型: ${a.kind || chatMediaKind(a.mime)} / ${a.mime || ''}`,
        `大小: ${chatMediaFormatBytes(a.size)}`,
        `本地路径: ${a.path || ''}`,
        `读取要求: 请各模型使用自己的原生 CLI/文件/多模态能力读取该本地文件；如果是视频且无法直接理解，请先抽帧或读取元数据，不要假装看过。`,
      ].join('\n')).join('\n\n');
      textarea.value = textarea.value.trim()
        ? `${textarea.value.trim()}\n\n${block}`
        : block;
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    async function ingestTaskMediaFiles(files, textarea) {
      if (!core.roomState.activeId) {
        toast('先选中一个房间再添加媒体附件', 'warn');
        return;
      }
      const candidates = [...files].filter(file => CHAT_MEDIA_ACCEPT_MIME.has(chatMediaMimeForFile(file)));
      if (candidates.length === 0) {
        toast('只支持 PNG/JPG/WebP/GIF/MP4/MOV/WebM', 'warn');
        return;
      }
      const uploaded = [];
      for (const file of candidates.slice(0, CHAT_MEDIA_MAX_FILES)) {
        if (file.size > CHAT_MEDIA_MAX_BYTES) {
          toast(`${file.name} 超过 120MB，已跳过`, 'error', 4000);
          continue;
        }
        try {
          uploaded.push(await uploadChatMediaFile(file));
        } catch (e) {
          toast(`上传 ${file.name} 失败：${e.message}`, 'error', 5000);
        }
      }
      appendMediaContextToTaskInput(textarea, uploaded);
      if (uploaded.length) toast(`已把 ${uploaded.length} 个媒体附件写入任务上下文`, 'success', 2200);
    }

    window.PanelRoomsChatMedia = {
      chatMediaMimeForFile,
      chatMediaKind,
      chatMediaFormatBytes,
      ensureChatMediaDraftRoom,
      clearChatMediaDraft,
      renderChatMediaDraft,
      renderChatAttachments,
      hydrateChatAttachmentPreviews,
      uploadChatMediaFile,
      ingestChatMediaFiles,
      appendMediaContextToTaskInput,
      ingestTaskMediaFiles,
      // app.js 残留消费点的最小接口：
      // sendChatMessage 读草稿（活引用，逐字等价于原 chatMediaDraft.map）
      getDraft: () => chatMediaDraft,
      // 绑定块 hasMediaFiles 判断（原 CHAT_MEDIA_ACCEPT_MIME.has(chatMediaMimeForFile(file))）
      isAcceptedMediaFile: (file) => CHAT_MEDIA_ACCEPT_MIME.has(chatMediaMimeForFile(file)),
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
