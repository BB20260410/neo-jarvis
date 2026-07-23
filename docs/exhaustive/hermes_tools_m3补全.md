# M3 补全分析 hermes_tools

# Hermes 工具模块逐文件分析 → Noe 优化点

---

## 1. `hermes/tools/approval.py` (危险命令审批系统)

### 📌 职责
危险命令模式的检测、会话级审批状态、CLI/Gateway 双通道交互、智能 LLM 辅助审批、永久白名单持久化、插件钩子。

### ⚙️ 关键机制
1. **YOLO 模式冻结**：`_YOLO_MODE_FROZEN = is_truthy_value(os.getenv("HERMES_YOLO_MODE", ""))` 在模块导入时一次性求值，杜绝"技能运行时改 env → 立即绕过审批"的提示注入升级路径
2. **ContextVar 多会话隔离**：`contextvars.ContextVar` 绑定 session_key/turn_id/tool_call_id，解决 Gateway 在 executor 线程并发跑 agent turn 时进程全局 env 竞态
3. **Cron 模式识别**：`_is_gateway_approval_context()` 显式排除 `HERMES_CRON_SESSION`，避免 cron 任务提交"无人监听"的 pending 审批而永久阻塞
4. **shell 展开归一化**：`_normalize_command_for_detection()` 把 `$HOME`/`${HERMES_HOME}`/`~/` 在检测时统一 rewrite，把静态 pattern 与运行时路径解耦（避免 `HERMES_HOME` 后设置导致 pattern 失效）
5. **政策文件双侧防护**：`~/.hermes/config.yaml` 既在 `file_tools._check_sensitive_path` 拦截写入，又在 terminal 端拦截 `sed -i/tee/cp`（单侧 deny 形同演戏）
6. **smart_approval 辅助 LLM**：对低风险命令自动放行（减少人工摩擦），高风险仍走人工
7. **plugin 钩子**：`pre_approval_request` / `post_approval_response` 两阶段可观察点
8. **永久白名单持久化**：`config.yaml` 内嵌 allowlist 跨会话复用

### 🎯 Noe 优化/改进/完善点

| 序号 | 优化点 | 具体落地方案 |
|------|--------|--------------|
| **A1** | **YOLO/dev-mode 启动期冻结** | Noe 的 `governance.security.yolo` / `bypassApproval` 应该在 `bootstrap.ts` 进程启动时立刻读取并 freeze 成 const，**禁用**运行期通过 IPC、Electron `process.env`、技能 `process.env` 覆写。需要新增 `frozenAt: Date` 字段记入审计。 |
| **A2** | **ContextVar → Node AsyncLocalStorage 适配** | Noe 现在是 Node+Electron，需要用 `node:async_hooks.AsyncLocalStorage` 替换 Python 的 `contextvars`，给每个 IPC 通道、每个 renderer 窗口、每个 bridge turn 绑定独立 session context，**避免主窗口与子窗口审批状态串扰**。 |
| **A3** | **Cron 路径特殊化** | Noe 的 `schedule/cron/*` 任务走"无人工审批"路径（审批系统只记录不阻塞），用 `mode: "observe-only"`，并在审计中强制打 `cron_supervised=true` 标签。 |
| **A4** | **shell 归一化检测** | Noe 的 `executor` 在执行前过一遍 `normalizeForDetection()`：把 `~`/`$HOME`/`${NOE_HOME}` 全部展开，**避免 `cat ~/Noe/config.yaml` 绕开 sensitive path 检查**。 |
| **A5** | **政策文件双侧拦截** | Noe 的 `~/.noe/config.yaml`（含 quorum 阈值、approval 模式、永久白名单）必须在**写文件工具**和**shell 工具**两侧都做 deny，并加入"NoeConfigGuard"中间件监听 mtime 变化立即刷新 config cache（Hermes 注释里专门强调的"mid-session 翻转"攻击）。 |
| **A6** | **多模型 consensus 参与审批分级** | Noe 已有 consensus，可把"敏感命令分级"也升级为 consensus：低风险走 quorum 1 快速放行；中风险 quorum 3；高风险（如涉及 `~/.ssh`、`config.yaml`、`rm -rf`）强制 quorum 5 + 人工 confirm。`smart_approval` 改成"低风险模型单独给风险分"，不是单点决定。 |
| **A7** | **审批插件钩子 → Noe EventBus** | 暴露 `onApprovalRequest` / `onApprovalResponse` 两个事件，给 Noe 现有的 `Freedom` 社交链可选择性广播"高风险操作待审批"（让信任的同伴代为审批），可作为多代理协作的安全通道。 |
| **A8** | **永久白名单带签名** | Noe 的白名单条目应支持 `signature: ed25519(...)`，避免恶意插件自行追加 `rm -rf /` 到 allowlist。 |

