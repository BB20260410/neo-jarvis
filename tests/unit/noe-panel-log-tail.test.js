import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectNoePanelLogTail,
  compactPanelLogTail,
  redactPanelLogLine,
} from '../../src/runtime/NoePanelLogTail.js';

const roots = [];

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'noe-panel-log-tail-'));
  roots.push(root);
  return root;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('NoePanelLogTail', () => {
  it('returns missing status for absent logs without side effects', () => {
    const file = join(tempRoot(), 'missing.log');
    const report = collectNoePanelLogTail({ file, now: new Date('2026-06-13T00:00:00Z') });
    expect(report).toMatchObject({
      ok: true,
      status: 'missing',
      cursor: 0,
      size: 0,
      lines: [],
      policy: {
        readOnly: true,
        bounded: true,
        redacted: true,
        secretValuesReturned: false,
        actionsPerformed: false,
      },
    });
  });

  it('reads a bounded tail and redacts secret-shaped values before returning lines', () => {
    const file = join(tempRoot(), 'panel.log');
    writeFileSync(file, [
      'line 1',
      'authorization=secret-token-value',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
      'url http://127.0.0.1:51835/?t=0123456789abcdef0123456789abcdef',
      'openai sk-abcdefghijklmnopqrstuvwxyz123456',
      'jwt aaa.bbb.cccccccccccccccccccc',
      'done',
    ].join('\n'));

    const report = collectNoePanelLogTail({ file, limit: 4, maxBytes: 4096 });
    expect(report.ok).toBe(true);
    expect(report.lineCount).toBe(4);
    expect(report.truncated).toBe(true);
    expect(report.lines.join('\n')).not.toContain('secret-token-value');
    expect(report.lines.join('\n')).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(report.lines.join('\n')).not.toContain('0123456789abcdef0123456789abcdef');
    expect(report.lines).toEqual([
      'url http://127.0.0.1:51835/?t=[redacted]',
      'openai [redacted-openai-key]',
      'jwt [redacted-jwt]',
      'done',
    ]);
  });

  it('uses cursor and reports reset when the cursor is stale or past the file', () => {
    const file = join(tempRoot(), 'panel.log');
    writeFileSync(file, ['a', 'b', 'c', 'd', 'e'].join('\n'));

    const first = collectNoePanelLogTail({ file, cursor: 0, limit: 10, maxBytes: 1 });
    expect(first.reset).toBe(true);
    expect(first.truncated).toBe(true);
    expect(first.lines).toEqual(['e']);

    const second = collectNoePanelLogTail({ file, cursor: 999, limit: 10, maxBytes: 100 });
    expect(second.reset).toBe(true);
    expect(second.cursor).toBe(first.size);
    expect(second.lines).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('keeps UTF-8 characters valid when byte bounding cuts near multibyte text', () => {
    const file = join(tempRoot(), 'panel.log');
    writeFileSync(file, `启动\n${'前缀'.repeat(80)}\n尾部月球🌕\n`);
    const report = collectNoePanelLogTail({ file, limit: 10, maxBytes: 32 });
    expect(report.ok).toBe(true);
    expect(report.lines.at(-1)).toBe('尾部月球🌕');
    expect(JSON.stringify(report)).not.toContain('\uFFFD');
  });

  it('compacts reports without changing safety flags', () => {
    const file = join(tempRoot(), 'panel.log');
    writeFileSync(file, 'ok\n');
    const compact = compactPanelLogTail(collectNoePanelLogTail({ file }));
    expect(compact).toMatchObject({
      ok: true,
      status: 'ok',
      lineCount: 1,
      secretValuesReturned: false,
      actionsPerformed: false,
    });
  });

  it('redacts generic token and owner-token forms in a single line', () => {
    const line = redactPanelLogLine('X-Panel-Owner-Token: 0123456789abcdef0123456789abcdef cookie=session-token-value');
    expect(line).not.toContain('0123456789abcdef0123456789abcdef');
    expect(line).not.toContain('session-token-value');
    expect(line).toContain('[redacted]');
  });
});
