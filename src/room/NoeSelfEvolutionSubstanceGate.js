// @ts-check
// NoeSelfEvolutionSubstanceGate — self-evolution complete 的"实质闸"（第八道叠加只读闸，与引用性闸互补）。
// owner 拍板的假进化最小真拦：盖章点堵"自指/零外部价值"cycle——空改动(啥没改) / 纯自指产物(技能卡 + 临时日志截图)。
// 生产实锤(17 cycle 全 unverified)：假进化 complete 的 touchedFiles 全是 docs/skill-cards/*.md(自我表彰技能卡) 或空；
//   引用性闸 NoeSelfEvolutionValueGate "无源文件就放行"(只判 src/.js 孤儿)漏了这两类。本闸补：盖章前要求"真实系统
//   改动"，否则真拦(block complete)。"造 ValueError 日志+截图"这类纯仪式产物(.log/.png//tmp)也归零外部价值。
// 只读、只判定、绝不获写/apply 权限；flag NOE_SELFEVO_SUBSTANCE_GATE 门控，默认 OFF(零回归)。与引用性闸互补：
//   它管 src/.js 零引用孤儿，本闸管空 touchedFiles + 纯自指文档/临时产物。两闸都过才证明这次进化有真实外部价值。

// 自指/零外部价值产物：①自我表彰技能卡(docs/skill-cards/) ②临时日志/截图/图片(造 ValueError 仪式的典型产物)
//   ③/tmp 等临时路径。这些都不是"改进 Neo 真实能力"的改动——是给自己记一笔 / 造个一次性文件。
const SKILL_CARD_RE = /(^|\/)docs\/skill-cards\//i;
// 临时产物后缀：只锚定明确临时类型(.log/.tmp/.cap)。不含 .png/.jpg——真实图像资产同后缀，靠临时路径区分而非后缀
//   (判据审 MEDIUM：防误杀 public/*.png、assets/*.png 这类真实资产；临时截图靠下面 TMP_PATH_RE 拦)。
const EPHEMERAL_EXT_RE = /\.(log|tmp|cap)$/i;
// 临时路径：只锚定明确临时目录(/tmp、/var/folders、.tmp/、_evolution_artifacts/、__pycache__/)。不含 cache/temp 中间段——
//   src/cache/、src/runtime/cache/ 是真实源码模块(判据审 MEDIUM 防误杀)。临时路径下的截图/日志(造 ValueError 产物)仍被拦。
const TMP_PATH_RE = /^(\/private)?\/tmp\/|^\/var\/folders\/|(^|\/)(\.tmp|_evolution_artifacts|__pycache__)(\/|$)/i;

function isSelfReferentialArtifact(rel) {
  const s = String(rel || '').trim();
  if (!s) return true; // 空路径 = 无实质
  return SKILL_CARD_RE.test(s) || EPHEMERAL_EXT_RE.test(s) || TMP_PATH_RE.test(s);
}

/**
 * 评估 self-evolution cycle 是否有实质外部价值改动（实质闸）。只读、只判定。
 * @param {any} [cycle] - self-evolution cycle 对象（取 implementation.touchedFiles）
 * @param {object} [opts] - { enabled?:boolean }（enabled 未传时读 env NOE_SELFEVO_SUBSTANCE_GATE）
 * @returns {{ok:boolean, skipped:boolean, errors:string[], checked:string[]}}
 */
export function evaluateNoeSelfEvolutionSubstanceGate(cycle = {}, opts = {}) {
  const enabled = (opts && opts.enabled !== undefined) ? opts.enabled : (process.env.NOE_SELFEVO_SUBSTANCE_GATE === '1');
  if (!enabled) return { ok: true, skipped: true, errors: [], checked: [] };

  const impl = (cycle && typeof cycle === 'object' && cycle.implementation && typeof cycle.implementation === 'object')
    ? cycle.implementation : {};
  // 判据审 CRITICAL：先把 null/undefined 归空、对象元素解包({path}/{file})、trim，再 filter——原 map(String).filter(Boolean)
  //   顺序 bug：String(null)==='null' 是非空字符串会被 filter(Boolean) 留下 → 全 null 元素的病态 cycle 骗过空判定盖章。
  const touched = Array.isArray(impl.touchedFiles)
    ? impl.touchedFiles
      .map((x) => String(x && typeof x === 'object' ? (x.path || x.file || '') : (x == null ? '' : x)).trim())
      .filter(Boolean)
    : [];

  // 空改动：啥都没改还想盖 complete = 零实质（很多假进化 cycle touchedFiles=[] 仍走到盖章）。
  if (touched.length === 0) {
    return { ok: false, skipped: false, errors: ['no_substantive_change'], checked: [] };
  }
  // 全是自指产物（技能卡 / 临时日志截图）→ 没改进任何真实能力，零外部价值。
  const meaningful = touched.filter((f) => !isSelfReferentialArtifact(f));
  if (meaningful.length === 0) {
    return { ok: false, skipped: false, errors: [`self_referential_only:${touched.join(',')}`], checked: touched };
  }
  return { ok: true, skipped: false, errors: [], checked: touched };
}
