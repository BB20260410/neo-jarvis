// CodexSpawnAdapter — spawn `codex exec` 拿 GPT 的回答（聊天室成员）
// 用户 ChatGPT 5x plan 通过 codex CLI 走，零 API 增量
// codex exec stdin 喂 prompt，-o file 拿最终回答，避免解析 stdout 噪声

import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, rmSync, mkdtempSync, existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RoomAdapter, normalizeNativeCapabilities } from './RoomAdapter.js';
import { applyCodexGpt55RuntimeDefaults } from './CodexRuntimeDefaults.js';
import { mcpStore } from '../mcp/McpStore.js';
import { buildCodexAppPluginBridgeCapabilities, buildCodexAppPluginRequestSchema } from './CodexAppPluginBridge.js';

// 极简 TOML 值序列化(只覆盖 panel MCP server 用到的 string/array/object[string→string])
function tomlString(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r') + '"'; }
function tomlStringArray(arr) { return '[' + (arr || []).map(tomlString).join(', ') + ']'; }
export function buildPanelMcpToml(servers) {
  // 给所有 panel MCP server 加 panel_ 前缀,避免和 ~/.codex/config.toml 里用户已配的 MCP 同名冲突。
  // 用 [mcp_servers.panel_<name>] 段;codex --profile 会层叠到 base config 上,临时生效。
  const lines = [];
  for (const s of servers) {
    const key = 'panel_' + String(s.name || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    lines.push(`[mcp_servers.${key}]`);
    lines.push(`command = ${tomlString(s.command || '')}`);
    if (Array.isArray(s.args) && s.args.length) lines.push(`args = ${tomlStringArray(s.args)}`);
    if (s.env && typeof s.env === 'object') {
      const envEntries = Object.entries(s.env).filter(([, v]) => v !== undefined && v !== null);
      if (envEntries.length) {
        lines.push(`[mcp_servers.${key}.env]`);
        for (const [k, v] of envEntries) lines.push(`${k} = ${tomlString(v)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

// v0.51 Z-05 fix: spawn 不解析 shell alias，需 which resolve 绝对路径
function resolveCodexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  try {
    const r = spawnSync('which', ['codex'], { encoding: 'utf-8', env: process.env });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch {}
  const fb = join(homedir(), '.npm-global', 'bin', 'codex');
  return existsSync(fb) ? fb : 'codex';
}
const DEFAULT_CODEX_BIN = resolveCodexBin();

function isContextWindowText(text) {
  return /out of room in the model'?s context window|context window|context length|max(?:imum)? context|too many tokens|prompt is too long|input is too long/i.test(String(text || ''));
}

export function isCodexMcpStartupFailure(text) {
  return /MCP startup failed|failed to initialize MCP client|handshaking with MCP server failed|StdioServerTransport|Broken pipe/i.test(String(text || ''));
}

function codexExitError({ code, stdout, stderr }) {
  // codex banner + prompt echo 常常挤在 stderr 头部，UI 只需要短错误，完整 raw 仍放 raw 字段给调用方调试。
  const stderrTail = stderr.length > 1500 ? '...(头部省略)...' + stderr.slice(-1500) : stderr;
  const stdoutTail = stdout.length > 800 ? '...(头部省略)...' + stdout.slice(-800) : stdout;
  const err = new Error(`Codex exit code=${code} reply 空 stderr_tail=${stderrTail} stdout_tail=${stdoutTail}`);
  err.stdout = stdout;
  err.stderr = stderr;
  if (isContextWindowText(stderr) || isContextWindowText(stdout)) {
    err.code = 'CONTEXT_WINDOW_EXHAUSTED';
    err.message = 'Codex 上下文窗口不足：底层模型拒绝当前报告输入，请缩短输入或使用报告压缩重试';
  }
  return err;
}

export class CodexSpawnAdapter extends RoomAdapter {
  constructor(opts = {}) {
    super({
      id: 'codex',
      displayName: opts.displayName || '🟢 GPT',
      model: opts.model || null,
      timeout: Object.prototype.hasOwnProperty.call(opts, 'timeout') ? opts.timeout : 0,
    });
    this.bin = opts.bin || DEFAULT_CODEX_BIN;
    // codex CLI 0.128.0 的 turn/start 硬上限是 1,048,576 字符（stdin 整段）；
    // 扣掉 flattenMessages 分隔符 + system prompt + 模板 + 元信息，安全余量 ~48K。
    this.maxPromptChars = 1_000_000;
    // 报告不是普通聊天：Codex 还会加载 AGENTS / skills / 内置系统提示，1M 字符会超过真实模型上下文。
    // 单独给报告输入一个软预算，RoomReporter 可在 context-window 错误后继续压缩重试。
    this.maxReportContentChars = opts.maxReportContentChars || 120_000;
    this.contextRetryContentChars = opts.contextRetryContentChars || 32_000;
  }

  getNativeCapabilities() {
    let panelMcpNames = [];
    try {
      panelMcpNames = mcpStore
        .list({ enabledOnly: true, mask: true })
        .filter((server) => server?.type === 'stdio')
        .map((server) => server.name)
        .filter(Boolean);
    } catch {}
    return normalizeNativeCapabilities({
      providerId: this.id,
      displayName: this.displayName,
      runtime: 'Codex CLI (`codex exec`)',
      nativeRuntime: true,
      accountScoped: true,
      userConfigured: true,
      toolUse: true,
      skills: [
        'Codex/GPT 账号级模型能力',
        'Codex CLI 可见的 AGENTS.md / skills / 本机项目上下文',
        'Codex CLI 原生代码执行与编辑能力',
      ],
      plugins: [
        'Codex CLI 配置中可见的 profiles/plugins',
        'Codex 运行时可见的本机扩展能力',
      ],
      tools: [
        'Codex exec 文件/命令/代码操作能力',
        'Codex 原生工具调用链',
      ],
      mcp: [
        'Codex base config 中已有的 MCP servers',
        '面板启用的 stdio MCP 会通过临时 --profile 叠加给 Codex',
      ],
      bridges: buildCodexAppPluginBridgeCapabilities({ panelMcpNames }),
      requestProtocol: buildCodexAppPluginRequestSchema(),
      notes: [
        '集群协同不会要求 GPT 共享 Claude/Gemini 的 Skill;GPT 成员按 Codex/GPT 自己的运行时执行。',
        'ChatGPT/Codex UI 专属连接器只有在 Codex CLI 运行时实际暴露时才可用,不会被面板凭空伪造。',
      ],
    });
  }

  async _doChat(messages, opts = {}) {
    const prompt = this.flattenMessages(messages);
    const tmpDir = mkdtempSync(join(tmpdir(), 'codex-room-'));
    const outFile = join(tmpDir, 'last.txt');

    const args = [
      'exec',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '-C', opts.cwd || process.cwd(),
      '-o', outFile,
    ];
    const model = opts.model || this.model;
    if (model) args.push('-m', model);
    applyCodexGpt55RuntimeDefaults(args, model);

    // MCP 桥(v0.55 Sprint 12 仿 Claude):写一份 panel MCP 临时 toml 到 $CODEX_HOME,用
    // --profile 层叠到用户 base config 上。临时生效,完成后 cleanup,不污染用户 ~/.codex。
    // opts.disableMcp = true 时跳过(总结/简单 turn 不需要工具)
    let codexProfileFile = null;
    let codexProfileName = null;
    try {
      if (!opts.disableMcp) {
        const enabled = mcpStore.list({ enabledOnly: true, mask: false }).filter((s) => s.type === 'stdio');
        if (enabled.length > 0) {
          const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
          codexProfileName = `panel-mcp-${randomUUID().slice(0, 8)}`;
          codexProfileFile = join(codexHome, `${codexProfileName}.config.toml`);
          writeFileSync(codexProfileFile, buildPanelMcpToml(enabled), { mode: 0o600 });
          args.push('--profile', codexProfileName);
        }
      }
    } catch (e) {
      // MCP 注入失败不阻塞主流程,记下跳过
      console.warn('[codex-mcp] inject failed:', e.message);
      codexProfileFile = null;
    }

    args.push('-'); // 从 stdin 读 prompt

    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, args, {
        env: { ...process.env, LANG: 'zh_CN.UTF-8', LC_ALL: 'zh_CN.UTF-8' },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let settled = false;
      // v0.45 P0-1: 闭包变量提前声明，避免 cleanup 在 timer/onAbort 赋值前被 spawn error 同步触发时 TDZ
      let timer = null;
      let onAbort = null;
      child.stdout.on('data', d => { stdout += d.toString(); opts.onProgress?.(d.toString()); });
      child.stderr.on('data', d => { stderr += d.toString(); });
      // v0.51 W-09 fix: stdout/stderr 流 error 防御
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});

      const cleanup = () => {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        if (codexProfileFile) {
          try { unlinkSync(codexProfileFile); } catch {}
          codexProfileFile = null;
        }
        if (opts.abortSignal && onAbort) {
          opts.abortSignal.removeEventListener('abort', onAbort);
        }
        if (timer) { clearTimeout(timer); timer = null; }
      };
      const finishOk = (val) => { if (settled) return; settled = true; cleanup(); resolve(val); };
      const finishErr = (e) => { if (settled) return; settled = true; cleanup(); reject(e); };
      const forceKillSoon = () => {
        const killTimer = setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
          } catch {}
        }, 2000);
        try { killTimer.unref?.(); } catch {}
      };

      timer = opts.noAbort === true || this.timeout <= 0 ? null : setTimeout(() => {
        try { child.kill('SIGTERM'); } catch {}
        // v0.51 ZZ-09 fix: SIGKILL 兜底
        forceKillSoon();
        finishErr(new Error(`Codex 超时 ${this.timeout}ms`));
      }, this.timeout);

      if (opts.abortSignal) {
        if (opts.abortSignal.aborted) {
          try { child.kill('SIGTERM'); } catch {}
          return finishErr(new Error('Codex 被中断'));
        }
        onAbort = () => {
          try { child.kill('SIGTERM'); } catch {}
          forceKillSoon();
          finishErr(new Error('Codex 被中断'));
        };
        opts.abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', e => finishErr(new Error(`Codex spawn 失败: ${e.message}`)));

      // P0 #4: stdin EPIPE 防御（CLI 立即 exit / 大 prompt 都可能触发）
      child.stdin.on('error', e => {
        if (e.code === 'EPIPE') return; // 进程先死，下面 exit handler 会处理 reject
        finishErr(new Error('Codex stdin 错误: ' + e.message));
      });

      child.on('exit', (code) => {
        // v0.51 ZZ-06 fix: abort 后 child SIGTERM 退出但 reply 已写入 outFile，原逻辑会误判成功
        if (opts.abortSignal?.aborted) return finishErr(new Error('Codex 被中断'));
        let reply = '';
        try { reply = readFileSync(outFile, 'utf-8').trim(); } catch {}
        if (!reply) {
          // 兜底：从 stdout 提取 "codex\n...\ntokens used" 段
          const m = stdout.match(/codex\n([\s\S]*?)\ntokens used/);
          if (m) reply = m[1].trim();
        }
        let tokensOut = 0;
        const tm = stdout.match(/tokens used\s*\n([\d,]+)/);
        if (tm) tokensOut = parseInt(tm[1].replace(/,/g, ''), 10) || 0;
        if (code === 0 && reply) {
          finishOk({ reply, tokensIn: 0, tokensOut, raw: { stdout, stderr, code } });
        } else {
          if (codexProfileFile && !opts._codexMcpRetry && isCodexMcpStartupFailure(`${stderr}\n${stdout}`)) {
            settled = true;
            cleanup();
            this._doChat(messages, { ...opts, disableMcp: true, _codexMcpRetry: true }).then(resolve, reject);
            return;
          }
          finishErr(codexExitError({ code, stdout, stderr }));
        }
      });

      // 直接用 end(prompt) 同时写入 prompt 并排队 EOF；不要等 write 回调再 end，
      // 否则大输入/CLI 读 stdin 行为变化时可能卡在“等 EOF”阶段。
      try {
        child.stdin.end(prompt);
      } catch (e) {
        finishErr(new Error('Codex stdin end: ' + e.message));
      }
    });
  }
}
