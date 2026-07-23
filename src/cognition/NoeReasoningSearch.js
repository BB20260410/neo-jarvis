// @ts-check
// NoeReasoningSearch — 统一推理搜索控制器（注入式发散→打分→剪枝/beam）。
//
// 借鉴来源（裁决 docs/RESEARCH_融入裁决_2026-06-14.md 明确建议：GoT/ToT/llm-reasoners 三者
//   本质同源「发散+打分+剪枝/搜索」，合并为一个统一 reasoning-search 模块一次落地）：
//   1) 借鉴 princeton-nlp/tree-of-thought-llm 的 bfs.solve()（MIT）的 Y：
//      「逐层 generate(发散多候选) → evaluate(自评打分) → select(剪枝保 width 条)」的 beam 骨架。
//      → 这里用 beam strategy 复现：每深度从当前 frontier 的每个节点 generate 子候选，统一 evaluate，
//        全局排序后只保留分数最高的 width 条进入下一层（经典 beam-search）。
//   2) 借鉴 spcl/graph-of-thoughts 的 Score+KeepBestN 算子（BSD-3）的 Y：
//      「打分 + 显式保留 Best-N 剪枝」是可观测、可调度的搜索算子，而非隐式竞争。
//      → 这里 evaluate 槽 + width 上限即 Score+KeepBestN；每个节点带 score/depth/path 可观测。
//   3) 借鉴 maitrix-org/llm-reasoners 的三泛型抽象（Apache-2.0）的 Y：
//      「SearchConfig(reward/fast_reward) + SearchAlgorithm」把搜索控制流与 reward/world-model 解耦。
//      → 这里把 generate(=world-model.step 推进) 与 evaluate(=reward 打分) 全部「注入」，
//        本模块只管搜索控制流，绝不内置 LLM/reward。⚠️裁决红线：llm-reasoners 自带 visualize()
//        会把推理树上传 maitrix 托管 AWS——本模块不含任何上传/网络/可视化代码，只返回纯 JSON 结果树。
//
// 与 Neo 既有模块的边界（诚实增量，避免重复造轮子）：
//   - NoeDeliberation.js：单次三段补全（立论/挑战/修订），不发散多候选、无逐层剪枝。本模块补「多候选搜索」骨架。
//   - NoeLocalModelCouncil.js（synthesizer 合成）：多模型横评/合成，不是同一主脑多采样的 beam 控制流。
//   - PeerCritiqueGate.js：单批提案打分+keep/kill，不做跨深度的迭代发散→收敛。
//   - NoeWorkspace.js（GWT）：广播竞争，不是有目的的多步树搜索。
//   本模块定位：纯「搜索控制流」骨架——generate/evaluate 由调用方注入（LLM 在 BrainRouter、reward
//   在期望账本/好奇回路），本模块零模型零网络零时钟，可用确定性 mock 单测 beam 选路。
//
// 纯函数 + 注入式：createReasoningSearch({ generate, evaluate }) → async search({ root, width, depth, strategy })。
//   generate(node) → 子候选数组（string 或 { content }）；evaluate(node) → 分数（越大越好）。两者可同步可异步。
//   任何节点 generate/evaluate 抛错一律 fail-open（该节点跳过/记 0 分），绝不让一次坏采样炸掉整次搜索。
//
// 行为变化（是否真的走多候选搜索 vs 单步直出）由 env 门控、默认 OFF（项目最有效防伤害模式）：
//   readReasoningSearchEnv() 读 NOE_REASONING_SEARCH：off|beam|greedy（缺省/'off'/'0'/'' → enabled:false）。
//   OFF 时调用方应走原有单步路径（普通对话/快路）；仅高风险多步深思难题才打开（裁决口径）。
//   注意：search() 本身是纯控制流，传什么参数就跑什么——门控只决定「调用方该不该调它」，不在 search 内部短路，
//   这样单测可不依赖 env 直接验证算法；是否启用的判断交给调用点（与 NoeThoughtLoopGuard 同款分层）。

/** 默认搜索参数 + 防爆上限（窄 beam，裁决口径：本地算力放大靠开关 + 仅难题触发兜底）。 */
export const DEFAULT_SEARCH_PARAMS = Object.freeze({
  width: 3,          // beam 宽度（每层保留的最优候选数）
  depth: 2,          // 最大搜索深度（迭代发散→收敛的步数）
  maxWidth: 8,       // width 硬上限（防一次性铺太多候选烧算力）
  maxDepth: 6,       // depth 硬上限（防无限深搜）
  maxChildren: 8,    // 单节点 generate 子候选硬上限（防一次发散爆量）
  strategy: 'beam',  // 'beam' | 'greedy'（greedy = width 退化为 1 的特例）
});

