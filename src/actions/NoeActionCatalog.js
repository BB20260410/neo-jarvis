const DEFAULT_FORBIDDEN_PATH_RE = /(^|[\\/])games[\\/]cartoon-apocalypse([\\/]|$)/i;

function asText(value, max = 240) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function asInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isInteger(n) ? n : Number.NaN;
}

function normalizeSchema(schema = {}) {
  return {
    type: 'object',
    additionalProperties: false,
    required: [],
    properties: {},
    ...schema,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateInput(schema, input) {
  const normalized = normalizeSchema(schema);
  const data = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const errors = [];

  for (const key of normalized.required || []) {
    if (data[key] === undefined || data[key] === null || data[key] === '') {
      errors.push(`${key} is required`);
    }
  }

  if (normalized.additionalProperties === false) {
    const allowed = new Set(Object.keys(normalized.properties || {}));
    for (const key of Object.keys(data)) {
      if (!allowed.has(key)) errors.push(`${key} is not allowed`);
    }
  }

  for (const [key, spec] of Object.entries(normalized.properties || {})) {
    if (data[key] === undefined || data[key] === null || data[key] === '') continue;
    const value = data[key];
    if (spec.type === 'string') {
      if (typeof value !== 'string') errors.push(`${key} must be a string`);
      if (spec.minLength && asText(value).length < spec.minLength) errors.push(`${key} is too short`);
      if (spec.maxLength && String(value).length > spec.maxLength) errors.push(`${key} is too long`);
    }
    if (spec.type === 'integer') {
      if (!Number.isInteger(Number(value))) errors.push(`${key} must be an integer`);
      if (spec.minimum !== undefined && Number(value) < spec.minimum) errors.push(`${key} is too small`);
      if (spec.maximum !== undefined && Number(value) > spec.maximum) errors.push(`${key} is too large`);
    }
    if (spec.type === 'boolean' && typeof value !== 'boolean') errors.push(`${key} must be a boolean`);
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) errors.push(`${key} must be one of ${spec.enum.join(', ')}`);
  }

  if (errors.length) {
    const error = new Error(`invalid action input: ${errors.join('; ')}`);
    error.code = 'NOE_ACTION_INPUT_INVALID';
    error.errors = errors;
    throw error;
  }
  return data;
}

function noSideEffectPreview(action, input, extra = {}) {
  return {
    ok: true,
    actionId: action.id,
    dryRun: true,
    risk: action.risk,
    summary: extra.summary || action.description,
    normalizedInput: extra.normalizedInput || input,
    wouldUse: extra.wouldUse || action.modules,
    wouldCreateArtifacts: extra.wouldCreateArtifacts || [],
    sideEffects: [],
    blockedEffects: [
      'commit',
      'push',
      'upload',
      'delete',
      'restart_process',
      'kill_process',
      'read_secret',
      'touch_games_cartoon_apocalypse',
      'touch_ports_51735_51835',
    ],
    nextStep: extra.nextStep || 'This dry-run only describes the action. Execution requires a separate authorized action path.',
  };
}

export const DEFAULT_NOE_ACTIONS = [
  {
    id: 'research.search.preview',
    group: 'research',
    title: 'Search Preview',
    description: 'Plan a lightweight web search without calling the network.',
    modules: ['src/research/ResearchIntent.js', 'src/research/WebSearch.js'],
    risk: 'low_preview',
    supportsDryRun: true,
    supportsExecute: false,
    inputSchema: {
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1, maxLength: 240 },
        count: { type: 'integer', minimum: 1, maximum: 10, default: 5 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['ok', 'dryRun', 'wouldUse', 'sideEffects'],
    },
    examples: [
      'node scripts/noe-action-catalog.mjs dry-run research.search.preview --input \'{"query":"Wukong AI","count":5}\'',
    ],
    dryRun(input, action) {
      const query = asText(input.query);
      const count = asInteger(input.count, 5);
      return noSideEffectPreview(action, input, {
        summary: `Would prepare a ${count}-result search plan for "${query}".`,
        normalizedInput: { query, count },
        nextStep: 'Use the existing research route or DeepResearcher only after the user asks for live research.',
      });
    },
  },
  {
    id: 'research.deep.plan',
    group: 'research',
    title: 'Deep Research Plan',
    description: 'Draft a multi-round research plan without running model or network calls.',
    modules: ['src/research/DeepResearcher.js'],
    risk: 'low_preview',
    supportsDryRun: true,
    supportsExecute: false,
    inputSchema: {
      required: ['question'],
      properties: {
        question: { type: 'string', minLength: 1, maxLength: 500 },
        maxRounds: { type: 'integer', minimum: 1, maximum: 8, default: 4 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['ok', 'dryRun', 'wouldUse', 'sideEffects'],
    },
    examples: [
      'node scripts/noe-action-catalog.mjs dry-run research.deep.plan --input \'{"question":"How should Noe learn from Wukong AI?"}\'',
    ],
    dryRun(input, action) {
      const question = asText(input.question, 500);
      const maxRounds = asInteger(input.maxRounds, 4);
      return noSideEffectPreview(action, input, {
        summary: `Would plan up to ${maxRounds} research rounds for "${question}".`,
        normalizedInput: { question, maxRounds },
        wouldCreateArtifacts: ['research_plan.json', 'source_map.md', 'final_report.md'],
      });
    },
  },
  {
    id: 'skills.extract.preview',
    group: 'skills',
    title: 'Skill Extraction Preview',
    description: 'Check whether a room or text is a candidate for reusable skill extraction.',
    modules: ['src/skills/AutoSkillExtractor.js', 'src/skills/SkillExtractor.js'],
    risk: 'low_preview',
    supportsDryRun: true,
    supportsExecute: false,
    inputSchema: {
      required: ['source'],
      properties: {
        source: { type: 'string', minLength: 1, maxLength: 2000 },
        roomId: { type: 'string', maxLength: 120 },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['ok', 'dryRun', 'wouldUse', 'sideEffects'],
    },
    examples: [
      'node scripts/noe-action-catalog.mjs dry-run skills.extract.preview --input \'{"source":"测试、配置 wrangler、部署"}\'',
    ],
    dryRun(input, action) {
      const source = asText(input.source, 2000);
      const likelyReusable = source.length >= 20 && /(步骤|流程|模板|复用|deploy|部署|检查|验证)/i.test(source);
      return noSideEffectPreview(action, input, {
        summary: likelyReusable ? 'Would prepare a disabled draft skill proposal.' : 'Would ask for more reusable process detail before extraction.',
        normalizedInput: { source, roomId: input.roomId ? asText(input.roomId, 120) : undefined, likelyReusable },
        wouldCreateArtifacts: likelyReusable ? ['disabled_skill_draft'] : [],
      });
    },
  },
  {
    id: 'hwfit.recommend.preview',
    group: 'local-models',
    title: 'Hardware Fit Preview',
    description: 'Describe a local model recommendation run without probing hardware or Ollama.',
    modules: ['src/hwfit/HardwareFit.js'],
    risk: 'low_preview',
    supportsDryRun: true,
    supportsExecute: false,
    inputSchema: {
      properties: {
        includeInstalled: { type: 'boolean', default: false },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['ok', 'dryRun', 'wouldUse', 'sideEffects'],
    },
    examples: [
      'node scripts/noe-action-catalog.mjs dry-run hwfit.recommend.preview --input \'{"includeInstalled":false}\'',
    ],
    dryRun(input, action) {
      return noSideEffectPreview(action, input, {
        summary: 'Would inspect Apple Silicon memory budget and estimate suitable local model quantization.',
        normalizedInput: { includeInstalled: input.includeInstalled === true },
        nextStep: 'Execution may read sysctl and optionally Ollama tags, but this preview does neither.',
      });
    },
  },
  {
    id: 'files.organize.preview',
    group: 'files',
    title: 'File Organization Preview',
    description: 'Plan file organization steps without moving, deleting, or reading secrets.',
    modules: ['src/loop/SafeActExecutors.js'],
    risk: 'medium_preview',
    supportsDryRun: true,
    supportsExecute: false,
    inputSchema: {
      required: ['root'],
      properties: {
        root: { type: 'string', minLength: 1, maxLength: 500 },
        pattern: { type: 'string', maxLength: 120 },
        mode: { type: 'string', enum: ['report_only', 'group_by_extension', 'group_by_date'], default: 'report_only' },
      },
    },
    outputSchema: {
      type: 'object',
      required: ['ok', 'dryRun', 'wouldUse', 'sideEffects'],
    },
    examples: [
      'node scripts/noe-action-catalog.mjs dry-run files.organize.preview --input \'{"root":"~/Downloads","mode":"report_only"}\'',
    ],
    dryRun(input, action) {
      const root = asText(input.root, 500);
      if (DEFAULT_FORBIDDEN_PATH_RE.test(root)) {
        const error = new Error('files.organize.preview refuses games/cartoon-apocalypse paths');
        error.code = 'NOE_ACTION_FORBIDDEN_PATH';
        throw error;
      }
      const mode = input.mode || 'report_only';
      return noSideEffectPreview(action, input, {
        summary: `Would produce a file organization preview for ${root} using mode ${mode}.`,
        normalizedInput: { root, pattern: input.pattern ? asText(input.pattern, 120) : '*', mode },
        wouldCreateArtifacts: ['file_organization_preview.json'],
        nextStep: 'Any real move/delete/upload must go through the separate sensitive-action consensus path.',
      });
    },
  },
];

/**
 * Creates a Noe action catalog instance from a list of action definitions.
 *
 * @param {Object} [options] - Configuration options.
 * @param {Array<Object>} [options.actions=DEFAULT_NOE_ACTIONS] - An array of action definition objects.
 *   Each object must have an `id` and implement the required action interface.
 * @returns {Object} A catalog object with methods: `list`, `schema`, `help`, and `dryRun`.
 */
export function createNoeActionCatalog({ actions = DEFAULT_NOE_ACTIONS } = {}) {
  const map = new Map(actions.map((action) => [action.id, action]));

  function requireAction(id) {
    const action = map.get(String(id || ''));
    if (!action) {
      const error = new Error(`unknown Noe action: ${id || '(empty)'}`);
      error.code = 'NOE_ACTION_UNKNOWN';
      throw error;
    }
    return action;
  }

  function list() {
    return [...map.values()].map((action) => ({
      id: action.id,
      group: action.group,
      title: action.title,
      description: action.description,
      risk: action.risk,
      supportsDryRun: action.supportsDryRun === true,
      supportsExecute: action.supportsExecute === true,
    })).sort((a, b) => a.id.localeCompare(b.id));
  }

  function schema(id) {
    const action = requireAction(id);
    return cloneJson({
      id: action.id,
      group: action.group,
      title: action.title,
      description: action.description,
      risk: action.risk,
      inputSchema: normalizeSchema(action.inputSchema),
      outputSchema: action.outputSchema,
      modules: action.modules,
      examples: action.examples,
    });
  }

  function help(id) {
    const action = requireAction(id);
    return [
      `${action.id} - ${action.title}`,
      action.description,
      '',
      `risk: ${action.risk}`,
      `dry-run: ${action.supportsDryRun ? 'yes' : 'no'}`,
      `execute: ${action.supportsExecute ? 'yes' : 'no'}`,
      '',
      'input:',
      JSON.stringify(normalizeSchema(action.inputSchema), null, 2),
      '',
      'examples:',
      ...(action.examples || []).map((example) => `  ${example}`),
    ].join('\n');
  }

  function dryRun(id, input = {}) {
    const action = requireAction(id);
    if (action.supportsDryRun !== true || typeof action.dryRun !== 'function') {
      const error = new Error(`action does not support dry-run: ${id}`);
      error.code = 'NOE_ACTION_DRY_RUN_UNSUPPORTED';
      throw error;
    }
    const validInput = validateInput(action.inputSchema, input);
    return action.dryRun(validInput, action);
  }

  return { list, schema, help, dryRun };
}
