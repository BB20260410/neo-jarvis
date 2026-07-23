import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const candidates = [
  {
    category: 'agent memory',
    repo: 'mem0ai/mem0',
    capability: 'Agent Memory',
    value: 'Memory mutation, scoring, and retrieval policy patterns for long-term personal memory.',
    risk: 'Python/service and vector-store assumptions; do not embed wholesale.',
    cost: 'M',
    prototype: 'P1 narrow memory-quality spike'
  },
  {
    category: 'agent memory',
    repo: 'letta-ai/letta',
    capability: 'Agent Memory',
    value: 'Stateful-agent memory model and context-window discipline.',
    risk: 'Platform scope is larger than Noe P0 and can recreate a second product.',
    cost: 'H',
    prototype: 'P2 concept reference only'
  },
  {
    category: 'RAG / local file index',
    repo: 'run-llama/llama_index',
    capability: 'RAG / Local File Index',
    value: 'Document ingestion, chunking, retrieval, and evaluator ideas for local file index.',
    risk: 'Large framework surface; Noe should first keep local FTS and explicit source attribution.',
    cost: 'M',
    prototype: 'P1 local-file-index API-pattern spike'
  },
  {
    category: 'local file index',
    repo: 'Unstructured-IO/unstructured',
    capability: 'Local File Index',
    value: 'Parsing and partitioning complex documents into clean chunks for RAG.',
    risk: 'Python ETL dependency and heavier install footprint.',
    cost: 'M',
    prototype: 'P1 document parsing spike only'
  },
  {
    category: 'local file index',
    repo: 'docling-project/docling',
    capability: 'Local File Index',
    value: 'Document conversion to structured Markdown/JSON, especially PDF/table/layout input.',
    risk: 'Python dependency and possible runtime weight for local-first desktop packaging.',
    cost: 'M',
    prototype: 'P1 PDF/document parsing comparison'
  },
  {
    category: 'vector store / RAG',
    repo: 'qdrant/qdrant',
    capability: 'RAG / Vector Store',
    value: 'Production-grade vector search if Noe outgrows FTS5 and local embeddings.',
    risk: 'Extra service/process; heavier than current local-first P0.',
    cost: 'M',
    prototype: 'P1 vector-store spike behind local-only switch'
  },
  {
    category: 'vector store / RAG',
    repo: 'chroma-core/chroma',
    capability: 'RAG / Vector Store',
    value: 'Fast embedding-store prototype path for memory and file retrieval experiments.',
    risk: 'Python dependency and persistence/ops complexity relative to SQLite.',
    cost: 'M',
    prototype: 'P1 alternative to Qdrant for quick memory experiments'
  },
  {
    category: 'vector store / RAG',
    repo: 'lancedb/lancedb',
    capability: 'RAG / Vector Store',
    value: 'Embedded retrieval library for multimodal/local vector search.',
    risk: 'Node integration and packaging path still need a narrow proof.',
    cost: 'M',
    prototype: 'P1 local embedded vector-store spike'
  },
  {
    category: 'local search',
    repo: 'meilisearch/meilisearch',
    capability: 'Local File Index',
    value: 'Fast hybrid keyword search engine for local corpus search UX.',
    risk: 'Adds a separate service and is heavier than SQLite FTS5 for P0.',
    cost: 'M',
    prototype: 'P2 only if FTS5 search quality blocks'
  },
  {
    category: 'knowledge graph',
    repo: 'microsoft/graphrag',
    capability: 'Knowledge Graph',
    value: 'Graph-based retrieval and summarization pipeline ideas.',
    risk: 'Heavy batch pipeline; poor fit for P0 live local assistant loop.',
    cost: 'H',
    prototype: 'P2 offline research only'
  },
  {
    category: 'knowledge graph',
    repo: 'getzep/graphiti',
    capability: 'Knowledge Graph',
    value: 'Temporal knowledge-graph patterns for evolving user/project memory.',
    risk: 'Service dependency and schema divergence from current SQLite tables.',
    cost: 'M',
    prototype: 'P1 narrow KG spike for memory relations'
  },
  {
    category: 'knowledge graph',
    repo: 'FalkorDB/FalkorDB',
    capability: 'Knowledge Graph',
    value: 'GraphRAG-oriented graph database using GraphBLAS under the hood.',
    risk: 'External graph DB service and operational weight.',
    cost: 'M',
    prototype: 'P2 graph-store reference only'
  },
  {
    category: 'multi-agent orchestration',
    repo: 'langchain-ai/langgraph',
    capability: 'Multi-Agent Orchestration',
    value: 'Durable graph/state-machine patterns for Act Pipeline and recovery.',
    risk: 'Would conflict with Noe in-process loop if adopted as the core runtime too early.',
    cost: 'M',
    prototype: 'P1 pattern spike for Act Pipeline state only'
  },
  {
    category: 'multi-agent orchestration',
    repo: 'microsoft/autogen',
    capability: 'Multi-Agent Orchestration',
    value: 'Conversation orchestration and tool-use coordination examples.',
    risk: 'License endpoint reports CC-BY-4.0 for the repo license; code-use needs legal review.',
    cost: 'H',
    prototype: 'No prototype until license review'
  },
  {
    category: 'multi-agent orchestration',
    repo: 'crewAIInc/crewAI',
    capability: 'Multi-Agent Orchestration',
    value: 'Role/task orchestration vocabulary useful for room-level collaboration UX.',
    risk: 'Can amplify the old problem of models chatting without a state-closing executor.',
    cost: 'M',
    prototype: 'P2 concept reference only'
  },
  {
    category: 'Electron packaging',
    repo: 'electron-userland/electron-builder',
    capability: 'Electron Packaging',
    value: 'Already in Noe devDependencies; strongest candidate for formal DMG packaging path.',
    risk: 'Signing/notarization and Xike residue in packaging metadata still need cleanup.',
    cost: 'L',
    prototype: 'P0 use existing dependency for package smoke'
  },
  {
    category: 'Electron packaging',
    repo: 'electron/forge',
    capability: 'Electron Packaging',
    value: 'Alternative Electron packaging/publishing flow.',
    risk: 'Noe already has electron-builder; switching now creates churn.',
    cost: 'M',
    prototype: 'P2 alternative only if builder path blocks'
  },
  {
    category: 'observability',
    repo: 'open-telemetry/opentelemetry-js',
    capability: 'Observability',
    value: 'Already partially in dependencies; standard traces for loop/tool/memory spans.',
    risk: 'Exporter misconfiguration can leak metadata; keep local/no-export default.',
    cost: 'L',
    prototype: 'P0 local trace hooks with exporter disabled by default'
  },
  {
    category: 'observability',
    repo: 'megahertz/electron-log',
    capability: 'Observability',
    value: 'Lightweight local Electron/Node logging with no external upload.',
    risk: 'Only logging; no traces or crash aggregation.',
    cost: 'L',
    prototype: 'P0 local packaged-app logging'
  },
  {
    category: 'observability',
    repo: 'getsentry/sentry-javascript',
    capability: 'Observability',
    value: 'Crash/error reporting option for packaged Electron app.',
    risk: 'External telemetry and privacy review required before any upload.',
    cost: 'M',
    prototype: 'P2 only after privacy/product consent'
  },
  {
    category: 'tool protocol / marketplace',
    repo: 'modelcontextprotocol/servers',
    capability: 'Tool Marketplace',
    value: 'Tool/server manifest examples for a future audited tool market.',
    risk: 'License endpoint can be NOASSERTION and real tool execution is dangerous.',
    cost: 'M',
    prototype: 'P2 manifest-shape reference only, no handler execution'
  }
];

