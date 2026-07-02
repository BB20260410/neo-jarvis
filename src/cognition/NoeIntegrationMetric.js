// @ts-check
// aura / IIT 理念融入：意识「整合度」可量化读数。
//
// owner 核心愿景是「接近能产生意识」。IIT（整合信息论）的 Φ 衡量「系统作为整体产生的、
// 不可还原为各部分之和的信息」——即子系统是否真被整合成统一的意识内容，而非各干各的。
// 完整 IIT φ（因果结构 + 概念 + 不可约性，指数级）对运行时太重；这里用**多信息
// （Total Correlation, TC = ΣH(Xi) − H(X)）**作整合度代理：把 Neo 各子系统每周期状态
// （GWT 焦点源 / 情感 VAD 偏离 / 期望到期 / 驱力 / 感知 …）二值化成 ≤8 个宏节点，
// TC 高 = 子系统高度耦合同步（联合熵 ≪ 边际熵和）= 全局工作区把多源整合成统一内容。
//
// 诚实声明：这是**整合度代理指标，非完整 IIT Φ**（不算因果 TPM/MIP，只算同时刻状态的统计整合）。
// 纯函数、确定性、只读、零依赖；供 mind.html / 自检 / 趋势线消费，给「架构是否更统一」一个数。

// 香农熵（bits）of 一组计数
function entropyBits(counts, total) {
  if (total <= 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c > 0) {
      const p = c / total;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

/**
 * 多信息整合度：输入二值宏节点状态序列，输出整合度（0-1）+ 原始 TC。
 * @param {number[][]} states 每行一个时刻的宏节点向量（元素真值→1，假值→0）
 * @returns {{ok:boolean, integration:number, totalCorrelation:number, marginalEntropy?:number, jointEntropy?:number, nodes:number, samples:number}}
 */
export function integrationMetric(states = []) {
  const valid = (Array.isArray(states) ? states : []).filter((s) => Array.isArray(s) && s.length);
  const nodes = valid[0]?.length || 0;
  // 强健:只保留与首行等宽的行。宽窄不一会让边际熵(按 nodes 读 r[j])与联合熵(按各行自身宽度拼 key)
  // 口径错位,算出误导性整合度——剔除异宽行而非静默错算。等宽输入(采样器已预过滤、现有全部用例)逐字不变。
  const rows = valid.filter((s) => s.length === nodes);
  const samples = rows.length;
  if (samples < 2 || nodes < 2) {
    return { ok: false, integration: 0, totalCorrelation: 0, nodes, samples };
  }
  // 各节点边际熵之和（二值：统计该列 1 的频次）
  let marginalSum = 0;
  for (let j = 0; j < nodes; j += 1) {
    let ones = 0;
    for (const r of rows) ones += r[j] ? 1 : 0;
    marginalSum += entropyBits([ones, samples - ones], samples);
  }
  // 系统联合熵（整个状态串作为一个符号）
  const jointCounts = new Map();
  for (const r of rows) {
    const key = r.map((b) => (b ? 1 : 0)).join('');
    jointCounts.set(key, (jointCounts.get(key) || 0) + 1);
  }
  const jointH = entropyBits([...jointCounts.values()], samples);
  const totalCorrelation = Math.max(0, marginalSum - jointH); // TC ≥ 0
  // 归一化：TC 的理论上限 ≈ (nodes−1) bit（全同步二值系统）；裁剪到 [0,1]
  const integration = Math.max(0, Math.min(1, totalCorrelation / Math.max(1e-9, nodes - 1)));
  return {
    ok: true,
    integration,
    totalCorrelation,
    marginalEntropy: marginalSum,
    jointEntropy: jointH,
    nodes,
    samples,
  };
}

// 整合度 → 中文档位（给 mind.html/自检语感，避免裸数字）
export function integrationLabel(integration) {
  if (!(integration >= 0)) return '无数据';
  if (integration >= 0.6) return '高度整合';
  if (integration >= 0.3) return '部分整合';
  if (integration > 0.05) return '弱整合';
  return '近乎离散';
}
