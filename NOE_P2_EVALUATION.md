# Noe P2 体验层可行性评估

生成：2026-06-03（接手会话）
当前状态：P0 已验收、P1 产品力已落地（Memory M1 / NoeLoop tickHandler / ToolRegistry 只读 handler / M3 endpoint / 文件索引 / Electron 正式化，见 README + `NOE_CE12_P0_DOCS_CANONICAL.md`）。
本文用途：P2 是高成本体验层，每项都有外部依赖或红线，本 session 不擅自完整实现；此处给可行性评估 + 推荐最小路径 + 需用户裁定的输入，供决定后再实现。

## 总判断与推荐顺序

P2 三项都不是"写几行就能完成"的功能。按"风险低→高、自主度高→低"推荐顺序：
**Tool marketplace（最接近现有 ToolRegistry，最安全）→ Voice（本地 Web Speech，纯前端）→ Social I/O（外发红线，最后）。**

## P2-01 Voice 输入/输出

- **可行性**：中。浏览器内置 Web Speech API（`SpeechRecognition` + `SpeechSynthesis`）可做**纯本地**语音输入/输出原型，默认不外发。
- **成本**：前端集成（brain-ui 加麦克风按钮 + 语音转文字 → memory/focus）。语音交互难自动化测试，需人工验。
- **红线**：本地 Web Speech 不外发，安全；若改用云 STT/TTS（更准）则涉及外发 + 可能付费 → 必须审批。
- **推荐最小原型**：brain-ui 加"语音记忆"按钮，Web Speech 识别 → 填入 memory body（纯本地，麦克风需用户当场授权）。
- **需用户裁定**：本地（免费、略糙）还是云（准、外发付费）。

## P2-02 Social I/O 只读原型

- **可行性**：中。只读拉取（RSS / 公开 API）+ 展示可做。
- **成本**：需指定具体 social 源 + 拉取适配器 + 展示 UI。
- **红线**：外发（发帖/评论/私信）必须审批，本 session 绝不接真实外发；即便只读拉取也要防 SSRF —— 复用现有 `PermissionGovernance` 的 `network.upload` 闸 + `isPrivateHost` 拦截。
- **推荐最小原型**：先做一个只读 RSS/JSON 源拉取 → 展示为 focus/memory 候选，外发路径完全不接线。
- **需用户裁定**：要接哪些 social 源 + 是否需账号鉴权（若需则提供）。

## P2-03 Tool marketplace manifest

- **可行性**：高。`ToolRegistry` 已有 manifest schema（Ajv 校验）+ register API + PermissionGovernance 闸 + Brain UI 工具列表，**今天又新增了只读 handler 机制**（`src/capabilities/builtinReadonlyTools.js`）。基础最完整。
- **成本**：低-中。增量 = 从外部源（本地 manifest 目录 / JSON）批量加载 manifest 声明 + 权限审计 UI 增强。
- **红线**：只接 manifest（声明），不接未审计的真实 handler；无 handler 的工具 invoke 仍安全返 501；接真实 handler 前必须逐个审计（参考今天只读 handler 的 low-risk + 无 command + 复用现成只读能力的模式）。
- **推荐最小原型**：`src/capabilities/toolMarketplace.js` 从本地 manifest 目录加载声明 → register（默认 `enabled=false`）→ UI 标注"声明态、无 handler"。
- **需用户裁定**：无（可自主做），但价值取决于后续是否接真实 handler。

## 明确不做（红线 / 需用户裁定）

- 不接真实 social 外发（发布/评论/私信）。
- 不引入付费云语音作为默认路径。
- marketplace 不接未经审计的真实 handler。
- 分发签名 / 公证 / DMG 需 Apple 开发者证书（见 Electron 正式化），属付费/账号红线，待用户提供证书后再做。

## 与 P1 的衔接

P1 已把"大脑四件套"从空壳推进到可用（NoeLoop 不再空转、ToolRegistry 不再恒 501、Memory M1 可见来源可信度）。P2 是在此之上加"感官（Voice）+ 触手（Social/marketplace）"。建议每接一个 P2 能力，都沿用 P1 的安全范式：默认只读 / 危险动作审批 / 复用现成能力 / 单测 + 实跑双验证。
