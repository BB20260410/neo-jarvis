// @ts-check
// markdown-ui.js — v0.24/v0.25 markdown 渲染（marked + DOMPurify 定制 renderer）
// （ensureMarkedConfigured/renderMarkdown + 代码块复制/折叠 document 委托——按钮由 renderMarkdown 生成，属主=本区）
// （从 app.js 外迁；app.js 模块化第21批 2026-06-11）
// 依赖经 window.PanelCore 桥取 app.js 顶层共享符号（纯工具可解构：escapeHtml/escapeHtmlEarly/toast）；
// boot 延迟初始化避时序 bug。document click 委托收进 boot() 只绑一次。
// 铁律原样保留：①_markedConfigured 幂等（marked.use 只配置一次）②CDN 全局 window.marked/window.DOMPurify
// 缺失或解析失败时 Path B 手写 regex fallback（消息渲染热路径的降级语义不许丢）。
// 消费方（sessions-list/stream/tools/safety/projects-files/rooms-* 等）经 PanelCore.renderMarkdown 懒转发取用。
(function () {
  'use strict';
  function boot() {
    const core = window.PanelCore;
    const { escapeHtml, escapeHtmlEarly, toast } = core;
    const IMG_PLACEHOLDER = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';

    function ownerToken() {
      try {
        return new URLSearchParams(window.location.search).get('t')
          || window.localStorage?.getItem?.('panel-owner-token')
          || window.sessionStorage?.getItem?.('panel-owner-token')
          || '';
      } catch { return ''; }
    }

    async function hydrateCachedMarkdownImage(img) {
      if (!img || img.dataset.noeImgLoading === '1') return;
      const url = img.dataset.noeImgCacheUrl || '';
      if (!url) return;
      img.dataset.noeImgLoading = '1';
      try {
        const token = ownerToken();
        const headers = token ? { 'X-Panel-Owner-Token': token } : {};
        const resp = await fetch(url, { headers, credentials: 'same-origin' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const blob = await resp.blob();
        if (blob.type && !/^image\//i.test(blob.type)) throw new Error('not an image');
        const oldUrl = img.dataset.noeBlobUrl || '';
        const objectUrl = URL.createObjectURL(blob);
        img.src = objectUrl;
        img.dataset.noeBlobUrl = objectUrl;
        img.removeAttribute('data-noe-img-cache-url');
        if (oldUrl.startsWith('blob:')) URL.revokeObjectURL(oldUrl);
      } catch (e) {
        img.alt = img.alt || '图片加载失败';
        img.title = `图片加载失败：${e?.message || e}`;
      } finally {
        delete img.dataset.noeImgLoading;
      }
    }

    function scanCachedMarkdownImages(root = document) {
      try {
        const base = root?.querySelectorAll ? root : document;
        if (base.matches?.('img[data-noe-img-cache-url]')) hydrateCachedMarkdownImage(base);
        base.querySelectorAll('img[data-noe-img-cache-url]').forEach(hydrateCachedMarkdownImage);
      } catch {}
    }

    // v0.25 marked 自定义 code renderer：输出 .code-wrap 含 toolbar + 行号 + 折叠
    let _markedConfigured = false;
    function ensureMarkedConfigured() {
      if (_markedConfigured || !window.marked) return;
      try {
        const renderer = {
          code(token) {
            // marked v13 token object: { text, lang, escaped, ... }
            const text = (token && typeof token === 'object') ? (token.text || '') : (arguments[0] || '');
            const lang = ((token && token.lang) || arguments[1] || 'plaintext').toString().toLowerCase().slice(0, 30);
            const lines = text.split('\n').length;
            const collapsed = lines > 12;
            // v0.26 diff 专属逐行 span 着色
            let body;
            if (lang === 'diff') {
              body = text.split('\n').map(ln => {
                let cls = 'diff-ctx';
                if (ln.startsWith('+++') || ln.startsWith('---')) cls = 'diff-file';
                else if (ln.startsWith('@@')) cls = 'diff-hunk';
                else if (ln.startsWith('+')) cls = 'diff-add';
                else if (ln.startsWith('-')) cls = 'diff-del';
                return `<span class="diff-line ${cls}">${escapeHtmlEarly(ln)}</span>`;
              }).join('\n');
            } else {
              body = escapeHtmlEarly(text);
            }
            return [
              `<div class="code-wrap${collapsed ? ' code-collapsed' : ''}" data-lang="${escapeHtmlEarly(lang)}">`,
              `<div class="code-toolbar">`,
              `<span class="code-lang">${escapeHtmlEarly(lang)}</span>`,
              `<span class="code-lines">${lines} 行</span>`,
              `<button type="button" class="code-collapse-btn" aria-label="折叠/展开代码块" title="折叠/展开">${collapsed ? '▶' : '▼'}</button>`,
              `<button type="button" class="code-copy-btn" aria-label="复制代码到剪贴板" title="复制">📋</button>`,
              `</div>`,
              `<pre><code class="lang-${escapeHtmlEarly(lang)}">${body}</code></pre>`,
              `</div>`,
            ].join('');
          },
        };
        window.marked.use({ renderer });
        // v0.49 N-21 fix: DOMPurify hook 给所有 a 标签强制加 rel="noopener noreferrer" + target="_blank"
        // 防 Reverse Tabnabbing：新页面通过 window.opener 篡改原页
        if (window.DOMPurify && typeof window.DOMPurify.addHook === 'function') {
          window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
            if (node.nodeName === 'A' && node.hasAttribute('href')) {
              node.setAttribute('target', '_blank');
              node.setAttribute('rel', 'noopener noreferrer');
            }
          });
        }
        _markedConfigured = true;
      } catch (e) {
        // S26 B2：启动期 markdown init 失败用户应感知（影响 message render 体验）
        // 不用 setTimeout 因为 toast 可能 DOM 未 ready；toast(0) 不自动消失，强制用户看到
        console.warn('marked.use renderer failed:', e.message);
        try { toast('markdown 渲染降级（marked.use 失败：' + e.message + '）', 'warn', 0); } catch {}
      }
    }

    // v0.24/v0.25 marked + DOMPurify 替换手写 regex；CDN 失败时 fallback 到老 regex
    function renderMarkdown(text) {
      if (!text) return '';
      // Path A: marked + DOMPurify
      if (typeof window !== 'undefined' && window.marked && window.DOMPurify) {
        try {
          ensureMarkedConfigured();
          const raw = window.marked.parse(text, {
            gfm: true,           // GitHub flavored
            breaks: true,        // \n → <br>（贴近 chat 习惯）
            headerIds: false,    // 不生成 id（防 XSS）
            mangle: false,
          });
          let safe = window.DOMPurify.sanitize(raw, {
            ALLOWED_TAGS: ['a','b','strong','i','em','u','s','del','code','pre','p','br','hr',
                           'ul','ol','li','blockquote','h1','h2','h3','h4','h5','h6',
                           'table','thead','tbody','tr','th','td','span','div','img','button'],
            ALLOWED_ATTR: ['href','target','rel','title','alt','src','class','colspan','rowspan',
                           'type','aria-label','data-lang'],
            ALLOW_DATA_ATTR: false,
            ADD_ATTR: ['target'],
            // v0.44 P1 #14: 限协议，禁 javascript: / data:image/svg / vbscript: 等绕过路径
            ALLOWED_URI_REGEXP: /^(https?:|mailto:|tel:|#|\/)/i,
          });
          // B-005 v0.9：外链图片走本地缓存 proxy（防外链失效）
          safe = safe.replace(/<img\b([^>]*?)\ssrc=["'](https?:\/\/[^"']+)["']/gi, (m, attrs, src) => {
            const escapedSrc = src.replace(/"/g, '&quot;');
            return `<img${attrs} src="${IMG_PLACEHOLDER}" data-noe-img-cache-url="/api/img-cache?url=${encodeURIComponent(src)}" data-original-src="${escapedSrc}"`;
          });
          return safe;
        } catch (e) {
          // 解析失败 → fallback
          console.warn('marked/DOMPurify failed, fallback:', e.message);
        }
      }
      // Path B: fallback 手写 regex（CDN 没加载时）
      let html = escapeHtml(text);
      html = html.replace(/```([a-zA-Z]*)\n([\s\S]*?)```/g, (_, lang, code) => {
        return `<pre><code class="lang-${lang}">${code}</code></pre>`;
      });
      html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
      html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
      html = html.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
      html = html.replace(/\n/g, '<br>');
      return html;
    }

    // v0.25 代码块复制 + 折叠（event delegation on #chatOutput）——按钮由 renderMarkdown 生成，属主=本区
    // 原 app.js 加载即执行的 document 级委托收进 boot() 只绑一次
    document.addEventListener('click', (e) => {
      const copyBtn = e.target.closest('.code-copy-btn');
      if (copyBtn) {
        e.stopPropagation();
        const wrap = copyBtn.closest('.code-wrap');
        const code = wrap?.querySelector('pre > code');
        if (code) {
          const text = code.textContent || '';
          navigator.clipboard?.writeText(text).then(() => {
            const orig = copyBtn.textContent;
            copyBtn.textContent = '✓';
            copyBtn.classList.add('copy-success');
            setTimeout(() => {
              copyBtn.textContent = orig;
              copyBtn.classList.remove('copy-success');
            }, 1500);
          }).catch(err => toast('复制失败: ' + err.message, 'error'));
        }
        return;
      }
      const collapseBtn = e.target.closest('.code-collapse-btn');
      if (collapseBtn) {
        e.stopPropagation();
        const wrap = collapseBtn.closest('.code-wrap');
        if (wrap) {
          const nowCollapsed = wrap.classList.toggle('code-collapsed');
          collapseBtn.textContent = nowCollapsed ? '▶' : '▼';
          collapseBtn.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
        }
        return;
      }
    });

    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver((records) => {
        for (const record of records) {
          record.addedNodes?.forEach?.((node) => {
            if (node?.nodeType === 1) scanCachedMarkdownImages(node);
          });
        }
      });
      try { observer.observe(document.body || document.documentElement, { childList: true, subtree: true }); } catch {}
    }
    scanCachedMarkdownImages(document);

    window.PanelMarkdown = {
      ensureMarkedConfigured,
      renderMarkdown,
      scanCachedMarkdownImages,
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(boot, 0));
  } else {
    setTimeout(boot, 0);
  }
})();
