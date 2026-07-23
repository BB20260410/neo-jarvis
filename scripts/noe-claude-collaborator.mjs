#!/usr/bin/env node
// @ts-check

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  askClaudeCollaborator,
  claudeCollaboratorStatus,
  resetClaudeCollaboratorState,
} from '../src/room/NoeClaudeCollaborator.js';
import { redactSensitiveText } from '../src/runtime/NoeContextScrubber.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SENSITIVE_PATH_RE = /(^|[/\\])(?:\.env(?:\..*)?|room-adapters\.json|.*cookie.*|.*oauth.*|.*token.*|.*secret.*|.*keychain.*)$/i;
const DIFF_EXCLUDES = [
  ':!games/cartoon-apocalypse/**',
  ':!.env',
  ':!.env.*',
  ':!**/.env',
  ':!**/.env.*',
  ':!**/room-adapters.json',
  ':!**/*cookie*',
  ':!**/*oauth*',
  ':!**/*token*',
  ':!**/*secret*',
  ':!**/*keychain*',
];

function usage() {
  return [
    'Usage:',
    '  npm run noe:claude:collaborator -- status [--json] [--state <path>]',
    '  npm run noe:claude:collaborator -- ask --task <text> [--mode plan|review|handoff|active-executor-brief] [--context <file>] [--shared-evidence-file <json>] [--include-diff] [--model claude-opus-4-8] [--effort max] [--ack-cost]',
    '  npm run noe:claude:collaborator -- ask --dry-run --task <text>',
    '  npm run noe:claude:collaborator -- reset --confirm',
  ].join('\n');
}

function readOptionValue(argv, index, name) {
  const arg = argv[index];
  const prefix = `${name}=`;
  if (arg.startsWith(prefix)) return { value: arg.slice(prefix.length), next: index };
  if (arg === name) return { value: argv[index + 1] || '', next: index + 1 };
  return null;
}

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'status';
  const args = argv.slice(command === argv[0] ? 1 : 0);
  const out = {
    command,
    task: '',
    taskFile: '',
    context: [],
    sharedEvidenceFile: '',
    mode: 'plan',
    statePath: '',
    reportDir: '',
    model: '',
    effort: 'max',
    bin: '',
    includeDiff: false,
    dryRun: false,
    json: false,
    ackCost: false,
    resume: true,
    confirm: false,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--include-diff') out.includeDiff = true;
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--ack-cost') out.ackCost = true;
    else if (arg === '--no-resume') out.resume = false;
    else if (arg === '--confirm') out.confirm = true;
    else {
      const task = readOptionValue(args, i, '--task');
      const taskFile = readOptionValue(args, i, '--task-file');
      const context = readOptionValue(args, i, '--context');
      const sharedEvidenceFile = readOptionValue(args, i, '--shared-evidence-file');
      const mode = readOptionValue(args, i, '--mode');
      const state = readOptionValue(args, i, '--state');
      const reportDir = readOptionValue(args, i, '--report-dir');
      const model = readOptionValue(args, i, '--model');
      const effort = readOptionValue(args, i, '--effort');
      const bin = readOptionValue(args, i, '--bin');
      const found = task || taskFile || context || sharedEvidenceFile || mode || state || reportDir || model || effort || bin;
      if (!found) throw new Error(`unknown option: ${arg}`);
      if (task) out.task = task.value;
      if (taskFile) out.taskFile = taskFile.value;
      if (context) out.context.push(context.value);
      if (sharedEvidenceFile) out.sharedEvidenceFile = sharedEvidenceFile.value;
      if (mode) out.mode = mode.value;
      if (state) out.statePath = state.value;
      if (reportDir) out.reportDir = reportDir.value;
      if (model) out.model = model.value;
      if (effort) out.effort = effort.value;
      if (bin) out.bin = bin.value;
      i = found.next;
    }
  }

  return out;
}

