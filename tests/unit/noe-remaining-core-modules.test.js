import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { buildCodebaseFtsIndex } from '../../src/agents/CodebaseFtsIndex.js';
import { buildCodebaseVectorIndex } from '../../src/agents/CodebaseVectorIndex.js';
import {
  classifyCodebaseQuery,
  scoreCodebaseEvidence,
  scorePathForCodebaseQuery,
  tokenizeCodebaseQuery,
} from '../../src/agents/CodebaseQueryEngine.js';
import {
  buildNoeReviewBrainPreflight,
  normalizeNoeAutoModel,
  resolveNoeBrainForTask,
  resolveNoeModelLoadPlan,
  resolveNoeOutputBudget,
} from '../../src/model/NoeLocalBrainRouter.js';
import { recordGoalStepResult } from '../../src/cognition/NoeGoalStepRecorder.js';

function sampleMap() {
  const evidence = [
    {
      path: 'src/server/routes/budgets.js',
      language: 'js',
      parser: 'js',
      symbols: [{ name: 'registerBudgetRoutes', type: 'function', line: 7, exported: true }],
      imports: [{ source: '../budget/BudgetPolicyStore.js', specifiers: [{ imported: 'budgetPolicyStore', local: 'budgetPolicyStore' }] }],
      exports: [{ name: 'registerBudgetRoutes', local: 'registerBudgetRoutes' }],
      anchors: [{ kind: 'route', name: 'POST /api/noe/budget/preflight', line: 11 }],
      snippets: [{ line: 12, reason: 'route', text: 'router.post("/api/noe/budget/preflight", requireOwnerToken, handler)' }],
      references: [{ kind: 'call', name: 'budgetPolicyStore.preflight', line: 18, text: 'budgetPolicyStore.preflight(req.body)' }],
    },
    {
      path: 'src/budget/BudgetPolicyStore.js',
      language: 'js',
      parser: 'js',
      symbols: [{ name: 'BudgetPolicyStore', type: 'class', line: 1, exported: true }],
      imports: [],
      exports: [{ name: 'BudgetPolicyStore', local: 'BudgetPolicyStore' }],
      anchors: [],
      snippets: [{ line: 4, reason: 'method', text: 'preflight({ estimateTokens }) prevents quota overspend incidents' }],
      references: [],
    },
  ];
  return {
    cwd: '/tmp/noe-codebase-test',
    query: 'budget preflight route',
    focusFiles: [
      {
        path: 'src/server/routes/budgets.js',
        score: 20,
        reasons: ['focus'],
        snippets: ['budget preflight route'],
        snippetLocations: [{ line: 11, reason: 'query', text: 'budget preflight route' }],
      },
    ],
    graph: {
      edges: [{ from: 'src/server/routes/budgets.js', to: 'src/budget/BudgetPolicyStore.js' }],
    },
    evidence,
  };
}

