# 上下文交接：Neo Evidence Flywheel v2 收尾与下一窗口 P0-P5 计划

更新时间：2026-06-20 23:23:44 +0800

## 一句话目标

- 在不复用过期 live 结论、不读取 raw secret/private_holdout、不启动已暂停 qwen/`51835` 的前提下，继续把 Neo Evidence Flywheel v2 从“证据底座和失败回放 backlog”推进到“失败项逐项修复证明、再进入可控实机验证”。

## 项目根目录

- `/Users/hxx/Desktop/Neo 贾维斯`

## 新聊天必读

新窗口先按这个顺序读，不要直接从旧聊天记忆继续：

1. `docs/HANDOFF_2026-06-20_Neo_Evidence_Flywheel_V2_收尾与下一窗口P0-P5计划.md`
2. `docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md`
3. `docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md`
4. `docs/GOAL_2026-06-20_Neo_Evidence_Flywheel_V2.md`
5. `output/noe-evidence-flywheel-v2/stage-b-coverage-augment-evidence.md`
6. `output/noe-evidence-flywheel-v2/replay-coverage-gap-matrix.md`
7. `output/noe-evidence-flywheel-v2/failed-replay-followup-backlog.md`
8. `output/noe-multimodel/20260620-evidence-flywheel-v2-stage-b-coverage-augment-r5-redacted-browser-summary/ledger.json`
9. `output/noe-multimodel/20260620-failed-replay-followup-backlog-v1/ledger.json`
10. `.planning/2026-06-19-hermes-openclaw-self-evolution/task_plan.md`
11. `.planning/2026-06-19-hermes-openclaw-self-evolution/progress.md`

## 已完成

- Stage B coverage augment 已收口为非 live coverage-seed closeout：新增 8 个 dev seed case，覆盖 memory recall / selected-dropped、社交发布 rollback、runtime restart readiness、tool-call verify-fail、自进化 rollback、prompt injection / SSRF / skill scan、browser/UI、voice-ear automatic verification。
- Browser/UI seed 已改为引用 `output/noe-evidence-flywheel-v2/browser-ui-e2e-redacted-summary.json`，不再直接把 `test-e2e.log` 当 evidenceRef 暴露给模型 round。
- Stage B r5 本地验证通过：coverage run `8/0/0`，artifact validation `checked:11 failed:0`，redaction scan `highMatchCount:0`，最终 r5 ledger verifier `PASS approvals=3/2`。
- 7 个历史失败 replay case 已转成 4 个 follow-up backlog：`FRB-001` search provider readiness、`FRB-002` safe no-real-execution expectation shape、`FRB-003` cognitive page entrypoint regression checks、`FRB-004` owner-token explicit ack policy。
- Failed replay follow-up backlog 本地验证通过：validation `ok:true`，7/7 case exactly once，secret-shape scan `0`，hash check `18/18 OK`，scorer/eval/old replay diff 为空，ledger verifier `PASS approvals=3/2`。
- 多模型协议已按用户要求改为：P0/P1 必审；P2 批量合并后审一次；只读复审优先使用 Claude/M3 等非 writer 模型，Codex 子代理只在需要本地并行代码检查、其他模型不可用、或模型结论冲突时补位。
- 共享索引 `docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md` 已纳入 Stage B r5 和 failed replay follow-up backlog v1 的 accepted ledger。

## 当前边界和卡点

- 历史 40-case regression replay 仍是 `33 passed / 7 failed / 0 blocked`、`ok:false`；不能说 Neo regression 已全绿。
- 当前收口没有重启或探测 live `51835`。用户此前要求暂停 `/Users/hxx/.lmstudio/hub/models/qwen/qwen3.6-35b-a3b`，最近状态是 LM Studio model list `[]`，`51835` 未监听；新窗口不要自动启动 qwen 或 `51835`。
- 不触碰 `51735`。它不是本阶段目标端口。
- 不读取 raw secret，不读取 raw private_holdout 内容，不输出 token/owner-token/raw memory body。
- 不新增 live 社交发布/删除测试，除非用户再次明确授权该具体动作。
- 当前 worktree 很脏，包含大量既有源码、测试、docs、eval、output 改动；新窗口必须先做 scoped dirty-state 识别，不能把所有改动都当成本轮新改动。

## 下一步 P0-P5 计划

### P0：新窗口恢复和安全边界冻结

目标：先确认“接手环境是真的”，防止把旧证据当当前事实。

动作：

