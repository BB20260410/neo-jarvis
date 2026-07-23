# Neo Multimodel Shared Memory Index

更新时间：2026-06-21

## 入口

新窗口或外部模型处理当前 Neo 自进化蒸馏任务时，先读：

1. `docs/HANDOFF_2026-06-20_Neo_Evidence_Flywheel_V2_收尾与下一窗口P0-P5计划.md`
2. `docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md`
3. `docs/GOAL_2026-06-20_Neo_Evidence_Flywheel_V2.md`
4. `output/noe-evidence-flywheel-v2/final-d-e-f-evidence.md`
5. `output/noe-evidence-flywheel-v2/failed-replay-backlog-categorization-evidence.md`
6. `output/noe-evidence-flywheel-v2/route-compat-owner-gate-evidence.md`
7. `output/noe-evidence-flywheel-v2/owner-gate-secret-redaction-evidence.md`
8. `output/noe-evidence-flywheel-v2/stage-b-coverage-augment-evidence.md`
9. `output/noe-evidence-flywheel-v2/replay-coverage-gap-matrix.md`
10. `output/noe-evidence-flywheel-v2/failed-replay-followup-backlog.md`
11. `output/noe-evidence-flywheel-v2/frb-004-owner-token-ack-policy-evidence.md`
12. `output/noe-evidence-flywheel-v2/frb-001-search-provider-readiness-evidence.md`
13. `output/noe-evidence-flywheel-v2/frb-003-cognitive-entrypoints-evidence.md`
14. `output/noe-evidence-flywheel-v2/frb-002-act-safety-expectation-shape-evidence.md`
15. `output/noe-evidence-flywheel-v2/p2-evidence-hygiene-backlog.md`
16. `.planning/2026-06-19-hermes-openclaw-self-evolution/task_plan.md`
17. `.planning/2026-06-19-hermes-openclaw-self-evolution/progress.md`
18. `docs/HANDOFF_2026-06-19_代码蒸馏OpenClaw_SSRF链接理解Skill扫描.md`
19. `docs/DECISION_2026-06-19_Neo_Phase6_P2_Boundary_And_Final_Test_Plan.md`

## 最新阶段

| 阶段 | 状态 | 关键证据 |
| --- | --- | --- |
| Phase 0 baseline | complete | `docs/EVIDENCE_2026-06-19_Hermes_OpenClaw_自进化阶段0.md` |
| Phase 2 evidence substrate | complete with follow-ups | `docs/BASELINE_2026-06-19_Neo_证据底座基线审计.md` |
| Phase 3 candidate gates | complete with follow-ups | `docs/DESIGN_2026-06-19_Neo_Phase3_MemorySkillCandidateGate.md`、`docs/DESIGN_2026-06-19_Neo_Phase3_MemoryUtilityLite.md` |
| Phase 4 candidate patch dry-run | complete | `docs/DESIGN_2026-06-19_Neo_Phase4_CandidatePatchDryRun.md` |
| Phase 5 archive / scorecard / PR repair / PlanValidator | complete for dry-run/schema/report | `docs/DESIGN_2026-06-19_Neo_Phase5_*`、`docs/DECISION_2026-06-19_Neo_Phase5_GraphMemory_PlanValidator_CausalRiskGate.md` |
| Phase 6 boundary/final test planning | in progress | `docs/DECISION_2026-06-19_Neo_Phase6_P2_Boundary_And_Final_Test_Plan.md` |
| Evidence Flywheel v2 A-F | complete as non-live evidence/dry-run closeout | `output/noe-evidence-flywheel-v2/final-d-e-f-evidence.md`、`output/noe-multimodel/20260620-evidence-flywheel-v2-final-d-e-f-rerun2/ledger.json` |
| NeoEval Stage C dev/regression scoring | complete as non-live eval closeout | `output/noe-evidence-flywheel-v2/eval-stage-c-evidence.md`、`output/noe-evidence-flywheel-v2/eval-score-summary.md` |
| Stage B coverage augment seeds | complete as non-live coverage-seed closeout | `output/noe-evidence-flywheel-v2/stage-b-coverage-augment-evidence.md`、`output/noe-evidence-flywheel-v2/replay-coverage-gap-matrix.md` |
| Next-window closeout and P0-P5 plan | complete as handoff | `docs/HANDOFF_2026-06-20_Neo_Evidence_Flywheel_V2_收尾与下一窗口P0-P5计划.md` |
| Failed replay backlog categorization | complete as descriptive read-only backlog | `output/noe-evidence-flywheel-v2/failed-replay-backlog-categorization-evidence.md` |
| FRB-004 owner-token explicit ack policy | complete as scoped P1 closeout | `output/noe-evidence-flywheel-v2/frb-004-owner-token-ack-policy-evidence.md`、`output/noe-multimodel/20260621-frb-004-owner-token-ack-policy-p1-gate/ledger.json` |
| FRB-001 search provider readiness follow-up | complete as managed-fixture P1 closeout | `output/noe-evidence-flywheel-v2/frb-001-search-provider-readiness-evidence.md`、`output/noe-multimodel/20260621-frb-001-search-provider-readiness-p1-gate/ledger.json` |
| FRB-003 cognitive entrypoint regression checks | complete as pinned historical regression P1 closeout | `output/noe-evidence-flywheel-v2/frb-003-cognitive-entrypoints-evidence.md`、`output/noe-multimodel/20260621-frb-003-cognitive-entrypoints-p1-gate/ledger.json` |
| FRB-002 act safety expectation shape | complete as P2 expectation-shape closeout | `output/noe-evidence-flywheel-v2/frb-002-act-safety-expectation-shape-evidence.md`、`output/noe-multimodel/20260621-frb-002-act-safety-expectation-shape-p2-gate/ledger.json` |
| P2 evidence hygiene backlog | open for later batch | `output/noe-evidence-flywheel-v2/p2-evidence-hygiene-backlog.md` |
| Route compat / owner-gate tests | complete | `output/noe-evidence-flywheel-v2/route-compat-owner-gate-evidence.md` |
| Owner-gate passphrase redaction | complete as non-live source/unit/browser-route proof | `output/noe-evidence-flywheel-v2/owner-gate-secret-redaction-evidence.md` |

