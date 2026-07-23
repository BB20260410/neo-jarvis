# 交接文档：Noe 新软件分支 + BaiLongma 融合方向

日期：2026-06-01  
新软件名：`Noe`  
新软件目录：`/Users/hxx/Desktop/可视化面板_新软件分支_2026-06-01`  
原项目目录：`/Users/hxx/Desktop/00_项目/05_Claude可视化面板`  
目标融合开源项目：`https://github.com/xiaoyuanda666-ship-it/BaiLongma`

## 一句话总结

Noe 是从 Xike Lab / Claude 可视化面板独立复制出来的新软件分支，目标不是继续做“面板”，而是融合 BaiLongma 的数字意识/持续运行/记忆/语音/社交/Brain UI 思路，做成一个更接近《钢铁侠》里 Jarvis 的本地优先个人 AI 操作系统。

## 当前产品身份隔离

Noe 已完成基础隔离，避免破坏原项目：

- 产品名：`Noe`
- npm 包名：`noe`
- Electron appId：`com.hxx.noe`
- 默认端口：`51835`
- 默认数据目录：`~/.noe-panel`
- owner token：`~/.noe-panel/owner-token.txt`
- launchd label：`com.hxx.noe.panel51835`
- Electron 输出目录：`out-noe`
- 默认日志：`/tmp/noe-panel-51835.log`

原项目仍保留：

```text
/Users/hxx/Desktop/00_项目/05_Claude可视化面板
```

Noe 新分支只在这里开发：

```text
/Users/hxx/Desktop/可视化面板_新软件分支_2026-06-01
```

## BaiLongma 当前公开信息速记

来自 GitHub 仓库 `xiaoyuanda666-ship-it/BaiLongma`：

- 项目定位：`Bailongma — 数字意识框架`。
- README 描述其为持续运行的数字意识实验框架，不是传统一问一答聊天程序。
- 核心机制：由 `TICK` 驱动，外部消息优先响应，空闲时基于记忆、任务和上下文自主思考。
- 内置能力：SQLite 记忆系统、L1/L2 双层思考、上下文注入、焦点栈、语音系统、多平台社交分发、工具市场、ACUI 可视化组件、Brain UI 监控面板。
- 默认 Web 入口包括 Brain UI：`http://127.0.0.1:3721/brain-ui`。

## Noe 的产品方向

Noe = Xike Lab 的多模型工程执行能力 + BaiLongma 的持续意识循环。

目标形态：

- 本地优先，不把用户长期数据交给云端平台托管。
- 像 Jarvis 一样长期在线，有记忆，有任务，有语音，有主动提醒，有工具执行能力。
- 能调用 Claude / GPT / Gemini / 本地模型 / OpenAI-compatible providers。
- 能把多个模型组织成“集群协同”，做项目开发、调研、复盘、代码执行。
- 能通过 Brain UI 风格的界面展示思考流、任务状态、记忆召回、工具调用和系统健康。

## 融合开发建议架构

### 第一层：Noe Shell

沿用当前面板的 Electron、本地服务、owner-token、安全守卫、房间、模型适配器、集群协同。

职责：

- 桌面壳
- 本地 API 服务
- 模型/插件/技能桥接
- 项目房间和交付包
- 安全守卫、预算、审计、E2E

### 第二层：Conscious Loop

引入 BaiLongma 的 TICK 思路，但不要直接粗暴复制。

建议先实现 Noe 自己的 `NoeLoop`：

- 外部消息优先
- 后台任务队列
- 空闲 tick
- 长任务 watchdog
- 模型调用 abort / retry
- 任务暂停、恢复、交接

### 第三层：Memory Core

融合 BaiLongma 的 SQLite + FTS5 + 向量召回思路，和现有 EvidenceKnowledge / AgentRun / ActivityLog 打通。

目标：

- 用户长期记忆
- 项目记忆
- 任务记忆
- 交付记忆
- 时间词召回
- 焦点栈压缩

### 第四层：Voice + Social I/O

参考 BaiLongma 的语音与社交分发，但 Noe 第一版建议先只做：

- 本机语音输入
- TTS 回复
- 桌面通知
- 微信/飞书/Discord 等放到第二阶段

### 第五层：Brain UI / Jarvis UI

