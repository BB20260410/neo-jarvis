# Progress Log

## Session: 2026-06-19

### Voice Ear Automated Evidence Track
- **Status:** complete for automated voice-ear evidence; final status remains `PASS_WITH_OPEN_BLOCKERS` because owner human-ear review is still open.
- **Updated:** 2026-06-20T05:18:56+0800.
- Actions taken:
  - Ran current live `51835` voice-ear automatic verification with owner-token acknowledgement: long 10/10, bracket 5/5, wake-negative 10/10.
  - Validated all 35 generated audio files with `ffprobe`; failedCount 0.
  - Ran a second full 10/5/10 verification after temporarily enabling owner-gate with a scratch wake word; this closed the `wakePrefixSource=owner_gate_disabled` ambiguity. The report showed `wakePrefixSource:"wake_word"` and `wakePrefixLength:8`.
  - Restored owner-gate after a transient restore `fetch failed`; added a recovery artifact proving pre-test, post-retry, and fresh live summaries all match: `enabled=false`, `wakeWordsCount=6`, `passphrasesCount=0`.
  - Re-ran runtime evidence after the restore and after the final pre/post/live summary compare; latest `output/noe-runtime-evidence/runtime-evidence-1781903936796.json` reports `blockers:[]`.
- Evidence:
  - V1 automatic report: `output/noe-voice-ear-acceptance/voice-ear-20260620-current/report.json`.
  - V1 audio technical validation: `output/noe-voice-ear-acceptance/voice-ear-20260620-current/audio-technical-validation.json`.
  - Owner-gate-enabled report: `output/noe-voice-ear-acceptance/voice-ear-20260620-owner-gate-enabled/report.json`.
  - Owner-gate-enabled audio validation: `output/noe-voice-ear-acceptance/voice-ear-20260620-owner-gate-enabled/audio-technical-validation.json`.
  - Owner-gate restore retry: `output/noe-runtime-repair/20260620-voice-owner-gate-enabled/owner-gate-restore-retry.json`.
  - Pre/post/live summary compare: `output/noe-runtime-repair/20260620-voice-owner-gate-enabled/owner-gate-pre-post-summary-compare.json`.
  - Latest post-restore runtime evidence: `output/noe-runtime-evidence/runtime-evidence-1781903936796.json`.
  - V3 evidence: `output/noe-multimodel/20260620-voice-ear-current-v3/evidence.md`.
  - V3 multi-model ledger: `output/noe-multimodel/20260620-voice-ear-current-v3/20260620-voice-ear-current-v3/ledger.json`.
- Review gates:
  - Subagent Aristotle v1: `pass_with_caveats`; no P0; preserve owner human-ear blocker.
  - Subagent Herschel v2: found and fixed P1 evidence-ordering issue where runtime evidence predated restore retry.
  - Subagent Volta v3: `approve_with_caveats`; no P0/P1 blocking automated closeout; owner human-ear blocker remains.
  - Codex/Claude/M3 v3 ledger reached `consensus_passed`, approvals 3/3, `parseErrors=[]`; ledger verifier passed.
- Remaining blocker:
  - `voice_ear_acceptance_requires_owner_ear_review`
- Caveats:
  - These checks prove automatic interface/audio/KWS endpoint behavior, not owner-audible quality.
  - No model or log can close the owner human-ear checklist; owner must listen and explicitly record pass/fail.
  - Real room microphone/speaker wake behavior is still not equivalent to generated wake-negative WAVs through `/api/noe/voice/wakeword`.

### NeoEval Scorer v5 and Xiaohongshu blocker repair
- **Status:** complete for NeoEval v5 and Xiaohongshu publish/delete closure; final status remains `PASS_WITH_OPEN_BLOCKERS` because owner voice ear review is still open.
- **Updated:** 2026-06-20T03:42:28+0800.
- Actions taken:
  - Fixed the Neo Review Brain final-publish blocker: first blocker was `rawOutputRef missing`; final publish review now receives sanitized DOM proof and reached `approve`.
  - Fixed the Xiaohongshu final publish click target: the `xhs-publish-btn` host center clicked the wrong side of the split button; the live path now clicks the submit region.
  - Per owner authorization, published `/Users/hxx/Desktop/001.mp4` as test note `Noe测试001`, verified it appeared in Xiaohongshu creator note manager, then deleted it and verified title/marker/noteId were absent after delete.
  - Implemented NeoEval offline scorer v5, including raw score artifacts, `--require-pass`, private_holdout traversal rejection, secret-shaped ref redaction/blocking, `rawRef` consistency checks, and `forbiddenIncludes` failure handling.
  - Updated NeoEval/baseline/plan docs and added a known-fail README for replay-collection-v5 so `ok:false` is not mistaken for a scorer regression.
- Evidence:
  - Xiaohongshu publish/delete: `output/noe-live-evidence/xhs-001mp4-publish-delete-final-evidence-1781887936945.json`.
  - Publish run ledger: `output/noe-freedom-runs/live-xhs-final-publish-submit-region-1781887696004/ledger.json`.
  - NeoEval v5 smoke score: `output/noe-eval-runs/smoke-schema-v5/run-schema-smoke-001-1781890371240/score.json`.
  - NeoEval v5 replay score: `output/noe-eval-runs/replay-collection-v5/run-replay-collection-001-1781890371430/score.json`.
  - NeoEval v5 known-fail note: `output/noe-eval-runs/replay-collection-v5/README.md`.
  - Latest baseline audit: `output/noe-baseline-audit/baseline-audit-1781890581760.json`.
  - NeoEval v5 multi-model gate: `output/noe-multimodel/20260620-neoeval-scorer-v5-review/ledger.json`.
- Verification:
  - NeoEval focused tests: 5 files / 40 tests passed.
  - NeoEval validator: `checked:48`, `failed:0`.
  - NeoEval v5 artifact validator: `checked:4`, `failed:0`.
  - Strict replay require-pass expected fail preserved 7 historical failed replay cases.
  - Consensus runner/gate/ledger focused tests: 5 files / 63 tests passed.
  - Multi-model ledger verifier: PASS, approvals `3/2`.
  - Subagent Sagan verdict: `pass`, no P0/P1/P2 findings.
- Closed external/manual blockers:
  - `xiaohongshu_publish_editor_not_ready`
  - `social_dom_probe_did_not_fill_upload_or_publish`
- Remaining blocker:
  - `voice_ear_acceptance_requires_owner_ear_review`
- Caveats:
  - Xiaohongshu returned editor `published=true` rather than a public post URL; closure is based on creator note-manager appearance plus deletion verification, not public URL visibility.
  - Xiaohongshu proof covers that platform only; it does not prove every social platform.
  - NeoEval v5 is offline dev/replay scoring, not private_holdout scoring and not a live runtime runner.
  - Voice programmatic checks passed earlier, but human ear quality remains owner-only acceptance and cannot be closed by logs or model review.

### Runtime Blocker Repair Track: curiosity and affect closed
- **Status:** complete for the two runtime blockers; final status remains `PASS_WITH_OPEN_BLOCKERS`.
- **Updated:** 2026-06-19T21:44:37+0800.
- Actions taken:
  - Reproduced `curiosity_harvest_missing`: eligible failed expectations existed, but `source:"surprise"` goals were blocked by the ordinary active-goal backlog cap.
  - Fixed `src/cognition/NoeGoalSystem.js` so surprise-fueled goals are backlog-exempt, added regression coverage in `tests/unit/noe-goal-system.test.js`, then performed a scoped live DB backfill with backup and rollback evidence.
  - Reproduced `affect_health_below_target`: latest live affect rows were dominated by saturated heartbeat ticks.
  - Fixed `src/cognition/NoeAffectHealth.js` to measure saturation by dimension ratio instead of row-level any-dimension saturation, added unit/audit coverage, then performed a controlled live scratch drill consumed by the real `51835` heartbeat.
  - Restarted `51835` after each runtime repair through the redacted owner-token restart path; `51735` remained observe-only.
- Evidence:
  - Curiosity repair: `output/noe-runtime-repair/20260619-curiosity-backlog-v1/evidence.json`; refreshed runtime evidence `output/noe-runtime-evidence/runtime-evidence-1781875371691.json`.
  - Affect repair: `output/noe-runtime-repair/20260619-affect-health-v1/scratch-evidence.json`; refreshed runtime evidence `output/noe-runtime-evidence/runtime-evidence-1781876102236.json`.
  - Latest runtime evidence now reports `blockers:[]`; final recheck path is `output/noe-runtime-evidence/runtime-evidence-1781876769051.json`.
- Review gates:
  - Curiosity: Locke subagent approved with caveats; Codex/Claude/M3 ledger `output/noe-multimodel/20260619-curiosity-backlog-repair-v1/ledger.json` reached `consensus_passed`.
  - Affect: Euler subagent approved with caveats; Codex/Claude/M3 ledger `output/noe-multimodel/20260619-affect-health-repair-v1/ledger.json` reached `consensus_passed`.
- Remaining blocker:
  - `voice_ear_acceptance_requires_owner_ear_review`
- Caveats:
  - Curiosity harvest is no longer missing, but the created surprise goal still reports `research_not_completed`; do not claim the full curiosity learning loop is complete.
  - Affect runtime-audit blocker is closed, but D5 remains `partial` with `backdoor_detection_not_measured_here`, and strict affect health still has `affect_saturation_high`.
  - The remaining owner voice ear blocker requires human listening; it is not closed by runtime evidence alone.

### Planning Sync: final closeout evidence reconciled
- **Status:** complete for planning sync; underlying final status remains `PASS_WITH_OPEN_BLOCKERS`.
- **Updated:** 2026-06-19T20:57:31+0800.
- Actions taken:
  - Re-read current repo state for Neo, Hermes, and OpenClaw before trusting earlier summaries.
  - Verified the planning file was stale: it still said F3 was next even though F3, F4, and final closeout artifacts already existed.
  - Re-read final closeout evidence:
    - `output/noe-full-function-real-machine/20260619/FINAL-closeout-evidence.md`
    - `output/noe-full-function-real-machine/20260619/FINAL-subagent-closeout.md`
    - `output/noe-full-function-real-machine/20260619/F3-tools-mcp-external-evidence.md`
    - `output/noe-full-function-real-machine/20260619/F4-ui-e2e-social-voice-evidence.md`
    - `output/noe-full-function-real-machine/20260619/F4-gate-result.md`
  - Re-verified the relevant ledgers:
    - `20260619-full-function-F3-tools-mcp-external-v1`: PASS, approvals `3/2`.
    - `20260619-full-function-F4-ui-e2e-social-voice-v1`: PASS, approvals `3/2`.
    - `20260619-final-closeout-pass-with-open-blockers-v1`: PASS, approvals `3/2`.
  - Updated `task_plan.md` so Phase 6 reflects F3/F4/final closeout completion and preserved the five open blockers known at that time. This was superseded by the later runtime blocker repair track above.
- Evidence interpretation:
  - F3 proves scoped tools/MCP/external readiness, not arbitrary MCP operation safety or all optional provider availability.
  - F4 proves UI/e2e/social-readiness/voice-programmatic coverage, not social fill/upload/publish readiness or owner-approved final voice quality.
  - Final closeout proves runtime substrate and stage matrix readiness with caveats, not unconditional full Neo health.
- Remaining blockers at that time; the two runtime blockers were later closed by the repair track above, and the two Xiaohongshu blockers were later closed by the live publish/delete repair:
  - `xiaohongshu_publish_editor_not_ready`
  - `social_dom_probe_did_not_fill_upload_or_publish`
  - `voice_ear_acceptance_requires_owner_ear_review`
- Next:
  - Wait for the two read-only subagent audits started after this sync: one completion-audit explorer and one Phase 1 Hermes/OpenClaw coverage explorer.
  - If they confirm no P0/P1 planning mismatch, continue either Phase 1 source-provenance hardening or a separate blocker-repair track.

### Subagent Follow-Up: completion audit and Phase 1 coverage
- **Status:** complete for this follow-up; no P0 found.
- Agents:
  - Aquinas `019edff4-c678-7b21-ba6a-4f334dd84d54`: verdict `pass_with_open_blockers`.
  - Pasteur `019edff4-c73b-79f2-95db-14903a7fa1e0`: verdict `pass_with_followups`.
- Aquinas findings applied:
  - Keep final status as `PASS_WITH_OPEN_BLOCKERS`, not unconditional PASS.
  - Preserve the five blockers known at that time; this was later superseded by the runtime repair track that closed `curiosity_harvest_missing` and `affect_health_below_target`.
  - Do not claim F1 M3 approval: F1 v3 ledger passed, but M3 was available and abstained.
  - Do not claim old F0 matrix F5/F6/F7 were completed as independent same-name artifact packages; current evidence is F1-F4 plus final closeout.
