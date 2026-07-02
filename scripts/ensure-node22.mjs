#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MINIMUM_MAJOR = 22;
const DEFAULT_REQUIRED_MAJOR = 22;

function clean(value, max = 2000) {
  return String(value || '').trim().slice(0, max);
}

function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const text = clean(value);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function readProjectNvmrc(root = ROOT) {
  try {
    return readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  } catch {
    return '';
  }
}

function majorFromVersion(version) {
  const match = clean(version).match(/^v?(\d+)\./);
  return match ? Number(match[1]) : 0;
}

function nodeInfo(bin) {
  const candidate = clean(bin);
  if (!candidate) return null;
  const result = spawnSync(candidate, ['-e', 'process.stdout.write(JSON.stringify({version:process.version,modules:process.versions.modules,execPath:process.execPath}))'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (result.status !== 0) {
    return {
      bin: candidate,
      ok: false,
      error: clean(result.stderr || result.stdout || `exit ${result.status}`, 500),
    };
  }
  try {
    const parsed = JSON.parse(result.stdout || '{}');
    return {
      bin: candidate,
      ok: true,
      version: parsed.version || '',
      major: majorFromVersion(parsed.version),
      modules: String(parsed.modules || ''),
      execPath: parsed.execPath || candidate,
    };
  } catch {
    return { bin: candidate, ok: false, error: 'invalid node probe output' };
  }
}

function whichNode() {
  try {
    const result = spawnSync('which', ['node'], { encoding: 'utf8', timeout: 3000 });
    if (result.status === 0) return result.stdout.trim();
  } catch {}
  return '';
}

export function candidateNodeBins({
  root = ROOT,
  env = process.env,
  execPath = process.execPath,
  homeDir = homedir(),
} = {}) {
  const nvmrc = readProjectNvmrc(root);
  const nvmVersion = nvmrc.replace(/^v/, '');
  const userHome = env.USER ? join('/Users', env.USER) : '';
  const lognameHome = env.LOGNAME ? join('/Users', env.LOGNAME) : '';
  return unique([
    env.NOE_NODE_BIN,
    env.NVM_DIR && nvmVersion ? join(env.NVM_DIR, 'versions', 'node', `v${nvmVersion}`, 'bin', 'node') : '',
    nvmVersion ? join(homeDir, '.nvm', 'versions', 'node', `v${nvmVersion}`, 'bin', 'node') : '',
    nvmVersion && userHome ? join(userHome, '.nvm', 'versions', 'node', `v${nvmVersion}`, 'bin', 'node') : '',
    nvmVersion && lognameHome ? join(lognameHome, '.nvm', 'versions', 'node', `v${nvmVersion}`, 'bin', 'node') : '',
    whichNode(),
    execPath,
  ]);
}

export function selectNodeRuntime({
  current = {
    bin: process.execPath,
    ok: true,
    version: process.version,
    major: majorFromVersion(process.version),
    modules: process.versions.modules,
    execPath: process.execPath,
  },
  candidates = [],
  minimumMajor = DEFAULT_MINIMUM_MAJOR,
  requiredMajor = null,
} = {}) {
  const usable = candidates.filter((item) => item?.ok);
  const exact = requiredMajor
    ? usable.find((item) => item.major === requiredMajor)
    : null;
  if (requiredMajor) {
    if (current?.major === requiredMajor) {
      return { ok: true, selected: current, mode: 'current_exact', candidates };
    }
    if (exact) return { ok: true, selected: exact, mode: 'candidate_exact', candidates };
    return {
      ok: false,
      error: `Noe validation requires Node ${requiredMajor}.x but no usable runtime was found.`,
      current,
      candidates,
    };
  }

  if (current?.major >= minimumMajor) {
    return { ok: true, selected: current, mode: current.major === DEFAULT_REQUIRED_MAJOR ? 'current_node22' : 'current_minimum_ok', candidates };
  }
  const fallback = usable.find((item) => item.major >= minimumMajor);
  if (fallback) return { ok: true, selected: fallback, mode: 'candidate_minimum_ok', candidates };
  return {
    ok: false,
    error: `Noe requires Node >=${minimumMajor}; current=${current?.version || 'unknown'}.`,
    current,
    candidates,
  };
}

export function resolveNode22OrFail(options = {}) {
  const candidates = candidateNodeBins(options).map(nodeInfo);
  const current = {
    bin: process.execPath,
    ok: true,
    version: process.version,
    major: majorFromVersion(process.version),
    modules: process.versions.modules,
    execPath: process.execPath,
  };
  const selected = selectNodeRuntime({
    current,
    candidates,
    requiredMajor: DEFAULT_REQUIRED_MAJOR,
  });
  if (!selected.ok) {
    const tried = candidates.map((item) => `${item?.bin || '-'} ${item?.ok ? item.version : item?.error || 'unusable'}`).join('\n  - ');
    const err = new Error(`${selected.error}\nTried:\n  - ${tried}\nSet NOE_NODE_BIN=/path/to/node22 or use .nvmrc ${readProjectNvmrc(options.root || ROOT) || '22.x'}.`);
    err.details = selected;
    throw err;
  }
  return selected.selected.execPath || selected.selected.bin;
}

export function ensureMinimumNode(options = {}) {
  const current = {
    bin: process.execPath,
    ok: true,
    version: process.version,
    major: majorFromVersion(process.version),
    modules: process.versions.modules,
    execPath: process.execPath,
  };
  const candidates = candidateNodeBins(options).map(nodeInfo);
  return selectNodeRuntime({
    current,
    candidates,
    minimumMajor: options.minimumMajor || DEFAULT_MINIMUM_MAJOR,
  });
}

function parseArgs(argv) {
  const out = {
    requireMajor: null,
    minimumMajor: DEFAULT_MINIMUM_MAJOR,
    printBin: false,
    json: false,
    execArgs: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--require-22') out.requireMajor = DEFAULT_REQUIRED_MAJOR;
    else if (arg.startsWith('--require-major=')) out.requireMajor = Number(arg.split('=')[1]);
    else if (arg.startsWith('--minimum-major=')) out.minimumMajor = Number(arg.split('=')[1]);
    else if (arg === '--print-bin') out.printBin = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--exec') {
      out.execArgs = argv.slice(i + 1);
      break;
    }
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const candidates = candidateNodeBins().map(nodeInfo);
  const current = {
    bin: process.execPath,
    ok: true,
    version: process.version,
    major: majorFromVersion(process.version),
    modules: process.versions.modules,
    execPath: process.execPath,
  };
  const result = selectNodeRuntime({
    current,
    candidates,
    minimumMajor: args.minimumMajor,
    requiredMajor: args.requireMajor,
  });
  if (!result.ok) {
    console.error(`[node-runtime] ${result.error}`);
    for (const candidate of candidates) {
      console.error(`  - ${candidate?.bin || '-'}: ${candidate?.ok ? `${candidate.version} ABI ${candidate.modules}` : candidate?.error || 'unusable'}`);
    }
    process.exit(1);
  }

  const selectedBin = result.selected.execPath || result.selected.bin;
  if (args.execArgs?.length) {
    const [script, ...scriptArgs] = args.execArgs;
    const child = spawnSync(selectedBin, [script, ...scriptArgs], {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
    });
    process.exit(typeof child.status === 'number' ? child.status : 1);
  }
  if (args.printBin) {
    console.log(selectedBin);
    return;
  }
  if (args.json) {
    console.log(JSON.stringify({
      ok: true,
      mode: result.mode,
      selected: result.selected,
      current,
      nvmrc: readProjectNvmrc(),
    }, null, 2));
    return;
  }
  console.log(`[node-runtime] ok mode=${result.mode} selected=${selectedBin} version=${result.selected.version} abi=${result.selected.modules} current=${process.version} currentAbi=${process.versions.modules}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
