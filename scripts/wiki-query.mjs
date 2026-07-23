import { searchWiki } from '../src/knowledge/LLMWiki.js';

function arg(name, fallback) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
}

const root = arg('--root', 'knowledge/llm-wiki');
const topK = Number(arg('--topK', '5'));
const query = process.argv.filter((v, i) => i > 1 && !['--root', '--topK'].includes(process.argv[i - 1]) && !v.startsWith('--')).join(' ');
const result = await searchWiki({ root, query, topK });
console.log(JSON.stringify(result, null, 2));
