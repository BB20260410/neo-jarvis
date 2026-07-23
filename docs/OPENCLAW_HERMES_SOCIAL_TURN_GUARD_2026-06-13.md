# OpenClaw / Hermes 社交通道 Turn Guard 融合记录 2026-06-13

## 来源

- 本地 OpenClaw：`/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw`
  - `src/channels/turn/kernel.ts`
  - `src/channels/turn/bot-loop-protection.ts`
  - `src/channels/turn/durable-delivery.ts`
  - `src/channels/turn/message-turn-guardrails.test.ts`
- 本地 Hermes：`/Users/hxx/Documents/Claw系audit_2026-06-09/hermes-agent`
  - `gateway/platforms/weixin.py`
  - `gateway/platforms/qqbot/adapter.py`

## Neo 缺口

Neo 已有 `NoeSocialWebhookInbound`、`NoeQqBridgeResearchGate`、签名/replay/脱敏记忆和 dry-run 入站，但社交通道还缺 OpenClaw 那种统一 turn admission 层：

- provider 重放消息不应二次启动智能体回合。
- Noe 自己发出的回声不应被当作用户输入。
- 机器人对机器人连续互相触发要被压制。
- webhook provider 仍应收到安全 ack，避免反复重投。
- 交付回执不能包含回复正文或 secret 原值。

## 本轮落地

新增：

- `src/runtime/NoeSocialTurnGuard.js`
- `tests/unit/noe-social-turn-guard.test.js`

修改：

- `src/runtime/NoeInboundGateway.js`
- `src/runtime/NoeSocialWebhookInbound.js`
- `src/runtime/NoeQqBridgeResearchGate.js`
- `tests/unit/noe-social-webhook-inbound.test.js`
- `tests/unit/noe-qq-bridge-research-gate.test.js`
- `package.json`

能力：

- `createSocialTurnGuard()` 统一处理 duplicate provider message、self echo、bot-to-bot loop suppression。
- `createInboundGateway()` 支持可注入 `turnGuard`，guard drop 时返回 `ok:true`、`accepted:false`、`ackProvider:true`，但不触发 handler、不写记忆。
- 微信/企业微信/飞书 webhook receiver 默认接入 guard。
- QQ official dry-run receiver 默认接入 guard，并透传非敏感 `senderKind` / `receiverKind` turn facts。
- `buildSocialTurnDeliveryReceipt()` 生成不含回复正文的交付回执骨架，供后续真实 channel reply delivery 接入。
- 新增验证入口：`npm run verify:noe:social-turn-guard`。

安全边界：

- 不读取、输出或写入 secret 原值。
- 不触碰 `51735`。
- 不重启或接管 `51835`。
- 不执行真实微信/QQ 登录、上传或发消息。

## 后续

1. 用这层 `turnGuard` 承接 Hermes / OpenClaw 的真实 WeChat、WeCom、QQBot adapter 研究，不让各平台绕过统一入站安全层。
2. 将 `buildSocialTurnDeliveryReceipt()` 接到未来真实 outbound delivery，让 Noe 区分“已生成回复”和“用户真实收到回复”。
3. 给 Noe Brain 的社交入站页增加 turn admission 统计：重复、回声、bot loop、已接纳。

## 2026-06-13 续：个人微信 context_token 安全账本

来源继续参考 Hermes `gateway/platforms/weixin.py`：

- `ContextTokenStore`：按 account + peer 保存最新 `context_token`。
- `_process_message()`：入站时先做 message id / content fingerprint dedup，再保存最新 `context_token`。
- 出站前读取 peer 的最新 `context_token`，但不能把 token 写进日志或 UI。

本轮 Neo 落地：

- `NoeSocialTurnGuard` 增加无 `messageId` 时的内容指纹去重，覆盖个人微信长轮询重复包。
- `normalizeWeChatClawbotMessage()` 透传非敏感 `messageId`、`msgType`、`senderKind`。
- `NoeWeChatPersonalBridge` 接入同一套 `turnGuard`。
- 新增 `createWeChatPersonalContextTokenStore()`，只保存和输出 `sha256:<prefix>` 引用、更新时间和 peer 计数；不返回 raw token。
- 个人微信 inbound-test route 修正 `accepted` 语义：guard drop 返回 `accepted:false`，不会被 `ok:true` 误报为进入 Noe。
- `outboundDryRun()` 会报告 `contextTokenAvailable` / `contextTokenWouldBeUsed`，但仍不发送真实微信消息。

新增/扩展验证：

- `tests/unit/noe-social-turn-guard.test.js`
- `tests/unit/noe-wechat-personal-bridge.test.js`
- `tests/unit/routes/noe-social-inbound-routes.test.js`

边界保持：

- 不启动真实 WeChat/iLink client。
- 不返回 QR 原图、cookie、context token、bot token 或其它 secret 原值。
- 不发送真实微信/QQ消息。

## 2026-06-13 续：社交通道 Admission Read Model

来源参考 OpenClaw `src/channels/status/read-model.ts`：

- runtime status 不直接暴露原始 gateway payload，而是合并成可展示的只读状态。
- account/channel 状态要保留 source 和可用性语义，但不能泄露 token。

本轮 Neo 落地：

- `NoeSocialTurnGuard.stats()` 增加 admission read model：
  - `admittedTurns`、`acceptedTurns`、`droppedTurns`、`releasedReplayKeys`
  - `reasons`、`dropReasons`
  - `channels[channel].accepted/dropped/total/reasons/lastAt`
  - `lastAdmission` 只保留 channel、kind、reason、senderKind/receiverKind、是否有 provider message id
- `lastAdmission` 与 channel stats 不返回 senderId、messageId、文本、replay key 或 secret。
- `/api/noe/social-inbound/status`、个人微信 status、QQ status 现在能看到各自 turn guard 统计。

收益：

- owner 可以区分“没有消息进来”“消息被重复包去重”“自回声被拦截”“机器人循环被压制”。
- 后续 Noe Brain 社交面板可以直接读取这些统计，而不是从日志里猜。

验证：

- `npm run verify:noe:social-turn-guard`
- `npm run test:p0:unit`
- `npm run verify:handoff`
- `git diff --check -- ':!games/cartoon-apocalypse/**'`

## 2026-06-13 续：OpenClaw Durable Delivery 回执落点

来源参考 OpenClaw `src/channels/turn/durable-delivery.ts`：

- delivery 层必须区分“turn 已处理 / reply 已生成 / 是否尝试发送 / 用户是否真的可见”。
- dry-run 不能伪造成真实送达；失败和 unsupported 要被记录成明确状态。

本轮 Neo 落地：

- `buildSocialTurnDeliveryReceipt()` 支持 `not_applicable`、`unsupported`、`handled_visible`、`handled_no_send`、`failed`。
- 回执新增 `replyGenerated`、`deliveryAttempted`、`dryRun`、`liveMessageSent`、`visibleReplySent`、`finalReplyDelivered`。
- 个人微信 `outboundDryRun()` 现在要求有回复正文和主人可见入站证据；通过时返回 `handled_no_send`，明确表示“已生成回复，但 dry-run 未发送真实消息”。
- 回执不返回回复正文、context token、cookie、message body 或 secret 原值。

收益：

- Noe 可以在社交出站链路里区分“计划了回复”和“主人/用户实际收到回复”，避免把 dry-run 或生成文本误算成交付。
- P6 owner-perceived delivery 后续可以只认 `finalReplyDelivered:true` 或 owner confirmed delivery，不再把预演当真实触达。

验证：

- `npm run verify:noe:social-turn-guard`
