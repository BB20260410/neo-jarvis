# xAI SuperGrok OAuth 可行性探针（B 方案）· 2026-07-18

## 范围

- **只做**：设备码登录 + 存 token + **单次** `chat/completions` 推理
- **不做**：接入 Neo 主脑 / 心跳 / 5s 反刍（全量接入另议）

## 命令

```bash
cd "/Users/hxx/Desktop/Neo 贾维斯"
npm run noe:xai-oauth:status
npm run noe:xai-oauth:login    # 浏览器授权
npm run noe:xai-oauth:probe    # 单次推理
npm run noe:xai-oauth:all      # login + probe
```

脚本：`scripts/noe-xai-oauth-probe.mjs`
Token：`~/.noe-panel/xai-oauth.json`（0600，勿提交 git）

## 实测结论（本机）

| 项 | 结果 |
|----|------|
| OAuth 设备码登录 | ✅ 成功 |
| `grok-4` 推理 | ✅ HTTP 200，约 3s，reply=`pong` |
| VERDICT | **PASS** |

对比：同一账号下的 **API Key** 路径此前因空 team 无 credits 返回 `403 permission-denied`。
OAuth 面可推理 → **会员池/订阅鉴权路径可用**，与 API 预付 credits 是两套账。

## 全量接入（2026-07-18 已落地 · owner 要求全部 grok-4.5 high）

| 项 | 值 |
|----|-----|
| 开关 | `NOE_USE_XAI_BRAIN=1` + `NOE_XAI_TAKEOVER_ALL=1` |
| 模型 | `NOE_XAI_MODEL=grok-4.5` |
| 推理 | `NOE_XAI_REASONING_EFFORT=high` |
| 鉴权 | OAuth（`~/.noe-panel/xai-oauth.json`）优先，API Key 兜底 |
| 代码 | `src/room/NoeXaiAuth.js` / `XaiChatAdapter.js`；`room-adapters.js` 槽位接管 |
| 路由 | `NOE_BRAIN_{LOCAL,MID,CODE,DEEP}` → lmstudio / ollama / lmstudio-code（均为 XaiChatAdapter） |
| 含 | minimax / minimax-highspeed 槽在 TAKEOVER_ALL 下也指向 Grok |

**警告**：内心反刍默认约 5s 一轮也会打 `grok-4.5(high)`，会员周额度消耗极快。要省额度：调大 `NOE_INNER_INTERVAL_MS` 或关 `NOE_INNER_MONOLOGUE`。

## 回滚

```bash
# 关 xAI 脑
# .env: NOE_USE_XAI_BRAIN=0
rm -f ~/.noe-panel/xai-oauth.json   # 可选：清 OAuth
cd "/Users/hxx/Desktop/Neo 贾维斯" && npm run start:noe
```
