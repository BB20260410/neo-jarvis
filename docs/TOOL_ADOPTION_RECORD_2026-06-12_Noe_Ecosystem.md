# TOOL_ADOPTION_RECORD · Noe Ecosystem 2026-06-12

> Repo: `/Users/hxx/Desktop/Neo 贾维斯`. 本记录只登记已安装/接线/烟测或明确 blocked 的 Batch A/B 项。证据主报告：`output/noe-ecosystem-install-2026-06-12/INSTALL_EVIDENCE.md`。

## Accepted Records

```json
[
  {
    "name": "serena-noe-repo",
    "type": "mcp",
    "ownerValue": "提升代码理解、符号概览、引用追踪，补 Noe100 的 observability/recoverability 证据链",
    "risk": "local-write",
    "defaultMode": "developer_enabled",
    "smokeCommand": "node scripts/noe-ecosystem-mcp-register.mjs && node scripts/noe-ecosystem-mcp-smoke.mjs",
    "evidenceRef": "output/noe-ecosystem-install-2026-06-12/mcp-smoke.json",
    "rollback": "在 ~/.noe-panel/mcp-servers.json 禁用或删除 serena-noe-repo；删除 .serena/project.yml 与 output/noe-ecosystem-install-2026-06-12/.venv-serena",
    "acceptedBy": "developer_trial"
  },
  {
    "name": "playwright-local-safe",
    "type": "mcp",
    "ownerValue": "提供本地页面 snapshot/click/screenshot 证据，补行动前后状态与 UI 回归证明",
    "risk": "local-write",
    "defaultMode": "developer_enabled",
    "smokeCommand": "node scripts/noe-ecosystem-mcp-register.mjs && node scripts/noe-ecosystem-mcp-smoke.mjs",
    "evidenceRef": "output/noe-ecosystem-install-2026-06-12/mcp-smoke.json",
    "rollback": "在 ~/.noe-panel/mcp-servers.json 禁用或删除 playwright-local-safe；删除 scripts/noe-playwright-mcp-safe-server.mjs；保留或删除 @playwright/mcp devDependency",
    "acceptedBy": "developer_trial"
  },
  {
    "name": "@lancedb/lancedb",
    "type": "dependency",
    "ownerValue": "长期记忆向量召回 PoC，补 memory eval 与可持久 topK/FTS 证据",
    "risk": "local-write",
    "defaultMode": "disabled",
    "smokeCommand": "node scripts/noe-lancedb-memory-poc.mjs",
    "evidenceRef": "output/noe-ecosystem-install-2026-06-12/lancedb-memory-poc.json",
    "rollback": "保持 NOE_LANCEDB_MEMORY unset；删除 PoC 输出目录与 devDependency；不替换 MemoryCore",
    "acceptedBy": "developer_trial"
  },
  {
    "name": "addy-engineering-skills-selected",
    "type": "skill",
    "ownerValue": "把 source-driven-development、debugging、security、observability 等工程技能纳入 SkillStore，补执行纪律与提示预算控制",
    "risk": "local-write",
    "defaultMode": "developer_enabled",
    "smokeCommand": "node scripts/noe-skillstore-addys-smoke.mjs",
    "evidenceRef": "output/noe-ecosystem-install-2026-06-12/skills-addys-smoke.json",
    "rollback": "删除 ~/.noe-panel/skills 中对应 7 个 skill 目录或在 SkillStore 禁用；不整包导入 Addy",
    "acceptedBy": "developer_trial"
  },
  {
    "name": "sherpa-onnx-node-existing-stack",
    "type": "runtime",
    "ownerValue": "验证现有离线 STT/KWS/VAD/TTS/speaker primitives 与模型路径，补语音本地能力证据",
    "risk": "readonly",
    "defaultMode": "developer_enabled",
    "smokeCommand": "node scripts/noe-sherpa-capability-check.mjs",
    "evidenceRef": "output/noe-ecosystem-install-2026-06-12/sherpa-capability-check.json",
    "rollback": "不新增 Python STT；如需禁用，关闭相关 voice env/服务或卸载 sherpa-onnx-node",
    "acceptedBy": "developer_trial"
  },
  {
    "name": "inspect-ai-three-model-eval-sample",
    "type": "cli",
    "ownerValue": "建立三模型同参数三轮 eval 框架，输出分数、平均、方差，避免 0 分/满分不可区分",
    "risk": "readonly",
    "defaultMode": "developer_enabled",
    "smokeCommand": "node scripts/noe-inspect-ai-eval-sample.mjs",
    "evidenceRef": "output/noe-ecosystem-install-2026-06-12/inspect-ai-eval-sample.json",
    "rollback": "删除 output/noe-ecosystem-install-2026-06-12/.venv-inspect 与脚本；不接入生产推理链",
    "acceptedBy": "developer_trial"
  },
  {
    "name": "@browserbasehq/stagehand-local-poc",
    "type": "dependency",
    "ownerValue": "AI browser observe/act/extract PoC，验证它与 Playwright MCP 的分层：Stagehand 负责高层理解，Playwright MCP 仍是确定性浏览器控制层",
    "risk": "local-model-cost",
    "defaultMode": "disabled",
    "smokeCommand": "node scripts/noe-stagehand-poc.mjs",
    "evidenceRef": "output/noe-ecosystem-install-2026-06-12/stagehand-poc.json",
    "rollback": "保持未注册到主链；删除 devDependency 和 scripts/noe-stagehand-poc.mjs 即可撤销；不替换 Playwright MCP",
    "acceptedBy": "developer_trial",
    "note": "PoC 使用本地 LM Studio qwen/qwen3.6-35b-a3b；LM Studio JSON schema 响应可能落在 reasoning_content，脚本包含隔离 fallback。"
  },
  {
    "name": "github-readonly",
    "type": "mcp",
    "ownerValue": "只读 GitHub repository/search/commits 证据源，避免默认开放写入工具",
    "risk": "readonly",
    "defaultMode": "readonly",
    "smokeCommand": "node scripts/noe-ecosystem-mcp-register.mjs && node scripts/noe-ecosystem-mcp-smoke.mjs",
    "evidenceRef": "output/noe-ecosystem-install-2026-06-12/mcp-smoke.json",
    "rollback": "在 ~/.noe-panel/mcp-servers.json 禁用或删除 github-readonly；删除 scripts/noe-github-mcp-readonly-server.mjs；不启用 deprecated mutating server",
    "acceptedBy": "developer_trial"
  }
]
```

