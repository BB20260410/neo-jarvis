import { lintWiki } from '../src/knowledge/LLMWiki.js';

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const root = arg('--root', 'knowledge/llm-wiki');
const result = await lintWiki({ root });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
