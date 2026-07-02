import { createHash } from 'node:crypto';

export const DEFAULT_TOOL_GUARDRAIL_CONFIG = {
  repeatedFailureThreshold: 3,
  sameToolFailureThreshold: 5,
  noProgressThreshold: 4,
  warnOnly: true,
  hardStopMutatingRepeats: true,
};

const MUTATING_PATTERNS = /(write|create|update|patch|delete|remove|move|rename|upload|publish|deploy|restart|kill|exec|shell|run|apply|commit|push)/i;
const IDEMPOTENT_PATTERNS = /(read|get|list|search|find|inspect|status|doctor|lint|dry[-_]?run|preview|plan)/i;

function clean(value, max = 4000) {
  return String(value ?? '').slice(0, max);
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function hashArgs(args) {
  return createHash('sha256').update(stableJson(args ?? {}), 'utf8').digest('hex').slice(0, 16);
}

export function classifyToolCall(toolName = '', metadata = {}) {
  if (metadata.mutating === true || metadata.sideEffects === true) return 'mutating';
  if (metadata.readonly === true || metadata.readOnly === true || metadata.dryRun === true) return 'idempotent';
  const text = clean(toolName, 240);
  if (MUTATING_PATTERNS.test(text)) return 'mutating';
  if (IDEMPOTENT_PATTERNS.test(text)) return 'idempotent';
  return 'unknown';
}

export class ToolCallGuardrailController {
  constructor(config = {}) {
    this.config = { ...DEFAULT_TOOL_GUARDRAIL_CONFIG, ...config };
    this.events = [];
  }

  record(call = {}) {
    const toolName = clean(call.toolName || call.tool || call.name, 240) || 'unknown';
    const argHash = hashArgs(call.args || call.arguments || {});
    const classification = classifyToolCall(toolName, call.metadata || {});
    const ok = call.ok !== false && !call.error;
    const changed = call.changed === true || call.sideEffect === true;
    const outputHash = hashArgs(call.output ?? call.result ?? call.error ?? '');
    const event = {
      toolName,
      argHash,
      classification,
      ok,
      changed,
      outputHash,
      error: call.error ? clean(call.error, 500) : '',
      at: call.at || Date.now(),
    };
    this.events.push(event);
    if (this.events.length > 100) this.events = this.events.slice(-100);
    return this.evaluate(event);
  }

  evaluate(latest = null) {
    const findings = [];
    const sameCallFailures = this.events.filter((event) => event.toolName === latest?.toolName && event.argHash === latest?.argHash && !event.ok);
    if (sameCallFailures.length >= this.config.repeatedFailureThreshold) {
      findings.push({
        id: 'repeated_exact_tool_failure',
        severity: latest.classification === 'mutating' && this.config.hardStopMutatingRepeats ? 'stop' : 'warn',
        toolName: latest.toolName,
        count: sameCallFailures.length,
      });
    }

    const sameToolFailures = this.events.filter((event) => event.toolName === latest?.toolName && !event.ok);
    if (sameToolFailures.length >= this.config.sameToolFailureThreshold) {
      findings.push({ id: 'same_tool_failure_cluster', severity: 'warn', toolName: latest.toolName, count: sameToolFailures.length });
    }

    const tail = this.events.slice(-this.config.noProgressThreshold);
    if (
      tail.length === this.config.noProgressThreshold &&
      tail.every((event) => event.toolName === latest?.toolName && event.argHash === latest?.argHash && event.outputHash === latest?.outputHash && event.changed !== true)
    ) {
      findings.push({ id: 'idempotent_no_progress_loop', severity: 'warn', toolName: latest.toolName, count: tail.length });
    }

    // owner 偏好（2026-06-11 回滚强制停止）：默认 warnOnly 一律只警告不硬停——开发者要自由，
    // 不让护栏强制中断（要硬停可显式构造 warnOnly:false）。
    const stop = findings.some((finding) => finding.severity === 'stop') && this.config.warnOnly !== true;
    return {
      ok: !stop,
      stop,
      warnings: findings.filter((finding) => finding.severity !== 'stop' || this.config.warnOnly === true),
      findings,
      latest,
    };
  }

  snapshot() {
    return {
      eventCount: this.events.length,
      config: { ...this.config },
      recent: this.events.slice(-10),
    };
  }
}

