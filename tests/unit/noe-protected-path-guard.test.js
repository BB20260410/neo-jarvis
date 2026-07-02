// @ts-check
// 验证 src/runtime/_protectedPathGuard.js 的 commandDeletesProtectedPath —— 从 NoeFreedomAdapters
// 与 NoeFreedomExecutor 抽取的「删保护路径」安全闸【单一来源】。断言值经抽取后实测、与抽取前两处
// 内联实现逐字一致（去重不改行为）。覆盖正向命中 + 反向 probe（不该拦的不拦、非法输入不抛）。
// 两条消费路径(marketplace 校验 / developer hard veto)的端到端覆盖另见
// noe-freedom-adapters.test.js 与 noe-audit-p1-permission-freedom.test.js。
import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { commandDeletesProtectedPath } from '../../src/runtime/_protectedPathGuard.js';

const HOME = homedir();

describe('commandDeletesProtectedPath 正向：删受保护路径被识别（返回命中的路径）', () => {
  it('系统目录', () => {
    expect(commandDeletesProtectedPath('rm -rf /etc')).toBe('/etc');
    expect(commandDeletesProtectedPath('sudo rm -rf /')).toBe('/');
    expect(commandDeletesProtectedPath('rm -rf /usr/local')).toBe('/usr');
    expect(commandDeletesProtectedPath('rm -rf /Applications/Codex.app')).toBe('/Applications/Codex.app');
  });

  it('运行时目录：~ 与 $HOME 字面量都展开后命中（防手滑误删 token/配置）', () => {
    expect(commandDeletesProtectedPath('rm -rf ~/.noe-panel')).toBe(`${HOME}/.noe-panel`);
    expect(commandDeletesProtectedPath('rm -rf $HOME/.codex')).toBe(`${HOME}/.codex`);
    expect(commandDeletesProtectedPath('rm -rf ~/.agents')).toBe(`${HOME}/.agents`);
  });

  it('破坏性动词变体 rmdir/unlink/trash 都识别', () => {
    expect(commandDeletesProtectedPath('rmdir /etc')).toBe('/etc');
    expect(commandDeletesProtectedPath('unlink /var')).toBe('/var');
    expect(commandDeletesProtectedPath('trash /Library')).toBe('/Library');
  });

  it('命令链 / 引号包裹仍能识别', () => {
    expect(commandDeletesProtectedPath('cd /tmp && rm -rf /etc')).toBe('/etc');
    expect(commandDeletesProtectedPath("rm -rf '/etc'")).toBe('/etc');
  });
});

describe('commandDeletesProtectedPath 反向 probe：不该拦的不拦、非法输入不抛', () => {
  it('非破坏性动词不拦（读类命令放行）', () => {
    expect(commandDeletesProtectedPath('ls /etc')).toBe('');
    expect(commandDeletesProtectedPath('cat /etc/hosts')).toBe('');
    expect(commandDeletesProtectedPath('find / -name x')).toBe('');
  });

  it('破坏性动词但目标非保护路径不拦（不误伤正常清理）', () => {
    expect(commandDeletesProtectedPath('rm -rf ~/Downloads/tmp')).toBe('');
    expect(commandDeletesProtectedPath('rm -rf /tmp/build')).toBe('');
  });

  it('空 / 缺省 / 非字符串入参返回空串且不抛错', () => {
    expect(commandDeletesProtectedPath('')).toBe('');
    expect(commandDeletesProtectedPath()).toBe('');
    expect(commandDeletesProtectedPath(/** @type {any} */ (null))).toBe('');
    expect(commandDeletesProtectedPath(/** @type {any} */ (123))).toBe('');
    expect(() => commandDeletesProtectedPath(/** @type {any} */ (123))).not.toThrow();
  });
});
