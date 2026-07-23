// PeerCritiqueGate — AutoScientists 式「提案 → 同行评审 → 只执行存活方案」门(peer-critique-before-compute)。
// 思想来源：mims-harvard/AutoScientists（arXiv 2605.28655，哈佛 Zitnik 实验室）——
//   多代理在花昂贵算力前先互相评审提案、剪掉弱的、合并重复的，避免把后续昂贵计算浪费在劣质/冗余方案上。
// Noe 用法：Arena 模式 N 份提案产出后、昂贵的联网 judge 核对前，先过这道门，judge 只核对存活方案。
//
// 设计铁律（守 Noe「不臃肿 + 本地优先 + 不破坏」）：
//   - fail-open：评审/解析任何异常 → 保留全部提案（绝不卡住房间）。
//   - 省 token：单次评审调用（评审员一次看全部匿名提案），默认用便宜的本地大脑当评审员。
//   - 不破坏：存活数至少 minSurvivors；提案数 < 3 直接跳过（没什么可剪）。

const DEFAULTS = { minSurvivors: 2, scoreThreshold: 5, maxProposalChars: 3500, dedupeThreshold: 0.85 };

// 评审 prompt：一次看全部匿名提案，逐份打分(0-10) + 保留/淘汰 + 一句理由。严格行格式便于解析。
export function buildCritiquePrompt(topic, proposals, maxChars = DEFAULTS.maxProposalChars) {
  const block = proposals
    .map((p) => `### 方案 ${p.anonId}\n${String(p.content || '').slice(0, maxChars)}`)
    .join('\n\n');
  return `你是严格但公正的同行评审员。下面是针对同一任务的 ${proposals.length} 份匿名方案。逐份评估「可执行性 / 正确性 / 针对性」，给 0-10 分，并判定保留(keep)还是淘汰(kill)。淘汰 = 明显空泛/跑题/有硬伤/与他案重复且更差。

任务：${topic}

${block}

只按下面格式逐行输出，一份一行，不要任何额外文字：
<编号> | <0-10分> | keep 或 kill | <一句理由>
例：
A | 7 | keep | 方案具体可落地、给了来源
B | 3 | kill | 泛泛而谈、无可执行步骤`;
}

