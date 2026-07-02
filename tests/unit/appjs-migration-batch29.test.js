// @ts-check
// 第三波手术 第29批 结构级防回归：server.js 二轮拆分热身矿②
// squadFinishHook（~43 行纯 hook builder：squad 结项产出 → 证据知识库索引）
// 迁出 src/server/services/squad-evidence-hook.js，工厂注入 evidenceKnowledgeStore。
// 接线点不变：squadDispatcher.setSquadFinishHook(createSquadEvidenceHook({ evidenceKnowledgeStore }))。
// 风格对齐 appjs-migration-batch28.test.js：源码文本断言 + 真跑行为冒烟。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSquadEvidenceHook } from '../../src/server/services/squad-evidence-hook.js';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const SERVER_FILE = 'server.js';
const MODULE_FILE = 'src/server/services/squad-evidence-hook.js';

describe('server.js 拆分第29批（squadFinishHook 外迁）', () => {
  const serverSrc = read(SERVER_FILE);
  const moduleSrc = read(MODULE_FILE);

  it('新模块 <500 行（工程硬规则）+ @ts-check 头 + 注入式工厂', () => {
    expect(moduleSrc.split('\n').length, `${MODULE_FILE} 行数超标`).toBeLessThan(500);
    expect(moduleSrc.startsWith('// @ts-check')).toBe(true);
    expect(moduleSrc).toContain('export function createSquadEvidenceHook({ evidenceKnowledgeStore })');
  });

  it('server.js 不再内联 hook 实现，接线改走工厂且仍挂在 squadDispatcher 上', () => {
    expect(serverSrc).toContain("import { createSquadEvidenceHook } from './src/server/services/squad-evidence-hook.js';");
    expect(serverSrc).toContain('squadDispatcher.setSquadFinishHook(createSquadEvidenceHook({ evidenceKnowledgeStore }));');
    // 内联实现的标志性片段不得残留 server.js
    expect(serverSrc).not.toContain("refKind: 'squad_task'");
    expect(serverSrc).not.toContain("refKind: 'squad_final'");
  });

  it('行为契约：四类 refKind + 截断（title 200 / review 4000）+ 吞错不阻断全部保留在模块', () => {
    for (const kind of ['squad_task', 'squad_dev_attempt', 'squad_qa_review', 'squad_final']) {
      expect(moduleSrc, `缺 refKind ${kind}`).toContain(`refKind: '${kind}'`);
    }
    expect(moduleSrc).toContain('.slice(0, 200)');
    expect(moduleSrc).toContain('.slice(0, 4000)');
    expect(moduleSrc).toContain('catch { /* 索引失败不阻断 squad 主流程 */ }');
  });

  it('真跑冒烟：完整 squad 房 → 索引出 task/attempt/review/final 四类条目', () => {
    const indexed = [];
    const hook = createSquadEvidenceHook({ evidenceKnowledgeStore: { indexItems: (items) => indexed.push(...items) } });
    hook('room-1', {
      taskList: [{
        id: 't1', title: 'T', summary: 'S', status: 'done',
        attempts: [{ by: 'dev', content: 'impl' }],
        reviews: ['ok', { verdict: 'pass' }],
      }],
      finalConsensus: '全部完成',
    }, 'done');
    const kinds = indexed.map((i) => i.refKind);
    expect(kinds).toEqual(['squad_task', 'squad_dev_attempt', 'squad_qa_review', 'squad_qa_review', 'squad_final']);
    expect(indexed[0].refId).toBe('room-1:t1');
    expect(indexed[indexed.length - 1].content).toBe('[done] 全部完成');
    // sessionId = roomId 契约（KC 命中后跳转依赖）
    expect(indexed.every((i) => i.sessionId === 'room-1' && i.roomId === 'room-1')).toBe(true);
  });

  it('真跑冒烟：空房不调 indexItems；store 抛错不外泄', () => {
    let called = 0;
    const hook = createSquadEvidenceHook({ evidenceKnowledgeStore: { indexItems: () => { called++; } } });
    hook('room-2', { taskList: [] }, 'paused');
    expect(called).toBe(0);
    const boom = createSquadEvidenceHook({ evidenceKnowledgeStore: { indexItems: () => { throw new Error('boom'); } } });
    expect(() => boom('room-3', { finalConsensus: 'x' }, 'done')).not.toThrow();
  });
});
