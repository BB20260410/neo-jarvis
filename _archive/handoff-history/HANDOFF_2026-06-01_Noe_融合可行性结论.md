# 交接文档：Noe / Neo 贾维斯 + BaiLongma 融合可行性结论

日期：2026-06-01  
新软件名：`Noe`  
当前目录名：`Neo 贾维斯`  
Noe 目录：`/Users/hxx/Desktop/Neo 贾维斯`  
原稳定项目目录：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板`  
目标融合仓库：`https://github.com/xiaoyuanda666-ship-it/BaiLongma`

## 一句话结论

这个想法可行，而且方向有价值。正确做法不是把两个项目硬拼在一起，而是让 `Noe` 做主产品底座，吸收 BaiLongma 的持续意识循环、记忆系统、Brain UI、语音和工具生态思路，逐步融合成一个更接近《钢铁侠》Jarvis 的本地优先个人 AI 操作系统。

## 最终判断

可以做。  
能做到。  
但必须先完整下载 BaiLongma 做只读代码审计，不能只看 README 就开始融合。

## 为什么可行

Noe 当前底座强在工程执行：

- Electron 本地桌面壳
- 本地 API 服务
- owner-token 安全保护
- 多模型适配：Claude / GPT / Gemini
- 集群协同
- 项目房间
- 任务执行
- 交付报告
- 附件上传
- lint / unit test / e2e / package 验证体系

BaiLongma 强在 Jarvis 感体验：

- TICK 持续运行机制
- 外部消息优先
- 空闲自主思考
- SQLite 记忆
- L1/L2 双层思考
- 焦点栈
- Brain UI
- 语音系统
- 社交分发
- 工具市场

二者互补：

```text
Noe = 多模型工程执行底座 + BaiLongma 持续意识/记忆/Brain UI 思路
```

## 不推荐的做法

不要这样做：

- 不要把 BaiLongma 整个复制进 Noe。
- 不要把 Noe 改造成 BaiLongma。
- 不要让两个服务长期并行跑。
- 不要一开始就同时做 UI、记忆、语音、社交、工具市场。
- 不要不做安全审计就接入 BaiLongma 的工具执行能力。
- 不要在原项目目录开发 Noe。

## 推荐方案

推荐方案：`Noe 主体 + BaiLongma 模块化吸收`。

Noe 保留：

- Electron 主壳
- 本地服务
- 安全守卫
- owner-token
- 多模型适配
- 集群协同
- 项目房间
- 任务交付
- 测试体系

BaiLongma 吸收：

- TICK loop 思路
- Memory 架构思路
- Focus Stack 思路
- Brain UI 思路
- Voice 思路
- Social I/O 思路
- 工具市场思路

## 主要技术壁垒

### 1. 主循环冲突

Noe 当前是用户发起任务、房间协同、模型执行。  
BaiLongma 是 TICK 持续运行。

如果直接合并，会出现：

- 空闲思考抢占用户任务
- 后台 tick 消耗模型额度
- 项目执行被社交消息打断
- 多模型集群任务和单 Agent 意识流互相污染

解决方式：

- 不直接搬 BaiLongma 主循环。
- 在 Noe 里设计自己的 `NoeLoop`。
- NoeLoop 必须接入 Noe 现有预算、任务、房间、watchdog、abort、owner-token。

### 2. 记忆系统冲突

BaiLongma 有 SQLite / FTS5 / 向量召回。  
Noe 已有 EvidenceKnowledge、AgentRun、ActivityLog、Knowledge Center。

如果直接合并数据库，会非常混乱。

解决方式：

- 先设计 Memory Core 桥接层。
- 不立刻迁移所有表。
- 先分出 user memory、project memory、task memory、focus stack、evidence memory。

### 3. 工具权限风险

BaiLongma 的工具市场和工具执行能力很强，但风险也高。  
Noe 当前已经有安全守卫、审批、owner-token、审计。

如果直接接入 BaiLongma 工具市场，可能打穿安全边界。

解决方式：

- 所有工具必须进入 Noe 审批系统。
- exec / fetch / file write 必须走权限分级。
- 工具调用必须有审计日志。
- 高风险工具不能默认自动执行。

