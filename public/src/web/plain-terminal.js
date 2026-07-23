(function () {
  function clean(data) {
    return String(data || '')
      .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
      .replace(/\x1b\][\s\S]*?\x07/g, '')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }

  function keyToData(event) {
    if (event.ctrlKey && event.key && event.key.length === 1) {
      const code = event.key.toUpperCase().charCodeAt(0) - 64;
      if (code >= 1 && code <= 26) return String.fromCharCode(code);
    }
    if (event.key === 'Enter') return '\r';
    if (event.key === 'Backspace') return '\x7f';
    if (event.key === 'Tab') return '\t';
    if (event.key === 'Escape') return '\x1b';
    if (event.key === 'ArrowUp') return '\x1b[A';
    if (event.key === 'ArrowDown') return '\x1b[B';
    if (event.key === 'ArrowRight') return '\x1b[C';
    if (event.key === 'ArrowLeft') return '\x1b[D';
    if (!event.metaKey && !event.altKey && event.key && event.key.length === 1) return event.key;
    return '';
  }

  window.createPlainTerminal = function createPlainTerminal(container) {
    let onDataHandler = null;
    let text = '[xterm CDN 未加载，已启用纯文本终端；基础命令可用，TUI 体验会降级。]\n';
    const screen = document.createElement('pre');
    screen.className = 'plain-term-screen';
    screen.tabIndex = 0;
    screen.textContent = text;
    container.classList.add('plain-term-container');
    container.appendChild(screen);

    const api = {
      cols: 100,
      rows: 30,
      write(data) {
        text = (text + clean(data)).slice(-80_000);
        screen.textContent = text;
        screen.scrollTop = screen.scrollHeight;
      },
      focus() { screen.focus(); },
      dispose() {
        screen.remove();
        container.classList.remove('plain-term-container');
      },
      onData(handler) {
        onDataHandler = handler;
        return { dispose() { if (onDataHandler === handler) onDataHandler = null; } };
      },
      onResize() {
        return { dispose() {} };
      },
    };

    screen.addEventListener('keydown', (event) => {
      const data = keyToData(event);
      if (!data || !onDataHandler) return;
      event.preventDefault();
      onDataHandler(data);
    });

    return api;
  };
}());