## Accepted Ledgers

| Round | Status | Notes |
| --- | --- | --- |
| `20260619-evolution-archive-dry-run-v3` | consensus passed | Phase 5 archive dry-run final gate |
| `20260619-evolution-scorecard-dry-run-v2` | consensus passed | Phase 5 scorecard dry-run final gate |
| `20260619-pr-repair-dry-run` | consensus passed | Phase 5 PR repair dry-run final gate |
| `20260619-boundary-graphmemory-planvalidator-causalriskgate` | consensus passed | PlanValidator only; GraphMemory/CausalRisk deferred |
| `20260619-plan-validator-dry-run` | consensus passed | PlanValidator metadata-only dry-run |
| `20260619-multimodel-memory-precision-discussion` | consensus passed with Claude unavailable | Strategy discussion; Codex + M3 quorum, Claude natural language read separately |
| `20260619-shared-memory-protocol-v2` | consensus passed | Shared evidence/handoff protocol after Claude blocker fixes |
| `20260619-multimodel-exhaustive-quality-mode` | blocked, superseded by evidence pack rerun | First gate had Codex evidence-gap rejection; second gate blocked due Claude unparsed output and missing embedded verifier notes |
| `20260619-multimodel-exhaustive-quality-mode-v3` | consensus passed | Phase 6 quality-mode substrate approved; B/C/D/E still not complete |
| `20260619-final-stage-B-secret-use-v2` | consensus passed | Stage B presence-only keychain evidence accepted; C/D/E pending at that time |
| `20260619-final-stage-C-sealed-holdout-v4` | consensus passed | Stage C sealed holdout metadata-only aggregate accepted; D/E pending at that time |
| `20260619-final-stage-D-live-scratch-v1` | consensus passed | Stage D live 51835 scratch write/cleanup accepted; E pending |
| `20260619-final-bcde-real-machine-complete-v1` | consensus passed | Final B/C/D/E stage matrix complete; full Neo function testing still pending |
| `20260619-round-quality-memory-v3` | consensus passed | Round Quality Memory first slice accepted; automatic support files, evidence redaction, assemble safe refs, raw-output redaction, active-executor unavailable gate, redaction-policy visibility, and protocol update |
| `20260619-assemble-safe-ref-positive` | ledger verify passed | Positive assemble safe-ref smoke using legal `output/noe-multimodel/**` raw refs |
| `20260619-full-function-F1-core-runtime-v1` | consensus passed; superseded | Initial F1 core runtime gate before M3 max profile / active-executor abstain hardening |
| `20260619-full-function-F1-core-runtime-v2` | superseded by hardening | M3 proved available with adaptive thinking / 524288 / priority, but Codex active executor abstained; new verifier now fails this ledger with `active_executor_must_approve:codex` |
| `20260619-full-function-F1-core-runtime-v3` | consensus passed | Current accepted F1 core runtime gate: Codex active executor approve + Claude approve, M3 available but abstain due same-round visibility boundary; ledger verifier PASS under new active-executor rule |
| `20260619-full-function-F2-memory-cognition-v1` | consensus passed | Accepted only the scoped F2 read-only memory/cognition baseline with blockers preserved; 3/3 approvals; not full memory/autonomy health |
| `20260620-evidence-flywheel-v2-final-d-e-f-rerun2` | consensus passed | Stages D/E/F closeout; runtime trace snapshot, memory/skill candidate gate, candidate patch dry-run; non-live/dry-run only |
| `20260620-evidence-flywheel-v2-stage-c-closeout-r2` | consensus passed | Stage C dev/regression eval artifacts accepted after caveat-card fix; dev 4/0/0, regression 33/7/0 remains non-green |
| `20260620-evidence-flywheel-v2-stage-b-coverage-augment-r5-redacted-browser-summary` | consensus passed | 8 non-live coverage seed cases accepted; browser/UI seed now uses a path-redacted summary instead of direct `test-e2e.log`; not a fix for historical 33/7 replay baseline |
| `20260620-failed-replay-followup-backlog-v1` | consensus passed | 7 historical failed replay cases converted into 4 concrete follow-up backlog items; not a fix for historical 33/7 replay baseline |
| `20260620-failed-replay-backlog-categorization-r2` | consensus passed | 7 failed historical replay cases categorized exactly once; descriptive backlog only, old 33/7 baseline remains failed |
| `20260620-route-compat-owner-gate-final` | consensus passed | OpenAI compat route test repaired to current export/adapter contract; isolated owner-gate tests added |
| `20260620-owner-gate-secret-redaction-final-r3` | consensus passed | Owner-gate public config no longer returns passphrase values; verified by unit/routes + isolated Chromium real route harness |
| `20260621-frb-004-owner-token-ack-policy-p1-gate` | consensus passed | FRB-004 closed as scoped P1: live owner-token read remains explicit-ack/standing-grant gated; managed replay uses isolated credentials; current promotion evidence scan clean; historical output path-field cleanup tracked as P2 `EHB-001` |
| `20260621-frb-001-search-provider-readiness-p1-gate` | consensus passed | FRB-001 closed only as explicit managed search fixture proof; not a live provider-readiness claim; historical case-real-replay-001 source remains failed `8/2` |
| `20260621-frb-003-cognitive-entrypoints-p1-gate` | consensus passed | FRB-003 closed as pinned historical regression coverage: current managed replay verifies cognitive page entrypoints; old source replay artifacts remain failed `10/1` and `9/1` |
| `20260621-frb-002-act-safety-expectation-shape-p2-gate` | consensus passed | FRB-002 closed as P2 expectation-shape note: managed replay proves completed/awaiting_approval/blocked-or-failed safe three-state behavior with `realExecActs:0`; old source replay artifacts remain failed and unchanged |