当前面板 UI 作为后台控制台基础，后续重做 Noe 前台：

- 思考流可视化
- 任务雷达
- 记忆地图
- 工具调用时间线
- 项目驾驶舱
- 语音状态环
- 多模型协同状态

## 重要边界

1. 不要在原项目目录开发 Noe。
2. 不要让 Noe 默认使用 `51735`。
3. 不要让 Noe 默认使用 `~/.claude-panel`。
4. 不要让 Noe 和原项目共用 launchd label。
5. 不要把 BaiLongma 代码直接全量粘进 Noe；先做接口层和架构映射，再选择模块迁移。
6. 先审 BaiLongma license 和依赖，再决定是否复制代码、引用代码或只借鉴架构。

## 下一步建议

### 阶段 1：只读审计 BaiLongma

目标：搞清楚它能融合什么，不能融合什么。

要做：

- clone / inspect BaiLongma 到独立目录，不要放进 Noe 源码树。
- 阅读 `package.json`、`src/index.js`、`src/memory/`、`src/ui/brain-ui/`、`src/voice/`、`src/social/`。
- 输出 `NOE_BAILONGMA_ARCH_AUDIT.md`。

### 阶段 2：Noe 品牌与启动验证

目标：证明新软件身份隔离后能跑。

命令：

```bash
cd /Users/hxx/Desktop/可视化面板_新软件分支_2026-06-01
npm run check:panel
```

启动：

```bash
PORT=51835 npm start
```

打开：

```text
http://127.0.0.1:51835
```

owner token：

```bash
cat ~/.noe-panel/owner-token.txt
```

### 阶段 3：NoeLoop 最小闭环

先不要做庞大 Jarvis。先做最小闭环：

- tick 循环
- inbox 队列
- idle thought
- active task
- watchdog
- pause/resume
- UI 状态显示

### 阶段 4：Memory Core

把当前项目证据库和 BaiLongma 记忆思路融合：

- long-term memory
- project memory
- task memory
- focus stack
- memory injection
- memory compression

### 阶段 5：Jarvis 体验

最后再做用户可感知的 Jarvis 体验：

- 语音输入/输出
- 主动提醒
- 系统资源感知
- 桌面操作工具
- 项目执行代理
- Brain UI

## 本轮没有做的事

- 没有启动 Noe 服务。
- 没有跑测试。
- 没有 clone BaiLongma。
- 没有改原项目。
- 没有 git commit / push。

## 给下个聊天框的复制提示

```text
你接手的是 Noe，新软件分支，不是原来的 Xike Lab 稳定项目。

Noe 目录：/Users/hxx/Desktop/可视化面板_新软件分支_2026-06-01
原项目目录：/Users/hxx/Desktop/00_项目/05_Claude可视化面板
Noe 交接文档：HANDOFF_2026-06-01_Noe_BaiLongma融合.md
目标融合仓库：https://github.com/xiaoyuanda666-ship-it/BaiLongma

请只在 Noe 目录工作，不要改原项目。

Noe 已完成基础隔离：
- 产品名：Noe
- npm 包名：noe
- Electron appId：com.hxx.noe
- 默认端口：51835
- 数据目录：~/.noe-panel
- owner token：~/.noe-panel/owner-token.txt
- launchd label：com.hxx.noe.panel51835
- Electron 输出目录：out-noe

产品目标：基于当前 Xike Lab 的多模型/集群协同/项目开发能力，融合 BaiLongma 的 TICK 持续运行、记忆系统、语音、社交分发、Brain UI 和工具市场思路，做一个更接近钢铁侠 Jarvis 的本地优先个人 AI 操作系统。

下一步不要急着复制 BaiLongma 代码。先做只读审计：
1. clone / inspect BaiLongma 到独立目录。
2. 阅读 package.json、src/index.js、src/memory、src/ui/brain-ui、src/voice、src/social。
3. 输出 NOE_BAILONGMA_ARCH_AUDIT.md。
4. 再设计 NoeLoop、Memory Core、Voice/Brain UI 的融合路线。

启动 Noe 前先检查：
cd /Users/hxx/Desktop/可视化面板_新软件分支_2026-06-01
npm run check:panel

启动 Noe：
PORT=51835 npm start

打开：
http://127.0.0.1:51835
```
