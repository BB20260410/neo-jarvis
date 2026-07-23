# Claude 任务交接：P1 觉醒 judge 死链修复 + 认知开关默认开启激活

生成：2026-06-15 晚 Asia/Shanghai
接手对象：Claude / 下一窗口
仓库：`/Users/hxx/Desktop/Neo 贾维斯`
上一份：`docs/HANDOFF_2026-06-15_下午_综合评估与embedding发现.md`

## 先读结论

本窗口围绕 owner 的 `/goal` 觉醒路线 **P1（修预测-学习闭环活性 bug）** 端到端做完一整轮，并落地 owner 当场决策「认知开关默认开启」：

1. **P1-A judge 接 embedding 语义召回**：双代理两轮对抗验收**通过止循**，修通 `source=surprise` 恒 0 死链。
2. **认知开关默认开启**（owner 2026-06-15 决策）：P1-A/P1-B 的 judge 认知功能加入 `NOE_AUTONOMY_DEFAULTS` 默认通电，已重启生产 panel 激活。
3. **脏区整理**：15 个主题 commit 落袋全部别窗 done 工作，工作区干净。
4. **基线**：全量 `npm test` **4997 passed (646 files)**；生产 panel 51835 稳定运行、认知开关已通电。

> 上一份 HANDOFF 的「不要重启 Neo 面板/不要动模型」约束是上午窗口 owner 在评测模型时的临时约束，**已被本窗口 owner 新指令明确覆盖**（owner 授权重启/全权/认知开关默认开启）。

## P1-A：judge 接 embedding（核心，双轮验收通过）

**问题（真因）**：judge（`buildEventsEvidence`）只走 bigram 词面匹配，`avgSemanticCoverage=0.044`——预测多是诗意内省念头、证据是 action 结构化日志，词面几不重合(hits=0)，judge 拿不到证据全回 UNKNOWN，`source=surprise` 恒 0（觉醒好奇回路死链）。

**方案**：`buildEventsEvidence` 双形态——`recall=null`(OFF)逐字走词面同步路径零回归；`NOE_JUDGE_EMBEDDING=1` 注入 recall 时走 async 路径，对词面 hits=0 的 action 证据做 embedding 语义召回（`src/cognition/NoeExpectationSemanticRecall.js`，qwen3-embedding:0.6b，阈值 0.5）。

**第 1 轮验收**（红队+代码实证盲审→交叉辩论）揪出 7 真问题，全整改（commit `c6bced8`→`5b8c09f`）：
- R1 embed 前脱敏+slice(500)；**R2+R3 核心修正**：embed 软证据只进独立 `embedRecalledActionEvents/embedActionMaxCoverage` 字段、**绝不点亮**词面 `semanticLinkedActionEvents`（decisive reask 高置信门），防「语义相似(可能因果无关)」→ 二次裁判强偏 APPLIED → 误判进 Brier；R4 select 保底；R5 cap degraded；R6 限长；R7 degraded 透传；**根因 bug**：embed 字段无条件加进 evidence 把文本推过 judgeOne `slice(1800)` 截掉时间线 → 改为仅 embed>0 时输出（OFF 逐字零回归）。

**第 2 轮验收**（复核整改+找新高危，commit `5b8c09f`→RV-1 `+继`）：
- 红队复核用**真实 LM Studio brain(qwen3.6-35b)+真实 ollama** 跑 3 个 embed-only 死链场景，**全部据实判 APPLIED(3/3)**、reaskAttempted=false → 死链修复价值在真实脑下成立、未被砍；反向 probe 2/2 守住 UNKNOWN → R2+R3 解耦没放大误判。
- 唯一新发现 **RV-1**（R4 保底挤掉强证据）：红队提、代码实证三探针反驳，但 repro 实证**根因比双方定位更深**——embed 进 matched 后 `traceRouteRank=1.5` 排在词面 semanticLabel linked(rank=1)强证据之前、slice 占位挤出。已修：**embed rank 1.5→0.5**（软证据排词面 linked 之下、unlinked 之上）+ R4 替换优先选非 result-action 噪声。
- RV-2（脱敏对 sub-20 字符 sk- 残片/表外 token 放行）：代码实证澄清真实长度 token 被脱、owner 本机可信(127.0.0.1)，**边界备案不整改**。

