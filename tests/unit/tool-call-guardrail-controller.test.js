import { describe, expect, it } from 'vitest';
import {
  ToolCallGuardrailController,
  classifyToolCall,
} from '../../src/safety/ToolCallGuardrailController.js';

describe('ToolCallGuardrailController', () => {
  it('classifies common mutating and readonly tool names', () => {
    expect(classifyToolCall('file.delete')).toBe('mutating');
    expect(classifyToolCall('doctor.lint')).toBe('idempotent');
    expect(classifyToolCall('custom.thing')).toBe('unknown');
  });

  it('warns on repeated exact failures by stable argument hash', () => {
    const guard = new ToolCallGuardrailController({ repeatedFailureThreshold: 3 });
    guard.record({ toolName: 'search.read', args: { q: 'x' }, ok: false, error: 'boom' });
    guard.record({ toolName: 'search.read', args: { q: 'x' }, ok: false, error: 'boom' });
    const out = guard.record({ toolName: 'search.read', args: { q: 'x' }, ok: false, error: 'boom' });

    expect(out.ok).toBe(true);
    expect(out.findings.map((item) => item.id)).toContain('repeated_exact_tool_failure');
  });

  it('can hard-stop mutating repeated failures when warnOnly is disabled', () => {
    const guard = new ToolCallGuardrailController({ repeatedFailureThreshold: 2, warnOnly: false });
    guard.record({ toolName: 'file.delete', args: { path: 'a' }, ok: false, error: 'denied' });
    const out = guard.record({ toolName: 'file.delete', args: { path: 'a' }, ok: false, error: 'denied' });

    expect(out.stop).toBe(true);
    expect(out.ok).toBe(false);
  });

  it('detects no-progress idempotent loops', () => {
    const guard = new ToolCallGuardrailController({ noProgressThreshold: 3 });
    guard.record({ toolName: 'status.read', args: { id: 1 }, ok: true, output: 'same' });
    guard.record({ toolName: 'status.read', args: { id: 1 }, ok: true, output: 'same' });
    const out = guard.record({ toolName: 'status.read', args: { id: 1 }, ok: true, output: 'same' });

    expect(out.findings.map((item) => item.id)).toContain('idempotent_no_progress_loop');
  });
});

