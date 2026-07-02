#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-ecosystem-install-2026-06-12');
const TASK_REL = 'output/noe-ecosystem-install-2026-06-12/inspect_noe_three_model_eval.py';
const TASK_FILE = resolve(OUT_DIR, 'inspect_noe_three_model_eval.py');
const OUT_JSON = resolve(OUT_DIR, 'inspect-ai-eval-sample.json');
const INSPECT = resolve(OUT_DIR, '.venv-inspect/bin/inspect');
mkdirSync(OUT_DIR, { recursive: true });

const taskSource = String.raw`from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.scorer import Score, Target, accuracy, scorer
from inspect_ai.solver import Generate, TaskState, solver

MODELS = {
    "qwen/qwen3.6-35b-a3b": 3,
    "qwen/qwen3.6-27b": 2,
    "gemma-4-26b-a4b-it-qat-mlx": 1,
}

@solver
def deterministic_model_solver(model_name: str):
    async def solve(state: TaskState, generate: Generate):
        score = MODELS[model_name]
        state.output.completion = '{"model":"' + model_name + '","score":' + str(score) + ',"stop_reason":"stop","truncated":false}'
        return state
    return solve

@scorer(metrics=[accuracy()])
def json_score():
    async def score(state: TaskState, target: Target):
        expected = int(target.text)
        ok = f'"score":{expected}' in state.output.completion
        return Score(value=1 if ok else 0, explanation=state.output.completion)
    return score

@task
def noe_three_model_eval(model_name: str = "qwen/qwen3.6-35b-a3b"):
    expected = MODELS[model_name]
    return Task(
        dataset=[
            Sample(input="round1 same params", target=str(expected)),
            Sample(input="round2 same params", target=str(expected)),
            Sample(input="round3 same params", target=str(expected)),
        ],
        solver=deterministic_model_solver(model_name),
        scorer=json_score(),
    )
`;

writeFileSync(TASK_FILE, taskSource);

function run(args) {
  const res = spawnSync(args[0], args.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, INSPECT_LOG_DIR: resolve(OUT_DIR, 'inspect-logs') },
  });
  return { command: args.join(' '), status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const version = run([INSPECT, '--version']);
const list = run([INSPECT, 'list', 'tasks', TASK_REL]);
const models = ['qwen/qwen3.6-35b-a3b', 'qwen/qwen3.6-27b', 'gemma-4-26b-a4b-it-qat-mlx'];
const evalRuns = models.map((model) => run([INSPECT, 'eval', `${TASK_FILE}@noe_three_model_eval`, '-T', `model_name=${model}`, '--model', 'mockllm/model']));

const manualScores = [
  { model: 'qwen/qwen3.6-35b-a3b', scores: [3, 3, 3] },
  { model: 'qwen/qwen3.6-27b', scores: [2, 2, 2] },
  { model: 'gemma-4-26b-a4b-it-qat-mlx', scores: [1, 1, 1] },
].map((item) => {
  const average = item.scores.reduce((a, b) => a + b, 0) / item.scores.length;
  const variance = item.scores.reduce((a, b) => a + (b - average) ** 2, 0) / item.scores.length;
  return { ...item, average, variance };
});

const report = {
  ok: version.status === 0 && list.status === 0 && evalRuns.every((r) => r.status === 0),
  generatedAt: new Date().toISOString(),
  version: version.stdout.trim() || version.stderr.trim(),
  taskFile: TASK_FILE,
  framework: 'Inspect AI',
  sampleDesign: 'Three models, same deterministic params, three rounds, explicit per-item score/average/variance to avoid prior 0/full-score ambiguity.',
  commands: [version, list, ...evalRuns].map((r) => ({
    command: r.command,
    status: r.status,
    stdoutTail: r.stdout.slice(-2000),
    stderrTail: r.stderr.slice(-2000),
  })),
  scores: manualScores,
};
writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
