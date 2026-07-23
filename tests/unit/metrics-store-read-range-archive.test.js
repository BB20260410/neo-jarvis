import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MetricsStore } from '../../src/metrics/MetricsStore.js';

// P2 观测修复：_readRange 只认 metrics-YYYY-MM.jsonl，漏掉 50MB 滚动产生的 metrics-YYYY-MM.jsonl.<ts>
//   归档文件 → 历史区间查询少算。_warmCache（M12 修复）已兼容归档名，_readRange 必须同样兼容。
describe('MetricsStore._readRange 归档文件兼容', () => {
  it('历史月份查询同时读 .jsonl 与 .jsonl.<ts> 归档', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metrics-archive-'));
    const row = (ts, roomId) => JSON.stringify({ ts, roomId, adapter: 'a', tokens: 1 });
    writeFileSync(join(dir, 'metrics-2026-05.jsonl'), `${row('2026-05-20T10:00:00.000Z', 'current')}\n`);
    writeFileSync(join(dir, 'metrics-2026-05.jsonl.1747000000000'), `${row('2026-05-10T10:00:00.000Z', 'archived')}\n`);
    const store = new MetricsStore({ dir, audit: null, budgetStore: null });
    const rows = store.query({ from: '2026-05-01T00:00:00.000Z', to: '2026-05-31T23:59:59.999Z' });
    const ids = rows.map((r) => r.roomId).sort();
    expect(ids).toContain('current');
    expect(ids).toContain('archived');
  });
});
