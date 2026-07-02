#!/usr/bin/env node
import { parseArgs } from './lib/noe-social-dom-live-probe-utils.mjs';
import { runNoeSocialDomLiveProbe } from './lib/noe-social-dom-live-probe-runner.mjs';

export { runNoeSocialDomLiveProbe };

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const out = await runNoeSocialDomLiveProbe({ options });
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.ok ? 0 : out.tokenPolicy?.policyBlocked ? 2 : 1;
}

if (process.argv[1] && process.argv[1].endsWith('noe-social-dom-live-probe.mjs')) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