---

## 2. `hermes/tools/browser_camofox.py` (Camofox 反检测浏览器后端)

### 📌 职责
通过 REST API 桥接到自托管的 **Camoufox**（Firefox 分支，C++ 指纹伪装），为浏览器工具提供 1:1 接口映射 + 抗指纹探测能力。

### ⚙️ 关键机制
1. **REST → 工具接口映射**：accessibility snapshot（带元素 ref）/ click/type/scroll by ref / screenshot
2. **模式优先级**：`BROWSER_CDP_URL`（`/browser connect` 显式连接的真实浏览器）> `CAMOFOX_URL`（反检测后端）> 默认 Playwright
3. **VNC 探测缓存**：从 `/health` 响应里 `vncPort` 提取并缓存，给 UI 提供实时观察通道
4. **Docker loopback URL 重写**：`http://127.0.0.1:3000` → `http://host.docker.internal:3000`（opt-in，host 模式不开）
5. **profile-scoped 身份**：开启 `managed_persistence` 时用 `uuid5(NAMESPACE_URL, "camofox-user:" + scope)` 生成稳定 userId，让 Camofox 把多个会话映射到同一持久化 profile
6. **adopt existing tab**：可恢复已存在的 tab ID（重启/崩溃后继续）
7. **外部 identity override**：集成方可设 `CAMOFOX_USER_ID` 强制让 Hermes 跑在同一浏览器 profile
8. **snapshot 80K 字符上限**：远大于 Playwright 默认，避免 a11y 树被截断

### 🎯 Noe 优化/改进/完善点

| 序号 | 优化点 | 具体落地方案 |
|------|--------|--------------|
| **B1** | **反检测浏览器为可选后端** | Noe 默认走 Playwright/Chromium，加 `NOE_BROWSER_BACKEND=camofox` 时走反检测后端（适合爬取风控严格的站点）。Electron 设置面板可一键切换。 |
| **B2** | **VNC 实时预览嵌进 Electron** | Noe 是 Electron，可把 VNC URL 渲染为 `BrowserView` 子窗口叠加在主界面右下角（"浏览器代理中" 透明层），用户实时看到 agent 在做什么，**透明度优先**。 |
| **B3** | **profile-scoped 持久身份** | 用 `uuid.v5(NAMESPACE_URL, "noe:browser:" + userDataPath)` 派生 userId，让 Noe 的多个会话/多窗口共享同一浏览器 profile（cookie、localStorage 跨会话保留）。 |
| **B4** | **Docker/容器化部署** | Noe 可提供 Docker compose 一键起 Camofox + 主进程，并把 `CAMOFOX_REWRITE_LOOPBACK_URLS` 默认开。 |
| **B5** | **Loopback 重写做成可配置 proxy** | 不仅是 docker 场景，Noe 若作为远程服务运行在用户家但让浏览器跑在云端，也需要类似 host alias 重写。抽象成 `BrowserProxyRule` 配置。 |
| **B6** | **80K snapshot 上限自适应** | Noe 应让 snapshot 字符上限随模型 context window 动态调整（4o-mini 走 20K，claude-200k 走 100K），同时配合"按需 element ref 展开"。 |
| **B7** | **身份 override 给插件系统** | 让 Noe 插件可以 `setBrowserIdentity(userId)`，比如"我的金融插件要求跑在固定带 cookie 的会话里"。 |

---

## 3. `hermes/tools/browser_cdp_tool.py` (原生 CDP 透传)

### 📌 职责
向 DevTools WebSocket 端点发送**任意** CDP 命令，作为高层 browser_navigate/click 等工具未覆盖场景（native dialog、iframe、cookie、网络控制）的逃生口。

### ⚙️ 关键机制
1. **优先级**：`BROWSER_CDP_URL` (env, `/browser connect` 设) > `browser.cdp_url` (config.yaml)
2. **Target 多路复用**：`Target.attachToTarget` + `flatten=True` 把 page-level session 复用到 browser-level WebSocket
3. **async-from-sync 桥**：用 `ThreadPoolExecutor(max_workers=1)` + `asyncio.run` 隔离事件循环（避免 `RuntimeError: This event loop is already running`）
4. **`max_size=None`**：CDP `DOM.getDocument` 响应巨大，不能截断
5. **ping_interval=None**：CDP 服务器不发 ping，开着反而触发不必要的 close
6. **超时 + ID 匹配循环**：忽略 events，只匹配 `msg.id == call_id` 的响应

