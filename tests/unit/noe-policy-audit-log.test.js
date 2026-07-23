import { describe, expect, it } from 'vitest';
import { createPolicyAuditLog, redactSecret } from '../../src/audit/PolicyAuditLog.js';

// 内存 writer，绝不碰真实文件系统。
function makeLog(startTs = 1000) {
  const lines = [];
  let clock = startTs;
  const log = createPolicyAuditLog({
    writer: (line) => lines.push(line),
    now: () => clock,
    path: '/virtual/audit.log',
  });
  return { log, lines, advance: (ms) => { clock += ms; } };
}

describe('redactSecret', () => {
  it('抹掉明显的 key/token，保留路径与命令', () => {
    expect(redactSecret('run with sk-ABCDEFGHIJKLMNOP token')).toContain('[key]');
    expect(redactSecret('Bearer abcdef123456')).toBe('Bearer [key]');
    expect(redactSecret('api_key=supersecretvalue')).toContain('[redacted]');
    // 路径/命令保留
    expect(redactSecret('git status in /Users/x/proj')).toBe('git status in /Users/x/proj');
  });
});

describe('createPolicyAuditLog', () => {
  it('append 写一行 JSON，含时间戳与决策字段', () => {
    const { log, lines } = makeLog(5000);
    const rec = log.append({ action: 'shell.exec', decision: 'allow', capability: 'proc.exec', target: { cmd: 'npm test' }, reason: 'dev trust', source: 'policy', trustLevel: 'developer' });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ts).toBe(5000);
    expect(parsed.action).toBe('shell.exec');
    expect(parsed.decision).toBe('allow');
    expect(parsed.capability).toBe('proc.exec');
    expect(parsed.trustLevel).toBe('developer');
    expect(parsed.target).toContain('npm test');
    expect(rec.decision).toBe('allow');
  });

  it('每次 append 只追加一行（append-only 语义）', () => {
    const { log, lines } = makeLog();
    log.append({ action: 'a', decision: 'allow' });
    log.append({ action: 'b', decision: 'deny' });
    log.append({ action: 'c', decision: 'ask' });
    expect(lines).toHaveLength(3);
    expect(lines.every((l) => l.endsWith('\n'))).toBe(true);
    expect(JSON.parse(lines[1]).decision).toBe('deny');
  });

  it('target 里的密钥被脱敏', () => {
    const { log, lines } = makeLog();
    log.append({ action: 'net.outbound', decision: 'deny', target: { url: 'https://x.com', header: 'Bearer sk-LEAKEDKEY1234567' } });
    expect(lines[0]).not.toContain('LEAKEDKEY');
    expect(lines[0]).toContain('[key]');
  });

  it('recordSafe 在 writer 抛错时返回 null 不崩', () => {
    const log = createPolicyAuditLog({ writer: () => { throw new Error('disk full'); }, now: () => 1 });
    expect(log.recordSafe({ action: 'x', decision: 'allow' })).toBeNull();
  });

  it('默认路径在 ~/.noe/audit.log', () => {
    const log = createPolicyAuditLog({ writer: () => {} });
    expect(log.path).toMatch(/\.noe\/audit\.log$/);
  });
});
