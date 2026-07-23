import { spawn } from 'node:child_process';
import { createWebSearch } from './WebSearch.js';
import { sanitizeNoeHostExecEnv } from '../security/NoeHostExecEnv.js';
import { parseNoeLlmJsonValue, stripNoeLlmThinking } from '../runtime/NoeLlmJsonExtractor.js';

const PROVIDER_LABELS = {
  minimax: 'MiniMax Search API',
  codex: 'Codex CLI Web Search',
  claude: 'Claude CLI WebSearch',
  searxng: 'SearXNG fallback',
  brave: 'Brave fallback',
  noe_managed_fixture: 'Managed Noe Search Fixture',
};

const PROVIDER_ORDER = ['minimax', 'codex', 'claude', 'searxng', 'brave'];
const MAX_CLI_OUTPUT = 12000;

function cliStatus(envName, env = process.env) {
  return {
    enabled: env[envName] === '1',
    reason: env[envName] === '1'
      ? 'enabled_by_env_explicit_opt_in'
      : 'disabled_by_default_to_avoid_spawning_paid_cli',
  };
}

function tagResults(results) {
  return (Array.isArray(results) ? results : []).map((r) => ({
    ...r,
    viaModel: PROVIDER_LABELS[r.source] || r.source || 'unknown',
  }));
}

function stripFence(text) {
  return stripNoeLlmThinking(text).replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
}

function parseCliResults(provider, query, output, count) {
  const clean = stripFence(output);
  const parsed = parseNoeLlmJsonValue(clean, null);
  if (parsed) {
    const arr = Array.isArray(parsed) ? parsed : parsed.results || parsed.organic || [];
    if (Array.isArray(arr) && arr.length) {
      return arr.slice(0, count).map((r) => ({
        title: String(r.title || r.name || `${PROVIDER_LABELS[provider]} result`).slice(0, 160),
        url: String(r.url || r.link || ''),
        snippet: String(r.snippet || r.description || r.summary || r.content || '').slice(0, 800),
        date: r.date || '',
        source: provider,
      }));
    }
    if (parsed.answer || parsed.summary) {
      return [{ title: `${PROVIDER_LABELS[provider]} answer`, url: '', snippet: String(parsed.answer || parsed.summary).slice(0, 1200), source: provider }];
    }
  }
  return [{
    title: `${PROVIDER_LABELS[provider]} answer for ${String(query).slice(0, 80)}`,
    url: '',
    snippet: clean.slice(0, 1200),
    source: provider,
  }];
}

function safeEnv(env = process.env) {
  return sanitizeNoeHostExecEnv(env, {
    allowlist: ['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'SHELL', 'USER', 'LOGNAME'],
  });
}

function buildPrompt(query, count) {
  return [
    'Use web search if available. Return only compact JSON.',
    `Query: ${query}`,
    `Return up to ${count} results as {"results":[{"title":"","url":"","snippet":"","date":""}]}.`,
    'If you can only summarize, return {"answer":"..."} instead.',
  ].join('\n');
}

function defaultCliCommand(provider, prompt, env) {
  const upper = provider.toUpperCase();
  const command = env[`NOE_AI_SEARCH_${upper}_COMMAND`] || provider;
  const argsJson = env[`NOE_AI_SEARCH_${upper}_ARGS_JSON`];
  if (argsJson) {
    const parsed = JSON.parse(argsJson);
    if (!Array.isArray(parsed)) throw new Error(`${upper}_ARGS_JSON must be an array`);
    return { command, args: parsed.map((arg) => String(arg).replace('{prompt}', prompt)) };
  }
  if (provider === 'codex') {
    return {
      command,
      args: [
        '--search',
        '--ask-for-approval',
        'never',
        'exec',
        '--sandbox',
        'read-only',
        '--ephemeral',
        prompt,
      ],
    };
  }
  if (provider === 'claude') {
    return {
      command,
      args: [
        '--print',
        '--permission-mode',
        'dontAsk',
        '--allowedTools',
        'WebSearch',
        '--disallowedTools',
        'Bash,Edit,Write,Read',
        '--output-format',
        'text',
        '--no-session-persistence',
        prompt,
      ],
    };
  }
  return { command, args: ['-p', prompt] };
}

function runCli({ command, args, timeoutMs, runner }) {
  if (runner) return runner({ command, args, timeoutMs, env: safeEnv() });
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: safeEnv() });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = Number(timeoutMs) > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error(`cli timeout after ${timeoutMs}ms`));
    }, timeoutMs) : null;
    const collect = (chunk, key) => {
      const next = (key === 'stdout' ? stdout : stderr) + chunk.toString('utf8');
      if (key === 'stdout') stdout = next.slice(-MAX_CLI_OUTPUT);
      else stderr = next.slice(-MAX_CLI_OUTPUT);
    };
    child.stdout.on('data', (chunk) => collect(chunk, 'stdout'));
    child.stderr.on('data', (chunk) => collect(chunk, 'stderr'));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr || `${command} exited ${code}`));
      return resolve({ stdout, stderr, exitCode: code });
    });
  });
}

