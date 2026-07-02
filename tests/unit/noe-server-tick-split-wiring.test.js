// @ts-check
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(join(process.cwd(), 'server.js'), 'utf8');

describe('server.js cognitive tick split wiring', () => {
  it('splits workspace meso tick from inner monologue enablement', () => {
    expect(src).toContain("const innerMonologueEnabled = process.env.NOE_INNER_MONOLOGUE === '1';");
    expect(src).toContain("const workspaceEnabled = process.env.NOE_WORKSPACE === '1';");
    expect(src).toContain('if (innerMonologueEnabled || workspaceEnabled) {');
    expect(src).toContain('if (workspaceEnabled) {');
    expect(src).toContain('if (innerMonologueEnabled) {');
    expect(src).toContain('if (innerReflect) runInnerReflectTick = () => {');
    expect(src).not.toContain('工作区挂在反刍 tick 上');
  });

  it('keeps meso, innerReflect, and maintenance as separate heartbeat jobs', () => {
    expect(src).toContain("noeHeartbeat.register('meso'");
    expect(src).toContain("noeHeartbeat.register('innerReflect'");
    expect(src).toContain("noeHeartbeat.register('maintenance'");
    expect(src.indexOf("noeHeartbeat.register('meso'")).toBeLessThan(src.indexOf("noeHeartbeat.register('innerReflect'"));
    expect(src.indexOf("noeHeartbeat.register('innerReflect'")).toBeLessThan(src.indexOf("noeHeartbeat.register('maintenance'"));
  });
});
