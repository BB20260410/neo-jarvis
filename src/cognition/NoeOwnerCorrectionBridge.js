// @ts-check
// NoeOwnerCorrectionBridge — 阶段1 P1 根除必须：owner 否定 Neo 事实判断 = 最强 epistemic 源。
//
// 三方(M3/codex)共识：现有 NoeOwnerBehaviorPredictor 只覆盖「owner 取消 followup」(行为层)，不覆盖对话里
//   「你说错了 / 不对 / 其实是 X」的【事实纠正】。owner 直接否定 Neo 判断 = 带 label 的 ground truth =
//   阶段1 最高信号 surprise；不接 = Neo 反复给错答案、owner 反复纠正、没记忆→反复犯（用户体验致命洞）。
//
// 解法：owner interaction 文本含明确【纠正信号】(区别于取消任务) → harvestSurprise(owner_correction)。
//   owner 纠正本身即「我的某个认知被权威否定」= 被现实打脸，不需精确关联 Neo 上一句(纠正信号已是足够证据)。
//
// 纪律：注入式，去重限速，flag NOE_OWNER_CORRECTION 默认 OFF。
//   origin='owner_correction' 以 owner_ 开头 → isNonNoiseSurpriseOrigin 已认非噪声(无需改)。

// owner 明确纠正 Neo 事实判断的信号（区别于「取消任务」——那归 NoeOwnerBehaviorPredictor 的 followup 否定）。
// OC-FALSEPOS-2（Claude 第三轮）：移除单独「应该是/记错」(陈述/owner 自陈易误判)，保留明确纠正词 + 「不是…而是」结构。
// OC-FALSEPOS-3（修三方审查 serious）：再移除「其实是/实际上是」——owner 主动陈述事实(「其实那家店周一不开门」「实际上是下周三」)
//   高频命中却非否定 Neo，会刷假 owner_correction surprise=3；真纠正必含明确否定词(不对/错/不是…而是)已覆盖，「其实不是X而是Y」由「不是.{1,12}而是」兜住。
const CORRECTION_RE = /(?:不对|搞错|说错|弄错|理解错|你错|不是这样|并不是|不是.{1,12}而是|that'?s\s+wrong|incorrect|you'?re\s+wrong)/i;
// 排除疑问/反问/求助/缓和/owner 自陈语气（不是断言纠正 Neo）。codex+Claude 复盘：「其实应该怎么办」求助、
//   「其实不是很急」缓和、「我记错了」owner 自陈，都非纠正 Neo。
// OC-FALSEPOS-4（修三方审查 minor）：「你错怪我了」是 owner 说 Neo 错怪了 owner(反向，非世界事实纠正)，加进排除。
const NON_CORRECTION_RE = /[?？]\s*$|不对吗|是不是|对不对|错了吗|应该(?:怎|如何|要不要|多少|什么|啥)|其实(?:我|想|要|该)|我(?:记|搞|弄|说|理解|看|算)错|你错怪/;
// OC-FALSEPOS-5（修三方审查 serious）：「不是+缓和量词」(不是很/太/那么…)原混在 NON_CORRECTION_RE 里会误杀
//   「不对，不是很安全而是有风险」这种(明确否定 + 不是X而是Y结构)的真纠正(本应最强 surprise=3)。拆出单独判，
//   仅在无强否定结构时才算缓和排除。
const SOFTENING_RE = /不是(?:很|太|那么|挺|蛮|特别)/;
const STRONG_CORRECTION_RE = /不对|搞错|说错|弄错|理解错|不是.{1,12}而是/;

// OC-POLLUTION-1（Claude 第三轮致命）：ownerInteractionWatcher 喂的 timeline summary 是「主人说"X"，我答"Y"」格式，
//   含 Neo 自己回复——Neo 回复里的「其实是/不对/并不是」会刷最强假 surprise。只取 owner 原话段，剥离 Neo 回复。
function extractOwnerSpeech(text) {
  const raw = String(text || '').trim();
  const seg = raw.match(/主人说[:：]?\s*["“「『](.+?)["”」』]/); // 标准 summary：只留引号内 owner 原话
  if (seg) return seg[1].trim();
  // 含 Neo 回复标志但格式不标准→剥「我答/我回/我说…」尾段 + 去「主人说」前缀
  if (/(?:^|[，,\s])我(?:答|回答|回复|说)/.test(raw)) {
    return raw.split(/[，,]?\s*我(?:答|回答|回复|说)[:：]?/)[0].replace(/^主人说[:：]?\s*["“「『]?/, '').replace(/["”」』]\s*$/, '').trim();
  }
  return raw; // 非 summary 格式（其他对话入口的 owner 原话）原样用
}

export function createOwnerCorrectionBridge({
  goalSystem,
  now = Date.now,
  surpriseThreshold = 2,
  correctionSurprise = 3, // owner 纠正是最强 epistemic 信号(带 label ground truth)，故高于 worldModel 矛盾的 2.5
  dedupWindowMs = 6 * 3600 * 1000,
  maxPerHour = 6,
} = {}) {
  const recent = new Map(); // 纠正文本指纹 → ts
  const hourly = [];
  const fp = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 60);

  /**
   * owner 交互文本进来时调用（接 ownerInteractionWatcher / 对话入口）。
   * @returns {{corrected?:boolean, curiosityGoalId?:any, skipped?:string}|null}
   */
  function onOwnerInteraction({ text } = {}) {
    if (process.env.NOE_OWNER_CORRECTION !== '1') return null;
    if (!goalSystem?.harvestSurprise) return null;
    const t = extractOwnerSpeech(text); // OC-POLLUTION-1：剥离 Neo 回复，只判 owner 原话
    if (t.length < 4) return null;
    if (!CORRECTION_RE.test(t) || NON_CORRECTION_RE.test(t)) return null; // 非纠正 / 疑问语气
    if (SOFTENING_RE.test(t) && !STRONG_CORRECTION_RE.test(t)) return null; // 缓和量词(不是很/太…)仅在无强否定前缀时排除（OC-FALSEPOS-5）
    try {
      const now_ = now();
      const key = fp(t);
      const last = recent.get(key);
      if (last && now_ - last < dedupWindowMs) return { skipped: 'deduped' };
      while (hourly.length && now_ - hourly[0] > 3600 * 1000) hourly.shift();
      if (hourly.length >= maxPerHour) return { skipped: 'rate_limited' };
      if (recent.size >= 1000) recent.delete(recent.keys().next().value); // F8：防 recent Map 无界增长
      recent.set(key, now_);
      hourly.push(now_);
      const claim = `owner 纠正了我的判断：${t.slice(0, 150)}`;
      if (correctionSurprise < surpriseThreshold) return { corrected: true, curiosityGoalId: null };
      const curiosityGoalId = goalSystem.harvestSurprise({ claim, surprise: correctionSurprise, origin: 'owner_correction' });
      return { corrected: true, curiosityGoalId };
    } catch { return null; }
  }

  return { onOwnerInteraction };
}