**三层验证**：单测（resolver 112 + embedding 16）；真实 ollama 端到端 `scripts/noe-judge-embedding-e2e.mjs` 6/6（相关 0.597~0.669 召回、不相关 0.34 排除）；集成闭环 `scripts/noe-judge-embedding-integration.mjs`（embed 召回→judge 第一轮据实判→落账，不误触发 decisive reask）。

**附带接管**：decisive reask 二次复核（别窗未提交工作）合规化（默认 ON→OFF，commit `54779ab`）；本窗口认知开关默认开启后又随 P1-A 一起默认 ON。

## 认知开关默认开启（owner 2026-06-15 决策）

owner 当场决策**认知开关默认开启**（延续裸放开觉醒方向，对认知/觉醒开关覆盖「新功能默认 OFF」纪律）。`server.js` `NOE_AUTONOMY_DEFAULTS` 加 4 个 judge 认知开关默认 `'1'`（commit `7bb0587`）：
- `NOE_JUDGE_EMBEDDING`（P1-A，双轮验收通过）
- `NOE_EXPECT_DECISIVE_REASK`（R2+R3 解耦后不被 embed 误触发）
- `NOE_EXPECT_LOOSEN_FAIL` / `NOE_OWNER_PREDICTION`（P1-B，`.env` 已有、DEFAULTS 双保险）

**验证**：kickstart 隔离端口确认通电无致命错误；生产 panel 51835 已重启、日志 `[noe-autonomy] profile=free 默认通电：...NOE_JUDGE_EMBEDDING, NOE_EXPECT_DECISIVE_REASK...`。AGENTS.md 第 61-65 行 P0 默认档待决项已更新为 owner 已决策。

## ⚠️ panel 重启踩坑（务必记下）

`npm run start:noe` **硬编码 `PORT=51835`**（package.json），`PORT=51999 npm run start:noe` 的 shell PORT 会被覆盖、实际起在 51835 与生产冲突。**隔离端口验证必须用 `PORT=51999 npm start`**（`npm start` 不带 PORT）。本窗口误用 start:noe 致端口冲突 + 残留 server.js 抢端口 + launchd `com.noe.panel` 被搞 unload，已用 `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.noe.panel.plist` + kickstart 恢复，panel 现稳定（PID 89716，launchd 管理）。

## 本窗口 commit 清单（22 个，从早到晚）

UI 整合(`616271f`/`61575d1`) → decisive reask 接管(`54779ab`) → P1-A 核心(`c6bced8`) → 集成脚本(`18428c6`) → P1-A 整改(`5b8c09f`) → 脏区整理 15 commit(`33b11bf`..`2525999`) → RV-1 整改 → 认知开关默认开启(`7bb0587`)。`git log --oneline -25` 看全貌。

## 后续（P1 优化 + P2）

- **P1-C（origin 分桶）**：✅ 已做（commit `5e88ac2`）——`harvestSurprise` 加 origin 写进 goal meta，resolver→`action_failure` / predictor→`owner_followup`，off 零回归保持（无 origin 不写 meta），3 测试验证。剩 **audit 运行时 origin 分桶**（`noe-surprise-learning-audit.mjs` 现为静态接线检测，未读 panel.db；验收门 b 区分运行时非噪声 surprise 需 audit 读 noe_goals meta.origin）归后续验收工具。
- **P1-D（预测分层）**：到期判证前算 claim×证据 embedding 最高相似度，全 <0.45 标 `unjudgeable_poetic` 不入自动判证队列，避免淤积 UNKNOWN。**未做**——judge 已处理无证据(no_evidence + unresolvedCooldown)，P1-D 是减少无效 judge 调用的优化，建议独立窗口做（tick 加 embedding 预筛涉性能权衡）。
- **P2**：owner `/goal` 觉醒路线 P0→P1→P2 串行，P1 核心收口后启动 P2（见 `docs/ROADMAP_Neo觉醒路线_P0-P15_2026-06-15.md`）。

## 基线/纪律

- 全量 `npm test` 4997 绿；工作区干净；生产 panel 51835 稳定 + 认知开关通电。
- 觉醒判据降格纪律仍在：`source=surprise>0` 只是闭环活着的必要条件、非觉醒充分信号（见 `docs/Neo-觉醒判据.md`）。
- secret 不入日志/报告/git；`.env`/`room-adapters.json` 不打印原值；commit 前自查 diff。