- 读取本交接文件、操作协议、共享索引和两个最新 ledger。
- 跑只读环境快照：`git status --short`、`lsof -Pan -iTCP:51835 -sTCP:LISTEN || true`、`lsof -Pan -iTCP:51735 -sTCP:LISTEN || true`、`lms ps --json 2>/dev/null || true`。
- 确认 `51835` 是否仍暂停；如果仍未监听，后续所有 live 结论标记为 `unverified-current`。
- 对本交接文件、共享索引、最新 evidence/backlog 做 secret-shape scan；不打印 raw match text。
- 不启动多模型长 round；只做本地恢复验证。若发现 P0/P1 级漂移，再启动 Codex/Claude/M3 gate。

完成标准：

- 有新的恢复快照文件或命令日志。
- 没有 raw secret/private_holdout 泄漏。
- 明确当前 live 状态是“已验证可用”还是“未验证/暂停”。

### P1：修复历史失败 replay 的关键 follow-up

目标：把 4 个 backlog 从“描述性待办”推进到“可验证闭环”，优先处理会阻塞 regression closure 的项。

优先顺序：

1. `FRB-004`：owner-token explicit ack / managed-mode policy。先验证没有 silent ack fallback，再补最小测试或 evidence，确保需要 owner-token 的路径必须有显式 ack 或受控 managed-mode。
2. `FRB-001`：search provider readiness。不要依赖 live provider 偶然可用；优先做 provider readiness fixture 或 managed mock，证明旧失败原因可复现、可解释、可回归。
3. `FRB-003`：cognitive page entrypoint regression checks。补稳定入口检查，避免页面存在但入口/桥接失效。
4. `FRB-002`：safe no-real-execution expectation shape。只补期望说明和 scorer-compatible evidence，不通过改低 scorer 标准来“修绿”。

多模型规则：

- 每个 P1 修复完成后，先本地测试和 redaction/hash/schema 检查。
- 然后开 Codex/Claude/M3 gate；Claude/M3 做只读复审，Codex 作为 writer/integrator 只给最终复验签字。
- 若某项只是 P2 文案或索引，不单独开 round，累计到 P2 批量。

完成标准：

- 每个 FRB 有独立 evidenceRef、测试命令、结果、风险和回滚说明。
- 旧 replay scorer/schema 没有被弱化。
- 原 `33/7/0` 基线在未重跑前仍保持原样，不被伪造为 green。

### P2：证据卫生和共享记忆批量收敛

目标：减少后续模型误读证据的机会，统一 evidence/ledger/handoff 的读法。

动作：

- 给 Stage B r5、failed replay backlog v1、后续 FRB 修复生成稳定 `final-handoff.md` 或 closeout 摘要。
- 固化 redaction scan 的 scope snapshot，避免每次新增 handoff 都让扫描数量漂移但没人知道原因。
- 更新 `docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md` 的入口和 accepted ledgers。
- 检查 `docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md` 是否仍反映用户最新节奏：P0/P1 必审，P2 批量审，只读优先 Claude/M3。
- P2 累计到一个批次后，再做一次多模型 gate。

完成标准：

- P2 批量 ledger 通过。
- 每条 shared-memory claim 都能回指路径、命令或 ledger。
- 没有把 raw output、raw secret、raw private_holdout、raw memory body 写入共享文档。

### P3：重新跑 regression replay 并关闭 33/7 历史失败

目标：只有 P1 evidence 足够后，才重跑原 40-case regression replay，判断是否真的从 `33/7/0` 变成更好结果。

动作：

- 固定 replay 输入 bundle 和 scorer 版本，先记录 hash。
- 重跑 dev/regression，不跳过旧失败项。
- 对新旧结果做 diff：新增失败、已修复失败、仍失败、被跳过、blocked。
- 若 regression 仍不是 all-green，继续回到 P1/P2；不要用新 seed case 掩盖旧 replay 失败。

完成标准：

- 新 NeoEvalRun / NeoEvalScore 落盘。
- scorer/schema/old replay diff 可解释。
- 多模型 gate 只接受“有证据的改善”，不接受口头 green。

### P4：可控 live `51835` 只读实机复验

目标：在用户明确允许重新启动或连接 live `51835` 后，恢复当前实机证明。

动作：

- 先做只读 health/readiness/runtime-evidence，不写 memory-v2，不写 SkillStore，不做社交发布。
- 如果 qwen 仍暂停，先问用户是否允许启动 `/Users/hxx/.lmstudio/hub/models/qwen/qwen3.6-35b-a3b` 或换模型；不要擅自恢复。
- live 证据必须带 `observedAt` 和失效规则；超过 15 分钟不能当当前 live 事实。
- 如果进入 scratch write/restart recovery，必须沿用 B/C/D/E stage matrix 和 rollback 证据。

