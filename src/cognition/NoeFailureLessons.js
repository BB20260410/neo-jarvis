// @ts-check
// NoeFailureLessons（P1-1 自学习）——把执行失败（act failed / runtime 故障）抽成可复用教训。
//
// 设计：
//   - 全注入式（memoryWrite/recordEpisode/now/state），便于单测 stub；env 门控在 server 侧（默认 OFF）。
//   - 失败 act（status='failed'）→ 确定性规则归一根因类别 → 写 type=feedback 教训记忆 → 同类任务可召回。
//   - **根因标 unverified**（第二轮审计必修）：归因来自规则/启发式，未经确定性验证或人工确认，绝不自动当
//     「已验证事实」固化（防幻觉归因被反复召回强化）。教训正文明示「根因(未验证)」，confidence='unverified'。
//   - 去重：同 (action+根因类别) 在 cooldown 窗口内只记一次（防同类失败刷屏记忆库）。
//   - 脱敏：failure_reason 经 redact 后才入正文（不写 secret/diff）。

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

const DEFAULT_COOLDOWN_MS = 30 * 60_000;

// 确定性根因规则：reason 文本 → 粗类别（按特异性从具体到泛排序，先命中先用）。
// 仅作「方向标签」，不声称已验证。
const ROOT_CAUSE_RULES = Object.freeze([
  { category: 'network', label: '网络/连接', re: /error\s*61|econnrefused|econnreset|etimedout|enotfound|socket hang up|fetch failed|network|wss?:\/\/|连接(失败|拒绝|超时|断)|断网/i },
  { category: 'timeout', label: '超时', re: /timeout|timed out|超时|deadline exceeded/i },
  { category: 'permission_policy', label: '权限/策略拦截', re: /policy_protected|patch_path_blocked|requires_standing_grant|unauthorized|forbidden|permission denied|grant|越权|未授权|被拦/i },
  { category: 'patch_apply', label: '补丁/应用', re: /patch|no_patch_plan|apply|from_not_found|from_ambiguous|operations_required|unsupported_patch|symlink|not_a_file/i },
  { category: 'verify_test', label: '校验/测试失败', re: /verify|runtime_verification|test(s)? failed|assertion|expect|exit code [^0]|npm test/i },
  { category: 'model_adapter', label: '模型/adapter', re: /adapter|no_adapter|empty reply|llm|model.*(unavailable|error)|rate.?limit|429|quota/i },
  { category: 'not_found', label: '资源缺失', re: /not found|enoent|missing|缺失|不存在|undefined is not|cannot read/i },
  { category: 'resource', label: '资源/容量', re: /emfile|enospc|out of memory|oom|heap|fd|too many open/i },
]);

