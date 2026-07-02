// OpenAI 兼容网关 /v1/*（从 server.js 抽出）：把外部 OpenAI SDK 请求路由到 panel 已注册的 adapter。
// 让外部 IDE/客户端（Continue/Cursor/Cherry Studio）把 panel 当 backend。model 命名「<adapterId>:<model?>」。
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

export function registerOpenaiCompatRoutes(app, { roomAdapterPool, metricsStore, requireOwnerToken, DEBUG_ERRORS = false }) {
  app.get('/v1/models', (req, res) => {
    try {
      const adapters = Array.from(roomAdapterPool.keys());
      // 每个 adapter 提供"基础" model id（用户也可以传 adapterId:任意 model 名）
      const ADAPTER_MODELS = {
        claude: ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5', 'sonnet', 'opus', 'haiku'],
        codex: ['gpt-5', 'gpt-5-mini', 'gpt-5-codex', 'o3', 'o3-mini'],
        // 2026-05：gemini-3.x 在 free quota 下全部 ModelNotFoundError；2.5 系列稳定可用。
        //   首位 = 链首默认（能力优先 pro）；GeminiSpawnAdapter 内置 fallback chain：pro → flash → flash-lite，
        //   配额耗尽自动降级，所以 pro 即使 25 RPD 紧也能无痛兜到 flash
        'gemini-cli': ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3-flash-preview', 'gemini-3.5-flash'],
        gemini: ['gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-3.1-flash-image-preview', 'gemini-3-flash-preview', 'gemini-3.5-flash'],
        'gemini-openai': [''],
        minimax: ['MiniMax-M2.7', 'MiniMax-M2.6', 'abab7-chat'],
        ollama: ['gemma3:4b', 'qwen2.5:7b', 'llama3.2:3b'],
        ccr: [''],
      };
      const data = [];
      for (const a of adapters) {
        const ms = ADAPTER_MODELS[a] || [''];
        for (const m of ms) {
          const id = m ? `${a}:${m}` : a;
          data.push({
            id,
            object: 'model',
            created: 0,
            owned_by: 'noe',
          });
        }
      }
      res.json({ object: 'list', data });
    } catch (e) {
      console.error('[500 v1]', e?.stack || e?.message || e);
      res.status(500).json({ error: { message: DEBUG_ERRORS ? (e?.message || 'panel internal error') : '内部错误（详情见 server 日志）', type: 'panel_internal_error' } });
    }
  });

  // Round 5 H#5：OpenAI 兼容网关消耗用户 Claude/Codex/Gemini 配额 → owner-token 防本机其他 UID 刷
  app.post('/v1/chat/completions', requireOwnerToken, async (req, res) => {
    try {
      const body = req.body || {};
      if (!body.model || typeof body.model !== 'string') {
        return res.status(400).json({ error: { message: 'model is required', type: 'invalid_request_error' } });
      }
      if (!Array.isArray(body.messages) || body.messages.length === 0) {
        return res.status(400).json({ error: { message: 'messages must be non-empty array', type: 'invalid_request_error' } });
      }
      const wantStream = body.stream === true;
      // 解 model
      const colonIdx = body.model.indexOf(':');
      const adapterId = colonIdx >= 0 ? body.model.slice(0, colonIdx) : body.model;
      const modelName = colonIdx >= 0 ? body.model.slice(colonIdx + 1) : '';
      const adapter = roomAdapterPool.get(adapterId);
      if (!adapter) {
        return res.status(404).json({ error: { message: `adapter "${adapterId}" not registered or disabled in panel`, type: 'invalid_request_error', param: 'model' } });
      }
      // 规范 messages：只保留 role/content
      const messages = body.messages
        .filter((m) => m && typeof m === 'object' && typeof m.role === 'string' && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content }));
      if (messages.length === 0) {
        return res.status(400).json({ error: { message: 'no valid messages after filtering', type: 'invalid_request_error' } });
      }
      // body.max_tokens 等暂不传到 adapter（adapter 各自有默认）
      const startedAt = Date.now();
      const completionId = 'chatcmpl-panel-' + randomUUID().slice(0, 24);

      // v0.55 Sprint 14 F4：SSE streaming
      if (wantStream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders?.();
        const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
        // adapter.chat 不真原生 streaming（多数 spawn 是一次性返回），但有 onProgress 接 stdout chunk
        // 策略：onProgress 拿到的增量 → 转成 OpenAI delta；最后再发一次 finish_reason: stop
        let lastSent = '';
        const onProgress = (chunk) => {
          if (!chunk || typeof chunk !== 'string') return;
          // 注意 chunk 是 stdout 字节流，不是干净的"new content"——多数 adapter 累积传，每次 chunk 含所有已收文本前缀
          // 为正确生成 delta：跟 lastSent 比较增量
          // 但很多 spawn adapter 的 onProgress 传的是 *当前块*（chunk），不是累积。看 ClaudeSpawnAdapter 实现是 `child.stdout.on('data', d => { stdout += d.toString(); opts.onProgress?.(d.toString()); })` —— 传的是当前块
          send({
            id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
          });
          lastSent += chunk;
        };
        // 心跳：每 15s 发空 comment 防中间代理 idle 关连接
        const heartbeat = setInterval(() => { try { res.write(':\n\n'); } catch {} }, 15000);
        // 客户端提前断开（网络闪断/IDE 关闭）时清理心跳，避免 setInterval + req/res 闭包泄漏 → FD 耗尽
        req.on('close', () => clearInterval(heartbeat));
        try {
          // 第一个 chunk 发个 role:'assistant' delta，符合 OpenAI 协议
          send({
            id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
          });
          const result = await adapter.chat(messages, {
            model: modelName,
            cwd: homedir(),
            onProgress,
            budgetContext: { projectId: homedir(), adapterId },
          });
          clearInterval(heartbeat);
          // 如果 adapter 整体 reply 比 onProgress 累积更长，补发剩余
          const fullReply = (result && result.reply) || '';
          if (fullReply.length > lastSent.length) {
            send({
              id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
              choices: [{ index: 0, delta: { content: fullReply.slice(lastSent.length) }, finish_reason: null }],
            });
          }
          // 结束信号
          send({
            id: completionId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: {
              prompt_tokens: result.tokensIn || 0,
              completion_tokens: result.tokensOut || 0,
              total_tokens: (result.tokensIn || 0) + (result.tokensOut || 0),
            },
          });
          res.write('data: [DONE]\n\n');
          res.end();
          try {
            metricsStore.record({
              roomId: '', roomMode: 'openai-api-stream', roomName: `v1/chat:${adapterId}`,
              projectId: homedir(),
              turn: 'v1-stream', adapter: adapterId, model: modelName,
              latencyMs: Date.now() - startedAt,
              tokensIn: result.tokensIn || 0, tokensOut: result.tokensOut || 0,
              success: true, errorKind: null,
            });
          } catch {}
        } catch (e) {
          clearInterval(heartbeat);
          try {
            send({ error: { message: `adapter error: ${e.message}`, type: 'upstream_error' } });
            res.end();
          } catch {}
        }
        return;
      }

      // ===== 非 streaming 路径 =====
      let result;
      try {
        result = await adapter.chat(messages, {
          model: modelName,
          cwd: homedir(),
          budgetContext: { projectId: homedir(), adapterId },
        });
      } catch (e) {
        return res.status(502).json({ error: { message: `adapter error: ${e.message}`, type: 'upstream_error' } });
      }
      try {
        metricsStore.record({
          roomId: '', roomMode: 'openai-api', roomName: `v1/chat:${adapterId}`,
          projectId: homedir(),
          turn: 'v1-completion', adapter: adapterId, model: modelName,
          latencyMs: Date.now() - startedAt,
          tokensIn: result.tokensIn || 0, tokensOut: result.tokensOut || 0,
          success: true, errorKind: null,
        });
      } catch {}
      res.json({
        id: completionId,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: body.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: result.reply || '' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: result.tokensIn || 0,
          completion_tokens: result.tokensOut || 0,
          total_tokens: (result.tokensIn || 0) + (result.tokensOut || 0),
        },
      });
    } catch (e) {
      console.error('[500 v1]', e?.stack || e?.message || e);
      res.status(500).json({ error: { message: DEBUG_ERRORS ? (e?.message || 'panel internal error') : '内部错误（详情见 server 日志）', type: 'panel_internal_error' } });
    }
  });

  app.use('/v1', (req, res) => {
    res.status(404).json({ error: { message: `unknown endpoint: ${req.method} ${req.path}`, type: 'invalid_request_error' } });
  });
}
