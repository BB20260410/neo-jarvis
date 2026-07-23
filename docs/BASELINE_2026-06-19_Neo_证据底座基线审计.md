# Neo 证据底座基线审计

更新时间：2026-06-20T01:36:21+0800

## 边界

本审计是只读基线，不是能力增强实现。

本轮做了：
- 只读聚合 `~/.noe-panel/panel.db` 的计数、状态、引用和覆盖率。
- 只读请求 `GET /health`、`GET /api/noe/readiness`、`GET /api/noe/acts?limit=1`，确认 live `51835` 在线、readiness 通过、acts 详情路由受 owner-token 保护。
- 运行安全面 targeted tests。
- 生成可复跑脚本和报告。

本轮不做：
- 不读取 memory body、prompt body、owner token、`.env`。
- 不读取或写入 `evals/neo/private_holdout`。
- 不写 memory-v2。
- 不执行 act，不触发工具动作，不重启或接管 `51835`。
- 不把 source-only 安全测试等同于 live 攻击证明。

## 产物

- 脚本：`scripts/noe-baseline-audit.mjs`
- JSON 报告：`output/noe-baseline-audit/latest.json`
- Markdown 报告：`output/noe-baseline-audit/latest.md`
- 本轮实机报告：`output/noe-baseline-audit/baseline-audit-1781890581760.json`
- no-live 复跑报告：`output/noe-baseline-audit-no-live-check/latest.json`

## 当前基线

| 维度 | 当前证据 | 解释 |
|---|---:|---|
| visible memory | 505 / 2656 | 来自 `noe_memory` 聚合；不导出正文 |
| sourceEpisodeCoverage | 37.99% | 记忆来源 episode 覆盖仍不足 |
| retrieval rows | 759 | 来自 `noe_memory_retrieval_log` |
| retrieval selected row rate | 89.99% | 日志选中覆盖，不等于语义正确率 |
| retrieval selected / inferred dropped | 2993 / 2029 mentions | hit_ids - selected_ids 推断 dropped；只做排序代理 |
| tool passed rate | 96.96% | `agent_tool_results`: passed 894 / total 922 |
| tool invoked events | 17 succeeded | `noe.tool.invoked`: kg search 8、memory recall 7、fs hybrid search 2 |
| act completed rate | 96.26% | `noe_acts`: completed 2855 / total 2966 |
| failed acts | 110 | top failure: `browser_dom_host_mismatch` |
| blocked safety acts | 1 | `config.write` 无真实 executor |
| approvals | approved 168 / pending 54 | pending 队列需与 act 成功率分开解释 |
| permission decisions | allow 4665 / deny 2117 / ask 1193 | 来自 `events` 聚合 |
| live `51835` health/readiness/protected acts | ok / passed / 401 | 只读 GET，无 owner token、无重启、无 action |

## Retrieval 分层

| route | rows | selected row rate | avg hits | avg selected | avg dropped |
|---|---:|---:|---:|---:|---:|
| chat | 728 | 91.48% | 6.81 | 4.03 | 0.68 |
| mission | 20 | 60% | 2.55 | 2.25 | 0.15 |
| reflection | 8 | 37.5% | 0.63 | 0.63 | 0 |
| maintenance | 3 | 66.67% | 3.33 | 3.33 | 0 |

结论：chat 路径覆盖可用；mission/reflection 样本少且 selected coverage 偏弱，不能声称“召回语义质量已达标”。下一步需要把 NeoEval 的 `memory_retrieval_log` case 接入评分器。

## Selected / Dropped 排序代理

| bucket | mentions | distinct | avg salience | avg hit count | avg confidence | hidden mention rate |
|---|---:|---:|---:|---:|---:|---:|
| selected | 2993 | 113 | 4.882 | 121.576 | 0.856 | 12.5% |
| inferred dropped | 2029 | 158 | 3.496 | 18.61 | 0.837 | 10.99% |

结论：selected 集合在 salience 和 hit_count 上明显高于 inferred dropped，说明当前排序/预算裁剪有可解释性；但这仍然只是日志代理，不读取正文，也不证明语义相关性。语义质量必须由 NeoEval labeled cases 评分。

## Runtime / Tool / Verify

| 项 | 证据 |
|---|---|
| tool result status | `passed:894`, `approval_required:28` |
| tool invoked audit events | `succeeded:17` |
| act status | `completed:2855`, `failed:110`, `blocked_safety:1` |
| executed events | latest report `executedEventCount:2853` |
| failure reasons | `browser_dom_host_mismatch:110`, `real executor not registered for config.write:1` |
| checkpoint proxy | latest report act evidence done 2775，act evidence blocked 110 |

