import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  askClaudeCollaborator,
  defaultClaudeCollaboratorState,
  extractClaudeEvidenceRead,
  readClaudeContextFiles,
  REQUIRED_CLAUDE_COLLABORATOR_MODE_LABEL,
  saveClaudeCollaboratorState,
} from '../../src/room/NoeClaudeCollaborator.js';

function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'noe-claude-collab-'));
}

function parsedState(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

describe('NoeClaudeCollaborator', () => {
  it('persists Claude session id, report refs, and resumes the next round', async () => {
    const root = makeRoot();
    const statePath = join(root, 'state', 'claude.json');
    const reportDir = join(root, 'output', 'noe-claude-collaborator');
    const calls = [];
    const runner = async (request) => {
      calls.push(request);
      return {
        stdout: JSON.stringify({
          result: `1. 结论\nClaude 已复核。\n5. memory_update: 继续记住第 ${calls.length} 轮 Neo 协作上下文`,
          session_id: 'sess-persistent-1',
          total_cost_usd: 0.01,
          modelUsage: { sonnet: { input_tokens: 10 } },
        }),
        stderr: '',
        code: 0,
      };
    };

    const first = await askClaudeCollaborator({
      task: '制定 Neo 协作开发计划',
      statePath,
      reportDir,
      rootDir: root,
      runner,
    });
    const second = await askClaudeCollaborator({
      task: '继续上一轮，审查当前方案',
      statePath,
      reportDir,
      rootDir: root,
      runner,
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.sessionId).toBe('sess-persistent-1');
    expect(calls[0].args).toContain('--model');
    expect(calls[0].args[calls[0].args.indexOf('--model') + 1]).toBe('claude-opus-4-8');
    expect(calls[0].args).toContain('--effort');
    expect(calls[0].args[calls[0].args.indexOf('--effort') + 1]).toBe('max');
    expect(calls[0].args).not.toContain('--resume');
    expect(calls[1].args).toContain('--resume');
    expect(calls[1].args[calls[1].args.indexOf('--resume') + 1]).toBe('sess-persistent-1');
    expect(existsSync(first.reportPath)).toBe(true);
    expect(existsSync(second.reportPath)).toBe(true);

    const state = parsedState(statePath);
    expect(state.name).toBe('Noe Claude Development Partner');
    expect(state.model).toBe('claude-opus-4-8');
    expect(state.effort).toBe('max');
    expect(state.requiredMode).toBe(REQUIRED_CLAUDE_COLLABORATOR_MODE_LABEL);
    expect(state.sessionId).toBe('sess-persistent-1');
    expect(state.memory).toHaveLength(2);
    expect(state.runs).toHaveLength(2);
    expect(state.memory[0].summary).toContain('继续记住第 1 轮');
  });

  it('refuses sensitive and outside-root context files', () => {
    const root = makeRoot();
    const outside = join(makeRoot(), 'outside.md');
    try {
      writeFileSync(join(root, '.env'), 'ANTHROPIC_API_KEY=secret');
      writeFileSync(join(root, 'room-adapters.json'), '{"apiKey":"secret"}');
      writeFileSync(outside, 'outside');

      expect(() => readClaudeContextFiles(['.env'], { rootDir: root })).toThrow(/refusing sensitive context file/);
      expect(() => readClaudeContextFiles(['room-adapters.json'], { rootDir: root })).toThrow(/refusing sensitive context file/);
      expect(() => readClaudeContextFiles([outside], { rootDir: root })).toThrow(/outside project root/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('dry-runs without spawning Claude and includes collaborator memory and mode', async () => {
    const root = makeRoot();
    const statePath = join(root, 'state.json');
    const reportDir = join(root, 'reports');
    saveClaudeCollaboratorState({
      ...defaultClaudeCollaboratorState(),
      sessionId: 'sess-prev',
      memory: [{ ts: '2026-06-13T00:00:00.000Z', kind: 'note', summary: 'memory from previous round' }],
    }, statePath);

    const result = await askClaudeCollaborator({
      task: '让 Claude 作为显式 active executor 前先产出交接 brief',
      statePath,
      reportDir,
      rootDir: root,
      mode: 'active-executor-brief',
      dryRun: true,
      runner: async () => {
        throw new Error('runner should not be called in dryRun');
      },
    });

    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.args).toContain('--resume');
    expect(result.prompt).toContain('Noe Claude Development Partner');
    expect(result.prompt).toContain('active-executor-brief');
    expect(result.prompt).toContain('memory from previous round');
    expect(result.prompt).toContain('默认不是 writer');
    expect(result.prompt).toContain('Claude 4.8 Max');
    expect(result.prompt).toContain('evidence_read');
    expect(result.args).toContain('--effort');
    expect(result.args[result.args.indexOf('--effort') + 1]).toBe('max');
  });

  it('extracts Claude evidence_read refs for round validation', () => {
    const evidenceRead = extractClaudeEvidenceRead(`
1. 结论
2. evidence_read:
- src/room/NoeCodexClaudeCollaborationRound.js (direct-read) - checked validation
- docs/DESIGN.md | summary-only | only saw quoted text
3. 风险/硬边界
`);

    expect(evidenceRead).toEqual([
      {
        ref: 'src/room/NoeCodexClaudeCollaborationRound.js',
        mode: 'direct-read',
        raw: 'src/room/NoeCodexClaudeCollaborationRound.js (direct-read) - checked validation',
      },
      {
        ref: 'docs/DESIGN.md',
        mode: 'summary-only',
        raw: 'docs/DESIGN.md | summary-only | only saw quoted text',
      },
    ]);
  });

  it('extracts Markdown evidence_read tables from Claude reports', () => {
    const evidenceRead = extractClaudeEvidenceRead(`
## 1. 结论

Claude 已审查。

## 2. evidence_read

| ref | mode | note |
|-----|------|------|
| \`output/noe-memory-live-provenance/noe-memory-live-provenance-1781347719109.json\` | **direct-read** | checked chatOk/source links |
| mind.html「语义 已启用」 | **summary-only（最关键）** | only saw Codex summary |
| src/memory/NoeMemoryRoadmapVerifier.js | truncated | long file snippet |

---

## 3. 风险/硬边界
`);

    expect(evidenceRead).toEqual([
      {
        ref: 'output/noe-memory-live-provenance/noe-memory-live-provenance-1781347719109.json',
        mode: 'direct-read',
        raw: '| output/noe-memory-live-provenance/noe-memory-live-provenance-1781347719109.json | direct-read | checked chatOk/source links |',
      },
      {
        ref: 'mind.html「语义 已启用」',
        mode: 'summary-only',
        raw: '| mind.html「语义 已启用」 | summary-only（最关键） | only saw Codex summary |',
      },
      {
        ref: 'src/memory/NoeMemoryRoadmapVerifier.js',
        mode: 'truncated',
        raw: '| src/memory/NoeMemoryRoadmapVerifier.js | truncated | long file snippet |',
      },
    ]);
  });

  it('validates collaborator mode before running', async () => {
    const root = makeRoot();
    await expect(askClaudeCollaborator({
      task: 'bad mode',
      rootDir: root,
      statePath: join(root, 'state.json'),
      reportDir: join(root, 'reports'),
      mode: 'write-directly',
      dryRun: true,
    })).rejects.toThrow(/unsupported claude collaborator mode/);
  });

  it('refuses non-4.8 Claude models even when explicitly requested', async () => {
    const root = makeRoot();
    await expect(askClaudeCollaborator({
      task: 'bad model',
      rootDir: root,
      statePath: join(root, 'state.json'),
      reportDir: join(root, 'reports'),
      model: 'sonnet',
      dryRun: true,
    })).rejects.toThrow(/requires Claude 4\.8 Max/);
  });
});
