# Noe AI 接手手册

更新时间：2026-06-06

本文件只解决一个问题：下一个 AI 接手时少走弯路。它不是新的产品路线，也不替代 CE12 canonical 文档。

## 1. 当前事实

- 真实工作区：`/Users/hxx/Desktop/Neo 贾维斯`
- Noe 端口：`51835`
- 原 Xike Lab / 可视化面板端口：`51735`
- `/Users/hxx/Documents/Neo 贾维斯` 不是当前实现根，不能在那里改 Noe 代码。
- 当前目标：把 Noe 做成用户每天可用的本地个人 AI 助手，不做商业化叙事、不做公开分发路线。

## 2. 接手读序

1. `CLAUDE.md` 和 `AGENTS.md`：红线和工程约束。
2. `README.md`：当前状态、启动、验证、限制。
3. `NOE_CE12_P0_DOCS_CANONICAL.md`：CE12 P0 当前事实源。
4. `NOE_CE12_P0_OPERATIONS_MANUAL.md`：启动、验证、排障。
5. `NOE_CE12_P0_ACCEPTANCE_CANONICAL.md`：验收口径。
6. `NOE_M3_SUGGESTION_ONLY.md`：M3 只能做建议员。
7. `docs/NOE_PRODUCT_COMPLETENESS_PLAN_2026-06-06.md`：去商业化后的产品完善路线。

旧 handoff 和 2026-06-05 计划文件可以参考，但不要让它们覆盖当前代码事实。

## 3. 当前硬边界

- 不 commit / push，除非用户明确要求。
- 不把 `.env`、API key、owner token、数据库、录音、照片原图进 git。
- 不 spawn `claude -p` / `codex -p` 子 LLM。
- 不碰 `/Users/hxx/Desktop/00_项目/05_Claude可视化面板`。
- 不杀 `51735` 进程。
- 不新增依赖，除非先给出必要性并获得用户同意。
- 文件保持在 500 行以内。
- 改代码前先读文件。

## 4. 易混概念

| 名称 | 实际含义 | 不要混成 |
|---|---|---|
| Noe | 当前 Electron + Node 本地助手项目 | 原 Xike Lab 面板维护项目 |
| Neo 贾维斯 | 用户对 Noe 的中文项目称呼 | `/Users/hxx/Documents/Neo` 里的其他项目 |
| M3 | MiniMax-M3 模型和 Noe 内部建议员链路 | 有本地工具权限的执行 agent |
| Mavis / OpenCode executor | 外部本地执行器形态 | 当前 Noe 允许的能力 |
| suggestion-only | 只读精选上下文、输出建议 JSON、`diffs=[]` | 读文件、跑 shell、直接改代码 |
| 实时语音 | VAD 监听、转写、TTS、可打断 | 只按住说话一次性录音 |
| 人物库 | 本地人物资料、人脸/声纹模板和身份上下文 | 通用 VLM 看图描述 |
| 本地优先 | 数据默认在本机处理 | 自动等于安全，无需权限护栏 |

## 5. M3 当前裁定

M3 永久保持 suggestion-only：

- 可以指出风险、缺口、体验问题、补丁建议。
- 不可以读本地文件。
- 不可以运行 shell。
- 不可以写文件、删文件、移动文件、apply_patch。
- 不可以做最终验收。

如果未来出现“让 M3 自己动手”的需求，先写独立安全设计并让用户明确批准；不能通过环境变量临时打开。

## 6. 当前产品重点

现在只做产品完善度：

1. 语音是否稳定说完、不误打断、可被用户自然打断。
2. 视觉是否只基于最新画面回答，不夹带旧聊天。
3. 人物库是否能稳定识别主人/熟人/未知人，并清楚显示证据。
4. 模型选择是否真实可用，不显示假模型。
5. 认知页 UI 是否不遮挡、不重叠、不让用户猜系统状态。
6. 附件、图片、文件、搜索、研究入口是否能真实工作。
7. 记忆是否少记垃圾、多记偏好和事实，并能解释来源。

不做：

- 商业化叙事。
- 公开发布路线。
- Tauri 重写。
- Tool marketplace。
- 广泛社交账号发布能力。
- 外部用户招募。

## 7. 验证命令

改前端或认知页：

```bash
npm run test:p0:unit
npm run verify:noe:cognitive-runtime -- --base-url http://127.0.0.1:51835
```

改 M3 suggestion-only：

```bash
npm run test:m3:suggestions
npm run test:p0:unit
```

改后端路由：

```bash
npm run test:p0:unit
npm run verify:noe:full-current -- --include-managed
```

验证命令通过不等于体验完成。涉及 UI、语音、摄像头、人脸、附件时，要再做真实浏览器或设备路径检查。

## 8. 文档状态

- `NOE_CE12_P0_*.md`：当前 CE12 基线，优先可信。
- `docs/HANDOFF_2026-06-05_codex交接.md`：历史交接，部分测试数和状态可能过期。
- `docs/Noe*_2026-06-05.md`：阶段计划和审计材料，作为背景，不作为当前待办事实。
- `docs/知识库方法论研究与落地_2026-06-05.md`：Obsidian / Karpathy / Wiki 研究材料，按需读。

## 9. 每次改完要汇报

汇报必须包含：

- 改了哪些文件。
- 用户能看到什么变化。
- 跑了哪些验证。
- 哪些没有验证或需要用户真实输入。
- 是否需要重启 51835。
