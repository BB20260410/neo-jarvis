// @ts-check
import { describe, expect, it } from 'vitest';
import { createTopicDiscovery, isResearchableSeed } from '../../src/cognition/NoeTopicDiscovery.js';

// ---- mock 数据源（与真实接口同形：kg.search / goalSystem.list / commitmentStore.list / kv.get） ----

function mockKg(entities) {
  return {
    search() {
      return { entities: Array.isArray(entities) ? entities : [] };
    },
  };
}
function mockGoalSystem(goals) {
  return {
    // P10-fix(Opus/Codex审):真实 NoeGoalSystem.list 只支持 {status,limit},不支持 source——mock 须同形,
    //   不替源码做 source 过滤(否则掩盖 fromCuriositySignals 必须 JS 内自筛 source='surprise' 的真实需求=绿测假象)。
    /** @param {{status?:string,limit?:number}} [f] */
    list(f = {}) {
      const all = Array.isArray(goals) ? goals : [];
      const byStatus = f.status ? all.filter((g) => g.status === f.status) : all;
      return f.limit ? byStatus.slice(0, f.limit) : byStatus;
    },
  };
}
function mockCommitmentStore(items) {
  return {
    /** @param {{status?:string}} [f] */
    list(f = {}) {
      const all = Array.isArray(items) ? items : [];
      return f.status ? all.filter((c) => c.status === f.status) : all;
    },
  };
}
function mockKv(archiveObj) {
  return { get: (k) => (k === 'noe.learning.topicArchive.v1' ? archiveObj : null) };
}