## 2026-06-20 Evidence Flywheel v2 Snapshot

Current accepted status:

- Stage A/B/C baseline and replay eval substrate exist, with the historical replay baseline still `33 passed / 7 failed / 0 blocked`, `ok:false`.
- Stage C explicit target outputs now exist: `eval-run-dev.json`, `eval-run-regression.json`, and `eval-score-summary.md`. The two `eval-run-*.json` files are pointer artifacts; canonical NeoEvalRun files are `evals/neo/dev/run-stage-c-dev.json` and `evals/neo/regression/run-stage-c-regression.json`. Dev is all-green (`4/0/0`, `ok:true`); regression intentionally preserves the historical replay baseline (`33/7/0`, `ok:false`).
- Stage B coverage augment now adds 8 dev coverage seed cases for memory recall, social publish rollback, restart readiness, tool-call verify-fail, self-evolution rollback, SSRF/skill-scan security, browser/UI, and voice-ear automatic verification. This is coverage-seed evidence only; it does not modify or re-score the original 40-case replay bundle and does not make the `33/7/0` regression baseline green.
- Stage D/E/F is closed as a non-live evidence/dry-run slice: runtime trace snapshot, unified candidate gate, and candidate patch dry-run all have local tests, hash checks, redaction scan, subagent review, and multi-model ledger verification.
- The 7 failed historical replay cases are categorized as descriptive backlog. This does not rewrite old replay artifacts and does not claim all-green.
- The 7 failed historical replay cases now also have concrete follow-up backlog items in `output/noe-evidence-flywheel-v2/failed-replay-followup-backlog.md`: FRB-001 search provider readiness, FRB-002 safe no-real-execution expectation shape, FRB-003 cognitive entrypoint regression checks, and FRB-004 explicit owner-token ack policy.
- FRB-004 is now closed as a scoped P1 item. Evidence: default live replay without ack policy-blocked, managed replay 11/11 pass on an isolated non-reserved port, current promotion evidence high-signal scan 0, closeout live health/readiness fresh, and formal Codex/Claude/M3 gate passed. This does not make the historical `33/7/0` replay baseline green.
- FRB-001 is now closed as a scoped P1 managed-fixture item. Evidence: search-related unit tests `3 files / 36 tests passed`, managed replay on isolated port `51743` passed `11/11`, and the three relied-on checks are `managed_search_fixture_is_explicit`, `noe_do_search_returns_results`, and `voice_text_search_returns_sanitized_reply`. This is not a live web-provider readiness proof.
- FRB-003 is now closed as a scoped P1 pinned-historical-regression item. Evidence: cognitive entrypoint unit tests `3 files / 14 tests passed`, managed replay on isolated port `53744` passed `11/11`, and `cognitive_page_core_entrypoints_present` verified research script, chat input, people KB entrypoint, and people sheet via real HTTP page/resource fetch. Historical source replay artifacts remain failed `10/1` and `9/1`.
- FRB-002 is now closed as a P2 expectation-shape item. Evidence: act pipeline tests `5 files / 50 tests passed`, managed replay on isolated port `56096` passed `11/11`, and `acts_safety_three_states_no_real_execution` verified low-risk `completed`, high-risk `awaiting_approval`, dangerous action `failed`, `noRealExecution:true`, and `realExecActs:0`. Historical source replay artifacts remain failed `10/1`; case 004 can show zero real execution while still staying failed because it used the older expectation shape.
- P2 evidence hygiene follow-up `EHB-001` is tracked separately because a broad historical scan found older pre-existing real-use replay reports with path-like owner credential fields. These old artifacts are excluded from FRB-004 promotion evidence.
- Route compat / owner-gate tests were repaired after a stale API-contract diagnostic: `tests/unit/routes/openai-compat.test.js` now targets `registerOpenaiCompatRoutes`; `tests/unit/routes/noe-owner-gate.test.js` uses isolated HOME and dynamic imports.
- Owner-gate passphrase redaction was fixed: `OwnerGateStore.publicConfig()` returns no secret values, and the cognitive identity bridge preserves existing passphrases unless the user submits a new passphrase or explicitly clears it.