- Pasteur findings applied:
  - Phase 1 required topics are covered.
  - PLAN/EVIDENCE needed OpenClaw source-path evidence rather than summary bullets only.
  - Added OpenClaw per-topic source evidence for skills/workshop, memory dreaming, tool planner, MCP config, before_tool_call/trusted policy, sandbox/runtime config, and plugin/provenance boundaries.
  - Updated Phase 1 status to `pass_with_followups`.
- Files updated:
  - `.planning/2026-06-19-hermes-openclaw-self-evolution/task_plan.md`
  - `.planning/2026-06-19-hermes-openclaw-self-evolution/progress.md`
  - `docs/PLAN_2026-06-19_Hermes_OpenClaw_自进化蒸馏总路线.md`
  - `docs/EVIDENCE_2026-06-19_Hermes_OpenClaw_自进化阶段0.md`

### Multi-Model Gate: planning sync and Phase 1 source table
- **Status:** complete; consensus passed.
- Round: `20260619-planning-sync-phase1-source-table-v1`.
- Evidence: `output/noe-multimodel/20260619-planning-sync-phase1-source-table-v1/evidence.md`.
- Ledger: `output/noe-multimodel/20260619-planning-sync-phase1-source-table-v1/ledger.json`.
- Result:
  - `consensus_passed`.
  - Codex: `approve`.
  - Claude: `approve_with_changes`.
  - M3: `approve`.
  - `parseErrors=[]`.
  - dynamic quorum: available `3`, threshold `2`, approvals `3`.
  - Ledger verifier passed: `approvals=3/2`.
- M3 profile:
  - model `MiniMax-M3`.
  - `thinking.type=adaptive`.
  - `maxCompletionTokens=524288`.
  - `reasoningSplit=true`.
  - `serviceTier=priority`.
  - `noAbort=true`.
- Follow-ups applied after gate:
  - Added explicit distinction that `/api/noe/readiness blockers:[]` only proves readiness-route health and does not close the five final acceptance blockers.
  - Confirmed OpenClaw source-path evidence with a 17-file symbol check: `ok:true`, `checked:17`, `failed:[]`.
  - Re-probed live `51835`: `/health ok:true`, PID `48574`; `/api/noe/readiness ok:true`, readiness `passed`, blockers `[]`.
  - Re-verified F3, F4, and final closeout ledgers; all passed.
- Scope remains unchanged:
  - This gate approves documentation/evidence synchronization only.
  - It does not authorize implementation, self-code execution, patch apply, commit, push, publish, memory-v2/SkillStore/GraphMemory writeback, or live `51835` mutation.

### Round Quality Memory v3: 多模型/子代理模式强化
- **Status at that time:** complete for first slice; full-function real-machine testing still pending then. Later F1-F4 and final closeout completed as `PASS_WITH_OPEN_BLOCKERS`; see the planning-sync entry above.
- Actions taken:
  - Asked Rawls and Dalton to review recent B/C/D/E multi-model + subagent operating results and propose token-expensive quality improvements.
  - Implemented automatic round support files in `src/room/NoeConsensusRunner.js`: `evidence.md`, `evidence-pack.md`, `disagreements.md`, `staleness-ledger.md`, `verifier-notes.md`, and `final-handoff.md`.
  - Added `manifest.supportFiles`, `manifest.evidenceTextRef`, `manifest.evidenceSha256`, and `ledger.artifacts[]` item `round_support_files` with `countedInConsensus:false`.
  - Added evidence-text redaction before model prompts/shared docs, raw-output redaction in `buildNoeConsensusLedgerFromRawOutputs`, visible `NOE_CONSENSUS_REDACTION_POLICY_SUMMARY`, and redaction policy sections in generated support files.
  - Hardened `scripts/noe-consensus-round-assemble.mjs` with safe refs for evidence/raw/out-dir and made safe-ref checks unit-testable.
  - Added active-executor unavailable gate behavior so a selected writer returning `decision:"unavailable"` blocks the round, while an unavailable non-writer Codex does not retain writer authority under a Claude executor.
  - Updated `docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md` and `docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md`.
  - Ran true Codex/Claude/M3 gates `20260619-round-quality-memory-v1`, `v2`, and final `v3`; `v3` passed 3/3 with `parseErrors=[]`, validation `ok=true`, and ledger verifier PASS.
  - Ran positive assemble safe-ref smoke `20260619-assemble-safe-ref-positive`; ledger verifier PASS.
- Verification:
  - `npm run test:noe:consensus`: 9 files / 143 tests passed.
  - `npm run verify:noe:final-stage-matrix`: 1 file / 9 tests passed; B/C/D/E completed.
  - `node scripts/noe-consensus-ledger-verify.mjs --ledger output/noe-multimodel/20260619-round-quality-memory-v3/ledger.json --require-evidence --require-artifacts --require-passed`: PASS.
  - `node scripts/noe-consensus-ledger-verify.mjs --ledger output/noe-multimodel/20260619-assemble-safe-ref-positive/ledger.json --require-evidence --require-artifacts --require-passed`: PASS.
- Follow-ups from v3 models:
  - Add `claims.json` and `verifier-notes.json`.
  - Enforce machine TTL/staleness expiry at gate time.
  - Add structured `NoeConsensusEvidencePack` schema/CLI.
  - Record subagent outputs as ledger artifacts.
  - Add same-model repair provenance to vote fields.

### Full-Function Real-Machine F1: core runtime/readiness
- **Status at that time:** complete for F1 narrow gate; full Neo function testing still in progress then. Later F2/F3/F4 and final closeout completed as `PASS_WITH_OPEN_BLOCKERS`; see the planning-sync entry above.
- Actions taken:
  - Built `output/noe-full-function-real-machine/20260619/F0-full-function-test-matrix.md` to split full-function testing into F1-F7 and preserve boundaries.
  - Ran F1 live/read-only checks: `check:panel`, `GET /health`, `GET /api/noe/readiness`, `doctor:noe:lint`, `verify:noe:runtime-evidence`, `verify:noe:100-readiness`, and `verify:noe:full-current -- --include-live --ack-read-owner-token`.
  - Preserved caveats: `curiosity_harvest_missing`, `affect_health_below_target`, `obsidian_mcp_readiness`, `external_readiness`, dirty worktree warning, and no this-run restart proof.
  - Rawls and Dalton reviewed F0/F1 evidence: P0/P1 none; both allowed F1 gate only for the narrow core runtime/readiness claim.
  - Confirmed MiniMax-M3 official thinking controls: M3 supports `thinking.type=adaptive` as thinking-on and `disabled` as no-think; `reasoning_split` is output separation only. Raised formal exhaustive M3 profile to `maxCompletionTokens=524288`, `serviceTier=priority`, `reasoningSplit=true`, `noAbort=true`.
  - Fixed a newly introduced M3 runner regression where `qualityProfile` was not passed to `runBuiltInParticipant`, which would have made M3 unavailable. Focused runner test now proves the real M3 request body contains `thinking:{type:"adaptive"}`, `max_completion_tokens:524288`, `service_tier:"priority"`.
  - Hardened `NoeConsensusGate`: selected active executor must explicitly approve; active executor abstain/reject/unavailable blocks continuation even if dynamic quorum passes.
  - Ran F1 gates:
    - `20260619-full-function-F1-core-runtime-v1`: passed, superseded by M3 max profile.
    - `20260619-full-function-F1-core-runtime-v2`: initially passed before hardening, but Codex active executor abstained; now intentionally fails verifier with `active_executor_must_approve:codex`.
    - `20260619-full-function-F1-core-runtime-v3`: accepted current F1; Codex active executor approve + Claude approve, M3 available but abstain due same-round visibility boundary; verifier PASS under new rule.
- Verification:
  - `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-consensus-runner.test.js`: 27 tests passed.
  - `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/minimax-suggestion-pipeline.test.js`: 10 tests passed.
  - `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-consensus-active-executor-gate.test.js tests/unit/noe-consensus-gate.test.js tests/unit/noe-consensus-runner.test.js`: 54 tests passed.
  - `npm run test:noe:consensus`: 9 files / 143 tests passed.
  - `npm run verify:noe:consensus-ledger -- --ledger output/noe-multimodel/20260619-full-function-F1-core-runtime-v3/ledger.json --require-evidence --require-artifacts --require-passed`: PASS.
  - `npm run verify:noe:consensus-ledger -- --ledger output/noe-multimodel/20260619-full-function-F1-core-runtime-v2/ledger.json --require-evidence --require-artifacts --require-passed`: expected FAIL after hardening with `active_executor_must_approve:codex` and `stored_gate_result_is_stale`.
- Next:
  - Continue F2 memory/cognition/readiness and F3 tools/MCP/external readiness with the same stage pattern: real-machine probe, subagent review, Codex/Claude/M3 gate, verifier pass.

### Phase 0: 统一基线
- **Status:** complete
- **Started:** 2026-06-19
- Actions taken:
  - Read current handoff: `docs/HANDOFF_2026-06-19_代码蒸馏OpenClaw_SSRF链接理解Skill扫描.md`.
  - Restored memory context for Neo/OpenClaw/Hermes distillation and self-evolution research.
  - Verified real repo paths and git state for Neo, Hermes, OpenClaw.
  - Started three read-only explorer subagents for Neo, Hermes, OpenClaw.
  - Created dedicated planning directory for this goal.
- Files created/modified:
  - `.planning/.active_plan`
  - `.planning/2026-06-19-hermes-openclaw-self-evolution/task_plan.md`
  - `.planning/2026-06-19-hermes-openclaw-self-evolution/findings.md`
  - `.planning/2026-06-19-hermes-openclaw-self-evolution/progress.md`

