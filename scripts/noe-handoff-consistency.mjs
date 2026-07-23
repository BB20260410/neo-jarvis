#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  agents: join(ROOT, 'AGENTS.md'),
  claude: join(ROOT, 'CLAUDE.md'),
  handoff: join(ROOT, 'docs', 'HANDOFF_2026-06-06_codex交接.md'),
  currentHandoff: join(ROOT, 'docs', 'HANDOFF_2026-06-12_单主脑Gemma收敛后续计划.md'),
  modelRouteRecord: join(ROOT, 'docs', 'EXECUTION_RECORD_2026-06-12_三角色本地模型路由.md'),
  noe100Matrix: join(ROOT, 'docs', 'NOE_100_ACCEPTANCE_MATRIX.md'),
  audit: join(ROOT, 'docs', 'Noe后续计划完成审计_2026-06-05.md'),
  final: join(ROOT, 'docs', 'Noe最终交付与代码审查_2026-06-05.md'),
  packageJson: join(ROOT, 'package.json'),
};

// 可维护：把散落的硬编码抽成具名常量/纯判据（默认值与原行为完全一致，零行为变化）。
// HANDOFF 行数上限：与项目“新文件 < 500 行”约定同源；抽成常量便于统一调整，默认 500 不变。
export const HANDOFF_MAX_LINES = 500;

// 接手读序“边界存在”的稳定语义标记：不钉死具体日期，只校验
//   ① 指向 docs/HANDOFF（最新交接为入口）② 有“优先”分层 ③ 有“只作为背景”降级分层
//   ④ 锚定验收基线 NOE_100_ACCEPTANCE_MATRIX.md。
// 四者同时存在 ⇒ 仍是一条真实的有序读序（优先级 + 背景降级 + 验收锚点），不随文档日期演进而误判。
export const READ_ORDER_STABLE_MARKERS = Object.freeze([
  'docs/HANDOFF',
  '优先',
  '只作为背景',
  'NOE_100_ACCEPTANCE_MATRIX.md',
]);

// 纯判据：给定 CLAUDE.md 文本，是否仍声明了接手读序边界。
export function claudeHasReadOrderBoundary(claudeText) {
  const text = typeof claudeText === 'string' ? claudeText : '';
  return READ_ORDER_STABLE_MARKERS.every((marker) => text.includes(marker));
}

function read(file) {
  return readFileSync(file, 'utf8');
}

function lineCount(text) {
  return text.split(/\r?\n/).length;
}

function add(checks, id, ok, details = {}) {
  checks.push({ id, ok: Boolean(ok), details });
}

function has(text, needle) {
  return text.includes(needle);
}

