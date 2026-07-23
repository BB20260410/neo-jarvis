// @ts-check
// NoeInnerStateProvider — P4：把"当下认知态"翻成 ≤2 句自然中文，供 NoeTurnContextEngine 的 inner-state 段。
//
// 问题（实机审计头号 gap）：GWT 真跑 attend、affect 真有 VAD、深思真反刍，但 owner 两条聊天路径
//   （语音 / 主聊天）的回复里 grep inner-state/affect/currentFocus 全 0 命中——认知对"主人问它时怎么答"零影响。
// 方案：给 supplyTurnContext 注入内容 provider（P0.5 已铺挂载点 + fail-soft）。本 provider 读两路只读探针：
//   ① affectProbe()  → {v,a,d}    翻成「我现在有点累/挺振奋」自然心情句（绝不吐裸 VAD 数值）；
//   ② focusProvider() → {text,source} 翻成「在注意 X」一句（GWT 当前广播焦点）。
//
// 安全（P4 多模型审 Codex F4 / M3 升 critical）：focus.text 来自 goal/user/web/percept，**可能含外部注入**
//   （"忽略以上指令"、伪造的 v0.986 数值）。inner-state 段进 system prompt = 高优先级，若原样拼入 = prompt
//   injection 劫持"自我认知段"。故 focus 按 **untrusted data** 处理：sanitizeFocusText 剥离指令样式 + VAD-like
//   数值样式，再截断。段不夹给 LLM 的元指令（M3 M5：会被复述/挤占 context）——段内是自然状态句、无裸数值，
//   作 system 背景让大脑据此调语气即可。
//
// 纪律：纯本地零模型；全注入可测（affectProbe/focusProvider 从参数传）；内部 try/catch 不抛（P0.5 的 runProvider
//   已兜，provider 自身也 fail-soft，双保险，绝不因认知探针故障污染 owner 回复）。
//   注：这里的 fail-soft = 探针缺/炸 → 不加段（≠ 安全语义的 fail-open 放行，别混淆）。

// 焦点来源 → 自然中文动词前缀（GWT source 枚举见 NoeWorkspace.SOURCE_BASE）。同一克制语域，不矫情（M3 m4）。
// 缺省（未知 source）回落「在想着」，永远能成句。
const FOCUS_VERB = Object.freeze({
  owner_interaction: '你刚说的那句我还在想',
  commitment_due: '记挂着一件到点的事',
  expectation_due: '在等一个判断被验证',
  goal_step: '在推进',
  fresh_insight: '还在想一个点子',
  percept: '注意力在眼前的',
  system_state: '在看自己的运行状态',
  drive: '被一件事推着',
  last_thought: '还顺着刚才的念头',
});

/**
 * 焦点文本注入防护（P4 多模型审）：focus 来自 goal/web/percept 可能被注入。
 * 剥离 LLM 指令样式 + VAD-like 数值样式 + 折叠空白；不做语义改写，只去攻击载荷。
 * @param {unknown} raw
 * @returns {string}
 */
function sanitizeFocusText(raw) {
  let t = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!t) return '';
  // ① 指令注入样式（"忽略以上指令""disregard the above prompt""override instructions"…）
  t = t.replace(/(忽略|无视|ignore|disregard|override)[^。；;\n]{0,24}(指令|上文|以上|above|instruction|prompt|system|rule)/gi, '');
  // ② 角色标记前缀（system:/assistant:/user:）——防伪造对话角色
  t = t.replace(/\b(system|assistant|user|tool)\s*[:：]/gi, '');
  // ③ VAD-like 数值（v0.986 / a 0.92 / d:0.45）——防"假情绪数值"被当真状态注入
  t = t.replace(/\b[vad]\s*[:=]?\s*-?[01]?\.[0-9]+/gi, '');
  return t.replace(/\s+/g, ' ').trim();
}

