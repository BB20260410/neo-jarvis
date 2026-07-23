import { describe, it, expect } from 'vitest';
import { createNoeFocusStack } from '../../src/cognition/NoeFocusStack.js';

describe('createNoeFocusStack', () => {
  it('push/pop 子任务焦点，pop 回上层', () => {
    let t = 0;
    const s = createNoeFocusStack({ now: () => (t += 1) });
    s.push({ focus: '主目标：重构记忆层' });
    s.push({ focus: '子任务：改 dedup 阈值' });
    expect(s.current().focus).toBe('子任务：改 dedup 阈值');
    const r = s.pop();
    expect(r.popped.focus).toBe('子任务：改 dedup 阈值');
    expect(r.current.focus).toBe('主目标：重构记忆层'); // 弹回主线
  });

  it('空 focus 拒；空栈 pop 安全', () => {
    const s = createNoeFocusStack();
    expect(s.push({ focus: '' }).ok).toBe(false);
    expect(s.pop().ok).toBe(false);
    expect(s.current()).toBeNull();
  });

  it('栈溢出：保住主线 root + 最近帧，中段进 overflowSummary，不丢主线', () => {
    let t = 0;
    const s = createNoeFocusStack({ maxDepth: 4, now: () => (t += 1) });
    for (let i = 0; i < 10; i += 1) s.push({ focus: `F${i}` });
    const snap = s.snapshot();
    expect(snap.depth).toBe(4); // 不超 maxDepth
    expect(snap.mainLine.focus).toBe('F0'); // 主线（root）永不丢
    expect(snap.current.focus).toBe('F9');  // 最近帧保留
    expect(snap.overflowSummaries.length).toBeGreaterThan(0); // 被挤中段有摘要
    const allSummaries = snap.overflowSummaries.map((o) => o.summary).join(' ');
    expect(allSummaries).toContain('F1'); // 中段被摘要，没丢
  });

  it('returnToMainLine：收起所有子任务回到 root', () => {
    const s = createNoeFocusStack();
    s.push({ focus: 'root' });
    s.push({ focus: 'sub1' });
    s.push({ focus: 'sub2' });
    const r = s.returnToMainLine();
    expect(r.collapsed).toBe(2);
    expect(r.current.focus).toBe('root');
    expect(s.snapshot().depth).toBe(1);
  });

  it('自定义 summarize', () => {
    let t = 0;
    const s = createNoeFocusStack({ maxDepth: 3, now: () => (t += 1), summarize: (frames) => `收起${frames.length}个子焦点` });
    for (let i = 0; i < 6; i += 1) s.push({ focus: `F${i}` });
    expect(s.snapshot().overflowSummaries.some((o) => o.summary.includes('收起'))).toBe(true);
  });

  it('clear 清空', () => {
    const s = createNoeFocusStack();
    s.push({ focus: 'a' });
    s.clear();
    expect(s.snapshot().depth).toBe(0);
  });
});
