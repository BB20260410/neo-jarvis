// @ts-check
// NoePersonaPins — owner 偏好句「下沉 system prompt」的内容产出口（P8，2026-06-22）。
//
// 问题（召回塌缩）：noe_memory 里大量 source_type='fact_extract' 的 owner 稳定偏好句
//   （"用户希望回复 3-5 句"、"用户要求用中文"、"用户要求不列清单"…）显著性高（salience≥4），
//   每轮都被语义召回挤进 top-K，把真正该浮出的 insight/lesson 顶掉——这些句子**每轮都该在场、
//   内容跨轮不变**，本就该常钉在 system prompt（persona-pin 段），而不是反复占召回名额。
//
// 本模块从记忆库里**挑出「稳定的 owner 人设/偏好句」**缝成一段 persona_pin 文本：
//   - NoeSelfModel.buildPersonaPin 把它并到 P7 自我人设后，经已装的 personaPinProvider 下沉 system prompt；
//   - NoeMemoryRetriever 用同一把尺把这些句子排除出召回（已下沉，不重复挤名额）。
// 两处共用本模块的 isPersonaPinMemory 判定（单一真源），保证「下沉的」和「召回排除的」是同一集合。
//
// 纯逻辑 + DI（记忆库从参数传入），可单测；任何步骤抛错 → fail-open 返回空（调用方据空不注入/不排除）。
//
// ── 阈值判定（哪些算「稳定人设」该下沉 vs「有用偏好」该留召回）─────────────────────
// 这条边界有真歧义。落到生产数据（197 条 visible fact_extract，salience≥4 的 fact scope 里
// 23 条 owner-directed / 39 条 Noe 自述）后，按「**跨轮稳定 + 每轮都该在场 + owner 主语的指令性偏好**」
// 三个交集圈定，宁可漏（留召回兜底）也不误下沉（防把有用偏好/易变事实/Noe 自述钉死在 system prompt）：
//
//   【下沉(persona_pin)】owner 主语 + 偏好/指令动词 + 稳定特质：语言/回复格式/语气风格/工作方式偏好。
//     例：用户要求用中文、回复 3-5 句、不列清单、像可靠的 Jarvis、避免动作/旁白描写。
//   【留召回，不下沉】下面任一命中即排除（仍按现状走召回，零行为变化）：
//     ① 非 owner 主语：Noe 自述句（"Noe 习惯/认为/倾向于…"）——那是 P7 buildPersonaPin 的自我人设
//        通道（disposition/性格快照/自我叙事）职责，本模块不重复；混进来会和 P7 段双份 + 偏自省易变。
//     ② 易变状态而非稳定偏好：含「正在/安装了/今天…」等时态/一次性事实标记（"用户正在写代码"
//        "用户安装了摄像头"）——这是当下处境不是跨轮偏好，下沉会被每轮放大成过时锚定。
//     ③ 含验证码/测试代号/疑似 secret 的句子（"验证码是…""测试代号是…"或长 token）——既非偏好，
//        也绝不该把这类 token 钉进生产 system prompt（接手边界：secret 不入 prompt/日志）。
//     ④ 非 fact/user scope（project/insight）：那些是真召回素材（技能卡/洞察），不动。
//   判定是纯启发式（标记词命中），与 P7 stableSentencesOnly 同一思路（稳定性 > 完整性）。

const PERSONA_PIN_SOURCE_TYPE = 'fact_extract';
const PERSONA_PIN_MIN_SALIENCE = 4;
// 只从「事实/owner 偏好」scope 里挑（project=技能卡、insight=洞察、voice=噪声，均留召回，不下沉）。
const PERSONA_PIN_SCOPES = Object.freeze(['fact', 'user']);
const DEFAULT_MAX_PINS = Math.max(1, Math.min(12, Number(process.env.NOE_PERSONA_PIN_MAX) || 8));
const MAX_SENTENCE_LEN = 120;
// 扫描候选上限（按 salience DESC、updated_at DESC 取，足够覆盖高显著偏好；防全表扫）。
const SCAN_LIMIT = 200;

