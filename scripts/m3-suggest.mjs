#!/usr/bin/env node
// API-only M3 suggestion helper. Reads selected context from stdin and prints
// structured JSON. It never starts Mavis/OpenCode and never reads project files
// by itself.

import { buildM3ColdReviewInput, runM3SuggestionTask } from '../src/room/MiniMaxSuggestionPipeline.js';

function arg(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((item) => item.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

const taskType = arg('task', 'evidence_review');
const title = arg('title', taskType);
const checkpoint = arg('checkpoint', '');
const context = await readStdin();
const input = checkpoint
  ? buildM3ColdReviewInput(checkpoint, context, { title: title || undefined })
  : { taskType, title, context };
const result = await runM3SuggestionTask(input, {
  model: arg('model', process.env.MINIMAX_MODEL || 'MiniMax-M3'),
});

console.log(JSON.stringify({
  ok: result.ok,
  status: result.status,
  task: result.task && {
    id: result.task.id,
    taskType: result.task.taskType,
    route: result.task.route.route,
    contextChars: result.task.contextChars,
    finalAuthority: result.task.finalAuthority,
  },
  plan: result.plan || null,
  error: result.error || null,
}, null, 2));

process.exit(result.ok ? 0 : 1);
