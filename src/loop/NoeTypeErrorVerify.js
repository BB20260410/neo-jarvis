// @ts-check
// 块4(type_error_fix 域,扩展自主能力域):包装 runtimeVerify——对 type_error goal,在 base verify(npm test)绿后,
//   额外跑 typecheck + 防作弊价值锚(该文件 error 真减少 + 无 @ts-ignore/any 消音)。!ok → applyAndVerify line320 现有自动回滚。
//   fail-open:typecheck 跑不了/读文件失败 → 不卡 base 绿(不引入新失败模式)。全 DI 注入便于单测,executor 只在 ctx.signal==='type_error' 时启用。
import { countFileTypeErrors, assessTypeErrorFix } from '../cognition/NoeTypeErrorScanner.js';

/**
 * @param {{
 *   runTypecheck: () => (Promise<string> | string),
 *   readFile: (p: string, enc?: string) => string,
 *   resolvePath?: (root: string, file: string) => string,
 * }} deps
 */
export function createTypeErrorVerify(deps) {
  const d = deps || /** @type {any} */ ({});
  const runTypecheck = d.runTypecheck;
  const readFile = d.readFile;
  const resolvePath = typeof d.resolvePath === 'function' ? d.resolvePath : (_root, f) => f;

  /**
   * @param {{ baseVerify: Function, targetFile: string, beforeErrorCount: number, root: string }} cfg
   */
  return function wrap(cfg) {
    const { baseVerify, targetFile, beforeErrorCount, root } = cfg;
    return async function verify(args) {
      const base = await baseVerify(args);
      if (!base || base.ok !== true) return base; // npm test 没绿 → 不必跑 typecheck,直接返回
      let output = '';
      // fail-closed(2026-06-29 修复):typecheck 跑不了/输出空 → 不能验证 → reject(绝不放行)。
      //   根因教训:原 fail-open 在 launchd PATH 无 npm → spawnSync 空输出 → countFileTypeErrors('')=0 → 误判 after=0 总放行 = 假 complete。
      try { output = await runTypecheck(); } catch { return { ...base, ok: false, reason: 'type_error_fix_rejected: typecheck 无法运行,不能验证' }; }
      if (!output || !String(output).trim()) return { ...base, ok: false, reason: 'type_error_fix_rejected: typecheck 输出空,不能验证' };
      const after = countFileTypeErrors(output, targetFile);
      let content = '';
      try { content = readFile(resolvePath(root, targetFile), 'utf8'); } catch { content = ''; }
      const assess = assessTypeErrorFix({ patchText: content, beforeErrorCount, afterErrorCount: after });
      if (!assess.ok) return { ...base, ok: false, reason: `type_error_fix_rejected: ${assess.reason}` };
      return base;
    };
  };
}
