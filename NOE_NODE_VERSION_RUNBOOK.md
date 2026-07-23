# Noe Node Runtime Runbook

Generated for CE12 P0 productization on 2026-06-02.

## Source Of Truth

- `package.json` declares `engines.node = ">=22"`.
- The default non-interactive shell may report Node `v26.0.0`; this satisfies the package engine, but the current Noe workspace native modules are compiled for Node 22 ABI `127`.
- Current concrete evidence: Node 22 can load `better-sqlite3`; Node 26 fails on the same Noe workspace with `NODE_MODULE_VERSION 127` vs required `147`.
- Exact Node `22.22.2` is installed and is used for reproducible validation evidence:
  - `/Users/hxx/.nvm/versions/node/v22.22.2/bin/node`
- `.nvmrc` pins `22.22.2`.

## Runtime Gate

Use `scripts/ensure-node22.mjs` for validation commands that need exact Node 22:

```bash
node scripts/ensure-node22.mjs --require-22 --json
node scripts/ensure-node22.mjs --require-22 --exec node_modules/vitest/vitest.mjs run tests/unit/node-runtime-gate.test.js
```

The gate probes, in order:

1. `NOE_NODE_BIN`
2. `.nvmrc` under the local nvm install path
3. `which node`
4. `process.execPath`

If an exact Node 22 runtime is required and unavailable, the gate fails closed with the probed paths and versions. If only a minimum runtime is required, Node `>=22` is accepted.

## Operational Rules

- Core startup and validation scripts must go through the Node 22 wrapper so the root `node_modules` ABI stays coherent:
  - `npm start`
  - `npm run start:noe`
  - `npm run dev`
  - `npm test`
- CE12 evidence scripts use exact Node 22:
  - `npm run verify:node22`
  - `npm run test:e2e`
  - `npm run smoke:electron`
- Do not block on `nvm: command not found` in a non-interactive shell. Use the direct Node 22 path or `NOE_NODE_BIN`.
- Node 26 is not a policy blocker, but it is not the active runtime for this workspace until native modules are rebuilt for ABI `147`.

## Native Module Recovery

If native modules fail after switching Node versions:

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/npm rebuild better-sqlite3 node-pty @homebridge/node-pty-prebuilt-multiarch
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node -e "import('better-sqlite3').then(() => console.log('better-sqlite3 ok'))"
```

Node 26 compatibility is a warning and investigation path, not a CE12 blocker, unless an actual command fails.