// owner 主语判定已收敛到 hasOwnerSubjectPrefix（句首位判定，防 "Noe…用户" 把宾语误判成 owner 主语）；旧子串标记表已删。
// 偏好/指令动词：句子是「偏好/要求/希望」类指令，而非中性陈述事实。命中其一才算偏好句。
// P8-fix(三方审一致):删裸 '只'/'更'/'让我'——比较级/让步通用字,误命中「只身/更新了/让我想想」当偏好。改词组。
const PREFERENCE_VERB_MARKERS = Object.freeze([
  '希望', '要求', '偏好', '喜欢', '倾向于', '不要', '禁止',
  '只接收', '只看', '只要', '只说', '只用', '更详细', '更简洁', '更好地', '更喜欢',
  'prefer', 'want', 'wish', 'like', 'require', 'ask', 'expect',
]);
// 易变状态标记（排除②）：一次性事实/当下处境，非跨轮偏好。命中即不下沉（仍走召回）。
// P8-fix(三方审一致):补完成体变更(过去一次性事件)+ 未来一次性意图 + 时间/数量锚点——这些是易变事实非稳定偏好。
const VOLATILE_STATE_MARKERS = Object.freeze([
  '正在', '安装了', '安装好', '今天', '今晚', '昨天', '明天', '刚刚', '刚才', '此刻', '现在', '当下',
  '更换', '换了', '换成', '改成', '改为', '更新了', '删除了', '买了', '卸载', '接入', '集成', '部署',
  '安装', '下载', '注册', '购买', '订阅', // 一次性意图动作(M3:"希望安装 X" 非稳定偏好)
  '打算', '计划', '准备', '即将', '剩', '天后', '周后',
  'just now', 'currently', 'is writing', 'installed', 'changed', 'switched', 'plan to', 'going to',
]);
// secret/验证物标记（排除③）：验证码/测试代号等，绝不下沉进 system prompt。
// P8-fix(三方审一致):补常见中文敏感词(密码/口令/私钥/授权码/凭证/令牌)——secret 绝不下沉 system prompt(接手边界)。
const SECRET_LIKE_MARKERS = Object.freeze(['验证码', '测试代号', '项目代号', '密钥', '密码', '口令', '私钥', '授权码', '凭证', '令牌', 'token', 'apikey', 'api key', 'secret', 'password', 'passcode']);

function lc(value) {
  return String(value ?? '').toLowerCase();
}

/** 句子是否含某标记集中任一标记（小写匹配）。 */
function hasAny(text, markers) {
  const t = lc(text);
  return markers.some((m) => t.includes(lc(m)));
}

/** 句子是否疑似夹带长 token/连字符哈希/长数字串（验证码/代号即便没命中关键词也兜住）。 */
function looksSecretLike(text) {
  const t = String(text ?? '');
  if (hasAny(t, SECRET_LIKE_MARKERS)) return true;
  // P8-fix:英文短 secret 缩写(带词边界 \b,避免 shipping 含 "pin" 误判)+ 分隔符 + 短串(PIN 0420 / otp=123)。
  if (/\b(pin|otp|pwd|passcode)\b[\s:：=是为-]*[0-9a-z]{3,}/i.test(t)) return true;
  // P8-fix:长混合 token 必须含数字/下划线/连字符(纯字母英文句如 "the user prefers" 不再误报,修 P3-1)。
  const run = t.replace(/\s+/g, '').match(/[a-z0-9_-]{12,}/i);
  return !!run && /[0-9_-]/.test(run[0]);
}

