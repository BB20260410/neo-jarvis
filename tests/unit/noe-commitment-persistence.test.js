// @ts-check
// 强健工程：CommitmentStore 落盘——重启不丢用户"提醒我…"承诺（旧版纯内存重启即丢）
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createCommitmentStore } from '../../src/runtime/NoeCommitmentStore.js';

const dir = mkdtempSync(join(tmpdir(), 'noe-commit-persist-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let t = 1_000_000;
const now = () => (t += 1000);

describe('CommitmentStore 持久化', () => {
  it('add 的承诺重启后还在（核心：用户"提醒我"不白说）', () => {
    const file = join(dir, 'c1.json');
    const a = createCommitmentStore({ file, now });
    a.add({ text: '明天提醒我买菜' });
    a.add({ text: '下周三前交报销' });
    // 模拟重启
    const b = createCommitmentStore({ file, now });
    expect(b.list().map((c) => c.text).sort()).toEqual(['下周三前交报销', '明天提醒我买菜']);
    expect(b.size()).toBe(2);
  });

  it('resolve/cancel 状态重启后保留', () => {
    const file = join(dir, 'c2.json');
    const a = createCommitmentStore({ file, now });
    const r1 = a.add({ text: '收口任务一' });
    const r2 = a.add({ text: '取消任务二' });
    a.resolve(r1.id);
    a.cancel(r2.id);
    const b = createCommitmentStore({ file, now });
    expect(b.get(r1.id).status).toBe('done');
    expect(b.get(r2.id).status).toBe('cancelled');
    expect(b.list({ status: 'open' })).toEqual([]);
  });

  it('due() 跨重启仍能取出该提的 open 项', () => {
    const file = join(dir, 'c3.json');
    const a = createCommitmentStore({ file, now });
    a.add({ text: '到点提醒', dueWindow: { earliestMs: 0, latestMs: 5_000_000 } });
    const b = createCommitmentStore({ file, now });
    const due = b.due(2_000_000);
    expect(due.length).toBe(1);
    expect(due[0].text).toBe('到点提醒');
  });

  it('原子写：不留 .tmp，二次写留一代备份', () => {
    const file = join(dir, 'c4.json');
    const a = createCommitmentStore({ file, now });
    a.add({ text: '第一条' });
    a.add({ text: '第二条' });
    expect(existsSync(file + '.tmp')).toBe(false);
    expect(existsSync(file + '.bak-latest')).toBe(true);
  });

  it('损坏文件：空载不崩 + .corrupted 备份', () => {
    const file = join(dir, 'c5.json');
    writeFileSync(file, '{ 半截坏 commitments', 'utf-8');
    const s = createCommitmentStore({ file, now });
    expect(s.size()).toBe(0);
    expect(s.add({ text: '坏后仍能新增' }).id).toBeTruthy(); // 不崩，可继续用
    expect(readdirSync(dir).some((n) => n.startsWith('c5.json.corrupted-'))).toBe(true);
  });

  it('脏数据条目（缺 text/id）被逐条跳过，好的保留', () => {
    const file = join(dir, 'c6.json');
    writeFileSync(file, JSON.stringify({
      version: 1,
      commitments: [
        { id: 'ok1', text: '正常', category: 'reminder', sensitivity: 'routine', dueWindow: { earliestMs: 0, latestMs: 1 }, createdAt: 1, updatedAt: 1, status: 'open' },
        { id: '', text: '缺id' },
        { id: 'noText', text: '' },
        { id: 'badStatus', text: '坏状态归 open', status: '乱写' },
      ],
    }), 'utf-8');
    const s = createCommitmentStore({ file, now });
    expect(s.get('ok1')?.text).toBe('正常');
    expect(s.get('badStatus')?.status).toBe('open'); // 非法 status 归一
    expect(s.size()).toBe(2);
  });

  it('不给 file 时纯内存（向后兼容，零落盘副作用）', () => {
    const before = readdirSync(dir).length;
    const s = createCommitmentStore({ now });
    s.add({ text: '内存态' });
    expect(s.size()).toBe(1);
    expect(readdirSync(dir).length).toBe(before); // 没产生任何文件
  });
});
