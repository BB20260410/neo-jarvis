# OpenClaw src/skills 逐文件全读
已完成对 OpenClaw 仓根下 `src/skills/` 目录中 **64 个实质逻辑文件**的全面分析。

以下是分类汇总的详细报告，涵盖每个文件的**核心职责**、**关键机制**，以及特别针对 **Noe (本地AI助手) 能提供的优化与增强策略**。

---

### 1. Workshop 模块 (技能自动化提案与编排)
负责智能总结历史经验并自动生成新的技能 (Skill Drafts)。

*   **`src/skills/workshop/types.ts`**
    *   **职责**: 定义 AI 生成的技能草案和策略配置数据接口。
    *   **机制**: `SkillProposalRecord`, `SkillProposalApplyResult` (状态跟踪类型)。
*   **`src/skills/workshop/store.ts`**
    *   **职责**: 持久化/读取工作区中被提出的技能提案。
    *   **机制**: `readSkillProposalsManifest`, `writeSkillProposal` (通过写入本地 `.json` 保存草案与依赖文件)。
*   **`src/skills/workshop/service.ts`**
    *   **职责**: 编排技能生成、验证及最终落地。
    *   **机制**: `proposeCreateSkill`, `proposeUpdateSkill`, `applySkillProposal`。
*   **`src/skills/workshop/policy.ts`**
    *   **职责**: 控制提案的应用权限。
    *   **机制**: `resolveProposalApprovalPolicy` (判断策略为 `auto` 自动写入，还是需要人工批准 `allow-once`)。
*   **`src/skills/workshop/frontmatter.ts`**
    *   **职责**: 规范化草案自带的 Markdown Frontmatter 元数据。
    *   **机制**: `extractProposalContent` (拆分 YAML 头与具体正文)。
*   **`src/skills/workshop/config.ts`**
    *   **职责**: 提取用户的自动化 Workshop 配置。
    *   **机制**: `resolveSkillWorkshopConfig` (校验并发上限与单文件体积 `maxSkillBytes`)。
> **✨ Noe 优化点**:
> Noe 可作为一个交互式卡片在聊天界面中拦截 `proposeCreateSkill/UpdateSkill`。与其仅仅在后台写入，Noe 可以直接展示左右对照的 Diff 视图 (旧工作流 vs 新总结的规则)，提供“一键批准”或“自然语言反馈微调”的按钮。

### 2. Security 模块 (安全审计机制)
保障技能库加载与运行阶段的安全控制。

*   **`src/skills/security/workspace-audit.ts`**
    *   **职责**: 审计工作区内的隐患情况。
    *   **机制**: `auditWorkspaceSkills` (检测并上报软链接逃逸出工作区目录 `symlink-escape` 的行为)。
*   **`src/skills/security/scanner.ts`**
    *   **职责**: 静态分析可疑技能脚本文件。
    *   **机制**: `scanSkillFiles` (根据 AST/正则检测危险的 Shell 注入等，分为 `critical`, `warn`, `info` 告警级)。
*   **`src/skills/security/clawhub-verdicts.ts`**
    *   **职责**: 向中心注册表拉取插件信用/漏洞评级。
    *   **机制**: `projectClawHubVerdictItem` (处理注册表封禁或漏洞预警状态并格式化)。
> **✨ Noe 优化点**:
> 当 Scanner 报出 `critical` 级危险行为或审计出路径逃逸时，Noe 可以使用大模型自动提供等效且安全的修复代码，一键（如把绝对路径改为安全的相对目录变量）清理用户环境的安全债务。

### 3. Runtime 模块 (运行时环境与监听)
控制代理在运行时所感知和可调用的状态边界。

*   **`src/skills/runtime/tools-dir.ts`**
    *   **职责**: 锚定技能内部工具专用的安全落盘目录。
    *   **机制**: `resolveSkillToolsRootDir` (根据环境做 Safe Hash 计算)。
*   **`src/skills/runtime/tool-dispatch.ts`**
    *   **职责**: 动态下发/屏蔽 Tool 使用权限。
    *   **机制**: `replaceWithEffectiveToolAllowlist` (从上下文剥离未授权技能)。
*   **`src/skills/runtime/session-snapshot.ts` & `snapshot-hydration.ts`**
    *   **职责**: 管理会话执行状态缓存，减少重复解析量。
    *   **机制**: `resolveReusableWorkspaceSkillSnapshot`, `hydrateResolvedSkills` (构建防抖哈希索引)。
