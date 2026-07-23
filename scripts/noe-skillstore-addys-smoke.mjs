#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { skillStore } from '../src/skills/SkillStore.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-ecosystem-install-2026-06-12');
const OUT_JSON = resolve(OUT_DIR, 'skills-addys-smoke.json');
mkdirSync(OUT_DIR, { recursive: true });

const skills = [
  ['source-driven-development', 'Use for source-first changes: inspect existing files, trace callers, then edit minimal code.', 'Read the local source before deciding. Trace imports, routes, tests, and runtime entrypoints. Do not claim behavior without code or command evidence.'],
  ['context-engineering', 'Use when shaping prompts or context windows for Noe agent tasks.', 'Prefer concise task context with explicit repo root, boundaries, evidence requirements, and stop conditions based on validation results.'],
  ['test-driven-development', 'Use when implementing fixes that need behavior proof.', 'Start from a failing or targeted test when practical. Keep tests close to the changed contract and run the smallest useful suite before broader checks.'],
  ['debugging', 'Use when a task is blocked, flaky, or has an unknown failure mechanism.', 'Collect the exact error, reduce to a minimal reproduction, inspect logs/state, form one hypothesis at a time, and preserve blocker evidence.'],
  ['security', 'Use when tools, files, browser state, credentials, or external actions are involved.', 'Do not expose secrets. Gate destructive or external write actions. Prefer read-only defaults, snapshots, and rollback paths.'],
  ['observability', 'Use when adding or validating model/tool/runtime behavior.', 'Record inputs without secrets, outputs or digests, duration, status, stop reason, truncation, artifacts, and enough context to replay the decision.'],
  ['incremental-implementation', 'Use when integrating a large capability into Noe.', 'Land the smallest reversible slice first, feature-flag risky behavior, smoke it in isolation, then connect it to the main path only after evidence is green.'],
];

const upserted = skills.map(([name, description, body]) => skillStore.upsert({
  name,
  displayName: name,
  description,
  body,
  enabled: true,
  extra: { source: 'addy-selected' },
}));

skillStore.reload();
const names = skills.map(([name]) => name);
const list = skillStore.list().filter((s) => names.includes(s.name));
const prompt = skillStore.buildSystemPromptForSkills(names);
const report = {
  ok: list.length === names.length && prompt.length > 0 && prompt.length < 12000,
  generatedAt: new Date().toISOString(),
  imported: list.map((s) => ({ name: s.name, enabled: s.enabled, bodyLen: s.bodyLen })),
  promptBudget: { chars: prompt.length, maxChars: 12000 },
  promptPreview: prompt.slice(0, 600),
  upserted: upserted.map((s) => ({ name: s.name, enabled: s.enabled, path: s.path })),
};
writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
