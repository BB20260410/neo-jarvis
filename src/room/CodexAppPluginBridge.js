// CodexAppPluginBridge — GPT/Codex 成员专属的 App 插件桥接说明
//
// 目标:
// - 不把 Codex App / ChatGPT 插件伪装成所有模型共享的 room skill。
// - GPT 成员通过 Codex CLI 执行时,优先使用自己运行时真实暴露的插件/连接器/MCP。
// - 如果插件只存在于 Codex 桌面会话而没有暴露给 CLI,必须输出可审计请求,不能伪造工具结果。

function cleanText(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanList(values, limit = 12) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = cleanText(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

export function buildCodexAppPluginBridgeCapabilities({ panelMcpNames = [] } = {}) {
  const panelMcp = cleanList(panelMcpNames, 8);
  return [
    'Codex App 插件桥接: GPT 成员保留 Codex CLI base config 中已有的 MCP、profiles、插件与本机账号配置;面板临时 profile 只做叠加,不覆盖用户原配置。',
    '如果 Codex App/插件/连接器已在当前 Codex CLI 运行时真实暴露,GPT 成员可以按 Codex 原生工具能力直接调用并产出 Agent Run 证据。',
    '如果某个插件只存在于 Codex 桌面聊天上下文、没有暴露给 Codex CLI,GPT 成员必须输出 CODEX_APP_PLUGIN_REQUEST 块,说明需要哪个插件、输入、预期证据和阻断原因;不得编造已调用结果。',
    ...panelMcp.map((name) => `面板已叠加 MCP: ${name}`),
  ];
}

export function buildCodexAppPluginRequestSchema() {
  return [
    '当需要 Codex App 插件但当前运行时无法直接调用时,输出以下块:',
    'CODEX_APP_PLUGIN_REQUEST',
    '- plugin: <插件或连接器名称>',
    '- action: <要执行的动作>',
    '- input: <必要输入,避免泄露密钥>',
    '- expected_evidence: <成功后应回填的证据>',
    '- blocker: <为什么当前 Codex CLI 不能直接完成>',
    'END_CODEX_APP_PLUGIN_REQUEST',
  ].join('\n');
}