// 解析评审员输出 → Map(anonId → {score, keep, reason})。宽松解析；解析不到的条目不产出（交给 fail-open）。
export function parseCritique(reply, anonIds) {
  const out = new Map();
  const valid = new Set((anonIds || []).map((s) => String(s).toUpperCase()));
  for (const line of String(reply || '').split('\n')) {
    const m = line.match(/^\s*[#\-*>\s]*([A-Z]|P\d+)\s*[|｜]\s*(\d{1,2})\s*[|｜]\s*(keep|kill|保留|淘汰)\s*[|｜]\s*(.*)$/i);
    if (!m) continue;
    const id = m[1].toUpperCase();
    if (!valid.has(id)) continue;
    const score = Math.max(0, Math.min(10, parseInt(m[2], 10)));
    const w = m[3].toLowerCase();
    const keep = w === 'keep' || w === '保留';
    out.set(id, { score, keep, reason: (m[4] || '').trim().slice(0, 200) });
  }
  return out;
}

// 近似重复检测（共享状态/避免重复劳动）：归一化分词 Jaccard。返回 Map(被判重复的较短提案 anonId → 指向的更优 anonId)。
export function findDuplicates(proposals, threshold = DEFAULTS.dedupeThreshold) {
  const toks = proposals.map(
    (p) => new Set(String(p.content || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/).filter((w) => w.length >= 2)),
  );
  const dupOf = new Map();
  for (let i = 0; i < proposals.length; i++) {
    for (let j = i + 1; j < proposals.length; j++) {
      const a = toks[i], b = toks[j];
      if (!a.size || !b.size) continue;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const jac = inter / (a.size + b.size - inter);
      if (jac >= threshold) {
        const shorterIdx = (proposals[i].content || '').length >= (proposals[j].content || '').length ? j : i;
        const keeperId = shorterIdx === j ? proposals[i].anonId : proposals[j].anonId;
        if (!dupOf.has(proposals[shorterIdx].anonId)) dupOf.set(proposals[shorterIdx].anonId, keeperId);
      }
    }
  }
  return dupOf;
}

// 选存活：keep=true 或 score>=阈值 的留下；被判重复的剔除；保证 >= minSurvivors（不足则按分数补回）。
export function selectSurvivors(proposals, verdicts, dupOf = new Map(), opts = {}) {
  const { minSurvivors = DEFAULTS.minSurvivors, scoreThreshold = DEFAULTS.scoreThreshold } = opts;
  const scored = proposals.map((p) => {
    const v = verdicts.get(p.anonId);
    return {
      ...p,
      _score: v ? v.score : 5,
      _keep: v ? v.keep : true,
      _reason: v?.reason || '',
      _dup: dupOf.get(p.anonId) || null,
    };
  });
  let survivors = scored.filter((p) => !p._dup && (p._keep || p._score >= scoreThreshold));
  if (survivors.length < minSurvivors) {
    const pool = scored.filter((p) => !survivors.includes(p)).sort((a, b) => b._score - a._score);
    for (const p of pool) {
      if (survivors.length >= minSurvivors) break;
      survivors.push(p);
    }
  }
  const rejected = scored.filter((p) => !survivors.includes(p));
  return { survivors, rejected };
}

export class PeerCritiqueGate {
  constructor({ broadcast = () => {}, minSurvivors = DEFAULTS.minSurvivors, scoreThreshold = DEFAULTS.scoreThreshold } = {}) {
    this.broadcast = broadcast;
    this.minSurvivors = minSurvivors;
    this.scoreThreshold = scoreThreshold;
  }

  /**
   * 评审一组提案，返回存活/剪除。
   * @param {{roomId, proposals:Array<{anonId,content,speaker?,displayName?,error?}>, topic, critic, abortSignal?}} args
   * @returns {Promise<{survivors, rejected, degraded:boolean, skipped?:boolean}>}
   */
  async evaluate({ roomId, proposals, topic, critic, abortSignal } = {}) {
    const valid = (proposals || []).filter((p) => p && p.content && !p.error);
    // 提案太少无需评审（没什么可剪），或没评审员 → 跳过，保留全部
    if (valid.length < 3 || !critic?.chat) {
      return { survivors: valid, rejected: [], degraded: false, skipped: true };
    }
    try {
      const dupOf = findDuplicates(valid);
      const result = await critic.chat(
        [
          { role: 'system', content: '你是严格但公正的同行评审员，只输出规定格式，不要解释。' },
          { role: 'user', content: buildCritiquePrompt(topic, valid) },
        ],
        { think: false, abortSignal, budgetContext: { roomId, taskId: 'peer-critique' } },
      );
      const verdicts = parseCritique(result?.reply, valid.map((p) => p.anonId));
      if (verdicts.size === 0) {
        // 解析失败 → fail-open 保留全部
        this.broadcast(roomId, { type: 'critique_gate', degraded: true, survived: valid.map((p) => p.anonId), rejected: [] });
        return { survivors: valid, rejected: [], degraded: true };
      }
      const { survivors, rejected } = selectSurvivors(valid, verdicts, dupOf, {
        minSurvivors: this.minSurvivors,
        scoreThreshold: this.scoreThreshold,
      });
      this.broadcast(roomId, {
        type: 'critique_gate',
        degraded: false,
        survived: survivors.map((p) => p.anonId),
        rejected: rejected.map((p) => ({ anonId: p.anonId, score: p._score, reason: p._dup ? `与 ${p._dup} 重复` : p._reason })),
      });
      return { survivors, rejected, degraded: false };
    } catch (e) {
      // fail-open：评审失败绝不卡住房间
      this.broadcast(roomId, { type: 'critique_gate', degraded: true, error: e?.message, survived: valid.map((p) => p.anonId), rejected: [] });
      return { survivors: valid, rejected: [], degraded: true };
    }
  }
}
