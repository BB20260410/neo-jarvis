import { describe, it, expect, vi } from 'vitest';
import { classifyCuaToolRisk, createNoeCuaDriver } from '../../src/capabilities/NoeCuaDriver.js';

describe('classifyCuaToolRisk', () => {
  it('只读工具 → 免 ack', () => {
    expect(classifyCuaToolRisk('get_screen_size')).toMatchObject({ tier: 'read', requiresAck: false });
    expect(classifyCuaToolRisk('get_window_state')).toMatchObject({ requiresAck: false });
  });
  it('list_apps/list_windows 是只读枚举(免 ack，实测修复)', () => {
    expect(classifyCuaToolRisk('list_apps')).toMatchObject({ tier: 'read', requiresAck: false });
    expect(classifyCuaToolRisk('list_windows')).toMatchObject({ requiresAck: false });
  });
  it('写类工具 → 需 ack', () => {
    expect(classifyCuaToolRisk('click')).toMatchObject({ tier: 'write', requiresAck: true });
    expect(classifyCuaToolRisk('type')).toMatchObject({ requiresAck: true });
  });
  it('红线5(点支付/登录)→ destructive highRisk', () => {
    expect(classifyCuaToolRisk('click', '支付按钮').highRisk).toBe(true);
    expect(classifyCuaToolRisk('type', 'submit password').highRisk).toBe(true);
  });
});

describe('createNoeCuaDriver.callTool', () => {
  function mk(spawnImpl) { return createNoeCuaDriver({ spawnFn: vi.fn(spawnImpl) }); }

  it('写类无 ack → gui_write_requires_ack（不执行）', async () => {
    const spawnFn = vi.fn();
    const cua = createNoeCuaDriver({ spawnFn });
    const r = await cua.callTool('click', { x: 1, y: 2 });
    expect(r).toMatchObject({ ok: false, reason: 'gui_write_requires_ack' });
    expect(spawnFn).not.toHaveBeenCalled(); // 未 ack 不真调
  });

  it('只读工具 → 真调 + 解析 JSON', async () => {
    const cua = mk(async () => ({ exitCode: 0, stdout: '{"width":1728,"height":1117}', stderr: '' }));
    const r = await cua.callTool('get_screen_size');
    expect(r).toMatchObject({ ok: true, tool: 'get_screen_size' });
    expect(r.value.width).toBe(1728);
  });

  it('写类 + ack → 执行', async () => {
    const cua = mk(async () => ({ exitCode: 0, stdout: '{"clicked":true}', stderr: '' }));
    const r = await cua.callTool('click', { x: 10, y: 20 }, { ackGuiAction: true });
    expect(r.ok).toBe(true);
    expect(r.value.clicked).toBe(true);
  });

  it('权限未授权(stderr 含 accessibility)→ permission_not_granted', async () => {
    const cua = mk(async () => ({ exitCode: 1, stdout: '', stderr: 'Error: Accessibility permission not granted' }));
    const r = await cua.callTool('click', { x: 1, y: 1 }, { ackGuiAction: true });
    expect(r).toMatchObject({ ok: false, reason: 'permission_not_granted' });
  });

  it('高危(红线5)即便 ack → requiresOwnerConfirm 标记', async () => {
    const cua = mk(async () => ({ exitCode: 0, stdout: '{"ok":true}', stderr: '' }));
    const r = await cua.callTool('click', { x: 1, y: 1 }, { ackGuiAction: true, actionText: '点击立即支付' });
    expect(r.ok).toBe(true);
    expect(r.requiresOwnerConfirm).toBe(true);
  });

  it('空 tool → tool_required', async () => {
    expect(await createNoeCuaDriver({ spawnFn: vi.fn() }).callTool('')).toMatchObject({ ok: false, reason: 'tool_required' });
  });

  it('checkPermissions 解析 status', async () => {
    const cua = mk(async () => ({ exitCode: 0, stdout: '{"status":"unknown","daemon_running":false}', stderr: '' }));
    expect(await cua.checkPermissions()).toMatchObject({ status: 'unknown' });
  });
});
