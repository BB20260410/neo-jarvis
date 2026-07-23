import { describe, it, expect } from 'vitest';
import {
  readThoughtLoopGuardEnv,
  computeSynapticStrength,
  extractKeywords,
  detectTopicLoop,
  buildPivotSuggestion,
  analyzeThoughtLoop,
  DEFAULT_LOOP_PARAMS,
  DEFAULT_SYNAPSE_PARAMS,
} from '../../src/cognition/NoeThoughtLoopGuard.js';

// 全部确定性：注入 now / env / 念头数组，不依赖真实时钟、网络、模型。

describe('readThoughtLoopGuardEnv（env 门控，默认 OFF）', () => {
  it('缺省 / 空 / 未知值一律 OFF', () => {
    expect(readThoughtLoopGuardEnv({}).enabled).toBe(false);
    expect(readThoughtLoopGuardEnv({ NOE_THOUGHT_LOOP_GUARD: '' }).enabled).toBe(false);
    expect(readThoughtLoopGuardEnv({ NOE_THOUGHT_LOOP_GUARD: 'maybe' }).enabled).toBe(false);
    expect(readThoughtLoopGuardEnv({ NOE_THOUGHT_LOOP_GUARD: '0' }).enabled).toBe(false);
  });
  it('仅 1/true/on（大小写无关）才 ON', () => {
    expect(readThoughtLoopGuardEnv({ NOE_THOUGHT_LOOP_GUARD: '1' }).enabled).toBe(true);
    expect(readThoughtLoopGuardEnv({ NOE_THOUGHT_LOOP_GUARD: 'true' }).enabled).toBe(true);
    expect(readThoughtLoopGuardEnv({ NOE_THOUGHT_LOOP_GUARD: 'ON' }).enabled).toBe(true);
    expect(readThoughtLoopGuardEnv({ NOE_THOUGHT_LOOP_GUARD: ' True ' }).enabled).toBe(true);
  });
});

describe('computeSynapticStrength（Ebbinghaus S(t)=S_base·e^(-t/tau)）', () => {
  const now = 1_000_000_000_000;

  it('刚访问（dt<=0）= 满强度 sBase', () => {
    expect(computeSynapticStrength({ lastAccessTs: now, now })).toBe(DEFAULT_SYNAPSE_PARAMS.sBase);
    // 未来时间戳也钳为满强度（fail-open，不误判为遗忘）
    expect(computeSynapticStrength({ lastAccessTs: now + 5000, now })).toBe(DEFAULT_SYNAPSE_PARAMS.sBase);
  });

  it('恰好一个 tau 间隔后 ≈ 1/e（约 0.3679）', () => {
    const tau = DEFAULT_SYNAPSE_PARAMS.tauBaseMs; // accessCount=0
    const s = computeSynapticStrength({ lastAccessTs: now - tau, now });
    expect(s).toBeCloseTo(Math.exp(-1), 5);
  });

  it('随时间间隔单调递减', () => {
    const s1 = computeSynapticStrength({ lastAccessTs: now - 10 * 60_000, now });
    const s2 = computeSynapticStrength({ lastAccessTs: now - 60 * 60_000, now });
    const s3 = computeSynapticStrength({ lastAccessTs: now - 240 * 60_000, now });
    expect(s1).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThan(s3);
  });

  it('accessCount 越高 tau 越大、同样间隔下衰减越慢（被复习的念头活更久）', () => {
    const dtMs = 60 * 60_000; // 1 小时
    const cold = computeSynapticStrength({ lastAccessTs: now - dtMs, now, accessCount: 0 });
    const reviewed = computeSynapticStrength({ lastAccessTs: now - dtMs, now, accessCount: 5 });
    expect(reviewed).toBeGreaterThan(cold);
  });

  it('非法输入 fail-open（返回 sBase，不误判遗忘）', () => {
    expect(computeSynapticStrength({ lastAccessTs: NaN, now })).toBe(DEFAULT_SYNAPSE_PARAMS.sBase);
    expect(computeSynapticStrength({ lastAccessTs: now, now: undefined })).toBe(DEFAULT_SYNAPSE_PARAMS.sBase);
    expect(computeSynapticStrength()).toBe(DEFAULT_SYNAPSE_PARAMS.sBase);
  });

  it('结果恒在 [0, sBase] 区间', () => {
    const s = computeSynapticStrength({ lastAccessTs: now - 9999 * 3600_000, now });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(DEFAULT_SYNAPSE_PARAMS.sBase);
  });
});