## Blocked Or Not Adopted

```json
[]
```

Batch C（Graphiti、mem0、ToolHive、LiteLLM、Langfuse、CUA、OmniParser）未进入 Noe 主链；依赖、端口、许可、回滚方式仅记录在 `INSTALL_EVIDENCE.md` 的 isolated plan 表。

## 2026-06-13 Operationalization

- 新增统一验收入口：`npm run verify:noe:tool-ecosystem`。
- 报告位置：`output/noe-tool-ecosystem/latest.json`，同时写入时间戳报告。
- 当前入口串联检查：npm 依赖版本、模型 key readiness（只读且不打印 secret）、Obsidian Local REST MCP readiness/plan、Serena/Playwright/GitHub MCP 注册与 smoke、LanceDB memory PoC、Addy-selected skills、Sherpa 本地语音 primitives、Stagehand 本地 LM Studio PoC、Inspect AI eval sample。
- Playwright safe MCP 默认浏览器从 `chromium` 切到系统 `chrome`，因为本机下载 `chrome-for-testing` 多次在 90% TLS 断流；可用 `NOE_PLAYWRIGHT_MCP_BROWSER` 覆盖。
- 最新实测：必需项全过；`model_key_readiness` 作为可选项 blocked，原因是部分云模型 key 未配置，报告不打印 secret 值。

## 2026-06-14 P0 Tool Trial Install

- 新增 devDependencies：`chrome-devtools-mcp@1.2.0`、`@upstash/context7-mcp@3.2.1`。
- 新增隔离 Semgrep CLI venv：`output/noe-p0-tool-install-2026-06-14/.venv-semgrep`，安装 `semgrep==1.166.0`；不污染全局 Python。
- 新增 P0 MCP 注册入口：`node scripts/noe-p0-tool-mcp-register.mjs`，注册：
  - `chrome-devtools-local-safe`：通过 `scripts/noe-chrome-devtools-mcp-safe-server.mjs` 代理，默认 headless + isolated + no usage statistics + no CrUX + redacted network headers，并阻断非 localhost URL 参数。
  - `context7-docs`：Context7 docs MCP，无 API key 默认路径。
  - `semgrep-local-security`：官方 `semgrep mcp --transport stdio`，关闭 metrics/version check。
- 新增 P0 验收入口：`npm run verify:noe:p0-tools`。
- `npm run verify:noe:tool-ecosystem` 已串入 P0 注册和 smoke。

## 2026-06-14 Codex-visible MCP Activation

- 使用 Codex 官方共享 MCP 配置路径写入 `~/.codex/config.toml`：
  - `noe-chrome-devtools-local-safe`
  - `noe-context7-docs`
  - `noe-semgrep-local-security`
- 新增 Codex 可见性验收入口：`npm run verify:noe:codex-mcp`。
- 验收方式不是只检查配置文本，而是通过 `codex mcp get --json` 读取 Codex 自己看到的 server 配置，再用同一 command/args 做 stdio MCP handshake 和 tool call。
- `npm run verify:noe:tool-ecosystem` 已串入 `codex_mcp_smoke`，确保后续总体验证会覆盖“Codex 真实可用”。
