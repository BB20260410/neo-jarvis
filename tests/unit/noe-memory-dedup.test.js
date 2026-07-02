// 记忆写入去重/冲突合并（借鉴 mem0）：相似记忆 UPDATE 替换而非堆新，矛盾不并存。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryCore } from '../../src/memory/MemoryCore.js';
import { close, initSqlite } from '../../src/storage/SqliteStore.js';
import { textSimilarity, decideMemoryWrite, normalizeForDedup } from '../../src/memory/NoeMemoryDedup.js';

describe('NoeMemoryDedup 纯函数', () => {
  it('normalize 去标点空白、归一化大小写', () => {
    expect(normalizeForDedup('我喜欢美式。 ')).toBe('我喜欢美式');
    expect(normalizeForDedup('I Like AmericanO!')).toBe('ilikeamericano');
  });

  it('textSimilarity：相同=1、近重复中高分、换关键词字符法抓不到（诚实边界）', () => {
    expect(textSimilarity('我喜欢喝美式咖啡', '我喜欢喝美式咖啡。')).toBe(1);     // 仅标点差 → 近重复
    expect(textSimilarity('我喜欢喝美式咖啡', '我喜欢喝美式咖啡，不加糖')).toBeGreaterThan(0.62); // 追加内容 → 合并
    expect(textSimilarity('我喜欢喝美式咖啡', '我喜欢喝拿铁咖啡')).toBeLessThan(0.62); // 换关键词 → 字符法不合并（需语义版）
    expect(textSimilarity('今天北京下雨', '我家的猫叫小白')).toBeLessThan(0.15);   // 无关 → 低分
  });

  it('decideMemoryWrite：近重复 → update 命中那条；追加内容会合并；无候选/不相干 → add', () => {
    const cands = [
      { id: 'a', body: '我喜欢喝美式咖啡', scope: 'fact', salience: 3 },
      { id: 'b', body: '我家住在北京朝阳区', scope: 'fact', salience: 3 },
    ];
    expect(decideMemoryWrite({ body: '我喜欢喝美式咖啡。', scope: 'fact' }, cands).action).toBe('update'); // 近重复
    expect(decideMemoryWrite({ body: '我喜欢喝美式咖啡，不加糖', scope: 'fact' }, cands).action).toBe('update'); // 追加内容
    expect(decideMemoryWrite({ body: '我今天买了一台新电脑', scope: 'fact' }, cands).action).toBe('add');
    expect(decideMemoryWrite({ body: '随便什么', scope: 'fact' }, []).action).toBe('add');
  });

  it('decideMemoryWrite：短句追加型靠前缀包含救回（明天三点开会→…在会议室A）；极短句(<6字)不靠包含误并', () => {
    const cand = [{ id: 'a', body: '明天下午三点开会', scope: 'fact', salience: 3 }];
    expect(decideMemoryWrite({ body: '明天下午三点开会，在会议室A', scope: 'fact' }, cand).action).toBe('update');
    // "好"vs"好的"归一化后短方仅 1-2 字 < minLen6，不靠前缀包含合并（太短不可靠）
    expect(decideMemoryWrite({ body: '好的', scope: 'fact' }, [{ id: 'b', body: '好', scope: 'fact', salience: 3 }]).action).toBe('add');
  });

  it('decideMemoryWrite：跨 scope 不合并；高 salience 受保护不被替换', () => {
    const cands = [{ id: 'vip', body: '我叫张三', scope: 'fact', salience: 5 }];
    expect(decideMemoryWrite({ body: '我叫张三。', scope: 'fact' }, cands).action).toBe('add'); // salience5 保护
    const cross = [{ id: 'x', body: '我喜欢咖啡', scope: 'voice', salience: 3 }];
    expect(decideMemoryWrite({ body: '我喜欢咖啡', scope: 'fact' }, cross).action).toBe('add'); // 跨 scope
  });

  it('两段纯符号(归一化后皆空)不判为相同，避免误合并不同内容', () => {
    expect(textSimilarity('。。。', '！！！')).toBe(0);   // 修复前: 两空归一化返回 1 → 误判完全相同
    expect(textSimilarity('🎉🎉', '###')).toBe(0);
  });

  it('多个前缀包含候选被阈值clamp并列时，按真实相似度选最相似的(不被候选顺序误选)', () => {
    const cands = [
      { id: 'a', body: '明天下午三点', scope: 'fact', salience: 3 },
      { id: 'b', body: '明天下午三点开', scope: 'fact', salience: 3 },
    ];
    const r = decideMemoryWrite({ body: '明天下午三点开会讨论方案', scope: 'fact' }, cands);
    expect(r.action).toBe('update');
    expect(r.target.id).toBe('b');   // 真实相似度 b>a；修复前 clamp 并列会误选顺序靠前的 a
  });
});

describe('MemoryCore × 去重（真 SQLite）', () => {
  let tmp; let core;
  beforeEach(() => {
    close();
    tmp = mkdtempSync(join(tmpdir(), 'noe-dedup-'));
    initSqlite(join(tmp, 'panel.db'));
    core = new MemoryCore({ dedupe: { enabled: true, threshold: 0.62 } });
  });
  afterEach(() => { close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; });

  // 直接 SQL 计数（recall 的 FTS/LIKE 召回口径受查询词影响，不适合断言"库里到底几条"）
  const countAll = (projectId, scope) => core.db().prepare('SELECT COUNT(*) n FROM noe_memory WHERE project_id = ? AND scope = ? AND hidden = 0').get(projectId, scope).n;

  it('相似新写入 UPDATE 旧记忆（库里只剩一条，body 更新，merge_trace 留痕）', () => {
    const first = core.write({ body: '我喜欢喝美式咖啡', scope: 'fact', projectId: 'p1' });
    core.write({ body: '我喜欢喝美式咖啡，不加糖', scope: 'fact', projectId: 'p1' });
    expect(countAll('p1', 'fact')).toBe(1);  // 没堆成两条
    const got = core.get(first.id, { includeHidden: true });
    expect(got).not.toBeNull();               // 替换的是同一条（id 没变）
    expect(got.body).toContain('不加糖');     // body 已更新
    expect(got.mergeTrace.length).toBe(1);    // 留了一次合并痕迹
  });

  it('不相干写入正常新增（不误并）', () => {
    core.write({ body: '我喜欢喝美式咖啡', scope: 'fact', projectId: 'p1' });
    core.write({ body: '我家的宽带是电信的', scope: 'fact', projectId: 'p1' });
    expect(countAll('p1', 'fact')).toBe(2);
  });

  it('显式 id 的写入绕过去重（精确 upsert 语义不变，如 vision-latest）', () => {
    core.write({ id: 'vision-latest:p1', body: '屏幕上是代码编辑器', scope: 'vision', projectId: 'p1' });
    core.write({ id: 'vision-latest:p1', body: '屏幕上是代码编辑器现在', scope: 'vision', projectId: 'p1' });
    const got = core.get('vision-latest:p1', { includeHidden: true });
    expect(got.body).toContain('现在');
  });

  it('dedupe 关闭（默认）时行为同旧：相似也堆两条', () => {
    const plain = new MemoryCore({ dedupe: { enabled: false } });
    plain.write({ body: '我喜欢喝美式咖啡', scope: 'fact', projectId: 'p2' });
    plain.write({ body: '我喜欢喝美式咖啡，不加糖', scope: 'fact', projectId: 'p2' });
    expect(plain.db().prepare('SELECT COUNT(*) n FROM noe_memory WHERE project_id = ? AND scope = ?').get('p2', 'fact').n).toBe(2);
  });
});
