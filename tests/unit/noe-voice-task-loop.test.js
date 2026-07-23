// @ts-check
import { describe, expect, it, beforeEach } from 'vitest';
import {
  strictTranscriptMatch,
  classifyAsrResult,
  NoeVoiceTaskLoop,
  runVoiceTaskLoopSuite,
} from '../../src/runtime/NoeVoiceTaskLoop.js';
import {
  UnifiedTaskStore,
  resetUnifiedTaskStoreForTests,
} from '../../src/runtime/UnifiedTaskStore.js';

describe('strict transcript match', () => {
  it('rejects 打开面板 vs 打开面吧 (no loose homophone)', () => {
    expect(strictTranscriptMatch('打开面板', '打开面板')).toBe(true);
    expect(strictTranscriptMatch('打开面板', '打开面吧')).toBe(false);
    expect(strictTranscriptMatch('取消任务', '取消 任务')).toBe(true);
  });
});

describe('NoeVoiceTaskLoop product path', () => {
  beforeEach(() => {
    resetUnifiedTaskStoreForTests();
  });

  it('PTT creates UnifiedTask; text/voice share Task ID and receipt', () => {
    const store = new UnifiedTaskStore({ env: { NOE_UNIFIED_TASK_WRITE: '1' } });
    const loop = new NoeVoiceTaskLoop({
      taskStore: store,
      sourceDigest: 'sha256:voice-test',
    });
    const start = loop.startFromPtt({
      channel: 'voice',
      asr: { transcript: '查看任务状态', confidence: 0.91 },
      actionType: 'read_file',
    });
    expect(start.ok).toBe(true);
    expect(start.taskId).toBeTruthy();
    expect(start.receipt.taskId).toBe(start.taskId);
    const done = loop.complete(start.taskId, {
      verified: true,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
      exitCode: 0,
      expectedTranscript: '查看任务状态',
      actualTranscript: '查看任务状态',
      artifacts: [{ path: 'a.md', sha256: '1' }],
    });
    expect(done.ok).toBe(true);
    expect(done.taskId).toBe(start.taskId);
    expect(done.displayCompleted).toBe(true);
  });

  it('rejects ASR mismatch for 打开面板→打开面吧', () => {
    const store = new UnifiedTaskStore({ env: { NOE_UNIFIED_TASK_WRITE: '1' } });
    const loop = new NoeVoiceTaskLoop({ taskStore: store });
    const start = loop.startFromPtt({
      channel: 'voice',
      asr: { transcript: '打开面吧', confidence: 0.99, expectedIntent: '打开面板' },
    });
    expect(start.ok).toBe(false);
    expect(start.error).toBe('strict_transcript_mismatch');
  });

  it('ASR failure can switch to text without losing task creation', () => {
    const store = new UnifiedTaskStore({ env: { NOE_UNIFIED_TASK_WRITE: '1' } });
    const loop = new NoeVoiceTaskLoop({ taskStore: store });
    const fail = loop.startFromPtt({
      channel: 'voice',
      asr: { error: 'mic_denied' },
    });
    expect(fail.ok).toBe(false);
    expect(fail.canSwitchToText).toBe(true);
    const start = loop.startFromPtt({
      channel: 'voice',
      asr: { error: 'mic_denied' },
      textFallback: '文本接管任务',
    });
    expect(start.ok).toBe(true);
    expect(start.usedTextFallback).toBe(true);
    const corr = loop.correctTranscript(start.taskId, '文本接管任务已纠正');
    expect(corr.sameTaskId).toBe(true);
    expect(corr.taskId).toBe(start.taskId);
  });

  it('high-risk requires second confirm; cancel keeps same Task ID', () => {
    const store = new UnifiedTaskStore({ env: { NOE_UNIFIED_TASK_WRITE: '1' } });
    const loop = new NoeVoiceTaskLoop({ taskStore: store });
    const start = loop.startFromPtt({
      channel: 'voice',
      asr: { transcript: '删除重要文件', confidence: 0.95 },
      actionType: 'fs_delete',
    });
    expect(start.needsSecondConfirm).toBe(true);
    const premature = loop.complete(start.taskId, {
      verified: true,
      hasValidArtifacts: true,
      hasEvidence: true,
      validatorsPass: true,
      exitCode: 0,
    });
    expect(premature.ok).toBe(false);
    const approved = loop.approve(start.taskId);
    expect(approved.ok).toBe(true);
    expect(approved.taskId).toBe(start.taskId);
    const cancelled = loop.cancel(start.taskId);
    expect(cancelled.ok).toBe(true);
    expect(cancelled.taskId).toBe(start.taskId);
    expect(cancelled.status).toBe('cancelled');
  });

  it('interrupt and approve share same Task ID', () => {
    const store = new UnifiedTaskStore({ env: { NOE_UNIFIED_TASK_WRITE: '1' } });
    const loop = new NoeVoiceTaskLoop({ taskStore: store });
    const start = loop.startFromPtt({
      channel: 'voice',
      asr: { transcript: '长时间任务', confidence: 0.9 },
    });
    loop.approve(start.taskId);
    const inter = loop.interrupt(start.taskId);
    expect(inter.taskId).toBe(start.taskId);
    expect(inter.sameTaskId).toBe(true);
  });

  it('runVoiceTaskLoopSuite meets ≥0.9 with taskLoopClosed', () => {
    const store = new UnifiedTaskStore({ env: { NOE_UNIFIED_TASK_WRITE: '1' } });
    const suite = runVoiceTaskLoopSuite({
      taskStore: store,
      sourceDigest: 'sha256:voice-suite',
    });
    expect(suite.taskLoopClosed).toBe(true);
    expect(suite.strictMatching).toBe(true);
    expect(suite.voiceTaskSuccessRate).toBeGreaterThanOrEqual(0.9);
    expect(suite.ok).toBe(true);
    const strict = suite.results.find((r) => r.id === 'strict_no_homophone');
    expect(strict?.ok).toBe(true);
  });

  it('classifyAsrResult low confidence', () => {
    const r = classifyAsrResult({ transcript: '可能删除', confidence: 0.2 });
    expect(r.ok).toBe(false);
    expect(r.mode).toBe('low_confidence');
  });
});