describe('NoeTopicDiscovery — P10 动态主题发现', () => {
  describe('flag 门控（默认 OFF 留 owner kickstart）', () => {
    it('enabled=false（默认）时 discover 返回空、不读任何源', () => {
      let touched = false;
      const kg = { search() { touched = true; return { entities: [] }; } };
      const d = createTopicDiscovery({ kg, enabled: false });
      const r = d.discover();
      expect(d.enabled).toBe(false);
      expect(r.enabled).toBe(false);
      expect(r.seeds).toEqual([]);
      expect(touched).toBe(false); // OFF 时不该碰数据源
    });

    it('enabled=true 显式开启时才发现', () => {
      const kg = mockKg([{ name: 'Graphiti', mention_count: 7, description: '', type: 'term' }]);
      const d = createTopicDiscovery({ kg, enabled: true });
      const r = d.discover();
      expect(r.enabled).toBe(true);
      expect(r.seeds.length).toBeGreaterThan(0);
    });
  });

  describe('源①：记忆里反复出现但未深究的实体 → 种子', () => {
    it('mention 高 + description 空 = 知识缺口，生成种子', () => {
      const kg = mockKg([
        { name: 'Graphiti', mention_count: 8, description: '', type: 'term' },
        { name: 'pymdp', mention_count: 5, description: '', type: 'term' },
      ]);
      const d = createTopicDiscovery({ kg, enabled: true });
      const { seeds } = d.discover();
      const names = seeds.map((s) => s.evidence?.name);
      expect(names).toContain('Graphiti');
      expect(names).toContain('pymdp');
      expect(seeds.every((s) => s.source === 'unexplored_entity')).toBe(true);
      // 种子携带可定位对象 + 可喂研究的 url/query
      const g = seeds.find((s) => s.evidence?.name === 'Graphiti');
      expect(g.url).toMatch(/github\.com\/search/);
      expect(g.query.toLowerCase()).toContain('graphiti');
    });

    it('mention 不够（< 阈值）或已深究（description 长）= 不算缺口，不生成', () => {
      const kg = mockKg([
        { name: 'OnceMentioned', mention_count: 1, description: '', type: 'term' }, // 提及太少
        { name: 'WellKnown', mention_count: 20, description: '这是一段已经研究得很透彻的详细说明文字', type: 'term' }, // 已深究
      ]);
      const d = createTopicDiscovery({ kg, enabled: true });
      const { seeds } = d.discover();
      expect(seeds.length).toBe(0);
    });
  });

  describe('源②：好奇回路高好奇信号 → 种子', () => {
    it('surprise 目标且 curiosity.score 高 → 抽 claim 成研究主题', () => {
      const goalSystem = mockGoalSystem([
        { id: 'g1', source: 'surprise', title: '搞明白为什么没料到：MiniMax embedding 维度不匹配', meta: { curiosity: { score: 0.82, label: 'epistemic' } } },
        { id: 'g2', source: 'reflection', title: '别的来源不该被当好奇信号', meta: null },
      ]);
      const d = createTopicDiscovery({ goalSystem, enabled: true });
      const { seeds } = d.discover();
      expect(seeds.length).toBe(1);
      expect(seeds[0].source).toBe('curiosity_signal');
      expect(seeds[0].evidence.claim).toContain('MiniMax embedding');
      expect(seeds[0].evidence.goalId).toBe('g1');
    });

    it('curiosity.score 低于阈值 → 过滤掉', () => {
      const goalSystem = mockGoalSystem([
        { id: 'g1', source: 'surprise', title: '搞明白为什么没料到：SqliteStore 切库污染', meta: { curiosity: { score: 0.2 } } },
      ]);
      const d = createTopicDiscovery({ goalSystem, enabled: true });
      expect(d.discover().seeds.length).toBe(0);
    });

    it('meta 缺 curiosity（NOE_EFE_CURIOSITY OFF）→ 保守 0.5 仍过默认阈值', () => {
      const goalSystem = mockGoalSystem([
        { id: 'g1', source: 'surprise', title: '搞明白为什么没料到：OLLAMA_KEEP_ALIVE 间歇失效', meta: null },
      ]);
      const d = createTopicDiscovery({ goalSystem, enabled: true });
      expect(d.discover().seeds.length).toBe(1);
    });
  });

  describe('源③：owner 未兑现承诺/开放回路 → 种子', () => {
    it('open 的 open_loop/task 类承诺 → 研究种子；reminder 类排除', () => {
      const commitmentStore = mockCommitmentStore([
        { id: 'c1', status: 'open', category: 'open_loop', text: '查 LangGraph durable execution 怎么做 checkpoint', sensitivity: 'care' },
        { id: 'c2', status: 'open', category: 'reminder', text: '提醒买菜', sensitivity: 'routine' }, // 日程提醒不研究
        { id: 'c3', status: 'done', category: 'task', text: '已完成的不算', sensitivity: 'routine' }, // 非 open
      ]);
      const d = createTopicDiscovery({ commitmentStore, enabled: true });
      const { seeds } = d.discover();
      expect(seeds.length).toBe(1);
      expect(seeds[0].source).toBe('open_commitment');
      expect(seeds[0].evidence.commitmentId).toBe('c1');
      // care 类得分高于 routine 默认
      expect(seeds[0].score).toBeGreaterThan(0.6);
    });
  });

  describe('防护闸 per-source cap（阶段C：防单源刷屏）', () => {
    it('config maxSourceRatio=0.5：单源最多占 totalCap 的一半，余下被 sourceCap 丢', () => {
      const entities = Array.from({ length: 10 }, (_, i) => ({ name: `TechEntity${i}`, mention_count: 5, description: '', type: 'concept' }));
      const d = createTopicDiscovery({ kg: mockKg(entities), enabled: true, config: { totalCap: 12, maxSourceRatio: 0.5 } });
      const { bySource, dropped } = d.discover();
      expect(bySource.unexplored_entity).toBeLessThanOrEqual(6); // ceil(12*0.5)=6
      expect(dropped.sourceCap).toBeGreaterThan(0); // 超额同源种子被 cap 丢
    });
    it('maxSourceRatio 缺省=1.0 不限（零回归）', () => {
      const entities = Array.from({ length: 10 }, (_, i) => ({ name: `TechEntityX${i}`, mention_count: 5, description: '', type: 'concept' }));
      const d = createTopicDiscovery({ kg: mockKg(entities), enabled: true }); // 不传 maxSourceRatio
      expect((d.discover().dropped.sourceCap) || 0).toBe(0); // 默认不 cap
    });
  });

  describe('种子质量过滤（借鉴 P0-4 AUTOSEED 闸：须含可定位对象/明确问题）', () => {
    it('纯情绪碎片不过闸', () => {
      expect(isResearchableSeed({ title: '嗯嗯', query: '谢谢' }).ok).toBe(false);
      expect(isResearchableSeed({ title: '加油！', query: '' }).ok).toBe(false);
    });
    it('太短/太空不过闸', () => {
      expect(isResearchableSeed({ title: 'a', query: '' }).ok).toBe(false);
      expect(isResearchableSeed({ title: '', query: '' }).ok).toBe(false);
    });
    it('纯泛词问句（无技术对象、无实义词）不过闸', () => {
      expect(isResearchableSeed({ title: '这个东西是什么', query: '' }).ok).toBe(false);
    });
    it('含技术对象过闸', () => {
      expect(isResearchableSeed({ title: 'Graphiti temporal graph', query: '' }).ok).toBe(true);
      expect(isResearchableSeed({ title: '研究 pymdp 的 EFE 公式', query: '' }).ok).toBe(true);
    });
    it('明确问句 + 实义词过闸', () => {
      expect(isResearchableSeed({ title: '为什么记忆召回零命中', query: '' }).ok).toBe(true);
    });
    it('discover 内会丢掉情绪碎片，dropped.quality 计数', () => {
      // 构造一个会过源但质量差的承诺（纯情绪）+ 一个好的
      const commitmentStore = mockCommitmentStore([
        { id: 'c1', status: 'open', category: 'task', text: '谢谢', sensitivity: 'routine' },
        { id: 'c2', status: 'open', category: 'task', text: '研究 DSPy 声明式优化', sensitivity: 'routine' },
      ]);
      const d = createTopicDiscovery({ commitmentStore, enabled: true });
      const r = d.discover();
      expect(r.seeds.length).toBe(1);
      expect(r.seeds[0].evidence.commitmentId).toBe('c2');
      expect(r.dropped.quality).toBeGreaterThanOrEqual(1);
    });
  });

  describe('去重（静态表 / 近期已研究账本 / 源间互相）', () => {
    it('与静态表（NOE_LEARNING_CONCEPTS）重复的种子被去掉', () => {
      const kg = mockKg([{ name: 'Letta', mention_count: 9, description: '', type: 'term' }]);
      const dupUrl = 'https://github.com/search?q=Letta&type=repositories';
      const staticConcepts = [{ title: 'Letta（MemGPT）', url: dupUrl, query: 'Letta MemGPT' }];
      // 实体源对 Letta 生成的 url 与静态表 url 同形 → 去重
      const d = createTopicDiscovery({ kg, staticConcepts, enabled: true });
      const r = d.discover();
      expect(r.seeds.find((s) => s.evidence?.name === 'Letta')).toBeUndefined();
      expect(r.dropped.duplicate).toBeGreaterThanOrEqual(1);
    });

    it('名级兜底去重：实体名已在静态表（即便 url/query 串不同）也算重复', () => {
      // 真实场景：静态表 Letta 的 url 是 ?q=Letta+MemGPT，实体源生成 ?q=Letta，url 不同但同概念。
      const kg = mockKg([{ name: 'Letta', mention_count: 11, description: '', type: 'term' }]);
      const staticConcepts = [{ title: 'Letta（MemGPT）：长期记忆', url: 'https://github.com/search?q=Letta+MemGPT&type=repositories', query: 'Letta MemGPT memory' }];
      const d = createTopicDiscovery({ kg, staticConcepts, enabled: true });
      const r = d.discover();
      expect(r.seeds.find((s) => s.evidence?.name === 'Letta')).toBeUndefined();
      expect(r.dropped.duplicate).toBeGreaterThanOrEqual(1);
    });

    it('近期已研究（curator 访问账本）里的主题被去掉', () => {
      const url = 'https://github.com/search?q=Cognee&type=repositories';
      const kg = mockKg([{ name: 'Cognee', mention_count: 6, description: '', type: 'term' }]);
      // 账本键 = topicKey（url 小写）；命中即「近期已研究」
      const kv = mockKv({ [url.toLowerCase()]: { visits: 2, lastVisit: 1, title: 'Cognee' } });
      const d = createTopicDiscovery({ kg, kv, enabled: true });
      const r = d.discover();
      expect(r.seeds.find((s) => s.evidence?.name === 'Cognee')).toBeUndefined();
      expect(r.dropped.duplicate).toBeGreaterThanOrEqual(1);
    });

    it('源间同 url 只保留一个（高分优先）', () => {
      // 实体源与承诺源恰好产出同 url（同一概念）→ 只留一条
      const sameTerm = 'Reflexion';
      const kg = mockKg([{ name: sameTerm, mention_count: 4, description: '', type: 'term' }]);
      const commitmentStore = mockCommitmentStore([
        { id: 'c1', status: 'open', category: 'task', text: sameTerm, sensitivity: 'care' },
      ]);
      const d = createTopicDiscovery({ kg, commitmentStore, enabled: true });
      const r = d.discover();
      const reflexion = r.seeds.filter((s) => String(s.url).includes('Reflexion'));
      expect(reflexion.length).toBe(1);
    });
  });

  describe('多源汇聚 + bySource 统计', () => {
    it('三源各出一条 → 汇成候选，bySource 正确', () => {
      const kg = mockKg([{ name: 'AutoGen', mention_count: 5, description: '', type: 'term' }]);
      const goalSystem = mockGoalSystem([
        { id: 'g1', source: 'surprise', title: '搞明白为什么没料到：browser.observe_page 空转', meta: { curiosity: { score: 0.7 } } },
      ]);
      const commitmentStore = mockCommitmentStore([
        { id: 'c1', status: 'open', category: 'open_loop', text: '排查 Composio 工具接入限制', sensitivity: 'routine' },
      ]);
      const d = createTopicDiscovery({ kg, goalSystem, commitmentStore, enabled: true });
      const r = d.discover();
      expect(r.seeds.length).toBe(3);
      expect(r.bySource.unexplored_entity).toBe(1);
      expect(r.bySource.curiosity_signal).toBe(1);
      expect(r.bySource.open_commitment).toBe(1);
    });

    it('discoverConcepts 产出 {title,url,query} 形状，可喂 NoeTopicCurator.dynamicConcepts', () => {
      const kg = mockKg([{ name: 'UI-TARS', mention_count: 6, description: '', type: 'term' }]);
      const d = createTopicDiscovery({ kg, enabled: true });
      const concepts = d.discoverConcepts();
      expect(concepts.length).toBeGreaterThan(0);
      for (const c of concepts) {
        expect(Object.keys(c).sort()).toEqual(['query', 'title', 'url']);
        expect(typeof c.url).toBe('string');
      }
    });

    it('totalCap 限制候选总数', () => {
      const entities = Array.from({ length: 30 }, (_, i) => ({ name: `Concept${i}`, mention_count: 5, description: '', type: 'term' }));
      const d = createTopicDiscovery({ kg: mockKg(entities), enabled: true, config: { totalCap: 4 } });
      expect(d.discover().seeds.length).toBe(4);
    });
  });

  describe('fail-open：任一数据源缺失/抛异常 → 该源 0 种子，不抛穿', () => {
    it('全部源为 null → 空结果不崩', () => {
      const d = createTopicDiscovery({ enabled: true });
      const r = d.discover();
      expect(r.seeds).toEqual([]);
      expect(r.enabled).toBe(true);
    });

    it('kg.search 抛异常 → 实体源 0 种子，其他源照常', () => {
      const kg = { search() { throw new Error('db boom'); } };
      const commitmentStore = mockCommitmentStore([
        { id: 'c1', status: 'open', category: 'task', text: '研究 Temporal durable workflow', sensitivity: 'routine' },
      ]);
      const d = createTopicDiscovery({ kg, commitmentStore, enabled: true });
      const r = d.discover();
      expect(r.bySource.unexplored_entity).toBeUndefined();
      expect(r.bySource.open_commitment).toBe(1); // 其他源不受牵连
    });

    it('goalSystem.list 抛异常 → 好奇源 0 种子', () => {
      const goalSystem = { list() { throw new Error('boom'); } };
      const d = createTopicDiscovery({ goalSystem, enabled: true });
      expect(() => d.discover()).not.toThrow();
      expect(d.discover().seeds).toEqual([]);
    });

    it('kv.get 抛异常（账本损坏）→ 去重少一层但发现不崩', () => {
      const kg = mockKg([{ name: 'Inngest', mention_count: 5, description: '', type: 'term' }]);
      const kv = { get() { throw new Error('corrupt'); } };
      const d = createTopicDiscovery({ kg, kv, enabled: true });
      const r = d.discover();
      expect(r.seeds.length).toBe(1); // 账本读失败仍能发现
    });

    it('数据源返回畸形（非数组/缺字段）→ 安全跳过', () => {
      const kg = { search() { return { entities: [null, { name: '' }, { mention_count: 5 }] }; } };
      const d = createTopicDiscovery({ kg, enabled: true });
      expect(() => d.discover()).not.toThrow();
      expect(d.discover().seeds).toEqual([]);
    });
  });

  describe('P10-fix（三方审回归·发现端）', () => {
    it('B5 质量闸：hasTech 路径也挡纯泛词+多词英文寒暄(thing/stuff/ok thanks)，真技术词不误伤', () => {
      expect(isResearchableSeed({ title: 'thing', query: 'thing' }).ok).toBe(false);
      expect(isResearchableSeed({ title: 'stuff', query: 'stuff' }).ok).toBe(false);
      expect(isResearchableSeed({ title: 'ok thanks', query: 'ok thanks' }).ok).toBe(false);
      expect(isResearchableSeed({ title: 'MemGPT', query: 'MemGPT architecture' }).ok).toBe(true);
      expect(isResearchableSeed({ title: 'RAG', query: 'retrieval augmented generation' }).ok).toBe(true);
    });
    it('B5 源头：泛词实体名(thing/东西)在实体源被过滤，不靠 query 模板实义词蒙混', () => {
      const kg = mockKg([
        { name: 'thing', mention_count: 9, description: '', type: 'term' },
        { name: '东西', mention_count: 9, description: '', type: 'term' },
        { name: 'pymdp', mention_count: 9, description: '', type: 'term' },
      ]);
      const names = createTopicDiscovery({ kg, enabled: true }).discover().seeds.map((sd) => sd.evidence?.name);
      expect(names).not.toContain('thing');
      expect(names).not.toContain('东西');
      expect(names).toContain('pymdp');
    });
  });
});
