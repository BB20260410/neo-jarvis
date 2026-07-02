function cleanId(value, fallback = 'default') {
  const s = String(value || '').trim().toLowerCase();
  return /^[a-z][a-z0-9_-]{0,63}$/.test(s) ? s : fallback;
}

export function memoryPolicyForProfile(profile = {}) {
  const id = cleanId(profile.id);
  const mode = ['companion', 'assistant', 'general'].includes(profile.mode) ? profile.mode : 'general';
  const base = {
    id,
    mode,
    tags: ['voice', 'dialogue', `profile:${id}`, `mode:${mode}`],
    factTags: ['fact', 'voice', `profile:${id}`, `mode:${mode}`],
    recallLimit: 3,
    injectLimit: 2,
    writeDialogue: true,
    dialogueConfidence: 0.75,
    extractFacts: true,
    factConfidence: 0.65,
  };
  if (mode === 'companion') {
    return { ...base, recallLimit: 6, injectLimit: 4, dialogueConfidence: 0.9, factConfidence: 0.75 };
  }
  if (mode === 'assistant') {
    return { ...base, recallLimit: 2, injectLimit: 2, writeDialogue: false, extractFacts: false };
  }
  return base;
}

export function rankProfileMemories(items = [], policy = memoryPolicyForProfile()) {
  const profileTag = `profile:${policy.id}`;
  const modeTag = `mode:${policy.mode}`;
  return items.map((item, index) => {
    const tags = Array.isArray(item?.tags) ? item.tags : [];
    let score = 0;
    if (tags.includes(profileTag)) score += 2;
    if (tags.includes(modeTag)) score += 1;
    return { item, index, score };
  }).sort((a, b) => (b.score - a.score) || (a.index - b.index)).map((row) => row.item);
}
