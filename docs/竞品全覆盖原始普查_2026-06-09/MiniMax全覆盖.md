这份报告是对 `mmx-cli` (MiniMax CLI) `src/` 目录下所有模块的系统性全覆盖解析，侧重于其架构抽象与核心机制。对于本地 AI 助手（如 Noe），这份报告将阐明如何剥离命令行外壳，将其纯粹作为一个 Node.js SDK 能力库进行无缝集成。
---
### 一、 本地 AI 助手 (Noe) 的集成策略与 SDK 抽象
`mmx-cli` 在设计上实现了 **CLI 路由层与 SDK 核心层的严格解耦**。
**SDK 抽象层次 (`src/sdk/` & `src/client/`)**
所有底层网络请求和重试都被抽象在 `Client` 基类中 (`src/sdk/client.ts`)。`Client` 会读取并挂载由 `http.ts` 提供的 `request/requestJson` 以及 SSE 流式解析能力。而上层的应用端点通过继承 `Client`，形成高度语义化的命名空间：
- `MiniMaxSDK` (`src/sdk/index.ts`) 是整个能力的聚合入口。它将 `TextSDK`, `VideoSDK`, `ImageSDK` 等实例化并挂载为属性。
**Noe 助手集成示例**
Noe 不需要通过 `child_process` 来 spawn 命令行（这既慢又难以捕获复杂错误），而是可以直接将其作为底层能力引入：
```typescript
import { MiniMaxSDK } from 'minimax-cli/src/sdk';
// Noe 的能力工具封装：
const minimax = new MiniMaxSDK({ 
  apiKey: process.env.MINIMAX_API_KEY, // 或通过 OAuth credential
  region: 'global' 
});
// 多模态能力调用：
const videoResult = await minimax.video.generate({ prompt: "一只猫在跳舞", async: false });
const imageResult = await minimax.image.generate({ prompt: "未来城市", width: 1024, height: 1024 });
```
---
### 二、 核心机制深度解析
#### 1. 多模态生成封装策略 (Multimodal Encapsulation)
不同模态因为耗时与返回数据结构的巨大差异，采取了针对性的封装策略：
- **视频 (Video - `src/sdk/video/index.ts` & `commands/video/generate.ts`)**
  - **动态路由校验**：在校验层 (`validateParams`) 实现了不同提示组合的模型降级与自动切换。例如如果提供 `--first-frame` 和 `--last-frame`，会自动切换到支持首尾帧插值 (SEF) 的 `MiniMax-Hailuo-02` 模型；如果提供参考图 (`subject_reference`)，切换到 `S2V-01`。
  - **同步/异步融合**：`generate()` 接收一个 `async` 标识。若为 `true` (对应 CLI 的 `--async` / `--no-wait`)，直接返回 `taskId`；否则内部会无缝调用 `poll()` 阻塞等待直至完成。
- **图 (Image - `src/sdk/image/index.ts`)**
  - **严格规约与尺寸转换**：强制拦截宽高必须是 `8` 的倍数且介于 `[512, 2048]` 之间。
  - **落盘抽象**：提供原生的 `save()` 方法，无缝处理 API 返回的两种情况：`"url"` (CDN 下载) 或 `"base64"` (直接解码写盘)。
- **语音与音乐 (Speech & Music - `src/sdk/speech/index.ts`, `src/sdk/music/index.ts`)**
  - **流式/全量双轨**：二者都支持重载函数签名。可以通过传递 `{ stream: true }` 来获取 `AsyncGenerator` 实现边下边播，或者同步等待 Hex 数据。
  - **二进制重建**：语音接口返回的是 16 进制字符串 (`audioHex`)，SDK 内置了 `hexToBuffer` 函数将 Hex 转回原生 Buffer 防止传输截断。
- **视觉理解 (Vision - `src/sdk/vision/index.ts`)**
  - 内部依赖 `toDataUri()` 工具函数，能够把本地文件路径或者公网 URL 统一转换为 base64 Data URI 上传给 VLM 端点，对外隐藏了文件处理的复杂性。