const VALID_STRATEGIES = Object.freeze(['beam', 'greedy']);

/** env 门控：默认 OFF。返回 { enabled, strategy }。仅 'beam'/'greedy' 视为开启。 */
export function readReasoningSearchEnv(env = process.env) {
  const raw = String(env?.NOE_REASONING_SEARCH ?? '').trim().toLowerCase();
  if (raw === 'beam' || raw === 'greedy') return Object.freeze({ enabled: true, strategy: raw });
  // 'on'/'true'/'1' 视为开启但用默认策略 beam（与项目其他门控的真值口径兼容）
  if (raw === 'on' || raw === 'true' || raw === '1') return Object.freeze({ enabled: true, strategy: 'beam' });
  return Object.freeze({ enabled: false, strategy: 'off' });
}

/** 把任意数字夹到 [min, max] 整数区间；非有限数回退到 fallback 再夹。 */
function clampInt(value, fallback, min, max) {
  let n = Number(value);
  if (!Number.isFinite(n)) n = fallback;
  n = Math.floor(n);
  if (n < min) n = min;
  if (n > max) n = max;
  return n;
}

/** 把 generate 返回的一个子候选规整成统一 content 字符串（接受 string 或 { content }/{ text }）。 */
function toContent(raw) {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const c = raw.content ?? raw.text ?? raw.thought ?? '';
    return typeof c === 'string' ? c : String(c);
  }
  return String(raw);
}

/**
 * 创建一个统一推理搜索控制器（注入式）。
 *
 * @param {object} deps
 * @param {(node: ReasoningNode) => (Array<string|object>|Promise<Array<string|object>>)} deps.generate
 *   发散算子：给一个节点产生若干子候选（LLM 多采样在外，本模块只调它）。
 * @param {(node: ReasoningNode) => (number|Promise<number>)} deps.evaluate
 *   打分算子：给一个节点打分（reward 在外：期望账本 Brier/好奇新颖度等）。分数越大越好。
 * @param {() => string} [deps.makeId]  生成节点 id（默认自增；注入可做确定性测试）。
 */
// 难题复杂度启发（给调用方决定「是否值得多候选搜索」，避免简单深思也 N×chat 浪费）：
// 含难题词 / 背景丰富 / topic 较长 → 复杂值得 search；否则简单走单次。纯函数可测。
const COMPLEX_TOPIC_RE = /为什么|为何|如何|怎么(办|做|选|办好)|权衡|抉择|取舍|矛盾|纠结|到底|该不该|利弊|风险|决策|两难|哪个更|值不值|是否应/;
export function estimateTopicComplexity(topic = '', context = '') {
  const t = String(topic || '').trim();
  const c = String(context || '').trim();
  if (COMPLEX_TOPIC_RE.test(t)) return { complex: true, reason: 'keyword' };
  if (c.length >= 80) return { complex: true, reason: 'rich_context' };
  if (t.length >= 24) return { complex: true, reason: 'long_topic' };
  return { complex: false, reason: 'simple' };
}