### 4. Electron / 服务架构冲突

BaiLongma 可能有自己的端口、启动方式、Brain UI 服务。  
Noe 已经独立为端口 `51835` 和数据目录 `~/.noe-panel`。

解决方式：

- Noe 做唯一 Electron 主壳。
- BaiLongma 只作为模块来源或参考。
- 不让 BaiLongma 作为独立服务长期并行。

### 5. UI 融合成本

BaiLongma 的 Brain UI 很适合 Noe，但不能直接塞进当前 UI。

解决方式：

- 先做 `Brain UI Lite`。
- 路径建议：`/brain`。
- 第一版只展示任务、思考流、记忆召回、工具调用、模型状态和系统健康。

### 6. 语音和社交复杂度

语音、微信、飞书、Discord、社交分发都很有价值，但会拖慢第一版。

解决方式：

- 第一阶段不做全社交。
- 先做本机语音输入、TTS、桌面通知。
- 微信/飞书/Discord 放第二阶段。

### 7. License 和依赖审计

不能只看 GitHub 首页就复制代码。

解决方式：

- clone 后检查 LICENSE。
- 检查 package 依赖。
- 检查是否有敏感依赖、二进制、外部服务绑定。
- 如果采用代码，保留对应 license 声明。

## 是否必须下载 BaiLongma 分析

必须。

原因：README 只能证明方向，不能证明代码质量、模块边界、安全风险、依赖复杂度、可移植性。

下一窗口必须 clone 到独立审计目录，不要直接放进 Noe 源码树。

建议目录：

```bash
cd /Users/hxx/Desktop
git clone https://github.com/xiaoyuanda666-ship-it/BaiLongma.git BaiLongma-audit
```

## BaiLongma 审计重点

下一窗口需要重点看：

- `package.json`
- `src/index.js`
- `src/memory/`
- `src/context/`
- `src/ui/brain-ui/`
- `src/voice/`
- `src/social/`
- `src/capabilities/marketplace/`
- `electron/`
- `config.json`
- `LICENSE`
- 数据库 schema / migration

输出审计文件：

```text
/Users/hxx/Desktop/Neo 贾维斯/NOE_BAILONGMA_ARCH_AUDIT.md
```

## 真实可用实施路线

### 第 0 阶段：只读审计 BaiLongma

目标：搞清楚哪些能直接复用，哪些只能借鉴。

产出：

```text
NOE_BAILONGMA_ARCH_AUDIT.md
```

验收标准：

- 明确模块结构。
- 明确启动流程。
- 明确数据库和记忆机制。
- 明确 Brain UI 数据协议。
- 明确语音、社交、工具市场依赖。
- 明确可复用模块清单。
- 明确不能直接复用的风险模块。

### 第 1 阶段：Noe 自身启动验证

目标：确保 Noe 改名和隔离后能跑，且不影响原项目。

命令：

```bash
cd /Users/hxx/Desktop/Neo\ 贾维斯
npm run check:panel
PORT=51835 npm start
```

打开：

```text
http://127.0.0.1:51835
```

验收标准：

- Noe 不影响原项目。
- 原项目 `51735` 和 Noe `51835` 可以同时存在。
- Noe 使用 `~/.noe-panel`。

### 第 2 阶段：NoeLoop 最小闭环

目标：做 Noe 自己的持续意识循环最小版本。

只做：

- tick 定时器
- inbox 队列
- idle thought
- active task
- pause/resume
- watchdog
- 事件日志
- UI 状态显示

暂时不做：

- 社交
- 语音
- 完整人格
- 完整 Brain UI

验收标准：

- Noe 空闲时可以生成待办、思考或提醒。
- 用户发消息时优先响应。
- 正在执行项目时不会被 idle tick 打断。
- 出错后能暂停，不拖死整个面板。
- 不会无控制地烧模型额度。

### 第 3 阶段：Memory Core

目标：融合 BaiLongma 的记忆思路，但落到 Noe 自己的数据结构。

功能：

