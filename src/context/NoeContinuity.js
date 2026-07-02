// @ts-check
// NoeContinuity — 连续记忆 + 自我状态注入的 provider 注册（连续记忆脊椎·第四节读出侧）。
//
// 与 host-context 同款模块级缓存模式：让无状态的 ChatProfileStore.resolve 能注入有状态的
// 连续记忆（EpisodicTimeline.narrative：我们一路走来）+ 自我状态（NoeSelfModel.buildSelfStateBlock：
// 我此刻是谁）。server.js 启动时注入持有实例的 provider；resolve 调 buildNoeContinuityBlock() 读取。
//
// 轻量中立模块（无重依赖）——故意不直接 import EpisodicTimeline/NoeSelfModel，避免 ChatProfileStore
// 被拖进 SQLite 依赖链；provider 由 server.js 注入，那里才持有实例。env 门控默认 OFF（provider 不注入
// 时 buildNoeContinuityBlock 返回空，resolve 行为零变化）。

let _provider = null;

/** server.js 启动注入：fn() → 返回要拼进 system prompt 的连续记忆/自我状态块（字符串）。传非函数则清除。 */
export function setNoeContinuityProvider(fn) {
  _provider = typeof fn === 'function' ? fn : null;
}

/** resolve 调用：有 provider 则生成当前块，否则空串（零影响）。provider 抛错被吞，不阻断对话。 */
export function buildNoeContinuityBlock() {
  if (!_provider) return '';
  try {
    return String(_provider() || '').trim();
  } catch {
    return '';
  }
}