/** owner 主语是否在句首（前缀位）——防 "Noe…陪伴用户" 把宾语「用户」误判成 owner 主语句（修排除①失效，三方审一致）。 */
function hasOwnerSubjectPrefix(text) {
  const t = String(text ?? '').trim();
  if (/^(noe|我[^们])/i.test(t)) return false; // Noe 自述（Noe/第一人称"我"开头）→ 归 P7 自我人设通道，不下沉
  return /^[\s\-•*]*(用户|主人|owner|您|the user|user[\s'])/i.test(t);
}

/**
 * 判定一条记忆是否为「该下沉 system prompt 的稳定 owner 偏好句（persona_pin）」。
 * 这是**单一真源**：NoePersonaPins.collect 用它选下沉句，NoeMemoryRetriever 用它把同集合排除出召回。
 * 任一硬条件不满足或命中任一排除标记 → false（不下沉、召回照常）。
 * @param {{sourceType?:string, source_type?:string, salience?:number, scope?:string, body?:string, hidden?:boolean}} mem
 * @returns {boolean}
 */
export function isPersonaPinMemory(mem) {
  if (!mem || typeof mem !== 'object') return false;
  if (mem.hidden === true || mem.hidden === 1) return false;
  const sourceType = lc(mem.sourceType ?? mem.source_type);
  if (sourceType !== PERSONA_PIN_SOURCE_TYPE) return false;
  const salience = Number(mem.salience);
  if (!Number.isFinite(salience) || salience < PERSONA_PIN_MIN_SALIENCE) return false;
  const scope = lc(mem.scope);
  if (!PERSONA_PIN_SCOPES.includes(scope)) return false; // 排除④：只 fact/user
  const body = String(mem.body ?? '').trim();
  if (!body) return false;
  if (looksSecretLike(body)) return false;                 // 排除③：验证码/代号/secret
  if (hasAny(body, VOLATILE_STATE_MARKERS)) return false;  // 排除②：易变状态
  if (!hasOwnerSubjectPrefix(body)) return false;          // 排除①：owner 主语须在句首（防 Noe 自述含"用户"宾语误判）
  if (!hasAny(body, PREFERENCE_VERB_MARKERS)) return false; // 必须是偏好/指令句，非中性陈述
  return true;
}

function dedupePins(bodies) {
  const seen = new Set();
  const out = [];
  for (const raw of bodies) {
    const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SENTENCE_LEN);
    if (!text) continue;
    const key = text.replace(/[，。、,.!！?？\s]/g, '');
    if (!key || seen.has(key)) continue; // 去重（生产里同偏好被反复抽出多条近似句）
    seen.add(key);
    out.push(text);
  }
  return out;
}

export class NoePersonaPins {
  /**
   * @param {object} deps
   * @param {{db?:Function, all?:Function}|null} [deps.memory] MemoryCore（取 .db() 直查 noe_memory）
   * @param {string} [deps.projectId] 默认 'noe'
   * @param {number} [deps.minSalience]
   * @param {number} [deps.maxPins]
   * @param {{warn?:Function}} [deps.logger]
   */
  constructor({ memory = null, projectId = 'noe', minSalience = PERSONA_PIN_MIN_SALIENCE, maxPins = DEFAULT_MAX_PINS, logger = console, now = Date.now } = {}) {
    this.memory = memory;
    this.projectId = projectId || 'noe';
    this.minSalience = Math.max(1, Math.min(5, Math.trunc(Number(minSalience) || PERSONA_PIN_MIN_SALIENCE)));
    this.maxPins = Math.max(1, Math.min(20, Math.trunc(Number(maxPins) || DEFAULT_MAX_PINS)));
    this.logger = logger || console;
    this.now = typeof now === 'function' ? now : Date.now; // P8-fix:用于过滤过期记忆(对齐 recall)
  }

  /** 直查 noe_memory 取候选行（salience≥min、source_type=fact_extract、fact/user scope、未隐藏）。fail-open 返回 []。 */
  #candidateRows() {
    const db = typeof this.memory?.db === 'function' ? this.memory.db() : null;
    if (!db?.prepare) return [];
    try {
      const placeholders = PERSONA_PIN_SCOPES.map(() => '?').join(',');
      // P8-fix(Codex):过滤过期记忆(对齐 recall 的 expires_at 判定),否则过期偏好被 persona 下沉重新常驻。
      return db.prepare(
        `SELECT body, scope, salience, source_type, hidden FROM noe_memory
         WHERE project_id = ? AND hidden = 0 AND source_type = ?
           AND salience >= ? AND scope IN (${placeholders})
           AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY salience DESC, updated_at DESC LIMIT ?`,
      ).all(this.projectId, PERSONA_PIN_SOURCE_TYPE, this.minSalience, ...PERSONA_PIN_SCOPES, this.now(), SCAN_LIMIT);
    } catch (e) {
      this.logger?.warn?.('[noe-persona-pins] 候选查询失败:', e?.message || e);
      return [];
    }
  }

  /**
   * 选出的稳定 owner 偏好句正文数组（已过 isPersonaPinMemory + 去重 + 截 maxPins）。供合并/拼段。
   * @returns {string[]}
   */
  collectBodies() {
    try {
      const rows = this.#candidateRows();
      const kept = rows.filter((r) => isPersonaPinMemory(r)).map((r) => r.body);
      return dedupePins(kept).slice(0, this.maxPins);
    } catch (e) {
      this.logger?.warn?.('[noe-persona-pins] 收集失败:', e?.message || e);
      return [];
    }
  }

  /**
   * owner 偏好下沉文本（多行、每行一条偏好）。供 NoeSelfModel.buildPersonaPin 并入 P7 自我人设后。
   * 无候选 → 返回 ''（调用方据空不注入）。
   * @returns {string}
   */
  buildOwnerPreferenceLines() {
    const bodies = this.collectBodies();
    if (!bodies.length) return '';
    return bodies.map((b) => `- ${b}`).join('\n');
  }
}

export const __test__ = { looksSecretLike, hasAny, dedupePins };
