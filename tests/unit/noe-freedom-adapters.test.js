import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { findNoeFreedomTool } from '../../src/capabilities/NoeFreedomManifest.js';
import { runNoeFreedomAdapter, SHELL_BIN } from '../../src/runtime/NoeFreedomAdapters.js';
import { writeNoeFreedomRunLedgerFile } from '../../src/runtime/NoeFreedomRunLedger.js';

function tool(id) {
  return findNoeFreedomTool(id);
}

describe('NoeFreedomAdapters', () => {
  it('builds a social publish dry-run without calling fetch', async () => {
    const calls = [];
    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.social.publish'),
      args: { url: 'https://example.test/webhook', content: 'hello' },
      realExecute: false,
      deps: {
        fetch: async () => { calls.push('called'); },
      },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'social-publish',
      plannedOnly: true,
      sideEffectPerformed: false,
      host: 'example.test',
    });
    expect(out.wouldPostBytes).toBeGreaterThan(0);
    expect(calls).toHaveLength(0);
  });

  it('opens browser URLs through the system open command without reading cookies', async () => {
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.browser.open'),
      args: { url: 'https://example.test/account' },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'browser-open',
      host: 'example.test',
      browserOpenAttempted: true,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
    });
    expect(calls).toEqual([
      { command: 'open', args: ['https://example.test/account'] },
    ]);
  });

  it('can target a specific Chrome-like browser app when opening creator pages', async () => {
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.browser.open'),
      args: { url: 'https://creator.xiaohongshu.com/', browserApp: 'Google Chrome' },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'browser-open',
      host: 'creator.xiaohongshu.com',
      browserApp: 'Google Chrome',
      browserOpenAttempted: true,
      desktopAutomationAttempted: true,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
    });
    expect(calls).toEqual([
      { command: 'open', args: ['-a', 'Google Chrome', 'https://creator.xiaohongshu.com/'] },
    ]);
  });

  it('keeps Safari browser open on AppleScript because open -a does not reliably set front document URL', async () => {
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.browser.open'),
      args: { url: 'https://example.test/', browserApp: 'Safari' },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'browser-open',
      host: 'example.test',
      browserApp: 'Safari',
      browserOpenAttempted: true,
      desktopAutomationAttempted: true,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
    });
    expect(calls[0].command).toBe('osascript');
    expect(calls[0].args[1]).toContain('tell application "Safari"');
    expect(calls[0].args[1]).not.toContain('document.cookie');
  });

  it('probes browser state through osascript without reading cookies or passwords', async () => {
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
          activeBrowser: { app: 'Google Chrome', url: 'https://example.test/dashboard?token=secret-value', title: 'Dashboard', frontmost: true, windowCount: 1 },
          browsers: [{ app: 'Google Chrome', url: 'https://example.test/dashboard?token=secret-value', title: 'Dashboard', frontmost: true, windowCount: 1 }],
          cookiesReadByNoe: false,
          passwordReadByNoe: false,
          pageContentReadByNoe: false,
        }));
        child.emit('close', 0, null);
      });
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.browser.state_probe'),
      args: { includeAll: true },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'browser-state-probe',
      frontmostApp: 'Google Chrome',
      activeBrowser: { app: 'Google Chrome', url: 'https://example.test/dashboard?token=%5Bredacted%5D', title: 'Dashboard' },
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false,
      stdoutReturned: false,
    });
    expect(JSON.stringify(out)).not.toContain('secret-value');
    expect(calls[0].command).toBe('osascript');
    expect(calls[0].args[0]).toBe('-l');
    expect(calls[0].args[1]).toBe('JavaScript');
    expect(calls[0].args[2]).toBe('-e');
    expect(calls[0].args[3]).toContain('cookiesReadByNoe: false');
  });

  it('dry-runs browser state probe without desktop automation', async () => {
    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.browser.state_probe'),
      args: {},
      realExecute: false,
      deps: { spawn: () => { throw new Error('should not spawn'); } },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'browser-state-probe',
      plannedOnly: true,
      desktopAutomationAttempted: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
    });
  });

  it('dry-runs browser DOM execution without spawning desktop automation', async () => {
    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.browser.dom.execute'),
      args: {
        browserApp: 'Google Chrome',
        actions: [{ type: 'set_value', selector: '#token', value: 'plain-dom-secret' }],
      },
      realExecute: false,
      deps: { spawn: () => { throw new Error('should not spawn'); } },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'browser-dom-execute',
      plannedOnly: true,
      browserApp: 'Google Chrome',
      actionCount: 1,
      desktopAutomationAttempted: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    });
    expect(out.argsPreview.actions[0]).toMatchObject({
      type: 'set_value',
      selector: '#token',
      value: '[redacted]',
    });
    expect(JSON.stringify(out)).not.toContain('plain-dom-secret');
  });

  it('L1/L2：read_body 真读正文 → pageContentReadByNoe:true + extractedText 透传（治"只开不读"空转）', async () => {
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({
          ok: true,
          browserApp: 'Google Chrome',
          pageResult: JSON.stringify({
            ok: true,
            host: 'github.com',
            url: 'https://github.com/topics/llm-agent',
            title: 'llm-agent · GitHub Topics',
            expectedHosts: ['github.com'],
            actions: [
              { index: 0, type: 'read_title', ok: true, found: true },
              { index: 1, type: 'read_body', ok: true, found: true, contentRead: true, extractedText: 'LLM agents are systems that use language models to...', extractedLength: 1234 },
            ],
            cookiesReadByNoe: false,
            passwordReadByNoe: false,
            pageContentReadByNoe: true,
            secretValuesReturned: false,
          }),
        }));
        child.emit('close', 0, null);
      });
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.browser.dom.execute'),
      args: { browserApp: 'Google Chrome', actions: [{ type: 'read_title' }, { type: 'read_body' }], expectedHosts: ['github.com'] },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out.pageContentReadByNoe).toBe(true); // L2：真读了正文才 true（不再硬编码 false）
    const bodyAction = out.actions.find((a) => a.type === 'read_body');
    expect(bodyAction.contentRead).toBe(true);
    expect(bodyAction.extractedText).toContain('LLM agents'); // L1：正文透传给深思消费
  });

  it('executes browser DOM actions and returns sanitized action summaries', async () => {
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({
          ok: true,
          browserApp: 'Google Chrome',
          pageResult: JSON.stringify({
            ok: true,
            host: 'example.test',
            url: 'https://example.test/form?token=secret-value',
            title: 'Account Form',
            expectedHosts: ['example.test'],
            pageReadiness: {
              ok: true,
              hostMatched: true,
              expectedHosts: ['example.test'],
              targetSurface: 'creator_publish_editor',
              targetSurfaceReady: true,
              requiresLoginSession: true,
              loginSessionLikely: true,
              login: { passwordFieldPresent: false, loginPromptPresent: false },
              requiredRoles: ['read_title', 'content', 'final_publish'],
              foundRoles: ['read_title', 'content', 'final_publish'],
              missingRoles: [],
              fieldRoles: ['content'],
              clickableRoles: ['final_publish'],
              titleRead: true,
              secretValuesReturned: false,
            },
            actions: [
              { index: 0, type: 'read_title', ok: true, found: true },
              { index: 1, type: 'set_value', selector: '#token', ok: true, found: true, focused: true, valueSet: true },
              { index: 2, type: 'set_by_hints', role: 'content', ok: true, found: true, matchedByHints: true, focused: true, valueSet: true },
              { index: 3, type: 'click', selector: '#save', ok: true, found: true, clicked: true },
              { index: 4, type: 'probe_by_hints', role: 'final_publish', probeTarget: 'clickable', ok: true, found: true, matchedByHints: true, probed: true },
            ],
            cookiesReadByNoe: false,
            passwordReadByNoe: false,
            pageContentReadByNoe: false,
          }),
        }));
        child.emit('close', 0, null);
      });
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.browser.dom.execute'),
      args: {
        browserApp: 'Google Chrome',
        expectedHost: 'example.test',
        pageProbe: {
          expectedHosts: ['example.test'],
          requiresLoginSession: true,
          targetSurface: 'creator_publish_editor',
          requiredProbeRoles: ['read_title', 'content', 'final_publish'],
          fieldRoles: ['content'],
          clickableRoles: ['final_publish'],
        },
        actions: [
          { type: 'read_title' },
          { type: 'set_value', selector: '#token', value: 'plain-dom-secret' },
          { type: 'set_by_hints', role: 'content', hints: ['正文', 'content'], value: 'plain-dom-secret' },
          { type: 'click', selector: '#save' },
          { type: 'probe_by_hints', role: 'final_publish', probeTarget: 'clickable', hints: ['发布'] },
        ],
      },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'browser-dom-execute',
      browserApp: 'Google Chrome',
      host: 'example.test',
      urlPresent: true,
      urlSha256: expect.any(String),
      titlePresent: true,
      titleSha256: expect.any(String),
      expectedHosts: ['example.test'],
      pageReadiness: {
        ok: true,
        hostMatched: true,
        targetSurfaceReady: true,
        loginSessionLikely: true,
        missingRoles: [],
      },
      actionCount: 5,
      desktopAutomationAttempted: true,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false,
    });
    expect(JSON.stringify(out)).not.toContain('https://example.test/form');
    expect(JSON.stringify(out)).not.toContain('Account Form');
    expect(out.actions[1]).toMatchObject({
      type: 'set_value',
      selector: '#token',
      found: true,
      focused: true,
      valueSet: true,
    });
    expect(out.actions[2]).toMatchObject({
      type: 'set_by_hints',
      role: 'content',
      found: true,
      matchedByHints: true,
      valueSet: true,
    });
    expect(out.actions[3]).toMatchObject({
      type: 'click',
      selector: '#save',
      clicked: true,
    });
    expect(out.actions[4]).toMatchObject({
      type: 'probe_by_hints',
      role: 'final_publish',
      probeTarget: 'clickable',
      found: true,
      matchedByHints: true,
      probed: true,
      clicked: false,
      valueSet: false,
    });
    expect(JSON.stringify(out)).not.toContain('plain-dom-secret');
    expect(JSON.stringify(out)).not.toContain('secret-value');
    expect(calls[0].command).toBe('osascript');
    expect(calls[0].args[0]).toBe('-l');
    expect(calls[0].args[1]).toBe('JavaScript');
    expect(calls[0].args[3]).toContain('findChromeLikeTab');
    expect(calls[0].args[3]).toContain('matchesExpectedHost');
    expect(calls[0].args[3]).toContain('const allowTabSearch = false');
    expect(calls[0].args[3]).toContain('"example.test"');
    expect(calls[0].args[3]).not.toContain('document.cookie');
  });

  it('allows expected URL prefix tab search only when the DOM action is explicitly URL-bound', async () => {
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({
          ok: true,
          browserApp: 'Google Chrome',
          pageResult: JSON.stringify({
            ok: true,
            host: 'creator.xiaohongshu.com',
            url: 'https://creator.xiaohongshu.com/publish/post',
            title: 'XHS Editor',
            expectedHosts: ['creator.xiaohongshu.com'],
            expectedUrlPrefixes: ['https://creator.xiaohongshu.com/publish/post'],
            actions: [{ index: 0, type: 'probe_by_hints', role: 'content', ok: true, found: true, probed: true }],
            cookiesReadByNoe: false,
            passwordReadByNoe: false,
            pageContentReadByNoe: false,
          }),
        }));
        child.emit('close', 0, null);
      });
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.browser.dom.execute'),
      args: {
        browserApp: 'Google Chrome',
        expectedHosts: ['creator.xiaohongshu.com'],
        expectedUrlPrefixes: ['https://creator.xiaohongshu.com/publish/post'],
        actions: [{ type: 'probe_by_hints', role: 'content', hints: ['正文'] }],
      },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out).toMatchObject({
      ok: true,
      host: 'creator.xiaohongshu.com',
      expectedUrlPrefixes: ['https://creator.xiaohongshu.com/publish/post'],
    });
    expect(calls[0].args[3]).toContain('const allowTabSearch = true');
    expect(calls[0].args[3]).toContain('"https://creator.xiaohongshu.com/publish/post"');
  });

  it('surfaces browser DOM host mismatch as a failed runtime result', async () => {
    const fakeSpawn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({
          ok: true,
          browserApp: 'Google Chrome',
          pageResult: JSON.stringify({
            ok: false,
            error: 'browser_dom_host_mismatch',
            host: 'wrong.example.test',
            url: 'https://wrong.example.test/',
            title: 'Wrong Page',
            actions: [],
            cookiesReadByNoe: false,
            passwordReadByNoe: false,
            pageContentReadByNoe: false,
          }),
        }));
        child.emit('close', 0, null);
      });
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.browser.dom.execute'),
      args: {
        browserApp: 'Google Chrome',
        expectedHost: 'example.test',
        actions: [{ type: 'click', selector: '#publish' }],
      },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out).toMatchObject({
      ok: false,
      adapter: 'browser-dom-execute',
      error: 'browser_dom_host_mismatch',
      host: 'wrong.example.test',
      desktopAutomationAttempted: true,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    });
  });

  it('builds account connection inventory without reading cookies, passwords, or page content', async () => {
    const calls = [];
    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.account.connection_inventory'),
      args: {
        platforms: ['douyin'],
        browserState: {
          activeBrowser: {
            app: 'Google Chrome',
            url: 'https://creator.douyin.com/?token=secret-value',
            title: 'Douyin Creator',
          },
        },
      },
      realExecute: true,
      deps: {
        spawn: () => { calls.push('spawned'); },
        fetch: async () => { calls.push('fetched'); },
      },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'account-connection-inventory',
      realExecute: true,
      externalSideEffectPerformed: false,
      publishPerformed: false,
      secretValuesReturned: false,
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
    });
    expect(out.connections[0]).toMatchObject({
      platform: 'douyin',
      status: 'active_browser_match',
      browser: { host: 'creator.douyin.com' },
    });
    expect(out.connections[0].actionChain.map((item) => item.actionId)).toContain('noe.freedom.social.final_publish.execute');
    expect(out.browserStateAutoProbe).toMatchObject({
      attempted: false,
      used: false,
      source: 'provided',
      provided: true,
    });
    expect(JSON.stringify(out)).not.toContain('secret-value');
    expect(calls).toHaveLength(0);
  });

  it('auto-probes browser state for account inventory real execution when no browser state is supplied', async () => {
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
          activeBrowser: {
            app: 'Google Chrome',
            url: 'https://creator.douyin.com/creator-micro/content/upload?token=secret-value',
            title: '发布作品 - 抖音创作者中心',
            frontmost: true,
            windowCount: 1,
          },
          browsers: [{
            app: 'Google Chrome',
            url: 'https://creator.douyin.com/creator-micro/content/upload?token=secret-value',
            title: '发布作品 - 抖音创作者中心',
            frontmost: true,
            windowCount: 1,
          }],
          cookiesReadByNoe: false,
          passwordReadByNoe: false,
          pageContentReadByNoe: false,
        }));
        child.emit('close', 0, null);
      });
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.account.connection_inventory'),
      args: {
        platforms: ['douyin'],
        draftId: 'draft-1',
        title: '测试标题',
        content: '测试内容',
      },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'account-connection-inventory',
      realExecute: true,
      browserStateAutoProbe: {
        attempted: true,
        used: true,
        source: 'noe.freedom.browser.state_probe',
        provided: false,
      },
    });
    expect(out.connections[0]).toMatchObject({
      platform: 'douyin',
      status: 'active_browser_match',
      activePage: { stage: 'publish_editor' },
    });
    expect(out.recommendedNextFreedomActions.map((item) => item.actionId)).toEqual(expect.arrayContaining([
      'noe.freedom.social.publish_orchestrate',
      'noe.freedom.social.preflight.run',
      'noe.freedom.social.form_fill.plan',
    ]));
    expect(out.browserStateAutoProbe.probe).toMatchObject({
      ok: true,
      activeBrowser: {
        app: 'Google Chrome',
        url: 'https://creator.douyin.com/creator-micro/content/upload?token=%5Bredacted%5D',
      },
      cookiesReadByNoe: false,
      passwordReadByNoe: false,
      pageContentReadByNoe: false,
      secretValuesReturned: false,
    });
    expect(JSON.stringify(out)).not.toContain('secret-value');
    expect(calls[0].command).toBe('osascript');
  });

  it('keeps account inventory usable when automatic browser probing fails', async () => {
    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.account.connection_inventory'),
      args: { platforms: ['douyin'] },
      realExecute: true,
      deps: {
        spawn: () => {
          const child = new EventEmitter();
          child.stdout = new EventEmitter();
          child.stderr = new EventEmitter();
          queueMicrotask(() => {
            child.stderr.emit('data', 'automation denied with token=secret-value');
            child.emit('close', 1, null);
          });
          return child;
        },
      },
    });

    expect(out.ok).toBe(true);
    expect(out.browserStateAutoProbe).toMatchObject({
      attempted: true,
      used: false,
      source: 'none',
      provided: false,
    });
    expect(out.warnings.join('\n')).toContain('browser_state_auto_probe_unavailable');
    expect(out.connections[0]).toMatchObject({
      platform: 'douyin',
      status: 'known_platform',
    });
    expect(JSON.stringify(out)).not.toContain('secret-value');
  });

  it('audits developer readiness across browser accounts, ssh, marketplace, desktop, and keychain refs without exposing secrets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-readiness-audit-root-'));
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'noe-readiness-audit-marketplace-'));
    const desktopDir = mkdtempSync(join(tmpdir(), 'noe-readiness-audit-desktop-'));
    const sshConfigPath = join(root, 'ssh_config');
    writeFileSync(sshConfigPath, 'Host demo\n  HostName example.test\n  User neo\n', 'utf8');
    writeFileSync(join(desktopDir, 'clip.mp4'), 'media-bytes', 'utf8');
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
          activeBrowser: { app: 'Google Chrome', running: true, frontmost: true, url: 'https://creator.douyin.com/?token=secret-value', title: 'Douyin', windowCount: 1 },
          browsers: [{ app: 'Google Chrome', running: true, frontmost: true, url: 'https://creator.douyin.com/?token=secret-value', title: 'Douyin', windowCount: 1 }],
          cookiesReadByNoe: false,
          passwordReadByNoe: false,
          pageContentReadByNoe: false,
        }));
        child.emit('close', 0, null);
      });
      return child;
    };
    try {
      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.developer.readiness_audit'),
        root,
        args: {
          platforms: ['douyin', 'xiaohongshu'],
          marketplaceDir,
          desktopPath: desktopDir,
          sshConfigPath,
          includeProviderSecrets: true,
          includeProviderHealth: true,
          providerSecrets: ['minimax', 'xiaomi', 'gemini'],
          keychainRefs: [{ account: 'MIMO_API_KEY' }],
        },
        realExecute: true,
        deps: {
          spawn: fakeSpawn,
          env: {
            MINIMAX_API_KEY: 'sk-unitsecret-minimax-readiness-000000000000000000',
          },
          providerKeychainReader: ({ account }) => account === 'MIMO_API_KEY'
            ? { ok: true, value: 'tp-unitsecret-xiaomi-readiness-000000000000000000' }
            : { ok: false, error: 'not found secret-value' },
          providerSecretResolver: (provider) => ({
            ok: true,
            provider,
            value: `fake-${provider}-unitsecret-readiness-000000000000000000`,
            source: 'unit',
            sourceRef: `${provider}_unit`,
          }),
          providerFetch: async () => ({
            status: 200,
            text: async () => JSON.stringify({ data: [{ id: 'MiniMax-M3' }, { id: 'mimo-v2.5-pro' }] }),
          }),
          commandResolver: (command) => ({ ok: true, command, path: `/usr/local/bin/${command}`, status: 'available' }),
          roomConfigLoader: () => ({
            gemini: { apiKey: 'fake-gemini-unitsecret-readiness-000000000000000000' },
          }),
          marketplaceDir,
          secretBroker: {
            readKeychainMetadata: ({ account }) => ({
              ok: true,
              account,
              source: 'keychain',
              secretRef: `keychain:test:${account}`,
              value: '[redacted]',
              secretValuesReturned: false,
            }),
          },
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'developer-readiness-audit',
        realExecute: true,
        secretValuesReturned: false,
        cookiesReadByNoe: false,
        passwordReadByNoe: false,
        pageContentReadByNoe: false,
        externalSideEffectPerformed: false,
        publishPerformed: false,
        authority: {
          canUseLoggedInAccounts: true,
          canReadSecrets: false,
          canPublishExternally: false,
          bypassesNoeGovernance: false,
          readinessOnly: true,
        },
      });
      expect(out.accounts.connections[0]).toMatchObject({
        platform: 'douyin',
        status: 'active_browser_match',
      });
      expect(out.summary.activeLoggedInPlatforms).toContain('douyin');
      expect(out.summary.sshHostCount).toBe(1);
      expect(out.summary.secretRefCount).toBe(1);
      expect(out.summary.providerSecretConfiguredCount).toBe(3);
      expect(out.summary.providerSecretsConfigured).toEqual(['minimax', 'xiaomi', 'gemini']);
      expect(out.summary.providerHealthReachableCount).toBe(3);
      expect(out.summary.providerHealthAuthOkCount).toBe(3);
      expect(out.summary.onlineModelAvailableCount).toBe(3);
      expect(out.summary.onlineModelThreshold).toBe(2);
      expect(out.summary.onlineModelAvailable).toEqual(['codex', 'claude', 'm3']);
      expect(out.summary.desktopEntryCount).toBe(1);
      expect(out.onlineModelRoster).toMatchObject({
        ok: true,
        availableCount: 3,
        threshold: 2,
        codexFallbackPolicy: { countedInConsensus: false },
      });
      expect(out.providerSecrets).toMatchObject({
        ok: true,
        adapter: 'provider-secret-readiness',
        configuredCount: 3,
        secretValuesReturned: false,
      });
      expect(out.providerHealth).toMatchObject({
        ok: true,
        adapter: 'provider-health-readiness',
        authOkCount: 3,
        secretValuesReturned: false,
      });
      expect(out.nextFreedomActions.map((item) => item.actionId)).toContain('noe.freedom.developer.readiness_audit');
      expect(out.nextFreedomActions.map((item) => item.actionId)).toContain('noe.freedom.browser.open');
      expect(JSON.stringify(out)).not.toContain('secret-value');
      expect(JSON.stringify(out)).not.toContain('unitsecret');
      expect(JSON.stringify(out)).not.toContain('media-bytes');
      expect(calls[0].command).toBe('osascript');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(marketplaceDir, { recursive: true, force: true });
      rmSync(desktopDir, { recursive: true, force: true });
    }
  });

  it('dry-runs developer readiness audit without desktop automation or secret access', async () => {
    const calls = [];
    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.developer.readiness_audit'),
      args: {
        platforms: 'douyin,xiaohongshu',
        keychainRefs: ['MIMO_API_KEY'],
      },
      realExecute: false,
      deps: {
        spawn: () => { calls.push('spawned'); },
        secretBroker: { readKeychainMetadata: () => { throw new Error('should not read keychain'); } },
      },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'developer-readiness-audit',
      plannedOnly: true,
      externalSideEffectPerformed: false,
      publishPerformed: false,
      secretValuesReturned: false,
      checks: {
        browserState: true,
        accountConnections: true,
        providerSecrets: ['minimax', 'xiaomi', 'gemini', 'openai', 'anthropic'],
        providerHealth: [],
        keychainRefs: 1,
      },
    });
    expect(out.platforms).toEqual(['douyin', 'xiaohongshu']);
    expect(calls).toHaveLength(0);
  });

  it('suggests provider key setup and health probe next actions when model providers are missing', async () => {
    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.developer.readiness_audit'),
      args: {
        platforms: [],
        includeBrowserState: false,
        includeSshInventory: false,
        includeMarketplace: false,
        includeDesktop: false,
        includeProviderSecrets: true,
        includeProviderHealth: false,
        providerSecrets: ['minimax', 'gemini'],
        keychainRefs: [],
      },
      realExecute: true,
      deps: {
        env: {},
        providerKeychainReader: () => ({ ok: false, error: 'not found fake-unitsecret' }),
        roomConfigLoader: () => ({}),
        commandResolver: (command) => command === 'codex'
          ? { ok: true, command, path: '/usr/local/bin/codex', status: 'available' }
          : { ok: false, command, path: '', status: 'command_not_found' },
        secretBroker: { readKeychainMetadata: () => { throw new Error('should not read keychain refs'); } },
      },
    });

    expect(out.summary.providerSecretsMissing).toEqual(['minimax', 'gemini']);
    expect(out.onlineModelRoster.ok).toBe(false);
    expect(out.summary.onlineModelAvailable).toEqual(['codex']);
    expect(out.nextFreedomActions.map((item) => item.stepId)).toEqual(expect.arrayContaining([
      'probe_model_provider_health',
      'setup_missing_model_provider_keys',
      'repair_online_model_roster',
    ]));
    const setup = out.nextFreedomActions.find((item) => item.stepId === 'setup_missing_model_provider_keys');
    expect(setup).toMatchObject({
      actionId: 'noe.freedom.shell.execute',
      mode: 'developer_unrestricted',
      args: {
        command: 'npm run noe:keys:model:setup',
        cwd: '.',
        missingProviders: ['minimax', 'gemini'],
      },
    });
    const probe = out.nextFreedomActions.find((item) => item.stepId === 'probe_model_provider_health');
    expect(probe).toMatchObject({
      actionId: 'noe.freedom.developer.readiness_audit',
      args: {
        includeProviderHealth: true,
        providers: ['minimax', 'gemini'],
      },
    });
    expect(JSON.stringify(out)).not.toContain('unitsecret');
  });

  it('lists Freedom run history and generates resume actions without exposing next action args', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-freedom-run-history-adapter-'));
    try {
      writeNoeFreedomRunLedgerFile({
        root,
        runId: 'history-source',
        result: {
          id: 'history-source',
          ok: true,
          dryRunOnly: true,
          realExecute: false,
          tool: {
            id: 'noe.freedom.social.publish_orchestrate',
            operation: 'noe.freedom.social.publish_orchestrate',
            capability: 'social.publish_orchestrate',
            riskLevel: 'high',
          },
          authorization: { mode: 'dry_run', ownerPresent: false },
          trust: null,
          allowlist: null,
          argsPreview: { content: 'hello' },
          blockers: [],
          warnings: [],
          runtime: {
            ok: true,
            secretValuesReturned: false,
            nextFreedomActions: [
              {
                stepId: 'final_publish',
                title: 'Final publish',
                actionId: 'noe.freedom.social.final_publish.execute',
                mode: 'developer_unrestricted',
                args: { draftId: 'draft-1', token: 'tp-unitsecret000000000000000000000000000000' },
              },
            ],
          },
          rollback: { strategy: 'none' },
          evidence: { sha256: 'b'.repeat(64), dryRunOnly: true, refs: {} },
        },
      });

      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.run.history'),
        root,
        args: { limit: 5, requireOk: true },
        realExecute: true,
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'freedom-run-history',
        returned: 1,
        secretValuesReturned: false,
        sideEffectPerformed: false,
      });
      expect(out.items[0]).toMatchObject({
        ref: 'output/noe-freedom-runs/history-source/ledger.json',
        resumeCandidate: true,
        nextFreedomActions: [
          {
            stepId: 'final_publish',
            actionId: 'noe.freedom.social.final_publish.execute',
          },
        ],
      });
      expect(out.nextFreedomActions[0]).toMatchObject({
        actionId: 'noe.freedom.run.resume_next_actions',
        args: {
          ledgerRef: 'output/noe-freedom-runs/history-source/ledger.json',
          stopOnError: true,
          persistChildLedgers: true,
        },
      });
      expect(JSON.stringify(out)).not.toContain('tp-unitsecret');
      expect(JSON.stringify(out.items[0].nextFreedomActions[0])).not.toContain('draft-1');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dry-runs Freedom run history without reading ledger files', async () => {
    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.run.history'),
      args: { limit: 3, onlyWithNextActions: true },
      realExecute: false,
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'freedom-run-history',
      plannedOnly: true,
      wouldReadFreedomRunLedgers: true,
      onlyWithNextActions: true,
      secretValuesReturned: false,
    });
  });

  it('runs macOS automation through osascript with selected language', async () => {
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', 'ok\n');
        child.emit('close', 0, null);
      });
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.macos.applescript.run'),
      args: { language: 'jxa', script: 'Application.currentApplication().name()' },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'macos-applescript',
      language: 'JavaScript',
      desktopAutomationAttempted: true,
      secretValuesReturned: false,
      stdout: 'ok',
    });
    expect(calls).toEqual([
      { command: 'osascript', args: ['-l', 'JavaScript', '-e', 'Application.currentApplication().name()'] },
    ]);
  });

  it('creates, lists, and cancels social drafts without calling external providers', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-draft-adapter-'));
    const calls = [];
    try {
      const created = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.draft.create'),
        args: { id: 'draft-1', draftDir, platform: 'x', content: 'hello' },
        realExecute: true,
        deps: { fetch: async () => { calls.push('called'); } },
      });
      expect(created).toMatchObject({ ok: true, adapter: 'social-draft-create', state: 'draft', externalSideEffectPerformed: false });

      const listed = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.draft.list'),
        args: { draftDir },
        realExecute: true,
      });
      expect(listed.drafts).toEqual([
        expect.objectContaining({ id: 'draft-1', state: 'draft', externalSideEffectPerformed: false }),
      ]);

      const cancelled = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.draft.cancel'),
        args: { id: 'draft-1', draftDir },
        realExecute: true,
      });
      expect(cancelled).toMatchObject({ ok: true, adapter: 'social-draft-cancel', state: 'cancelled' });
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('prepares a social publishing workflow through the freedom adapter', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-workflow-adapter-'));
    try {
      const dryRun = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.workflow.prepare'),
        args: { id: 'adapter-dry-run', draftDir, platform: 'douyin', content: 'hello' },
        realExecute: false,
      });

      expect(dryRun).toMatchObject({
        ok: true,
        adapter: 'social-workflow-prepare',
        plannedOnly: true,
        platform: 'douyin',
        creatorHost: 'creator.douyin.com',
        externalSideEffectPerformed: false,
      });
      expect(dryRun.nextFreedomActions.map((action) => action.actionId)).toContain('noe.freedom.social.draft.create');

      const executed = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.workflow.prepare'),
        args: {
          id: 'adapter-real',
          draftDir,
          platform: 'xiaohongshu',
          title: 'note',
          content: 'draft with tp-unitsecret000000000000000000000000000000',
        },
        realExecute: true,
      });

      expect(executed).toMatchObject({
        ok: true,
        adapter: 'social-workflow-prepare',
        plannedOnly: false,
        draftWritten: true,
        externalSideEffectPerformed: false,
        publishPerformed: false,
      });
      const draft = readFileSync(join(draftDir, executed.draft.ref), 'utf8');
      expect(draft).not.toContain('tp-unitsecret');
      expect(JSON.stringify(executed)).not.toContain('tp-unitsecret');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('orchestrates the social publish workflow through the freedom adapter without final publishing', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-orchestrator-adapter-drafts-'));
    const calls = [];
    try {
      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.publish_orchestrate'),
        args: {
          id: 'adapter-orchestrated',
          draftDir,
          platform: 'douyin',
          title: 'ready title',
          content: 'ready content',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/?token=secret-value', title: 'Douyin' } },
        },
        realExecute: true,
        deps: {
          spawn: () => { calls.push('spawned'); },
          fetch: async () => { calls.push('fetched'); },
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-publish-orchestrator',
        plannedOnly: false,
        workflow: {
          draftWritten: true,
          publishPerformed: false,
        },
        externalSideEffectPerformed: true,
        publishPerformed: false,
        secretValuesReturned: false,
      });
      expect(out.nextFreedomActions.map((item) => item.actionId)).toContain('noe.freedom.social.final_publish.execute');
      expect(JSON.stringify(out)).not.toContain('secret-value');
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('runs social publish preflight through the freedom adapter without final publishing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-preflight-adapter-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-preflight-adapter-drafts-'));
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.draft.create'),
        args: {
          id: 'adapter-preflight',
          draftDir,
          platform: 'douyin',
          content: 'ready content',
          metadata: { mediaFiles: ['clips/demo.mp4'] },
        },
        realExecute: true,
      });

      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.preflight.run'),
        root,
        args: {
          draftDir,
          draftId: 'adapter-preflight',
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        realExecute: true,
        deps: { fetch: async () => { throw new Error('should not publish'); } },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-publish-preflight',
        plannedOnly: false,
        publishPerformed: false,
        externalSideEffectPerformed: false,
        readiness: { readyForAutomation: true, finalPublishAllowedByThisTool: false },
      });
      expect(out.media.files[0]).toMatchObject({ ref: 'clips/demo.mp4', contentRead: false });
      expect(out.nextFreedomActions.map((action) => action.actionId)).toContain('noe.freedom.macos.applescript.run');
      expect(JSON.stringify(out)).not.toContain('video-bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('builds social form-fill scripts through the freedom adapter without executing them', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-adapter-drafts-'));
    try {
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.draft.create'),
        args: {
          id: 'adapter-form-fill',
          draftDir,
          platform: 'douyin',
          content: 'ready content',
          metadata: { title: 'ready title', mediaFiles: ['clips/demo.mp4'] },
        },
        realExecute: true,
      });

      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.form_fill.plan'),
        args: {
          draftDir,
          draftId: 'adapter-form-fill',
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        realExecute: true,
        deps: { spawn: () => { throw new Error('should not run osascript'); } },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-form-fill-plan',
        plannedOnly: false,
        publishPerformed: false,
        externalSideEffectPerformed: false,
        automation: {
          scriptGenerated: true,
          finalButtonClicked: false,
          formSubmitted: false,
        },
      });
      expect(out.nextFreedomActions).toEqual([
        expect.objectContaining({
          actionId: 'noe.freedom.macos.applescript.run',
          args: expect.objectContaining({ language: 'jxa' }),
        }),
      ]);
      expect(out.nextFreedomActions[0].args.script).toContain('tab.execute');
      expect(out.nextFreedomActions[0].args.script).not.toContain('.click(');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('executes controlled social form-fill scripts through the freedom adapter', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-form-fill-execute-adapter-drafts-'));
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({
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
        }));
        child.emit('close', 0, null);
      });
      return child;
    };
    try {
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.draft.create'),
        args: {
          id: 'adapter-form-fill-execute',
          draftDir,
          platform: 'douyin',
          content: 'ready content',
          metadata: { title: 'ready title' },
        },
        realExecute: true,
      });

      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.form_fill.execute'),
        args: {
          draftDir,
          draftId: 'adapter-form-fill-execute',
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        realExecute: true,
        deps: { spawn: fakeSpawn },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-form-fill-execute',
        executionAttempted: true,
        publishPerformed: false,
        externalSideEffectPerformed: false,
        execution: {
          command: 'osascript',
          browser: { result: { titleFilled: true, contentFilled: true, titleEchoMatched: true, contentEchoMatched: true, sameField: false } },
          finalButtonClicked: false,
          formSubmitted: false,
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('osascript');
      expect(calls[0].args[3]).not.toContain('.click(');
      expect(calls[0].args[3]).not.toContain('.submit(');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('prepares social media upload selector probes through the freedom adapter', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-adapter-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-adapter-drafts-'));
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.draft.create'),
        args: {
          id: 'adapter-media-upload',
          draftDir,
          platform: 'douyin',
          content: 'ready content',
          metadata: { title: 'ready title', mediaFiles: ['clips/demo.mp4'] },
        },
        realExecute: true,
      });

      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.media_upload.prepare'),
        root,
        args: {
          draftDir,
          draftId: 'adapter-media-upload',
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        realExecute: true,
        deps: { spawn: () => { throw new Error('should not run osascript'); } },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-media-upload-plan',
        plannedOnly: false,
        fileContentRead: false,
        publishPerformed: false,
        externalSideEffectPerformed: false,
        selectorProbe: {
          scriptGenerated: true,
          fileSelected: false,
          uploadStarted: false,
          finalButtonClicked: false,
          formSubmitted: false,
        },
      });
      expect(out.nextFreedomActions).toEqual([
        expect.objectContaining({
          actionId: 'noe.freedom.macos.applescript.run',
          args: expect.objectContaining({ language: 'jxa' }),
        }),
      ]);
      expect(out.nextFreedomActions[0].args.script).toContain('input[type=\\\"file\\\"]');
      expect(out.nextFreedomActions[0].args.script).not.toContain('.click(');
      expect(out.nextFreedomActions[0].args.script).not.toContain('files =');
      expect(JSON.stringify(out)).not.toContain('video-bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('executes controlled social media upload through the freedom adapter without publishing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-adapter-root-'));
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-media-upload-exec-adapter-drafts-'));
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({
          ok: true,
          app: 'Google Chrome',
          result: { ok: true, host: 'creator.douyin.com', targetType: 'file_input', clickedUploadControl: true },
          verification: { selectedFileCount: 1 },
          mediaDialogAttempted: true,
          fileSelected: true,
          uploadStarted: true,
          finalButtonClicked: false,
          formSubmitted: false,
        }));
        child.emit('close', 0, null);
      });
      return child;
    };
    try {
      mkdirSync(join(root, 'clips'));
      writeFileSync(join(root, 'clips', 'demo.mp4'), 'video-bytes', 'utf8');
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.draft.create'),
        args: {
          id: 'adapter-media-upload-execute',
          draftDir,
          platform: 'douyin',
          content: 'ready content',
          metadata: { title: 'ready title', mediaFiles: ['clips/demo.mp4'] },
        },
        realExecute: true,
      });

      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.media_upload.execute'),
        root,
        args: {
          draftDir,
          draftId: 'adapter-media-upload-execute',
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
        },
        realExecute: true,
        deps: { spawn: fakeSpawn },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-media-upload-execute',
        mediaSelectionAttempted: true,
        externalSideEffectPerformed: true,
        publishPerformed: false,
        execution: {
          command: 'osascript',
          fileSelected: true,
          uploadStarted: true,
          finalButtonClicked: false,
          formSubmitted: false,
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('osascript');
      expect(calls[0].args[3]).toContain('clickPoint');
      expect(calls[0].args[3]).toContain('command -v cliclick');
      expect(calls[0].args[3]).toContain("doShellScript(cliclickPath + ' c:'");
      expect(calls[0].args[3]).toContain('setTheClipboardTo(mediaFilePath)');
      expect(calls[0].args[3]).not.toContain('fileInput.click()');
      expect(calls[0].args[3]).not.toContain('.submit(');
      expect(calls[0].args[3]).not.toContain('requestSubmit(');
      expect(JSON.stringify(out)).not.toContain('video-bytes');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('executes controlled social final publish through the freedom adapter with rollback evidence', async () => {
    const draftDir = mkdtempSync(join(tmpdir(), 'noe-social-final-publish-adapter-drafts-'));
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stdout.emit('data', JSON.stringify({
          ok: true,
          app: 'Google Chrome',
          result: {
            ok: true,
            host: 'creator.douyin.com',
            selector: 'button.publish',
            clickedLabel: '发布',
            finalButtonClicked: true,
            formSubmitted: false,
            pageContentReadByNoe: false,
          },
          postPublishProbe: {
            ok: true,
            url: 'https://creator.douyin.com/published/adapter',
            title: 'Douyin Creator Center',
            finalButtonClicked: false,
            formSubmitted: false,
          },
          publishPerformed: true,
          finalButtonClicked: true,
          formSubmitted: false,
          pageContentReadByNoe: false,
        }));
        child.emit('close', 0, null);
      });
      return child;
    };
    try {
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.draft.create'),
        args: {
          id: 'adapter-final-publish',
          draftDir,
          platform: 'douyin',
          content: 'ready content',
          metadata: { title: 'ready title', mediaFiles: ['clips/demo.mp4'] },
        },
        realExecute: true,
      });

      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.social.final_publish.execute'),
        args: {
          draftDir,
          draftId: 'adapter-final-publish',
          platform: 'douyin',
          browserState: { activeBrowser: { url: 'https://creator.douyin.com/', title: 'Douyin' } },
          priorStageEvidence: {
            ok: true,
            stageCount: 2,
            completedStages: ['form_fill_execute', 'media_upload_execute'],
          },
        },
        realExecute: true,
        deps: { spawn: fakeSpawn },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'social-final-publish-execute',
        executionAttempted: true,
        externalSideEffectPerformed: true,
        publishPerformed: true,
        execution: {
          command: 'osascript',
          publishPerformed: true,
          finalButtonClicked: true,
          formSubmitted: false,
          pageContentReadByNoe: false,
        },
        rollbackEvidence: {
          requiredAfterPublish: true,
          postUrlRef: 'https://creator.douyin.com/published/adapter',
          verifiedByNoe: true,
        },
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].command).toBe('osascript');
      expect(calls[0].args[3]).toContain('.click()');
      expect(calls[0].args[3]).not.toContain('.submit(');
      expect(calls[0].args[3]).not.toContain('requestSubmit(');
    } finally {
      rmSync(draftDir, { recursive: true, force: true });
    }
  });

  it('moves local files to trash through the file delete adapter', async () => {
    const root = mkdtempSync(join(homedir(), 'noe-file-delete-adapter-'));
    const calls = [];
    try {
      writeFileSync(join(root, 'obsolete.txt'), 'remove me');
      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.file.delete'),
        args: { path: 'obsolete.txt' },
        root,
        realExecute: true,
        deps: {
          trasher: async (absPath) => {
            calls.push(absPath);
            return { trashed: true, src: absPath };
          },
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'file-delete',
        trashed: true,
        realFileDeletePerformed: true,
        fileDeletedToTrash: true,
        sideEffectPerformed: true,
        rollbackExpectation: 'finder_put_back_from_trash',
        secretValuesReturned: false,
      });
      expect(calls).toEqual([join(root, 'obsolete.txt')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks protected system paths in the file delete adapter before trashing', async () => {
    const calls = [];
    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.file.delete'),
      args: { path: '/System' },
      realExecute: true,
      deps: {
        trasher: async (absPath) => {
          calls.push(absPath);
          return { trashed: true, src: absPath };
        },
      },
    });

    expect(out).toMatchObject({
      ok: false,
      adapter: 'file-delete',
      trashed: false,
      realFileDeletePerformed: false,
      fileDeletedToTrash: false,
      sideEffectPerformed: false,
    });
    expect(out.blockers).toContain('file_delete_failed:system-path');
    expect(calls).toHaveLength(0);
  });

  it('uploads referenced file bytes without returning file content', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-upload-adapter-'));
    try {
      const file = join(root, 'payload.txt');
      writeFileSync(file, 'upload-file-content', 'utf8');
      const calls = [];
      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.network.upload'),
        args: { url: 'https://example.test/upload', filePath: 'payload.txt', contentType: 'text/plain' },
        root,
        realExecute: true,
        deps: {
          fetch: async (url, init) => {
            calls.push({ url, init });
            return { ok: true, status: 201, text: async () => 'created' };
          },
        },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'network-upload',
        status: 201,
        fileUploaded: true,
        fileRef: 'payload.txt',
        fileBytes: Buffer.byteLength('upload-file-content'),
        fileContentReturned: false,
      });
      expect(calls[0].init.body.toString()).toBe('upload-file-content');
      expect(calls[0].init.headers['content-type']).toBe('text/plain');
      expect(JSON.stringify(out)).not.toContain('upload-file-content');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks network upload paths outside the execution root before reading or fetching', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-upload-adapter-root-'));
    const outside = mkdtempSync(join(tmpdir(), 'noe-upload-adapter-outside-'));
    try {
      const outsideFile = join(outside, 'payload.txt');
      writeFileSync(outsideFile, 'outside-content', 'utf8');
      const calls = [];
      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.network.upload'),
        args: { url: 'https://example.test/upload', filePath: outsideFile, contentType: 'text/plain' },
        root,
        realExecute: true,
        deps: {
          fetch: async () => {
            calls.push('called');
            return { ok: true, status: 201, text: async () => 'created' };
          },
        },
      });

      expect(out).toMatchObject({
        ok: false,
        adapter: 'network-upload',
        error: 'upload_file_path_outside_root',
      });
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('blocks secret-like network upload paths before reading or fetching', async () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-upload-adapter-secret-'));
    try {
      writeFileSync(join(root, '.env'), 'TOKEN=secret', 'utf8');
      const calls = [];
      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.network.upload'),
        args: { url: 'https://example.test/upload', filePath: '.env', contentType: 'text/plain' },
        root,
        realExecute: true,
        deps: {
          fetch: async () => {
            calls.push('called');
            return { ok: true, status: 201, text: async () => 'created' };
          },
        },
      });

      expect(out).toMatchObject({
        ok: false,
        adapter: 'network-upload',
        error: 'upload_secret_path_blocked',
        filePath: '.env',
      });
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('builds an SSH dry-run without spawning ssh or allowing password prompts', async () => {
    const calls = [];
    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.ssh.execute'),
      args: { host: 'demo-host', command: 'uptime' },
      realExecute: false,
      deps: {
        spawn: () => { calls.push('called'); },
      },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'ssh',
      plannedOnly: true,
      networkConnectionAttempted: false,
      passwordPromptAllowed: false,
      host: 'demo-host',
    });
    expect(calls).toHaveLength(0);
  });

  it('runs SSH through system ssh in batch mode without exposing private keys to Noe', async () => {
    const calls = [];
    const fakeSpawn = (command, args) => {
      calls.push({ command, args });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };

    const out = await runNoeFreedomAdapter({
      tool: tool('noe.freedom.ssh.execute'),
      args: { host: 'demo-host', command: 'uptime' },
      realExecute: true,
      deps: { spawn: fakeSpawn },
    });

    expect(out).toMatchObject({
      ok: true,
      adapter: 'ssh',
      securityMode: 'execute_with_system_ssh_no_secret_output',
      networkConnectionAttempted: true,
      privateKeyReadByNoe: false,
      passwordPromptAllowed: false,
    });
    expect(calls).toEqual([
      { command: 'ssh', args: ['-o', 'BatchMode=yes', 'demo-host', 'uptime'] },
    ]);
  });

  it('inspects SSH config metadata without spawning ssh or reading private key content', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-ssh-adapter-'));
    const config = join(dir, 'config');
    const privateKey = join(dir, 'id_ed25519');
    try {
      writeFileSync(config, `Host lab\n  HostName 192.0.2.10\n  User neo\n  IdentityFile ${privateKey}\n`, 'utf8');
      writeFileSync(privateKey, 'PRIVATE KEY SHOULD NOT APPEAR', 'utf8');
      const calls = [];
      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.ssh.inventory'),
        args: { path: config },
        realExecute: true,
        deps: { spawn: () => { calls.push('called'); } },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'ssh-inventory',
        privateKeyRead: false,
        networkConnectionAttempted: false,
        passwordPromptAllowed: false,
      });
      expect(out.hosts[0]).toMatchObject({
        aliases: ['lab'],
        hostName: '192.0.2.10',
        user: 'neo',
        identityFile: { configured: true, basename: 'id_ed25519' },
      });
      expect(JSON.stringify(out)).not.toContain(privateKey);
      expect(JSON.stringify(out)).not.toContain('PRIVATE KEY SHOULD NOT APPEAR');
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('builds a marketplace install dry-run without writing files', async () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'noe-marketplace-dry-run-'));
    try {
      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.install'),
        args: { manifest: { id: 'demo-tool', token: 'tp-unitsecret000000000000000000000000000000' } },
        realExecute: false,
        deps: { marketplaceDir },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'tool-marketplace-install',
        plannedOnly: true,
        id: 'demo-tool',
      });
      expect(out.wouldWritePath).toContain('demo-tool.json');
      expect(JSON.stringify(out)).not.toContain('tp-unitsecret');
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  it('writes a redacted marketplace manifest only during real adapter execution', async () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'noe-marketplace-real-'));
    try {
      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.install'),
        args: { manifest: { id: 'demo-tool', apiKey: 'tp-unitsecret000000000000000000000000000000' } },
        realExecute: true,
        deps: { marketplaceDir },
      });

      expect(out.ok).toBe(true);
      expect(out.adapter).toBe('tool-marketplace-install');
      const installed = readFileSync(out.path, 'utf8');
      expect(installed).toContain('demo-tool');
      expect(installed).not.toContain('tp-unitsecret');
      expect(out.sha256).toHaveLength(64);
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  it('lists and disables marketplace tools without enabling arbitrary execution', async () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'noe-marketplace-registry-'));
    try {
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.install'),
        args: { manifest: { id: 'demo-tool', command: 'node demo.js' } },
        realExecute: true,
        deps: { marketplaceDir },
      });

      const listed = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.list'),
        args: {},
        realExecute: true,
        deps: { marketplaceDir },
      });
      expect(listed.tools).toEqual([
        expect.objectContaining({ id: 'demo-tool', state: 'enabled', executionEnabled: false }),
      ]);

      const disabled = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.disable'),
        args: { id: 'demo-tool' },
        realExecute: true,
        deps: { marketplaceDir },
      });
      expect(disabled).toMatchObject({ ok: true, id: 'demo-tool', state: 'disabled' });
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  it('executes installed marketplace tool entrypoints through the shell adapter', async () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'noe-marketplace-execute-'));
    try {
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.install'),
        args: { manifest: { id: 'demo-tool', command: 'printf marketplace-ok' } },
        realExecute: true,
        deps: { marketplaceDir },
      });
      const calls = [];
      const fakeSpawn = (command, args) => {
        calls.push({ command, args });
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        queueMicrotask(() => {
          child.stdout.emit('data', 'marketplace-ok');
          child.emit('close', 0, null);
        });
        return child;
      };

      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.execute'),
        args: { id: 'demo-tool' },
        realExecute: true,
        deps: { marketplaceDir, spawn: fakeSpawn },
      });

      expect(out).toMatchObject({
        ok: true,
        adapter: 'tool-marketplace-execute',
        id: 'demo-tool',
        executionAdapterConfigured: true,
        stdout: 'marketplace-ok',
        secretValuesReturned: false,
      });
      expect(calls).toEqual([
        // SHELL_BIN 与生产同款推导：macOS=/bin/zsh、CI ubuntu=/bin/bash（写死 zsh 在 ubuntu 必挂）
        { command: SHELL_BIN, args: ['-lc', 'printf marketplace-ok'] },
      ]);
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  it('blocks disabled marketplace tools from execution', async () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'noe-marketplace-disabled-execute-'));
    try {
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.install'),
        args: { manifest: { id: 'demo-tool', command: 'printf should-not-run' } },
        realExecute: true,
        deps: { marketplaceDir },
      });
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.disable'),
        args: { id: 'demo-tool' },
        realExecute: true,
        deps: { marketplaceDir },
      });

      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.execute'),
        args: { id: 'demo-tool' },
        realExecute: true,
        deps: { marketplaceDir, spawn: () => { throw new Error('should not spawn'); } },
      });

      expect(out).toMatchObject({
        ok: false,
        adapter: 'tool-marketplace-execute',
        error: 'tool_marketplace_record_not_found',
      });
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });

  it('blocks marketplace entrypoints that would delete protected runtime paths', async () => {
    const marketplaceDir = mkdtempSync(join(tmpdir(), 'noe-marketplace-protected-delete-'));
    try {
      await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.install'),
        args: { manifest: { id: 'demo-tool', command: 'rm -rf ~/.codex' } },
        realExecute: true,
        deps: { marketplaceDir },
      });

      const calls = [];
      const out = await runNoeFreedomAdapter({
        tool: tool('noe.freedom.tool_marketplace.execute'),
        args: { id: 'demo-tool' },
        realExecute: true,
        deps: { marketplaceDir, spawn: () => { calls.push('spawned'); } },
      });

      expect(out).toMatchObject({
        ok: false,
        adapter: 'tool-marketplace-execute',
        error: `developer_hard_veto_protected_delete:${homedir()}/.codex`,
      });
      expect(calls).toHaveLength(0);
    } finally {
      rmSync(marketplaceDir, { recursive: true, force: true });
    }
  });
});