function printResult(value, { json = false } = {}) {
  if (json || typeof value !== 'string') console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

function fail(error, { json = false } = {}) {
  const message = error?.message || String(error || 'unknown error');
  if (json) console.log(JSON.stringify({ ok: false, error: message }, null, 2));
  else console.error(message);
  process.exitCode = 1;
}

function readTask(args) {
  if (args.taskFile) return readFileSync(resolve(ROOT, args.taskFile), 'utf8');
  return args.task;
}

function readJsonFile(file, fallback) {
  if (!file) return fallback;
  return JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
}

function safeDiffPath(file) {
  const text = String(file || '').trim();
  return Boolean(
    text
      && !text.startsWith('/')
      && !text.startsWith('..')
      && !SENSITIVE_PATH_RE.test(text)
      && !text.startsWith('games/cartoon-apocalypse/')
  );
}

function git(args) {
  return spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 8 * 1024 * 1024,
  });
}

function collectGitDiffBlock() {
  const names = git(['diff', '--name-only', '--', ...DIFF_EXCLUDES]);
  if (names.status !== 0) {
    return {
      path: 'git-diff-error',
      text: redactSensitiveText(names.stderr || names.stdout || `git diff --name-only failed: ${names.status}`),
      redacted: true,
      truncated: false,
    };
  }

  const safeFiles = names.stdout.split('\n').map((line) => line.trim()).filter(safeDiffPath);
  if (!safeFiles.length) {
    return {
      path: 'git-diff',
      text: 'No safe tracked git diff files were selected.',
      redacted: false,
      truncated: false,
    };
  }

  const result = git(['diff', '--', ...safeFiles]);
  const raw = result.status === 0
    ? result.stdout
    : result.stderr || result.stdout || `git diff failed: ${result.status}`;
  const redacted = redactSensitiveText(raw).slice(0, 60_000);
  return {
    path: 'git-diff',
    text: redacted,
    redacted: redacted !== raw,
    truncated: raw.length > redacted.length,
  };
}

function summarizeAskResult(result) {
  if (result.dryRun) {
    return {
      ok: true,
      dryRun: true,
      args: result.args,
      promptChars: result.prompt.length,
      promptPreview: result.prompt.slice(0, 1200),
      statePath: result.run?.statePath,
      model: result.run?.model,
      effort: result.run?.effort,
      requiredMode: result.run?.requiredMode,
      mode: result.run?.mode,
      resumed: result.run?.resumed,
    };
  }
  return {
    ok: result.ok,
    sessionId: result.sessionId,
    statePath: result.statePath,
    reportPath: result.reportPath,
    model: result.model,
    effort: result.effort,
    requiredMode: result.requiredMode,
    costUSD: result.costUSD,
    args: result.args,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printResult(usage(), args);
    return;
  }

  if (args.command === 'status') {
    const status = claudeCollaboratorStatus({
      statePath: args.statePath || undefined,
    });
    printResult(status, { json: true });
    return;
  }

  if (args.command === 'reset') {
    if (!args.confirm) throw new Error('reset requires --confirm');
    const state = resetClaudeCollaboratorState(args.statePath || undefined);
    printResult({ ok: true, reset: true, statePath: args.statePath || 'default', state }, { json: true });
    return;
  }

  if (args.command !== 'ask') throw new Error(`unsupported command: ${args.command}`);
  if (!args.dryRun && !args.ackCost) {
    throw new Error('real Claude collaborator calls require --ack-cost; use --dry-run for prompt verification');
  }

  const task = readTask(args);
  const extraContextBlocks = [];
  if (args.includeDiff) extraContextBlocks.push(collectGitDiffBlock());

  const result = await askClaudeCollaborator({
    task,
    context: args.context,
    extraContextBlocks,
    sharedEvidence: readJsonFile(args.sharedEvidenceFile, []),
    statePath: args.statePath || undefined,
    reportDir: args.reportDir || undefined,
    rootDir: ROOT,
    model: args.model,
    effort: args.effort,
    bin: args.bin,
    mode: args.mode,
    resume: args.resume,
    dryRun: args.dryRun,
  });
  printResult(summarizeAskResult(result), { json: true });
}

main().catch((error) => fail(error, { json: process.argv.includes('--json') }));
