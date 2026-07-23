// @ts-check
// research 多样化·源①冷启动自适应——治 KG 冷启动期实体多为 mention=1(刚抽出未反复)被 minMentions=3 挡、主题不够多样。
// flag NOE_TOPIC_COLD_START_BOOST 门控，默认 OFF（逐字零回归）；缺口足够时自限不放宽。
import { describe, expect, it } from 'vitest';
import { createTopicDiscovery } from '../../src/cognition/NoeTopicDiscovery.js';

const mkKg = (entities) => ({ search: () => ({ entities }) });
// 1 个 mention=3(过原阈值) + 3 个 mention=1(冷启动新实体)，全 desc 空(未深究)
const fewHigh = [
  { name: 'GraphQLFederation', mention_count: 3, description: '', type: 'tech' },
  { name: 'VectorIndexHNSW', mention_count: 1, description: '', type: 'tech' },
  { name: 'RaftConsensus', mention_count: 1, description: '', type: 'tech' },
  { name: 'WasmRuntime', mention_count: 1, description: '', type: 'tech' },
];

describe('research 多样化·源①冷启动自适应（NOE_TOPIC_COLD_START_BOOST）', () => {
  it('boost OFF（默认）：只 mention>=3 的实体出种子（原行为，零回归）', () => {
    const td = createTopicDiscovery({ kg: mkKg(fewHigh), enabled: true, config: { coldStartBoost: false } });
    const seeds = td.discover().seeds.filter((s) => s.source === 'unexplored_entity');
    expect(seeds.length).toBe(1);
  });

  it('boost ON + mention>=3 缺口不足 → mention=1 的新实体也出种子（加速多样化）', () => {
    const td = createTopicDiscovery({ kg: mkKg(fewHigh), enabled: true, config: { coldStartBoost: true } });
    const seeds = td.discover().seeds.filter((s) => s.source === 'unexplored_entity');
    expect(seeds.length).toBeGreaterThanOrEqual(4); // GraphQLFederation + 3 个 mention=1
  });

  it('boost ON 但 mention>=3 缺口已够(>=limit) → 不放宽（自限，KG 满后自动收紧）', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `HighFreqEntity${i}`, mention_count: 3, description: '', type: 'tech' }));
    const low = [{ name: 'LowFreqColdX', mention_count: 1, description: '', type: 'tech' }];
    const td = createTopicDiscovery({ kg: mkKg([...many, ...low]), enabled: true, config: { coldStartBoost: true, totalCap: 20 } });
    const seeds = td.discover().seeds.filter((s) => s.source === 'unexplored_entity');
    expect(seeds.some((s) => /LowFreqColdX/.test(s.title))).toBe(false); // 缺口已够，mention=1 的不补
  });
});