Verification anchors:

- Route compat / owner-gate: target tests `3 files / 20 tests passed`; adjacent regression `2 files / 30 tests passed`; all routes `59 files / 385 tests passed`; consensus ledger verify passed.
- Owner-gate passphrase redaction: `node --check` passed for 4 files; target tests `3 files / 37 tests passed`; all routes `59 files / 387 tests passed`; isolated Chromium mock and isolated Chromium real route harness both `ok:true`; consensus r3 approvals `codex, claude, m3`.
- Stage C: artifact validation `checked:50`, `failed:0`; here validation means schema/reference consistency plus hash-manifest checks, not scorer-semantic completeness. Stage C hash check all OK; redaction scan `highMatchCount:0`; sealed private holdout referenced only as metadata/hash aggregate. The sealed aggregate hash is a metadata fingerprint, not raw-content integrity proof.
- Stage B coverage augment: coverage run `8/0/0`, schema/artifact validation `checked:11`, redaction scan covers 22 files with `highMatchCount:0`, `classifiedReviewMatches:92`, hash check all OK, and final r5 ledger verifier passed. Browser/UI seed evidence now points to `output/noe-evidence-flywheel-v2/browser-ui-e2e-redacted-summary.json` rather than direct `test-e2e.log`; residual-reference audit and review-classification sample both passed. Post-r3/r5 local checks confirmed `51835` not listening, LM Studio model list `[]`, scorer/schema diff empty, no owner-token value shape in `test-e2e.log`, and no high-risk secret shape in r5 evidence.
- Failed replay follow-up backlog: validation `ok:true`, 7/7 cases covered exactly once, secret-shape scan `0`, hash check `18/18 OK`, scorer/eval/old replay diff empty, final ledger verifier `PASS approvals=3/2`.
- FRB-004 closeout: `node --check` passed for replay script and owner-token policy test; focused vitest `2 files / 10 tests passed`; default live replay with `NOE_STANDING_AUTONOMY_GRANT=0` policy-blocked as expected; managed replay `11/11` passed; closeout high-signal scan `0`; consensus ledger verifier `PASS approvals=3/2`; closeout live probe kept `51835` healthy/readiness passed and observed `51735` still separate.
- FRB-001 closeout: `node --check` passed for `scripts/noe-real-use-replay.mjs`, `src/research/AISearch.js`, `src/research/WebSearch.js`, and `src/research/ResearchIntent.js`; target search tests `3 files / 36 tests passed`; managed replay `11/11` passed; original historical replay source re-probe still `ok:false`, `8 passed`, `2 failed`; closeout scan `0`; consensus ledger verifier `PASS approvals=3/2`.
- FRB-003 closeout: `node --check` passed for replay and cognitive frontend modules; target cognitive structure tests `3 files / 14 tests passed`; managed replay `11/11` passed; original historical replay source re-probes still `ok:false`, `10/1` and `9/1`; source spot-check confirms HTTP page/resource fetch based check; closeout scan `0`; consensus ledger verifier `PASS approvals=3/2`.
- FRB-002 closeout: target act tests `5 files / 50 tests passed`; managed replay `11/11` passed; original historical replay source re-probes still `ok:false`, `10/1` for all three cases; no-weakening diff/hash evidence recorded; final consensus ledger verifier rerun `PASS approvals=3/2`; final read-only live probe kept `51835` healthy/readiness passed and observed `51735` still separate.
- Redaction scan for owner-gate redaction: `ok:true`, `highMatchCount:0`, `reviewMatchCount:232`, review matches classified as guardrail/descriptive markers; report prints no raw match text.

