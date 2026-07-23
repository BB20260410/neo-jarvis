# Noe / Neo 贾维斯 阶段 1：用户想法目标契约（GPT 独立版）

生成时间：2026-06-01 20:38:00 CST  
执行成员：GPT / xike-builder  
当前阶段：1. 用户想法  
工作区：`/Users/hxx/Desktop/Neo 贾维斯`  
依据文档：`HANDOFF_2026-06-01_Noe_融合可行性结论.md`  
目标融合仓库：`https://github.com/xiaoyuanda666-ship-it/BaiLongma`

## 1. 一句话目标

把 `Noe / Neo 贾维斯` 做成新的主产品底座：一个本地优先的 Electron AI 助手，保留 Noe 现有多模型协同、任务执行、安全守卫和交付体系，并在只读审计 BaiLongma 后，分阶段吸收它的 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O 和工具市场思路。

## 2. 用户想法转译

用户不是要求继续维护原来的 Xike Lab 稳定项目，也不是要求把 BaiLongma 原样搬进 Noe。用户要的是一个新的 Noe 产品方向：

- Noe 是主产品和唯一长期演进底座。
- BaiLongma 是架构灵感和可审计模块来源。
- 融合方式是审计后模块化吸收，不是两个项目硬拼。
- 第一件事是只读审计 BaiLongma，而不是写功能代码。
- 后续开发必须围绕 Noe 自身端口、数据目录、安全模型和协同执行体系展开。

## 3. 硬边界

- 只在 `/Users/hxx/Desktop/Neo 贾维斯` 内读写本轮产物。
- 原项目 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板` 只作为历史边界说明，不作为开发目标，不修改。
- BaiLongma 审计目录使用工作区内 canonical path：`/Users/hxx/Desktop/Neo 贾维斯/BaiLongma-audit`。
- 不把 BaiLongma 全量复制到 Noe 源码结构里。
- 不在未完成安全、License、依赖、数据库、工具权限审计前接入 BaiLongma 的工具执行能力。
- 不让 BaiLongma 作为第二个长期服务与 Noe 并行运行。
- 不在阶段 1 启动 Noe 服务、不改代码、不改 UI、不改数据库 schema。

## 4. 明确不可做事项

- 不做“BaiLongma 全量移植”。
- 不做“把 Noe 改造成 BaiLongma”。
- 不跳过 BaiLongma 只读审计直接开发 NoeLoop。
- 不同时推进 NoeLoop、Memory、Brain UI、Voice、Social、工具市场。
- 不开放 exec、fetch、file write 等高风险工具给未审计模块。
- 不占用或破坏原项目 `51735` 端口。
- 不把现有集群协同任务与后台 idle tick 混在一起。

## 5. 本阶段成功标准

阶段 1 结束时，任何成员应该能复述同一个目标：

- 项目名：Noe / Neo 贾维斯。
- 主目录：`/Users/hxx/Desktop/Neo 贾维斯`。
- 原项目：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板`，不得修改。
- 融合对象：BaiLongma。
- 融合策略：Noe 主体 + BaiLongma 模块化吸收。
- 下一阶段：只读审计 BaiLongma，产出 `NOE_BAILONGMA_ARCH_AUDIT.md`。
- 近期技术路线：审计 -> 51835 启动隔离验证 -> NoeLoop -> Memory Core -> Brain UI Lite -> Voice/Social/Jarvis 体验。

## 6. 风险假设

- BaiLongma 的 License、依赖、数据库 schema、外部服务绑定和工具执行权限尚未完全确认，不能直接复用代码。
- BaiLongma 的 TICK loop 如果直接进入 Noe，可能抢占用户任务、消耗模型额度、打断集群协同。
- BaiLongma 的 Memory 与 Noe 现有 EvidenceKnowledge、AgentRun、ActivityLog、Knowledge Center 可能存在数据模型冲突。
- Brain UI 直接并入当前 UI 可能造成路由、状态和视觉体系混乱，第一版应做 Brain UI Lite。
- 语音、社交和工具市场属于后置能力，提前做会扩大安全面和测试面。
- 当前 Noe 工作区已有大量未提交改动，后续成员必须避免无关回滚。

