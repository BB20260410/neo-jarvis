#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NoeBackgroundReviewRunner } from '../src/runtime/NoeBackgroundReview.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function smokeMessages() {
  return [
    {
      role: 'user',
      content: '下次做 Hermes 对标时，必须先确认官方仓库，再把可复制机制落成测试。'.repeat(4),
    },
    {
      role: 'assistant',
      content: '已完成：克隆官方仓、写计划、落地 Mission Finalizer、跑验证。'.repeat(4),
    },
  ];
}

async function smoke() {
  const runner = new NoeBackgroundReviewRunner({
    root: ROOT,
    now: () => '2026-06-13T00:00:00.000Z',
    chat: async (_messages, opts) => ({
      reply: JSON.stringify({
        decision: 'propose',
        memoryProposals: [{ text: 'Owner wants Hermes research converted into tested Neo runtime improvements.', confidence: 0.78 }],
        skillProposals: [{ name: 'reference-architecture-fusion', description: 'Use when converting external agent architectures into Neo changes.' }],
        actionProposals: [{ title: 'Review BackgroundReview candidates before applying', evidenceRequired: ['reportRef'] }],
        risks: [],
        confidence: 0.82,
      }),
      observedAllowedTools: opts.allowedTools,
    }),
  });
  const result = await runner.run({
    messages: smokeMessages(),
    context: {
      projectId: 'noe',
      loadedSkills: ['local-model-routing'],
      evidenceRefs: ['docs/HERMES_2026-06-13_架构执行力与自我进化融合计划.md'],
    },
  });
  const reportPath = result.reportRef ? resolve(ROOT, result.reportRef) : '';
  const report = reportPath && existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null;
  const ok = Boolean(
    result.ok
      && result.reportRef?.startsWith('output/noe-background-review/')
      && report?.proposalOnly === true
      && Array.isArray(report.proposals)
      && report.proposals.length === 3
      && report.proposals.every((item) => ['memory_candidate', 'skill_draft', 'review_report'].includes(item.tool))
      && report.directWrites.length === 0
  );
  return { ok, result, reportRef: result.reportRef, proposalTools: report?.proposals?.map((item) => item.tool) || [] };
}

const command = process.argv[2] || 'smoke';
try {
  const result = command === 'smoke'
    ? await smoke()
    : { ok: false, error: `unsupported command: ${command}` };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.log(JSON.stringify({ ok: false, error: error.message }, null, 2));
  process.exitCode = 1;
}