*   **`src/skills/runtime/remote.ts`**
    *   **职责**: 管理跨节点执行支持（如支持远程 macOS 技能）。
    *   **机制**: `refreshRemoteNodeBins` (通过 WS 通道预检远程 `system.which`/`system.run` 以声明能力标签)。
*   **`src/skills/runtime/refresh.ts` & `refresh-state.ts`**
    *   **职责**: 文件热重载更新通知。
    *   **机制**: `createSkillsPathWatcher` (封装 `chokidar`，基于 `bumpSkillsSnapshotVersion` 向下广播重加载事件)。
*   **`src/skills/runtime/env-overrides.ts`** (含 `.runtime.ts`)
    *   **职责**: 向特定技能注入受控的环境变量或密钥。
    *   **机制**: `sanitizeSkillEnvOverrides`, `applySkillConfigEnvOverrides` (严厉拦截影响宿主的变量注入，如 `OPENSSL_CONF`)。
*   **`src/skills/runtime/cron-snapshot.ts`** (含 `.runtime.ts`)
    *   **职责**: 为后台定时任务加载轻量级上下文快照。
    *   **机制**: `resolveCronSkillsSnapshot`。
> **✨ Noe 优化点**:
> 1. `env-overrides`: 当加载某技能需要某 API Key 但未配置时，Noe 可自动识别缺失的 `env` 键，在 IDE / Chat 中弹出美观的配置表单收集密钥并自动写入，而不是抛出冷冰冰的 Missing Env 错误。
> 2. `remote`: 如果涉及多节点交互 (如 Linux 上触发了 iOS 的操作)，Noe 可在界面挂载远端机器当前的连通率、延迟指示灯，提升操作透明度。

### 4. Research 模块 (被动知识图谱归纳)
*   **`src/skills/research/text.ts`**
    *   **职责**: 洗稿、提取聊天对话中的核心文本。
    *   **机制**: `extractTranscriptText`。
*   **`src/skills/research/signals.ts`**
    *   **职责**: 意图探测。
    *   **机制**: `extractDurableInstructionProposal` (检测对话中是否存在诸如 "next time", "always", "prefer" 的正则关键字，推理技能大纲标签如 "QA Workflow" 等)。
*   **`src/skills/research/autocapture.ts`**
    *   **职责**: 决定是否触发归档。
    *   **机制**: `runSkillResearchAutoCapture` (串联信号与 Workshop Service 真正落地)。
> **✨ Noe 优化点**:
> Noe 可作为用户的“副驾驶”，在对话中捕捉到 “下次注意……” 这种强关联意图后，自然地回复提示：“我注意到了您的习惯偏好，是否需要我将其提取为持久的 `XXX 规范`？” 让自动化从幕后走向前台交互。

### 5. Loading 模块 (包与元数据的解析加载)
*   **`src/skills/loading/workspace.ts`**
    *   **职责**: 负责文件系统的全域技能寻找与防穿透加载。
    *   **机制**: `loadSkillEntries`, `createSkillDiscoveryBudget` (采用积分预算制寻找 `SKILL.md`，深度超标或同级目录数超标直接断开，防止性能挂起；同时处理用户 Home 目录的 `~` 缩略符替换节约 Token)。
*   **`src/skills/loading/source.ts`**
    *   **职责**: 元信息溯源。
    *   **机制**: `resolveSkillTelemetrySource` (区分为 bundled, workspace, openclaw-managed)。
*   **`src/skills/loading/skill-version.ts`** & `serialize.ts`
    *   **职责**: 唯一性散列与并发控制。
    *   **机制**: `computeSkillPromptVersion` (SHA256)、`serializeByKey`。
*   **`src/skills/loading/skill-contract.ts`**
    *   **职责**: 向大模型喂食所需的 Prompt 数据化。
    *   **机制**: `formatSkillsForPrompt` (输出 `<available_skills>` 标准 XML 字符串)。
*   **`src/skills/loading/session.ts`**
    *   **职责**: 处理忽略规则与合规性。
    *   **机制**: `loadSkillsFromDirInternal` (整合读取目录 `.gitignore`，校验名称是否满足 a-z 0-9 规范要求)。
*   **`src/skills/loading/runtime-config.ts`** & `config.ts`
    *   **职责**: 环境判定合并。
    *   **机制**: `resolveSkillRuntimeConfig`, `evaluateRuntimeEligibility` (依据 `hasBinary` 等验证该节点是否有资格运行)。