### Phase 1: Hermes / OpenClaw 只读蒸馏
- **Status:** in_progress
- Actions taken:
  - Spawned read-only Neo explorer subagent.
  - Spawned read-only Hermes explorer subagent.
  - Spawned read-only OpenClaw explorer subagent.
  - Ran read-only model health check and phase-0 consensus gate.
  - Ran read-only 51835 readiness, process, doctor, model key, and retrieval-log probes.
  - Wrote stage-0 evidence index.
  - Wrote NeoEval schema draft and eval layer directory structure.
  - Closed completed subagents; interrupted and closed the original slow Hermes subagent; used a narrower Hermes quick-review subagent instead.
  - Attempted NeoEval schema multi-model gate; Claude CLI hung, so the local audit process was terminated and the gate remains incomplete.
  - Implemented NeoEval validator, targeted unit tests, and one sanitized dev smoke fixture to address the Codex gate blockers.
  - Read the OpenClaw SSRF/link-understanding/skill-scan handoff and resumed under the per-task subagent + multi-model review rule.
  - Terminated the stuck `20260619-neoeval-validator-gate` local audit process after it produced no output; no runtime service was killed.
  - Expanded NeoEval dev fixtures to cover four source kinds: `real_replay`, `memory_retrieval_log`, `synthetic_guard`, and `incident_regression`.
  - Added same-batch case/run/score cross-consistency checks and score summary/status consistency checks.
  - Ran a read-only subagent review; result: pass, P0 none, P1 none, P2 addressed or documented.
  - Started final multi-model gate `20260619-neoeval-validator-final-gate`; Codex raw vote approved, but the runner did not advance to Claude/M3 before the outer timeout. No quorum ledger was produced.
  - Recovered the final gate by preserving Codex raw output, running Claude and M3 raw reviews separately, then assembling with `npm run noe:consensus:assemble`; result: valid ledger, 3/3 approvals.
  - Added `scripts/noe-eval-collect-replay-cases.mjs`.
  - Generated 40 sanitized `real_replay` dev cases from existing `output/noe-real-use-replay/*.json` artifacts plus `run-replay-collection-001` and `score-replay-collection-001`.
  - Kept collection score blocked with `evaluator_not_connected_yet`; this records collection only, not real candidate scoring.
  - Fixed validator private_holdout discipline: `evals/neo/private_holdout/*.json` is rejected by path before any file read/JSON parse.
  - Strengthened the regression test to cover missing private_holdout JSON, proving the validator rejects by path before file reads.
  - Drafted Neo Runtime Trace read-only audit/design for `observe -> can_execute -> act -> verify -> learn`.
  - Ran a read-only subagent review for Runtime Trace entrypoints; result: pass for design direction, with P0 guardrails around append-only, fail-open, no raw payload, no memory-v2, and no live `51835` operations.
  - Ran a high-signal secret scan over the Runtime Trace design and planning files; result: no matches.
  - Ran Runtime Trace design multi-model gate `20260619-runtime-trace-design-gate`; result: valid ledger, 3/3 approvals, authorized only Slice B append-only trace writer + read-only snapshot implementation.
  - Accepted M3 gate constraints for Slice B: fault-injection fail-open tests, sanitized golden record, async/bounded writer behavior, rotation/retention policy, static no-import checks for security/permissions/webhook/private_holdout paths, and no raw prompt/memory/lesson/body fields.
  - Implemented Slice B without runtime hooks: append-only runtime trace writer, read-only snapshot CLI, golden fixture, and focused unit tests.
  - Wrote one sanitized manual smoke trace to `output/noe-runtime-trace/runtime-trace-2026-06-19.jsonl`.
  - Ran runtime trace snapshot dry-run; result: `ok:true`, `recordsScanned:1`, `violations:[]`, no live `51835` access.
  - Re-ran unit tests, NeoEval artifact validator, no-touch import scan, high-signal secret scan, and private_holdout JSON count.
  - Ran Slice B implementation subagent review; result: P0 none, P1 found two blockers: private_holdout path invariant was incomplete, and raw payload could be hidden under safe metric keys.
  - Fixed both P1 blockers: writer/reader/snapshot outDir now reject `evals/neo/private_holdout` and path escapes; metric strings now redact raw prompt/stdout/stderr/DOM/body/lesson/card markers and long prose-like values.
  - Added coverage for hidden-set input/output rejection, path escaping, safe-key raw payload redaction, concurrent queue order, and rotation behavior.
  - Ran final read-only subagent re-review; result: P0 none, P1 none, previous blockers closed, cleared for multi-model final review.
  - Ran Runtime Trace Slice B final multi-model gate `20260619-runtime-trace-slice-b-final-gate`; result: valid ledger, 3/3 approvals. The gate preserves Slice B as evidence substrate only and does not authorize runtime hooks.
  - Started baseline audit subagents for memory/retrieval, act/tool/runtime/permission, and prompt-injection/SSRF/tool-poisoning surfaces.
  - Added `scripts/noe-baseline-audit.mjs`, a read-only aggregate baseline script over `panel.db` plus optional readiness GET.
  - Ran baseline audit with live readiness; generated `output/noe-baseline-audit/latest.json` and `output/noe-baseline-audit/latest.md`.
  - Wrote `docs/BASELINE_2026-06-19_Neo_证据底座基线审计.md`.
  - Ran targeted security tests for SSRF / img-cache SSRF / tool safety / marketplace / skill draft paths.
  - Enhanced baseline audit with selected-vs-inferred-dropped ranking proxy, `noe.tool.invoked` event aggregation, `permission.decision` event aggregation, and read-only live `/health` plus protected acts GET probe.
  - Updated baseline doc with current metrics, explicit live-proof limits, and P1 follow-up list for remote plugin/MCP SSRF guard coverage, MCP stdio env inheritance, link-understanding prompt-injection eval coverage, skill-scan behavior, skill body route auth classification, and MCP Aggregator permission hook coverage.
  - Added the user's per-stage hard gate to the task plan: every stage needs stage-matched real-machine testing, followed by multi-model plus subagent conclusions/recommendations. For the current read-only baseline stage, the real-machine test is constrained to live read-only probes, read-only DB aggregation, and real local command/test execution.
  - Ran enhanced baseline multi-model gate `20260619-baseline-audit-gate`; result: valid ledger, Codex/Claude/M3 approvals 3/3. The gate approves only the read-only baseline evidence substrate and explicitly does not authorize runtime hooks, live action execution, self-code execution, 51835 restart/takeover, memory-v2 writes, or private_holdout reads.
  - Ran enhanced baseline subagent review with Halley; result: P0 none, P1 none, P2 doc-sync follow-ups found and fixed. Gate recommendation: `pass_with_followups`; scope remains read-only baseline evidence substrate only.
  - Started Phase 3 memory/skill candidate gate v1.
  - Added `src/candidates/NoeMemorySkillCandidateGate.js`, a candidate-only gate requiring source episode, evidence refs, test evidence, rollback plan, and private holdout result metadata.
  - Added `src/candidates/NoeMemorySkillCandidateInputs.js`, an optional metadata-only adapter for existing memory pending / skill draft queues. It is only used when CLI is passed `--from-existing-queues`.
  - Added `scripts/noe-memory-skill-candidate-gate.mjs`, defaulting to sanitized smoke candidates and writing only `output/noe-candidate-gate/**`.
  - Added `tests/unit/noe-memory-skill-candidate-gate.test.js`.
  - Added `docs/DESIGN_2026-06-19_Neo_Phase3_MemorySkillCandidateGate.md`.
  - Added `verify:noe:memory-skill-candidate-gate` script.
  - Ran syntax checks, unit tests, verify script, CLI smoke, explicit existing-queue metadata path, and related memory/skill candidate regressions for candidate gate v1.
  - Ran Bernoulli subagent review for candidate gate v1; result: fail. P0/P1/P2 blockers were missing enforcement for memory-v2/live action/runtime hook/restart/self-code, missing mandatory `candidateId`, too-narrow sensitive ref blocking, and unbounded CLI input/output paths.
  - Fixed the candidate gate and CLI/input adapters to reject global candidate-only violations, require `candidateId`, block `.env*` / owner token / private holdout / `file:` / URL-encoded escapes before file reads, and require CLI `--out-dir` to stay under repo `output/`.
  - Removed the evaluator's legacy `id` fallback so `candidateId` is genuinely mandatory; input adapters remain responsible for normalizing older queue IDs before gate evaluation.
  - Re-ran syntax checks, `npm run verify:noe:memory-skill-candidate-gate`, related memory/skill/evolution candidate regressions, existing-queue metadata mode, and CLI negative cases for `.env.local` and outside-repo outDir.
  - Ran final read-only subagent review with Dirac; result: `pass_with_followups`, P0 none, P1 none. P2 asked for repo-inside non-`output/` `--out-dir` coverage, which was added and verified with `docs/noe-candidate-gate`.
  - Ran final multi-model gate `20260619-memory-skill-candidate-gate` without external timeout or model abort; result: `consensus_passed`, Codex approve, Claude approve_with_changes, M3 approve, approvals 3/3, ledger valid.
  - Started Phase 3 memory utility learning lite as a read-only/candidate-log slice.
  - Added `src/memory/NoeMemoryUtilityLite.js`, aggregating retrieval selected IDs, inferred dropped IDs, hidden/expired metadata, hit counts, salience, confidence, source episode presence, and cold zero-hit signals without memory body output.
  - Added `scripts/noe-memory-utility-lite.mjs`, defaulting to read-only `~/.noe-panel/panel.db` and writing reports only under `output/noe-memory-utility-lite/**`.
  - Added `tests/unit/noe-memory-utility-lite.test.js`, including salience>=5 protected review behavior and CLI boundary tests.
  - Added `docs/DESIGN_2026-06-19_Neo_Phase3_MemoryUtilityLite.md` and `output/noe-multimodel/20260619-memory-utility-lite/evidence.md`.
  - Ran syntax checks, `npm run verify:noe:memory-utility-lite`, related memory regressions, real DB read-only CLI, CLI negative probes, no-body-field scan, private_holdout count, secret scan, and whitespace checks.
  - Ran Feynman read-only review; result: `design_pass_with_followups`. Added/recorded static no-import/no-write scan and extra `output/noe-memory-utility-lite-smoke` real DB smoke per review.
  - Ran final multi-model gate `20260619-memory-utility-lite` without external timeout or model abort; result: `consensus_passed`, Codex approve, Claude approve, M3 approve, approvals 3/3, ledger valid.
- Files created/modified:
  - `docs/PLAN_2026-06-19_Hermes_OpenClaw_自进化蒸馏总路线.md`
  - `docs/EVIDENCE_2026-06-19_Hermes_OpenClaw_自进化阶段0.md`
  - `docs/NEOEVAL_SCHEMA_2026-06-19.md`
  - `evals/neo/README.md`
  - `evals/neo/dev/.gitkeep`
  - `evals/neo/regression/.gitkeep`
  - `evals/neo/private_holdout/README.md`
  - `evals/neo/private_holdout/.gitignore`
  - `src/eval/NeoEvalSchema.js`
  - `scripts/noe-eval-validate.mjs`
  - `tests/unit/noe-eval-schema.test.js`
  - `evals/neo/dev/case-memory-retrieval-smoke-001.json`
  - `evals/neo/dev/case-real-replay-smoke-001.json`
  - `evals/neo/dev/case-synthetic-guard-smoke-001.json`
  - `evals/neo/dev/case-incident-regression-smoke-001.json`
  - `evals/neo/dev/run-schema-smoke-001.json`
  - `evals/neo/dev/score-schema-smoke-001.json`
  - `scripts/noe-eval-collect-replay-cases.mjs`
  - `tests/unit/noe-eval-validator-cli.test.js`
  - `evals/neo/dev/case-real-replay-001.json` ... `evals/neo/dev/case-real-replay-040.json`
  - `evals/neo/dev/run-replay-collection-001.json`
  - `evals/neo/dev/score-replay-collection-001.json`
  - `docs/DESIGN_2026-06-19_Neo_RuntimeTrace_只读审计与首版方案.md`
  - `src/runtime/NoeRuntimeTrace.js`
  - `scripts/noe-runtime-trace-snapshot.mjs`
  - `tests/unit/noe-runtime-trace.test.js`
  - `tests/fixtures/noe-runtime-trace/golden-runtime-trace.json`
  - `scripts/noe-baseline-audit.mjs`
  - `docs/BASELINE_2026-06-19_Neo_证据底座基线审计.md`

