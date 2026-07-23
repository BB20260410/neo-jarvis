// @ts-check
// type_error_fix 域信号源(扩展自主能力域第一个,2026-06-29):跑 typecheck → 解析低 error 文件 →
//   立 type_error goal,交飞轮 selfEvolve 自主修。仿 NoeSelfDirectionSeed 范式(DI + 单坑位 + protected 排除 + fail-open)。
//   不需 LLM 反思——目标来自客观 typecheck 输出。价值锚(assessTypeErrorFix)在 applyAndVerify 阶段生效,不在此。
import { parseTypecheckTargets } from '../cognition/NoeTypeErrorScanner.js';
import {
  improveSignalFromTypecheckTarget,
  buildSelfEvolutionGoalFromImproveSignal,
} from './NoeSelfEvolutionImproveSignal.js';

const SIGNAL = 'type_error';
const SIGNAL_SOURCE = 'self_evolution';

/**
 * @param {{
 *   runTypecheck: () => (Promise<string> | string),
 *   goalSystem: { add: Function, list?: Function },
 *   isProtected?: (file: string) => boolean,
 *   maxErrorsPerFile?: number,
 *   now?: () => number,
 * }} deps
 */
export function createTypeErrorSeed(deps) {
  const d = deps || /** @type {any} */ ({});
  const runTypecheck = d.runTypecheck;
  const goalSystem = d.goalSystem;
  const isProtected = typeof d.isProtected === 'function' ? d.isProtected : () => false;
  // 防反复 drop:排除最近 dropped 的 type_error 文件(M3 修不对的复杂 error),让飞轮转向能修的简单 error。
  const isRecentlyDropped = typeof d.isRecentlyDropped === 'function' ? d.isRecentlyDropped : () => false;
  const maxErrorsPerFile = typeof d.maxErrorsPerFile === 'number' ? d.maxErrorsPerFile : 3;
  // P4 救域:难 error 码 deny(默认 TS2339/TS2322,实测 M3 修不动 12 连 dropped)——从源头不立注定失败的目标。
  const denyCodes = Array.isArray(d.denyCodes) ? d.denyCodes : ['TS2339', 'TS2322'];
  const now = typeof d.now === 'function' ? d.now : () => Date.now();

  async function runOnce() {
    if (!goalSystem || typeof goalSystem.add !== 'function') return { ok: false, skipped: 'no_goalsystem' };
    if (typeof runTypecheck !== 'function') return { ok: false, skipped: 'no_typecheck' };

    const open = (typeof goalSystem.list === 'function' && goalSystem.list({ status: 'open', limit: 200 })) || [];
    const active = (typeof goalSystem.list === 'function' && goalSystem.list({ status: 'active', limit: 200 })) || [];
    const live = [...open, ...active];
    // 单坑位:已有 type_error goal 在飞 → 跳过(防刷屏,仿 self_directed 单坑位)
    if (live.some((g) => g && g.meta && g.meta.signal === SIGNAL)) return { ok: false, skipped: 'in_flight' };

    let output = '';
    try {
      output = await runTypecheck();
    } catch (e) {
      return { ok: false, skipped: 'typecheck_failed', error: e instanceof Error ? e.message : String(e) };
    }

    const targets = parseTypecheckTargets(output, { maxErrorsPerFile, denyCodes });
    const taken = new Set(live.map((g) => g && g.meta && g.meta.targetFile).filter(Boolean));
    const target = targets.find((t) => !isProtected(t.file) && !taken.has(t.file) && !isRecentlyDropped(t.file));
    if (!target) return { ok: false, skipped: 'no_target' };

    // Perception ring SSOT: ImproveSignal → goal shape (technical anchors required).
    const improve = improveSignalFromTypecheckTarget(target);
    if (!improve.hasTechnicalAnchor) return { ok: false, skipped: 'no_technical_anchor' };
    const goalPayload = buildSelfEvolutionGoalFromImproveSignal(improve, {
      now,
      why: 'type_error_fix 域(扩展自主能力域)：逐文件开启类型安全，修结构性 bug',
    });
    // Preserve SIGNAL constant & source for openSelfEvolutionGoals filter
    goalPayload.source = SIGNAL_SOURCE;
    goalPayload.meta = { ...goalPayload.meta, signal: SIGNAL };
    const goalId = goalSystem.add(goalPayload);
    if (!goalId) return { ok: false, reason: 'add_rejected' };
    return {
      ok: true,
      goalId,
      targetFile: target.file,
      errorCount: target.errorCount,
      improveSignal: improve,
    };
  }

  return { runOnce };
}