## 7. 工程闭环落地方式

1. 用户想法：本文件固定目标、边界、不可做事项、成功标准和风险假设。
2. 需求分析与拆解：基于本文件拆出 BaiLongma 审计清单、Noe 端口隔离、NoeLoop、Memory Core、Brain UI Lite、Voice/Social/Jarvis 六条需求线。
3. 技术方案设计：先读 `NOE_BAILONGMA_ARCH_AUDIT.md`，再设计 Noe 自己的 loop、memory、UI、工具权限和数据桥接，不照搬 BaiLongma。
4. 任务分配与排期：按“审计 -> 隔离验证 -> 最小闭环 -> 记忆 -> UI -> 语音/社交”串行推进，每阶段有独立验收。
5. 代码开发：阶段 1 不写代码；后续只在 Noe 目录内改动，优先复用 Noe 现有模块和安全守卫。
6. 单元测试：NoeLoop、Memory Core、权限门禁、路由和数据存储必须有窄单测。
7. 集成测试：验证 Noe 端口 `51835`、数据目录 `~/.noe-panel`、owner-token、安全审批和集群协同不回归。
8. 功能验证：通过浏览器或 Electron UI 验证 Brain UI Lite、任务流、记忆召回、暂停/继续、错误可见性。
9. 文档编写：持续更新 `NOE_BAILONGMA_ARCH_AUDIT.md`、阶段交接、验证报告和下一窗口提示。
10. 交付验收：每阶段提供文件证据、命令输出、端口/进程证据、测试结果和剩余风险。
11. 复盘优化：记录范围漂移、安全风险、模型额度消耗、后台 loop 干扰和 UI 可理解性问题。

## 8. 下一阶段衔接

下一阶段不是功能开发，而是只读审计 BaiLongma。建议执行顺序：

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
test -d "BaiLongma-audit" && printf 'BaiLongma-audit exists\n'
find "BaiLongma-audit" -maxdepth 3 \( -name 'package.json' -o -path '*/src/index.js' -o -path '*/src/memory' -o -path '*/src/context' -o -path '*/src/ui/brain-ui' -o -path '*/src/voice' -o -path '*/src/social' -o -path '*/src/capabilities/marketplace' -o -name 'electron' -o -name 'config.json' -o -name 'LICENSE' \) -print | sort
```

如果工作区内审计镜像缺失，按当前路径契约 clone 到 Noe 工作区内：

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
git clone https://github.com/xiaoyuanda666-ship-it/BaiLongma.git BaiLongma-audit
```

审计输出固定写入：

```text
/Users/hxx/Desktop/Neo 贾维斯/NOE_BAILONGMA_ARCH_AUDIT.md
```

## 9. 本阶段实测证据

```text
$ pwd
/Users/hxx/Desktop/Neo 贾维斯

$ test -d 'BaiLongma-audit' && printf 'BaiLongma-audit exists\n' || printf 'BaiLongma-audit missing\n'
BaiLongma-audit exists

$ find 'BaiLongma-audit' -maxdepth 3 \( -name 'package.json' -o -path '*/src/index.js' -o -path '*/src/memory' -o -path '*/src/context' -o -path '*/src/ui/brain-ui' -o -path '*/src/voice' -o -path '*/src/social' -o -path '*/src/capabilities/marketplace' -o -name 'electron' -o -name 'config.json' -o -name 'LICENSE' \) -print | sort
BaiLongma-audit/config.json
BaiLongma-audit/electron
BaiLongma-audit/LICENSE
BaiLongma-audit/package.json
BaiLongma-audit/src/capabilities/marketplace
BaiLongma-audit/src/context
BaiLongma-audit/src/index.js
BaiLongma-audit/src/memory
BaiLongma-audit/src/social
BaiLongma-audit/src/ui/brain-ui
BaiLongma-audit/src/voice
```

## 10. 阶段 1 结论

用户想法已收敛为明确目标：以 Noe 为主产品底座，审计后吸收 BaiLongma 的关键架构思路，严格避开原项目目录和全量搬运风险。下一阶段可以直接进入 BaiLongma 只读架构审计。
