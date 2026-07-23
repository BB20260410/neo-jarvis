# NeoEval

NeoEval stores sanitized evaluation case definitions for Neo.

Current status:
- Schema validator: connected.
- Offline scorer: connected for sanitized dev/regression run files.
- Live runtime runner: not connected yet.

Layers:
- `dev/`: small sanitized cases for development.
- `regression/`: stable sanitized cases for known regressions.
- `private_holdout/`: structure only; real private holdout content must not be committed.

Schema: `docs/NEOEVAL_SCHEMA_2026-06-19.md`.
Scorer: `scripts/noe-eval-score.mjs`.
