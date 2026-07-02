// @ts-check
// NoeLocalBrainRouter — 薄路由层，避免调用方散落模型字符串。

export {
  NOE_BRAIN_ROLES,
  NOE_MAIN_BRAIN,
  NOE_REVIEW_BRAIN,
  NOE_FALLBACK_BRAIN,
  NOE_MAIN_BRAIN_MODEL,
  NOE_MAIN_BRAIN_LOAD_MODEL,
  NOE_REVIEW_BRAIN_MODEL,
  NOE_REVIEW_BRAIN_LOAD_MODEL,
  NOE_FALLBACK_BRAIN_MODEL,
  NOE_FALLBACK_BRAIN_LOAD_MODELS,
  NOE_MAIN_BRAIN_SYSTEM_PROMPT,
  NOE_REVIEW_BRAIN_SYSTEM_PROMPT,
  NOE_FALLBACK_BRAIN_SYSTEM_PROMPT,
  NOE_OUTPUT_BUDGETS,
  buildNoeReviewBrainPreflight,
  isNoeHighRiskTask,
  listNoeBrainRoles,
  normalizeNoeAutoModel,
  resolveNoeBrainByModel,
  resolveNoeBrainForTask,
  resolveNoeModelLoadPlan,
  resolveNoeOutputBudget,
} from './NoeLocalModelPolicy.js';
