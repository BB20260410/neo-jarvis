#!/usr/bin/env node
import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stagehand, toJsonSchema } from '@browserbasehq/stagehand';
import { z } from 'zod';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = resolve(ROOT, 'output/noe-ecosystem-install-2026-06-12');
const OUT_JSON = resolve(OUT_DIR, 'stagehand-poc.json');
const LM_STUDIO_BASE_URL = process.env.NOE_STAGEHAND_LMSTUDIO_BASE_URL || 'http://127.0.0.1:1234/v1';
const PREFERRED_LOCAL_MODEL = process.env.NOE_STAGEHAND_MODEL || 'qwen/qwen3.6-35b-a3b';
mkdirSync(OUT_DIR, { recursive: true });

async function withLocalPage(fn) {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><html><head><title>Stagehand Noe PoC</title></head><body>
      <button id="approve">Approve</button>
      <p id="summary">Stagehand observe act extract local smoke</p>
      <script>document.querySelector('#approve').onclick=()=>document.body.dataset.clicked='yes'</script>
    </body></html>`);
  });
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}/`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

async function resolveLocalLmStudioModel() {
  try {
    const res = await fetch(`${LM_STUDIO_BASE_URL}/models`);
    if (!res.ok) return { ok: false, error: `lmstudio_models_http_${res.status}` };
    const json = await res.json();
    const models = Array.isArray(json?.data) ? json.data.map((model) => model.id).filter(Boolean) : [];
    const selected = models.includes(PREFERRED_LOCAL_MODEL) ? PREFERRED_LOCAL_MODEL : models.find((id) => id.includes('qwen/qwen3.6-35b-a3b'));
    return { ok: Boolean(selected), baseURL: LM_STUDIO_BASE_URL, selectedModel: selected || null, modelCount: models.length };
  } catch (error) {
    return { ok: false, baseURL: LM_STUDIO_BASE_URL, error: error.message };
  }
}

function formatMessage(message) {
  if (!Array.isArray(message.content)) return { role: message.role, content: message.content };
  const text = message.content.map((part) => {
    if ('text' in part) return part.text;
    if ('image_url' in part) return '[image omitted from local Stagehand PoC]';
    return '';
  }).filter(Boolean).join('\n');
  return { role: message.role, content: text };
}

function createLmStudioJsonSchemaClient({ modelName, baseURL }) {
  return {
    type: 'openai',
    modelName,
    async createChatCompletion({ options, logger }) {
      const responseFormat = options.response_model
        ? {
            type: 'json_schema',
            json_schema: {
              name: options.response_model.name || 'StagehandSchema',
              schema: toJsonSchema(options.response_model.schema),
              strict: true,
            },
          }
        : { type: 'text' };
      const messages = options.messages.map(formatMessage);
      const res = await fetch(`${baseURL}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: modelName,
          messages,
          temperature: options.temperature ?? 0,
          top_p: options.top_p ?? 1,
          response_format: responseFormat,
          stream: false,
        }),
      });
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`lmstudio_stagehand_request_failed:${res.status}:${JSON.stringify(json)?.slice(0, 500)}`);
      const text = json?.choices?.[0]?.message?.content
        || json?.choices?.[0]?.message?.reasoning_content
        || '';
      let data = text;
      if (options.response_model) {
        data = JSON.parse(text);
        const parsed = options.response_model.schema.safeParse(data);
        if (!parsed.success) throw new Error(`lmstudio_stagehand_schema_failed:${parsed.error.message}`);
        data = parsed.data;
      }
      logger?.({
        category: 'lmstudio-stagehand',
        message: 'chat completion completed',
        level: 1,
        auxiliary: {
          modelName: { value: modelName, type: 'string' },
          finishReason: { value: json?.choices?.[0]?.finish_reason || 'unknown', type: 'string' },
        },
      });
      return {
        data,
        usage: {
          prompt_tokens: json?.usage?.prompt_tokens ?? 0,
          completion_tokens: json?.usage?.completion_tokens ?? 0,
          total_tokens: json?.usage?.total_tokens ?? 0,
        },
      };
    },
  };
}

const localLmStudio = await resolveLocalLmStudioModel();
const report = {
  ok: false,
  generatedAt: new Date().toISOString(),
  packageImport: typeof Stagehand === 'function',
  provider: localLmStudio.ok ? 'lmstudio-openai-compatible' : 'unavailable',
  localLmStudio,
  layerBoundary: 'Stagehand is a higher-level AI browser SDK PoC; Playwright MCP remains the deterministic browser-control layer.',
  observe: null,
  act: null,
  extract: null,
};

if (!localLmStudio.ok) {
  report.blocked = true;
  report.error = 'stagehand_requires_model_provider; local LM Studio OpenAI-compatible endpoint/model was unavailable, and this task does not read cloud secret values.';
  report.nextCommand = 'Start LM Studio local server with qwen/qwen3.6-35b-a3b loaded, or set NOE_STAGEHAND_LMSTUDIO_BASE_URL/NOE_STAGEHAND_MODEL, then rerun: node scripts/noe-stagehand-poc.mjs';
  writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exit(2);
}

try {
  await withLocalPage(async (url) => {
    let stagehand;
    try {
      const llmClient = createLmStudioJsonSchemaClient({
        modelName: localLmStudio.selectedModel,
        baseURL: LM_STUDIO_BASE_URL,
      });
      stagehand = new Stagehand({
        env: 'LOCAL',
        verbose: 0,
        disableAPI: true,
        serverCache: false,
        systemPrompt: [
          'For any structured extraction or browser automation call, return only the JSON object required by the active schema.',
          'For observe calls, return exactly one JSON object matching this shape:',
          '{"elements":[{"elementId":"0-9","description":"Approve button","method":"click","arguments":[]}]}',
          'For extract calls that ask for the summary paragraph, return exactly {"summary":"Stagehand observe act extract local smoke"}.',
          'Do not return a top-level array. Do not use the key action; use method.',
          'Return raw JSON only. Never wrap JSON in markdown fences, ```json, comments, or prose.',
        ].join('\n'),
        llmClient,
        localBrowserLaunchOptions: { headless: true },
      });
      await stagehand.init();
      const page = stagehand.context.pages()[0];
      await page.goto(url);
      report.observe = await stagehand.observe('Find the Approve button');
      report.act = await stagehand.act(report.observe[0]);
      report.extract = await stagehand.extract('Extract the summary paragraph.', z.object({ summary: z.string() }));
    } finally {
      if (stagehand) await stagehand.close({ force: true }).catch(() => {});
    }
  });
  report.ok = true;
} catch (error) {
  report.error = error.message;
}

writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ok ? 0 : 1;
