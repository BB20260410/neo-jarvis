// @ts-check
// Step 2'（飞轮停摆修复）：post_review 真拒后，把结构化拒绝信息装配成「脱敏 learning」记入 memory + episode，
//   供 Neo 下次立项参考避坑（呼应"从失败中学"= 真正自我迭代，而非卡死浪费）。
//   脱敏命脉：绝不带 rawOutputRef / diff / secret——只取 reviewer decision + errors 文案 + objective。
//   全注入式（memoryWrite/recordEpisode/now），任一缺失静默跳过，绝不阻断飞轮 tick。

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

function cleanText(value, max = 200) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// 多模型审 P0-1：脱敏单条 blocker——去 secret token（redactSensitiveText）+ 去文件 ref/path（rawOutputRef 等）+ 去 diff 残留。
//   errors 来自 validateNoePostReview 可能拼进 `missing_*:<ref>` / diff 片段，必须闭合脱敏，绝不外泄。
function scrubBlocker(value, max = 80) {
  let s = redactSensitiveText(String(value == null ? '' : value));
  s = s.replace(/(?:output|src|tests|docs|scripts|public)\/[\w./-]+/gi, '<ref>'); // 文件 ref/path
  s = s.replace(/\bdiff\b\s*:?[\s\S]*/i, '<diff>'); // diff 内容残留（含其后所有，防代码片段泄漏）
  return s.trim().slice(0, max);
}

// 装配脱敏 summary：objective + 各 reviewer 的 model:decision + 前几条 errors。
//   objective 是目标描述（文件路径是有用信息须保留）→ 只去 secret token；errors 来自复核错误串可能拼 ref/diff → scrubBlocker 全去。
//   kind=verify_not_green：验证失败 lesson，供 extractObjectiveFromSummary + open 队列降权。
export function buildSelfEvolutionRejectLessonSummary(info = {}) {
  const objective = cleanText(redactSensitiveText(String(info.objective == null ? '' : info.objective)), 120) || '自我进化';
  const reviews = Array.isArray(info.reviews) ? info.reviews : [];
  const decisions = reviews
    .map((r) => `${cleanText(r && r.model, 24) || 'reviewer'}:${cleanText(r && r.decision, 24) || '?'}`)
    .join(', ');
  const errors = (Array.isArray(info.errors) ? info.errors : [])
    .slice(0, 4)
    .map((e) => scrubBlocker(e, 80))
    .filter(Boolean)
    .join('；');
  const kind = String(info.kind || info.reason || '').trim();
  if (kind === 'verify_not_green' || kind === 'failfast_same_failure_repeated' || kind === 'runtime_verify_failed') {
    return `自我进化 cycle 验证未绿（${objective}）。原因：${errors || kind}。`.slice(0, 400);
  }
  return `自我进化 cycle 被复核拒绝（${objective}）。复核：${decisions || '无'}。blocker：${errors || '未细化'}。`.slice(0, 400);
}

// 装配 recorder：reject 信息 → 脱敏 summary → 写 memory（知识，可召回反馈下次 autoseed）+ episode（经历留痕）。
export function createSelfEvolutionRejectLessonRecorder({ memoryWrite = null, recordEpisode = null, now = () => Date.now(), projectId = 'noe' } = {}) {
  return function record(info = {}) {
    // @ts-ignore

    const summary = buildSelfEvolutionRejectLessonSummary(info);
    const ts = Number(typeof now === 'function' ? now() : now) || 0;
    let memoryId = '';
    if (typeof memoryWrite === 'function') {
      try {
        const r = memoryWrite({
          kind: 'self_evolution_reject_lesson',
          // P0-1（多模型+子代理两路实测坐实）：必须带 projectId（否则 MemoryCore.write 默认写 'default'，
          //   而 recall 搜 'noe' → 召回恒 0、闭环生产不通电）+ sourceType（P2-4 精确召回锚点，防误召回非 lesson）。
          sourceType: 'self_evolution_reject_lesson',
          projectId,
          text: summary,
          tags: ['failure_lesson', 'self_evolution_reject', `cycle:${cleanText(info.cycleId, 40)}`],
          createdAt: ts,
        });
        memoryId = (r && (r.id || r.memoryId)) || '';
      } catch { /* 留痕失败绝不阻断飞轮 tick */ }
    }
    if (typeof recordEpisode === 'function') {
      try { recordEpisode({ episodeType: 'self_evolution_lesson', text: summary, at: ts }); } catch { /* 不阻断 */ }
    }
    return { ok: true, memoryId, summary };
  };
}