describe('extractKeywords（复用 normalizeForDedup 的归一化）', () => {
  it('抽中文 bigram 关键词', () => {
    const kws = extractKeywords('我又在想意识到底是什么');
    expect(kws).toContain('意识');
  });

  it('抽 latin 词并小写归一化', () => {
    const kws = extractKeywords('thinking about Consciousness again');
    expect(kws).toContain('consciousness');
    expect(kws).toContain('thinking');
  });

  it('过滤停用词与过短词', () => {
    const kws = extractKeywords('我 的 是 了'); // 全停用词/单字
    expect(kws).toEqual([]);
  });

  it('空 / 纯标点 / 非字符串 → 空数组（不抛）', () => {
    expect(extractKeywords('')).toEqual([]);
    expect(extractKeywords('！！？？。。')).toEqual([]);
    expect(extractKeywords(null)).toEqual([]);
    expect(extractKeywords(undefined)).toEqual([]);
  });

  it('受 maxKeywords 上限约束', () => {
    const kws = extractKeywords('意识自由存在本质逻辑意义关系系统模式边界焦虑卡住循环反刍抽象', { maxKeywords: 3 });
    expect(kws.length).toBeLessThanOrEqual(3);
  });
});

describe('detectTopicLoop（≥2 关键词在 ≥5 条念头反复出现）', () => {
  it('同一主题词在 5 条以上念头反复 → 回环', () => {
    const thoughts = [
      { text: '我在想意识和自由的关系' },
      { text: '意识到底是不是自由的前提' },
      { text: '自由意识又冒出来了' },
      { text: '关于意识与自由我还是没头绪' },
      { text: '意识、自由，绕不开这两个' },
      { text: '今天天气不错' }, // 无关，不该被统计进共享
    ];
    const r = detectTopicLoop(thoughts);
    expect(r.looped).toBe(true);
    const kwSet = new Set(r.sharedKeywords.map((k) => k.keyword));
    expect(kwSet.has('意识')).toBe(true);
    expect(kwSet.has('自由')).toBe(true);
    // 统计的是「出现在多少条念头」：意识/自由各 5 条
    expect(r.sharedKeywords.find((k) => k.keyword === '意识').count).toBe(5);
  });

  it('多样化念头（无足量共享词）→ 不回环', () => {
    const thoughts = [
      { text: '修一个 bug' },
      { text: '给 owner 回消息' },
      { text: '看天气预报' },
      { text: '整理今天的笔记' },
      { text: '想想晚饭吃什么' },
    ];
    expect(detectTopicLoop(thoughts).looped).toBe(false);
  });

  it('只有 1 个共享关键词达阈值（minSharedKeywords=2）→ 不回环', () => {
    const thoughts = [
      { text: '意识 alpha' },
      { text: '意识 beta' },
      { text: '意识 gamma' },
      { text: '意识 delta' },
      { text: '意识 epsilon' },
    ];
    const r = detectTopicLoop(thoughts);
    // 「意识」出现在 5 条，但只有它一个达阈值 → 不到 minSharedKeywords=2
    expect(r.sharedKeywords.some((k) => k.keyword === '意识')).toBe(true);
    expect(r.looped).toBe(false);
  });

  it('念头内重复同一词只算一条（doc-frequency 而非总词频）', () => {
    // 单条里「意识」出现很多次，但只有 2 条念头 → 远不到 loopThreshold=5
    const thoughts = [
      { text: '意识意识意识意识意识自由自由自由自由' },
      { text: '意识意识自由自由' },
    ];
    const r = detectTopicLoop(thoughts);
    const yi = r.sharedKeywords.find((k) => k.keyword === '意识');
    expect(yi).toBeUndefined(); // count 至多 2，<5，不进 sharedKeywords
    expect(r.looped).toBe(false);
  });

  it('仅看 windowSize 窗口内的念头', () => {
    // 窗口设 5：前 5 条是各不相同的话题（无足量共享词），第 6+ 条才是回环主题 →
    // 窗口只取前 5 条 → 不应判回环。
    // 注意：这 5 条必须是「真·各不相同」的内容。早期用 `无关话题第${i}个独立内容` 这种
    // 仅末位数字不同、其余逐字相同的模板当噪声是错的——归一化后它们共享 8 个 bigram
    // （无关/关话/话题/…）出现在全部 5 条里，那本身就是「近重复反刍」，被判回环是正确行为，
    // 测不到窗口边界。改用词汇互不重叠的 5 个独立话题，才真正只在测「窗口外的念头不被统计」。
    const noise = [
      { text: '修复登录页面崩溃' },
      { text: '给客户回一封邮件' },
      { text: '研究新的渲染管线' },
      { text: '整理上周的会议纪要' },
      { text: '盘算晚饭吃点什么好' },
    ];
    const looping = Array.from({ length: 6 }, () => ({ text: '意识 自由 反复出现' }));
    const thoughts = [...noise, ...looping];
    const r = detectTopicLoop(thoughts, { ...DEFAULT_LOOP_PARAMS, windowSize: 5 });
    expect(r.consideredCount).toBe(5);
    expect(r.looped).toBe(false);
  });

  it('参数可覆盖：放宽到 loopThreshold=2 / minSharedKeywords=2', () => {
    const thoughts = [
      { text: '意识 自由' },
      { text: '意识 自由' },
    ];
    const r = detectTopicLoop(thoughts, { windowSize: 12, loopThreshold: 2, minSharedKeywords: 2, minKeywordLen: 2, maxKeywordsPerThought: 12 });
    expect(r.looped).toBe(true);
  });

  it('空数组 / 非数组 → 不回环且不抛', () => {
    expect(detectTopicLoop([]).looped).toBe(false);
    // @ts-expect-error 故意传非数组测健壮性
    expect(detectTopicLoop(null).looped).toBe(false);
  });

  it('字符串元素与对象元素都支持', () => {
    const thoughts = ['意识 自由', '意识 自由', '意识 自由', '意识 自由', '意识 自由'];
    expect(detectTopicLoop(thoughts).looped).toBe(true);
  });
});