### 🎯 Noe 优化/改进/完善点

| 序号 | 优化点 | 具体落地方案 |
|------|--------|--------------|
| **C1** | **CDP 透传作为底层 escape hatch** | Noe 的浏览器工具链（基于 Playwright）上层应包一层 `noe.browser.cdp(method, params, targetId?)` 透传方法，覆盖 dialog、network throttle、cookie 注入等 Playwright API 弱或不直观的场景。 |
| **C2** | **Node 版的 async-from-sync 桥** | Noe 天然就是 async，**不需要**这层桥。但应该保留"从同步函数内调 CDP"的能力（部分旧 IPC handler 仍是同步），用 `deasync` 或 `child_process.execSync` 风格的包装。 |
| **C3** | **权限分层** | CDP 透传是高权限操作，应要求 Noe 现有的 `governance.tier >= 3` 才暴露，并加入审批钩子（任何 `Network.deleteCookies` / `Page.handleJavaScriptDialog` 都需要 confirm）。 |
| **C4** | **CDP endpoint 自动降级** | 主连接断了自动从 `browser.cdp_url` 列表里挑下一个，**断点续连**。 |
| **C5** | **TargetID 缓存 + 复用** | attachTarget 一次后缓存 sessionId，避免每次 cdp_call 都重新 attach，提高 throughput。 |
| **C6** | **加入 vision 桥** | 把 CDP `Page.captureScreenshot` 直接喂给 Noe 现有的 vision 通道（OCR、UI 元素识别），**视觉能力 + 浏览器能力联动**。 |

---

## 4. `hermes/tools/browser_dialog_tool.py` (Native JS 对话框响应)

### 📌 职责
agent 调用 `browser_dialog` 接受/拒绝/响应 `alert/confirm/prompt/beforeunload` 等 native 对话框。

### ⚙️ 关键机制
1. **响应式（response-only）**：先 `browser_snapshot` 看 `pending_dialogs`，再调此工具响应
2. **CDP-only gating**：与 `browser_cdp_check` 同源判断（仅在 CDP 端点可达时注册），Camofox (REST-only) 和默认 Playwright 都不暴露
3. **多 dialog 队列**：`dialog_id` 消歧（罕见，但有 case）
4. **prompt 专用参数**：`prompt_text` 仅 prompt 有效，其他类型忽略
5. **task-scoped supervisor registry**：`SUPERVISOR_REGISTRY[task_id]` 拿当前 CDP supervisor

### 🎯 Noe 优化/改进/完善点

| 序号 | 优化点 | 具体落地方案 |
|------|--------|--------------|
| **D1** | **Dialog 自动策略** | 99% 的 `confirm()` agent 应该自动点 OK（无害且阻塞 agent），仅在 `prompt` 且要求敏感输入（密码、token）时才拦截。Noe 可加白名单 origin + 默认策略配置。 |
| **D2** | **Dialog 桥到人类 UI** | Noe 是 Electron，**关键 dialog 直接弹一个 native 通知**（"agent 正在等您填这个 prompt"），用户一键填回；不要在控制台等着。 |
| **D3** | **多 dialog 队列用 MemoryCore 记录** | 把待处理 dialog 持久化到 Noe 的 `MemoryCore`（FTS），session 重建时可查询"上次的 pending dialog 是什么"。 |
| **D4** | **gating 改成能力声明** | `browser_dialog` 的可见性应该跟随 Noe 现有的"工具能力注册中心"，按"是否连上 CDP"动态挂载/卸载，类似动态能力发现。 |
| **D5** | **beforeunload 特殊处理** | `beforeunload.accept` = 放行导航；`dismiss` = 留下。Noe 可让用户配"agent 是否允许离开当前页面"，避免 agent 误跳丢失上下文。 |

---

## 5. `hermes/tools/ansi_strip.py` (ANSI 转义序列剥离)

### 📌 职责
从子进程输出剥除 ANSI 转义序列，**防止模型把转义码"学"进 file write 造成污染**。

### ⚙️ 关键机制
1. **完整 ECMA-48 覆盖**：CSI（含 `?` 私有模式、冒号分隔参数、中间字节）、OSC（BEL/ST 终止）、DCS/SOS/PM/APC、nF 多字节、Fp/Fe/Fs 单字节
2. **8-bit C1 控制字符**：`\x9b` (CSI) / `\x9d` (OSC) / `[\x80-\x9f]`（其他 C1）
3. **fast path**：`re.search(r"[\x1b\x80-\x9f]")` 没命中直接返回原文，**绝大部分干净输出零开销**
4. **DOTALL flag**：OSC 字符串可跨行