Important caveats:

- These 2026-06-20 Evidence Flywheel v2 slices did not restart or probe live `51835` after the later model pause, and did not touch `51735`.
- They did not read raw secret or raw private_holdout content.
- They did not perform new live social publishing/deletion.
- FRB-004 did not restart, kill, or take over live `51835`; it used a managed isolated temporary instance for positive replay proof and only performed public health/readiness probes on live `51835`.
- FRB-001 did not call live web search providers and did not prove provider readiness for production. Future live search claims still require a fresh live provider probe and separate gate.
- FRB-003 did not run a live owner-token browser E2E against `51835`; its positive proof is managed HTTP replay plus static/structure tests. Future full UI/E2E claims still need their own browser/live evidence.
- FRB-002 did not make the historical `33/7/0` replay baseline green. It documents the current safe expectation shape and preserves the historical failures as regression input.
- The worktree is intentionally dirty with many unrelated/inherited changes; do not treat uncommitted status as belonging to one slice without checking scoped dirty-state artifacts.

## Current Shared-Memory Slice

Round: `20260619-final-bcde-real-machine-complete-v1`

Purpose:
- Final B/C/D/E real-machine closeout accepted the scoped evidence for B presence-only configured secret check, C sealed metadata aggregate, D live 51835 scratch write/cleanup, and E final 51835 restart recovery.
- Final gate passed 3/3 with `parseErrors=[]`, validation `ok=true`, `fallbacks=[]`, and Stage Matrix `requireComplete:true`, `completed:["B","C","D","E"]`.
- Claude had unparsed initial output and was repaired by same-model JSON repair; repaired same-model JSON was counted.
- Caveat: this is not proof that all Neo features were exhaustively tested. Full-function real-machine testing remains pending.

Round: `20260619-round-quality-memory-v3`

