import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { close, getDb, initSqlite } from '../../src/storage/SqliteStore.js';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { NoeMemoryAuditLog } from '../../src/memory/NoeMemoryAuditLog.js';
import { NoeMemoryRetriever, formatMemoryContextBlock } from '../../src/memory/NoeMemoryRetriever.js';
import { createActiveMemoryRecallCircuitBreaker } from '../../src/memory/NoeActiveMemory.js';

let dir = null;

function setup() {
  dir = mkdtempSync(join(tmpdir(), 'noe-memory-retriever-test-'));
  initSqlite(join(dir, 'panel.db'));
  const memory = new MemoryCore({ logger: { warn: () => {} } });
  const auditLog = new NoeMemoryAuditLog({ db: () => getDb(), now: () => 2000 });
  const retriever = new NoeMemoryRetriever({ memory, auditLog, logger: { warn: () => {} } });
  return { memory, retriever };
}

afterEach(() => {
  close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe('NoeMemoryRetriever', () => {
  it('retrieves facts/project skills/insights and logs selected ids', async () => {
    const { memory, retriever } = setup();
    memory.write({ id: 'fact-coffee', projectId: 'noe', scope: 'fact', body: '主人长期偏好黑咖啡，不加糖。', confidence: 0.9, salience: 4 });
    memory.write({ id: 'user-note', projectId: 'noe', scope: 'user', body: '主人明确让我记住：喜欢美式咖啡。', confidence: 0.9, salience: 4 });
    memory.write({ id: 'skill-memory', projectId: 'noe', scope: 'project', body: '技能卡：长期记忆写入前必须保留来源证据。', confidence: 0.8, salience: 4 });
    memory.write({ id: 'insight-memory', projectId: 'noe', scope: 'insight', body: '我发现没有来源的事实会降低主人信任。', confidence: 0.7, salience: 3 });
    memory.write({ id: 'voice-noise', projectId: 'noe', scope: 'voice', body: '黑咖啡闲聊噪声。' });
    const r = await retriever.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat', memoryPolicy: { injectLimit: 5 } });
    expect(r.selected.map((m) => m.id)).toContain('fact-coffee');
    expect(r.selected.map((m) => m.id)).toContain('user-note');
    expect(r.selected.map((m) => m.id)).not.toContain('voice-noise');
    expect(r.channels.user.map((m) => m.id)).toContain('user-note');
    const block = formatMemoryContextBlock(r);
    expect(block).toContain('<noe-memory-v2 trust="local"');
    expect(block).toContain('咖啡');
    const logs = getDb().prepare('SELECT selected_ids FROM noe_memory_retrieval_log').all();
    expect(logs.length).toBe(1);
    expect(JSON.parse(logs[0].selected_ids)).toContain('fact-coffee');
  });

  it('P2 杠杆1(NOE_MEMORY_LESSON_CHANNEL=1)：lesson 类保底进 selected，不被同 scope reflection 淹', async () => {
    process.env.NOE_MEMORY_LESSON_CHANNEL = '1';
    try {
      const { memory, retriever } = setup();
      // 多条 nightly_reflection 占 insight scope，挤压 insight 通道(limit=2)
      for (let i = 0; i < 8; i++) memory.write({ id: `refl${i}`, projectId: 'noe', scope: 'insight', sourceType: 'nightly_reflection', body: `咖啡相关夜间反思第${i}条记录`, confidence: 0.7, salience: 4 });
      memory.write({ id: 'lesson1', projectId: 'noe', scope: 'insight', sourceType: 'learning_lesson', body: '认知修正：关于咖啡偏好的经验', confidence: 0.72, salience: 4 });
      const r = await retriever.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat', memoryPolicy: { injectLimit: 3 } });
      expect(r.selected.some((m) => m.sourceType === 'learning_lesson')).toBe(true); // lesson 保底进了 selected
      expect(r.channels.lesson).toBeDefined();
    } finally { delete process.env.NOE_MEMORY_LESSON_CHANNEL; }
  });

  it('P2 杠杆1 flag OFF：逐字零回归（lesson 专属通道不跑、channels.lesson 不存在）', async () => {
    delete process.env.NOE_MEMORY_LESSON_CHANNEL;
    const { memory, retriever } = setup();
    memory.write({ id: 'lesson1', projectId: 'noe', scope: 'insight', sourceType: 'learning_lesson', body: '认知修正：咖啡', confidence: 0.72, salience: 4 });
    const r = await retriever.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat' });
    expect(r.channels.lesson).toBeUndefined();
  });

  it('P2 杠杆1 小 limit 边界：lesson 不独占、至少留 1 席给四通道（三方一致 SERIOUS 修复）', async () => {
    process.env.NOE_MEMORY_LESSON_CHANNEL = '1';
    try {
      const { memory, retriever } = setup();
      memory.write({ id: 'fact-coffee', projectId: 'noe', scope: 'fact', body: '主人长期偏好咖啡', confidence: 0.9, salience: 4 });
      memory.write({ id: 'lesson1', projectId: 'noe', scope: 'insight', sourceType: 'learning_lesson', body: '认知修正：关于咖啡的经验', confidence: 0.72, salience: 4 });
      const r = await retriever.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat', memoryPolicy: { injectLimit: 2 } });
      expect(r.selected.length).toBe(2);
      expect(r.selected.some((m) => m.id === 'fact-coffee')).toBe(true); // fact 没被 lesson 独占挤掉(留席)
      expect(r.selected.some((m) => m.sourceType === 'learning_lesson')).toBe(true); // lesson 也进了(末尾保底)
    } finally { delete process.env.NOE_MEMORY_LESSON_CHANNEL; }
  });

  it('P2 杠杆1 fail-safe：query 与库内 lesson 无关 → lesson 通道空 → 不强塞（三方关切）', async () => {
    process.env.NOE_MEMORY_LESSON_CHANNEL = '1';
    try {
      const { memory, retriever } = setup();
      memory.write({ id: 'fact-coffee', projectId: 'noe', scope: 'fact', body: '主人长期偏好咖啡', confidence: 0.9, salience: 4 });
      memory.write({ id: 'lesson-unrel', projectId: 'noe', scope: 'insight', sourceType: 'learning_lesson', body: '认知修正：关于数据库索引优化的经验', confidence: 0.72, salience: 4 });
      const r = await retriever.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat', memoryPolicy: { injectLimit: 3 } });
      expect(r.selected.some((m) => m.sourceType === 'learning_lesson')).toBe(false); // 无关 lesson 不被强塞
    } finally { delete process.env.NOE_MEMORY_LESSON_CHANNEL; }
  });

  it('度量诚实(NOE_MEMORY_USAGE_BUMP)：ON 让真注入对话的 selected 计 hit_count，OFF(默认)零回归', async () => {
    const { memory } = setup();
    memory.write({ id: 'fact-coffee', projectId: 'noe', scope: 'fact', body: '主人长期偏好黑咖啡，不加糖。', confidence: 0.9, salience: 4 });
    const hit = () => getDb().prepare('SELECT hit_count FROM noe_memory WHERE id=?').get('fact-coffee').hit_count;
    // OFF（默认/旧行为）：召回注入对话也不计数 → hit_count 失真低估真实使用（93.7% 假"没人读"的根源）
    const off = new NoeMemoryRetriever({ memory, logger: { warn: () => {} }, recordUsageHits: false });
    const rOff = await off.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat' });
    expect(rOff.selected.map((m) => m.id)).toContain('fact-coffee');
    expect(hit()).toBe(0);
    // ON：selected 是真注入决策的记忆 → 计 hit（度量诚实）
    const on = new NoeMemoryRetriever({ memory, logger: { warn: () => {} }, recordUsageHits: true });
    const rOn = await on.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat' });
    expect(rOn.selected.map((m) => m.id)).toContain('fact-coffee');
    expect(hit()).toBeGreaterThan(0);
  });

  it('度量诚实：只计 selected（真注入），召回但未选上的 candidates 不计数', async () => {
    const { memory } = setup();
    // 写 6 条 fact，chat profile fact 通道 limit=5、total=8，但构造让部分落选需要更克制的 totalLimit
    for (let i = 0; i < 6; i++) {
      memory.write({ id: `f${i}`, projectId: 'noe', scope: 'fact', body: `关于咖啡的事实第 ${i} 条`, confidence: 0.5, salience: 1 });
    }
    const on = new NoeMemoryRetriever({ memory, logger: { warn: () => {} }, recordUsageHits: true });
    const r = await on.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat', limit: 2 }); // 只选 2 条
    expect(r.selected.length).toBe(2);
    const selectedSet = new Set(r.selected.map((m) => m.id));
    for (let i = 0; i < 6; i++) {
      const h = getDb().prepare('SELECT hit_count FROM noe_memory WHERE id=?').get(`f${i}`).hit_count;
      if (selectedSet.has(`f${i}`)) expect(h).toBeGreaterThan(0); // 选上的计数
      else expect(h).toBe(0); // 没选上的不计数
    }
  });

  it('P-topic(NOE_LESSON_TOPIC_INDEX=1)：召回到的 lesson 按 query 主题重叠加权，主题相关者优先占 reserved 槽', async () => {
    process.env.NOE_MEMORY_LESSON_CHANNEL = '1';
    process.env.NOE_LESSON_TOPIC_INDEX = '1';
    try {
      // mock memory：四主通道空，lesson 通道返回两条——无关 lesson 排在前(且 confidence 更高)，
      //   主题相关 lesson(tags 含 redis/缓存)排在后。topic 重排应把相关者提到前面，injectLimit=2 时它独占那 1 个 lesson 槽。
      const memory = {
        recall: () => [],
        recallFused: async ({ sourceTypes }) => {
          if (Array.isArray(sourceTypes) && sourceTypes.includes('learning_lesson')) {
            return [
              { id: 'lesson-unrelated', scope: 'insight', sourceType: 'learning_lesson', body: '认知修正：关于无关主题的经验', tags: ['lesson', 'think', '邮件', '日历'], confidence: 0.9, salience: 4 },
              { id: 'lesson-redis', scope: 'insight', sourceType: 'learning_lesson', body: '认知修正：用 redis 做缓存', tags: ['lesson', 'think', 'redis', '缓存'], confidence: 0.72, salience: 4 },
            ];
          }
          return [];
        },
      };
      const retriever = new NoeMemoryRetriever({ memory, auditLog: { recordRetrieval() {} }, logger: { warn() {} } });
      const r = await retriever.retrieve({ transcript: 'redis 缓存 怎么配', projectId: 'noe', routeType: 'chat', memoryPolicy: { injectLimit: 2 } });
      const lessonIds = r.selected.filter((m) => m.sourceType === 'learning_lesson').map((m) => m.id);
      // 主题相关的 redis lesson 被加权提前，独占唯一 lesson 槽（无关 lesson 落选）。
      expect(lessonIds).toContain('lesson-redis');
      expect(lessonIds).not.toContain('lesson-unrelated');
    } finally {
      delete process.env.NOE_MEMORY_LESSON_CHANNEL;
      delete process.env.NOE_LESSON_TOPIC_INDEX;
    }
  });

  it('P-topic flag OFF：召回 lesson 维持原序（topic 重排不生效，逐字零回归）', async () => {
    process.env.NOE_MEMORY_LESSON_CHANNEL = '1';
    delete process.env.NOE_LESSON_TOPIC_INDEX;
    try {
      const memory = {
        recall: () => [],
        recallFused: async ({ sourceTypes }) => {
          if (Array.isArray(sourceTypes) && sourceTypes.includes('learning_lesson')) {
            return [
              { id: 'lesson-unrelated', scope: 'insight', sourceType: 'learning_lesson', body: '认知修正：关于无关主题的经验', tags: ['lesson', 'think', '邮件', '日历'], confidence: 0.9, salience: 4 },
              { id: 'lesson-redis', scope: 'insight', sourceType: 'learning_lesson', body: '认知修正：用 redis 做缓存', tags: ['lesson', 'think', 'redis', '缓存'], confidence: 0.72, salience: 4 },
            ];
          }
          return [];
        },
      };
      const retriever = new NoeMemoryRetriever({ memory, auditLog: { recordRetrieval() {} }, logger: { warn() {} } });
      const r = await retriever.retrieve({ transcript: 'redis 缓存 怎么配', projectId: 'noe', routeType: 'chat', memoryPolicy: { injectLimit: 2 } });
      const lessonIds = r.selected.filter((m) => m.sourceType === 'learning_lesson').map((m) => m.id);
      // OFF：维持 stableDedupe 原序（unrelated 在前），唯一 lesson 槽给原序第一个 unrelated。
      expect(lessonIds).toContain('lesson-unrelated');
      expect(lessonIds).not.toContain('lesson-redis');
    } finally {
      delete process.env.NOE_MEMORY_LESSON_CHANNEL;
    }
  });

  it('opens a recall circuit and skips repeated failing memory calls', async () => {
    let now = 10_000;
    let calls = 0;
    const warnings = [];
    const auditEvents = [];
    const memory = {
      recall: () => {
        calls += 1;
        throw new Error('XIAOMI_API_KEY=tp-unit-test-redaction-key-00000000000000000000 unavailable');
      },
    };
    const retriever = new NoeMemoryRetriever({
      memory,
      auditLog: { recordRetrieval: (event) => auditEvents.push(event) },
      now: () => now,
      logger: { warn: (...args) => warnings.push(args.join(' ')) },
      circuitBreaker: createActiveMemoryRecallCircuitBreaker({
        failureThreshold: 1,
        cooldownMs: 30_000,
        now: () => now,
      }),
    });

    const first = await retriever.retrieve({ transcript: '主人记忆', projectId: 'noe', routeType: 'chat' });
    const callsAfterFailure = calls;
    const second = await retriever.retrieve({ transcript: '主人记忆', projectId: 'noe', routeType: 'chat' });
    const secondAudit = auditEvents.at(-1);
    now += 30_001;
    memory.recall = () => [{ id: 'fact-restored', scope: 'fact', body: '冷却后记忆恢复。' }];
    const third = await retriever.retrieve({ transcript: '主人记忆', projectId: 'noe', routeType: 'chat' });

    expect(first.ok).toBe(false);
    expect(first.droppedReasons).toContain('recall_failed');
    expect(first.recallCircuit.open).toBe(true);
    expect(warnings.join('\n')).not.toContain('tp-unit-test-redaction-key');
    expect(second.ok).toBe(true);
    expect(second.droppedReasons).toContain('recall_circuit_open');
    expect(calls).toBe(callsAfterFailure);
    expect(secondAudit.droppedReasons).toContain('recall_circuit_open');
    expect(third.ok).toBe(true);
    expect(third.selected.map((item) => item.id)).toContain('fact-restored');
  });

  it('suppresses semantic-only noise when a literal anchor already has direct recall hits', async () => {
    const calls = [];
    const memory = {
      recall({ q, scope }) {
        calls.push(`literal:${scope}:${q}`);
        if (scope === 'fact') return [{ id: 'fact-marker', scope: 'fact', body: 'marker direct hit', confidence: 0.9, salience: 4 }];
        return [];
      },
      async recallFused({ scope }) {
        calls.push(`fused:${scope}`);
        if (scope === 'fact') return [
          { id: 'fact-marker', scope: 'fact', body: 'marker direct hit', confidence: 0.9, salience: 4 },
          { id: 'fact-noise', scope: 'fact', body: 'semantic noise', confidence: 0.9, salience: 4 },
        ];
        if (scope === 'user') return [{ id: 'user-noise', scope: 'user', body: 'semantic user noise', confidence: 0.9, salience: 4 }];
        return [];
      },
    };
    const retriever = new NoeMemoryRetriever({
      memory,
      auditLog: { recordRetrieval() {} },
      logger: { warn() {} },
    });

    const result = await retriever.retrieve({
      transcript: 'memory_extractor_live_20260613104832_oub7jy',
      projectId: 'noe',
      routeType: 'reflection',
      limit: 8,
    });

    expect(result.selectedIds).toEqual(['fact-marker']);
    expect(result.droppedReasons).toContain('semantic_suppressed_by_literal_anchor');
    expect(calls.some((call) => call.startsWith('fused:'))).toBe(false);
  });

  it('falls back to fused recall for literal anchors when direct recall has no hits', async () => {
    const memory = {
      recall() { return []; },
      async recallFused({ scope }) {
        if (scope === 'user') return [{ id: 'user-semantic', scope: 'user', body: 'semantic owner note', confidence: 0.9, salience: 4 }];
        return [];
      },
    };
    const retriever = new NoeMemoryRetriever({
      memory,
      auditLog: { recordRetrieval() {} },
      logger: { warn() {} },
    });

    const result = await retriever.retrieve({
      transcript: 'voice_note 138395',
      projectId: 'noe',
      routeType: 'chat',
      limit: 8,
    });

    expect(result.selectedIds).toEqual(['user-semantic']);
    expect(result.droppedReasons).not.toContain('semantic_suppressed_by_literal_anchor');
  });

  describe('P8 persona_pin 召回排除（NOE_MEMORY_PERSONA_PIN）', () => {
    function seedPersonaAndFacts() {
      const { memory, retriever } = setup();
      // persona_pin：稳定 owner 偏好句（下沉 system prompt 的那一集合）
      memory.write({ id: 'pin-lang', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: '用户要求用中文回答咖啡问题', confidence: 0.9 });
      memory.write({ id: 'pin-fmt', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: '用户希望回复咖啡时控制在 3 到 5 句', confidence: 0.9 });
      // 真 fact（非 persona_pin：中性陈述事实）+ insight
      memory.write({ id: 'fact-coffee', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 4, body: '主人长期喝黑咖啡不加糖。', confidence: 0.9 });
      memory.write({ id: 'insight-coffee', projectId: 'noe', scope: 'insight', sourceType: 'learning_lesson', salience: 4, body: '关于咖啡偏好的认知修正经验', confidence: 0.8 });
      return { memory, retriever };
    }

    it('OFF（默认）：persona_pin 句仍正常召回（零回归）', async () => {
      delete process.env.NOE_MEMORY_PERSONA_PIN;
      const { retriever } = seedPersonaAndFacts();
      const r = await retriever.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat', memoryPolicy: { injectLimit: 8 } });
      const ids = r.selected.map((m) => m.id);
      expect(ids).toContain('pin-lang'); // OFF 时不排除
      expect(ids).toContain('fact-coffee');
    });

    it('ON：persona_pin 句被排除出召回，真 fact/insight 仍在', async () => {
      process.env.NOE_MEMORY_PERSONA_PIN = '1';
      try {
        const { retriever } = seedPersonaAndFacts();
        const r = await retriever.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat', memoryPolicy: { injectLimit: 8 } });
        const ids = r.selected.map((m) => m.id);
        expect(ids).not.toContain('pin-lang'); // 已下沉 → 不召回
        expect(ids).not.toContain('pin-fmt');
        expect(ids).toContain('fact-coffee');  // 真 fact 不受影响
        // 通道里也不含 persona_pin
        expect(r.channels.fact.map((m) => m.id)).not.toContain('pin-lang');
      } finally { delete process.env.NOE_MEMORY_PERSONA_PIN; }
    });

    it('ON：persona_pin 让出名额，更多 distinct 非 persona 记忆进 selected', async () => {
      // 小预算下，persona_pin 占名额会挤掉真 fact；排除后真 fact 进得来。
      delete process.env.NOE_MEMORY_PERSONA_PIN;
      const { memory } = setup();
      // 4 条 persona_pin（高 salience 抢前排）+ 2 条真 fact
      for (let i = 0; i < 4; i++) memory.write({ id: `pin${i}`, projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 5, body: `用户要求咖啡相关第${i}条稳定偏好`, confidence: 0.95 });
      memory.write({ id: 'realA', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 4, body: '主人办公室的咖啡机型号是 X。', confidence: 0.9 });
      memory.write({ id: 'realB', projectId: 'noe', scope: 'fact', sourceType: 'fact_extract', salience: 4, body: '主人下午两点常喝咖啡。', confidence: 0.9 });
      const ret = new NoeMemoryRetriever({ memory, auditLog: { recordRetrieval() {} }, logger: { warn() {} } });
      const off = await ret.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat', limit: 3 });
      process.env.NOE_MEMORY_PERSONA_PIN = '1';
      let on;
      try { on = await ret.retrieve({ transcript: '咖啡', projectId: 'noe', routeType: 'chat', limit: 3 }); }
      finally { delete process.env.NOE_MEMORY_PERSONA_PIN; }
      const offReal = off.selected.filter((m) => m.id.startsWith('real')).length;
      const onReal = on.selected.filter((m) => m.id.startsWith('real')).length;
      expect(onReal).toBeGreaterThan(offReal); // 排除 persona_pin 后真 fact 进入 selected 变多
    });
  });
});
