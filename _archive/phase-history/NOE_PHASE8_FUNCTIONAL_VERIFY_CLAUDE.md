# Noe 阶段 8「功能验证」— Claude 方案（用户主路径浏览器端到端复现）

> 入口脚本：`NOE_PHASE8_FUNCTIONAL_VERIFY.mjs`（可复跑，退出码即裁定）
> 运行：`/Users/hxx/.nvm/versions/node/v22.22.2/bin/node NOE_PHASE8_FUNCTIONAL_VERIFY.mjs`
> 实测结果：**22/22 PASS，EXIT=0**

## 1. 与阶段 7 的区别（为什么这是“功能验证”而非又一次集成测试）

- 阶段 7「集成测试」：用 HTTP 断言模块间协作（鉴权→Memory/Focus/Loop/Tool→SQLite→WS）。
- 阶段 8「功能验证」：站在**用户视角**，用真实浏览器（Playwright `chromium`）**点 Brain UI 上真实存在的按钮**，断言用户**肉眼可见**的 DOM 输出，并截图留证。门槛 = 用户主路径可复现通过。

## 2. 验证环境（隔离）

| 项 | 值 |
|---|---|
| server | 真 spawn `node server.js`（Node 22.22.2，better-sqlite3 ABI 对齐） |
| 端口 | 优先 51835（用户主路径明确要求“能在 51835 启动”），占用则退随机空闲口 |
| HOME | `mkdtemp` 临时目录 → `~/.noe-panel`、owner-token 全落临时目录，**不污染生产** |
| 浏览器 | `playwright@1.60.0` core + 已下载 Chromium，headless |
| 原项目 | 51735 PID 全程实测不变 |

## 3. 用户 Jarvis 主路径步骤 / 输入 / 输出（实测）

| 步骤 | 用户动作（真实 UI） | 输入 | 输出（断言） | 结果 |
|---|---|---|---|---|
| U1 | 带 owner-token 打开面板 | `/?t=<token>` | title=`Noe` | PASS |
| U1b | 关闭首启遥测同意弹窗 + 跳过引导 | 点「不参与」 | `.telemetry-consent` 移除 | PASS |
| U2 | 点击「Brain」 | click `#btnNoeBrain` | `#noeBrainArea` 由隐藏变可见 | PASS |
| U3 | 查看健康 | — | `#noeHealthStatus`=`ok` | PASS |
| U3b | loop 默认未自动运行 | — | `#noeLoopState`=`stopped`（不烧额度） | PASS |
| U4 | 写记忆→关键词召回 | body=`…JARVIS_PHASE8_51835…`；query=`JARVIS_PHASE8_51835` | `#noeMemoryList` 含该标记（Memory Core FTS 命中） | PASS |
| U4b | 记忆计数 | — | `#noeMemoryCount` ≥ 1（实测 1） | PASS |
| U5 | 推焦点 | title=`FOCUS_JARVIS_PHASE8_51835` | `#noeFocusDepth` 0→1（Focus Stack 入栈） | PASS |
| U6 | Pop 焦点（absorb） | click `[data-noe-pop-focus]` | 深度回 0；`#noeMemoryCount` 1→2（焦点吸收为 scope=focus 记忆） | PASS |
| U7 | 触发 loop tick | POST `/api/noe/loop/tick {force:true}` | `ok=true`, `eventId=1` | PASS |
| U7b | 零额度行动 | — | `event.acted=false`（默认不行动，不烧 token） | PASS |
| U7c | Thought Stream 更新 | click `#btnNoeLoopTick` | `#noeThoughtStream` 出现 tick 事件，`#noeThoughtCount`≥1（实测 3） | PASS |
| U8 | 工具安全 | — | `#noeToolCount`=`0/0`，列表显示“默认不会执行任何工具” | PASS |
| U9 | 截图留证 | — | `output/playwright/noe-phase8-functional-*.png`（134K，全页） | PASS |
| U10 | 控制台 | — | 无相关 console error | PASS |
| 隔离 | — | — | 51735 PID `73664→73664` 运行期/停测后均不变 | PASS |

截图肉眼可核：Loop=stopped（ticks=2/actMode=false）、Focus Stack=0、Thought Stream=3 条 tick、Memory=2 含召回标记、Tools=0/0、Health=ok、底栏**累计 $0.000（零额度）**。

## 4. 本轮发现并实证的真实缺口（非阻断，建议后续修）

并行成员阶段 7 落的 `tests/e2e/noe-brain-ui.e2e.mjs` **无法作为功能验证证据**：
1. `import { test, expect } from '@playwright/test'` —— 该包**未安装**（项目只装了 `playwright` core），实跑直接 `ERR_MODULE_NOT_FOUND`。
2. 选择器用 `#noe-brain-ui-panel`/`#noe-health-status`/`#noe-memory-list`/`#noe-thought-stream`（连字符），而真实前端是驼峰 `#noeBrainArea`/`#noeHealthStatus`/`#noeMemoryList`/`#noeThoughtStream` —— 全部对不上。
3. 未处理首启遥测同意弹窗（拦截点击）、未点 `#btnNoeBrain`（Brain UI 默认 `display:none`）。

→ 本脚本 `NOE_PHASE8_FUNCTIONAL_VERIFY.mjs` 用 `playwright` core + 正确驼峰选择器 + 首启弹窗处理，是阶段 8 真正可跑通的功能验证。

## 5. 11 阶段闭环衔接

承上（阶段 5 实现 / 6 单测 22 通过 / 7 集成 E2E 真绿）→ 本阶段把“接口可用”升级为**用户肉眼可见的主路径可复现**（开面板→记忆→焦点→吸收→tick→Thought Stream，零额度、工具不裸执行）→ 启下（阶段 9 文档可直接引用本截图与步骤表；阶段 10 验收以 `NOE_PHASE8_FUNCTIONAL_VERIFY.mjs` 退出码为门）。

## 裁定

用户主路径（Jarvis 体验）已**用真实浏览器端到端复现并截图**，22/22 PASS、退出码 0；原项目 51735 全程零影响、临时库隔离、生产 `~/.noe-panel` 未污染、BaiLongma 镜像只读未改、secret 门 PASS。**同意推进至阶段 9「文档编写」。**
