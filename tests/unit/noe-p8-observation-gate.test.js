// @ts-check
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildP8ObservationGateReport,
  runP8ObservationGate,
} from '../../scripts/noe-p8-observation-gate.mjs';

const tempRoots = [];
const T0 = Date.parse('2026-06-13T00:45:39.145Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'noe-p8-observation-gate-'));
  tempRoots.push(dir);
  return dir;
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function eventLine(type, at = T0) {
  return JSON.stringify({ type, at: new Date(at).toISOString() });
}

function writeLongSoakMission(root, {
  missionId = 'p8-long-soak-real-test',
  status = 'succeeded',
  phase = 'complete',
  updatedAt = T0,
  checkpointCount = 28,
  summaryCount = 7,
  heartbeatCount = 421,
  coverageOk = true,
  finalReportOk = true,
  requiredCount = 31,
  writeEvidenceFiles = true,
  declareReadable = true,
  emitSucceededEvent = true,
  succeededAt = updatedAt,
} = {}) {
  const dir = join(root, missionId);
  const artifacts = join(dir, 'artifacts');
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(join(dir, 'checkpoints'), { recursive: true });
  writeJson(join(dir, 'mission.json'), {
    schemaVersion: 1,
    missionId,
    metadata: {
      kind: 'p8_long_soak',
      durationMs: 7 * 60 * 60 * 1000,
      checkpointCount,
      summaryEveryMs: 60 * 60 * 1000,
    },
    completionCriteria: [
      { id: 'soak-duration-reached', type: 'mission_elapsed_at_least_ms', minElapsedMs: 7 * 60 * 60 * 1000 },
    ],
  });
  writeJson(join(dir, 'state.json'), {
    schemaVersion: 1,
    missionId,
    status,
    phase,
    current_cursor: 32,
    current_slice: 32,
    recovery_attempts: 6,
    blockers: [],
    createdAt: new Date(updatedAt - 7 * 60 * 60 * 1000).toISOString(),
    updatedAt: new Date(updatedAt).toISOString(),
  });
  const events = [
    ...Array.from({ length: heartbeatCount }, () => eventLine('mission.heartbeat')),
    ...Array.from({ length: checkpointCount + 4 }, () => eventLine('mission.checkpoint.written')),
    ...Array.from({ length: summaryCount }, () => eventLine('mission.run_summary.written')),
    ...(emitSucceededEvent ? [eventLine('mission.succeeded', succeededAt)] : []),
  ];
  writeFileSync(join(dir, 'events.jsonl'), `${events.join('\n')}\n`);
  for (let i = 1; i <= checkpointCount; i += 1) {
    writeJson(join(artifacts, `soak-checkpoint-${String(i).padStart(4, '0')}.json`), { ok: true, checkpointIndex: i });
  }
  for (let i = 1; i <= summaryCount; i += 1) {
    writeJson(join(artifacts, `run-summary-${String(i * 4).padStart(6, '0')}.json`), { ok: true, summaryIndex: i });
  }
  const requiredEvidence = Array.from({ length: requiredCount }, (_, index) => {
    const fileName = `evidence-${index}.json`;
    if (writeEvidenceFiles) writeJson(join(artifacts, fileName), { ok: true, evidenceIndex: index });
    return {
      ref: `output/noe-missions/${missionId}/artifacts/${fileName}`,
      readable: declareReadable,
      inFinalReport: true,
    };
  });
  writeJson(join(artifacts, 'coverage-table.json'), { ok: coverageOk, requiredEvidence });
  writeJson(join(artifacts, 'final-report.json'), {
    ok: finalReportOk,
    requiredEvidenceRefs: requiredEvidence.map((item) => item.ref),
  });
  writeJson(join(artifacts, 'finalization-000032.json'), { ok: true });
  return dir;
}

afterEach(() => {
  while (tempRoots.length) rmSync(tempRoots.pop(), { recursive: true, force: true });
});

describe('noe-p8-observation-gate', () => {
  it('keeps the next-stage gate closed when the P8 baseline is valid but the 7 day window has not elapsed', () => {
    const root = tempDir();
    writeLongSoakMission(root, { updatedAt: T0 });

    const report = buildP8ObservationGateReport({
      missionRoot: root,
      nowMs: T0 + 2 * DAY_MS,
      minObservationDays: 7,
    });

    expect(report.ok).toBe(true);
    expect(report.baseline?.qualifiesLongSoak).toBe(true);
    expect(report.gate.readyForNextStage).toBe(false);
    expect(report.gate.blockers).toContain('observation_window_not_elapsed');
    expect(report.gate.recommendation).toBe('continue_observation_do_not_start_p9_or_research_bridge');
  });

  it('opens the gate after the observation window elapses and no unsettled long soak remains', () => {
    const root = tempDir();
    writeLongSoakMission(root, { updatedAt: T0 });

    const report = buildP8ObservationGateReport({
      missionRoot: root,
      nowMs: T0 + 8 * DAY_MS,
      minObservationDays: 7,
    });

    expect(report.ok).toBe(true);
    expect(report.gate.readyForNextStage).toBe(true);
    expect(report.gate.blockers).toEqual([]);
    expect(report.nextAllowedWork).toContain('P7-J0-lite mission-runtime integration review');
  });

  it('blocks when no qualified P8 long soak baseline exists', () => {
    const root = tempDir();
    writeLongSoakMission(root, { status: 'blocked', phase: 'blocked', finalReportOk: false });

    const report = buildP8ObservationGateReport({ missionRoot: root, nowMs: T0 + 8 * DAY_MS });

    expect(report.ok).toBe(false);
    expect(report.baseline).toBe(null);
    expect(report.gate.readyForNextStage).toBe(false);
    expect(report.gate.blockers).toContain('qualified_p8_long_soak_missing');
  });

  it('writes timestamped and latest reports without touching live state', () => {
    const root = tempDir();
    const out = join(root, 'out');
    writeLongSoakMission(root, { updatedAt: T0 });

    const { report, written } = runP8ObservationGate({
      missionRoot: root,
      outDir: out,
      nowMs: T0 + 2 * DAY_MS,
    });

    expect(report.policy.noLivePortsTouched).toBe(true);
    expect(written?.file).toMatch(/report\.json$/);
    expect(written?.latest).toMatch(/latest\.json$/);
  });

  // ── B1.2 防伪造：gate 不能只信 coverage-table / state 的自我声明，必须核验真实证据 ──
  it('blocks a baseline that declares evidence refs whose files do not exist (anti-fabrication)', () => {
    const root = tempDir();
    // coverage-table 声明 31 个 evidence ref 且 readable:true，但实际不写文件——纯声明伪造覆盖。
    writeLongSoakMission(root, { updatedAt: T0, writeEvidenceFiles: false });

    const report = buildP8ObservationGateReport({
      missionRoot: root,
      nowMs: T0 + 8 * DAY_MS,
      minObservationDays: 7,
    });

    // 旧实现只数 item.readable 声明 → 误判 qualifiesLongSoak=true 并开门；
    // 修复后必须核验每个 ref 指向的文件真实存在可读，否则不合格。
    expect(report.baseline?.qualifiesLongSoak ?? false).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('blocks a baseline that claims succeeded status but emits no mission.succeeded event', () => {
    const root = tempDir();
    // state.status='succeeded' 但事件流里没有 mission.succeeded——状态字段与真实事件流不一致。
    writeLongSoakMission(root, { updatedAt: T0, emitSucceededEvent: false });

    const report = buildP8ObservationGateReport({
      missionRoot: root,
      nowMs: T0 + 8 * DAY_MS,
      minObservationDays: 7,
    });

    expect(report.baseline?.qualifiesLongSoak ?? false).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('anchors the observation window to the real succeeded-event time, not a writable early updatedAt', () => {
    const root = tempDir();
    // 攻击场景：把 state.updatedAt 写得很早（想让观察窗口提前满 7 天放行），
    // 但真实 mission.succeeded 事件时间是较晚的 T0。窗口锚点必须取较晚的真实完成时间，不被提前。
    writeLongSoakMission(root, {
      updatedAt: T0 - 10 * DAY_MS,
      succeededAt: T0,
    });

    const report = buildP8ObservationGateReport({
      missionRoot: root,
      nowMs: T0 + 2 * DAY_MS,
      minObservationDays: 7,
    });

    // baseline 本身合格，但从真实完成时间 T0 起算只观察了 2 天 < 7 → 必须仍关门。
    expect(report.baseline?.qualifiesLongSoak).toBe(true);
    expect(report.gate.readyForNextStage).toBe(false);
    expect(report.gate.blockers).toContain('observation_window_not_elapsed');
  });

  // ── codex/workflow 对抗审查复现的两个高危绕过（返工补防） ──
  it('blocks evidence refs that are symlinks escaping the mission artifacts dir (anti-borrow/replay)', () => {
    const root = tempDir();
    const dir = writeLongSoakMission(root, { updatedAt: T0 });
    // 攻击：把 artifacts 里每个真实 evidence 换成指向 mission 外文件的软链接——
    // 本 mission 零真实证据，却想借 statSync 跟随软链接判「文件存在」蒙混过门（含跨 mission 借用/replay）。
    const outside = join(root, 'OUTSIDE-real.json');
    writeJson(outside, { ok: true, donor: true });
    const artifacts = join(dir, 'artifacts');
    for (let i = 0; i < 31; i += 1) {
      const f = join(artifacts, `evidence-${i}.json`);
      rmSync(f, { force: true });
      symlinkSync(outside, f);
    }

    const report = buildP8ObservationGateReport({ missionRoot: root, nowMs: T0 + 8 * DAY_MS, minObservationDays: 7 });

    // 软链接 realpath 逃出本 mission artifacts → 不算本 mission 的真实证据。
    expect(report.baseline?.qualifiesLongSoak ?? false).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('blocks evidence refs that are hard links borrowing a file outside the mission (anti-borrow)', () => {
    const root = tempDir();
    const dir = writeLongSoakMission(root, { updatedAt: T0 });
    // 硬链接变体：把 mission 外文件硬链进 artifacts——realpath 返回自身路径(在 artifacts 内)绕过逃逸检查，
    // 但 nlink>1 暴露"这文件其实是借来的别处 inode"。本 mission 并未真正产出该证据。
    const outside = join(root, 'OUTSIDE-real.json');
    writeJson(outside, { ok: true, donor: true });
    const artifacts = join(dir, 'artifacts');
    for (let i = 0; i < 31; i += 1) {
      const f = join(artifacts, `evidence-${i}.json`);
      rmSync(f, { force: true });
      linkSync(outside, f);
    }

    const report = buildP8ObservationGateReport({ missionRoot: root, nowMs: T0 + 8 * DAY_MS, minObservationDays: 7 });

    expect(report.baseline?.qualifiesLongSoak ?? false).toBe(false);
    expect(report.ok).toBe(false);
  });

  it('blocks a succeeded event with no parseable timestamp (must not fall back to a writable updatedAt anchor)', () => {
    const root = tempDir();
    const dir = writeLongSoakMission(root, { updatedAt: T0 - 10 * DAY_MS });
    // 攻击：唯一的 mission.succeeded 事件不带 at（latestEventTimeMs 取不到时间），
    // 想让窗口锚点退回被写早 10 天的 updatedAt 提前开门——比带合法 at 更省力。
    writeFileSync(join(dir, 'events.jsonl'), `${JSON.stringify({ type: 'mission.succeeded' })}\n`);

    const report = buildP8ObservationGateReport({ missionRoot: root, nowMs: T0 + 2 * DAY_MS, minObservationDays: 7 });

    // succeeded 事件无可解析时间戳 → 不合格（绝不拿可写的 updatedAt 当锚点提前开门）。
    expect(report.baseline?.qualifiesLongSoak ?? false).toBe(false);
  });
});