const auditCommand = 'gh repo view <repo> --json nameWithOwner,description,url,stargazerCount,pushedAt,isArchived && gh api repos/<repo>/license';

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60000
  }).trim();
}

function repoMeta(repo) {
  console.error(`auditing ${repo}`);
  const viewRaw = gh([
    'repo',
    'view',
    repo,
    '--json',
    'nameWithOwner,description,url,stargazerCount,pushedAt,isArchived'
  ]);
  const view = JSON.parse(viewRaw);

  let license = { spdxId: 'NOASSERTION', url: null };
  try {
    const licenseRaw = gh(['api', `repos/${repo}/license`, '--jq', '{spdx: .license.spdx_id, url: .html_url}']);
    const parsed = JSON.parse(licenseRaw);
    license = { spdxId: parsed.spdx || 'NOASSERTION', url: parsed.url || null };
  } catch {
    license = { spdxId: 'NOASSERTION', url: null };
  }

  return { ...view, license };
}

const auditedAt = new Date().toISOString();
const rows = candidates.map((candidate) => ({
  ...candidate,
  ...repoMeta(candidate.repo)
}));

mkdirSync('output', { recursive: true });
const outPath = path.join('output', 'noe-phase11-open-source-audit.json');
writeFileSync(outPath, JSON.stringify({
  auditedAt,
  source: 'GitHub CLI / GitHub REST API, read-only public metadata',
  auditCommand,
  rows
}, null, 2));

console.log(`NOE phase11 open-source audit generated: ${outPath}`);
console.log(`auditedAt=${auditedAt}`);
console.log(`rows=${rows.length}`);
for (const row of rows) {
  console.log(`${row.nameWithOwner}\t${row.license.spdxId}\tstars=${row.stargazerCount}\tpushedAt=${row.pushedAt}\tprototype=${row.prototype}`);
}
