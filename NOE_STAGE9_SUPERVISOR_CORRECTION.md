# Noe / Neo 贾维斯 阶段 9 监督纠偏落账

更新时间：2026-06-02 02:34 CST

## 纠偏结论

本文件把 2026-06-01T17:57:48 的监督纠偏写成阶段 9 可传递规则，防止下一位执行者被旧的自动质量门文案带偏。

- 当前阶段是 9「文档编写」，不是回退到旧 CE05「代码开发」返工。
- 本阶段最多讨论 3 轮；当前按第 2/3 轮处理，第 3 轮必须给出可裁定结论：同意推进，或列出真正阻断推进的关键问题。
- 不要沿用旧的“不允许因轮数/输出上限停止”文案；这里的 3 轮上限是本阶段的有效推进规则。
- Claude 可用时，Claude + GPT/Codex 一致通过即可推进。
- Claude 掉线、没额度、限流或 CLI 不可用后，由 GPT/Codex + Gemini 有效成员共识推进。
- Gemini 在 Claude 可用时是审计辅助；只有指出可复验证的安全风险、secret 泄露、路径或权限错误、数据破坏、原项目污染、不可逆操作风险时才阻断。
- 如果没有 secret、路径权限、数据破坏、原项目污染或不可逆风险，按当前阶段交付证据继续推进，不要因旧 CE05 返工文字回退。

## 项目边界

- 只在 `/Users/hxx/Desktop/Neo 贾维斯` 工作。
- 不要修改 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- 不要全量复制 `BaiLongma-audit/`。
- 不要在未审计前启用真实工具执行能力。

## 当前文档体系取舍

当前磁盘已收敛为 `NOE_PHASE9_DOCS_CANONICAL.md` + `NOE_PHASE9_DOCS_VERIFY.mjs` 的单一权威文档体系；不重新引入已删除的 `工作区入口.md`、`NOE_NEXT_EXECUTOR_HANDOFF.md`、`NOE_OPERATIONS_MANUAL.md`、`NOE_PHASE9_DOCUMENTATION.md`、`NOE_PHASE9_VERIFY.mjs`，避免再次制造双源漂移。

该纠偏已同步进入：

- `NOE_PHASE9_DOCS_CANONICAL.md`
- `README.md`
- `CHANGELOG.md`
- `上下文交接.md`
- `任务交接.md`
- `NOE_PHASE9_DOCS_VERIFY.mjs`

## 验证入口

用 Node 22 运行：

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE9_DOCS_VERIFY.mjs
```

验证门必须检查：

- `NOE_STAGE9_SUPERVISOR_CORRECTION.md` 存在。
- 文档包含“最多讨论 3 轮”。
- 文档包含“Claude 掉线、没额度、限流或 CLI 不可用后，由 GPT/Codex + Gemini 有效成员共识推进”。
- 文档包含“不要因旧 CE05 返工文字回退”。
