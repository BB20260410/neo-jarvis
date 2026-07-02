// NoeMemorySemanticIndex — 记忆语义索引适配器（FusionRanker 双路召回的「向量路」，波次6 接线）。
//
// 包装 embeddings/VectorIndex(kind='noe_memory')：写记忆时嵌入入库，召回时语义检索。
// provider 可配：hash(零成本但精度近零，仅测试/兜底) / ollama(真语义，本地模型如 qwen3-embedding:0.6b)。
// 注入式：MemoryCore 收 { upsert, search }，未注入则纯 FTS 行为不变（零影响）。

import { upsertEmbedding, semanticSearch, semanticSearchVectors, deleteEmbedding } from '../embeddings/VectorIndex.js';
import { estimateVarianceFromVector } from './NoeFisherRaoReranker.js';

const KIND = 'noe_memory';

export function createMemorySemanticIndex({
  provider = process.env.NOE_MEMORY_EMBED_PROVIDER || 'hash',
  model = process.env.NOE_MEMORY_EMBED_MODEL || undefined,
  baseUrl = process.env.NOE_MEMORY_EMBED_BASEURL || undefined,
  // keepAlive 默认 undefined → 底层 resolveOllamaKeepAlive 读 NOE_OLLAMA_KEEP_ALIVE（默认 '-1' 常驻），
  // 让 ollama embedding 模型常驻根治按需唤醒间歇失效（reference_ollama_ondemand_embedding_failure）。
  keepAlive,
} = {}) {
  return {
    provider,
    /** 写入/更新一条记忆的语义向量（文本截 4000 字防超长）。 */
    async upsert({ refId, text }) {
      return upsertEmbedding({ kind: KIND, refId, text: String(text || '').slice(0, 4000), provider, model, baseUrl, keepAlive });
    },
    /** 语义检索：返回 [{refId, score}]（minScore 滤掉纯噪声命中）。 */
    async search(query, { limit = 10 } = {}) {
      return semanticSearch(String(query || ''), { kind: KIND, limit, provider, model, baseUrl, keepAlive, minScore: 0.05 });
    },
    /**
     * 带向量+方差的语义检索（NOE_MEMORY_FISHER_RANK 用）：返回 { queryVector, queryVariance, hits:[{refId,score,vector,variance}] }。
     * 方差=嵌入维度内蕴方差（estimateVarianceFromVector，零 join）；底层「带不确定度嵌入」信号即来自此。
     * 普通 cosine 召回不调用本方法，故对默认路径零影响。
     */
    async searchVectors(query, { limit = 10 } = {}) {
      const { queryVector, hits } = await semanticSearchVectors(String(query || ''), { kind: KIND, limit, provider, model, baseUrl, keepAlive, minScore: 0.05 });
      return {
        queryVector,
        queryVariance: estimateVarianceFromVector(queryVector),
        hits: hits.map((h) => ({ ...h, variance: estimateVarianceFromVector(h.vector) })),
      };
    },
    remove(refId) { try { return deleteEmbedding({ kind: KIND, refId }); } catch { return 0; } },
  };
}