#### 2. 鉴权体系 (Authentication)
`src/auth/` 模块实现了高度现代化的鉴权瀑布流，核心在 `src/auth/resolver.ts` 和 `src/auth/oauth.ts`：
- **优先级瀑布流**：`resolveCredential` 会按顺序评估：命令行 `--api-key` > 配置文件的 OAuth Token > 配置文件的静态 API Key。
- **设备流 OAuth (Device Code Grant)**：`deviceCodeLogin` (RFC 8628 + PKCE) 是核心机制。向 `/oauth2/device/code` 换取设备码，唤起本地浏览器，随即开启轮询直到用户在网页端点击授权。
- **自动续期 (Token Refresh)**：`src/auth/refresh.ts` 确保在每次请求前，如果发现 token 过期，会向 `/oauth2/token` 发起 refresh 换取新令牌并写回本地配置。
#### 3. 异步轮询抽象 (Asynchronous Polling)
在 `src/polling/poll.ts` 中的 `poll<T>` 函数是所有耗时任务（如视频生成、长文本）的核心基础设施：
- 它接收 `intervalSec` 和 `timeoutSec`，以及判定函数 `isComplete` 和 `isFailed`。
- 在内部维护一个独立于 HTTP 的 `Date.now() < deadline` 阻塞循环。
- 通过引入 `createSpinner`，在 CLI 模式下会呈现动态更新状态文本的效果，当在 SDK 内部或者 `--quiet` 模式下时则默默重试。
---
### 三、 模块职责与机制详尽巡礼
#### 入口与路由
- **`src/main.ts`**：执行 CLI 的全局生命周期（进程信号捕获 `SIGINT`、代理注入 `ProxyAgent`、全局参数 `scanCommandPath` 提取、Auth Setup、大区自动侦测触发）。
- **`src/registry.ts`**：树状 CLI 路由器 (`CommandRegistry`)，负责将 `mmx video generate` 等多段指令挂载到对应的 `run` 逻辑，同时生成层级化 Help 文档（内置终端颜色降级逻辑）。
- **`src/command.ts` / `src/args.ts`**：核心 Parser，不依赖 commander 等重型包。利用原生的状态机逻辑 `parseFlags` 解析出布尔、数字和数组，并支持 `-h`、`--dry-run` 拦截。
#### 核心运行时
- **`src/client/stream.ts`**：实现了非常轻量级的 SSE (Server-Sent Events) 文本块解析器 (`parseSSE`)，用生成器 `yield` 标准的 `{ data: string }` 块。
- **`src/client/endpoints.ts`**：路由池。集中维护如 `v1/video_generation` 或 `/v2/images/generations` 的硬编码 API 路径。
#### 辅助业务模块
- **`src/config/`**：包含 `schema.ts` (定义 Schema/Zod校验)、`loader.ts` (JSON 落盘与加载) 以及非常关键的 `detect-region.ts` (首次输入 Key 时自动请求两地探测并把路由绑定至 CN 或 Global)。
- **`src/errors/`**：`base.ts` 提供了包含建议解决方案与退出码的 `CLIError`；`handler.ts` 是顶层拦截器，控制堆栈打印和红色错误 UI。
- **`src/files/`**：`download.ts` 基于流式抓取和 HTTP `Content-Length` 获取提供带有进度条支持的纯净文件下载。
- **`src/output/`**：丰富的 TTY 适配层。`status-bar.ts` (状态栏)、`quota-table.ts` (用量表格)、`formatter.ts` (支持 `--output json` 直接吐出 JSON 结构供如 `jq` 等外接工具使用)、`audio.ts` (尝试通过本机 `mpv`/`afplay` 播放声音)。
- **`src/update/`**：包含 `checker.ts` (基于 npm registry 发起新版本静默检查) 和 `self-update.ts` (原地 npm 命令执行更新)。
- **`src/utils/`**：实用工具库。包含 `prompt.ts` (基于 `readline` 的交互式 prompt)，`image.ts` (将文件转 base64 URI)，`env.ts`。
#### 命令组 (`src/commands/`)
包含 `auth/`, `config/`, `file/`, `image/`, `music/`, `quota/`, `search/`, `speech/`, `text/`, `video/`, `vision/` 文件夹。它们负责将 `flags` 映射到 `MiniMaxSDK` 方法调用。例如 `commands/video/generate.ts` 处理 `promptOrFail` 的 fallback 交互，并根据 `--subject-image` 构造复杂的 SDK Body 再发起请求。
---
### 四、 覆盖清单校验 (Coverage Checklist)
- [x] **架构概览**: `main.ts` 路由与 `registry.ts` 分发机制解析完毕。
- [x] **SDK模块**: 深度解构了 `src/sdk/` 与基类 `Client`。
- [x] **Client模块**: 解析了 `http.ts`, `stream.ts`, `endpoints.ts` 及其重试/解析机制。
- [x] **Auth模块**: 解析了 `resolver.ts` 的优先级与 `oauth.ts` 的 PKCE 换端机制。
- [x] **Commands模块**: 梳理了 CLI 到 SDK 的映射、互斥配置校验机制。
- [x] **Polling模块**: 剖析了 `poll.ts` 的事件循环与 Spinner 设计。
- [x] **其他基石模块**: 覆盖了 `config`, `errors`, `files`, `output`, `types`, `update`, `utils`。
- [x] **多模态落地**: 全面整理了图片 (`width` 校验与写盘)、视频 (`async` 轮询与 SEF 互斥)、语音/音乐 (hex 处理与 stream 返回)、视觉 (`toDataUri`) 的底层原理。
- [x] **Noe集成指南**: 提供了基于 `MiniMaxSDK` 的 Node.js 化模块直接调用范例。
