# HANDOFF TO CLAUDE - 多模型协作与密钥位置 - 2026-06-09

## 真实仓库与红线

- 真实仓库只使用: `/Users/hxx/Desktop/Neo 贾维斯`
- 不要使用: `/Users/hxx/Documents/Neo 贾维斯` 或 `/Users/hxx/Documents/Neo 2`
- 不要读取、复制、输出 `.env`、API key、token、cookie、owner token 明文。
- 不要 `cat ~/.noe-panel/room-adapters.json`，它可能含明文 `apiKey`。
- 不要读取 CLI OAuth token 文件；只用状态检查命令确认是否可用。
- 不要碰 `51735`。
- 不要碰 `games/cartoon-apocalypse/**`。
- 不要给模型、agent、多模型调用设置人为硬超时。

## 模型角色

- Codex: 默认 `activeExecutor`，模型默认 `gpt-5.5`，最高 reasoning effort。走本机 `codex` CLI 登录态或 `CODEX_BIN` 指定路径。
- Claude: 可在用户明确选择或 validated consensus 选择时成为唯一 `activeExecutor`。默认模型 `claude-opus-4-8`，走本机 `claude` CLI 或 `CLAUDE_BIN`。
- Gemini: reviewer/advisory，不是 writer。默认模型 `gemini-3.1-pro-preview`，走本机 `gemini` CLI 或 `GEMINI_BIN`。CLI fallback chain 包含 `gemini-2.5-pro`、`gemini-2.5-flash`、`gemini-2.5-flash-lite`。
- MiniMax M3: suggestion-only，不是 writer。默认 API model `MiniMax-M3`，通过 `MINIMAX_API_KEY`。
- Xiaomi MiMo: advisory，不是 writer。默认 model `mimo-v2.5-pro`，默认 base URL `https://token-plan-cn.xiaomimimo.com/v1`，通过 `XIAOMI_API_KEY` 或 `MIMO_API_KEY`。

## 密钥在哪里

Noe resolver 的密钥优先级是:

1. 当前进程环境变量。
2. macOS Keychain，service 固定为 `Neo Jarvis Noe model API keys`。
3. `~/.noe-panel/room-adapters.json` 中的 adapter config。

不要直接读取密钥值。只用这个检查命令看是否已配置:

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run noe:keys:model:check
```

该命令只输出 `ok/source/sourceRef/message`，不会输出 secret value。

如果缺 key，由用户自己运行:

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run noe:keys:model:setup
```

Keychain service 和 account 映射:

- MiniMax M3: service `Neo Jarvis Noe model API keys`; accounts `MINIMAX_API_KEY`, `minimax`, `MiniMax-M3`; env `MINIMAX_API_KEY`。
- Xiaomi MiMo: service `Neo Jarvis Noe model API keys`; accounts `XIAOMI_API_KEY`, `MIMO_API_KEY`, `xiaomi`, `mimo`, `Xiaomi-MiMo`; env `XIAOMI_API_KEY` or `MIMO_API_KEY`。
- Gemini API fallback/config: service `Neo Jarvis Noe model API keys`; accounts `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `gemini`, `Google-Gemini`; env `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`。
- OpenAI/Codex API fallback/config: service `Neo Jarvis Noe model API keys`; accounts `OPENAI_API_KEY`, `CODEX_API_KEY`, `openai`, `codex`, `OpenAI-Codex`; env `OPENAI_API_KEY`, `CODEX_API_KEY`。
- Anthropic/Claude API fallback/config: service `Neo Jarvis Noe model API keys`; accounts `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `anthropic`, `claude`, `Anthropic-Claude`; env `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`。

CLI 登录态:

- Codex CLI: 用本机 `codex` 登录态；不要检查 token 文件。可用 `CODEX_BIN` 覆盖 binary。
- Claude CLI: 用本机 `claude` 登录态；不要检查 token 文件。可用 `CLAUDE_BIN` 覆盖 binary。
- Gemini CLI: 用本机 `gemini` 登录态；不要读取 `~/.gemini/oauth_creds.json`。可用 `GEMINI_BIN` 覆盖 binary。

## 多模型协作怎么跑

先 dry-run，不调用模型、不烧额度:

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run noe:consensus:round -- \
  --goal "说明本轮目标" \
  --evidence-file docs/Noe自我进化闭环方案_2026-06-07.md \
  --round-id "dry-run-$(date +%Y%m%d-%H%M%S)"
```

真实调用模型必须显式确认成本:

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run noe:consensus:round -- \
  --goal "说明本轮目标" \
  --evidence-file docs/Noe自我进化闭环方案_2026-06-07.md \
  --round-id "real-round-$(date +%Y%m%d-%H%M%S)" \
  --run-models \
  --ack-cost
```

如果 Codex 没额度，让 Claude 当唯一执行者:

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run noe:consensus:round -- \
  --goal "说明本轮目标" \
  --evidence-file docs/Noe自我进化闭环方案_2026-06-07.md \
  --round-id "claude-executor-$(date +%Y%m%d-%H%M%S)" \
  --active-executor claude \
  --executor-selected-by user \
  --executor-selection-reason codex_quota_unavailable \
  --run-models \
  --ack-cost
```

生成的 ledger 必须满足:

- `implementation.writer` 等于 `implementation.activeExecutor`。
- Claude 当 executor 时必须有 `executorSelection`，例如 `selectedBy: "user"`。
- Claude 当 executor 时 ledger boundaries 必须含 `active_executor_single_writer`，不应要求 `codex_only_writer`。
- Gemini/M3/MiMo 不能写文件；M3 必须保持 suggestion-only。
- post-review 必须排除 active executor，并由其它模型按 dynamic quorum 审查。

## 验证命令

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm test -- tests/unit/noe-execution-authority.test.js tests/unit/noe-consensus-active-executor-gate.test.js tests/unit/noe-consensus-runner.test.js tests/unit/noe-provider-secrets.test.js
npm run verify:noe:self-evolution
npm run verify:handoff
git diff --check -- ':!games/cartoon-apocalypse/**'
```

如果要验证 live P0 freedom API:

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run verify:noe:freedom-live
```

该命令只访问 `51835`，不要碰 `51735`。

## 给 Claude 的执行判断

- 如果用户指定 Claude 执行，你是唯一 writer；Codex 变成 reviewer。
- 如果没有指定，Codex 仍是默认 writer；Claude 只做 reviewer。
- 如果任何模型 unavailable，不要伪装成功；按 unavailable raw output 记录，并让 dynamic quorum 决定是否仍可通过。
- 如果需要 secret access/use，必须有用户授权或 validated dynamic quorum，并且 secret 值不得进入 prompt、raw output、ledger、docs 或聊天。