function main() {
  const checks = [];
  for (const [id, file] of Object.entries(files)) {
    add(checks, `exists_${id}`, existsSync(file), { file });
  }
  if (checks.some((c) => !c.ok)) return finish(checks);

  const agents = read(files.agents);
  const claude = read(files.claude);
  const handoff = read(files.handoff);
  const currentHandoff = read(files.currentHandoff);
  const modelRouteRecord = read(files.modelRouteRecord);
  const noe100Matrix = read(files.noe100Matrix);
  const audit = read(files.audit);
  const finalDoc = read(files.final);
  const pkg = JSON.parse(read(files.packageJson));
  const noe100Script = read(join(ROOT, 'scripts', 'noe-100-readiness.mjs'));
  const noe100Test = read(join(ROOT, 'tests', 'unit', 'noe-100-readiness.test.js'));
  const soakDailyScript = read(join(ROOT, 'scripts', 'noe-soak-daily-snapshot.mjs'));
  const soakDailyTest = read(join(ROOT, 'tests', 'unit', 'noe-soak-daily-snapshot.test.js'));
  const fullCurrentScript = read(join(ROOT, 'scripts', 'noe-full-current-verify.mjs'));
  const phase5Script = read(join(ROOT, 'scripts', 'noe-phase5-runtime-verify.mjs'));
  const serverScript = read(join(ROOT, 'server.js'));
  const cognitiveScript = read(join(ROOT, 'scripts', 'noe-cognitive-verify.mjs'));
  const cognitiveRuntimeScript = read(join(ROOT, 'scripts', 'noe-cognitive-runtime-verify.mjs'));
  const realUseReplayScript = read(join(ROOT, 'scripts', 'noe-real-use-replay.mjs'));
  const freedomLiveScript = read(join(ROOT, 'scripts', 'noe-freedom-live-smoke.mjs'));
  const captureEvidenceScript = read(join(ROOT, 'scripts', 'noe-capture-external-evidence.mjs'));
  const voiceEarScript = read(join(ROOT, 'scripts', 'noe-voice-ear-acceptance.mjs'));
  const socialDomLiveProbeScript = read(join(ROOT, 'scripts', 'lib', 'noe-social-dom-live-probe-utils.mjs')) + '\n' + read(join(ROOT, 'scripts', 'lib', 'noe-social-dom-live-probe-runner.mjs'));
  const restartPanelScript = read(join(ROOT, 'scripts', 'restart-panel.mjs'));
  const perfCheckScript = read(join(ROOT, 'scripts', 'perf-check.mjs'));
  const standingGrantModulePath = join(ROOT, 'scripts', 'lib', 'noe-standing-autonomy-grant.mjs');
  const standingGrantCliPath = join(ROOT, 'scripts', 'noe-standing-autonomy-grant.mjs');
  const standingGrantTestPath = join(ROOT, 'tests', 'unit', 'noe-standing-autonomy-grant.test.js');
  const standingGrantModule = existsSync(standingGrantModulePath) ? read(standingGrantModulePath) : '';
  const standingGrantCli = existsSync(standingGrantCliPath) ? read(standingGrantCliPath) : '';
  const standingGrantTest = existsSync(standingGrantTestPath) ? read(standingGrantTestPath) : '';
  const continuousAutonomyScriptPath = join(ROOT, 'scripts', 'noe-continuous-autonomy-snapshot.mjs');
  const continuousAutonomyTestPath = join(ROOT, 'tests', 'unit', 'noe-continuous-autonomy-snapshot.test.js');
  const continuousAutonomyScript = existsSync(continuousAutonomyScriptPath) ? read(continuousAutonomyScriptPath) : '';
  const continuousAutonomyTest = existsSync(continuousAutonomyTestPath) ? read(continuousAutonomyTestPath) : '';
  const expectationCalibrationScriptPath = join(ROOT, 'scripts', 'noe-expectation-calibration-snapshot.mjs');
  const expectationCalibrationTestPath = join(ROOT, 'tests', 'unit', 'noe-expectation-calibration-snapshot.test.js');
  const expectationCalibrationScript = existsSync(expectationCalibrationScriptPath) ? read(expectationCalibrationScriptPath) : '';
  const expectationCalibrationTest = existsSync(expectationCalibrationTestPath) ? read(expectationCalibrationTestPath) : '';
  const e2eWithServerScript = read(join(ROOT, 'scripts', 'e2e-with-server.mjs'));
  const rawE2eScripts = [
    read(join(ROOT, 'tests', 'e2e', 'noe-brain-ui-p0.e2e.mjs')),
    read(join(ROOT, 'tests', 'e2e', 'noe-freedom-stage-summary.e2e.mjs')),
    read(join(ROOT, 'tests', 'e2e', 'panel-ui-walkthrough.mjs')),
  ].join('\n');
  const entryDocs = [agents, claude].join('\n');
  const allDocs = [agents, claude, handoff, currentHandoff, modelRouteRecord, noe100Matrix, audit, finalDoc].join('\n');

  add(checks, 'agents_no_stale_phase2_next_step', !/下一步\s*=\s*阶段二/.test(agents));
  add(checks, 'agents_no_stale_55_count', !/55\/55|55 passed/.test(agents));
  add(checks, 'agents_points_to_full_current', has(agents, 'verify:noe:full-current'));
  add(checks, 'entry_docs_no_stale_unbounded_secret_policy', !/(早先所有项目级[\s\S]{0,80}硬边界[\s\S]{0,80}作废|开发者自由授权优先|room adapters 可读取|本地 `?\.env`?\s*\/\s*key\s*\/\s*token\s*\/\s*cookie)/.test(entryDocs));
  add(checks, 'entry_docs_have_current_secret_boundary', has(agents, '不打印、复制、总结或暴露') && has(claude, '不打印、复制、总结或暴露') && has(agents, 'npm run noe:keys:model:check') && has(claude, 'npm run noe:keys:model:check'));
  add(checks, 'entry_docs_have_standing_autonomy_grant', has(agents, 'standing autonomy grant') && has(claude, 'standing autonomy grant') && has(agents, 'npm run noe:autonomy:grant') && has(claude, 'npm run noe:autonomy:grant'));
  add(checks, 'entry_docs_have_port_git_boundaries', has(agents, '不触碰 `51735`') && has(claude, '不触碰 `51735`') && has(agents, '不 commit、amend、push、reset') && has(claude, '不 commit、amend、push、reset'));
  add(checks, 'entry_docs_have_three_role_model_policy', has(agents, 'qwen/qwen3.6-35b-a3b') && has(agents, 'qwen/qwen3.6-27b') && has(agents, 'gemma-4-26b-a4b-it-qat-mlx') && has(claude, 'qwen/qwen3.6-35b-a3b') && has(claude, 'qwen/qwen3.6-27b') && has(claude, 'gemma-4-26b-a4b-it-qat-mlx'));
  add(checks, 'agents_read_order_points_to_current_noe100_route', has(agents, 'HANDOFF_2026-06-12_单主脑Gemma收敛后续计划.md') && has(agents, 'EXECUTION_RECORD_2026-06-12_三角色本地模型路由.md') && has(agents, 'NOE_100_ACCEPTANCE_MATRIX.md'));
  add(checks, 'claude_points_to_current_read_order', claudeHasReadOrderBoundary(claude));
  add(checks, 'handoff_under_500_lines', lineCount(handoff) <= HANDOFF_MAX_LINES, { lines: lineCount(handoff), max: HANDOFF_MAX_LINES });
  add(checks, 'handoff_mentions_current_counts', has(handoff, 'phase5_live') && has(handoff, 'managed phase5 11/11') && has(handoff, 'managed real-use replay 11/11'));
  add(checks, 'handoff_mentions_full_current', has(handoff, 'verify:noe:full-current'));
  add(checks, 'current_handoff_mentions_three_role_model_policy', has(currentHandoff, 'qwen/qwen3.6-35b-a3b') && has(currentHandoff, 'qwen/qwen3.6-27b') && has(currentHandoff, 'gemma-4-26b-a4b-it-qat-mlx'));
  add(checks, 'current_handoff_no_stale_benchmark_default', !/跑完恢复 Gemma|Gemma 当前主脑/.test(currentHandoff));
  add(checks, 'current_handoff_mentions_continuous_autonomy_snapshot', has(currentHandoff, 'verify:noe:continuous-autonomy') && has(currentHandoff, 'noe-continuous-autonomy'));
  add(checks, 'model_route_record_mentions_three_roles', has(modelRouteRecord, 'Main Brain') && has(modelRouteRecord, 'Review Brain') && has(modelRouteRecord, 'Fallback Brain') && has(modelRouteRecord, 'qwen/qwen3.6-35b-a3b') && has(modelRouteRecord, 'qwen/qwen3.6-27b'));
  add(checks, 'noe100_matrix_keeps_soak_blocker', has(noe100Matrix, 'not_enough_soak_evidence') && has(noe100Matrix, 'activeDays=3') && has(noe100Matrix, 'Noe100'));
  add(checks, 'noe100_matrix_excludes_controlled_drill_from_long_term_calibration', has(noe100Matrix, 'natural live resolved >= 20') && has(noe100Matrix, 'controlled drill `resolvedCount>=20` 只证明机制') && has(noe100Matrix, '不会满足长期 live 校准'));
  add(checks, 'noe100_readiness_requires_natural_live_expectations', has(noe100Script, 'const expectationSettlementReady = naturalLiveResolvedExpectations >= 20') && has(noe100Script, 'controlled drill proves mechanism only') && has(noe100Test, 'does not let controlled expectation drills satisfy long-term natural live readiness'));
  add(checks, 'soak_snapshot_reports_natural_expectation_progress', has(soakDailyScript, 'naturalLiveResolved') && has(soakDailyScript, 'longTermReady') && has(soakDailyTest, 'controlledMechanismReady') && has(soakDailyTest, 'natural_live_noe_expectations_below_threshold'));
  add(checks, 'standing_autonomy_grant_module_exists', Boolean(standingGrantModule), { file: standingGrantModulePath });
  add(checks, 'standing_autonomy_grant_cli_exists', Boolean(standingGrantCli), { file: standingGrantCliPath });
  add(checks, 'standing_autonomy_grant_unit_test_exists', Boolean(standingGrantTest), { file: standingGrantTestPath });
  add(checks, 'standing_autonomy_grant_has_no_secret_values', has(standingGrantModule, 'secretValuesIncluded: false') && has(standingGrantModule, 'secretValueReturned: false') && has(standingGrantModule, 'neverWriteSecretValuesToReports'));
  add(checks, 'standing_autonomy_grant_supports_max_scopes', has(standingGrantModule, 'MAX_AUTONOMY_SCOPES') && has(standingGrantModule, 'restart-51835:repair') && has(standingGrantModule, 'e2e-live:run') && has(standingGrantCli, '--write-max'));
  add(checks, 'standing_autonomy_grant_tests_scope_exactness', has(standingGrantTest, 'does not let owner-token read imply unrelated scopes') && has(standingGrantTest, 'restart-51835:repair'));
  add(checks, 'continuous_autonomy_snapshot_script_exists', Boolean(continuousAutonomyScript), { file: continuousAutonomyScriptPath });
  add(checks, 'continuous_autonomy_snapshot_unit_test_exists', Boolean(continuousAutonomyTest), { file: continuousAutonomyTestPath });
  add(checks, 'continuous_autonomy_snapshot_is_read_only', has(continuousAutonomyScript, 'noModelCalls: true') && has(continuousAutonomyScript, 'noDbWrites: true') && has(continuousAutonomyScript, 'lmStudioLoadUnloadChanged: false'));
  add(checks, 'continuous_autonomy_snapshot_checks_fast_cadence', has(continuousAutonomyScript, 'meso: 5_000') && has(continuousAutonomyScript, 'micro: 10_000') && has(continuousAutonomyScript, 'proactive: 10_000') && has(continuousAutonomyScript, 'expectation: 600_000') && has(continuousAutonomyTest, 'cadence_proactive_too_slow_or_missing'));
  add(checks, 'server_defaults_match_fast_autonomy_cadence', has(serverScript, "NOE_INNER_INTERVAL_MS: '5000'") && has(serverScript, "NOE_GROWTH_INNER_INTERVAL_MS: '5000'") && has(serverScript, "NOE_IDLE_INNER_INTERVAL_MS: '15000'") && has(serverScript, "NOE_PROACTIVE_TICK_MS: '10000'") && has(serverScript, "NOE_AFFECT_TICK_MS: '10000'") && has(serverScript, 'Math.max(10_000, Number(process.env.NOE_AFFECT_TICK_MS)'));
  add(checks, 'expectation_calibration_excludes_controlled_live_rows', has(expectationCalibrationScript, 'isControlledLiveExpectation') && has(expectationCalibrationScript, 'controlled_live_expectations_excluded_from_live_calibration') && has(expectationCalibrationScript, 'liveCalibrationReady: naturalResolvedScored.length >= requiredLiveResolved') && has(expectationCalibrationScript, 'readyForLongTermCalibration: live.liveCalibrationReady && live.brierNatural.n >= requiredLiveResolved') && has(expectationCalibrationTest, 'excludes controlled live rows from long-term live calibration readiness'));
  add(checks, 'phase5_live_token_requires_ack', has(phase5Script, 'ackReadOwnerToken') && has(phase5Script, '--ack-read-owner-token') && has(phase5Script, 'NOE_ACK_READ_OWNER_TOKEN'));
  add(checks, 'phase5_live_accepts_standing_grant', has(phase5Script, 'resolveOwnerTokenAuthorization') && has(phase5Script, 'phase5-live:run') && has(phase5Script, 'standing autonomy grant'));
  add(checks, 'full_current_default_no_live_token', has(fullCurrentScript, 'includeLive: false') && has(fullCurrentScript, 'includeCognitiveLive: false') && has(fullCurrentScript, '--include-live') && has(fullCurrentScript, '--include-cognitive-live') && has(fullCurrentScript, '--ack-read-owner-token'));
  add(checks, 'cognitive_live_token_requires_ack', has(cognitiveScript, 'ackReadOwnerToken') && has(cognitiveScript, '--ack-read-owner-token') && has(cognitiveScript, 'not_loaded_policy_requires_ack'));
  add(checks, 'cognitive_runtime_token_requires_ack', has(cognitiveRuntimeScript, 'ackReadOwnerToken') && has(cognitiveRuntimeScript, '--ack-read-owner-token') && has(cognitiveRuntimeScript, 'not_loaded_policy_requires_ack'));
  add(checks, 'real_use_replay_live_token_requires_ack', has(realUseReplayScript, 'ackReadOwnerToken') && has(realUseReplayScript, '--ack-read-owner-token') && has(realUseReplayScript, 'use --managed for isolated no-secret verification'));
  add(checks, 'real_use_replay_accepts_standing_grant', has(realUseReplayScript, 'resolveOwnerTokenAuthorization') && has(realUseReplayScript, 'real-use-replay-live:run') && has(realUseReplayScript, 'standing autonomy grant'));
  add(checks, 'freedom_live_token_requires_ack', has(freedomLiveScript, 'ackReadOwnerToken') && has(freedomLiveScript, '--ack-read-owner-token') && has(freedomLiveScript, 'not_loaded_policy_requires_ack'));
  add(checks, 'freedom_live_accepts_standing_grant', has(freedomLiveScript, 'resolveOwnerTokenAuthorization') && has(freedomLiveScript, 'freedom-live:run') && has(freedomLiveScript, 'standing autonomy grant'));
  add(checks, 'capture_evidence_voice_token_requires_ack', has(captureEvidenceScript, 'ackReadOwnerToken') && has(captureEvidenceScript, '--ack-read-owner-token') && has(captureEvidenceScript, 'use --skip-voice for managed-only delegate evidence'));
  add(checks, 'voice_ear_token_requires_ack', has(voiceEarScript, 'ackReadOwnerToken') && has(voiceEarScript, '--ack-read-owner-token') && has(voiceEarScript, 'ownerTokenPrinted: false'));
  add(checks, 'social_dom_live_probe_token_requires_ack', has(socialDomLiveProbeScript, 'ackReadOwnerToken') && has(socialDomLiveProbeScript, '--ack-read-owner-token') && has(socialDomLiveProbeScript, 'not_loaded_policy_requires_ack'));
  add(checks, 'restart_panel_token_requires_ack', has(restartPanelScript, 'ACK_READ_OWNER_TOKEN') && has(restartPanelScript, '--ack-read-owner-token') && has(restartPanelScript, 'policy-blocked') && has(restartPanelScript, 'secretValueReturned: false'));
  add(checks, 'restart_panel_accepts_standing_grant', has(restartPanelScript, 'resolveOwnerTokenAuthorization') && has(restartPanelScript, 'restart-51835:repair') && has(restartPanelScript, 'standing autonomy grant'));
  add(checks, 'perf_check_token_requires_ack', has(perfCheckScript, 'ACK_READ_OWNER_TOKEN') && has(perfCheckScript, '--ack-read-owner-token') && has(perfCheckScript, 'owner-token not read'));
  add(checks, 'perf_check_accepts_standing_grant', has(perfCheckScript, 'resolveOwnerTokenAuthorization') && has(perfCheckScript, 'perf-protected-api:check') && has(perfCheckScript, 'standing autonomy grant'));
  add(checks, 'raw_e2e_token_requires_ack_or_injected_owner_token', has(rawE2eScripts, 'ACK_READ_OWNER_TOKEN') && has(rawE2eScripts, '--ack-read-owner-token') && has(rawE2eScripts, 'process.env.OWNER_TOKEN') && has(rawE2eScripts, 'NOE_E2E_ALLOW_RESERVED_PORT'));
  add(checks, 'raw_e2e_accepts_standing_grant_for_live_port', has(rawE2eScripts, 'resolveOwnerTokenAuthorization') && has(rawE2eScripts, 'e2e-live:run') && has(rawE2eScripts, 'standing autonomy grant'));
  add(checks, 'e2e_wrapper_allows_legacy_walkthrough_only_by_allowlist', has(e2eWithServerScript, 'LEGACY_E2E_TARGETS') && has(e2eWithServerScript, 'tests/e2e/panel-ui-walkthrough.mjs') && has(e2eWithServerScript, 'safeE2eTarget'));
  add(checks, 'audit_mentions_external_blocked', has(audit, 'external_blocked'));
  add(checks, 'final_doc_has_code_review', has(finalDoc, '代码审查') && has(finalDoc, 'phase5 managed'));

  const scripts = pkg.scripts || {};
  for (const name of ['verify:noe:full-current', 'verify:noe:capture-evidence', 'verify:noe:external-readiness', 'verify:cognitive', 'verify:noe:phase5', 'verify:noe:soak-snapshot', 'verify:noe:continuous-autonomy', 'verify:noe:personality-dataset', 'verify:noe:expectation-calibration', 'obsidian:mcp:check', 'obsidian:mcp:plan', 'wiki:ingest:check', 'wiki:lint']) {
    add(checks, `package_script_${name}`, typeof scripts[name] === 'string');
  }
  for (const name of ['noe:autonomy:grant', 'noe:autonomy:check', 'noe:autonomy:revoke']) {
    add(checks, `package_script_${name}`, typeof scripts[name] === 'string' && has(scripts[name], 'noe-standing-autonomy-grant.mjs'));
  }
  add(checks, 'package_test_p0_includes_standing_grant_unit', typeof scripts['test:p0:unit'] === 'string' && has(scripts['test:p0:unit'], 'tests/unit/noe-standing-autonomy-grant.test.js'));
  add(checks, 'package_test_p0_includes_continuous_autonomy_unit', typeof scripts['test:p0:unit'] === 'string' && has(scripts['test:p0:unit'], 'tests/unit/noe-continuous-autonomy-snapshot.test.js'));
  add(checks, 'package_test_e2e_raw_uses_managed_wrapper', typeof scripts['test:e2e:raw'] === 'string' && has(scripts['test:e2e:raw'], 'scripts/e2e-with-server.mjs') && has(scripts['test:e2e:raw'], 'tests/e2e/panel-ui-walkthrough.mjs'));

  const secretPattern = /(MINIMAX_API_KEY|OBSIDIAN_API_KEY|OPENAI_API_KEY)\s*[:=]\s*['"][^<'"]{8,}|Authorization: Bearer (?!<api-key>)[A-Za-z0-9._~+/=-]{8,}|X-Panel-Owner-Token['":\s]+[0-9a-f]{32,}|sk-[A-Za-z0-9_-]{20,}|\?t=[0-9a-f]{32,}/;
  add(checks, 'docs_no_obvious_secrets', !secretPattern.test(allDocs));

  finish(checks);
}

function finish(checks) {
  const failed = checks.filter((c) => !c.ok);
  for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.id}`);
  if (failed.length) {
    console.error(JSON.stringify({ ok: false, failed }, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, passed: checks.length, failed: 0 }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main();
}
