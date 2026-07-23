# xAI Grok 接管本地脑（2026-07-18）

## 做了什么

- 开关：`NOE_USE_XAI_BRAIN=1` + `XAI_API_KEY`（见项目根 `.env`，不入库）
- 代码：`src/server/services/room-adapters.js` 在开关开启时，把 `ollama` / `ollama-9b` / `lmstudio` / `lmstudio-code` 槽位换成 OpenAI 兼容直连 `https://api.x.ai/v1`（模型默认 `grok-4`，可用 `NOE_XAI_MODEL` 覆盖）
- 同时注册 `custom:xai` 供面板直选
- 自主认知白名单仍是 `lmstudio`/`ollama` id，故 Inner/Reflect/心跳等路径无需改白名单
- 语义嵌入：`NOE_MEMORY_EMBED=off`（避免继续依赖本机 ollama embedding）
- 已清除 `~/.noe-panel/EMERGENCY_STOP`（先前因「关本地模型」冻结自主任务）

## 回滚

1. `.env` 设 `NOE_USE_XAI_BRAIN=0` 或删掉 `XAI_API_KEY`
2. 恢复本地模型名（可用 `.env.bak.xai.*`）
3. 重启：`npm run start:noe`

## 额度

xAI 控制台需有 credits/licenses，否则 chat 返回 `permission-denied`。
