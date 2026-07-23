# OpenClaw src/daemon 逐文件全读
  "error": {
    "code": 429,
    "message": "No capacity available for model gemini-3-flash-preview on the server",
    "errors": [
      {
        "message": "No capacity available for model gemini-3-flash-preview on the server",
        "domain": "global",
        "reason": "rateLimitExceeded"
      }
    ],
    "status": "RESOURCE_EXHAUSTED",
    "details": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "MODEL_CAPACITY_EXHAUSTED",
        "domain": "cloudcode-pa.googleapis.com",
        "metadata": {
          "model": "gemini-3-flash-preview"
        }
      }
    ]
  }
}
]
    at Gaxios._request (file:///opt/homebrew/Cellar/gemini-cli/0.44.1/libexec/lib/node_modules/@google/gemini-cli/bundle/chunk-GPVT36PL.js:20961:19)
  config: {
    method: 'POST',
    params: { alt: 'sse' },
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'GeminiCLI-tui/0.44.1/gemini-3.1-pro-preview (darwin; arm64; terminal) google-api-nodejs-client/9.15.1',
    },
    responseType: 'stream',
    signal: AbortSignal { aborted: false },
    retry: false,
    paramsSerializer: [Function: paramsSerializer],
    validateStatus: [Function: validateStatus],
      _maxListeners: undefined,
      options: [Object],
      requests: [Object: null prototype] {},
      freeSockets: [Object: null prototype] {},
      maxFreeSockets: 256,
      scheduling: 'lifo',
      maxTotalSockets: Infinity,
      totalSocketCount: 1,
      agentKeepAliveTimeoutBuffer: 1000,
      proxyHeaders: {},
      connectOpts: [Object],
    },
  },
  response: {
    config: {
      method: 'POST',
      params: [Object],
      headers: [Object],
      responseType: 'stream',
      signal: [AbortSignal],
      retry: false,
      paramsSerializer: [Function: paramsSerializer],
      validateStatus: [Function: validateStatus],
    },
    data: '[{\n' +
      '  "error": {\n' +
      '    "code": 429,\n' +
      '    "message": "No capacity available for model gemini-3-flash-preview on the server",\n' +
      '    "errors": [\n' +
      '      {\n' +
      '        "message": "No capacity available for model gemini-3-flash-preview on the server",\n' +
      '        "domain": "global",\n' +
      '        "reason": "rateLimitExceeded"\n' +
      '      }\n' +
      '    ],\n' +
      '    "status": "RESOURCE_EXHAUSTED",\n' +
      '    "details": [\n' +
      '      {\n' +
      '        "@type": "type.googleapis.com/google.rpc.ErrorInfo",\n' +
      '        "reason": "MODEL_CAPACITY_EXHAUSTED",\n' +
      '        "domain": "cloudcode-pa.googleapis.com",\n' +
      '        "metadata": {\n' +
      '          "model": "gemini-3-flash-preview"\n' +
      '        }\n' +
      '      }\n' +
      '    ]\n' +
      '  }\n' +
      '}\n' +
      ']',
    headers: {
      'alt-svc': 'h3=":443"; ma=2592000,h3-29=":443"; ma=2592000',
      connection: 'close',
      'content-length': '630',
      'content-type': 'application/json; charset=UTF-8',
      date: 'Tue, 09 Jun 2026 01:56:05 GMT',
      server: 'ESF',
      'server-timing': 'gfet4t7; dur=1735',
      vary: 'Origin, X-Origin, Referer',
      'x-cloudaicompanion-trace-id': 'd7d81df0467e5a14',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'SAMEORIGIN',
      'x-xss-protection': '0'
    },
    status: 429,
    statusText: 'Too Many Requests',
    request: {
    }
  },
  error: undefined,
  status: 429,
}
我已完成对 `src/daemon/` 目录下所有核心逻辑文件的深度扫描（共 41 个文件）。以下是按职责划分的详细调研报告：

