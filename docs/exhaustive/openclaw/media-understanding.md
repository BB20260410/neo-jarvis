# OpenClaw src/media-understanding 逐文件全读
### 媒体理解模块 (Media Understanding) 深度技术调研报告

经过对 `src/media-understanding/` 目录下 32 个核心逻辑文件的逐行审计，该模块构建了一套极具鲁棒性的媒体处理流水线。以下是各核心文件的职责、机制及 **Noe (本地AI助手)** 的优化点分析。

---

#### 1. 核心编排与流水线
*   **`apply.ts` (职责：顶层编排)**
    *   **机制**: 控制 `MsgContext` 的生命周期，初始化缓存，并发调用音/图/视处理，提取文档文本，并将结果回填 Body。
    *   **核心细节**: 包含硬核的 `resolveUtf16Charset`（BOM 探测/零字节分布分析）和 `isMostlyPrintable` 启发式文本探测（apply.ts:167）。
    *   **Noe 优化点**:
        *   **文本探测增强**: 引入更先进的编码检测库或模型，减少对 legacy 编码判断的误报。
        *   **多文档智能合并**: 当存在多个文档时，Noe 可以生成摘要式索引放在 Body 头部，而非简单的拼接。

*   **`runner.ts` (职责：发动机/能力执行)**
    *   **机制**: `runCapability` 实现。负责 Scope 决策、模型选择（支持 `activeModel` 回退）、调用项处理器。
    *   **核心细节**: 自动探测环境中的 CLI（如 `whisper-cli`, `agy`），支持通过 `antigravity` 实现本地图像理解。
    *   **Noe 优化点**:
        *   **动态并发调整**: 根据 CPU 负载动态调整 `concurrency`。
        *   **CLI 自动发现增强**: Noe 可以主动搜索更多本地已安装的推理 CLI 并自动生成 `ModelConfig`。

#### 2. 资源管理与预处理
*   **`attachments.cache.ts` (职责：资源懒加载/安全)**
    *   **机制**: `MediaAttachmentCache` 类，实现本地路径/远程 URL 的透明访问。强制执行 SSRF 策略。
    *   **核心细节**: `ensureLocalStat` (cache:215) 严格校验路径是否在允许的 `roots` 内，防止路径穿越攻击。
    *   **Noe 优化点**:
        *   **持久化二级缓存**: 目前是内存/临时文件缓存，Noe 可以引入基于哈希的持久化缓存，避免重复下载/转录相同的媒体。

*   **`image-input-normalize.ts` (职责：图像格式对齐)**
    *   **机制**: 专门处理苹果生态的 `HEIC/HEIF`，自动转换为 `JPEG`。
    *   **Noe 优化点**:
        *   **智能缩放/裁剪**: 针对 vision 模型通常有 224px/512px 偏好，Noe 可以在此层进行预缩放以节省 Token 并提升速度。

#### 3. 跨模型适配与运行时
*   **`image.ts` (职责：VLM 模型适配)**
    *   **机制**: 适配 GitHub Copilot (Vision), MiniMax, OpenRouter 等。处理 reasoning-only 响应的自动重试。
    *   **核心细节**: `disableReasoningForImageRetryPayload` (image.ts:77) 针对推理型模型（如 o1）的空文本响应进行策略剥离重试。
    *   **Noe 优化点**:
        *   **Prompt 注入优化**: 针对不同模型自动调整 "Respondent in at most N chars" 的措辞位置。

*   **`openai-compatible-audio.ts` (职责：音频 API 标准化)**
    *   **机制**: 标准化的 `/audio/transcriptions` 适配器。
    *   **Noe 优化点**:
        *   **音频切片上传**: 针对超长音频（如 >25MB），Noe 可以实现自动分片转录并合并。

#### 4. 辅助与策略决策
*   **`audio-preflight.ts` (职责：提及检查前置)**
    *   **机制**: 解决群聊中“发一段语音点名机器人”但文字中没有提及的情况。
    *   **Noe 优化点**:
        *   **意图预判**: Noe 可以在预检阶段初步判断用户是否在寻求帮助，从而决定是否唤醒整个 Agent。

*   **`scope.ts` (职责：作用域安全)**
    *   **机制**: 基于 Channel、ChatType 和 SessionKey 的规则匹配（first-match-wins）。
    *   **Noe 优化点**:
        *   **隐私敏感度检测**: 如果检测到图像中可能包含敏感信息（如二维码、身份证），Noe 可以自动应用更严格的 Scope 规则。

---

### 已读逻辑文件清单 (32个)
| 文件名 | 主要职责 |
| :--- | :--- |
| `apply.ts` | 顶层流水线编排 |
| `attachments.cache.ts` | 附件 Buffer/Path 缓存 |
| `attachments.normalize.ts` | 附件结构归一化 |
| `attachments.select.ts` | 附件按策略筛选 |
| `audio-preflight.ts` | 音频预转录 |
| `audio-transcription-runner.ts` | 音频转录执行器 |
| `concurrency.ts` | 并发限制包装 |
| `config-provider-models.ts` | 图像能力发现 |
| `defaults.ts` | 默认参数与注册表解析 |
| `echo-transcript.ts` | 转录结果回传 |
| `entry-capabilities.ts` | 能力标签验证 |
| `image-input-normalize.ts` | HEIC 归一化 |
| `image-runtime.ts` | 图像运行时懒加载 |
| `image.ts` | 模型描述逻辑 |
| `manifest-metadata.ts` | 插件元数据构建 |
| `openai-compatible-audio.ts` | OpenAI 音频 API 适配 |
| `provider-capability-registry.ts` | 能力映射注册 |
| `provider-registry.ts` | 提供者对象注册 |
| `resolve.ts` | 运行参数解析 |
| `runner.entries.ts` | 项处理器 (CLI/Provider) |
| `runner.ts` | 核心 `runCapability` 运行器 |
| `runtime.ts` | 文件/URL 对外接口 |
| `scope.ts` | 作用域决策 |
| `shared.ts` | HTTP 与 FormData 共享工具 |
| `runner.attachments.ts` | 附件辅助 |
| `active-model.types.ts` | 核心类型 |
| `runtime-types.ts` | 运行时类型 |
| `types.ts` | 基础类型 |
| `defaults.constants.ts` | 核心常量 |
| `errors.ts` | 媒体错误定义 |
| `fs.ts` | 文件存取辅助 |
| `provider-id.ts` | ID 归一化 |

**Noe 改进方向总结**: 核心优化点集中在 **"智能感知"**。由于 Noe 是本地助手，它可以在 `apply.ts` 和 `runner.ts` 层引入对系统负载、隐私内容、音频时长的实时感知，从而比静态配置更灵活地选择本地 CLI（省钱）或云端 VLM（准确），并自动处理超限/编码/隐私等边缘情况。
