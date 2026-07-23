// @ts-check
// 合成 self-improve bench 任务模块（fixture，非真仓代码）。
// 通用采样壳：不判分、不自报。先读并删 token（认证用，非"通过凭证"），再 import subject 采样。
import { readFileSync, unlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BEGIN = '<<<NOE_BENCH_SAMPLES_BEGIN>>>';
const END = '<<<NOE_BENCH_SAMPLES_END>>>';

// —— 在 import subject 之前完成：读 token + 立即 unlink（subject 顶层届时已够不到该文件）——
const tokenUrl = new URL('./__bench_token', import.meta.url);
const inputsUrl = new URL('./__probe_inputs.json', import.meta.url);
let TOKEN = '';
try { TOKEN = readFileSync(tokenUrl, 'utf8'); } catch {}
try { unlinkSync(tokenUrl); } catch {}
const write = process.stdout.write.bind(process.stdout); // 私有引用，规避 subject 改 process.stdout

function emit(payload) {
  const json = JSON.stringify(payload);
  const mac = createHash('sha256').update(TOKEN + json).digest('hex');
  write('\n' + BEGIN + '\n' + JSON.stringify({ mac, json }) + '\n' + END + '\n');
}

async function main() {
  let spec;
  try {
    spec = JSON.parse(readFileSync(inputsUrl, 'utf8'));
  } catch (err) {
    emit({ ok: false, error: 'probe_inputs_unreadable:' + String(err && err.message || err) });
    return;
  }
  let subject;
  try {
    subject = await import('./subject.js');
  } catch (err) {
    emit({ ok: false, error: 'subject_import_failed:' + String(err && err.message || err) });
    return;
  }
  const fn = subject && subject[spec.exportName];
  if (typeof fn !== 'function') {
    emit({ ok: false, error: 'export_missing:' + String(spec.exportName) });
    return;
  }
  const samples = [];
  for (const inp of Array.isArray(spec.inputs) ? spec.inputs : []) {
    try {
      const value = fn.apply(null, Array.isArray(inp.args) ? inp.args : []);
      samples.push({ name: String(inp.name), returned: value });
    } catch (err) {
      samples.push({ name: String(inp.name), threw: String(err && err.message || err) });
    }
  }
  emit({ ok: true, exportName: String(spec.exportName), samples });
}

main();
