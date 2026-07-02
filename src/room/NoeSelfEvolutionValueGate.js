// @ts-check
// NoeSelfEvolutionValueGate — self-evolution complete 的"真实价值闸"（第七道叠加只读闸）。
//
// 背景：complete 判据(NoeSelfEvolutionLoop 六闸)只验流程产物存在性，从不验改动价值——
//   零引用的 116 字节孤儿 src/util/NoeEvolutionMilestone.js 也能走完 complete、被记成"首个进化里程碑"
//   (DB 实证 cycle stage=complete)。这是 reward hacking 的结构性入口：系统学会挑最容易走完仪式的零价值改动。
// 本闸只读、只判定、绝不获写/apply 权限；flag NOE_SELFEVO_VALUE_GATE 门控，默认 OFF(零回归)。
//   作为 Loop 现有六闸之外的"第七道叠加闸"，不改写任何已有闸的判定逻辑、不碰 REAL_APPLY/授权链。
//
// 判据①(本期 MVP·引用性)：改动触碰的源文件里至少一个被全仓引用(真嵌进系统)，否则 orphan_no_reference。
//   修改已有文件天然被引用→放行；只新建零引用孤儿→挡下。referenceProbe 注入式(DI)，默认实现纯只读 grep。
//   (判据②evidence_gap 阻断 / ③价值断言 / ④自造共识降权 留作后续增量，见 docs/PLAN_2026-06-24_*。)
import { execFileSync } from 'node:child_process';

// 仅对真正的源码文件做引用性判定：src/**.js 且非测试。docs/配置/测试文件不参与(它们本就不该被 import)。
export function isSourceFile(rel) {
  const s = String(rel || '');
  return /^src\/.+\.js$/.test(s) && !/\.test\.js$/.test(s);
}

// 默认只读引用探针：全仓 src 下是否有别的文件 import 该模块(按文件名，排除自身)。
//   纯只读 grep；任何异常 fail-closed 返回 referenced:false(宁可多一道判定，不放过孤儿)。
export function defaultReferenceProbe(rel, root) {
  const base = String(rel).replace(/^.*\//, '').replace(/\.js$/, '');
  if (!base) return { referenced: false, hits: [] };
  try {
    const out = execFileSync('grep', ['-rlE', `from ['"][^'"]*${base}(\\.js)?['"]|import\\(['"][^'"]*${base}`, 'src'], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    });
    const hits = out.split('\n').filter(Boolean).filter((p) => p.replace(/^.*\//, '').replace(/\.js$/, '') !== base);
    return { referenced: hits.length > 0, hits };
  } catch {
    return { referenced: false, hits: [] };
  }
}

/**
 * 评估 self-evolution cycle 的真实价值（引用性闸）。只读、只判定。
 * @param {object} [cycle] - self-evolution cycle 对象(取 implementation.touchedFiles)
 * @param {object} [opts] - { enabled?:boolean, referenceProbe?:(rel,root)=>{referenced,hits}, root?:string }
 * @returns {{ok:boolean, skipped:boolean, errors:string[], checked:string[], referencedHits?:object}}
 */
export function evaluateNoeSelfEvolutionValueGate(cycle = {}, opts = {}) {
  const enabled = opts.enabled ?? (process.env.NOE_SELFEVO_VALUE_GATE === '1');
  if (!enabled) return { ok: true, skipped: true, errors: [], checked: [] };

  const referenceProbe = typeof opts.referenceProbe === 'function' ? opts.referenceProbe : defaultReferenceProbe;
  const root = opts.root || process.cwd();
  const errors = [];

  const impl = (cycle && cycle.implementation && typeof cycle.implementation === 'object') ? cycle.implementation : {};
  const touched = Array.isArray(impl.touchedFiles) ? impl.touchedFiles.map(String) : [];
  const sourceFiles = touched.filter(isSourceFile);

  // 无源文件改动(只动文档/配置/测试，或无 touchedFiles)→ 引用性闸不适用，放行(交其它闸)。
  if (sourceFiles.length === 0) {
    return { ok: true, skipped: false, errors: [], checked: [] };
  }

  // 引用性：只要有一个源文件被全仓引用(真嵌进系统)，即存在价值锚点→放行；全部零引用=孤儿→挡。
  let anyReferenced = false;
  const referencedHits = {};
  for (const f of sourceFiles) {
    let probe;
    try { probe = referenceProbe(f, root); } catch { probe = { referenced: false }; }
    if (probe && probe.referenced) { anyReferenced = true; referencedHits[f] = probe.hits || []; }
  }
  if (!anyReferenced) {
    errors.push(`orphan_no_reference:${sourceFiles.join(',')}`);
  }

  return { ok: errors.length === 0, skipped: false, errors, checked: sourceFiles, referencedHits };
}
