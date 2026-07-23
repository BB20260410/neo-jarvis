import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPersonalityDatasetReadiness, scanSftDir, summarizeIdentity, writeReport } from '../../scripts/noe-personality-dataset-readiness.mjs';

function pair(text) {
  return {
    messages: [
      { role: 'system', content: 's' },
      { role: 'user', content: 'u' },
      { role: 'assistant', content: text },
    ],
  };
}

describe('noe-personality-dataset-readiness', () => {
  it('counts valid, invalid, duplicate, and sensitive SFT pairs without exporting text', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-personality-sft-'));
    try {
      writeFileSync(join(dir, 'sft-2026-W24.jsonl'), [
        JSON.stringify(pair('主人深夜工作时我会安静陪着他')),
        JSON.stringify(pair('主人深夜工作时我会安静陪着他')),
        JSON.stringify(pair('api_key sk-abcdefghijklmnop')),
        '{bad json',
        '',
      ].join('\n'));
      const sft = scanSftDir({ sftDir: dir });
      expect(sft.validPairs).toBe(3);
      expect(sft.invalidPairs).toBe(1);
      expect(sft.sensitivePairs).toBe(1);
      expect(sft.duplicateAssistantPairs).toBe(1);
      expect(JSON.stringify(sft)).not.toContain('安静陪着');
      expect(JSON.stringify(sft)).not.toContain('abcdefghijklmnop');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('P0-① validPairs 只计 persona 通道，project 留档单列不算进人格 SFT 门槛', () => {
    const dir = mkdtempSync(join(tmpdir(), 'noe-personality-split-'));
    try {
      // persona 文件 2 行 + project 文件 1 行 + persona 文件里混入 1 行 split=project
      writeFileSync(join(dir, 'sft-2026-W24.jsonl'), [
        JSON.stringify(pair('主人深夜工作时我会安静陪着他')),
        JSON.stringify({ ...pair('这次提交把 bug 修了'), split: 'project' }), // 混入 → 归 project
      ].join('\n'));
      writeFileSync(join(dir, 'sft-project-2026-W24.jsonl'), [
        JSON.stringify(pair('重构 server.js 跑通全部测试')),
      ].join('\n'));
      const sft = scanSftDir({ sftDir: dir });
      // 人格 SFT 口径只算 persona 文件里真正的 persona 行（1 条）
      expect(sft.validPairs).toBe(1);
      expect(sft.personaValidPairs).toBe(1);
      // project：project 文件 1 行 + persona 文件里混入的 1 行 = 2
      expect(sft.projectValidPairs).toBe(2);
      // 不泄漏正文
      expect(JSON.stringify(sft)).not.toContain('安静陪着');
      expect(JSON.stringify(sft)).not.toContain('server.js');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps formal training blocked when pairs are below 500 or owner approval is absent', () => {
    const report = buildPersonalityDatasetReadiness({
      sft: {
        exists: true,
        dir: '/tmp/sft',
        fileCount: 1,
        totalLines: 100,
        validPairs: 100,
        invalidPairs: 0,
        sensitivePairs: 0,
        uniqueAssistantPairs: 100,
        duplicateAssistantPairs: 0,
        avgAssistantChars: 30,
        byFile: [],
      },
      identity: {
        ownerIdentity: { exists: true, voice: { ready: true }, face: { ready: true } },
        peopleKnowledge: { exists: true, people: 2 },
        personalitySnapshot: { exists: true, chars: 30 },
        narrativeSelf: { exists: true, chars: 30 },
      },
      liveDb: { exists: true, memory: { insight: 7, highSalience: 20 }, events: { activeDays: 3 } },
      gate: { exists: false, pass: false },
      minPairs: 500,
      smokeMinPairs: 20,
      trainScriptExists: true,
      gateScriptExists: true,
      loraVenvExists: true,
      ownerApproved: false,
    });
    expect(report.status.smokeDatasetReady).toBe(true);
    expect(report.status.formalDatasetReady).toBe(false);
    expect(report.status.readyForFormalTraining).toBe(false);
    expect(report.status.blockers).toContain('not_enough_sft_pairs_for_formal_training');
    expect(report.status.blockers).toContain('owner_training_plan_required');
  });

  it('summarizes identity JSON as counts only and writes reports', () => {
    const root = mkdtempSync(join(tmpdir(), 'noe-personality-ready-'));
    try {
      const ownerFile = join(root, 'owner.json');
      const peopleFile = join(root, 'people.json');
      const personalityFile = join(root, 'personality.json');
      const narrativeFile = join(root, 'narrative.json');
      writeFileSync(ownerFile, JSON.stringify({
        voice: { enabled: true, ownerPersonId: 'owner', samples: [{ embedding: [1] }, { embedding: [2] }, { embedding: [3] }] },
        face: { enabled: true, ownerPersonId: 'owner', samples: [{ embedding: [1] }] },
      }));
      writeFileSync(peopleFile, JSON.stringify({ people: [
        { displayName: 'A', faceSamples: [{}], voiceSamples: [{}, {}, {}] },
      ] }));
      writeFileSync(personalityFile, JSON.stringify({ personality: '我想得多，说话会克制。', atMs: Date.now() }));
      writeFileSync(narrativeFile, JSON.stringify({ narrative: '我和主人一起把我自己造出来。', atMs: Date.now() }));
      const identity = summarizeIdentity({ ownerFile, peopleFile, personalityFile, narrativeFile, now: Date.now() });
      expect(identity.ownerIdentity.voice.ready).toBe(true);
      expect(identity.peopleKnowledge.people).toBe(1);
      expect(JSON.stringify(identity)).not.toContain('displayName');
      const paths = writeReport(buildPersonalityDatasetReadiness({
        sft: {
          exists: true,
          dir: '/tmp/sft',
          fileCount: 1,
          totalLines: 500,
          validPairs: 500,
          invalidPairs: 0,
          sensitivePairs: 0,
          uniqueAssistantPairs: 500,
          duplicateAssistantPairs: 0,
          avgAssistantChars: 40,
          byFile: [],
        },
        identity,
        liveDb: { exists: true, memory: {}, events: { activeDays: 7 } },
        gate: { exists: true, pass: true, adapterPresent: true },
        minPairs: 500,
        smokeMinPairs: 20,
        trainScriptExists: true,
        gateScriptExists: true,
        loraVenvExists: true,
        ownerApproved: true,
      }), { outDir: join(root, 'out') });
      expect(paths.reportPath).toMatch(/output\/noe-personality-dataset-readiness|personality-dataset-readiness/);
      const saved = JSON.parse(readFileSync(join(root, 'out', 'latest.json'), 'utf8'));
      expect(saved.status.readyForAdoption).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