- 长期记忆
- 项目记忆
- 任务记忆
- 焦点栈
- 时间词召回
- 记忆注入
- 记忆压缩
- 用户可查看、删除、修改记忆

验收标准：

- Noe 能记住用户长期偏好。
- Noe 能记住项目上下文。
- Noe 能在后续任务自动召回相关记忆。
- 用户能控制记忆。

### 第 4 阶段：Brain UI Lite

目标：让用户看见 Noe 正在想什么、做什么、卡在哪里。

建议路径：

```text
http://127.0.0.1:51835/brain
```

第一版展示：

- 当前任务
- 当前模型
- 当前思考流
- 记忆召回
- 工具调用
- 集群协同状态
- 系统健康状态

验收标准：

- 用户能看懂 Noe 当前状态。
- 出错时能知道卡在哪。
- 可以暂停、继续、清空队列。

### 第 5 阶段：项目开发模式融合

目标：让 Noe 真正能持续做项目。

功能：

- 一个目标生成一个项目工作区
- NoeLoop 负责长期推进
- 集群协同负责复杂任务分工
- Memory Core 负责上下文连续
- Brain UI 负责可视化监督
- 交付包负责最终结果

验收标准：

- 输入一个项目目标。
- Noe 自动拆解。
- 多模型协同执行。
- 掉线、超时、额度不足能接手。
- 最终输出代码、文档、验证报告、交接文档。

### 第 6 阶段：Jarvis 体验

目标：从能用升级到像 Jarvis。

功能：

- 语音输入
- TTS 回复
- 桌面通知
- 系统状态感知
- 日程/文件/项目提醒
- 可视化动效
- 多渠道入口

这个阶段放后面，不要一开始做。

## 最现实 MVP

第一版 Noe 不要追求完整 Jarvis。

最现实 MVP：

```text
一个本地 Electron AI 助手，
有长期记忆，
有持续任务循环，
能用 Claude/GPT/Gemini 集群协同做项目，
有 Brain UI 显示它正在想什么、做什么、卡在哪里。
```

这个 MVP 可做到。

## 最容易失败的做法

- 直接把 BaiLongma 全部复制进 Noe。
- 同时改 UI、记忆、语音、社交、工具市场。
- 不做安全隔离就开放 exec 工具。
- 不做测试就跑长任务。
- 一开始就追求完整 Jarvis，导致项目失控。

## 给下个聊天框的复制提示

```text
你接手的是 Noe / Neo 贾维斯，不是原来的 Xike Lab 稳定项目。

Noe 目录：/Users/hxx/Desktop/Neo 贾维斯
原项目目录：/Users/hxx/Desktop/00_项目/05_Claude可视化面板
本交接文档：HANDOFF_2026-06-01_Noe_融合可行性结论.md
目标融合仓库：https://github.com/xiaoyuanda666-ship-it/BaiLongma

请只在 Noe 目录工作，不要改原项目。

结论：Noe + BaiLongma 融合可行，但不要硬拼两个项目。Noe 做主产品底座，吸收 BaiLongma 的 TICK loop、Memory、Focus Stack、Brain UI、Voice、Social I/O 和工具市场思路。

下一步第一件事不是写代码，而是只读审计 BaiLongma：
cd /Users/hxx/Desktop
git clone https://github.com/xiaoyuanda666-ship-it/BaiLongma.git BaiLongma-audit

重点看：package.json、src/index.js、src/memory、src/context、src/ui/brain-ui、src/voice、src/social、src/capabilities/marketplace、electron、config.json、LICENSE、数据库 schema。

审计产出写到：
/Users/hxx/Desktop/Neo 贾维斯/NOE_BAILONGMA_ARCH_AUDIT.md

后续路线：
1. 只读审计 BaiLongma。
2. 验证 Noe 自身能在 51835 启动且不影响原项目 51735。
3. 做 NoeLoop 最小闭环。
4. 做 Memory Core。
5. 做 Brain UI Lite。
6. 再做语音、社交和 Jarvis 体验。

重要边界：不要直接把 BaiLongma 全量复制进 Noe；不要不审计就接入工具执行能力；不要在原项目目录开发。
```