Purpose:
- Accepted the first implementation slice for later tasks to use automatic round support files: `evidence.md`, `evidence-pack.md`, `disagreements.md`, `staleness-ledger.md`, `verifier-notes.md`, and `final-handoff.md`.
- Accepted evidence-text redaction before prompts/shared docs, raw-output redaction for assembled ledgers, assemble safe-ref allowlist, active-executor unavailable gate behavior, visible redaction policy, and protocol update.
- Gate passed 3/3 with `parseErrors=[]`, validation `ok=true`, and ledger verifier PASS.
- Caveat: this does not prove all multimodel improvements are complete; v3 models recommended next slices for `claims.json`, `verifier-notes.json`, machine TTL enforcement, structured evidence pack CLI, subagent artifacts, and repair provenance.

Round: `20260619-full-function-F1-core-runtime-v3`

Purpose:
- Accepted only the narrow F1 claim: current `51835` health/readiness/runtime-evidence/100-readiness/full-current live verification passed with caveats.
- M3 is configured for formal `exhaustive` rounds with `thinking.type=adaptive`, `maxCompletionTokens=524288`, `reasoningSplit=true`, `serviceTier=priority`, and `noAbort=true`; manifest records `secretStatus.source=keychain` without secret value.
- v2 gate exposed that dynamic quorum was insufficient when the active executor abstained. `NoeConsensusGate` now requires selected active executor approval; v2 ledger intentionally fails verifier under the new rule.
- v3 ledger verifier passes under the new rule: Codex active executor approve, Claude approve, M3 available but abstain because same-round Codex vote is not visible before M3 generation.
- Caveat: F1 does not prove full Neo health. It does not resolve `curiosity_harvest_missing` / `affect_health_below_target`, does not prove UI/e2e, external readiness, write-route coverage, or this-run restart recovery.

Round: `20260619-full-function-F2-memory-cognition-v1`

Purpose:
- Accepted only the scoped F2 claim: read-only memory/cognition baseline evidence is valid, summary-only, locally verified, and safe to carry into F3 with blockers preserved.
- Evidence files:
  - `output/noe-full-function-real-machine/20260619/F2-memory-cognition-evidence.md`
  - `output/noe-full-function-real-machine/20260619/F2-memory-cognition-results.json`
  - `output/noe-full-function-real-machine/20260619/F2-subagent-closeout.md`
  - `output/noe-full-function-real-machine/20260619/F2-gate-evidence.md`
- Local verification after Dalton P1 fixes:
  - `npm run test:noe:consensus`: 10 files / 144 tests passed
  - `node scripts/ensure-node22.mjs --require-22 --exec scripts/noe-self-evolution-plan-verify.mjs`: 215 passed / 0 failed
  - `npm run verify:noe:growth-readiness`: `ok:true`
  - F2 package scan for raw secret / sealed holdout / owner-token path / raw memory body: no matches
- Subagent review:
  - Rawls: `pass_with_blockers`, `canProceedToF3:true`
  - Dalton: initial P1 findings fixed; re-review `pass`, P0/P1/P2 none
- Multi-model gate:
  - Codex / Claude / M3 approvals 3/3
  - `parseErrors=[]`, validation `ok=true`, ledger verifier PASS
  - M3 manifest: `thinking.type=adaptive`, `maxCompletionTokens=524288`, `reasoningSplit=true`, `serviceTier=priority`, `noAbort=true`
- Preserved blockers:
  - `runtime:curiosity_harvest_missing`
  - `runtime:affect_health_below_target`
  - `expectation:live_expectation_overdue_open`
  - P8/observation blockers including `observation_window_not_elapsed` and missing categories
  - `personality:owner_training_plan_required`
  - live memory provenance remains deferred until a separate owner-token ack + controlled live write/provenance stage
- Caveat: F2 does not prove full memory/autonomy/runtime health. It only proves the read-only baseline and the safe F3 carry-forward framing.

Not authorized:
- no broad claim that all Neo features are tested;
- no memory-v2/SkillStore/GraphMemory write;
- no CausalRisk runtime gate;
- no patch apply;
- no git/gh/PR/publish;
- no secret/private_holdout read.

## Next Read Order For Reviewers

