#!/usr/bin/env node
// @ts-check

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCodexClaudeProtocolChecklist,
  createCodexClaudeCollaborationRound,
  validateCodexClaudeCollaborationRound,
  writeCodexClaudeCollaborationRound,
} from '../src/room/NoeCodexClaudeCollaborationRound.js';
import { extractClaudeEvidenceRead } from '../src/room/NoeClaudeEvidenceParser.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const command = argv[0] && !argv[0].startsWith('-') ? argv[0] : 'protocol';
  const args = argv.slice(command === argv[0] ? 1 : 0);
  const out = {
    command,
    task: '',
    taskFile: '',
    roundFile: '',
    roundId: '',
    outDir: 'output/noe-codex-claude-collaboration',
    activeExecutor: 'codex',
    mergeOwner: '',
    status: 'draft',
    codexPlanFile: '',
    claudePlanFile: '',
    codexReviewFile: '',
    claudeReviewFile: '',
    synthesisFile: '',
    codexAgreement: 'revise',
    claudeAgreement: 'revise',
    codexAgreementFile: '',
    claudeAgreementFile: '',
    codexWorkFile: '',
    claudeWorkFile: '',
    sharedEvidenceFile: '',
    challengeLogFile: '',
    readinessCriteriaFile: '',
    claudeReportFile: '',
    iteration: 1,
    json: false,
    help: false,
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const next = () => args[++i] || '';
    const valueOf = (name) => arg.startsWith(`${name}=`) ? arg.slice(name.length + 1) : null;
    if (arg === '--help' || arg === '-h') out.help = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--task') out.task = next();
    else if (valueOf('--task') !== null) out.task = valueOf('--task');
    else if (arg === '--task-file') out.taskFile = next();
    else if (valueOf('--task-file') !== null) out.taskFile = valueOf('--task-file');
    else if (arg === '--round-file') out.roundFile = next();
    else if (valueOf('--round-file') !== null) out.roundFile = valueOf('--round-file');
    else if (arg === '--round-id') out.roundId = next();
    else if (valueOf('--round-id') !== null) out.roundId = valueOf('--round-id');
    else if (arg === '--out-dir') out.outDir = next();
    else if (valueOf('--out-dir') !== null) out.outDir = valueOf('--out-dir');
    else if (arg === '--active-executor') out.activeExecutor = next();
    else if (valueOf('--active-executor') !== null) out.activeExecutor = valueOf('--active-executor');
    else if (arg === '--merge-owner') out.mergeOwner = next();
    else if (valueOf('--merge-owner') !== null) out.mergeOwner = valueOf('--merge-owner');
    else if (arg === '--status') out.status = next();
    else if (valueOf('--status') !== null) out.status = valueOf('--status');
    else if (arg === '--iteration') out.iteration = Number(next()) || 1;
    else if (valueOf('--iteration') !== null) out.iteration = Number(valueOf('--iteration')) || 1;
    else if (arg === '--codex-plan-file') out.codexPlanFile = next();
    else if (valueOf('--codex-plan-file') !== null) out.codexPlanFile = valueOf('--codex-plan-file');
    else if (arg === '--claude-plan-file') out.claudePlanFile = next();
    else if (valueOf('--claude-plan-file') !== null) out.claudePlanFile = valueOf('--claude-plan-file');
    else if (arg === '--codex-review-file') out.codexReviewFile = next();
    else if (valueOf('--codex-review-file') !== null) out.codexReviewFile = valueOf('--codex-review-file');
    else if (arg === '--claude-review-file') out.claudeReviewFile = next();
    else if (valueOf('--claude-review-file') !== null) out.claudeReviewFile = valueOf('--claude-review-file');
    else if (arg === '--synthesis-file') out.synthesisFile = next();
    else if (valueOf('--synthesis-file') !== null) out.synthesisFile = valueOf('--synthesis-file');
    else if (arg === '--codex-agreement') out.codexAgreement = next();
    else if (valueOf('--codex-agreement') !== null) out.codexAgreement = valueOf('--codex-agreement');
    else if (arg === '--claude-agreement') out.claudeAgreement = next();
    else if (valueOf('--claude-agreement') !== null) out.claudeAgreement = valueOf('--claude-agreement');
    else if (arg === '--codex-agreement-file') out.codexAgreementFile = next();
    else if (valueOf('--codex-agreement-file') !== null) out.codexAgreementFile = valueOf('--codex-agreement-file');
    else if (arg === '--claude-agreement-file') out.claudeAgreementFile = next();
    else if (valueOf('--claude-agreement-file') !== null) out.claudeAgreementFile = valueOf('--claude-agreement-file');
    else if (arg === '--codex-work-file') out.codexWorkFile = next();
    else if (valueOf('--codex-work-file') !== null) out.codexWorkFile = valueOf('--codex-work-file');
    else if (arg === '--claude-work-file') out.claudeWorkFile = next();
    else if (valueOf('--claude-work-file') !== null) out.claudeWorkFile = valueOf('--claude-work-file');
    else if (arg === '--shared-evidence-file') out.sharedEvidenceFile = next();
    else if (valueOf('--shared-evidence-file') !== null) out.sharedEvidenceFile = valueOf('--shared-evidence-file');
    else if (arg === '--challenge-log-file') out.challengeLogFile = next();
    else if (valueOf('--challenge-log-file') !== null) out.challengeLogFile = valueOf('--challenge-log-file');
    else if (arg === '--readiness-criteria-file') out.readinessCriteriaFile = next();
    else if (valueOf('--readiness-criteria-file') !== null) out.readinessCriteriaFile = valueOf('--readiness-criteria-file');
    else if (arg === '--claude-report-file') out.claudeReportFile = next();
    else if (valueOf('--claude-report-file') !== null) out.claudeReportFile = valueOf('--claude-report-file');
    else throw new Error(`unknown option: ${arg}`);
  }
  return out;
}