## Test Results
| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Neo repo baseline | `git rev-parse/status`, `package.json` version | Real path, branch, HEAD, dirty files, version | Path `/Users/hxx/Desktop/Neo 贾维斯`; branch `noe-main`; HEAD `0063d9df1ebc`; dirty `M AGENTS.md`; version `2.1.0` | pass |
| Hermes repo baseline | `git rev-parse/status`, package/pyproject versions | Real path, branch, HEAD, dirty files, versions | Path `/Users/hxx/Documents/Claw系audit_2026-06-09/hermes-agent`; branch `main`; HEAD `25c590ccd0c8`; dirty `?? .unity/`; versions `1.0.0` and `0.16.0` | pass |
| OpenClaw repo baseline | `git rev-parse/status`, `package.json` version | Real path, branch, HEAD, dirty files, version | Path `/Users/hxx/Documents/Claw系audit_2026-06-09/openclaw`; branch `main`; HEAD `81eaa88ce56d`; dirty `?? .unity/`; version `2026.6.8` | pass |
| 51835 readiness | `curl -sS --max-time 5 http://127.0.0.1:51835/api/noe/readiness` | Read-only status, no restart | `ok:true`, readiness `passed`, blockers `[]` | pass |
| Doctor lint | `npm run doctor:noe:lint` | Read-only local lint/diagnostic | ok `true`, status `warn`, warning is dirty worktree classification | pass |
| Model keys | `npm run noe:keys:model:check` | No secret values printed | MiniMax/Xiaomi ok from keychain; Gemini/OpenAI/Anthropic unconfigured | pass |
| Model health | `npm run verify:noe:model-health` | Read-only model health, no chat calls | LM Studio/Ollama/MiniMax/Xiaomi reachable; Gemini/OpenAI/Anthropic unavailable | pass |
| Phase 0 consensus | `npm run noe:consensus:round -- --round-id 20260619-phase0-route-gate --run-models --ack-cost ...` | Multi-model gate result | `consensus_passed`; Codex/Claude/M3 all `approve_with_changes`; ledger valid | pass |
| New-doc secret scan | `rg` secret/key/token patterns over new docs/planning files | No raw secrets | no matches | pass |
| External-code snippet scan | fenced block + code keyword scan over new docs/planning files | No copied external source snippets | only one bash command block in evidence doc; no code-keyword matches | pass |
| NeoEval schema secret scan | `rg` secret/key/token patterns over NeoEval schema and eval dirs | No raw secrets | no matches | pass |
| Private holdout structure | `find evals/neo -maxdepth 3 -type f` | Structure only, no cases | README/.gitkeep/.gitignore only | pass |
| Hermes quick-review subagent | `multi_agent_v1` explorer on narrowed Hermes files | First Hermes gap table | completed with P0/P1/P2 recommendations | pass |
| NeoEval validator tests | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-eval-schema.test.js` | Validator behavior covered | 1 file / 7 tests passed | pass |
| NeoEval validator smoke | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-eval-validate.mjs` | Validate committed smoke fixtures | checked 6, failed 0 | pass |
| NeoEval artifact check | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-eval-validate.mjs --check-artifacts evals/neo/dev/*.json` | Source artifacts exist | checked 6, failed 0 | pass |
| NeoEval subagent review | `multi_agent_v1` explorer Linnaeus, read-only | Independent review before next task | pass; P0 none, P1 none; P2 fixed/documented | pass |
| NeoEval final multi-model gate | `npm run noe:consensus:round -- --round-id 20260619-neoeval-validator-final-gate --run-models --ack-cost ...` | Codex/Claude/M3 gate before case采集 | blocked: Codex raw approve saved, but runner timed out before Claude/M3; no ledger/quorum | fail |
| NeoEval final gate recovery | `npm run noe:consensus:assemble -- --round-id 20260619-neoeval-validator-final-gate ...` | Use three raw model outputs and validate ledger | ok true; Codex/Claude/M3 approvals 3/3; ledger `output/noe-multimodel/20260619-neoeval-validator-final-gate/ledger.json` | pass |
| Replay case collection | `node scripts/noe-eval-collect-replay-cases.mjs --limit=40` | Generate 30-50 sanitized real replay cases | generated 40 cases; policy runtimeTouched=false, memoryV2Writes=false, liveRestart=false, privateHoldoutTouched=false | pass |
| Replay collection validator | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-eval-validate.mjs` | All eval JSON valid | checked 48, failed 0 | pass |
| Replay collection artifact check | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-eval-validate.mjs --check-artifacts evals/neo/dev/*.json` | All evidence refs exist | checked 48, failed 0 | pass |
| Replay collection secret scan | `rg` secret/key/token patterns over NeoEval schema/validator/collector/evals/docs/planning | No raw secrets | no matches | pass |
| Private holdout no-read regression | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-eval-schema.test.js tests/unit/noe-eval-validator-cli.test.js` | Reject invalid and missing private_holdout JSON before reading/parsing | 2 files / 9 tests passed | pass |
| Private holdout validator gate | `npm run noe:consensus:assemble -- --round-id 20260619-private-holdout-validator-gate ...` | Multi-model gate for no-read fix | ok true; Codex/Claude/M3 approvals 3/3; ledger `output/noe-multimodel/20260619-private-holdout-validator-gate/ledger.json` | pass |
| Runtime Trace design subagent review | `multi_agent_v1` explorer Darwin, read-only | Independent review of runtime trace entrypoints and no-touch zones | pass; source-only audit; no file edits; no `51835`; no memory-v2 writes; P0/P1 risks documented | pass |
| Runtime Trace design secret scan | high-signal `rg` over design/planning files | No raw secrets | no matches | pass |
| Runtime Trace design multi-model gate | `npm run noe:consensus:assemble -- --round-id 20260619-runtime-trace-design-gate ...` | Authorize only append-only trace writer + snapshot Slice B | ok true; Codex/Claude/M3 approvals 3/3; ledger `output/noe-multimodel/20260619-runtime-trace-design-gate/ledger.json` | pass |
| Runtime Trace implementation subagent review | `multi_agent_v1` explorer Raman, read-only | Independent Slice B implementation review | initial fail; P0 none; P1 private_holdout path invariant and raw-payload safe-key bypass fixed after review; final re-review P0/P1 none | pass |
| Runtime Trace unit tests | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-runtime-trace.test.js` | Schema, redaction, fail-open, path invariant, JSONL snapshot, no-touch imports, queue/rotation | 1 file / 8 tests passed | pass |
| Runtime Trace + NeoEval regression tests | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-runtime-trace.test.js tests/unit/noe-eval-schema.test.js tests/unit/noe-eval-validator-cli.test.js` | New trace code does not regress eval/private_holdout validator | 3 files / 17 tests passed | pass |
| Runtime Trace snapshot dry-run | `node scripts/noe-runtime-trace-snapshot.mjs --require-trace --limit 50` | JSONL-only aggregation, no live runtime dependency | ok true; recordsScanned 1; blockers []; violations []; latest `output/noe-runtime-trace/latest.json` | pass |
| Runtime Trace hidden input rejection | `node scripts/noe-runtime-trace-snapshot.mjs --input-dir evals/neo/private_holdout --out-dir output/noe-runtime-trace-hidden-probe --limit 1` | Reject before reading private_holdout | exit 1; error `NOE_RUNTIME_TRACE_PRIVATE_HOLDOUT_FORBIDDEN`; recordsScanned 0 | pass |
| Runtime Trace hidden output rejection | `node scripts/noe-runtime-trace-snapshot.mjs --input-dir output/noe-runtime-trace --out-dir evals/neo/private_holdout --limit 1` | Reject before writing private_holdout | exit 1; error `NOE_RUNTIME_TRACE_PRIVATE_HOLDOUT_FORBIDDEN`; no reportPath emitted | pass |
| Runtime Trace Slice B final multi-model gate | `npm run noe:consensus:assemble -- --round-id 20260619-runtime-trace-slice-b-final-gate ...` | Final review of append-only writer + JSONL snapshot only; no hook authorization | ok true; Codex/Claude/M3 approvals 3/3; ledger `output/noe-multimodel/20260619-runtime-trace-slice-b-final-gate/ledger.json` | pass |
| Runtime Trace no-touch import scan | `rg` import scan over `src/runtime/NoeRuntimeTrace.js` and `scripts/noe-runtime-trace-snapshot.mjs` | No imports from `src/security`, `src/permissions`, `src/webhook`, or private_holdout paths | no matches | pass |
| Runtime Trace secret scan | high-signal `rg` over new trace source/tests/fixture/output plus design/planning files | No raw secrets | no matches | pass |
| Private holdout JSON count | `find evals/neo/private_holdout -name '*.json' -type f -print | wc -l` | No committed holdout JSON | 0 | pass |
| Baseline audit live run | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-baseline-audit.mjs --probe-live` | Read-only DB aggregation plus readiness GET | ok true; blockers []; retrievalRows 606; selectedRowRate 87.46%; toolPassedRate 96.96%; actCompletedRate 96.15%; liveReadinessOk true | pass |
| Baseline audit no-live run | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-baseline-audit.mjs --out-dir output/noe-baseline-audit-no-live-check` | Reproducible without touching 51835 | ok true; blockers []; liveReadinessOk null | pass |
| Baseline audit syntax | `node --check scripts/noe-baseline-audit.mjs` | Syntax valid | pass | pass |
| Baseline audit enhanced live run | `node --check scripts/noe-baseline-audit.mjs && node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-baseline-audit.mjs --probe-live` | Enhanced selected/dropped, permission, tool event, health/readiness/protected acts aggregation | ok true; blockers []; selected/inferredDropped mentions 2245/1263; permission decisions allow 4664 / deny 2117 / ask 1193; live health/readiness/protected acts true/true/true | pass |
| Baseline audit enhanced no-live run | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-baseline-audit.mjs --out-dir output/noe-baseline-audit-no-live-check` | Enhanced aggregation without touching 51835 | ok true; blockers []; liveHealthOk null; protectedActsRouteAuth null | pass |
| Baseline security targeted tests | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/ssrf-guard.test.js tests/unit/routes/img-cache-ssrf.test.js tests/unit/noe-p0-tool-safety.test.js tests/unit/noe-tool-marketplace-registry.test.js tests/unit/noe-skill-draft-apply.test.js` | SSRF/tool/skill guard tests pass | 5 files / 58 tests passed | pass |
| Baseline regression tests | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-runtime-trace.test.js tests/unit/noe-eval-schema.test.js tests/unit/noe-eval-validator-cli.test.js` | Trace/Eval regressions remain green | 3 files / 17 tests passed | pass |
| Baseline secret scan | high-signal `rg` over baseline script/output/doc | No raw secrets | no matches | pass |
| Baseline enhanced security targeted tests | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/ssrf-guard.test.js tests/unit/routes/img-cache-ssrf.test.js tests/unit/noe-p0-tool-safety.test.js tests/unit/noe-tool-marketplace-registry.test.js tests/unit/noe-skill-draft-apply.test.js` | SSRF/tool/skill guard tests still pass after enhanced baseline report | 5 files / 58 tests passed | pass |
| Baseline enhanced regression tests | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-runtime-trace.test.js tests/unit/noe-eval-schema.test.js tests/unit/noe-eval-validator-cli.test.js` | Trace/Eval regressions still green after enhanced baseline report | 3 files / 17 tests passed | pass |
| Baseline enhanced secret scan | high-signal `rg` over enhanced baseline script/output/doc/planning | No raw secrets | no matches | pass |
| Baseline enhanced diff whitespace check | `git diff --check -- scripts/noe-baseline-audit.mjs docs/BASELINE_2026-06-19_Neo_证据底座基线审计.md docs/PLAN_2026-06-19_Hermes_OpenClaw_自进化蒸馏总路线.md .planning/2026-06-19-hermes-openclaw-self-evolution/task_plan.md .planning/2026-06-19-hermes-openclaw-self-evolution/progress.md output/noe-multimodel/20260619-baseline-audit-gate/evidence.md` | No whitespace errors | pass | pass |
| Baseline enhanced gate secret scan | high-signal `rg` over enhanced baseline script/output/doc/planning and gate output | No raw secrets | no matches | pass |
| Baseline enhanced multi-model gate | `npm run noe:consensus:round -- --round-id 20260619-baseline-audit-gate --run-models --ack-cost --goal ... --evidence-file output/noe-multimodel/20260619-baseline-audit-gate/evidence.md` | Codex/Claude/M3 review; do not authorize runtime hook/live action/self-code/51835 restart/memory-v2/private_holdout | consensus_passed; ledger valid; approvals 3/3; threshold 2 | pass |
| Baseline enhanced subagent review | `multi_agent_v1` explorer Halley, read-only | Independent review of enhanced baseline, per-stage real-machine test gate, and multi-model ledger | P0 none; P1 none; P2 doc sync issues fixed; gate `pass_with_followups` | pass |
| Candidate gate syntax | `node --check src/candidates/NoeMemorySkillCandidateGate.js && node --check scripts/noe-memory-skill-candidate-gate.mjs` | New module/CLI syntax valid | pass | pass |
| Candidate gate syntax v2 | `node --check src/candidates/NoeMemorySkillCandidateGate.js && node --check src/candidates/NoeMemorySkillCandidateInputs.js && node --check scripts/noe-memory-skill-candidate-gate.mjs` | New gate/input/CLI syntax valid | pass | pass |
| Candidate gate unit tests | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-memory-skill-candidate-gate.test.js` | Candidate-only rules enforced for memory/skill, source/evidence/test/rollback/holdout required, private_holdout/sensitive refs rejected, queue input adapter omits bodies, no legacy `id` fallback | 1 file / 11 tests passed | pass |
| Candidate gate CLI smoke | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-skill-candidate-gate.mjs` | Stage-matched local smoke without live action/private_holdout read/memory-v2 write | ok true; 2 candidates passed; output `output/noe-candidate-gate/latest.json` | pass |
| Candidate gate verify script | `npm run verify:noe:memory-skill-candidate-gate` | Single entry for unit tests plus smoke report | 1 file / 11 tests passed; 2 candidates passed | pass |
| Candidate gate related regressions | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-memory-skill-candidate-gate.test.js tests/unit/noe-memory-candidate-review.test.js tests/unit/noe-memory-candidate-apply.test.js tests/unit/noe-memory-candidate-rollback.test.js tests/unit/noe-memory-candidate-chain-drill.test.js tests/unit/noe-memory-candidate-status.test.js tests/unit/noe-skill-draft-apply.test.js tests/unit/noe-skill-draft-rollback.test.js tests/unit/noe-evolution-candidate-gate.test.js` | New gate hardening does not regress existing memory/skill/evolution candidate flows | 9 files / 57 tests passed | pass |
| Candidate gate existing-queue metadata path | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-skill-candidate-gate.mjs --from-existing-queues --out-dir output/noe-candidate-gate-existing-queues` | Explicit queue metadata read only, no body output, no production writes | ok true; current queues empty; 0 candidates; inputErrors [] | pass |
| Candidate gate sensitive input negative | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-skill-candidate-gate.mjs --candidate-file .env.local --out-dir output/noe-candidate-gate-negative` | Reject sensitive candidate input before file read | exit 1; `candidate file references forbidden sensitive path: .env.local` | pass |
| Candidate gate outDir negative | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-skill-candidate-gate.mjs --out-dir /tmp/noe-candidate-gate-outside` | Reject outside-repo output before creating output dir | exit 1; `out-dir escapes repo: /tmp/noe-candidate-gate-outside` | pass |
| Candidate gate non-output outDir negative | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-skill-candidate-gate.mjs --out-dir docs/noe-candidate-gate` | Reject repo-inside but non-output report dir before creating output dir | exit 1; `out-dir must stay under output/: docs/noe-candidate-gate` | pass |
| Candidate gate final subagent review | Dirac read-only review | Independent confirmation before multi-model gate | `pass_with_followups`; P0/P1 none; P2 test gap addressed | pass |
| Candidate gate final multi-model gate | `npm run noe:consensus:round -- --round-id 20260619-memory-skill-candidate-gate --run-models --ack-cost ...` | Codex/Claude/M3 review; no live action/runtime hook/self-code/51835 restart/MemoryCore/SkillStore/memory-v2/private_holdout authorization | `consensus_passed`; approvals 3/3; ledger `output/noe-multimodel/20260619-memory-skill-candidate-gate/ledger.json` | pass |
| Candidate gate ledger targeted verify | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-consensus-ledger-verify.mjs --ledger output/noe-multimodel/20260619-memory-skill-candidate-gate/ledger.json --require-artifacts --require-evidence --require-passed` | Verify this ledger without historical-ledger noise | checked 1; failed 0; approvals 3/2 | pass |
| Memory utility lite syntax | `node --check src/memory/NoeMemoryUtilityLite.js && node --check scripts/noe-memory-utility-lite.mjs` | New module/CLI syntax valid | pass | pass |
| Memory utility lite verify | `npm run verify:noe:memory-utility-lite` | Unit tests plus real DB read-only report | 1 file / 2 tests passed; report ok true; top50 candidates generated | pass |
| Memory utility lite related regressions | `node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/noe-memory-utility-lite.test.js tests/unit/noe-memory-status.test.js tests/unit/noe-memory-candidate-status.test.js tests/unit/noe-memory-retrieval-sample.test.js tests/unit/noe-memory-maintenance-dry-run.test.js tests/unit/noe-memory-candidate-review.test.js tests/unit/noe-memory-skill-candidate-gate.test.js` | New utility does not regress memory status/candidate/retrieval paths | 7 files / 26 tests passed | pass |
| Memory utility lite non-output outDir negative | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-utility-lite.mjs --out-dir docs/noe-memory-utility-lite` | Reject report dir outside repo output before writing | exit 1; `out-dir must stay under output/: docs/noe-memory-utility-lite` | pass |
| Memory utility lite sensitive db negative | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-utility-lite.mjs --db-path .env.local --out-dir output/noe-memory-utility-lite-negative` | Reject sensitive DB path before reading | exit 1; `db-path references forbidden sensitive path: .env.local` | pass |
| Memory utility lite private_holdout db negative | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-utility-lite.mjs --db-path evals/neo/private_holdout/panel.db --out-dir output/noe-memory-utility-lite-negative` | Reject private holdout DB path before reading | exit 1; `db-path references forbidden sensitive path: evals/neo/private_holdout/panel.db` | pass |
| Memory utility lite no body output scan | `rg -n '"(body|title|text|content|prompt|query)"\\s*:' output/noe-memory-utility-lite/latest.json ...` | Latest real DB report has no memory body/title/prompt/query fields | no matches | pass |
| Memory utility lite extra smoke | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-memory-utility-lite.mjs --out-dir output/noe-memory-utility-lite-smoke` | Real DB read-only report can write to explicit output dir | ok true; candidates 50; promote 6 / demote 44 | pass |
| Memory utility lite no-write import scan | `rg` over `src/memory/NoeMemoryUtilityLite.js` and `scripts/noe-memory-utility-lite.mjs` for MemoryCore/write gate/apply/rollback/initSqlite/schema migration/write-like calls | No write-capable imports/calls in lite slice | no matches | pass |
| Memory utility lite subagent review | Feynman read-only review | Independent confirmation before multi-model gate | `design_pass_with_followups`; P0/P1/P2 constraints recorded; no file edits; no 51835 touch | pass |
| Memory utility lite readonly DB open check | `rg -n "new Database\\(dbPath, \\{ readonly: true \\}\\)" scripts/noe-memory-utility-lite.mjs` | CLI opens DB read-only | line 139 matched | pass |
| Memory utility lite final multi-model gate | `npm run noe:consensus:round -- --round-id 20260619-memory-utility-lite --run-models --ack-cost ...` | Codex/Claude/M3 review; no MemoryCore write/salience/memory-v2/model/live/runtime/self-code/51835/private_holdout authorization | `consensus_passed`; approvals 3/3; ledger `output/noe-multimodel/20260619-memory-utility-lite/ledger.json` | pass |
| Memory utility lite ledger targeted verify | `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-consensus-ledger-verify.mjs --ledger output/noe-multimodel/20260619-memory-utility-lite/ledger.json --require-artifacts --require-evidence --require-passed` | Verify this ledger without historical-ledger noise | checked 1; failed 0; approvals 3/2 | pass |
| NeoEval schema gate | `npm run noe:consensus:round -- --round-id 20260619-neoeval-schema-gate --run-models --ack-cost ...` | Full multi-model gate | incomplete: Claude CLI hung; Codex vote was approve_with_changes with blockers now addressed | partial |

## Error Log
| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-06-19 | Handoff path under `/Users/hxx/Documents/Neo 2/docs/` was missing | 1 | Found and read the real file under `/Users/hxx/Desktop/Neo 贾维斯/docs/`. |
| 2026-06-19 | zsh `unmatched \"` from an over-complicated `rg` code-snippet regex | 1 | Re-ran as two simpler `rg` commands: one for fenced blocks, one for code keywords. |
| 2026-06-19 | `20260619-neoeval-validator-gate` produced no output and stayed running | 1 | Terminated only the stuck local audit process; then fixed validator gaps and started final gate with an outer timeout. |
| 2026-06-19 | `20260619-neoeval-validator-final-gate` wrote `codex.txt` approve but the runner did not exit/advance to Claude/M3 before timeout | 1 | Terminated only the stuck audit process group; later recovered by separately collecting Claude/M3 raw outputs and assembling a valid 3/3 ledger. |
| 2026-06-19 | Initial manual M3/Claude raw command used `ensure-node22 --exec node --input-type=module` incorrectly, causing `Cannot find module .../node` | 1 | Re-ran with direct `node --input-type=module`; no raw files were written by the failed attempt. |
| 2026-06-19 | `npm audit --omit=dev --audit-level=high` failed against `registry.npmmirror.com` because the mirror does not implement the audit endpoint | 1 | Re-ran audit with temporary `npm_config_registry=https://registry.npmjs.org`; high/critical remained 0, moderate remained 13. |

## Session Update: Phase 5 Evolution Archive Dry-Run
- **Status:** implementation and local verification complete; subagent and multi-model gate still required before next slice.
- Actions taken:
  - Added `src/candidates/NoeEvolutionArchiveDryRun.js` for metadata-only DGM/SICA style archive dry-run record validation.
  - Added `scripts/noe-evolution-archive-dry-run.mjs` to write dry-run reports only under `output/noe-evolution-archive-dry-run/**`.
  - Added `tests/unit/noe-evolution-archive-dry-run.test.js`; kept verification as direct commands because this slice forbids package script changes.
  - Added `docs/DESIGN_2026-06-19_Neo_Phase5_EvolutionArchiveDryRun.md`.
  - Hardened top-level refs: `candidateRef` must point to `output/noe-candidate-patches/**`; archive/evidence/validator/report refs must stay under `output/**`; holdout refs remain sentinel-only.
  - Fixed Erdos P0 finding: raw body text can no longer be hidden in `id` / lineage / ref values and echoed into reports or CLI errors.
  - Added strict ID grammar, ref/path unsafe character rejection, safe report output for IDs/kind/verdict/inputRef, and generic non-echoing CLI/error strings.
  - Fixed Erdos P1 follow-up: leading/trailing whitespace in raw ID/ref/CLI path values is now rejected instead of being trim-normalized.
  - First multi-model round `20260619-evolution-archive-dry-run` completed `consensus_passed`, but it used pre-P0-fix evidence and is not counted as the release gate.
- Verification:
  - Syntax: `node --check src/candidates/NoeEvolutionArchiveDryRun.js` and `node --check scripts/noe-evolution-archive-dry-run.mjs` passed.
  - Focused unit: `tests/unit/noe-evolution-archive-dry-run.test.js` passed, 12 tests.
  - CLI smoke: `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-evolution-archive-dry-run.mjs` passed; report `ok:true`, 1 record, 1 passed.
  - Related regression: evolution archive, readiness audit, candidate patch artifact gate, consensus runner tests passed; 5 files / 54 tests.
  - Negative probes: non-output outDir, `.env.local`, `evals/neo/private_holdout/hidden.jsonl`, `package.json`, `~/.noe-panel/self-improve/archive.jsonl`, `src/loop/x.js`, newline/body-like artifact path, leading/trailing whitespace artifact path, and `--unknown` all failed before write/read.
  - No live archive: `find output/noe-evolution-archive-dry-run -name archive.jsonl -type f` produced no files.
  - Body leak scan: exact fake prompt/diff/command body strings had no matches in output reports; pure-function probe with a raw prompt-like sentinel hidden in IDs/refs/inputRef returned `ok:false` and `leaked:false`.
  - SAST-lite: no child_process/spawn/exec import or executable call in archive dry-run gate/CLI.
  - Secret scan: high-signal secret patterns had no matches in new Phase 5 files and output reports.
  - `git diff --check` over touched tracked files passed.
  - SCA: official npm audit high/critical = 0; moderate = 13 remains as a known residual risk.
  - Erdos final closeout: `design_pass`; P0/P1 closed, next dry-run/schema/archive/report slice allowed.
  - Multi-model final gate: `20260619-evolution-archive-dry-run-v3` returned `consensus_passed`; Codex/Claude/M3 approvals 3/3; ledger valid.

## Session Update: Phase 5 Evolution Scorecard Dry-Run
- **Status:** complete for dry-run/schema/report scope; subagent and multi-model gate passed before the next slice.
- Actions taken:
  - Added `src/candidates/NoeEvolutionScorecardDryRun.js` for AgentBreeder-style multi-objective scorecard dry-run validation.
  - Added `scripts/noe-evolution-scorecard-dry-run.mjs` to write reports only under `output/noe-evolution-scorecard-dry-run/**`.
  - Added `tests/unit/noe-evolution-scorecard-dry-run.test.js`.
  - Added `docs/DESIGN_2026-06-19_Neo_Phase5_EvolutionScorecardDryRun.md`.
  - Added `output/noe-multimodel/20260619-evolution-scorecard-dry-run/evidence.md`.
  - Incorporated Galileo design review: fixed objective directions/weights, added lineage, holdout sentinel, Pareto review metadata, and result false flags; decision wording is `review_candidate`, not automatic promotion.
  - Fixed CLI forbidden input coverage for `src/eval/**` and `package-lock.json` after real probes showed they were not rejected before read.
  - Closed Galileo P2 follow-ups: report-level policy now mirrors record no-* policy, and Pareto `selectedForReview` must align with `decision:review_candidate`.
  - No package scripts were added for this slice.
- Verification:
  - Syntax: `node --check src/candidates/NoeEvolutionScorecardDryRun.js` and `node --check scripts/noe-evolution-scorecard-dry-run.mjs` passed.
  - Focused unit: `tests/unit/noe-evolution-scorecard-dry-run.test.js` passed, 8 tests.
  - CLI smoke: `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-evolution-scorecard-dry-run.mjs` passed; report `ok:true`, 1 record, 1 passed.
  - Related regression: scorecard, archive dry-run, NeoEval schema/CLI, candidate patch artifact gate, consensus runner tests passed; 6 files / 66 tests.
  - Negative probes: non-output outDir, `.env.local`, `evals/neo/private_holdout/score.json`, `package.json`, `package-lock.json`, `src/eval/NeoEvalSchema.js`, leading/trailing whitespace scorecard path, newline/body-like scorecard path, and `--unknown` all failed before write/read.
  - No live archive: `find output/noe-evolution-scorecard-dry-run -name archive.jsonl -type f` produced no files.
  - Body leak scan: exact fake body strings had no matches in output reports; pure-function probe with a raw scorecard-like sentinel hidden in IDs/refs/inputRef/decision returned `ok:false` and `leaked:false`.
  - SAST-lite: no child_process/spawn/exec/fetch import or executable call in scorecard gate/CLI.
  - Secret scan: high-signal secret patterns had no matches in new scorecard files and output reports.
  - `git diff --check` over touched scorecard files passed.
  - SCA: official npm audit high/critical = 0; moderate = 13 remains as a known residual risk.
  - Galileo final closeout: P0/P1 none; prior P2 follow-ups confirmed closed.
  - Multi-model final gate: `20260619-evolution-scorecard-dry-run-v2` returned `consensus_passed`; Codex/Claude/M3 approvals 3/3; ledger valid. Manifest confirms M3 used `MiniMax-M3` with `thinking.type=adaptive`, `reasoningSplit=true`, `maxCompletionTokens=131072`, and `noAbort=true`.

## Session Update: Phase 5 PR Repair Dry-Run
- **Status:** complete for dry-run/schema/report scope; subagent and multi-model gate passed before the next slice.
- Actions taken:
  - Added `src/candidates/NoeEvolutionPrRepairDryRun.js` for metadata-only PR repair dry-run validation.
  - Added `scripts/noe-evolution-pr-repair-dry-run.mjs` to write reports only under `output/noe-pr-repair-dry-run/**`.
  - Added `tests/unit/noe-evolution-pr-repair-dry-run.test.js`.
  - Added `docs/DESIGN_2026-06-19_Neo_Phase5_PrRepairDryRun.md`.
  - Added `output/noe-multimodel/20260619-pr-repair-dry-run/evidence.md`.
  - Fixed a real CLI entrypoint issue under the repository path with spaces/Chinese characters by using `fileURLToPath(import.meta.url)` instead of raw `file://` string comparison.
  - Incorporated Mendel design/implementation review: CLI now re-verifies candidate patch, archive, and scorecard upstream reports under guarded `output/**`; equivalent artifact/check refs must match top-level verified refs; `readyAfterGate` is shown in JSON and Markdown report summaries.
  - No package scripts were added for this slice.
- Verification:
  - Syntax: `node --check src/candidates/NoeEvolutionPrRepairDryRun.js` and `node --check scripts/noe-evolution-pr-repair-dry-run.mjs` passed.
  - Focused unit: `tests/unit/noe-evolution-pr-repair-dry-run.test.js` passed, 9 tests.
  - CLI smoke: `node scripts/noe-evolution-pr-repair-dry-run.mjs` passed; report `ok:true`, 1 record, 1 passed.
  - Related regression: PR repair, candidate patch artifact gate, archive dry-run, scorecard dry-run, and consensus runner tests passed; 5 files / 66 tests.
  - Negative probes: non-output outDir, `.env.local`, `evals/neo/private_holdout/pr.json`, `package.json`, `package-lock.json`, `src/eval/NeoEvalSchema.js`, leading/trailing whitespace record path, newline/body-like record path, and `--unknown` all failed before unsafe read/write.
  - No live archive: `find output/noe-pr-repair-dry-run -name archive.jsonl -type f` produced no files.
  - No real branch: `git branch --list codex/noe-pr-repair-dry-run-smoke` produced no output.
  - Body leak scan: exact fake PR body strings had no matches in output reports; pure-function probe with raw PR body in IDs/branch/refs/inputRef returned `ok:false` and `leaked:false`.
  - SAST-lite: no child_process/spawn/exec/fetch import or executable call in PR repair gate/CLI.
  - Secret scan: high-signal secret patterns had no matches in new PR repair files and output reports.
  - Whitespace scan over PR repair files had no trailing whitespace matches.
  - SCA: official npm audit high/critical = 0; moderate = 13 remains as a known residual risk.
  - Mendel final closeout: P0/P1 none after ref-consistency fix; P2 doc/Markdown follow-ups also applied and sanity-checked.
  - Multi-model final gate: `20260619-pr-repair-dry-run` returned `consensus_passed`; Codex/Claude/M3 approvals 3/3; ledger valid. Manifest confirms M3 used `MiniMax-M3` with `thinking.type=adaptive`, `reasoningSplit=true`, `maxCompletionTokens=131072`, and `noAbort=true`.

## 5-Question Reboot Check
| Question | Answer |
|----------|--------|
| Where am I? | Phase 5: archive dry-run、scorecard dry-run、PR repair dry-run 均已完成实机验证、子代理复核和多模型门禁。 |
| Where am I going? | 评估 GraphMemory / PlanValidator / CausalRiskGate 是否只进入 dry-run/schema/report 范围；继续不创建真实分支、不应用 patch、不提交/推送/开 PR、不碰 live 51835、不写 memory-v2、不读 secret/private_holdout。 |
| What's the goal? | Build evidence-backed Neo improvement route from local Neo/Hermes/OpenClaw, with per-stage real-machine verification plus subagent and multi-model gates. |
| What have I learned? | See `findings.md`. |
| What have I done? | Completed Phase 0 baseline, Phase 2 evidence substrate, Phase 3 candidate gates, Phase 4 candidate patch dry-run, and Phase 5 archive/scorecard/PR repair dry-run gates with local verification, subagent review, and Codex/Claude/M3 approvals. |

## Session Update: Phase 5 GraphMemory / PlanValidator / CausalRiskGate Boundary
- **Status:** complete for boundary decision.
- Actions taken:
  - Added `docs/DECISION_2026-06-19_Neo_Phase5_GraphMemory_PlanValidator_CausalRiskGate.md`.
  - Added `output/noe-multimodel/20260619-boundary-graphmemory-planvalidator-causalriskgate/evidence.md`.
  - Decision: only PlanValidator may enter dry-run/schema/report scope; GraphMemory writes and CausalRisk runtime gate remain paused.
  - Kept all work documentation/evidence only: no live `51835`, no memory-v2 write, no GraphMemory write, no CausalRisk runtime hook, no secret/private_holdout read.
- Verification:
  - Runtime trace / memory utility / eval / candidate regressions passed: 6 files / 30 tests.
  - Runtime trace snapshot check passed: `ok:true`, 1 record, 0 violations.
  - Memory utility boundary check under Node 22 passed: `ok:true`, 50 candidates, promote 6 / demote 44.
  - Secret and whitespace scans passed.
  - Mendel subagent review passed; multi-model gate `20260619-boundary-graphmemory-planvalidator-causalriskgate` passed 3/3 with valid ledger.

## Session Update: Phase 5 PlanValidator Dry-Run
- **Status:** complete for dry-run/schema/report scope; subagent and multi-model gate passed before Phase 6.
- Actions taken:
  - Added `src/candidates/NoePlanValidatorDryRun.js` for metadata-only PlanValidator dry-run record validation.
  - Added `scripts/noe-plan-validator-dry-run.mjs` to write reports only under `output/noe-plan-validator-dry-run/**`.
  - Added `tests/unit/noe-plan-validator-dry-run.test.js`.
  - Added `docs/DESIGN_2026-06-19_Neo_Phase5_PlanValidatorDryRun.md`.
  - Added `output/noe-multimodel/20260619-plan-validator-dry-run/evidence.md`.
  - Implemented closed schema for plan refs/hashes/source reports/rollback/risk refs/policy/result/validator checks.
  - CLI verifies `sourceReportRefs` under `output/**` and requires `ok:true`.
  - CLI verifies `validatorVersion` for known dry-run source report families: candidate patch, archive, scorecard, PR repair, and PlanValidator.
  - Closed Mendel P2 by table-driving mismatch/match tests across all five known source report families.
- Verification:
  - Syntax checks passed for source and CLI.
  - Focused unit passed: 1 file / 9 tests.
  - Related regression passed: 8 files / 74 tests.
  - CLI smoke passed: `ok:true`, 1 record, 1 passed, 0 failed.
  - Negative probes passed for non-output outDir, `.env.local`, `evals/neo/private_holdout`, `package.json`, `package-lock.json`, `src/eval`, whitespace path, newline body-like path, and unknown arg.
  - SAST-lite scan had no child_process/spawn/exec/fetch/MemoryCore/git/gh hits.
  - Secret scan and fake body leak scan had no matches.
  - No `archive.jsonl` was created under PlanValidator output; no `codex/noe-plan-validator-dry-run-smoke` branch existed.
  - SCA remained high/critical 0; residual moderate 13 stayed documented.
  - Mendel closeout: `pass`, P0 none, P1 none, prior P2 closed.
  - Multi-model final gate `20260619-plan-validator-dry-run`: `consensus_passed`; Codex approve, Claude approve_with_changes, M3 approve, approvals 3/3, ledger valid.
  - Manifest confirmed M3 used `MiniMax-M3` with `thinking.type=adaptive`, `reasoningSplit=true`, `maxCompletionTokens=131072`, and `noAbort=true`.

## Session Update: Phase 6 Shared Evidence / Ledger / Handoff Protocol
- **Status:** complete for documentation/template scope; subagent and multi-model gate passed.
- Actions taken:
  - Added `docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md`.
  - Added `docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md`.
  - Added `output/noe-multimodel/20260619-shared-memory-protocol/evidence.md`.
  - Added templates under `output/noe-multimodel/20260619-shared-memory-protocol/templates/`:
    - `final-handoff.md`
    - `disagreements.md`
    - `staleness-ledger.md`
    - `verifier-notes.md`
  - Converted the multi-model memory precision discussion into file-backed shared memory rules: source-of-truth policy, model read order, role split, context budget, anti-stale TTL, disagreement handling, promotion rules, forbidden memory, and non-JSON model output handling.
  - Explicitly covered four failure classes: stale memory, hallucinated live state, role overlap, and unparsed model vote.
  - Added checkable success criteria: 100% final-claim evidence coverage, 100% live/runtime freshness marking, per-round handoff/disagreement files, ledger freshness, unparsed-output non-counting, secret/body scan 0 matches, and side-effect boundary.
- Verification:
  - `git diff --check` passed for shared memory protocol docs/evidence/templates.
  - High-signal secret scan with `rg --pcre2` over protocol docs/templates/evidence and v2 gate output returned no matches.
  - Body/private-key/token assignment scan returned no matches.
  - Boundary wording scan confirmed no live/write authorization was introduced.
  - Path scope check confirmed templates stay under `output/noe-multimodel/20260619-shared-memory-protocol/templates/**`.
  - Mendel subagent review passed after P2 closeout; P0/P1 none.
  - First multi-model gate `20260619-shared-memory-protocol` passed but Claude gave `approve_with_changes`; blockers were fixed by naming the fourth failure class and making success criteria checkable.
  - Final multi-model gate `20260619-shared-memory-protocol-v2` passed with Codex/Claude/M3 approvals 3/3, parseErrors `[]`, valid ledger, and M3 `MiniMax-M3` with `thinking.type=adaptive`, `reasoningSplit=true`, `maxCompletionTokens=131072`, `noAbort=true`.
  - No live `51835`, memory-v2, SkillStore, GraphMemory, CausalRisk runtime gate, plan execution, patch apply, git/gh/PR/publish, secret/owner-token/private_holdout read, or provider-private memory was authorized or performed by this slice.

## Session Update: Phase 6 Shared Memory Template Exercise
- **Status:** complete for local verification; pending subagent and multi-model closeout.
- Actions taken:
  - Instantiated the v2 shared-memory templates:
    - `output/noe-multimodel/20260619-shared-memory-protocol-v2/final-handoff.md`
    - `output/noe-multimodel/20260619-shared-memory-protocol-v2/disagreements.md`
    - `output/noe-multimodel/20260619-shared-memory-protocol-v2/staleness-ledger.md`
    - `output/noe-multimodel/20260619-shared-memory-protocol-v2/verifier-notes.md`
  - Added `output/noe-multimodel/20260619-shared-memory-template-exercise/evidence.md`.
  - Added `output/noe-multimodel/20260619-final-real-machine-authorization/evidence.md` to record the user's B/C/D/E authorization and hard redaction rules.
- Verification:
  - `git diff --check` passed over v2 template instances and authorization evidence.
  - High-signal secret scan returned no matches.
  - Template instance integrity check passed: `template_instance_integrity_ok=true`.
  - Ledger consistency check passed: `ok:true`, `missing:[]`, `approvedCount:3`, all model votes parsed.
  - Field scan confirmed `parseErrors`, `countedInConsensus`, `fallbackFor`, `needs_verification`, `unverified-current`, and side-effect boundary markers are present.
  - No live `51835`, memory-v2, SkillStore, GraphMemory, patch apply, git/gh/PR/publish, raw secret, owner-token, `.env*`, `room-adapters.json`, or raw private_holdout read was performed.

## Session Update: Phase 6 Multimodel Exhaustive Quality Mode
- **Status:** complete for quality-mode substrate; B/C/D/E real-machine stages pending.
- Actions taken:
  - Ran two read-only subagent reviews:
    - Rawls focused on historical multi-model/subagent process failures.
    - Dalton focused on runner/evidence automation gaps.
  - Ran post-implementation subagent closeouts:
    - Rawls: P0 none, allowed approval gate for quality-mode slice; B/C/D/E completion still requires `--require-complete`.
    - Dalton: P0 none, allowed approval gate through runner path with `--stage-matrix`; manual assemble is not final B/C/D/E approval evidence.
  - Implemented default `qualityProfile=exhaustive` for formal consensus rounds.
  - Added exhaustive prompt/brief/manifest instructions for evidence-first review, P0/P1/P2 classification, fresh live evidence, policy-vs-enforcement checks, and minimum falsifiers.
  - Added `verificationRequired`, `parseStrategy`, and `unavailableReason` fields to normalized votes.
  - Added gate enforcement for:
    - counted approval blockers must be empty;
    - approval votes require `verificationRequired`;
    - `approve_with_changes` requires `recommendedFirstSlice`;
    - reject/abstain/unavailable cannot claim `consensus_vote=yes`.
  - Added machine-readable B/C/D/E authorization matrix, verifier, and runner/gate integration:
    - `output/noe-multimodel/20260619-final-real-machine-authorization/authorization.json`
    - `src/runtime/NoeFinalStageMatrix.js`
    - `scripts/noe-final-stage-matrix-verify.mjs`
    - `tests/unit/noe-final-stage-matrix.test.js`
    - `--stage-matrix` / `--require-stage-complete` support in `scripts/noe-four-model-consensus-round.mjs`
    - `final_stage_matrix` artifact support in `src/room/NoeConsensusRunner.js` and `src/room/NoeConsensusGate.js`
    - exhaustive-only enforcement for stage-matrix rounds; `qualityProfile=standard` is rejected when a stage matrix is attached.
    - final-stage ref validation before reading the matrix path or any `stageEvidenceRefs`; forbidden refs include `.env*`, owner-token, `room-adapters.json`, private_holdout, absolute paths, URL/file refs, and `..`.
    - `gate.sha256` now binds `artifacts`, including the final-stage matrix artifact.
    - `scripts/noe-four-model-consensus-round.mjs` now safe-checks `--evidence-file` and `--out-dir` before reading/writing formal gate inputs.
  - Updated `docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md`, `docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md`, and `output/noe-multimodel/20260619-multimodel-exhaustive-quality-mode/evidence.md`.
  - Added same-model JSON repair for unparsed participant output:
    - one repair attempt per participant;
    - original unparsed output is saved as `*.unparsed-attempt-1.txt`;
    - repair output is saved as `*.json-repair-attempt-1.txt`;
    - only repaired same-model parseable JSON is counted in quorum;
    - Codex fallback remains supplemental and never counts as the unavailable model vote.
  - Added `output/noe-multimodel/20260619-multimodel-exhaustive-quality-mode/evidence-pack.md` so model prompts include the verifier notes directly instead of referencing an unseen file.
  - Closed Dalton P1 on repair identity mismatch:
    - repaired output must parse and have no `identityViolations` before it can overwrite the participant vote;
    - `validateNoeConsensusLedger` now rejects any vote carrying `identityViolations`;
    - added regression coverage for repaired JSON that self-reports as a different model.
    - `jsonRepairPolicy.countedInConsensus` now says `same_model_only_when_parseable_and_identity_clean`.
- Verification:
  - Syntax checks passed for consensus runner/round/gate and final-stage matrix files.
  - Focused tests passed: 5 files / 69 tests.
  - Wider consensus regression passed: `npm run test:noe:consensus`, 9 files / 130 tests.
  - After stage-matrix runner/gate integration, wider consensus regression passed again: 9 files / 131 tests.
  - After exhaustive-only stage-matrix enforcement, wider consensus regression passed again: 9 files / 132 tests.
  - After read-before-boundary hardening, wider consensus regression passed again: 9 files / 133 tests.
  - After artifact-hash/evidence-file guard hardening, wider consensus regression passed again: 9 files / 134 tests.
  - `node scripts/noe-final-stage-matrix-verify.mjs` passed with `ok:true`; required stages are B/C/D/E and no stage is marked completed yet.
  - `npm run verify:noe:final-stage-matrix` passed after path/ref hardening: 1 file / 6 tests plus CLI `ok:true`.
  - `npm run verify:noe:final-stage-matrix` remained passing after exhaustive-only stage-matrix enforcement.
  - `npm run verify:noe:final-stage-matrix` passed after read-before-boundary hardening: 1 file / 7 tests plus CLI `ok:true`.
  - `npm run verify:noe:final-stage-matrix` remained passing after artifact-hash/evidence-file guard hardening.
  - CLI dry-run with safe evidence and `--stage-matrix` passed: `20260619-exhaustive-quality-cli-smoke`, `qualityProfile=exhaustive`, `stageMatrix.ok=true`.
  - CLI negative probe for `.env.local` evidence-file failed before read with `evidence_file_ref_forbidden`.
  - First approval gate `20260619-multimodel-exhaustive-quality-mode` returned `consensus_passed` by dynamic quorum, but Codex rejected due missing subagent/hash/secret-scan evidence details; those evidence gaps were closed in `output/noe-multimodel/20260619-multimodel-exhaustive-quality-mode/verifier-notes.md`, and a rerun is required.
  - Second approval gate with the same round id returned `consensus_blocked`; Codex abstained because verifier notes were referenced but not embedded, Claude returned unparsed natural language, and M3 approved with changes. This is the direct reason for `evidence-pack.md` and same-model JSON repair.
  - Focused runner regression after JSON repair passed: `tests/unit/noe-consensus-runner.test.js`, 1 file / 23 tests.
  - Focused identity-guard regression passed: consensus runner/round/gate, 3 files / 62 tests.
  - Full consensus regression after JSON repair identity guard passed: `npm run test:noe:consensus`, 9 files / 136 tests.
  - Final-stage matrix verification after JSON repair passed: `npm run verify:noe:final-stage-matrix`, 1 file / 7 tests plus CLI `ok:true`, completed `[]`, required B/C/D/E.
  - Evidence-pack dry-run passed: `20260619-exhaustive-quality-pack-cli-smoke`, `qualityProfile=exhaustive`, `stageMatrix.ok=true`, `jsonRepairPolicy.enabled=true`, M3 `thinking.type=adaptive`, `reasoningSplit=true`, `maxCompletionTokens=131072`, `noAbort=true`.
  - Identity-clean evidence-pack dry-run passed: `20260619-exhaustive-quality-pack-cli-smoke-identity-clean`, `jsonRepairPolicy.countedInConsensus=same_model_only_when_parseable_and_identity_clean`, M3 adaptive thinking options present.
  - Focused runner regression after identity-clean policy wording passed: 1 file / 24 tests.
  - Multi-model v3 gate `20260619-multimodel-exhaustive-quality-mode-v3` passed:
    - `consensus_passed`
    - Codex / Claude / M3 approvals 3/3
    - `parseErrors=[]`
    - validation `ok=true`, errors/warnings empty
    - `stageMatrix.ok=true`, `requireComplete=false`, `completed=[]`
    - Claude unparsed initial output was repaired by same-model JSON repair; `participant_json_repair.countedInConsensus=true`
    - `fallbacks=[]`
  - v3 subagent closeout passed:
    - Rawls: PASS, quality-mode substrate can be marked passed; B/C/D/E must not be marked complete.
    - Dalton: PASS, runner/ledger closeout accepted; allows entering B/C/D/E real-machine stages.

## Session Update: Final Real-Machine Stage B
- **Status:** complete for Stage B scoped evidence and gate; C/D/E pending.
- Actions taken:
  - Ran `node scripts/noe-model-keychain-check.mjs`; Dalton identified that it does not print raw values but does read keychain values into process memory.
  - Added and ran presence-only `node scripts/noe-model-keychain-presence-check.mjs --required minimax --optional xiaomi,gemini,openai,anthropic`, using `security find-generic-password` without `-w` or `-g`.
  - Wrote redacted machine evidence to `output/noe-final-real-machine-stages/20260619/stage-B-secret-use.json`.
  - Wrote stage evidence pack to `output/noe-final-real-machine-stages/20260619/stage-B-evidence-pack.md`.
- Result:
  - `minimax` configured from keychain source ref `MINIMAX_API_KEY`.
  - `xiaomi` configured from keychain source ref `XIAOMI_API_KEY`.
  - `gemini`, `openai`, and `anthropic` are unconfigured in `NoeProviderSecrets`; non-blocking for B because the current approved multi-model runner needs `minimax`, while Codex/Claude are CLI participants.
  - No raw secret value was read, printed, or stored by the final B presence-only command.
- Verification:
  - `node scripts/noe-final-stage-matrix-verify.mjs` passed with `completed:["B"]`.
  - `node scripts/noe-final-stage-matrix-verify.mjs --require-complete` failed as expected with missing C/D/E evidence.
  - High-signal secret scan over stage-B JSON returned no matches.
  - `git diff --check` passed for stage-B JSON.
  - Presence-only secret test passed: `tests/unit/noe-provider-secrets.test.js`, 1 file / 8 tests.
  - Dalton P1 on resolver raw-value read was closed by replacing B evidence with presence-only keychain metadata check.
  - Stage B subagent closeout recorded in `output/noe-final-real-machine-stages/20260619/stage-B-subagent-closeout.md`.
  - Initial Stage B multi-model gate `20260619-final-stage-B-secret-use` passed dynamic quorum but Codex rejected due missing subagent closeout artifact and missing Stage B JSON hash; not treated as clean approval.
  - Clean Stage B multi-model gate `20260619-final-stage-B-secret-use-v2` passed:
    - Codex / Claude / M3 approvals 3/3
    - `parseErrors=[]`
    - validation `ok=true`, no errors/warnings
    - stage matrix artifact `completed:["B"]`, `requireComplete=false`
    - `fallbacks=[]`
  - Stage B post-gate subagent closeout passed:
    - Rawls: PASS, Stage B can be marked complete; C/D/E and full closeout remain incomplete.
    - Dalton: PASS, B v2 runner/ledger accepted; allowed entering Stage C.
  - Stage B final closeout written to `output/noe-final-real-machine-stages/20260619/stage-B-final-closeout.md`.
  - Stage-matrix standard negative probe failed as expected with `stage_matrix_requires_exhaustive_quality_profile`.
  - Forbidden evidence-file probe after evidence pack failed as expected with `evidence_file_ref_forbidden` before read.
  - Production/evidence high-signal secret scan returned no matches; broader test-inclusive scan found only intentional redaction fixtures already used by unit tests, not the new JSON repair hunk.
  - JSON parse check passed for `package.json` and B/C/D/E authorization matrix.
  - Negative final closeout check passed by failing as expected: `node scripts/noe-final-stage-matrix-verify.mjs --require-complete` returns `stage_evidence_missing:B/C/D/E` until stage evidence files exist.
  - `git diff --check` passed over quality-mode touched files.
  - High-signal secret scan over touched source/scripts/docs/output/planning files returned 0 matches.
  - No live `51835`, memory-v2, SkillStore, GraphMemory, patch apply, git/gh/PR/publish, raw secret, owner-token, `.env*`, `room-adapters.json`, or raw private_holdout read was performed.

## Session Update: Final Real-Machine Stage C
- **Status:** complete for Stage C scoped sealed holdout metadata aggregate; D/E pending.
- Actions taken:
  - Added metadata-only sealed aggregate implementation:
    - `src/eval/NoePrivateHoldoutSealedAggregate.js`
    - `scripts/noe-private-holdout-sealed-aggregate.mjs`
    - `tests/unit/noe-private-holdout-sealed-aggregate.test.js`
  - Generated redacted Stage C evidence at `output/noe-final-real-machine-stages/20260619/stage-C-sealed-holdout.json`.
  - Wrote `output/noe-final-real-machine-stages/20260619/stage-C-evidence-pack.md`.
  - Wrote subagent and final closeouts:
    - `output/noe-final-real-machine-stages/20260619/stage-C-subagent-closeout.md`
    - `output/noe-final-real-machine-stages/20260619/stage-C-final-closeout.md`
  - Fixed a Stage C P0 found by Rawls: the first hash-only approach read sealed file bytes. Replaced it with metadata-only `readdirSync/statSync`; no file content read path remains.
  - Added `--no-write` to the Stage C CLI for re-probes without mutating stage evidence.
  - Fixed a consensus-ledger P2 found after Stage C gates: object array items and object-derived `unavailableReason` now serialize to readable JSON strings instead of `[object Object]`.
- Result:
  - Stage C evidence is `ok:true`, `redacted:true`, `evaluationMode:sealed_metadata_hash_only`.
  - Current sealed directory aggregate: `fileCount:2`, `jsonFileCount:0`, `nonJsonFileCount:2`, warning categories `non_json_file=2` and `sealed_holdout_no_json_artifacts=1`.
  - This is not a behavioral hidden-set score; it is metadata/hash validation only.
- Verification:
  - Stage C focused test passed: 1 file / 3 tests.
  - Focused consensus regression passed: 3 files / 64 tests.
  - Full consensus regression passed: 9 files / 138 tests.
  - `npm run verify:noe:final-stage-matrix` passed: 1 file / 7 tests plus matrix `ok:true`, completed `["B","C"]`.
  - `node scripts/noe-final-stage-matrix-verify.mjs --require-complete` failed as expected with missing D/E only.
  - Widened raw-read guard over Stage C aggregate/CLI returned no matches.
  - High-signal secret scan, sentinel leak scan, and exact `[object Object]` field-value scan returned no matches.
  - Stage C v4 multi-model gate `20260619-final-stage-C-sealed-holdout-v4` passed:
    - Codex / Claude / M3 approvals 3/3
    - `parseErrors=[]`
    - validation `ok=true`, no errors/warnings
    - `fallbacks=[]`
    - no JSON repair artifact in v4
    - M3 `MiniMax-M3` with `thinking.type=adaptive`, `reasoningSplit=true`, `noAbort=true`
    - Stage Matrix artifact `completed:["B","C"]`, `requireComplete=false`, counted in consensus false
  - Stage C v4 post-gate subagent closeout passed:
    - Rawls: PASS, P0/P1 none, Stage C complete, may enter D.
    - Dalton: PASS, P0/P1 none, Stage C complete, may enter D.
  - No live `51835`, memory-v2, SkillStore, GraphMemory, patch apply, git/gh/PR/publish, raw secret, owner-token, `.env*`, `room-adapters.json`, or raw private_holdout content read was performed.

## Session Update: Final Real-Machine Stage D
- **Status:** complete for Stage D scoped live 51835 scratch write/cleanup evidence and gate; E pending.
- Actions taken:
  - Added Stage D live scratch evidence builder:
    - `src/runtime/NoeLive51835ScratchEvidence.js`
    - `tests/unit/noe-live-51835-scratch-evidence.test.js`
  - Added live scratch CLI:
    - `scripts/noe-live-51835-scratch-write.mjs`
  - Ran live `51835` scratch write with standing authorization:
    - before query: HTTP 200 and scratch id absent
    - scratch write: HTTP 201 and scratch id visible after write
    - cleanup delete: HTTP 200
    - after cleanup query: HTTP 200 and scratch id absent
  - Wrote redacted Stage D evidence:
    - `output/noe-final-real-machine-stages/20260619/stage-D-live-51835-scratch-write.json`
    - `output/noe-final-real-machine-stages/20260619/stage-D-rollback.json`
    - `output/noe-final-real-machine-stages/20260619/stage-D-evidence-pack.md`
    - `output/noe-final-real-machine-stages/20260619/stage-D-verifier-notes.md`
  - Tightened Stage Matrix with D typed evidence checks:
    - `mode:"live_51835_scratch_write_cleanup"`
    - `qualityMode.profile:"exhaustive"`
    - model/subagent review markers
    - scratch project/scope
    - raw body/response stored flags
    - cleanup attempted/ok/visibility
    - counts `0 -> 1 -> 0`
    - required step names and status codes
  - Improved consensus manifest auditability:
    - `consensusStatus`
    - `ledgerRef`
    - `gateValidated`
    - gate summary
  - Wrote Stage D closeouts:
    - `output/noe-final-real-machine-stages/20260619/stage-D-subagent-closeout.md`
    - `output/noe-final-real-machine-stages/20260619/stage-D-final-closeout.md`
- Result:
  - Stage D evidence is `ok:true`, `redacted:true`, `mode:"live_51835_scratch_write_cleanup"`.
  - Scope is only `projectId:"stage-d-scratch"`, `scope:"scratch"`.
  - Raw credential, raw scratch body, raw response body, and raw scratch id/marker are not stored in Stage D JSON/Markdown outputs.
  - Owner credential was read into process memory only to call protected local API; it was not printed or stored.
  - Stage D is not Stage E and does not prove final B/C/D/E completion.
- Verification:
  - `node --check scripts/noe-live-51835-scratch-write.mjs` passed.
  - Targeted `git diff --check` passed.
  - Focused tests passed after D evidence and matrix changes: 6 files / 83 tests.
  - Focused tests after manifest gate fields passed: 3 files / 35 tests.
  - `npm run verify:noe:final-stage-matrix` passed: 1 file / 8 tests plus matrix `ok:true`, completed `["B","C","D"]`.
  - `node scripts/noe-final-stage-matrix-verify.mjs --require-complete` failed as expected with only `stage_evidence_missing:E`.
  - High-signal redaction scan over Stage D outputs and Stage D gate outputs returned no matches.
  - Single-ledger verification passed:
    - `node scripts/noe-consensus-ledger-verify.mjs --ledger output/noe-multimodel/20260619-final-stage-D-live-scratch-v1/ledger.json --require-evidence --require-artifacts --require-passed`
    - result: PASS, checked 1, failed 0.
  - Stage D subagent closeout passed:
    - Rawls: PASS; Stage D scratch write/cleanup evidence is sufficient, with P2 caveat that owner credential is read in process but not printed/stored.
    - Dalton: PASS; D typed evidence is machine-enforced and matrix state is B/C/D only, E pending.
  - Stage D multi-model gate `20260619-final-stage-D-live-scratch-v1` passed:
    - Codex / Claude / M3 approvals 3/3
    - `parseErrors=[]`
    - validation `ok=true`, no errors/warnings
    - `fallbacks=[]`
    - M3 `MiniMax-M3` with `thinking.type=adaptive`, `reasoningSplit=true`, `noAbort=true`
    - Stage Matrix artifact `completed:["B","C","D"]`, `requireComplete=false`
    - manifest records `consensusStatus:"consensus_passed"`, `ledgerRef`, `gateValidated:true`
  - No Stage E restart was performed yet.

## Session Update: Final Real-Machine Stage E And B/C/D/E Closeout
- **Status:** complete for B/C/D/E final-stage matrix; full Neo function testing still pending.
- Actions taken:
  - Added Stage E final restart evidence builder and wrapper:
    - `src/runtime/NoeFinal51835RestartEvidence.js`
    - `scripts/noe-final-51835-restart-recovery.mjs`
    - `tests/unit/noe-final-51835-restart-evidence.test.js`
  - Tightened Stage Matrix with E typed evidence checks:
    - finalRestartRecovery
    - preflight safeToRestart/ok
    - restart applied and realRestartAttempted
    - PID changed, old PID absent, new PID cwd is repo
    - 51835 port, 51735 untouched
    - health/readiness/freedom-live true
    - LM Studio loaded models unchanged
    - finalRestartOnly/no51735Touch/memoryV2Writes policy
  - Ran preflight via `node scripts/restart-panel.mjs --check-only`; result safe to restart:
    - 51835 listener owned by `/Users/hxx/Desktop/Neo 贾维斯`
    - safeToRestart true
    - 51735 observe-only listener present and not touched
  - Ran final live restart wrapper:
    - `node scripts/noe-final-51835-restart-recovery.mjs`
    - wrote `output/noe-final-real-machine-stages/20260619/stage-E-final-51835-restart-recovery.json`
    - wrote `output/noe-final-real-machine-stages/20260619/stage-E-evidence-pack.md`
    - wrote `output/noe-final-real-machine-stages/20260619/stage-E-verifier-notes.md`
  - Wrote final B/C/D/E evidence pack:
    - `output/noe-final-real-machine-stages/20260619/stage-final-bcde-evidence-pack.md`
  - Wrote final B/C/D/E closeout:
    - `output/noe-final-real-machine-stages/20260619/stage-final-bcde-closeout.md`
- Result:
  - Stage E evidence is `ok:true`, `redacted:true`, `mode:"final_51835_restart_recovery"`, `finalRestartRecovery:true`.
  - Restart was applied and realRestartAttempted true.
  - PID changed, old PID absent, new listener cwd is the Neo repo.
  - 51735 listener count stayed `1 -> 1` and `port51735Untouched:true`.
  - Post-restart health/readiness/freedom-live checks are true.
  - LM Studio loaded model count stayed `1 -> 1`.
  - Final Stage Matrix `--require-complete` now passes B/C/D/E.
- Verification:
  - Stage E / matrix / runtime drill tests passed before live restart: 3 files / 13 tests.
  - Post-restart focused regression passed: 4 files / 37 tests.
  - `npm run verify:noe:final-stage-matrix` passed: 1 file / 9 tests plus CLI `ok:true`, completed `["B","C","D","E"]`.
  - `node scripts/noe-final-stage-matrix-verify.mjs --require-complete` passed with completed `["B","C","D","E"]`.
  - Post-gate single-ledger verification for `20260619-final-bcde-real-machine-complete-v1` passed.
  - Post-gate `/health` returned `ok:true`, `status:"ok"`, port `51835`.
  - Post-gate 51735 observe-only check still showed listener on `127.0.0.1:51735`.
  - High-signal redaction scans over Stage E outputs and final gate outputs returned no matches.
  - Stage E subagent review passed:
    - Rawls: PASS, no P0/P1; caveat that bottom drill report stores raw HTTP response prefixes and final claims must remain scoped.
    - Dalton: PASS, no P0/P1; final matrix complete and E typed fields are machine-enforced.
  - Final multi-model gate `20260619-final-bcde-real-machine-complete-v1` passed:
    - Codex / Claude / M3 approvals 3/3
    - `parseErrors=[]`
    - validation `ok=true`, no errors/warnings
    - `fallbacks=[]`
    - Stage Matrix artifact `requireComplete:true`, `ok:true`, completed `["B","C","D","E"]`
    - Claude unparsed initial output was repaired by same-model JSON repair and counted.
    - M3 `MiniMax-M3` with `thinking.type=adaptive`, `reasoningSplit=true`, `noAbort=true`.
- Caveats:
  - B/C/D/E completion is scoped to the final-stage authorization matrix only.
  - This does not prove all Neo features are exhaustively tested.
  - Full Neo function real-machine testing remains pending and must run as a separate phased effort with subagent and multi-model review after each phase.

## Session Update: Full-Function F2 Memory/Cognition Baseline Gate
- **Status:** complete for scoped F2 read-only memory/cognition baseline; full memory/autonomy health not claimed.
- Actions taken:
  - Re-ran F2 real-machine/read-only verification commands:
    - `npm run verify:noe:memory-status`
    - `npm run verify:noe:runtime-evidence`
    - `npm run verify:noe:expectation-calibration`
    - `npm run verify:noe:continuous-autonomy`
    - `npm run verify:noe:soak-snapshot`
    - `npm run verify:noe:growth-readiness`
    - `npm run verify:noe:personality-dataset`
    - memory recall/retention/roadmap/semantic/relevance/retrieval/copy validation commands
    - `npm run verify:cognitive`
    - `npm run verify:noe:memory-live-provenance` as expected blocked/deferred without owner-token ack
  - Fixed F2 growth-readiness structural blocker:
    - Split `NoeConsensusRunner.js` into focused modules:
      - `src/room/NoeConsensusPrompts.js`
      - `src/room/NoeConsensusSupportFiles.js`
      - `src/room/NoeConsensusParticipantRuntime.js`
    - Kept `NoeConsensusRunner.js` as orchestration-only and preserved public re-exports for existing tests.
    - Split runner tests and added `tests/unit/noe-consensus-runner-support.test.js`.
    - Added `tests/unit/noe-consensus-runner-support.test.js` to `test:noe:consensus` and `test:p0:unit`.
    - Updated `scripts/noe-self-evolution-plan-verify.mjs` sample ledger with required `recommendedFirstSlice` and `verificationRequired` fields.
    - Added line-gate coverage for prompts/supportFiles/participantRuntime/runnerSupportTest.
  - Fixed Dalton P1 findings:
    - Codex fallback prompt now embeds exhaustive quality instructions.
    - Codex fallback prompt now uses `advisory_supplemental` and `canWrite:false` when Codex is not active executor.
  - Wrote F2 evidence artifacts:
    - `output/noe-full-function-real-machine/20260619/F2-memory-cognition-results.json`
    - `output/noe-full-function-real-machine/20260619/F2-memory-cognition-evidence.md`
    - `output/noe-full-function-real-machine/20260619/F2-subagent-closeout.md`
    - `output/noe-full-function-real-machine/20260619/F2-gate-evidence.md`
- Verification:
  - `node --check` on new/changed consensus modules passed.
  - Runner split focused tests passed: 2 files / 28 tests.
  - `npm run test:noe:consensus` passed: 10 files / 144 tests.
  - `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-self-evolution-plan-verify.mjs` passed: 215 passed / 0 failed.
  - `npm run verify:noe:growth-readiness` passed with `ok:true`, `liveDbMutated:false`.
  - `git diff --check` for touched code paths passed.
  - F2 package scan for raw secret / sealed holdout / owner-token path / raw memory body had no matches.
- Subagent review:
  - Rawls: `pass_with_blockers`, `canProceedToF3:true`; F2 cannot claim full memory/autonomy health.
  - Dalton initial: `pass_with_findings`, P1 fallback quality and line-gate coverage.
  - Dalton re-review after fixes: `pass`, P0/P1/P2 none.
- Multi-model gate:
  - Round `20260619-full-function-F2-memory-cognition-v1` passed.
  - Codex / Claude / M3 approvals 3/3.
  - `parseErrors=[]`, validation `ok=true`, no warnings/errors.
  - `node scripts/noe-consensus-ledger-verify.mjs --ledger output/noe-multimodel/20260619-full-function-F2-memory-cognition-v1/ledger.json --require-evidence --require-artifacts --require-passed` passed.
  - M3 manifest uses `MiniMax-M3`, `thinking.type=adaptive`, `maxCompletionTokens=524288`, `reasoningSplit=true`, `serviceTier=priority`, `noAbort=true`.
- Preserved blockers / caveats:
  - `runtime:curiosity_harvest_missing`
  - `runtime:affect_health_below_target`
  - `expectation:live_expectation_overdue_open`
  - P8/observation blockers including `observation_window_not_elapsed`, `insufficient_observation_window:5.44/24`, and missing categories.
  - `personality:owner_training_plan_required`
  - `memory-live-provenance` remains deferred until a separate owner-token ack + controlled live memory write/provenance stage.
- Next at that time:
  - Start F3 tools/MCP/external readiness as an independent audit. This was later completed; see the planning-sync entry at the top of this file.
  - Carry all F2 blockers forward and do not let F3 language imply they are resolved.
