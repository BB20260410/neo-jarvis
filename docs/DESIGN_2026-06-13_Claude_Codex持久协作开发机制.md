# Claude + Codex 持久协作开发机制

日期: 2026-06-13

## 目标

把 Claude 纳入 Neo 开发流程时，不能停留在“临时问一次 Claude”。本机制提供一个固定的 Claude Development Partner:

- Claude 协作者必须使用 `Claude 4.8 Max` 模式；当前 CLI 请求为 `--model claude-opus-4-8 --effort max`。
- Claude 通过 Claude Code CLI 的 `session_id` 续接同一协作者上下文。
- Neo 额外保存显式记忆到 `~/.noe-panel/claude-collaborator/state.json`。
- 每次 Claude 输出都会写入 `output/noe-claude-collaborator/`，供 Codex 复核、引用和回滚。
- 默认仍由 Codex 当 integrator/writer；Claude 负责 plan、review、research、handoff。
- 只有 owner 明确选择 `activeExecutor: "claude"`，并满足 Neo 单写者规则时，Claude 才能进入唯一执行者语义。

## 双方案互审协议

owner 下达任务后，标准流程是:

1. Codex 先建立 shared evidence pack，记录真实文件、命令输出、live 观察、约束和证据 hash。
2. Codex 与 Claude 都基于同一个 evidence pack 读取上下文；Claude 只能把直接看到的证据标为 `direct-read`，不能把 Codex 摘要当成已验证事实。
3. Codex 出独立方案。
4. Claude 通过持久 collaborator session 出独立方案。
5. Codex 审查 Claude 方案，明确哪些要吸收、哪些有风险、哪些需要验证。
6. Claude 审查 Codex 方案，明确哪些要吸收、哪些有风险、哪些需要验证。
7. 任何关键事实分歧都写入 `challengeLog`，必须 `confirmed` 或 `refuted`；存在 `unresolved` 时不得执行。
8. Codex 汇总一版 synthesis，说明怎样取长补短。
9. Claude 复核 synthesis，给出 `agree` / `revise` / `reject`。
10. Codex 只有在自己也认为方案可执行、可验证、可回滚时才给 `agree`。
11. Claude 的计划、互审或 agree 必须能关联 `output/noe-claude-collaborator/*.md` 报告；报告必须包含 `sessionId`、`generatedAt` 和解析出的 `evidence_read`。
12. 两边都 `agree` 后，还必须通过 `readinessCriteria`，再写入 `ready_to_execute` round artifact 并按分工执行。
13. 执行后由 active executor 汇总证据；另一方做 post-review。

这条协议特意避免“Codex 先读代码，Claude 只听 Codex 总结”的假协作。默认做法是共同证据包先行，独立分析随后发生。
`readBy.claude=true` 不能只由 Codex 填写；它必须和 Claude 报告中的 `evidence_read` 对得上。

协议 artifact 入口:

```bash
npm run noe:collab:codex-claude -- protocol --task "任务描述"
```

```bash
npm run noe:collab:codex-claude -- assemble \
  --task "任务描述" \
  --shared-evidence-file output/round/shared-evidence.json \
  --claude-report-file output/noe-claude-collaborator/2026-06-13T08-08-40-644Z-086df25c1c50.md \
  --codex-plan-file output/round/codex-plan.md \
  --claude-plan-file output/round/claude-plan.md \
  --codex-review-file output/round/codex-review-of-claude.md \
  --claude-review-file output/round/claude-review-of-codex.md \
  --challenge-log-file output/round/challenge-log.json \
  --synthesis-file output/round/synthesis.md \
  --readiness-criteria-file output/round/readiness-criteria.json \
  --status ready_to_execute \
  --codex-agreement agree \
  --claude-agreement agree \
  --codex-work-file output/round/codex-work.md \
  --claude-work-file output/round/claude-work.md
```

验证:

```bash
npm run noe:collab:codex-claude -- validate --round-file output/noe-codex-claude-collaboration/<round>/round.json
```

`shared-evidence.json` 示例:

```json
[
  {
    "ref": "src/memory/NoeMemoryGovernanceRepair.js",
    "kind": "file",
    "hash": "sha256:...",
    "requiredFor": ["codex", "claude"],
    "readBy": { "codex": true, "claude": true },
    "notes": "双方直接读取同一证据，避免只依赖摘要。"
  }
]
```

Claude collaborator 调用时也应传入同一份证据清单:

```bash
npm run noe:claude:collaborator -- ask \
  --mode independent-plan \
  --model claude-opus-4-8 \
  --effort max \
  --shared-evidence-file output/round/shared-evidence.json \
  --context src/memory/NoeMemoryGovernanceRepair.js \
  --task "基于 shared evidence 独立分析 Neo 记忆系统" \
  --ack-cost
```

Claude 输出必须包含:

```text
2. evidence_read:
- src/memory/NoeMemoryGovernanceRepair.js (direct-read) - read as context
```