function usage() {
  return [
    'Usage:',
    '  npm run noe:collab:codex-claude -- protocol --task <text>',
    '  npm run noe:collab:codex-claude -- assemble --task <text> --shared-evidence-file <json> --claude-report-file output/noe-claude-collaborator/<report>.md --codex-plan-file <file> --claude-plan-file <file> --codex-review-file <file> --claude-review-file <file> --challenge-log-file <json> --synthesis-file <file> --readiness-criteria-file <json> --status ready_to_execute --codex-agreement agree --claude-agreement agree',
    '  npm run noe:collab:codex-claude -- validate --round-file output/.../round.json',
  ].join('\n');
}

function readMaybeFile(file) {
  return file ? readFileSync(resolve(ROOT, file), 'utf8') : '';
}

function readJsonMaybeFile(file, fallback) {
  if (!file) return fallback;
  return JSON.parse(readMaybeFile(file));
}

function parseClaudeReport(file) {
  if (!file) return {};
  const text = readMaybeFile(file);
  const oneLine = (name) => {
    const match = text.match(new RegExp(`^- ${name}:\\s*(.*)$`, 'm'));
    return match ? match[1].trim() : '';
  };
  const evidenceRead = [];
  const parsedBlock = text.match(/## Parsed Evidence Read\s*\n+([\s\S]*?)(?:\n## |\n# |$)/);
  if (parsedBlock) {
    for (const line of parsedBlock[1].split('\n')) {
      const match = line.trim().match(/^-\s*(.*?)\s*\((direct-read|truncated|summary-only)\)\s*$/i);
      if (match) evidenceRead.push({ ref: match[1].trim(), mode: match[2].toLowerCase() });
    }
  }
  if (!evidenceRead.length) evidenceRead.push(...extractClaudeEvidenceRead(text));
  return {
    reportRef: file,
    sessionId: oneLine('sessionId'),
    generatedAt: oneLine('generatedAt'),
    requiredMode: oneLine('requiredMode'),
    requestedModel: oneLine('requestedModel'),
    requestedEffort: oneLine('requestedEffort'),
    evidenceRead,
  };
}

function readTask(args) {
  return args.taskFile ? readMaybeFile(args.taskFile) : args.task;
}

function print(value, json = false) {
  if (json || typeof value !== 'string') console.log(JSON.stringify(value, null, 2));
  else console.log(value);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    print(usage(), args.json);
    return;
  }

  if (args.command === 'protocol') {
    print(buildCodexClaudeProtocolChecklist({ task: readTask(args) }), args.json);
    return;
  }

  if (args.command === 'validate') {
    if (!args.roundFile) throw new Error('--round-file required');
    const round = JSON.parse(readMaybeFile(args.roundFile));
    const validation = validateCodexClaudeCollaborationRound(round, { rootDir: ROOT });
    print(validation, true);
    if (!validation.ok) process.exitCode = 1;
    return;
  }

  if (args.command !== 'assemble') throw new Error(`unsupported command: ${args.command}`);

  const round = createCodexClaudeCollaborationRound({
    roundId: args.roundId,
    task: readTask(args),
    sharedEvidence: readJsonMaybeFile(args.sharedEvidenceFile, []),
    codexPlan: readMaybeFile(args.codexPlanFile),
    claudePlan: readMaybeFile(args.claudePlanFile),
    codexReviewOfClaude: readMaybeFile(args.codexReviewFile),
    claudeReviewOfCodex: readMaybeFile(args.claudeReviewFile),
    challengeLog: readJsonMaybeFile(args.challengeLogFile, []),
    agentReports: {
      claude: parseClaudeReport(args.claudeReportFile),
    },
    synthesis: readMaybeFile(args.synthesisFile),
    activeExecutor: args.activeExecutor,
    mergeOwner: args.mergeOwner,
    status: args.status,
    iteration: args.iteration,
    codexAgreement: args.codexAgreement,
    claudeAgreement: args.claudeAgreement,
    codexAgreementRationale: readMaybeFile(args.codexAgreementFile),
    claudeAgreementRationale: readMaybeFile(args.claudeAgreementFile),
    codexWork: readMaybeFile(args.codexWorkFile),
    claudeWork: readMaybeFile(args.claudeWorkFile),
    readinessCriteria: readJsonMaybeFile(args.readinessCriteriaFile, {}),
  });
  const result = writeCodexClaudeCollaborationRound({
    rootDir: ROOT,
    outDir: args.outDir,
    round,
  });
  print(result, true);
  if (!result.ok) process.exitCode = 1;
}

main().catch((error) => {
  const json = process.argv.includes('--json');
  if (json) console.log(JSON.stringify({ ok: false, error: error?.message || String(error) }, null, 2));
  else console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