### 🎯 Noe 优化/改进/完善点

| 序号 | 优化点 | 具体落方面案 |
|------|--------|--------------|
| **E1** | **Node 端用 `ansi-regex` 或 `strip-ansi` 包** | 没必要自己写，直接用成熟包（npm `strip-ansi` 已被 30+ 大项目用）。但 Hermes 这种自研完整 ECMA-48 覆盖对**反检测场景**更鲁棒，可保留自研路径。 |
| **E2** | **剥 ANSI 后再过 MemoryCore 的 FTS** | 终端输出含 ANSI 时，Noe 的 FTS 索引会污染（"38;5;196mERROR" 这种 token 没意义），应**strip 后再入库**。 |
| **E3** | **保留为可选 raw 模式** | Noe 的 UI 渲染需要 ANSI 颜色（用户看），但**模型**收到的是 stripped。明确两层：`rawOutput` (UI) / `modelOutput` (stripped)。 |
| **E4** | **剥 OSC 标题序列** | OSC 0/1/2 会改 terminal title，剥掉也避免模型在 ssh 场景把"title hack"学进去。 |
| **E5** | **注入到 exfiltration 检测** | 现在 Noe 没有"模型输出里包含 ANSI" 的检测。可以在文件写入前 strip 一次（防止 model 把 `\x1b[31m` 写进代码文件），呼应 Hermes 注释里"root cause"。 |

---

## 6. `hermes/tools/browser_camofox_state.py` (Profile-scoped 身份)

### 📌 职责
为 Camofox 持久化 profile 派生**稳定**的 userId 和 session key。

### ⚙️ 关键机制
1. **uuid5 派生**：`uuid.uuid5(NAMESPACE_URL, "camofox-user:" + scope_root)` 取 hex[:10]，**确定性 + 跨重启稳定**
2. **双层 scope**：`userId` profile 级（跨 session 复用）、`session_key` 任务级（一个 logical browser task 内复用）
3. **路径解耦**：身份不依赖任何运行时文件状态

### 🎯 Noe 优化/改进/完善点

| 序号 | 优化点 | 具体落地方案 |
|------|--------|--------------|
| **F1** | **通用 profile identity 服务** | 把这个模式抽成 Noe 的 `core/profile-identity.ts`：`deriveStableId(namespace, scope, salt)`，给 browser、cache、temp dir、audit log 全部提供稳定派生 ID。 |
| **F2** | **可移植性** | Noe 现在 Electron `app.getPath('userData')` 决定 scope，建议把 scope 改成 `path.resolve(app.getPath('userData'))` + 配置文件名（避免重装系统 userData 路径变了导致身份变化）。 |
| **F3** | **身份加密** | userId 直接暴露在请求里，建议 Noe 加上"per-profile 加密 salt"（用 OS keychain 存储），避免其他本地进程枚举出 userId。 |
| **F4** | **session_key 改名"task_key"** | 命名更准确，与 Noe 现有的 "taskId" 概念一致。 |

---

## 7. `hermes/tools/binary_extensions.py` (二进制扩展名黑名单)

### 📌 职责
为基于文本的文件操作（diff、grep、read）提供跳过列表。

### ⚙️ 关键机制
1. **`frozenset` 存储**：O(1) lookup
2. **分类清晰**：图片/视频/音频/归档/可执行/Office/字体/字节码/数据库/设计/Flas/锁文件
3. **有意排除 `.pdf`**：注释明确说"agent 可能想解析"，**默认当文本处理**
4. **大小写无关**：`.lower()` 后比较

### 🎯 Noe 优化/改进/完善点

| 序号 | 优化点 | 具体落地方案 |
|------|--------|--------------|
| **G1** | **迁移到 Noe 的 file-magic 检测** | 仅靠扩展名不够（.txt 里塞 .exe 头），Noe 可加**双层检测**：先扩展名（O(1) 快路径），再用 `file-type` npm 包读前 4KB（magic bytes）。对模型保护更严密。 |
| **G2** | **多媒体单独路径** | 视频/音频不是"跳过文本处理" 而是 **"走 vision/audio 通道"**。Noe 已有 vision/voice，应把"看到 .mp4 → 自动调帧抽取"作为工具能力。 |
| **G3** | **Office 文档 → 文本抽取** | `.docx/.xlsx/.pptx` 应自动走 mammoth/exceljs 抽出 markdown 喂给模型，不要直接当二进制拒绝。 |
| **G4** | **二进制文件元数据单独存储** | 跳过文本处理，但 Noe 仍应记入 MemoryCore："见过这个文件 23MB mtime=... 不可读"，保留 awareness。 |
| **G5** | **大文件阈值** | 1.5GB 文本文件也是问题，加 size 阈值（>50MB 一律拒绝文本读取）。 |