*   **`src/skills/loading/local-loader.ts`** & `plugin-skills.ts` & `frontmatter.ts`
    *   **职责**: 插件资源投射与元信息拆解。
    *   **机制**: `openRootFileSync` (受限提取), `publishPluginSkills` (为启用的技能创建安全符号链接以被发现), `parseFrontmatter` (提取 YAML 里的 `install`, `requires` 等标签)。
*   **`src/skills/loading/bundled-dir.ts`** & `bundled-context.ts`
    *   **职责**: 内置核心技能装载。
    *   **机制**: `resolveBundledSkillsDir`。
> **✨ Noe 优化点**:
> 由于 `formatSkillsForPrompt` 将大段 XML 直接放进 Prompt，这极其耗费上下文。Noe 可以在这层引入基于 RAG / 向量匹配的动态过滤机制：只挑选与当前 Query 相似度最高的 5-10 个技能传入给大模型，其余的作为“已知但未激活”存留。

### 6. Lifecycle 模块 (三方技能与注册中心生命周期)
负责下载、验证、安装第三方执行脚本和打包环境。

*   **`src/skills/lifecycle/upload-store.ts`** & `upload-install.ts`
    *   **职责**: 提供上传通道，支持用户侧将私有技能打包上传至宿主机。
    *   **机制**: Idempotency Key 碰撞检测、分块合并 `writeArchiveChunk`、超时 TTL 清理器。
*   **`src/skills/lifecycle/install.ts`** & `source-install.ts`
    *   **职责**: 工具包管理。
    *   **机制**: `buildInstallCommand` (提供对接 `brew`, `npm`, `pnpm`, `uv`, `go` 的安全命令装载，支持 git 指定 commit 克隆与提取)。
*   **`src/skills/lifecycle/archive-install.ts`** & `install-extract.ts` & `install-download.ts` & `install-tar-verbose.ts`
    *   **职责**: 网络包获取与沙箱解压。
    *   **机制**: `fetchWithSsrFGuard` (网络 SSRF 拦截), `extractTarBz2WithStaging` + `checkTarEntrySafety` (防御解压路径污染 zip-slip), 通过 `tar tvf` 输出诊断提取状态。
*   **`src/skills/lifecycle/install-output.ts`**
    *   **职责**: 清理打包错误信息。
    *   **机制**: `formatInstallFailureMessage` (智能截取错误流最后的有效 200 字符，便于终端输出)。
*   **`src/skills/lifecycle/gh-config-discovery.ts`**
    *   **职责**: GitHub 鉴权漂移侦测。
    *   **机制**: `detectGhConfigDirMismatch` (检查执行时的 `HOME`/`SUDO_USER` 是否存在错位，修复无法鉴权拉包的错误)。
*   **`src/skills/lifecycle/clawhub.ts`**
    *   **职责**: 与远端 ClawHub 进行技能拉取和 Lockfile 锁定。
    *   **机制**: `resolveClawHubSkillVerificationTarget`, `performClawHubSkillInstall`, `readClawHubSkillsLockfile`。
> **✨ Noe 优化点**:
> 1. `install.ts` 如果因为当前环境没安装 `brew` (例如在 Ubuntu 或 Docker 内)导致安装依赖中断，Noe 可以识别这一 `stderr`，并在侧边栏提供 "替您翻译为 apt/apt-get 的安装命令" 的修复方案。
> 2. `gh-config-discovery` 的报错对纯非开发人员不友好，Noe 可以直接弹窗提供 "权限错乱，需要输入密码修复 GH_CONFIG_DIR" 一站式操作。

### 7. Discovery 模块 (路由探察与命令映射)
使得终端用户和大模型能以规范的方式检索出有哪些指令可用。

*   **`src/skills/discovery/status.ts`**
    *   **职责**: 完整地给出各技能的健康报表。
    *   **机制**: `buildWorkspaceSkillStatus` (生成包含了 `eligible`, `disabled`, `missing requirements` 等状态图谱的报表)。
*   **`src/skills/discovery/skill-index.ts`** & `filter.ts` & `agent-filter.ts`
    *   **职责**: 技能重命名去重、搜索树构建以及按 Agent 白名单鉴权。
    *   **机制**: `normalizeSkillIndexName`, `resolveEffectiveAgentSkillFilter`。
