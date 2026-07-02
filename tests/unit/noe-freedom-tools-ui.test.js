import { describe, expect, it, vi } from 'vitest';
import {
  applyFreedomNextAction,
  applyFreedomNextActionChain,
  applyFreedomQuickStart,
  buildFreedomChainArgsFromNextActions,
  buildFreedomNextActionChainRequest,
  buildFreedomRequestBody,
  defaultFreedomArgs,
  extractFreedomNextActions,
  formatFreedomResult,
  installNoeFreedomTools,
  parseFreedomArgsJson,
  redactFreedomUiValue,
  renderDeveloperModeProfile,
  renderFreedomNextActions,
  renderOwnerAuthorizedAccountTargets,
  renderQuickStartOptions,
  renderFreedomToolList,
} from '../../public/src/web/noe-freedom-tools.js';

function makeNode(id = '') {
  return {
    id,
    className: '',
    dataset: {},
    value: '',
    checked: true,
    textContent: '',
    title: '',
    style: {},
    listeners: {},
    _innerHTML: '',
    set innerHTML(value) { this._innerHTML = value; },
    get innerHTML() { return this._innerHTML; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
  };
}

function makeRoot() {
  const nodes = new Map();
  const grid = makeNode('brain-grid');
  grid.appended = [];
  grid.appendChild = (node) => {
    grid.appended.push(node);
    nodes.set(`#${node.id}`, node);
    for (const id of [
      'noeFreedomStatus',
      'noeFreedomQuickStart',
      'btnNoeFreedomApplyTemplate',
      'noeFreedomMode',
      'btnNoeFreedomStartSession',
      'noeFreedomSessionStatus',
      'noeFreedomTool',
      'noeFreedomPersist',
      'btnNoeFreedomRefresh',
      'noeFreedomArgs',
      'btnNoeFreedomDryRun',
      'btnNoeFreedomExecute',
      'noeFreedomDeveloperModeProfile',
      'noeFreedomToolList',
      'noeFreedomResult',
      'noeFreedomStageSummary',
      'noeFreedomAccountTargets',
      'noeFreedomNextActions',
    ]) nodes.set(`#${id}`, makeNode(id));
  };
  nodes.set('.noe-brain-grid', grid);
  nodes.set('#noeBrainArea .noe-brain-grid', grid);
  return {
    grid,
    createElement: () => makeNode(),
    querySelector(selector) {
      return nodes.get(selector) || null;
    },
  };
}

describe('Noe freedom tools UI', () => {
  it('builds developer unrestricted execute payloads without trust or allowlist ceremony', () => {
    const out = buildFreedomRequestBody({
      action: 'noe.freedom.shell.execute',
      argsJson: '{"command":"printf ok"}',
      mode: 'developer_unrestricted',
      realExecute: true,
      persistLedger: true,
      runId: 'ui-test',
    });

    expect(out.ok).toBe(true);
    expect(out.body).toMatchObject({
      action: 'noe.freedom.shell.execute',
      realExecute: true,
      persistLedger: true,
      runId: 'ui-test',
      authorization: { mode: 'developer_unrestricted', ownerPresent: true },
    });
    expect(out.body.authorization.allowlistAccepted).toBeUndefined();
    expect(out.body.authorization.rollbackPlan).toBeUndefined();
  });

  it('uses an active developer session id instead of frontend owner-present claims', () => {
    const out = buildFreedomRequestBody({
      action: 'noe.freedom.shell.execute',
      argsJson: '{"command":"printf ok"}',
      mode: 'developer_unrestricted',
      sessionId: 'freedom-session-ui',
      realExecute: true,
      persistLedger: true,
      runId: 'ui-session-test',
    });

    expect(out.ok).toBe(true);
    expect(out.body.authorization).toEqual({ sessionId: 'freedom-session-ui' });
    expect(out.body.authorization.ownerPresent).toBeUndefined();
    expect(out.body.authorization.mode).toBeUndefined();
  });

  it('forces dry-run authorization for dry-run requests even when developer mode is selected', () => {
    const out = buildFreedomRequestBody({
      action: 'noe.freedom.browser.open',
      argsJson: '{"url":"https://example.com"}',
      mode: 'developer_unrestricted',
      realExecute: false,
    });

    expect(out.ok).toBe(true);
    expect(out.body.realExecute).toBe(false);
    expect(out.body.authorization).toEqual({ mode: 'dry_run' });
  });

  it('redacts secret-like output before rendering results', () => {
    const formatted = formatFreedomResult({
      ok: true,
      runtime: {
        stdout: 'token tp-unitsecret000000000000000000000000000000',
      },
      argsPreview: {
        apiKey: 'sk-unitsecret000000000000000000000000000000',
      },
    });

    expect(formatted).toContain('[redacted]');
    expect(formatted).not.toContain('tp-unitsecret');
    expect(formatted).not.toContain('sk-unitsecret');
  });

  it('redacts nested credential fields for visible UI summaries', () => {
    const out = redactFreedomUiValue({
      nested: {
        password: 'plain-text-value',
        safe: 'visible',
      },
    });

    expect(out.nested.password).toBe('[redacted]');
    expect(out.nested.safe).toBe('visible');
  });

  it('redacts secret-like URL query parameters before loading visible next action args', () => {
    const out = redactFreedomUiValue({
      browserState: {
        url: 'https://creator.example.test/publish?token=secret-value&safe=1',
      },
    });

    expect(out.browserState.url).toContain('token=[redacted]');
    expect(out.browserState.url).toContain('safe=1');
    expect(out.browserState.url).not.toContain('secret-value');
  });

  it('uses harmless defaults and reports invalid JSON before hitting the route', () => {
    expect(defaultFreedomArgs('noe.freedom.shell.execute')).toContain('printf noe-developer-mode');
    expect(defaultFreedomArgs('noe.freedom.browser.open')).toContain('https://example.com');
    expect(defaultFreedomArgs('noe.freedom.account.connection_inventory')).toContain('wechat_channels');
    expect(defaultFreedomArgs('noe.freedom.developer.readiness_audit')).toContain('includeBrowserState');
    expect(defaultFreedomArgs('noe.freedom.developer.readiness_audit')).toContain('providerSecrets');
    expect(defaultFreedomArgs('noe.freedom.developer.readiness_audit')).toContain('includeProviderHealth');
    expect(defaultFreedomArgs('noe.freedom.social.workflow.prepare')).toContain('douyin');
    expect(defaultFreedomArgs('noe.freedom.social.publish_orchestrate')).toContain('Google Chrome');
    expect(defaultFreedomArgs('noe.freedom.social.publish_orchestrate')).toContain('includeDomFinalPublishAction');
    expect(defaultFreedomArgs('noe.freedom.chain.execute')).toContain('steps');
    expect(defaultFreedomArgs('noe.freedom.run.resume_next_actions')).toContain('ledgerRef');
    expect(defaultFreedomArgs('noe.freedom.run.history')).toContain('requireOk');
    expect(defaultFreedomArgs('noe.freedom.social.preflight.run')).toContain('draft-id');
    expect(defaultFreedomArgs('noe.freedom.social.form_fill.plan')).toContain('Google Chrome');
    expect(defaultFreedomArgs('noe.freedom.social.form_fill.execute')).toContain('Google Chrome');
    expect(defaultFreedomArgs('noe.freedom.social.media_upload.prepare')).toContain('mediaFiles');
    expect(defaultFreedomArgs('noe.freedom.social.media_upload.execute')).toContain('mediaFiles');
    expect(defaultFreedomArgs('noe.freedom.social.final_publish.execute')).toContain('Google Chrome');
    expect(defaultFreedomArgs('noe.freedom.browser.dom.execute')).toContain('read_title');
    expect(parseFreedomArgsJson('{not-json').ok).toBe(false);
  });

  it('redacts browser DOM action values in visible UI summaries', () => {
    const out = redactFreedomUiValue({
      actions: [
        { type: 'set_value', selector: '#token', value: 'plain-dom-value' },
      ],
    });

    expect(out.actions[0]).toMatchObject({
      type: 'set_value',
      selector: '#token',
      value: '[redacted]',
    });
    expect(JSON.stringify(out)).not.toContain('plain-dom-value');
  });

  it('renders capability rows without implying disabled tools are unavailable', () => {
    const html = renderFreedomToolList([
      { id: 'noe.freedom.shell.execute', name: '自由 Shell 执行', capability: 'shell.exec', riskLevel: 'critical' },
    ]);

    expect(html).toContain('自由 Shell 执行');
    expect(html).toContain('shell.exec');
  });

  it('renders developer mode powers and hard vetoes without secrets', () => {
    const html = renderDeveloperModeProfile({
      label: '开发者最大权限',
      mode: 'developer_unrestricted',
      skipsTrustManifestAndAllowlist: true,
      canRunLocalShell: true,
      canRunSsh: true,
      canRunMacAutomation: true,
      canOpenBrowserAccounts: true,
      canControlAllOwnerAuthorizedAccounts: true,
      canUseBrowserLoggedInSessions: true,
      canPublishExternally: true,
      canUploadFiles: true,
      canUseSecretRefs: true,
      canUseKeychainSecretRefs: true,
      canUseEnvSecretRefs: true,
      canUseSshAgentAndConfiguredKeys: true,
      canUseToolMarketplace: true,
      hardVetoes: ['system_root_delete', 'codex_runtime_delete', 'secret_plaintext_output'],
      allowedCapabilityPrefixes: ['account.'],
    });

    expect(html).toContain('开发者最大权限');
    expect(html).toContain('账号登录态');
    expect(html).toContain('所有已授权账号');
    expect(html).toContain('浏览器会话');
    expect(html).toContain('外部发布');
    expect(html).toContain('文件上传');
    expect(html).toContain('Keychain 引用');
    expect(html).toContain('.env 引用');
    expect(html).toContain('SSH agent/key');
    expect(html).toContain('secret_plaintext_output');
    expect(html).not.toMatch(/sk-|tp-|AIza|password=|cookie=/i);
  });

  it('renders and applies quick starts without executing them', () => {
    const root = makeRoot();
    root.grid.appendChild(makeNode('noeFreedomToolsPanel'));
    const quickStart = {
      id: 'browser.open-douyin-creator',
      title: '打开抖音创作者中心',
      actionId: 'noe.freedom.browser.open',
      mode: 'developer_unrestricted',
      args: { url: 'https://creator.douyin.com/' },
    };

    expect(renderQuickStartOptions([quickStart])).toContain('打开抖音创作者中心');
    const out = applyFreedomQuickStart(quickStart, root);

    expect(out.ok).toBe(true);
    expect(root.querySelector('#noeFreedomTool').value).toBe('noe.freedom.browser.open');
    expect(root.querySelector('#noeFreedomMode').value).toBe('developer_unrestricted');
    expect(root.querySelector('#noeFreedomArgs').value).toContain('creator.douyin.com');
  });

  it('renders follow-up Freedom actions from runtime results without exposing secrets', () => {
    const result = {
      ok: true,
      runtime: {
        nextFreedomActions: [
          {},
          {
            stepId: 'execute_final_publish',
            title: '最终发布',
            actionId: 'noe.freedom.social.final_publish.execute',
            mode: 'developer_unrestricted',
            args: {
              browserState: {
                url: 'https://creator.example.test/publish?token=secret-value&safe=1',
              },
              apiKey: 'sk-unitsecret000000000000000000000000000000',
            },
          },
        ],
      },
    };

    const actions = extractFreedomNextActions(result);
    const html = renderFreedomNextActions(result);

    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      index: 0,
      stepId: 'execute_final_publish',
      actionId: 'noe.freedom.social.final_publish.execute',
    });
    expect(actions[0].args.apiKey).toBe('[redacted]');
    expect(actions[0].args.browserState.url).toContain('token=[redacted]');
    expect(html).toContain('最终发布');
    expect(html).toContain('载入全部');
    expect(html).toContain('执行全部');
    expect(html).toContain('data-noe-next-action-chain="1"');
    expect(html).toContain('data-noe-next-action-chain-run="1"');
    expect(html).toContain('data-noe-next-action-index="0"');
    expect(html).not.toContain('secret-value');
    expect(html).not.toContain('sk-unitsecret');
  });

  it('renders owner-authorized account targets without exposing URL secrets', () => {
    const html = renderOwnerAuthorizedAccountTargets({
      runtime: {
        ownerAuthorizedAccountTargets: [
          {
            targetId: 'owner_account_platform',
            host: 'platform.example.test',
            app: 'Google Chrome',
            origin: 'https://platform.example.test',
            urlPreview: 'https://platform.example.test/dashboard?token=secret-value',
            socialPlatform: null,
            nextFreedomActions: [
              { actionId: 'noe.freedom.browser.state_probe' },
              { actionId: 'noe.freedom.browser.open' },
            ],
          },
        ],
      },
    });

    expect(html).toContain('已授权账号目标');
    expect(html).toContain('platform.example.test');
    expect(html).toContain('Google Chrome');
    expect(html).toContain('actions:2');
    expect(html).not.toContain('secret-value');
    expect(renderOwnerAuthorizedAccountTargets({})).toContain('暂无已授权账号目标');
  });

  it('loads a follow-up Freedom action into the form without executing it', () => {
    const root = makeRoot();
    root.grid.appendChild(makeNode('noeFreedomToolsPanel'));
    const action = {
      stepId: 'open_creator',
      actionId: 'noe.freedom.browser.open',
      mode: 'developer_unrestricted',
      args: { url: 'https://creator.example.test/' },
    };

    const out = applyFreedomNextAction(action, root);

    expect(out.ok).toBe(true);
    expect(root.querySelector('#noeFreedomTool').value).toBe('noe.freedom.browser.open');
    expect(root.querySelector('#noeFreedomMode').value).toBe('developer_unrestricted');
    expect(root.querySelector('#noeFreedomArgs').value).toContain('creator.example.test');
    expect(root.querySelector('#btnNoeFreedomExecute').listeners.click).toBeUndefined();
  });

  it('builds and loads a full follow-up Freedom action chain without executing it', () => {
    const root = makeRoot();
    root.grid.appendChild(makeNode('noeFreedomToolsPanel'));
    const actions = [
      {
        stepId: 'open_creator',
        actionId: 'noe.freedom.browser.open',
        mode: 'developer_unrestricted',
        args: { url: 'https://creator.example.test/?token=secret-value' },
      },
      {
        stepId: 'final_publish',
        actionId: 'noe.freedom.social.final_publish.execute',
        mode: 'developer_unrestricted',
        args: { draftId: 'draft-1', apiKey: 'sk-unitsecret000000000000000000000000000000' },
      },
    ];

    const built = buildFreedomChainArgsFromNextActions(actions);
    const out = applyFreedomNextActionChain(actions, root);
    const args = JSON.parse(root.querySelector('#noeFreedomArgs').value);

    expect(built.ok).toBe(true);
    expect(out).toMatchObject({
      ok: true,
      actionId: 'noe.freedom.chain.execute',
      stepCount: 2,
    });
    expect(root.querySelector('#noeFreedomTool').value).toBe('noe.freedom.chain.execute');
    expect(root.querySelector('#noeFreedomMode').value).toBe('developer_unrestricted');
    expect(args).toMatchObject({
      stopOnError: true,
      persistChildLedgers: true,
      steps: [
        { stepId: 'open_creator', actionId: 'noe.freedom.browser.open' },
        { stepId: 'final_publish', actionId: 'noe.freedom.social.final_publish.execute' },
      ],
    });
    expect(args.steps[0].args.url).toContain('token=[redacted]');
    expect(args.steps[1].args.apiKey).toBe('[redacted]');
    expect(root.querySelector('#btnNoeFreedomExecute').listeners.click).toBeUndefined();
  });

  it('requires a developer session before executing a follow-up chain', () => {
    const actions = [
      {
        stepId: 'final_publish',
        actionId: 'noe.freedom.social.final_publish.execute',
        mode: 'developer_unrestricted',
        args: { draftId: 'draft-1' },
      },
    ];

    const missing = buildFreedomNextActionChainRequest(actions, {});
    const ready = buildFreedomNextActionChainRequest(actions, {
      sessionId: 'freedom-session-ui-chain',
      runId: 'ui-chain-run',
    });

    expect(missing).toEqual({
      ok: false,
      error: 'developer_session_required_for_next_action_chain_execute',
    });
    expect(ready.ok).toBe(true);
    expect(ready.body).toMatchObject({
      action: 'noe.freedom.chain.execute',
      realExecute: true,
      runId: 'ui-chain-run',
      authorization: { sessionId: 'freedom-session-ui-chain' },
    });
    expect(ready.body.args.steps[0]).toMatchObject({
      stepId: 'final_publish',
      actionId: 'noe.freedom.social.final_publish.execute',
    });
    expect(ready.body.authorization.ownerPresent).toBeUndefined();
  });

  it('installs the panel into Noe Brain and loads capabilities through the protected route', async () => {
    const root = makeRoot();
    const fetchSpy = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ok: true,
        developerMode: {
          label: '开发者最大权限',
          mode: 'developer_unrestricted',
          skipsTrustManifestAndAllowlist: true,
          canOpenBrowserAccounts: true,
          canPublishExternally: true,
          canUploadFiles: true,
          hardVetoes: ['system_root_delete', 'codex_runtime_delete', 'secret_plaintext_output'],
        },
        quickStarts: [
          { id: 'developer.shell.safe-echo', title: 'Shell 自检', actionId: 'noe.freedom.shell.execute', mode: 'developer_unrestricted', args: { command: 'printf ok' } },
        ],
        tools: [
          { id: 'noe.freedom.shell.execute', name: '自由 Shell 执行', capability: 'shell.exec', riskLevel: 'critical' },
        ],
      }),
    }));
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    globalThis.fetch = fetchSpy;
    // owner token 在场：经 PanelCore 桥判定，受保护路由照常加载
    globalThis.window = { PanelCore: { hasOwnerToken: () => true } };
    try {
      const out = installNoeFreedomTools({ root });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(out.ok).toBe(true);
      expect(root.grid.appended[0]).toMatchObject({
        id: 'noeFreedomToolsPanel',
        className: 'noe-brain-panel noe-brain-panel-wide',
      });
      expect(fetchSpy.mock.calls[0][0]).toBe('/api/noe/freedom/capabilities');
      expect(root.querySelector('#noeFreedomQuickStart').innerHTML).toContain('Shell 自检');
      expect(root.querySelector('#noeFreedomDeveloperModeProfile').innerHTML).toContain('开发者最大权限');
      expect(root.querySelector('#noeFreedomStageSummary')).toBeTruthy();
      expect(root.querySelector('#noeFreedomAccountTargets')).toBeTruthy();
      expect(root.querySelector('#btnNoeFreedomExecute').listeners.click).toBeTypeOf('function');
      expect(root.querySelector('#btnNoeFreedomStartSession').listeners.click).toBeTypeOf('function');
      expect(root.querySelector('#btnNoeFreedomApplyTemplate').listeners.click).toBeTypeOf('function');
      expect(root.querySelector('#noeFreedomNextActions').listeners.click).toBeTypeOf('function');
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.window = oldWindow;
    }
  });

  it('pauses the protected capabilities route when the owner token is missing (bare open, no 401 noise)', async () => {
    const root = makeRoot();
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, tools: [] }) }));
    const oldFetch = globalThis.fetch;
    const oldWindow = globalThis.window;
    globalThis.fetch = fetchSpy;
    globalThis.window = { PanelCore: { hasOwnerToken: () => false } };
    try {
      const out = installNoeFreedomTools({ root });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(out.ok).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(root.querySelector('#noeFreedomStatus').textContent).toBe('blocked');
      expect(root.querySelector('#noeFreedomResult').textContent).toContain('owner_token_missing');
      expect(root.querySelector('#noeFreedomToolList').innerHTML).toContain('请确认 owner token');
    } finally {
      globalThis.fetch = oldFetch;
      globalThis.window = oldWindow;
    }
  });
});