1. `docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md`
2. `docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md`
3. `output/noe-multimodel/20260619-round-quality-memory-v3/final-handoff.md`
4. `output/noe-multimodel/20260619-round-quality-memory-v3/evidence-pack.md`
5. `output/noe-multimodel/20260619-round-quality-memory-v3/staleness-ledger.md`
6. `output/noe-multimodel/20260619-round-quality-memory-v3/verifier-notes.md`
7. `output/noe-multimodel/20260619-round-quality-memory-v3/manifest.json`
8. `output/noe-multimodel/20260619-round-quality-memory-v3/ledger.json`
9. `output/noe-final-real-machine-stages/20260619/stage-final-bcde-closeout.md`
10. `output/noe-final-real-machine-stages/20260619/stage-final-bcde-evidence-pack.md`
11. `output/noe-multimodel/20260619-final-bcde-real-machine-complete-v1/manifest.json`
12. `output/noe-multimodel/20260619-final-bcde-real-machine-complete-v1/ledger.json`
13. `output/noe-final-real-machine-stages/20260619/stage-E-verifier-notes.md`
14. `output/noe-final-real-machine-stages/20260619/stage-E-final-51835-restart-recovery.json`
15. `output/noe-final-real-machine-stages/20260619/stage-D-final-closeout.md`
16. `output/noe-final-real-machine-stages/20260619/stage-C-final-closeout.md`
17. `output/noe-final-real-machine-stages/20260619/stage-B-final-closeout.md`
18. `output/noe-multimodel/20260619-multimodel-exhaustive-quality-mode-v3/ledger.json`
19. `output/noe-full-function-real-machine/20260619/F1-core-runtime-evidence.md`
20. `output/noe-multimodel/20260619-full-function-F1-core-runtime-v3/final-handoff.md`
21. `output/noe-multimodel/20260619-full-function-F1-core-runtime-v3/verifier-notes.md`
22. `output/noe-multimodel/20260619-full-function-F1-core-runtime-v3/manifest.json`
23. `output/noe-multimodel/20260619-full-function-F1-core-runtime-v3/ledger.json`
24. `output/noe-full-function-real-machine/20260619/F2-memory-cognition-evidence.md`
25. `output/noe-full-function-real-machine/20260619/F2-subagent-closeout.md`
26. `output/noe-multimodel/20260619-full-function-F2-memory-cognition-v1/final-handoff.md`
27. `output/noe-multimodel/20260619-full-function-F2-memory-cognition-v1/verifier-notes.md`
28. `output/noe-multimodel/20260619-full-function-F2-memory-cognition-v1/manifest.json`
29. `output/noe-multimodel/20260619-full-function-F2-memory-cognition-v1/ledger.json`

## Copy-Paste Prompt

```text
请按 Neo 多模型共享记忆协议继续：先读取 docs/NOE_MULTIMODEL_OPERATING_PROTOCOL.md、docs/HANDOFF_INDEX_2026-06-19_Neo_Multimodel_Shared_Memory.md、.planning/2026-06-19-hermes-openclaw-self-evolution/task_plan.md、.planning/2026-06-19-hermes-openclaw-self-evolution/progress.md，再读取 output/noe-multimodel/20260619-round-quality-memory-v3/final-handoff.md、evidence-pack.md、staleness-ledger.md、verifier-notes.md、manifest.json 和 ledger.json；然后读取 output/noe-final-real-machine-stages/20260619/stage-final-bcde-closeout.md、stage-final-bcde-evidence-pack.md、output/noe-multimodel/20260619-final-bcde-real-machine-complete-v1/manifest.json 和 ledger.json；再读取 output/noe-full-function-real-machine/20260619/F1-core-runtime-evidence.md、output/noe-multimodel/20260619-full-function-F1-core-runtime-v3/manifest.json 和 ledger.json；最后读取 output/noe-full-function-real-machine/20260619/F2-memory-cognition-evidence.md、F2-subagent-closeout.md、output/noe-multimodel/20260619-full-function-F2-memory-cognition-v1/manifest.json 和 ledger.json。当前 B/C/D/E final-stage matrix 已完成，Round Quality Memory v3 first slice 已通过，F1 core runtime gate v3 已通过，F2 read-only memory/cognition baseline gate v1 已通过；但 F2 明确保留 runtime/expectation/P8/personality/live-provenance blockers，不能声称 full memory/autonomy health。下一步继续 F3 tools/MCP/external readiness：每阶段实机运行、子代理审核、Codex/Claude/M3 gate。不得读取 raw secret/private_holdout；不得写 memory-v2/SkillStore/GraphMemory；不得 commit/push/publish。
```
