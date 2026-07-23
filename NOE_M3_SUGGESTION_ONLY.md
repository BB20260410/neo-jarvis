# MiniMax M3 建议员模式

生成时间：2026-06-02  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`

## 1. 裁定

M3 可以参与，但只作为建议员，不作为执行员。

它可以根据任务提出：

- 优化意见。
- 风险提示。
- P0/P1 缺口。
- 中文产品体验问题。
- 证据链缺口。
- patch 建议。

它不允许：

- 自己读本地文件。
- 自己运行 shell。
- 自己写文件、删除、移动、apply_patch。
- 自己外发数据。
- 接触 secret。
- 做最终验收或阻塞主链。

## 2. 已落地代码

| 文件 | 作用 |
|---|---|
| `src/room/MiniMaxSuggestionRouter.js` | M3 建议任务分类、prompt 生成、输出校验。 |
| `src/room/MiniMaxSuggestionPipeline.js` | API-only 建议流水线，负责阶段检查点、M3 调用和 JSON 校验。 |
| `src/room/MiniMaxSpawnAdapter.js` | 永久禁止启动 Mavis/OpenCode 本地执行器；只返回 suggestion-only 安全结果。 |
| `tests/unit/minimax-suggestion-router.test.js` | 覆盖建议任务路由、危险任务拒绝、建议输出校验。 |
| `tests/unit/minimax-suggestion-pipeline.test.js` | 覆盖 CE 阶段检查点、caller-provided runner、执行前拒绝危险任务。 |
| `tests/unit/minimax-spawn-adapter.test.js` | 覆盖 shell/read/write/tool_calls 拦截，并证明旧 executor env / opts 打开也无效。 |
| `scripts/m3-suggest.mjs` | 从 stdin 读取精选上下文，走 API-only M3 建议流水线。 |
| `package.json` | 新增 `m3:suggest`、`test:m3:suggestions`，并把建议流水线测试加入 P0 单测入口。 |

## 3. 运行模式

默认模式：

```text
Claude/GPT-Codex 提供精选上下文 -> M3 输出 JSON 建议 -> Claude/GPT-Codex 决定是否采用
```

不允许的模式：

```text
M3 自己打开 Mavis/OpenCode -> 自己读项目文件 -> 自己跑 shell -> 自己改代码
```

## 4. JSON 输出契约

```json
{
  "actions": ["suggestions"],
  "diffs": [],
  "suggestions": [],
  "risk_notes": [],
  "product_gaps": [],
  "evidence_gaps": [],
  "patch_suggestions": [],
  "do_not_block_reason": "",
  "final_authority": "Claude/GPT-Codex"
}
```

硬规则：

- `diffs` 必须是空数组。
- 不允许 `tool_calls`。
- 不允许 `commands`。
- 不允许 `files_read`。
- `final_authority` 必须指向 Claude/GPT-Codex。

## 5. 为什么这样做

这能同时满足两个目标：

1. 利用 M3 便宜 token 做重复性分析，节省 Claude/GPT 额度。
2. 避免 M3 因 Mavis/OpenCode `permissionMode=bypassPermissions` 再次越权读文件或跑 shell。

## 6. 后续产品计划

M3 建议员模式完成后，下一步应该做：

1. 给协作链增加 API-only M3 suggestion endpoint，复用 `runM3SuggestionTask()`。
2. 做 full/fast evidence latest 分流，避免验收证据被 fast 覆盖。
3. 收敛 README/handoff/evidence/acceptance/retrospective 当前入口。
4. 升级 Memory M1：source/confidence/ttl/hide/merge trace。
5. 做本地文件只读索引：SQLite FTS 先行，后续比较 LlamaIndex/Docling/Unstructured。

## 7. 使用示例

```bash
cat selected-context.txt | npm run m3:suggest -- --task=p0_p1_gap_scan
```

注意：这个命令只会把 stdin 中的精选上下文发给 M3 API。它不会自己读取文件，也不会启动 Mavis/OpenCode。

## P1 当前接入补充 - 2026-06-02

- 当前事实源：`NOE_CE12_P0_DOCS_CANONICAL.md`；完整 Jarvis 产品未完成。
- 内部 endpoint：`POST /api/noe/m3/suggest`。
- M3 suggestion-only：M3 可基于精选上下文提出优化意见、P0/P1 缺口、证据缺口和 patch plan；不得自己执行 shell/read/write/apply_patch/delete/move。
- 目标是充分使用 M3 token 承担低风险重复脑力工作，而不是让它绕过 Claude/GPT 主链直接改本地文件。