### 1. 核心工具与常量 (Core Utilities & Constants)

| 文件名 | 职责 | 核心机制 (文件:行) | Noe (AI助手) 优化/改进点 |
| :--- | :--- | :--- | :--- |
| **arg-split.ts** | 跨平台命令行参数拆分 | `splitArgsPreservingQuotes`: 逐字符状态机处理引号和转义 (L10) | 扩展对 Shell 变量嵌套展开的模拟解析能力。 |
| **cmd-argv.ts** | Windows CMD 参数转义 | `quoteCmdScriptArg`: 处理 `%`, `!`, `"` 等 CMD 敏感字符 (L5) | 优化路径中含有空格时的双引号包裹策略。 |
| **cmd-set.ts** | Windows 环境变量赋值渲染 | `renderCmdSetAssignment`: 渲染带转义的 `set "K=V"` (L74) | 增加对 `PATH` 变量追加操作的专用渲染逻辑。 |
| **constants.ts** | 服务名与描述定义 | `resolveGatewayLaunchAgentLabel`: 根据 Profile 动态生成服务 ID (L33) | 自动生成更具描述性的 `Description`，包含安装时间或环境标识。 |
| **container-context.ts** | 容器环境探测 | `resolveDaemonContainerContext`: 读取 `OPENCLAW_CONTAINER_HINT` (L5) | 扩展对 K8s Pod 命名规范的自动识别。 |
| **diagnostics.ts** | 启动失败日志诊断 | `readLastGatewayErrorLine`: 扫描日志并正则匹配已知错误模式 (L28) | **重难点**：引入 NLP 或更复杂的规则引擎来解释模糊的系统错误。 |
| **exec-file.ts** | 子进程执行封装 | `execFileUtf8`: 异步捕获 stdout/stderr 且不抛出异常 (L7) | 增加对执行过程的实时流式回调，方便 UI 展示安装进度。 |
| **future-config-guard.ts** | 配置文件版本保护 | `assertFutureConfigActionAllowed`: 检查配置快照防止降级修改 (L22) | 提示用户具体的升级建议而非仅仅报错。 |

### 2. 网关入口与生命周期抽象 (Gateway & Lifecycle)

| 文件名 | 职责 | 核心机制 (文件:行) | Noe (AI助手) 优化/改进点 |
| :--- | :--- | :--- | :--- |
| **gateway-entrypoint.ts** | 入口文件探测 | `findFirstAccessibleGatewayEntrypoint`: 寻找 `dist/index.js` (L50) | 支持在开发环境下自动切换到 `src/entry.ts`。 |
| **node-service.ts** | Node 服务特化包装 | `resolveNodeService`: 为通用服务注入 Node 环境特有标识 (L53) | 自动配置 Node 节点特有的健康检查心跳间隔。 |
| **service-runtime.ts** | 运行时状态定义 | `getSystemdCgroupHygieneSummary`: 检查 cgroup 资源告警 (L72) | 扩展到 macOS 的 `sysctl` 指标和 Windows 的工作集限制。 |
| **service-types.ts** | 接口契约定义 | 定义 `GatewayServiceState`, `GatewayServiceStartResult` | 同步更新类型以支持多进程管理。 |
| **service.ts** | 跨平台注册中心 | `resolveGatewayService`: 平台适配器工厂 (L341); 自动修复检查 (L119) | **核心优化点**：实现基于状态机自动尝试各种修复方案（如清理端口 -> 重启）。 |

### 3. macOS launchd 适配 (macOS Specific)

