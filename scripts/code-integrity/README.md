# Neo Code Integrity — isolated, fail-closed quality-gate prototype

This directory is intentionally self-contained and has no `package.json`
integration. It was created in an independent clone so an active Neo working
tree can continue changing without receiving writes from this task.

## Safety model

`safe-run.mjs` launches one explicitly allowlisted absolute executable through
macOS `sandbox-exec`. The static profile:

- permits writes only below a dedicated runtime root;
- denies network access;
- denies process signals;
- denies every executable except the exact allowlist;
- denies reads from user-state roots and any live repository/worktree supplied
  through `--protect-read`;
- forwards no `HOME`, provider key, token, password or cookie environment.

The outer runner writes a hashed receipt for every invocation. Its receipt
contains hashes and byte counts, not raw command output. The changed gate keeps
raw test output only under its isolated runtime root and binds those files by
hash so a later verifier can detect deletion or alteration.

`safe-run.mjs` also binds the runner, policy, executable, Node entrypoint,
arguments, generated outputs and a short-lived one-run guard context. The gate
refuses direct execution without that context. Runtime/profile/context/receipt
paths are no-follow and write-once; child processes are denied writes to all
runner control directories, whose inode and hashes are revalidated after exit.
Each run has a 60-second default timeout,
lower scheduling priority and a bounded Node heap. These controls reduce risk,
but do not provide CPU, file-descriptor or process-count cgroups on macOS.

This is a fail-closed prototype. `sandbox-exec` is deprecated on macOS, so the
guard is considered usable only after every negative canary passes on the
current machine. It is not yet permission to run Neo server, Electron, E2E,
full Vitest, build, release, live probes, restart/repair or apply/rollback
commands.

`snapshot.mjs` represents a dirty worktree as `B0 + Bwork overlay`. It accepts
the overlay only when the source manifest before copying, the source manifest
after copying and the copied bytes share one digest. Acceptance means the
capture was internally stable; `snapshot-verify.mjs` must still be run before
use because another window may make it stale immediately. `Bauth` remains null
until a unique integrator declares a real checkpoint.

`checkpoint-create.mjs` currently emits a derived **candidate** checkpoint from
a clean Git HEAD/tree. It uses the `sha256:` representation expected by Neo but
explicitly records `canonicalSourceDigest: null`, `productionReady: false` and
unverified integrator authority. It is not Bauth.

`patch-bundle.mjs` v3 therefore emits candidate-only base/ours/new-file
payloads and refuses partial dirty slices. `tracked.patch` is review-only and
is never the application source; future replay must use the verified `ours`
payload plus deletion records after a unique integrator binds current Bauth and
Neo's canonical `NoeSourceDigest`. Candidate assurance requires a four-way
chain: the changed gate, its safe-run receipt, a machine-readable current
verification result and that verifier's bound safe-run receipt. This is named
`candidate_current`, never replay or production validation. `verify-bundle.mjs`
re-hashes every payload, evidence file and review patch, requires a clean target at the exact HEAD/tree, and
checks preimage bytes and file mode. `verify-bundle-set.mjs` is deliberately a
set-metadata verifier: it checks one candidate base tuple, overlap and dependency
order, but is not an apply simulator. Earlier v1/v2 authoritative claims are
superseded and must not be integrated.

`activity-scan.mjs` checks both exact dirty-path overlap and caller-declared
literal responsibility terms. A zero exact-path overlap is not considered
clear when another active window is changing the same source-digest,
acceptance, completion-truth, receipt or patch responsibilities.

## Changed gate and receipts

`changed-gate.mjs` supports three strict input modes:

- `worktree`: the combined tracked, staged and untracked overlay;
- `staged`: the index only, and it refuses any unstaged or untracked bytes so
  tests cannot accidentally validate content that is absent from the index;
- `commit-range`: a checked-out `<base>..<head>` range with a clean worktree.

For code-integrity changes the gate selects twelve allowlisted test entries:
eleven locally executed assertion/integration tests and one external-evidence
entry, `gate.integration.test.mjs`. The external entry is not nested-executed;
its current summary and companion safe-run writer receipt are verified instead.
An exact, data-only `impact-map.json` binds every changed behavior source to at
least one success and one failure invariant. Changed project tests are selected automatically;
ordinary project tests run only through the exact regular-file Vitest runner
whose hash is recorded. Arbitrary Node files cannot be supplied as fake test
evidence. An explicit `--test <relative-test-path>` can map another small slice.
The gate fails closed on an empty change set, missing mapping/tests/artifacts,
slice drift, critical configuration, unsupported/non-Node behavior, mechanical
violations or command failures. Critical and non-Node changes are escalated to
a future full gate instead of receiving a changed-only PASS.

Required evidence is schema-aware. A valid activity report with
`clearForSlice:false` remains valid negative evidence: the isolated static gate
may pass while `integration.ready` stays false. Unknown or opaque JSON cannot
stand in for canary, activity or external integration evidence.

The gate receipt binds base/head, changed bytes, incremental added-line policy,
controls, selected tests and runner hash, command arguments/results/log hashes,
required artifacts, Node/Git versions and the policy classification.
`verify-gate-receipt.mjs` reconstructs the policy, mechanical result and exact
command plan, checks exact task/read/write/protected roots and the rebuilt
sandbox profile, then atomically writes a machine-readable `current` or `stale`
result. That result must itself be a bound output of another safe-run.

The macOS-safe gate integration test is external evidence rather than a nested
test command. Its v2 summary binds the source digest before and after the run,
a unique round, the exact required scenario matrix, each entrypoint/argument/
expected exit and all safe-run receipts. The changed gate accepts it only with
the companion safe-run writer receipt and current source bytes.

`typescript-diagnostic-capture.mjs` actually invokes the pinned TypeScript
entrypoint, captures stdout/stderr, records tool bytes and recomputes the source
digest before and after. `diagnostic-ratchet.mjs` accepts only that typed
evidence plus its three-output safe-run receipt. Diagnostic fingerprints omit
line/column positions, while any new diagnostic kind or additional occurrence
fails. Legacy caller-supplied v1 version/command/digest/exit fields are rejected.

This directory is intentionally not connected to `package.json`, hooks or CI
while another window owns the active Neo worktree. Integration requires a
declared authoritative checkpoint and a fresh receipt on that exact baseline.

## Initial verification

Run the pure policy assertions through `safe-run`, then run `canary.mjs` with
the live repository path and a known foreign PID. All ten cases must pass:
runtime write allowed; clone-source write, live-repository read and `r+`,
control-directory replacement, symlink read and `r+`, foreign signal,
`launchctl` exec and network denied.

Run `gate.integration.test.mjs` directly as a read-only orchestrator. macOS
does not permit nested `sandbox-exec`; the driver itself performs no writes and
delegates every fixture mutation and gate invocation to a separate safe-run.
Its summary and safe-run receipt are required evidence for final verification.

Then run the changed gate through `safe-run` using the project-pinned Node
version, allowlisting both the Apple Git shim and its Xcode Git target. Always
protect the live repository and every owned worktree with `--protect-read`.