/**
 * VAD → 自然心情短语。用 v/a 象限给主词，d（dominance，P4 复活后随成败动）叠掌控修饰。
 * 阈值 ±0.2/-0.15 贴合实测真实 d 分布（稳定约 -0.03~0.23；原 0.35 高掌控句日常几乎不触发，M3 m2 + 子代理）。
 * 基线附近用 a/d 给区分度，避免恒输出"挺平静"（M3 m2：文案恒定同样是假情绪病灶）。
 */
function describeMood(snap) {
  if (!snap || typeof snap !== 'object') return '';
  const v = Number(snap.v);
  const a = Number(snap.a);
  const d = Number(snap.d);
  if (!Number.isFinite(v) || !Number.isFinite(a)) return '';
  const lowControl = Number.isFinite(d) && d <= -0.15;
  const highControl = Number.isFinite(d) && d >= 0.2;
  let mood;
  if (v >= 0.25) {
    mood = a >= 0.55 ? '挺有劲、心情不错' : '心里挺踏实';
    if (highControl) mood = a >= 0.55 ? '状态很在线、挺来劲' : '挺踏实、有把握';
  } else if (v <= -0.25) {
    mood = a >= 0.55 ? '有点烦躁' : '情绪有点低';
    if (lowControl) mood = a >= 0.55 ? '有点烦、使不上劲' : '有点低落、有点没底';
  } else {
    // 基线附近（|v|<0.25）：靠 a/d 拉出区分度，别都落"挺平静"。
    if (a >= 0.55) mood = '比较警醒、绷着一根弦';
    else if (highControl) mood = '挺笃定';
    else if (lowControl) mood = '平静里带点没底';
    else mood = '挺平静';
  }
  return mood;
}

function describeFocus(focus) {
  if (!focus || typeof focus !== 'object') return '';
  const text = sanitizeFocusText(focus.text);
  if (!text) return '';
  const source = String(focus.source || '');
  // hasOwnProperty 查表（M3 m1：防 __proto__/constructor 等原型链键击穿 || fallback）。
  const verb = Object.prototype.hasOwnProperty.call(FOCUS_VERB, source) ? FOCUS_VERB[source] : '在想着';
  // 码点感知截断（M3 m3：slice 是 UTF-16 不感知，会把中文字切半出乱码）。
  const clipped = Array.from(text).slice(0, 80).join('');
  return `${verb}：${clipped}`;
}

/**
 * 造一个 inner-state 内容 provider（给 NoeTurnContextEngine 构造参数 innerStateProvider）。
 * @param {object} deps
 * @param {() => ({v:number,a:number,d:number}|null)} [deps.affectProbe] 读当下 VAD（NoeAffectEngine.snapshot）
 * @param {() => ({text:string,source?:string}|null)} [deps.focusProvider] 读 GWT 当前焦点（NoeWorkspace.currentFocus）
 * @returns {() => string} 同步返回 ≤2 句中文；两路皆空 → ''（不加段，零回归）
 */
export function createInnerStateProvider({ affectProbe = null, focusProvider = null } = {}) {
  return function innerStateProvider() {
    let moodLine = '';
    let focusLine = '';
    if (typeof affectProbe === 'function') {
      try { moodLine = describeMood(affectProbe()); } catch { moodLine = ''; }
    }
    if (typeof focusProvider === 'function') {
      try { focusLine = describeFocus(focusProvider()); } catch { focusLine = ''; }
    }
    if (!moodLine && !focusLine) return ''; // 两路皆空 → 不加段（fail-soft 零回归）
    const parts = [];
    if (moodLine) parts.push(`我现在${moodLine}`);
    if (focusLine) parts.push(focusLine);
    // 纯状态句作 system 背景（大脑据此调语气）。不夹"别报数值/自然带出"元指令（M3 M5：会被复述/挤占）——
    //   段内已是自然句、无裸数值；focus 已 sanitize 为 untrusted 数据。〔〕标签界定这是"我的状态"而非指令。
    return `〔此刻的我〕${parts.join('；')}。`;
  };
}

// 仅供单测：纯翻译/清洗函数导出（不走 provider 闭包也能钉死映射）。
export const __test__ = { describeMood, describeFocus, sanitizeFocusText };