function goalDb(plan = []) {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE noe_goals (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      plan TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.prepare('INSERT INTO noe_goals(id, status, plan, updated_at) VALUES (?, ?, ?, ?)')
    .run('goal-1', 'open', JSON.stringify(plan), 100);
  return db;
}

function readGoal(db) {
  const row = db.prepare('SELECT * FROM noe_goals WHERE id = ?').get('goal-1');
  return { ...row, plan: JSON.parse(row.plan) };
}

describe('CodebaseFtsIndex / CodebaseVectorIndex / CodebaseQueryEngine', () => {
  it('builds FTS and vector indexes that produce explainable source results', () => {
    const map = sampleMap();
    const fts = buildCodebaseFtsIndex(map);
    const vector = buildCodebaseVectorIndex(map);
    try {
      const ftsResults = fts.query('budget preflight route', { maxResults: 5 });
      const vectorResults = vector.query('quota preflight route budget', { maxResults: 5 });
      const scored = scoreCodebaseEvidence(map, '预算 preflight route', {
        maxResults: 5,
        ftsResults,
        vectorResults,
      });

      expect(fts.summary).toMatchObject({ enabled: true, engine: 'sqlite-fts5', fileCount: 2 });
      expect(vector.summary).toMatchObject({ enabled: true, engine: 'local-hash-vector', rowCount: 2 });
      expect(ftsResults.some((item) => item.path === 'src/server/routes/budgets.js')).toBe(true);
      expect(vectorResults.length).toBeGreaterThan(0);
      expect(scored[0]).toEqual(expect.objectContaining({
        path: 'src/server/routes/budgets.js',
        reason: expect.arrayContaining(['import-graph']),
      }));
      expect(scored.some((item) => item.routes?.some((route) => route.name === 'POST /api/noe/budget/preflight'))).toBe(true);
    } finally {
      fts.close();
    }
  });

  it('classifies intent aliases and path scoring without self-referential query drift', () => {
    const tokens = tokenizeCodebaseQuery('预算 preflight incidents and route usage');
    const classified = classifyCodebaseQuery('预算 preflight incidents and route usage', tokens);
    const budgetScore = scorePathForCodebaseQuery('src/budget/BudgetPolicyStore.js', tokens, 'preflight incident');
    const selfScore = scorePathForCodebaseQuery('src/agents/CodebaseQueryEngine.js', ['handler'], 'handler');

    expect(tokens).toEqual(expect.arrayContaining(['budget', 'preflight', 'incident']));
    expect(classified.budget).toBe(true);
    expect(classified.routeSymbolGraph).toBe(true);
    expect(budgetScore.score).toBeGreaterThan(0);
    expect(selfScore.reasons).toContain('avoid-query-engine-self-reference');
    expect(selfScore.score).toBeLessThan(0);
  });
});

describe('NoeGoalStepRecorder', () => {
  it('creates plans, preserves act replay safety, and marks goals done only when every step is terminal', () => {
    const db = goalDb([]);
    let now = 1000;
    const getdb = () => db;
    const getGoal = (_id) => readGoal(db);
    try {
      const created = recordGoalStepResult({
        getdb,
        getGoal,
        now: () => now,
        allowActKind: true,
        goalId: 'goal-1',
        stepIndex: -1,
        input: {
          newSteps: [
            { step: 'Search docs', kind: 'research' },
            { step: 'Click launch', kind: 'act', action: 'browser.click', payload: { selector: '#launch' } },
            'Think through result',
          ],
        },
      });
      const afterCreate = readGoal(db);
      const createCheckpoint = db.prepare('SELECT phase, replay_safe, payload FROM noe_goal_checkpoints ORDER BY ts DESC LIMIT 1').get();

      expect(created.ok).toBe(true);
      expect(afterCreate.plan.map((step) => step.kind)).toEqual(['research', 'act', 'think']);
      expect(afterCreate.plan[1]).toMatchObject({ action: 'browser.click', payload: { selector: '#launch' } });
      expect(createCheckpoint.phase).toBe('plan_created');
      expect(createCheckpoint.replay_safe).toBe(1);
      expect(JSON.parse(createCheckpoint.payload).newStepCount).toBe(3);

      now += 1;
      const actDoing = recordGoalStepResult({
        getdb,
        getGoal,
        now: () => now,
        goalId: 'goal-1',
        stepIndex: 1,
        input: { doing: true, note: 'clicked once' },
      });
      const actCheckpoint = db.prepare('SELECT phase, replay_safe FROM noe_goal_checkpoints ORDER BY ts DESC LIMIT 1').get();

      expect(actDoing.ok).toBe(true);
      expect(readGoal(db).plan[1].status).toBe('doing');
      expect(actCheckpoint).toMatchObject({ phase: 'step_started', replay_safe: 0 });

      now += 1;
      recordGoalStepResult({ getdb, getGoal, now: () => now, goalId: 'goal-1', stepIndex: 0, input: { done: true } });
      recordGoalStepResult({ getdb, getGoal, now: () => now, goalId: 'goal-1', stepIndex: 1, input: { status: 'recovered' } });
      const final = recordGoalStepResult({ getdb, getGoal, now: () => now, goalId: 'goal-1', stepIndex: 2, input: { done: true } });

      expect(final.goalDone).toBe(true);
      expect(final.goal.status).toBe('done');
      expect(readGoal(db).status).toBe('done');
    } finally {
      db.close();
    }
  });
});

describe('NoeLocalBrainRouter', () => {
  it('routes low-risk work to main/fallback and high-risk work to review brain', () => {
    expect(normalizeNoeAutoModel('q35-6')).toBe('qwen/qwen3.6-35b-a3b');
    expect(resolveNoeModelLoadPlan('qwen/qwen3.6-27b')).toMatchObject({
      role: 'review',
      loadModel: 'qwen/qwen3.6-27b@4bit',
      contextLength: 262144,
    });
    expect(resolveNoeBrainForTask({ kind: 'chat' })).toMatchObject({ role: 'main', requiresReview: false });
    expect(resolveNoeBrainForTask({ kind: 'quick', mainUnavailable: true })).toMatchObject({
      role: 'fallback',
      degradedMode: true,
    });
    expect(resolveNoeBrainForTask({ actionId: 'noe.freedom.social.final_publish.execute', risk: 'high' })).toMatchObject({
      role: 'review',
      requiresReview: true,
    });
  });

  it('builds redacted review preflight and clamps output budgets by role', () => {
    const preflight = buildNoeReviewBrainPreflight({
      actionId: 'delete-post',
      operation: 'external_write',
      tool: { id: 'delete-post', riskLevel: 'high', tags: ['publish'] },
      args: { token: 'secret' },
      realExecute: true,
      evidenceRefs: { snapshot: 'snap.json' },
      reason: 'contains sk-unit-test-secret-12345678901234567890',
    });
    const fallbackBudget = resolveNoeOutputBudget('long_report', {
      role: 'fallback',
      requestedMaxTokens: 999999,
    });

    expect(preflight.required).toBe(true);
    expect(preflight.route).toMatchObject({ role: 'review', reason: 'explicit_review_required' });
    expect(preflight.request.user.reason).not.toContain('sk-unit-test-secret');
    expect(preflight.request.user.evidenceRefsPresent).toEqual(['snapshot']);
    expect(preflight.request.user.argsKeys).toEqual(['token']);
    expect(fallbackBudget.max_tokens).toBeLessThanOrEqual(4096);
  });
});