export function createReasoningSearch({ generate, evaluate, makeId } = {}) {
  if (typeof generate !== 'function') throw new TypeError('createReasoningSearch: generate 必须是函数（发散算子注入）');
  if (typeof evaluate !== 'function') throw new TypeError('createReasoningSearch: evaluate 必须是函数（打分算子注入）');

  let seq = 0;
  const nextId = typeof makeId === 'function' ? makeId : () => `n${seq++}`;

  /** fail-open 包装 generate：返回规整后的 content 数组（受 maxChildren 截断）；抛错 → 空数组。 */
  async function safeGenerate(node, maxChildren) {
    let out;
    try {
      out = await generate(node);
    } catch {
      return []; // 单节点发散失败不阻断整次搜索（fail-open）
    }
    if (!Array.isArray(out)) return [];
    const contents = [];
    for (const raw of out) {
      const c = toContent(raw);
      if (c !== '') contents.push(c);
      if (contents.length >= maxChildren) break; // 防一次发散爆量
    }
    return contents;
  }

  /** fail-open 包装 evaluate：抛错或非有限数 → 0 分（不让坏打分污染排序）。 */
  async function safeEvaluate(node) {
    let s;
    try {
      s = await evaluate(node);
    } catch {
      return 0;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : 0;
  }

  /**
   * 执行一次推理搜索。
   *
   * @param {object} opts
   * @param {string|object} [opts.root]   根念头/问题（string 或带 content 的对象）。
   * @param {number} [opts.width]   beam 宽度（夹到 [1, maxWidth]）。
   * @param {number} [opts.depth]   搜索深度（夹到 [0, maxDepth]）。
   * @param {('beam'|'greedy')} [opts.strategy]  策略：beam | greedy（greedy ≡ width=1）。
   * @param {object} [opts.params]  覆盖上限（maxWidth/maxDepth/maxChildren）。
   * @returns {Promise<SearchResult>}
   */
  async function search({ root = '', width, depth, strategy, params } = {}) {
    const p = { ...DEFAULT_SEARCH_PARAMS, ...(params || {}) };
    // 策略：非法值回退到默认 beam；greedy 强制 width=1（贪心 = 每层只留最优一条）
    let strat = String(strategy ?? p.strategy ?? 'beam').toLowerCase();
    if (!VALID_STRATEGIES.includes(strat)) strat = DEFAULT_SEARCH_PARAMS.strategy;
    const effMaxWidth = clampInt(p.maxWidth, DEFAULT_SEARCH_PARAMS.maxWidth, 1, 64);
    const effMaxDepth = clampInt(p.maxDepth, DEFAULT_SEARCH_PARAMS.maxDepth, 0, 64);
    const effMaxChildren = clampInt(p.maxChildren, DEFAULT_SEARCH_PARAMS.maxChildren, 1, 64);
    const reqWidth = clampInt(width, DEFAULT_SEARCH_PARAMS.width, 1, effMaxWidth);
    const effWidth = strat === 'greedy' ? 1 : reqWidth; // 贪心退化为宽度 1 的 beam
    const effDepth = clampInt(depth, DEFAULT_SEARCH_PARAMS.depth, 0, effMaxDepth);

    /** @type {ReasoningNode} */
    const rootNode = {
      id: nextId(),
      content: toContent(root),
      score: 0,
      depth: 0,
      parentId: null,
      path: [],          // 从根到本节点（不含根）的 content 链
      children: [],      // 仅记录被展开/评估过的子节点（可观测树；剪掉的不挂）
    };

    const allNodes = [rootNode];     // 所有被评估过的节点（含被剪枝的，便于审计）
    let frontier = [rootNode];       // 当前层 beam（保留的最优 width 条）
    let evaluations = 0;             // evaluate 调用计数（成本可观测）
    let generations = 0;             // generate 调用计数（成本可观测）

    // 根节点也打一次分（让深度 0 的退化场景也有分可比）
    rootNode.score = await safeEvaluate(rootNode);
    evaluations++;

    for (let d = 0; d < effDepth; d++) {
      /** @type {ReasoningNode[]} */
      const candidates = [];
      for (const node of frontier) {
        const childContents = await safeGenerate(node, effMaxChildren);
        generations++;
        for (const content of childContents) {
          /** @type {ReasoningNode} */
          const child = {
            id: nextId(),
            content,
            score: 0,
            depth: d + 1,
            parentId: node.id,
            path: [...node.path, content],
            children: [],
          };
          child.score = await safeEvaluate(child);
          evaluations++;
          node.children.push(child);
          allNodes.push(child);
          candidates.push(child);
        }
      }
      if (candidates.length === 0) break; // 这一层没产出任何候选 → 提前停（fail-open，不空转）
      // 剪枝（KeepBestN）：全局按分数降序，只保留最优 effWidth 条进入下一层（经典 beam）
      candidates.sort((a, b) => b.score - a.score);
      frontier = candidates.slice(0, effWidth);
    }

    // 选最佳：在「所有叶子（最后留下的 frontier）」里取最高分；若一步没走则 best=root
    let best = rootNode;
    for (const node of frontier) {
      if (node.score > best.score) best = node;
    }
    // 防御：frontier 可能因提前 break 仍指向更深一层之外的旧层，已由上面循环保证 frontier 是最新存活层

    return /** @type {SearchResult} */ ({
      best,                                  // 最优节点（含 path/score/depth）
      bestPath: best.path,                   // 从根到最优节点的 content 链（决策路径）
      bestScore: best.score,
      frontier,                              // 最终存活的 beam（可继续展开/审计）
      tree: rootNode,                        // 可观测结果树（仅含展开过的分支），可吐给 mind.html
      stats: Object.freeze({
        strategy: strat,
        width: effWidth,
        depth: effDepth,
        nodes: allNodes.length,
        generations,
        evaluations,
      }),
    });
  }

  return { search };
}

/**
 * @typedef {object} ReasoningNode
 * @property {string} id
 * @property {string} content
 * @property {number} score
 * @property {number} depth
 * @property {string|null} parentId
 * @property {string[]} path
 * @property {ReasoningNode[]} children
 */

/**
 * @typedef {object} SearchResult
 * @property {ReasoningNode} best
 * @property {string[]} bestPath
 * @property {number} bestScore
 * @property {ReasoningNode[]} frontier
 * @property {ReasoningNode} tree
 * @property {{strategy:string,width:number,depth:number,nodes:number,generations:number,evaluations:number}} stats
 */