| 文件名 | 职责 | 核心机制 (文件:行) | Noe (AI助手) 优化/改进点 |
| :--- | :--- | :--- | :--- |
| **launchd-current-service.ts** | 服务归属检测 | `isCurrentProcessLaunchdServiceLabel`: 校验 `LAUNCH_JOB_LABEL` (L10) | 识别由特定 macOS 版本引入的新环境变量。 |
| **launchd-plist.ts** | Plist 读写解析 | `buildLaunchAgentPlist`: 渲染 XML (L215); 环境变量脱敏包装 (L127) | 增加对 `KeepAlive` 复杂条件（如网络状态）的支持。 |
| **launchd-restart-handoff.ts** | 脱离式重启脚本 | `scheduleDetachedLaunchdRestartHandoff`: 生成 `/bin/sh` 托管脚本 (L183) | 优化 `wait_pid` 逻辑，使用更现代的 `lsof` 检查端口释放。 |
| **launchd.ts** | launchctl 生命周期控制 | `prepareLaunchAgentProgramArguments`: 生成 owner-only 的 env 文件 (L161) | 自动识别并建议清理因系统升级导致的孤立 Plist 文件。 |

### 4. Windows schtasks 适配 (Windows Specific)

| 文件名 | 职责 | 核心机制 (文件:行) | Noe (AI助手) 优化/改进点 |
| :--- | :--- | :--- | :--- |
| **schtasks-exec.ts** | 命令行调用封装 | `execSchtasks`: 处理 Windows 常见的调用挂起超时 (L10) | 引入基于 PowerShell 的备选查询机制。 |
| **schtasks.ts** | 计划任务模拟守护进程 | `buildScheduledTaskXml`: 解决笔记本电池断电停止任务问题 (L125); 启动目录回退机制 (L752) | **大幅改进点**：利用 Windows 终端模式自动弹出 UAC 提权请求。 |

### 5. Linux systemd 适配 (Linux Specific)

| 文件名 | 职责 | 核心机制 (文件:行) | Noe (AI助手) 优化/改进点 |
| :--- | :--- | :--- | :--- |
| **systemd-hints.ts** | 修复建议渲染 | `renderSystemdUnavailableHints`: 提供 Linger 开启等建议 (L24) | 实现一键自动化执行建议中的 Shell 命令。 |
| **systemd-linger.ts** | 用户持久化管理 | `readSystemdUserLingerStatus`: 检查 `loginctl` 状态 (L34) | 自动检测非交互式环境下缺少的 `XDG_RUNTIME_DIR`。 |
| **systemd-unavailable.ts** | 错误分类审计 | `classifySystemdUnavailableDetail`: 区分 Bus 不可用与组件缺失 (L40) | 细化对 `snap` 或 `flatpak` 环境下权限限制的识别。 |
| **systemd-unit.ts** | Unit 文件生成 | `buildSystemdUnit`: 设置 `KillMode=control-group` 保证清理干净 (L48) | 增加对 `RestartPreventExitStatus` 的细粒度配置。 |
| **systemd.ts** | systemctl 核心控制 | `execSystemctlUser`: 修复 `sudo` 后的 Bus 连接上下文 (L405) | 优化对容器内 `systemd-shim` 环境的兼容。 |

### 6. 环境、路径与审计 (Env, Paths & Audit)

