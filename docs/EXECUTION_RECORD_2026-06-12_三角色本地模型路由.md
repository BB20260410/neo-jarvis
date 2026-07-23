# 执行记录 · 三角色本地模型路由 2026-06-12

更新时间：2026-06-12 12:01:23 CST

## 结论

- Main Brain：`qwen/qwen3.6-35b-a3b`，LM Studio load key `qwen/qwen3.6-35b-a3b@6bit`。
- Review Brain：`qwen/qwen3.6-27b`，LM Studio load key `qwen/qwen3.6-27b@4bit`，按需 TTL 600s。
- Fallback Brain：`gemma-4-26b-a4b-it-qat-mlx`，fallback load keys `gemma-4-26b-a4b-it-qat-mlx`、`google/gemma-4-26b-a4b-qat`。
- `contextLength=262144` 是输入窗口；`max_tokens` 是单次输出预算，不是自主运行总能力上限。
- developer mode / autonomous run 不能由人工总步数、总时长、总输出长度硬停机；由任务完成判据、验证结果和风险门槛决定继续或停止。
- adapter 已标记 `finish_reason=length` 为 `truncated/incomplete/continuationRequired`；自动认知入口遇到该状态不写入记忆、期望或结论。

## 输出预算

- Q35-6 普通默认：`8192`。
- tiny thought / mood / inner monologue：`128-512`。
- vision：`512-1600`。
- fact extract / memory candidate JSON：`2048-4096`。
- short chat：`1024-2048`。
- normal chat / planning：`4096-8192`。
- autonomous step / developer-mode single action cycle：`8192-12288`。
- deep deliberation / self-evolution plan / complex code review：`12288-16384`。
- long report / benchmark summary / handoff generation：`16000-24576`。
- review JSON：默认 `4096`，长证据/高风险复核 `8192-12288`。
- fallback：默认上限 `4096`，复杂 autonomous developer-mode 不靠 fallback 硬跑。

## 已接入

- `src/model/NoeLocalModelPolicy.js`：三角色常量、系统提示词、预算表、路由、load plan、review preflight。
- `src/model/NoeLocalBrainRouter.js`：薄路由导出层。
- `src/room/LmStudioLoader.js`、`src/room/LmStudioChatAdapter.js`、`src/server/services/room-adapters.js`：Q35 默认、Q27 按需、Gemma fallback load 参数。
- `src/room/OpenAICompatChatAdapter.js`：`finish_reason=length` 标记 incomplete。
- 自动认知入口：inner monologue、mood、narrative self、personality snapshot、deliberation、expectation harvest/resolve、nightly reflection、proactive tick、fact extract、VLM。
- 高风险自由行动入口：`src/runtime/NoeFreedomExecutor.js` 生成 Review Brain preflight 元数据。
- benchmark 脚本当前口径：Q35-6 主脑、Q27-4 复核、G26-4 兜底；manual benchmark 不再声明 Gemma 单主脑默认。

## 验证

- `node --check`：模型 policy、adapter、自动认知入口、benchmark 脚本通过。
- 窄集 vitest：7 文件 / 78 tests passed。
- 自动认知 vitest：10 文件 / 103 tests passed。
- `npm run test:p0:unit`：100 文件 / 731 tests passed。
- `npm run verify:noe:self-evolution`：198 passed / 0 failed。
- `npm run verify:handoff`：27 passed / 0 failed。
- `git diff --check -- ':!games/cartoon-apocalypse/**'`：passed。

## 运行影响

- 未重启 `51835`。
- 未触碰 `51735`。
- 未改变 LM Studio loaded models。
- `lms ps` 当前 loaded：`gemma-4-26b-a4b-it-qat-mlx`，status `IDLE`，context `262144`，parallel `4`。
- 代码默认已切到 Q35-6；当前 live 进程如未重启，不会自动加载新代码。
