// @ts-check
// 第三波手术 第28批 结构级防回归：server.js 二轮拆分热身矿①
// collectPanelRuntimeProcesses（61 行纯函数：ps 后代进程树扫描 + claude/codex/gemini-cli 识别）
// 迁出 src/server/services/panel-runtime-processes.js，工厂注入 safeSlice（留守 server.js，3 处路由共用）。
// 注入点不变：registerRoomsRuntimeProcessesRoutes(app, { roomStore, collectPanelRuntimeProcesses })。
// 风格对齐 appjs-migration-batch23.test.js：源码文本断言，钉死接线不被静默破坏。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPanelRuntimeProcessCollector } from '../../src/server/services/panel-runtime-processes.js';

const read = (p) => readFileSync(join(process.cwd(), p), 'utf8');

const SERVER_FILE = 'server.js';
const MODULE_FILE = 'src/server/services/panel-runtime-processes.js';

describe('server.js 拆分第28批（collectPanelRuntimeProcesses 外迁）', () => {
  const serverSrc = read(SERVER_FILE);
  const moduleSrc = read(MODULE_FILE);

  it('新模块 <500 行（工程硬规则）+ @ts-check 头', () => {
    expect(moduleSrc.split('\n').length, `${MODULE_FILE} 行数超标`).toBeLessThan(500);
    expect(moduleSrc.startsWith('// @ts-check')).toBe(true);
  });

  it('server.js 不再持有实现，改为工厂 const + import', () => {
    expect(serverSrc).not.toContain('function collectPanelRuntimeProcesses()');
    expect(serverSrc).toContain("import { createPanelRuntimeProcessCollector } from './src/server/services/panel-runtime-processes.js';");
    expect(serverSrc).toContain('const collectPanelRuntimeProcesses = createPanelRuntimeProcessCollector({ safeSlice });');
  });

  it('注入点保持原样：runtime-processes 路由仍按名注入', () => {
    expect(serverSrc).toContain('registerRoomsRuntimeProcessesRoutes(app, { roomStore, collectPanelRuntimeProcesses });');
  });

  it('模块为注入式设计：spawnSync ps 自带、safeSlice 经参数注入且截断 480 不变', () => {
    expect(moduleSrc).toContain("import { spawnSync } from 'child_process';");
    expect(moduleSrc).toContain("spawnSync('ps', ['-axww', '-o', 'pid=,ppid=,stat=,etime=,command=']");
    expect(moduleSrc).toContain('export function createPanelRuntimeProcessCollector({ safeSlice })');
    expect(moduleSrc).toContain('commandPreview: safeSlice(row.command, 480),');
    // 不偷读全局：模块内无 server.js 闭包态
    expect(moduleSrc).not.toContain('_spawnSyncForBin');
  });

  it('行为契约：fullAccessSignals 五信号键 + adapter 识别规则一字不丢', () => {
    for (const key of ['clusterFullAccess', 'fullAuto', 'observeOnly', 'claudeSkipPermissions', 'codexBypassSandbox']) {
      expect(moduleSrc, `缺 fullAccessSignals.${key}`).toContain(`${key}: row.command.includes(`);
    }
    expect(moduleSrc).toContain("'claude --print'");
    expect(moduleSrc).toContain("'codex exec'");
    expect(moduleSrc).toContain("'gemini -p'");
  });

  it('真跑冒烟：工厂产出函数对本测试进程返回 ok（无 claude/codex 后代则 processes 为空数组）', () => {
    const collect = createPanelRuntimeProcessCollector({ safeSlice: (s, n) => String(s).slice(0, n) });
    const out = collect();
    expect(out.ok).toBe(true);
    expect(Array.isArray(out.processes)).toBe(true);
    for (const p of out.processes) {
      expect(['claude', 'codex', 'gemini-cli']).toContain(p.adapterId);
      expect(typeof p.pid).toBe('number');
    }
  });
});
