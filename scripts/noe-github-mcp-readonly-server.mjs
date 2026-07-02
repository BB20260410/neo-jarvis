#!/usr/bin/env node
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const USER_AGENT = 'noe-github-readonly-mcp/1.0';

function inputSchema(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required };
}

const tools = [
  {
    name: 'search_repositories_readonly',
    description: 'Read-only GitHub repository search. Does not write or mutate GitHub state.',
    inputSchema: inputSchema({
      query: { type: 'string', minLength: 1 },
      per_page: { type: 'number', minimum: 1, maximum: 10 },
    }, ['query']),
  },
  {
    name: 'get_repository_readonly',
    description: 'Read-only GitHub repository metadata fetch.',
    inputSchema: inputSchema({
      owner: { type: 'string', minLength: 1 },
      repo: { type: 'string', minLength: 1 },
    }, ['owner', 'repo']),
  },
  {
    name: 'list_commits_readonly',
    description: 'Read-only recent commits list for a public or token-accessible repository.',
    inputSchema: inputSchema({
      owner: { type: 'string', minLength: 1 },
      repo: { type: 'string', minLength: 1 },
      per_page: { type: 'number', minimum: 1, maximum: 10 },
    }, ['owner', 'repo']),
  },
];

function sanitizeArgs(args) {
  return args && typeof args === 'object' ? args : {};
}

async function githubGet(path, params = {}) {
  const url = new URL(`https://api.github.com${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': USER_AGENT,
  };
  if (process.env.GITHUB_TOKEN) headers.authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 4000) }; }
  if (!res.ok) {
    const message = data?.message || `${res.status} ${res.statusText}`;
    throw new Error(`github_readonly_request_failed:${res.status}:${message}`);
  }
  return data;
}

function compactRepo(repo) {
  return {
    full_name: repo.full_name,
    private: repo.private,
    html_url: repo.html_url,
    description: repo.description,
    stargazers_count: repo.stargazers_count,
    forks_count: repo.forks_count,
    default_branch: repo.default_branch,
    updated_at: repo.updated_at,
  };
}

const server = new Server(
  { name: 'noe-github-readonly-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params?.name;
  const args = sanitizeArgs(request.params?.arguments);
  if (name === 'search_repositories_readonly') {
    const data = await githubGet('/search/repositories', {
      q: String(args.query || ''),
      per_page: Math.min(Number(args.per_page) || 5, 10),
    });
    return { content: [{ type: 'text', text: JSON.stringify((data.items || []).map(compactRepo), null, 2) }] };
  }
  if (name === 'get_repository_readonly') {
    const data = await githubGet(`/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}`);
    return { content: [{ type: 'text', text: JSON.stringify(compactRepo(data), null, 2) }] };
  }
  if (name === 'list_commits_readonly') {
    const data = await githubGet(`/repos/${encodeURIComponent(args.owner)}/${encodeURIComponent(args.repo)}/commits`, {
      per_page: Math.min(Number(args.per_page) || 3, 10),
    });
    const commits = (Array.isArray(data) ? data : []).map((c) => ({
      sha: c.sha,
      html_url: c.html_url,
      message: c.commit?.message?.split('\n')[0] || '',
      author: c.commit?.author?.name || '',
      date: c.commit?.author?.date || '',
    }));
    return { content: [{ type: 'text', text: JSON.stringify(commits, null, 2) }] };
  }
  throw new Error(`unknown_tool:${name}`);
});

await server.connect(new StdioServerTransport());
