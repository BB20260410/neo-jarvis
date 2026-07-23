# Noe 阶段 1「用户想法」重跑证据

- 日期：2026-06-02
- 工作区：`/Users/hxx/Desktop/Neo 贾维斯`
- 定位：本轮自动验收返工证据，不是目标事实源；唯一目标事实源仍是 `NOE_PHASE1_目标契约_CANONICAL.md`。

## 目标 / 边界 / 成功标准 / 风险

- 目标：Noe / Neo 贾维斯是新的主产品底座；先只读审计 BaiLongma，再分阶段吸收 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O 和工具市场思路。
- 边界：只在 Noe 目录工作；原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 只读；BaiLongma 只读镜像为 `BaiLongma-audit/`；不全量复制、不预接工具执行能力、不搬密钥。
- 成功标准：canonical 覆盖目标、边界、成功标准、风险假设；任一成员能按 8 条复述卡复述同一目标；顶层目标契约唯一；下一阶段从复核审计草稿开始。
- 风险假设：license/依赖/schema/外部 I/O 未复核前不能并入；TICK loop/工具市场/Social I/O 有权限、额度、对外发布风险；端口和目录必须隔离；多成员并发写入可能造成目标漂移。

## 本轮实测命令证据

```text
$ pwd
/Users/hxx/Desktop/Neo 贾维斯

$ test -d BaiLongma-audit && git -C BaiLongma-audit status --short --branch
## main...origin/main

$ node NOE_PHASE1_VERIFY.mjs
结果: 13/13 通过 -> 阶段 1 完成门槛达标
关键证据：C1 四项交付物齐全；C2 顶层目标类 .md = 1 份；C6 51835 空闲且 51735 cwd=/Users/hxx/Desktop/00_项目/05_Claude可视化面板；C13 SHA-256=b9c4f84cad17550e

$ node NOE_PHASE1_GATE.mjs --json
NOE_PHASE1_GATE {"verdict":"PASS","phase1":"13/13","m1":"8/8","sha256":"b9c4f84cad17550e","exit":{"verify":0,"m1":0}}
```

## 11 阶段落地

1. 用户想法：本轮已重跑并确认 canonical 覆盖目标、边界、成功标准、风险假设。
2. 需求分析与拆解：下一步只读复核 `NOE_BAILONGMA_ARCH_AUDIT.md`。
3. 技术方案设计：基于复核结果设计 Noe 自己的 loop、memory、Brain UI Lite 和权限门。
4. 任务分配与排期：按 M0 审计复核、M1 端口隔离、M2 NoeLoop、M3 Memory、M4 Brain UI Lite、M5 Voice/Social/Jarvis 串行推进。
5. 代码开发：阶段 1 不写产品代码；后续只在 Noe 目录改。
6. 单元测试：覆盖 NoeLoop、Memory、权限门、存储和路由。
7. 集成测试：验证 51835、数据目录、owner-token、安全审批和集群协同。
8. 功能验证：验证任务流、记忆召回、Brain UI Lite 和错误可见性。
9. 文档编写：持续更新 canonical、审计报告、交接和验证报告。
10. 交付验收：每阶段提交命令输出、文件证据、端口/进程证据和剩余风险。
11. 复盘优化：记录范围漂移、安全面、模型额度、后台 loop 干扰和成员稳定性。