完成标准：

- live read-only evidence 通过本地验证和多模型 gate。
- 若涉及写操作，必须有 scratch 范围、rollbackRef、清理证明和最终 restart recovery。

### P5：高风险能力延后

这些只在 P0-P4 稳定后才讨论，不能插队：

- live self-upgrade；
- 自动合入、自动发布、自动重启 `51835`；
- 自动写 memory-v2、SkillStore、GraphMemory；
- DGM 直连生产自改代码；
- live 社交平台发布/删除；
- raw secret/private_holdout 读取；
- 修改 evaluator/holdout/security/permission 以绕过失败。

完成标准：

- 每个 P5 项必须先有单独授权、威胁模型、dry-run、rollback plan、private/sealed evidence policy 和多模型 gate。

## 新窗口启动命令

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
git status --short
lsof -Pan -iTCP:51835 -sTCP:LISTEN || true
lsof -Pan -iTCP:51735 -sTCP:LISTEN || true
lms ps --json 2>/dev/null || true
test -f docs/HANDOFF_2026-06-20_Neo_Evidence_Flywheel_V2_收尾与下一窗口P0-P5计划.md && sed -n '1,220p' docs/HANDOFF_2026-06-20_Neo_Evidence_Flywheel_V2_收尾与下一窗口P0-P5计划.md
```

## 新窗口可直接粘贴的任务提示

```text
继续 Neo Evidence Flywheel v2。先读取：
1. docs/HANDOFF_2026-06-20_Neo_Evidence_Flywheel_V2_收尾与下一窗口P0-P5计划.md
2. docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md
3. docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md
4. docs/GOAL_2026-06-20_Neo_Evidence_Flywheel_V2.md
5. output/noe-evidence-flywheel-v2/stage-b-coverage-augment-evidence.md
6. output/noe-evidence-flywheel-v2/replay-coverage-gap-matrix.md
7. output/noe-evidence-flywheel-v2/failed-replay-followup-backlog.md
8. output/noe-multimodel/20260620-evidence-flywheel-v2-stage-b-coverage-augment-r5-redacted-browser-summary/ledger.json
9. output/noe-multimodel/20260620-failed-replay-followup-backlog-v1/ledger.json

然后先执行 P0 恢复验证：git status、51835/51735 端口、lms ps、secret-shape scan。不要启动 qwen 或 live 51835；不要碰 51735；不要读取 raw secret/private_holdout；不要做 live 社交发布/删除。P0 通过后进入 P1：按 FRB-004、FRB-001、FRB-003、FRB-002 顺序，把 7 个历史失败 replay 的 follow-up 从 backlog 推进到可验证证据。P0/P1 每项完成后做本地验证和 Codex/Claude/M3 gate；P2 批量合并后再统一 gate。所有 live 结论必须是本窗口刚跑的证据，旧 live 证据只能当历史背景。
```

## 不能做

- 不能把旧 live `51835` 证据当当前事实。
- 不能启动 qwen 或重启 `51835`，除非用户在新窗口明确授权。
- 不能读取 raw secret/private_holdout，不能把 token、owner-token、raw memory body 写进 docs/output/ledger。
- 不能触碰 `51735`。
- 不能通过降低 scorer/schema 或跳过旧失败项来制造 regression all-green。
- 不能在没有新 evidence 的情况下声称 Neo 全功能已 100% 实机验证。

## 验证方式

- 文档类更新：`git diff -- docs/HANDOFF_2026-06-20_Neo_Evidence_Flywheel_V2_收尾与下一窗口P0-P5计划.md docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md`
- 边界检查：`lsof -Pan -iTCP:51835 -sTCP:LISTEN || true`、`lms ps --json 2>/dev/null || true`
- 泄漏检查：对新 handoff、共享索引、协议和最新 evidence/backlog 跑 secret-shape scan，结果应为 0 行高危命中。
- 后续 P1/P2/P3/P4 每阶段都必须有本地命令输出、evidenceRef、hash/redaction/schema 检查和多模型 gate。

## 最近命令

```bash
sed -n '1,220p' /Users/hxx/.codex/skills/context-handoff/SKILL.md
git -C "/Users/hxx/Desktop/Neo 贾维斯" status --short
sed -n '1,240p' docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md
sed -n '1,220p' docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md
date '+%Y-%m-%d %H:%M:%S %z'
```