async function cliSearch(provider, query, { count, env, cliRunner }) {
  const upper = provider.toUpperCase();
  if (env[`NOE_AI_SEARCH_${upper}_CLI`] !== '1') throw new Error(`${provider} CLI search disabled`);
  const prompt = buildPrompt(query, count);
  const { command, args } = defaultCliCommand(provider, prompt, env);
  const rawTimeout = env[`NOE_AI_SEARCH_${upper}_TIMEOUT_MS`];
  const timeoutMs = rawTimeout === undefined || rawTimeout === ''
    ? 0
    : Math.min(Math.max(Number(rawTimeout) || 0, 0), 180_000);
  const out = await runCli({ command, args, timeoutMs, runner: cliRunner });
  return parseCliResults(provider, query, out.stdout, count);
}

function managedMockEnabled(env) {
  return env.NOE_AI_SEARCH_MOCK === '1'
    && (env.NOE_PHASE5_RUNTIME_VERIFY === '1' || env.NOE_REAL_USE_REPLAY === '1');
}

function managedMockResults(query, count) {
  return [{
    title: `Noe managed search fixture: ${String(query).slice(0, 90)}`,
    url: 'https://example.invalid/noe-managed-search-fixture',
    snippet: `Deterministic managed verification result for "${String(query).slice(0, 160)}".`,
    date: '',
    source: 'noe_managed_fixture',
    fixture: true,
  }].slice(0, count);
}

export function createAISearch({ webSearch = createWebSearch(), env = process.env, cliRunner = null } = {}) {
  async function searchProvider(provider, query, opts = {}) {
    const count = Math.min(Number(opts.count) || 8, 20);
    if (provider === 'minimax' && managedMockEnabled(env)) {
      return managedMockResults(query, count);
    }
    if (provider === 'codex' || provider === 'claude') {
      return cliSearch(provider, query, { count, env, cliRunner });
    }
    if (typeof webSearch.searchProvider === 'function') {
      return webSearch.searchProvider(provider, query, { count });
    }
    if (provider === 'minimax') return webSearch.search(query, { count });
    throw new Error(`provider unavailable: ${provider}`);
  }

  async function search(query, opts = {}) {
    const q = String(query || '').trim();
    if (!q) return [];
    const errors = [];
    for (const provider of PROVIDER_ORDER) {
      try {
        const results = await searchProvider(provider, q, opts);
        if (results.length) return tagResults(results);
      } catch (e) {
        errors.push(`${provider}:${e?.message || String(e)}`);
      }
    }
    throw new Error(`所有 AI 搜索源失败：${errors.join('；')}`);
  }

  async function searchWithMeta(query, opts = {}) {
    const results = await search(query, opts);
    const source = results[0]?.source || null;
    return {
      ok: true,
      query: String(query || '').trim(),
      count: results.length,
      source,
      viaModel: PROVIDER_LABELS[source] || source || null,
      results,
    };
  }

  function status() {
    const base = webSearch.status?.() || {};
    return {
      ...base,
      aiSearch: true,
      providerOrder: PROVIDER_ORDER,
      mockSearch: managedMockEnabled(env),
      cliFallbacks: {
        codex: cliStatus('NOE_AI_SEARCH_CODEX_CLI', env),
        claude: cliStatus('NOE_AI_SEARCH_CLAUDE_CLI', env),
      },
    };
  }

  return {
    search,
    searchWithMeta,
    searchProvider,
    fetchContent: (...args) => webSearch.fetchContent(...args),
    status,
  };
}
