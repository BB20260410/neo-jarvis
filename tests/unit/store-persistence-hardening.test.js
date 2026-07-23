// @ts-check
// 强健工程：三个高危 Store（Mcp/Webhook/Knowledge）接入原子写 helper 后的防回归
// 锁三件事：①保存产生 .bak-latest 一代备份 ②损坏文件→自动 .corrupted 备份+空载不崩 ③不留 .tmp
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { McpStore } from '../../src/mcp/McpStore.js';
import { WebhookStore } from '../../src/webhook/WebhookStore.js';
import { KnowledgeStore } from '../../src/knowledge/KnowledgeStore.js';
import { NoeTaskFlowStore } from '../../src/runtime/NoeTaskFlowStore.js';
import { ArchiveStore } from '../../src/archive/ArchiveStore.js';

const dir = mkdtempSync(join(tmpdir(), 'noe-store-hardening-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('McpStore 持久化强健', () => {
  it('保存原子+留一代备份；重启读回', () => {
    const file = join(dir, 'mcp.json');
    const a = new McpStore({ file });
    a.create({ name: 'srv1', type: 'http', url: 'http://127.0.0.1:1/mcp' });
    a.create({ name: 'srv2', type: 'http', url: 'http://127.0.0.1:2/mcp' });
    expect(existsSync(file + '.tmp')).toBe(false);
    expect(existsSync(file + '.bak-latest')).toBe(true); // 第二次 create 备份了第一代
    const b = new McpStore({ file });
    expect(b.list().map((s) => s.name).sort()).toEqual(['srv1', 'srv2']);
  });

  it('损坏文件：空载不崩 + 自动 .corrupted 备份可恢复', () => {
    const file = join(dir, 'mcp-broken.json');
    writeFileSync(file, '{"version":1,"servers":[{"name":"半截', 'utf-8');
    const s = new McpStore({ file });
    expect(s.list()).toEqual([]);
    const baks = readdirSync(dir).filter((n) => n.startsWith('mcp-broken.json.corrupted-'));
    expect(baks.length).toBe(1);
  });
});

describe('WebhookStore 持久化强健', () => {
  it('保存原子+一代备份；重启读回', () => {
    const file = join(dir, 'wh.json');
    const a = new WebhookStore({ file });
    a.create({ name: 'w1', url: 'https://example.com/hook', format: 'json', events: ['room_done'] });
    a.create({ name: 'w2', url: 'https://example.com/hook2', format: 'json', events: ['room_done'] });
    expect(existsSync(file + '.tmp')).toBe(false);
    expect(existsSync(file + '.bak-latest')).toBe(true);
    const b = new WebhookStore({ file });
    expect(b.list().length).toBe(2);
  });

  it('损坏文件：空载不崩 + .corrupted 备份', () => {
    const file = join(dir, 'wh-broken.json');
    writeFileSync(file, '不是JSON', 'utf-8');
    const s = new WebhookStore({ file });
    expect(s.list()).toEqual([]);
    expect(readdirSync(dir).some((n) => n.startsWith('wh-broken.json.corrupted-'))).toBe(true);
  });
});

describe('NoeTaskFlowStore 持久化强健', () => {
  it('损坏 flow.json：load 返 null（不再抛 SyntaxError）+ .corrupted 备份；list 安全跳过', () => {
    const root = join(dir, 'taskflow-root');
    const s = new NoeTaskFlowStore({ root, baseDir: 'flows' });
    const flow = s.createFlow({ flowId: 'demo-flow', kind: 'demo', goal: '测试', steps: [{ id: 's1', title: '步骤一' }] });
    expect(s.load(flow.flowId)).toBeTruthy();

    const file = s.flowFile(flow.flowId);
    writeFileSync(file, '{ 半截', 'utf-8');
    expect(() => s.load(flow.flowId)).not.toThrow();
    expect(s.load(flow.flowId)).toBe(null);
    expect(() => s.list()).not.toThrow();
    const flowDir = join(root, 'flows', flow.flowId);
    expect(readdirSync(flowDir).some((n) => n.includes('.corrupted-'))).toBe(true);
  });

  it('write 原子：不留 .tmp，二次写留一代备份', () => {
    const root = join(dir, 'taskflow-root2');
    const s = new NoeTaskFlowStore({ root, baseDir: 'flows' });
    const flow = s.createFlow({ flowId: 'demo-flow-2', kind: 'demo', goal: '测试', steps: [{ id: 's1', title: '步骤一' }] });
    s.transition(flow.flowId, 's1', 'running');
    const file = s.flowFile(flow.flowId);
    expect(existsSync(file + '.tmp')).toBe(false);
    expect(existsSync(file + '.bak-latest')).toBe(true);
  });
});

describe('ArchiveStore 配置持久化强健', () => {
  it('损坏配置：回默认不崩 + .corrupted 备份；保存原子+一代备份', () => {
    const configFile = join(dir, 'archive-config.json');
    writeFileSync(configFile, '彻底坏了', 'utf-8');
    const s = new ArchiveStore({ configFile });
    expect(s.getConfig().rootPath).toBeTruthy(); // 回默认
    expect(readdirSync(dir).some((n) => n.startsWith('archive-config.json.corrupted-'))).toBe(true);

    s.updateConfig({ autoArchive: true });
    s.updateConfig({ autoArchive: false });
    expect(existsSync(configFile + '.tmp')).toBe(false);
    expect(existsSync(configFile + '.bak-latest')).toBe(true);
    const b = new ArchiveStore({ configFile });
    expect(b.getConfig().autoArchive).toBe(false);
  });
});

describe('KnowledgeStore index 持久化强健', () => {
  it('index.json 原子写+一代备份；损坏时备份后按"KB 不存在"安全降级', () => {
    const kbDir = join(dir, 'kb');
    mkdirSync(kbDir, { recursive: true });
    const s = new KnowledgeStore({ kbDir });
    s.create({ name: 'testkb', description: '测试库' });
    const indexFile = join(kbDir, 'testkb', 'index.json');
    expect(existsSync(indexFile)).toBe(true);
    expect(existsSync(indexFile + '.tmp')).toBe(false);
    expect(s.get('testkb')).toBeTruthy();

    // 注坏 index → get 返 null（与旧契约一致）但损坏文件已备份，证据不灭失
    writeFileSync(indexFile, '{ 坏掉了', 'utf-8');
    expect(s.get('testkb')).toBe(null);
    const baks = readdirSync(join(kbDir, 'testkb')).filter((n) => n.startsWith('index.json.corrupted-'));
    expect(baks.length).toBe(1);
    expect(readFileSync(join(kbDir, 'testkb', baks[0]), 'utf-8')).toBe('{ 坏掉了');
  });
});