`challenge-log.json` 示例:

```json
[
  {
    "claim": "source_episode 不在强来源类型中",
    "by": "claude",
    "reviewedBy": "codex",
    "decision": "refuted",
    "evidenceRef": "src/memory/NoeMemoryGovernanceRepair.js",
    "note": "真实代码包含 source_episode、source_event、evidence_ref、source_id。"
  }
]
```

`readiness-criteria.json` 示例:

```json
{
  "risksAddressed": true,
  "verificationPlan": true,
  "rollbackPlan": true,
  "singleWriter": true,
  "noSecretLeak": true,
  "costAcknowledged": true
}
```

该验证会阻断缺少独立方案、缺少互审、缺少 synthesis、任一方未 agree、缺少分工、缺少 Claude 报告溯源、Claude 报告未声明读取 required evidence、共享证据未被双方读取、存在 unresolved 争议、challenge 自签、缺少 challenge 证据、或 readiness 条件不足的轮次。`file` 类型 evidence 如果带 `sha256:`，验证会重算当前文件 hash；不匹配先进入 warning，用来提示证据可能过期。

## 入口

```bash
npm run noe:claude:collaborator -- status
```

```bash
npm run noe:claude:collaborator -- ask \
  --mode plan \
  --model claude-opus-4-8 \
  --effort max \
  --task "为当前 Neo 任务制定实现计划" \
  --context docs/HANDOFF_TO_CLAUDE_多模型协作与密钥位置_2026-06-09.md \
  --ack-cost
```

```bash
npm run noe:claude:collaborator -- ask \
  --mode review \
  --model claude-opus-4-8 \
  --effort max \
  --include-diff \
  --task "审查当前 Codex diff，指出风险和缺失验证" \
  --ack-cost
```

```bash
npm run noe:claude:collaborator -- ask \
  --dry-run \
  --task "验证 prompt 和边界，不真实调用 Claude"
```

真实 Claude 调用必须显式传 `--ack-cost`。验证脚本只跑 dry-run，不默认消耗 Claude 配额。
协作者会拒绝非 4.8 模型和非 `max` effort；旧 state 中保存的 `sonnet` 会在加载时迁移为 `claude-opus-4-8`。

## 模式

- `plan`: Claude 给实现计划和风险清单。
- `review`: Claude 审查 Codex 的 diff、测试和证据。
- `handoff`: Claude 生成下一轮交接材料。
- `independent-plan`: Claude 先出独立方案，不迎合 Codex。
- `cross-review`: Claude 审查 Codex 方案，提出采纳点、分歧和验证缺口。
- `synthesis-review`: Claude 审查综合方案是否吸收双方优点。
- `agreement-vote`: Claude 明确输出 `agree` / `revise` / `reject`。
- `active-executor-brief`: 仅用于 owner 明确考虑让 Claude 当唯一执行者前的交接 brief；它本身不授权 Claude 写文件。

## 安全边界

- 不读取 `.env`、API key、token、cookie、OAuth、owner token、Keychain 文件或 `room-adapters.json`。
- `--context` 会拒绝敏感文件和项目根外路径。
- `--include-diff` 只收集过滤后的 tracked diff，并排除 secret-like 文件名与 `games/cartoon-apocalypse/**`。
- Claude 默认以 `--permission-mode plan --tools ""` 运行，不给工具执行能力。
- 不触碰 `51735`。
- 不默认重启、kill 或接管 live `51835`。
- 不 commit、push、reset、clean。
- 不给模型、agent 或多模型调用设置人为硬超时。

## 数据形态

状态文件:

```text
~/.noe-panel/claude-collaborator/state.json
```

关键字段:

- `sessionId`: Claude Code CLI 返回的会话 ID，下次通过 `--resume` 续接。
- `model`: 固定为 `claude-opus-4-8`，代表 Claude 4.8。
- `effort`: 固定为 `max`。
- `requiredMode`: 固定为 `Claude 4.8 Max`。
- `memory`: 从 Claude 输出的 `memory_update:` 提取的短记忆，最多保留 40 条。
- `runs`: 最近运行索引，记录 mode、task hash、report path、cost。

报告目录:

```text
output/noe-claude-collaborator/
```

报告包含任务、Claude 结果、session id、模型和成本，不包含 secret 值。

## 协作纪律

Codex 和 Claude 可以一起开发 Neo，但同一轮只能有一个 writer/integrator:

- 默认: Codex 写，Claude 计划和复核。
- Codex 无额度或 owner 明确要求 Claude 执行: 需要单独记录 `activeExecutor: "claude"` 和 `executorSelection`，然后 Codex 转为 reviewer。
- post-review 必须排除 active executor。
- 不可用模型要记录为 unavailable，不能伪造票或审查。

该机制用于把 Claude 变成持续协作者，不是绕过 Neo 的共识、证据、回滚和安全门。
