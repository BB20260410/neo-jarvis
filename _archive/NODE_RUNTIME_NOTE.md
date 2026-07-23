# Node runtime note for Noe CE05

Generated: 2026-06-01T16:58:52Z

- Project engine in package.json: `node >=22`.
- Default shell node currently reports: `v26.0.0` at `/opt/homebrew/bin/node`.
- `v26.0.0` is newer than 22 and satisfies `>=22`; do not treat it as a hard blocker unless a concrete native-module/runtime failure is observed.
- Exact Node 22 is installed locally and can be invoked directly:
  - node: `/Users/hxx/.nvm/versions/node/v22.22.2/bin/node`
  - version: `v22.22.2`

If a validation command must use exact Node 22, run it as:

```bash
/Users/hxx/.nvm/versions/node/v22.22.2/bin/node <script-or-file>
```

Do not block on `nvm: command not found` in a non-interactive shell. This machine has Node 22 installed; the shell PATH simply defaults to Homebrew Node 26.