结论：act/tool 的总体完成率足够作为 baseline，但 browser DOM host mismatch 是明确可靠性缺口。`verify fail` 当前只能用 act failure / checkpoint evidence 做 proxy，还没有独立 verifier-accuracy 指标；不能把这些历史 DB 失败称为 RuntimeTrace `stage=verify,status=failed`。

注意：这些 runtime/event 数字是 `output/noe-baseline-audit/latest.json` 在 `2026-06-19T00:49:16.604Z` 的快照。live `panel.db` 会继续增长，后续窗口需要重新跑脚本刷新，不要把本文档里的计数当实时真相。

## Live 51835 只读证明

| probe | result | 解释 |
|---|---|---|
| `GET /health` | 200 / `ok:true` / port 51835 | 服务在线 |
| `GET /api/noe/readiness` | 200 / `passed` / blockers `[]` | readiness 通过 |
| `GET /api/noe/acts?limit=1` | 401 / `owner_token_required` | act 详情路由受保护 |

结论：本轮能证明 live `51835` 在线、公开健康检查可读、readiness 通过、受保护 act 详情需要 owner token。不能证明“本轮刚执行过 action”，因为没有触发任何 action。

## 安全面

本轮 targeted tests：

```text
tests/unit/ssrf-guard.test.js
tests/unit/routes/img-cache-ssrf.test.js
tests/unit/noe-p0-tool-safety.test.js
tests/unit/noe-tool-marketplace-registry.test.js
tests/unit/noe-skill-draft-apply.test.js
```

结果：5 files / 58 tests passed。

结论：
- SSRF / img-cache / tool safety / tool marketplace / skill draft 路径已有可运行测试。
- 这仍是测试证据，不是 live exploit probe。
- prompt injection / tool poisoning 还需要进入 NeoEval synthetic_guard / incident_regression scoring，不能只靠静态存在性。

### P1 风险点

| 风险 | 状态 | 路径 |
|---|---|---|
| remote plugin / MCP URL 未统一证明走 `SsrfGuard` | needs follow-up | `src/plugin/PluginHttpAdapter.js`、`src/mcp/McpStore.js`、`src/mcp/McpClientManager.js` |
| MCP stdio 继承完整 `process.env` | needs follow-up | `src/mcp/McpClientManager.js`、`src/plugin/PluginSpawnAdapter.js` |
| `ownerTrust=full` 默认值是能力/安全取舍 | documented owner policy tradeoff | `src/permissions/PermissionGovernance.js` |
| link understanding 标记 untrusted 但下游 prompt placement 仍需 eval | needs eval guard | `src/research/NoeLinkUnderstanding.js`、`src/voice/VoiceSession.js` |
| skill scan 默认/重载行为还不能证明覆盖旧 skill poisoning | needs follow-up | `src/skills/NoeSkillScanner.js`、`src/skills/SkillStore.js` |
| `GET /api/skills/:name` 返回 skill body 的鉴权预期需归类 | needs follow-up | `src/server/routes/skills.js` |
| MCP Aggregator 默认关闭；未来启用前要保留 permission/audit hook | needs follow-up if enabled | `src/mcp/McpAggregator.js` |

## 验证

| 验证 | 结果 |
|---|---|
| `node --check scripts/noe-baseline-audit.mjs` | pass |
| `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-baseline-audit.mjs --probe-live` | pass，blockers `[]`，health/readiness/protected acts 均符合预期 |
| `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-baseline-audit.mjs --out-dir output/noe-baseline-audit-no-live-check` | pass，blockers `[]`，不触碰 live |
| Runtime Trace + NeoEval regression | 3 files / 17 tests passed |
| NeoEval offline scorer | schema smoke 4/4 pass；replay collection 33/40 pass、7/40 fail；raw/score artifacts validate pass |
| security targeted tests | 5 files / 58 tests passed |
| high-signal secret scan over baseline script/output/doc | no matches |

## 缺口

- labeled memory recall quality 已有离线 selected-id/dev scorer 起点；仍缺更大规模人工标签和 private_holdout 隔离评分。
- 缺独立 verifier accuracy：当前只有 failed act / checkpoint proxy。
- 缺 runtime action 的按 executor 覆盖矩阵：当前能看 action/status，但未分 executor 能力边界。
- prompt injection / SSRF / tool poisoning 已有 synthetic/incident smoke scorer 起点；仍需扩充为系统回归门。
- approvals pending 54，会影响“可执行能力”的解释，应在后续报告中单独展示。
- remote plugin/MCP、MCP stdio env、skill body route、MCP Aggregator 等 P1 风险需要后续按切片验证或修复。
