// @ts-check
// NoeMemoryConflictPolicy — 事实更新/冲突/更替的确定性策略层。
// 这是 MemoryCore 写路径旁边的纯函数口径：先把 Mem0/Letta/Graphiti/Zep 式“事实会变”
// 变成可测判定，再由后续整理/写入层选择是否应用。
import { normalizeForDedup, textSimilarity } from './NoeMemoryDedup.js';

const UNCERTAIN_RE = /也许|可能|大概|似乎|猜|推测|maybe|probably|might/i;

function textOf(fact) {
  return String(fact?.text || fact?.body || fact?.content || '').trim();
}

function confidenceOf(fact) {
  const n = Number(fact?.confidence);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.7;
}

function salienceOf(fact) {
  const n = Number(fact?.salience);
  return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.trunc(n))) : 3;
}

function sourceRank(fact) {
  const s = String(fact?.source || fact?.sourceType || fact?.source_type || '').toLowerCase();
  if (/owner|user|interaction/.test(s)) return 3;
  if (/memory|manual|fact/.test(s)) return 2;
  if (/reflection|dream|model|llm|infer/.test(s)) return 1;
  return 2;
}

function factSlot(text) {
  const t = String(text || '');
  if (/咖啡|美式|拿铁|饮品|喝/.test(t) && /喜欢|偏好|改喝|现在/.test(t)) return 'drink_preference';
  // location：居住/搬迁动词，或"在…工作/生活/定居"结构，或"城市名+位置语境且非美食/天气/出行"——
  // 既识别"住成都/在南京工作/搬到上海"，又不把"喜欢北京烤鸭""现在北京天气"误判为地点（codex post-review 返工）。
  if (/住在|常住|搬到|搬去|搬家|居住|定居|现居|老家|户口|户籍/.test(t)
    || /在[一-龥]{2,10}(工作|上班|生活|定居|居住|安家)/.test(t)
    || (/成都|上海|北京|深圳|杭州|广州|南京|武汉|重庆|西安|苏州|天津/.test(t)
        && /住|搬|在|定居|居住|老家|工作|生活/.test(t)
        && !/烤鸭|天气|菜|小吃|美食|出差|旅游|玩|逛/.test(t))) return 'location';
  if (/生日|纪念日/.test(t)) return 'date_fact';
  // identity：姓名/身份关键词，或"(用户/我/他/她…)叫X"称谓、"叫做X"——避免"爱吃叫花鸡"，但识别"用户叫李雷"（codex post-review 返工补"用户"主语）。
  if (/名字|身份|职业|老婆|妻子|家人/.test(t)
    || /(?:用户|我|他|她|你|名字|姓名)\s*叫\s*[一-龥A-Za-z]/.test(t)
    || /叫做\s*[一-龥A-Za-z]/.test(t)) return 'identity';
  return '';
}

function explicitChange(text) {
  return /现在|改成|改喝|不再|换成|搬到|搬去|已经|从.+到/.test(String(text || ''));
}

/**
 * @param {{oldFact?:object,newFact?:object,now?:number}} input
 * @returns {{action:'merge'|'supersede'|'keep_both'|'ignore'|'needs_review', reason:string, slot?:string, validTo?:number|null}}
 */
export function decideMemoryConflict({ oldFact = {}, newFact = {}, now = Date.now() } = {}) {
  const oldText = textOf(oldFact);
  const newText = textOf(newFact);
  if (!newText) return { action: 'ignore', reason: 'empty_new' };
  if (!oldText) return { action: 'keep_both', reason: 'no_old_fact' };

  const newConfidence = confidenceOf(newFact);
  if (UNCERTAIN_RE.test(newText) && newConfidence < 0.6) return { action: 'ignore', reason: 'uncertain_low_confidence' };

  const oldNorm = normalizeForDedup(oldText);
  const newNorm = normalizeForDedup(newText);
  if (oldNorm && oldNorm === newNorm) return { action: 'merge', reason: 'exact_duplicate' };
  // 近重复(内容不完全相同)可能是"只改了关键值"的矛盾事实(如生日改一天)，合并前必须先尊重
  // protected/弱源保护——否则弱源近重复会绕过下面的 salience>=5 保护、直接覆盖 owner 高盐事实。
  if (textSimilarity(oldText, newText) >= 0.72
    && !(salienceOf(oldFact) >= 5 && sourceRank(newFact) < sourceRank(oldFact))) {
    return { action: 'merge', reason: 'near_duplicate' };
  }

  const oldSlot = factSlot(oldText);
  const newSlot = factSlot(newText);
  if (!oldSlot || oldSlot !== newSlot) return { action: 'keep_both', reason: 'different_slot' };

  if (salienceOf(oldFact) >= 5 && sourceRank(newFact) < sourceRank(oldFact)) {
    return { action: 'needs_review', reason: 'protected_fact_conflict', slot: oldSlot };
  }
  if (sourceRank(newFact) < sourceRank(oldFact) && newConfidence < 0.75) {
    return { action: 'ignore', reason: 'weaker_source_low_confidence', slot: oldSlot };
  }

  return {
    action: explicitChange(newText) || newConfidence >= 0.75 ? 'supersede' : 'needs_review',
    reason: explicitChange(newText) ? 'explicit_update' : 'same_slot_conflict',
    slot: oldSlot,
    validTo: Number.isFinite(Number(now)) ? Number(now) : null,
  };
}