| 文件名 | 职责 | 核心机制 (文件:行) | Noe (AI助手) 优化/改进点 |
| :--- | :--- | :--- | :--- |
| **service-env-plan.ts** | 环境计划构建 | `addServiceEnvPlanEntries`: 多来源优先级覆盖 (L52) | 增加“敏感变量”审计，防止 API Key 意外写入 Plist/Unit。 |
| **service-env-render-policy.ts** | 平台渲染策略 | `applyManagedServiceEnvRenderPolicy`: 针对 launchd 的内联转换 (L18) | 自动处理不同平台间的路径分隔符转换。 |
| **service-env.ts** | 最小化环境变量生成 | `buildMinimalServicePath`: 排除工作空间路径，保留全局包管理路径 (L431) | **优化点**：自动检测并合并当前 Shell 中有效的 Node/Bun 运行时路径。 |
| **service-managed-env.ts** | 管理变量追踪 | `MANAGED_SERVICE_ENV_KEYS_VAR`: 记录服务拥有的变量清单 (L5) | 增加配置“粘性”，确保手动修改的非敏感变量在重装时不被覆盖。 |
| **service-path-policy.ts** | PATH 过滤策略 | `isNonMinimalServicePathEntry`: 过滤 nvm/fnm 等 Shim 路径 (L21) | 提醒用户使用 `openclaw doctor` 修复不稳定的 Shim 路径引用。 |
| **paths.ts** | 路径解析基础 | `resolveGatewayStateDir`: 支持 Profile 隔离的状态目录 (L41) | 支持 MacOS 上的 `~/Library/Application Support` 标准路径。 |
| **program-args.ts** | 启动参数构造 | `resolveCliProgramArguments`: 决定运行时 (Node/Bun) 与包装器 (L164) | 自动检查 `OPENCLAW_WRAPPER` 的可执行权限。 |
| **runtime-binary.ts** | 二进制识别 | `isNodeRuntime`, `isBunRuntime`: 正则匹配 (L14) | 增加对 `deno` 等新运行时的潜在支持探测。 |
| **runtime-format.ts** | 状态格式化 | `formatRuntimeStatus`: 整合信号退出名与 cgroup 状态 (L30) | 提供更加语义化的“错误原因”翻译（如 137 -> 内存溢出或手动杀死）。 |
| **runtime-parse.ts** | 键值对解析 | `parseKeyValueOutput`: 通用输出行解析 (L5) | 支持多行值和转义符的解析。 |
| **runtime-paths.ts** | 稳定运行时选择 | `resolveSystemNodeInfo`: 排除版本管理器 Shim 寻找真实 Node (L147) | **改进点**：若找不到支持的 Node，自动引导用户安装特定版本。 |
| **inspect.ts** | 存量服务扫描 | `findExtraGatewayServices`: 跨平台扫描并利用 marker 识别服务 (L161) | **实用功能**：发现并清理导致端口冲突的残留旧版本进程。 |
| **service-audit.ts** | 服务配置审计 | `auditGatewayServiceConfig`: 检查 PATH、Token 嵌入等风险 (L353) | 提供“一键修复审计项”的功能。 |
| **service-layout.ts** | 磁盘布局汇总 | `summarizeGatewayServiceLayout`: 追踪源码签出与包根目录 (L103) | 验证符号链接的有效性。 |
| **restart-logs.ts** | 重启日志管理 | `renderPosixRestartLogSetup`: 生成 Shell 日志重定向代码 (L61) | 引入日志大小限制逻辑。 |
| **output.ts** | 输出格式化 | `formatLine`: 终端色彩与标签化输出 (L10) | 无。 |

### 已读文件清单 (Checklist)
1. `arg-split.ts`
2. `cmd-argv.ts`
3. `cmd-set.ts`
4. `constants.ts`
5. `container-context.ts`
6. `diagnostics.ts`
7. `exec-file.ts`
8. `future-config-guard.ts`
9. `gateway-entrypoint.ts`
10. `node-service.ts`
11. `service-runtime.ts`
12. `service-types.ts`
13. `service.ts`
14. `launchd-current-service.ts`
15. `launchd-plist.ts`
16. `launchd-restart-handoff.ts`
17. `launchd.ts`
18. `schtasks-exec.ts`
19. `schtasks.ts`
20. `systemd-hints.ts`
21. `systemd-linger.ts`
22. `systemd-unavailable.ts`
23. `systemd-unit.ts`
24. `systemd.ts`
25. `service-env-plan.ts`
26. `service-env-render-policy.ts`
27. `service-env.ts`
28. `service-managed-env.ts`
29. `service-path-policy.ts`
30. `paths.ts`
31. `program-args.ts`
32. `runtime-binary.ts`
33. `runtime-format.ts`
34. `runtime-hints.ts`
35. `runtime-parse.ts`
36. `runtime-paths.ts`
37. `inspect.ts`
38. `service-audit.ts`
39. `service-layout.ts`
40. `restart-logs.ts`
41. `output.ts`
