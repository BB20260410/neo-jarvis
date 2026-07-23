import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createSafeActExecutors } from '../../src/loop/SafeActExecutors.js';

function getExecutor(action, opts = {}) {
  return createSafeActExecutors(opts).get(action);
}

function fakeBrowserDomSpawn(pageResult, calls = []) {
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({
        ok: true,
        browserApp: 'Google Chrome',
        pageResult: JSON.stringify(pageResult),
      }));
      child.emit('close', 0, null);
    });
    return child;
  };
}

function fakeBrowserDomSpawnSequence(pageResults, calls = []) {
  let index = 0;
  return (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    const pageResult = pageResults[Math.min(index, pageResults.length - 1)];
    index += 1;
    queueMicrotask(() => {
      child.stdout.emit('data', JSON.stringify({
        ok: true,
        browserApp: 'Google Chrome',
        pageResult: JSON.stringify(pageResult),
      }));
      child.emit('close', 0, null);
    });
    return child;
  };
}

describe('SafeActExecutors', () => {
  it('NOE_CAPABILITY_ACQUISITION env 映射：ON+capability deps → 注册 noe.capability.install；OFF → 不注册（零回归）', () => {
    const capability = { root: process.cwd(), evaluateGrant: () => ({ authorized: false }), appendEvent: () => 'e' };
    const prev = process.env.NOE_CAPABILITY_ACQUISITION;
    try {
      process.env.NOE_CAPABILITY_ACQUISITION = '1';
      expect(createSafeActExecutors({ capability }).has('noe.capability.install')).toBe(true);
      process.env.NOE_CAPABILITY_ACQUISITION = '0';
      expect(createSafeActExecutors({ capability }).has('noe.capability.install')).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.NOE_CAPABILITY_ACQUISITION;
      else process.env.NOE_CAPABILITY_ACQUISITION = prev;
    }
  });

  it('refuses to write env files', async () => {
    const writeText = getExecutor('file.write_text', {
      safeResolveFsPath: (p) => `/tmp/noe-test/${p}`,
    });

    await expect(writeText({
      act: { payload: { path: '.env', content: 'SECRET=x' } },
      input: {},
    })).rejects.toThrow(/env files/);
  });

  it('requires argv-style safe exec commands', async () => {
    const exec = getExecutor('shell.safe_exec', {
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(exec({
      act: { payload: { command: 'npm install', args: [] } },
      input: {},
    })).rejects.toThrow(/argv-style/);
  });

  it('rejects unsafe git subcommands', async () => {
    const exec = getExecutor('shell.safe_exec', {
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(exec({
      act: { payload: { command: 'git', args: ['reset', '--hard'] } },
      input: {},
    })).rejects.toThrow(/git subcommand not allowed/);
  });

  it('runs allowed commands through the injected runner with a sanitized env', async () => {
    let seen = null;
    const exec = getExecutor('shell.safe_exec', {
      commandRunner: async (input) => {
        seen = input;
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });

    const result = await exec({
      act: { payload: { command: 'node', args: ['--version'], timeoutMs: 1000 } },
      input: {},
    });

    expect(result).toMatchObject({ command: 'node', args: ['--version'], exitCode: 0, stdout: 'ok' });
    expect(seen.env).not.toHaveProperty('MINIMAX_API_KEY');
    expect(seen.env).not.toHaveProperty('OPENAI_API_KEY');
  });

  it('appends autonomous notes with basic secret redaction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-note-exec-'));
    try {
      const writeNote = getExecutor('noe.note.write', {
        safeResolveFsPath: (p) => join(dir, String(p).replace(/^\/+/, '')),
      });

      const result = await writeNote({
        act: { title: '写自治笔记', payload: { path: 'output/noe-autonomy/learning.md', content: 'apiKey: "sk-abc123456789"\nBearer secret-token-value\nok' } },
        input: {},
      });

      const body = readFileSync(result.path, 'utf8');
      expect(result.append).toBe(true);
      expect(body).toContain('apiKey: [REDACTED]');
      expect(body).toContain('Bearer [REDACTED]');
      expect(body).toContain('ok');
      expect(body).not.toContain('sk-abc123456789');
      expect(body).not.toContain('secret-token-value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('file.write_text 落盘前对 content 脱敏 secret（防外泄，与 noe.note.write 对齐）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-write-redact-'));
    try {
      const writeText = getExecutor('file.write_text', {
        safeResolveFsPath: (p) => join(dir, String(p).replace(/^\/+/, '')),
      });
      const result = await writeText({
        act: { title: '写文件', payload: { path: 'output/noe-autonomy/out.txt', content: 'apiKey: "sk-abc123456789"\nBearer secret-token-value\nok' } },
        input: {},
      });
      const body = readFileSync(result.path, 'utf8');
      expect(body).toContain('apiKey: [REDACTED]');   // secret 被脱敏
      expect(body).toContain('Bearer [REDACTED]');
      expect(body).toContain('ok');                    // 非 secret 内容保留
      expect(body).not.toContain('sk-abc123456789');   // 修复前=原样落盘(外泄)
      expect(body).not.toContain('secret-token-value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('opens http/https URLs through the injected runner', async () => {
    let seen = null;
    const open = getExecutor('browser.open', {
      commandRunner: async (input) => {
        seen = input;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await open({
      act: { payload: { url: 'example.com/docs' } },
      input: {},
    });

    // 默认 Chrome 走复用当前标签(set URL of active tab)而非 open 新 tab——治反复开网页堆标签卡电脑(owner 2026-06-23)
    expect(result).toMatchObject({ command: 'osascript', reused: true, exitCode: 0 });
    expect(seen.command).toBe('osascript');
    expect(seen.args[0]).toBe('-e');
    expect(seen.args[1]).toContain('set URL of active tab');
    expect(seen.args[1]).toContain('https://example.com/docs');
  });

  it('browser.open_url is an alias for the browser opener', async () => {
    let seen = null;
    const open = getExecutor('browser.open_url', {
      commandRunner: async (input) => {
        seen = input;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await open({
      act: { payload: { url: 'https://example.com/agent' } },
      input: {},
    });

    expect(result).toMatchObject({ command: 'osascript', reused: true, exitCode: 0 });
    expect(seen.args[1]).toContain('https://example.com/agent');
  });

  it('allowNewTab:true → 回退 open 新标签（显式要新开时）', async () => {
    let seen = null;
    const open = getExecutor('browser.open', {
      commandRunner: async (input) => { seen = input; return { exitCode: 0, stdout: '', stderr: '' }; },
    });
    const result = await open({ act: { payload: { url: 'https://example.com/x', allowNewTab: true } }, input: {} });
    expect(result).toMatchObject({ command: 'open', args: ['https://example.com/x'], reused: false });
    expect(seen.command).toBe('open');
  });

  it('Chrome set URL 失败 → 回退 open（fail-open，不卡死自主学习）', async () => {
    let calls = 0;
    const open = getExecutor('browser.open', {
      commandRunner: async (input) => { calls += 1; return { exitCode: input.command === 'osascript' ? 1 : 0, stdout: '', stderr: '' }; },
    });
    const result = await open({ act: { payload: { url: 'https://example.com/y' } }, input: {} });
    expect(calls).toBe(2); // osascript 失败(exitCode 1) → 回退 open
    expect(result.command).toBe('open');
    expect(result.reused).toBe(false);
  });

  it('activates a macOS app through the injected runner', async () => {
    let seen = null;
    const activate = getExecutor('macos.app.activate', {
      commandRunner: async (input) => {
        seen = input;
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await activate({
      act: { payload: { app: 'Google Chrome' } },
      input: {},
    });

    expect(result).toMatchObject({
      app: 'Google Chrome',
      command: 'open',
      args: ['-a', 'Google Chrome'],
      exitCode: 0,
      desktopAutomationAttempted: true,
    });
    expect(seen.command).toBe('open');
    expect(seen.args).toEqual(['-a', 'Google Chrome']);
  });

  it('rejects unsafe macOS app names', async () => {
    const activate = getExecutor('macos.app.activate', {
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(activate({
      act: { payload: { app: 'Google Chrome; rm -rf ~' } },
      input: {},
    })).rejects.toThrow(/unsupported/);
  });

  it('types text through macOS keyboard automation without returning typed text', async () => {
    const calls = [];
    const typeText = getExecutor('macos.text.type', {
      commandRunner: async (input) => {
        calls.push(input);
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
    });

    const result = await typeText({
      act: { payload: { app: 'Google Chrome', text: 'Noe autonomy', ackClipboardOverwrite: true } },
      input: {},
    });

    expect(result).toMatchObject({
      app: 'Google Chrome',
      command: 'osascript',
      language: 'JavaScript',
      strategy: 'clipboard_paste',
      exitCode: 0,
      textReturned: false,
      clipboardOverwritten: true,
      previousClipboardRead: false,
      activatedApp: true,
      desktopAutomationAttempted: true,
    });
    expect(calls[0]).toMatchObject({ command: 'open', args: ['-a', 'Google Chrome'] });
    expect(calls[1].command).toBe('osascript');
    expect(calls[1].args.join('\n')).toContain('setTheClipboardTo');
    expect(JSON.stringify(result)).not.toContain('Noe autonomy');
  });

  it('requires clipboard overwrite ack and refuses multiline or sensitive-looking macOS keyboard text', async () => {
    const typeText = getExecutor('macos.text.type', {
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(typeText({
      act: { payload: { text: 'Noe autonomy' } },
      input: {},
    })).rejects.toThrow(/ackClipboardOverwrite/);
    await expect(typeText({
      act: { payload: { text: 'first line\nsecond line', ackClipboardOverwrite: true } },
      input: {},
    })).rejects.toThrow(/newline/);
    await expect(typeText({
      act: { payload: { text: 'apiKey=sk-abc123456789', ackClipboardOverwrite: true } },
      input: {},
    })).rejects.toThrow(/sensitive/);
  });

  it('presses a governed macOS key through the injected runner', async () => {
    const calls = [];
    const pressKey = getExecutor('macos.key.press', {
      commandRunner: async (input) => {
        calls.push(input);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    const result = await pressKey({
      act: { payload: { app: 'TextEdit', key: 'left' } },
      input: {},
    });

    expect(result).toMatchObject({
      app: 'TextEdit',
      key: 'left',
      keyCode: 123,
      command: 'osascript',
      language: 'AppleScript',
      activatedApp: true,
      desktopAutomationAttempted: true,
    });
    expect(calls[0]).toMatchObject({ command: 'open', args: ['-a', 'TextEdit'] });
    expect(calls[1].args.join('\n')).toContain('key code 123');
  });

  it('requires explicit acks for submit or destructive macOS keys', async () => {
    const pressKey = getExecutor('macos.key.press', {
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(pressKey({
      act: { payload: { key: 'return' } },
      input: {},
    })).rejects.toThrow(/ackSubmitKey/);
    await expect(pressKey({
      act: { payload: { key: 'delete' } },
      input: {},
    })).rejects.toThrow(/ackDestructiveKey/);
    await expect(pressKey({
      act: { payload: { key: 'return', ackSubmitKey: true } },
      input: {},
    })).resolves.toMatchObject({ key: 'return', keyCode: 36 });
  });

  it('clicks a governed macOS screen coordinate only with explicit ack', async () => {
    const calls = [];
    const click = getExecutor('macos.pointer.click', {
      commandRunner: async (input) => {
        calls.push(input);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    });

    await expect(click({
      act: { payload: { app: 'TextEdit', x: 120, y: 240 } },
      input: {},
    })).rejects.toThrow(/ackCoordinateClick/);

    const result = await click({
      act: { payload: { app: 'TextEdit', x: 120.2, y: 239.8, ackCoordinateClick: true } },
      input: {},
    });

    expect(result).toMatchObject({
      app: 'TextEdit',
      x: 120,
      y: 240,
      button: 'left',
      command: 'cliclick',
      args: ['c:120,240'],
      backend: 'cliclick',
      language: null,
      activatedApp: true,
      desktopAutomationAttempted: true,
    });
    expect(calls[0]).toMatchObject({ command: 'open', args: ['-a', 'TextEdit'] });
    expect(calls[1]).toMatchObject({ command: 'cliclick', args: ['c:120,240'] });
  });

  it('runs AppleScript through osascript without returning the script body', async () => {
    const calls = [];
    const runAppleScript = getExecutor('macos.applescript.run', {
      commandRunner: async (input) => {
        calls.push(input);
        return { exitCode: 0, stdout: 'Google Chrome', stderr: '' };
      },
    });
    const script = 'tell application "System Events" to get name of first process whose frontmost is true';

    const result = await runAppleScript({
      act: { payload: { app: 'Google Chrome', script } },
      input: {},
    });

    expect(result).toMatchObject({
      app: 'Google Chrome',
      command: 'osascript',
      language: 'AppleScript',
      exitCode: 0,
      scriptBytes: Buffer.byteLength(script, 'utf8'),
      scriptReturned: false,
      activatedApp: true,
      desktopAutomationAttempted: true,
      stdout: 'Google Chrome',
    });
    expect(calls[0]).toMatchObject({ command: 'open', args: ['-a', 'Google Chrome'] });
    expect(calls[1]).toMatchObject({ command: 'osascript', args: ['-e', script] });
    expect(JSON.stringify(result)).not.toContain('frontmost');
    expect(JSON.stringify(result)).not.toContain(script);
  });

  it('runs JXA through osascript -l JavaScript and exposes desktop aliases', async () => {
    const calls = [];
    const runJxa = getExecutor('desktop.jxa.run', {
      commandRunner: async (input) => {
        calls.push(input);
        return { exitCode: 0, stdout: '{"ok":true}', stderr: '' };
      },
    });
    const script = 'JSON.stringify({ok:true})';

    const result = await runJxa({
      act: { payload: { script } },
      input: {},
    });

    expect(result).toMatchObject({
      app: null,
      command: 'osascript',
      language: 'JavaScript',
      exitCode: 0,
      scriptBytes: Buffer.byteLength(script, 'utf8'),
      scriptReturned: false,
      activatedApp: false,
      desktopAutomationAttempted: true,
      stdout: '{"ok":true}',
    });
    expect(calls[0]).toMatchObject({ command: 'osascript', args: ['-l', 'JavaScript', '-e', script] });
    expect(JSON.stringify(result)).not.toContain(script);
  });

  it('rejects missing or invalid macOS automation scripts', async () => {
    const runAppleScript = getExecutor('macos.script.run', {
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(runAppleScript({
      act: { payload: { script: '' } },
      input: {},
    })).rejects.toThrow(/script required/);
    await expect(runAppleScript({
      act: { payload: { script: 'return "ok"\0' } },
      input: {},
    })).rejects.toThrow(/invalid characters/);
  });

  it('plans visual/browser actions without desktop execution', async () => {
    const plan = await getExecutor('visual.action.plan')({
      act: { title: '规划打开资料页后的下一步', payload: { goal: '输入搜索词 Noe', domSummary: '<input role="search">' } },
      input: {},
    });

    expect(plan).toMatchObject({ ok: true, status: 'planned', execute: false, requiresApproval: true });
    expect(plan.actions[0].type).toBe('browser.type');
    expect(plan.evidence.domSummary).toContain('role="search"');
  });

  it('probes browser state through the freedom adapter without returning raw tokenized URLs', async () => {
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({
          ok: true,
          frontmostApp: 'Google Chrome',
          activeBrowser: { app: 'Google Chrome', url: 'https://example.test/page?token=secret-value', title: 'Docs', frontmost: true, windowCount: 1 },
          browsers: [{ app: 'Google Chrome', url: 'https://example.test/page?token=secret-value', title: 'Docs', frontmost: true, windowCount: 1 }],
          cookiesReadByNoe: false,
          passwordReadByNoe: false,
          pageContentReadByNoe: false,
        }));
        child.emit('close', 0, null);
      });
      return child;
    };
    const probe = getExecutor('browser.state_probe', { freedomDeps: { spawn: fakeSpawn } });

    const result = await probe({
      act: { payload: { includeAll: true } },
      input: {},
    });

    expect(result).toMatchObject({
      ok: true,
      adapter: 'browser-state-probe',
      activeBrowser: { url: 'https://example.test/page?token=%5Bredacted%5D', title: 'Docs' },
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      secretValuesReturned: false,
    });
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(calls[0].command).toBe('osascript');
  });

  it('observes the active browser page through DOM read_title', async () => {
    const calls = [];
    const observe = getExecutor('browser.observe_page', {
      freedomDeps: {
        spawn: fakeBrowserDomSpawn({
          ok: true,
          host: 'example.test',
          url: 'https://example.test/docs?token=secret-value',
          title: 'Agent Docs',
          actions: [{ index: 0, type: 'read_title', ok: true, found: true }],
          cookiesReadByNoe: false,
          passwordReadByNoe: false,
          pageContentReadByNoe: false,
          secretValuesReturned: false,
        }, calls),
      },
    });

    const result = await observe({
      act: { payload: { browserApp: 'Google Chrome', expectedHost: 'example.test' } },
      input: {},
    });

    expect(result).toMatchObject({
      ok: true,
      adapter: 'browser-dom-execute',
      titlePresent: true,
      actionCount: 1,
    });
    expect(result.titleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('Agent Docs');
    expect(JSON.stringify(result)).not.toContain('secret-value');
    expect(calls[0].command).toBe('osascript');
  });

  it('reopens the declared target URL once when DOM observation is on the wrong host', async () => {
    const calls = [];
    const opened = [];
    const observe = getExecutor('browser.observe_page', {
      commandRunner: async (input) => {
        opened.push(input);
        return { exitCode: 0, stdout: '', stderr: '' };
      },
      freedomDeps: {
        spawn: fakeBrowserDomSpawnSequence([
          {
            ok: false,
            error: 'browser_dom_host_mismatch',
            host: 'localhost',
            expectedHosts: ['example.test'],
            actions: [],
          },
          {
            ok: true,
            host: 'example.test',
            url: 'https://example.test/docs',
            title: 'Agent Docs',
            actions: [{ index: 0, type: 'read_title', ok: true, found: true }],
          },
        ], calls),
      },
    });

    const result = await observe({
      act: {
        payload: {
          browserApp: 'Google Chrome',
          url: 'https://example.test/docs',
          expectedHost: 'example.test',
          retryDelayMs: 0,
        },
      },
      input: {},
    });

    expect(result).toMatchObject({
      ok: true,
      titlePresent: true,
      browserDomRecovery: {
        reason: 'browser_dom_host_mismatch',
        attempted: true,
        reopenedUrl: 'https://example.test/docs',
        browserApp: 'Google Chrome',
        openExitCode: 0,
        activationExitCode: 0,
      },
    });
    expect(result.titleSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result)).not.toContain('Agent Docs');
    expect(opened).toHaveLength(2);
    expect(opened[0]).toMatchObject({ command: 'open', args: ['-a', 'Google Chrome', 'https://example.test/docs'] });
    expect(opened[1]).toMatchObject({ command: 'osascript', args: ['-e', 'tell application "Google Chrome" to activate'] });
    expect(calls).toHaveLength(2);
  });

  it('clicks and types in the active browser via DOM actions', async () => {
    const click = getExecutor('browser.click', {
      freedomDeps: {
        spawn: fakeBrowserDomSpawn({
          ok: true,
          host: 'example.test',
          url: 'https://example.test/form',
          title: 'Form',
          actions: [{ index: 0, type: 'click', selector: '#next', ok: true, found: true, clicked: true }],
        }),
      },
    });
    const type = getExecutor('browser.type', {
      freedomDeps: {
        spawn: fakeBrowserDomSpawn({
          ok: true,
          host: 'example.test',
          url: 'https://example.test/form',
          title: 'Form',
          actions: [{ index: 0, type: 'set_by_hints', role: 'search', ok: true, found: true, valueSet: true }],
        }),
      },
    });

    await expect(click({ act: { payload: { selector: '#next' } }, input: {} }))
      .resolves.toMatchObject({ ok: true, actions: [{ clicked: true }] });
    await expect(type({ act: { payload: { role: 'search', hints: ['Search'], text: 'Noe autonomy' } }, input: {} }))
      .resolves.toMatchObject({ ok: true, actions: [{ valueSet: true }] });
  });

  it('requires an explicit side-effect ack for publish/delete-style browser clicks', async () => {
    const click = getExecutor('browser.click', {
      freedomDeps: {
        spawn: fakeBrowserDomSpawn({
          ok: true,
          actions: [{ index: 0, type: 'click_by_hints', role: 'final_publish', ok: true, found: true, clicked: true }],
        }),
      },
    });

    await expect(click({
      act: { payload: { role: 'final_publish', hints: ['发布'] } },
      input: {},
    })).rejects.toThrow(/side_effect_ack/);

    await expect(click({
      act: { payload: { role: 'final_publish', hints: ['发布'], ackExternalSideEffect: true } },
      input: {},
    })).resolves.toMatchObject({ ok: true });
  });

  it('refuses non-web browser.open schemes', async () => {
    const open = getExecutor('browser.open', {
      commandRunner: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    });

    await expect(open({
      act: { payload: { url: 'javascript:alert(1)' } },
      input: {},
    })).rejects.toThrow(/http\/https/);
  });
});
