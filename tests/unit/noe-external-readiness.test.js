import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildExternalReadinessReport,
  delegateConfirmEvidence,
  fileEvidence,
  jsonEvidence,
  mediaEvidence,
  parseArgs,
  redact,
} from '../../scripts/noe-external-readiness.mjs';

function tempEvidence(value) {
  const dir = mkdtempSync(join(tmpdir(), 'noe-external-ready-'));
  const file = join(dir, 'evidence.json');
  writeFileSync(file, JSON.stringify(value, null, 2));
  return { dir, file };
}

function tempFigure() {
  const dir = mkdtempSync(join(tmpdir(), 'noe-figure-one-'));
  const file = join(dir, 'figure-one.png');
  writeFileSync(file, 'png placeholder');
  return { dir, file };
}

describe('Noe external readiness verifier', () => {
  it('marks every external item as blocked when evidence is missing', () => {
    const report = buildExternalReadinessReport({
      obsidianReport: {
        ok: false,
        mode: 'read_only',
        nextActions: ['Open Obsidian.'],
      },
      checkedAt: '2026-06-05T00:00:00.000Z',
    });

    expect(report.ok).toBe(false);
    expect(report.externalBlocked).toEqual([
      'obsidian_mcp_ready',
      'real_voice_e2e_verified',
      'safe_delegate_confirm_verified',
      'real_delegate_start_verified',
      'figure_one_available',
    ]);
    expect(report.nextActions).toEqual(expect.arrayContaining([
      'Open Obsidian.',
      'Put “图一” at output/noe-external-evidence/figure-one.png or pass --figure-one <path>. Allowed: png/jpg/jpeg/webp/gif/pdf/heic.',
    ]));
  });

  it('passes when Obsidian and all explicit evidence files are present', () => {
    const voice = tempEvidence({ ok: true, kind: 'real_voice_e2e', transcript: '查最新 AI 新闻', reply: '已完成搜索' });
    const safeDelegate = tempEvidence({ ok: true, kind: 'delegate_confirm_idle', roomId: 'room-1', roomStatus: 'idle', started: false, queued: false });
    const delegate = tempEvidence({ ok: true, kind: 'real_delegate_start', roomId: 'room-1', startedAt: '2026-06-05T00:00:00.000Z' });
    const figure = tempFigure();
    try {
      const report = buildExternalReadinessReport({
        obsidianReport: { ok: true, mode: 'read_only', recommendedPath: { primary: 'built-in MCP' } },
        voiceEvidence: voice.file,
        safeDelegateEvidence: safeDelegate.file,
        delegateEvidence: delegate.file,
        figurePath: figure.file,
        checkedAt: '2026-06-05T00:00:00.000Z',
      });

      expect(report.ok).toBe(true);
      expect(report.externalBlocked).toEqual([]);
      expect(report.checks.every((c) => c.status === 'passed')).toBe(true);
    } finally {
      rmSync(voice.dir, { recursive: true, force: true });
      rmSync(safeDelegate.dir, { recursive: true, force: true });
      rmSync(delegate.dir, { recursive: true, force: true });
      rmSync(figure.dir, { recursive: true, force: true });
    }
  });

  it('rejects weak evidence files that do not prove the real action', () => {
    const weakVoice = tempEvidence({ ok: true, kind: 'real_voice_e2e' });
    const weakDelegate = tempEvidence({ ok: true, kind: 'real_delegate_start', roomId: 'room-1' });
    try {
      expect(jsonEvidence(weakVoice.file, 'real_voice_e2e', { requiredFields: ['transcript', 'reply'] })).toMatchObject({
        valid: false,
        missingFields: ['transcript', 'reply'],
      });
      expect(jsonEvidence(weakDelegate.file, 'real_delegate_start', {
        requiredAny: [['roomId', 'jobId', 'runId'], ['startedAt', 'started']],
      })).toMatchObject({
        valid: false,
        missingAny: [['startedAt', 'started']],
      });
      expect(mediaEvidence(weakDelegate.file)).toMatchObject({ valid: false, extension: '.json' });
      expect(delegateConfirmEvidence(weakDelegate.file)).toMatchObject({ valid: false, hasRoomId: true, started: null });
    } finally {
      rmSync(weakVoice.dir, { recursive: true, force: true });
      rmSync(weakDelegate.dir, { recursive: true, force: true });
    }
  });

  it('keeps user-provided paths and arguments redacted and deterministic', () => {
    const input = `/tmp/report.json?t=${'1234567890abcdef'.repeat(2)}`;
    expect(redact(input)).toContain('?t=[redacted]');
    expect(fileEvidence(input)).toMatchObject({
      provided: true,
      path: '/tmp/report.json?t=[redacted]',
      exists: false,
    });
    expect(parseArgs(['--figure-one', '/a.png', '--voice-evidence=/v.json', '--delegate-evidence', '/d.json'], {})).toMatchObject({
      figurePath: '/a.png',
      voiceEvidence: '/v.json',
      delegateEvidence: '/d.json',
    });
  });
});
