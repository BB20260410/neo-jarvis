import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createSignalRetentionWeightProvider } from '../../src/room/NoeSelfEvolutionSignalWeights.js';

// P10 棘轮闸（2026-07-02）：server.js 曾从 1656 行回弹到 3712（三波拆分成果被增量吞噬）。
//   本测试把「只许减不许增」写进全量测试——人和飞轮（双绿门跑的就是这套测试）都别再往 server.js 塞代码：
//   新路由进 src/server/routes/、可复用服务进 src/server/services/（项目 CLAUDE.md 既有纪律）。
//   合法缩减后请同步调低 MAX_LINES（棘轮收紧）；确需放宽必须 owner 拍板。
// 2026-07-03 校准 3712→3717：R2-P5 心跳 onOverdue→heartbeat_overdue 事件接线（组合根职责，无法外移）。
// 2026-07-03 再校准 3717→3722：G6 MetaEvolution outcomeStats 按 applied 分层。
// 2026-07-03 三校准 3722→3724：任务2 implement 装配传 localCodeAdapterId。
// 2026-07-03 四校准 3724→3738：轴3 capabilityTick 拓宽信号源。
// 2026-07-03 五校准 3738→3758：Step1 evolutionReview 自我复盘心跳。
// 2026-07-03 六校准 3758→3780：阶段二A signalRetentionWeight 提供者。
// 2026-07-03 七校准 3780→3786：阶段二 KG 参与推理 kgContext 注入。
// 2026-07-03 八校准 3786→3789：阶段二 扩展工具生态 matchExistingTools 注入。
// 2026-07-03 九校准 3789→3791：阶段二 难目标分解 decompose 注入。
// 2026-07-03 十校准 3791→3804：第三阶段 更智能陪伴 proactive smart gate。
// 2026-07-03 十一校准 3804→3810：第三阶段 全模态一体化 multimodalProvider 注入。
// 2026-07-03 十二校准 3810→3822：第三阶段 视觉源引入融合点。
// 2026-07-03 十三校准 3822→3825：第三阶段 语音模态补活(VoiceActivity 追踪→融合 voiceActive),四模态全融合,组合根DI。
// 2026-07-03 十四校准 3825→3830：飞轮 stuck 根因修复 A1/A2/B 三 flag 组合根接线(typeErrDetail/repairHints/failFast)。
const MAX_LINES = 3830;

describe('server.js 行数棘轮', () => {
  it(`server.js 不得超过 ${MAX_LINES} 行（只许减不许增）`, () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    // 与 wc -l 同口径：数换行符（split('\n') 会把末尾换行多算一行）。
    const lines = (readFileSync(resolve(root, 'server.js'), 'utf8').match(/\n/g) || []).length;
    expect(lines).toBeLessThanOrEqual(MAX_LINES);
  });
});

describe('signalRetentionWeight 移出组合根后的行为契约', () => {
  it('启用时按结局聚合保留率并复用缓存', () => {
    let reads = 0;
    const weight = createSignalRetentionWeightProvider({
      enabled: true,
      applyStaticBias: false,
      now: () => 1_000,
      getDb: () => ({
        prepare: () => ({
          all: () => {
            reads += 1;
            return [
              { sig: 'test_gap', status: 'done' },
              { sig: 'test_gap', status: 'dropped' },
              { sig: 'self_directed', status: 'done' },
            ];
          },
        }),
      }),
    });
    expect(weight('test_gap')).toBeCloseTo(0.675);
    expect(weight('self_directed')).toBe(1);
    expect(reads).toBe(1);
  });

  it('关闭或 DB 读失败时均 fail-open 为 1', () => {
    const disabled = createSignalRetentionWeightProvider({ enabled: false, getDb: () => { throw new Error('should_not_read'); } });
    const broken = createSignalRetentionWeightProvider({ enabled: true, getDb: () => { throw new Error('db_down'); } });
    expect(disabled('test_gap')).toBe(1);
    expect(broken('test_gap')).toBe(1);
  });
});