function cleanText(value, max = 300) {
  return redactSensitiveText(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function asMs(now) {
  const v = typeof now === 'function' ? now() : now;
  return Number(v) || 0;
}

function failureReasonOf(act = {}) {
  return cleanText(
    act.failure_reason || act.failureReason || act.error || act.reason || act.message
      || (act.result && (act.result.error || act.result.reason)) || '',
    400,
  );
}

// 归一根因类别（确定性、未验证）。
export function classifyFailureRootCause(reason = '') {
  const t = String(reason || '');
  if (!t.trim()) return { category: 'unknown', label: '未知', verified: false };
  for (const rule of ROOT_CAUSE_RULES) {
    if (rule.re.test(t)) return { category: rule.category, label: rule.label, verified: false };
  }
  return { category: 'other', label: '其他', verified: false };
}

// 构造一条 type=feedback 教训记忆（根因未验证）。
export function buildFailureLesson(act = {}, { now = Date.now } = {}) {
  const action = cleanText(act.action || act.kind || 'unknown_action', 120);
  const reason = failureReasonOf(act);
  const rootCause = classifyFailureRootCause(reason);
  const goalId = cleanText((act.payload && act.payload.goalId) || act.goalId || '', 80);
  const title = `失败教训（未验证根因·${rootCause.label}）：${action}`.slice(0, 160);
  const body = [
    `任务执行失败教训（根因未验证，仅供同类任务排查方向参考）。`,
    `- 失败动作：${action}`,
    `- 根因类别（未验证）：${rootCause.label}（${rootCause.category}）`,
    reason ? `- 失败原因（脱敏）：${reason}` : '- 失败原因：（未提供）',
    goalId ? `- 关联目标：${goalId}` : '',
    `**Why:** 同类动作（${action}）再次失败时，先按「${rootCause.label}」方向排查可省时。`,
    `**How to apply:** 此根因为「未验证」——下次命中先按此方向查；经确定性复现/人工确认后才可升级为已验证教训（防幻觉归因被反复召回固化）。`,
  ].filter(Boolean).join('\n');
  return {
    title,
    body,
    scope: 'feedback',
    sourceType: 'failure_lesson',
    confidence: 'unverified',
    tags: ['failure_lesson', `rootcause:${rootCause.category}`, `action:${action}`],
    rootCause,
    at: asMs(now),
  };
}

/**
 * 失败→教训抽取器。observe(act) 对 status='failed' 的 act 抽教训并写 type=feedback 记忆。
 * @param {{ memoryWrite?: Function, recordEpisode?: Function, now?: () => number, cooldownMs?: number, state?: {get:Function,set:Function} }} deps
 */
export function createNoeFailureLessons({
  memoryWrite = null,
  recordEpisode = null,
  now = () => Date.now(),
  cooldownMs = DEFAULT_COOLDOWN_MS,
  state = null,
} = {}) {
  const mem = new Map();
  const getState = (k) => { try { return state?.get ? state.get(k) : mem.get(k); } catch { return null; } };
  const setState = (k, v) => { try { state?.set ? state.set(k, v) : mem.set(k, v); } catch { /* best-effort */ } };

  function observe(act = {}) {
    try {
      // 显式归一化与校验：拒绝 null/undefined 与非对象输入，避免空内容教训入库。
      if (act === null || act === undefined) {
        return { ok: false, created: false, reason: 'invalid_act_null' };
      }
      if (typeof act !== 'object' || Array.isArray(act)) {
        return { ok: false, created: false, reason: 'invalid_act_type' };
      }
      if (act.status !== 'failed' && act.status !== 'error') {
        return { ok: true, created: false, reason: 'not_failed' };
      }
      if (typeof memoryWrite !== 'function') return { ok: false, reason: 'memory_write_unavailable' };
      // 归一化失败原因：拒绝 null/undefined / 空串 / 纯空白 message / 缺 error 字段。
      // failureReasonOf 内部已做 redact + collapseWhitespace + trim，归一化后为空即视为非法。
      const reason = failureReasonOf(act);
      if (typeof reason !== 'string' || reason.trim().length === 0) {
        return { ok: false, created: false, reason: 'empty_failure_reason' };
      }
      const lesson = buildFailureLesson(act, { now });
      // 去重：同 action+根因类别 在 cooldown 窗口内只记一次。
      const key = `noe.failure_lesson.${lesson.rootCause.category}.${cleanText(act.action || '', 80)}`;
      const last = getState(key);
      if (last?.at && asMs(now) - Number(last.at) < cooldownMs) {
        return { ok: true, created: false, deduped: true, reason: 'cooldown', rootCause: lesson.rootCause };
      }
      const written = memoryWrite({
        title: lesson.title,
        body: lesson.body,
        scope: lesson.scope,
        sourceType: lesson.sourceType,
        confidence: lesson.confidence,
        tags: lesson.tags,
      });
      const memoryId = (written && (written.id || written.memoryId)) || '';
      setState(key, { at: asMs(now), memoryId });
      try { recordEpisode?.({ type: 'observation', summary: `从失败中提取教训（未验证根因·${lesson.rootCause.label}）：${cleanText(act.action || '', 60)}`, salience: 3 }); } catch { /* timeline best-effort */ }
      return { ok: true, created: true, memoryId, rootCause: lesson.rootCause, lesson };
    } catch (e) {
      return { ok: false, reason: 'exception', error: cleanText(e?.message || e, 180) };
    }
  }

  return { observe, classifyFailureRootCause, buildFailureLesson };
}