describe('buildPivotSuggestion', () => {
  it('有共享词 → 含词的可执行建议', () => {
    const s = buildPivotSuggestion([{ keyword: '意识', count: 5 }, { keyword: '自由', count: 5 }]);
    expect(s).toContain('意识');
    expect(s).toContain('自由');
    expect(typeof s).toBe('string');
  });
  it('支持纯字符串数组', () => {
    expect(buildPivotSuggestion(['意识', '自由'])).toContain('意识');
  });
  it('空 → null', () => {
    expect(buildPivotSuggestion([])).toBeNull();
    expect(buildPivotSuggestion(null)).toBeNull();
  });
});

describe('analyzeThoughtLoop（顶层编排）', () => {
  const now = 1_000_000_000_000;
  const loopingThoughts = [
    { text: '意识和自由的关系', ts: now - 1000, accessCount: 1 },
    { text: '意识是不是自由', ts: now - 2000 },
    { text: '自由意识又来了', ts: now - 3000 },
    { text: '意识与自由', ts: now - 4000 },
    { text: '意识 自由', ts: now - 5000 },
  ];

  it('门控 OFF（默认）：仍返回诊断，但 enabled=false', () => {
    const r = analyzeThoughtLoop({ recentThoughts: loopingThoughts, now, gate: { enabled: false } });
    expect(r.enabled).toBe(false);
    // 诊断仍然计算（纯计算无副作用）
    expect(r.looped).toBe(true);
    expect(r.suggestion).toBeTruthy();
  });

  it('门控 ON：回环时给出 enabled=true + 建议 + reasons', () => {
    const r = analyzeThoughtLoop({ recentThoughts: loopingThoughts, now, gate: { enabled: true } });
    expect(r.enabled).toBe(true);
    expect(r.looped).toBe(true);
    expect(r.suggestion).toContain('换个角度');
    expect(r.reasons.some((x) => x.startsWith('shared_keywords:'))).toBe(true);
  });

  it('不回环时：looped=false 且无建议', () => {
    const calm = [
      { text: '修 bug', ts: now },
      { text: '回消息', ts: now - 1000 },
      { text: '看天气', ts: now - 2000 },
    ];
    const r = analyzeThoughtLoop({ recentThoughts: calm, now, gate: { enabled: true } });
    expect(r.looped).toBe(false);
    expect(r.suggestion).toBeNull();
    expect(r.reasons).toEqual([]);
  });

  it('latestStrength：有 now+ts 时按 Ebbinghaus 计算', () => {
    const r = analyzeThoughtLoop({ recentThoughts: loopingThoughts, now, gate: { enabled: true } });
    expect(typeof r.latestStrength).toBe('number');
    expect(r.latestStrength).toBeGreaterThan(0);
    expect(r.latestStrength).toBeLessThanOrEqual(DEFAULT_SYNAPSE_PARAMS.sBase);
  });

  it('latestStrength：缺 now 或缺 ts → null（不臆造）', () => {
    const noTs = [{ text: '意识 自由' }, { text: '意识 自由' }];
    expect(analyzeThoughtLoop({ recentThoughts: noTs, gate: { enabled: true } }).latestStrength).toBeNull();
    expect(analyzeThoughtLoop({ recentThoughts: noTs, now, gate: { enabled: true } }).latestStrength).toBeNull();
  });

  it('默认 gate（不传）从 env 读，测试进程无该 env → enabled=false', () => {
    const r = analyzeThoughtLoop({ recentThoughts: loopingThoughts, now });
    expect(r.enabled).toBe(false); // 不依赖测试环境是否设了该 env：默认 OFF 语义
  });

  it('空输入 fail-open：looped=false 不抛', () => {
    const r = analyzeThoughtLoop({ recentThoughts: [], now, gate: { enabled: true } });
    expect(r.looped).toBe(false);
    expect(r.consideredCount).toBe(0);
  });

  it('返回对象被冻结（防调用方误改诊断结果）', () => {
    const r = analyzeThoughtLoop({ recentThoughts: loopingThoughts, now, gate: { enabled: true } });
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.sharedKeywords)).toBe(true);
  });
});