*   **`src/skills/discovery/command-specs.ts`**
    *   **职责**: 把技能配置文件转换为终端/聊天框识别的快捷命令。
    *   **机制**: `buildWorkspaceSkillCommandSpecs` (检测 yaml 内的 `command-dispatch` 映射为 `/xx` 指令，并解决指令命名冲突后缀递增)。
*   **`src/skills/discovery/chat-commands.ts`** (含 `.runtime.ts`) & `chat-command-invocation.ts`
    *   **职责**: 命令响应分配。
    *   **机制**: `listSkillCommandsForAgents`, `resolveSkillCommandInvocation` (通过正则 `/cmd args` 切分参数并唤起具体 Skill Handler)。
*   **`src/skills/discovery/bins.ts`**
    *   **职责**: 收集并推断所需的所有系统二进制文件。
    *   **机制**: `collectSkillBins`。
*   **`src/skills/config/mutations.ts`**
    *   **职责**: 持久化更新启停状态。
    *   **机制**: `patchSkillConfigEntry` (修改全局/本地配置，拦截 `REDACTED_SENTINEL` 确保敏感 apiKey 读写不丢失)。
> **✨ Noe 优化点**:
> 1. 利用 `status.ts` 暴露出的数据，Noe 可以在其本地 GUI 界面专门开辟一个 "Skill Marketplace/Manager" 页，对异常项红标、对 `userInvocable` 直接呈现为点击运行按钮。
> 2. Noe 可以全面接管 `command-specs.ts` 产出的 `Slash Commands`，让用户在输入框中打出 `/` 时提供丝滑的原生补全菜单，而不是全靠硬敲或 LLM 理解。

---
**附: 本次提取所覆盖的文件清单 (64份)**
`src/skills/workshop/types.ts`
`src/skills/workshop/store.ts`
`src/skills/workshop/service.ts`
`src/skills/workshop/policy.ts`
`src/skills/workshop/frontmatter.ts`
`src/skills/workshop/config.ts`
`src/skills/types.ts`
`src/skills/security/workspace-audit.ts`
`src/skills/security/scanner.ts`
`src/skills/security/clawhub-verdicts.ts`
`src/skills/runtime/tools-dir.ts`
`src/skills/runtime/tool-dispatch.ts`
`src/skills/runtime/snapshot-hydration.ts`
`src/skills/runtime/session-snapshot.ts`
`src/skills/runtime/remote.ts`
`src/skills/runtime/refresh.ts`
`src/skills/runtime/refresh-state.ts`
`src/skills/runtime/env-overrides.ts`
`src/skills/runtime/env-overrides.runtime.ts`
`src/skills/runtime/embedded-run-entries.ts`
`src/skills/runtime/cron-snapshot.ts`
`src/skills/runtime/cron-snapshot.runtime.ts`
`src/skills/research/text.ts`
`src/skills/research/signals.ts`
`src/skills/research/autocapture.ts`
`src/skills/loading/workspace.ts`
`src/skills/loading/source.ts`
`src/skills/loading/skill-version.ts`
`src/skills/loading/skill-contract.ts`
`src/skills/loading/session.ts`
`src/skills/loading/serialize.ts`
`src/skills/loading/runtime-config.ts`
`src/skills/loading/plugin-skills.ts`
`src/skills/loading/local-loader.ts`
`src/skills/loading/frontmatter.ts`
`src/skills/loading/config.ts`
`src/skills/loading/bundled-dir.ts`
`src/skills/loading/bundled-context.ts`
`src/skills/lifecycle/upload-store.ts`
`src/skills/lifecycle/upload-install.ts`
`src/skills/lifecycle/source-install.ts`
`src/skills/lifecycle/install.ts`
`src/skills/lifecycle/install-types.ts`
`src/skills/lifecycle/install-tar-verbose.ts`
`src/skills/lifecycle/install-output.ts`
`src/skills/lifecycle/install-extract.ts`
`src/skills/lifecycle/install-download.ts`
`src/skills/lifecycle/gh-config-discovery.ts`
`src/skills/lifecycle/clawhub.ts`
`src/skills/lifecycle/archive-install.ts`
`src/skills/discovery/status.ts`
`src/skills/discovery/skill-index.ts`
`src/skills/discovery/filter.ts`
`src/skills/discovery/command-specs.ts`
`src/skills/discovery/chat-commands.ts`
`src/skills/discovery/chat-commands.runtime.ts`
`src/skills/discovery/chat-command-invocation.ts`
`src/skills/discovery/bins.ts`
`src/skills/discovery/agent-filter.ts`
`src/skills/config/mutations.ts`
