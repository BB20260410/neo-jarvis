#!/usr/bin/env node
// Deprecated CE10/CE11 Brain UI e2e entry.
// CE12 replaced this with tests/e2e/noe-brain-ui-p0.e2e.mjs so the managed
// evidence chain no longer cites the known-bad historical script as a pass.
console.warn('[deprecated][replaced] tests/e2e/noe-brain-ui.e2e.mjs forwards to tests/e2e/noe-brain-ui-p0.e2e.mjs');
await import('./noe-brain-ui-p0.e2e.mjs');