---

## 8. `hermes/tools/__init__.py` (包命名空间)

### 📌 职责
tools 包的初始化与命名空间，**严格控制副作用**。

### ⚙️ 关键机制
1. **不主动 import 子模块**：`import tools` 不应触发 `tools.terminal_tool` 等加载（避免在 `hermes_cli.config` 初始化过程中循环依赖）
2. **导出一个轻量 `check_file_requirements()`**：转调 `terminal_tool.check_terminal_requirements()`
3. **显式文档**：建议调用者直接 `from tools import browser_tool` 而非 `import tools.browser_tool`（其实两种等价，但态度明确）

### 🎯 Noe 优化/改进/完善点

| 序号 | 优化点 | 具体落地方案 |
|------|--------|--------------|
| **H1** | **TypeScript 工具注册中心按需加载** | Noe 的 `tools/index.ts` 应该用 `import('./' + name)` 动态加载，每个工具的 schema + handler 用 ESM 拆分，首屏只注册核心工具（calculator/file/web），其他等用户/agent 触发再 lazy load。 |
| **H2** | **工具按 governance tier 分层加载** | tier-1 工具（read）默认加载，tier-4 工具（写、shell、network）要求 `governance.session.tier >= N` 才注册。 |
| **H3** | **Electron main / renderer 拆分** | renderer 进程**不能**直接 require Node modules，工具清单应在 main 注册，renderer 通过 IPC 调用。这点 Hermes Python 没有，Noe 必须明确。 |
| **H4** | **能力声明 schema** | 每个工具有 `requiredCapabilities: ['filesystem', 'network', 'browser']`，Noe 在工具注册时检查环境能力，缺能力就降级或跳过注册。 |
| **H5** | **统一 `check_requirements` 接口** | 工具元信息里加 `requirements: { nodeVersion, diskSpace, apiKeys: [...] }`，启动时一次性体检 + UI 友好提示。 |

---

# 🔗 横向串联建议（Noe 整体可改进点）

基于以上 8 个文件的分析，下面 5 个**跨文件级**的优化对 Noe 的"本地优先 AI 助手"定位最关键：

1. **审批/审计双层模型升级**：把 Hermes 的"frozen YOLO + contextvars session" + Noe 的"四档路由 + consensus"合并成 **"tier-aware multi-model approval"**：
   - tier 1-2 命令：单模型秒过
   - tier 3：3 模型 quorum
   - tier 4：5 模型 quorum + 人工 confirm
   - cron 模式：所有命令自动 observe-only（写审计但不阻塞）

2. **浏览器能力栈完整化**：
   - Playwright (默认) → CDP 透传 (escape hatch) → Camofox (反检测)
   - 加上 Electron 原生 BrowserView 做 VNC 实时预览
   - 对话框响应 + 截图 + 元素 ref 喂给 vision 通道

3. **Memory 入库前统一清洗**：
   - 终端输出先 `strip-ansi` 再入 FTS
   - 浏览器 snapshot 80K 限制 + 按模型 context 动态调整
   - binary 文件走"元数据 awareness" 而非纯跳过

4. **profile-scoped identity 平台化**：
   - 把 `uuid5(namespace, scope)` 抽象为 Noe 通用服务
   - 给 browser、cache、log、audit、Freedom 社交链**统一身份**
   - OS keychain 加密 salt

5. **工具按需注册 + tier 化**：
   - 不再"启动时全部加载"
   - 工具声明 `governance.tier` + `requiredCapabilities`
   - 在 IPC/IPM 边界做能力检查

---

**总结**：Hermes 的代码展示了**安全工程**与**异步上下文管理**两个维度的高水准（frozen-env 防注入、contextvars 防并发串扰、shell 归一化防绕开），同时在浏览器层提供了 Camofox / CDP / Dialog 的完整逃生口。Noe 作为 Node+Electron 项目应重点**移植**这些安全/会话隔离模式，并用其现有的 **consensus + MemoryCore + governance** 把"单点 smart approval"升级为"多模型分级审批"。