export const DEFAULT_WAKE_WORDS = Object.freeze(['noe', 'neo', '诺伊', '诺依', '宝贝', '贾维斯']);

function splitList(value) {
  return String(value || '').split(/[,\n，、]/).map((s) => s.trim()).filter(Boolean);
}

function norm(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function hitSttNoeAlias(text, wakeWords) {
  if (!wakeWords.includes('noe') && !wakeWords.includes('neo')) return false;
  return /(^|[^a-z0-9])n\s*o\s*e?([^a-z0-9]|$)/i.test(String(text || ''));
}

export class OwnerGate {
  constructor({ enabled = false, wakeWords = DEFAULT_WAKE_WORDS, passphrases = [] } = {}) {
    this.enabled = enabled === true;
    this.wakeWords = (wakeWords.length ? wakeWords : DEFAULT_WAKE_WORDS).map(norm).filter(Boolean);
    this.passphrases = passphrases.map(norm).filter(Boolean);
  }

  status() {
    return { enabled: this.enabled, wakeWords: this.wakeWords.length, passphrases: this.passphrases.length };
  }

  check(text, { ownerVerified = false } = {}) {
    if (!this.enabled || ownerVerified === true) return { ok: true };
    const s = norm(text);
    const hitPass = this.passphrases.length > 0 && this.passphrases.some((p) => s.includes(p));
    const hitWake = this.wakeWords.some((w) => s.includes(w)) || hitSttNoeAlias(text, this.wakeWords);
    if (hitPass || (this.passphrases.length === 0 && hitWake)) return { ok: true };
    return { ok: false, ignored: true, error: '已忽略：未命中主人唤醒词或口令。' };
  }
}

export function createOwnerGateFromEnv(env = process.env) {
  const passphrases = splitList(env.NOE_OWNER_PASSPHRASES || env.NOE_OWNER_PASSPHRASE || '');
  const wakeWords = splitList(env.NOE_OWNER_WAKE_WORDS || '');
  return new OwnerGate({
    enabled: env.NOE_OWNER_GATE === '1' || passphrases.length > 0,
    wakeWords: wakeWords.length ? wakeWords : DEFAULT_WAKE_WORDS,
    passphrases,
  });
}
