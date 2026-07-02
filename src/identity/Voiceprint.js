function readAscii(buf, start, len) {
  return Buffer.from(buf.subarray(start, start + len)).toString('ascii');
}

export function parsePcm16Wav(input) {
  const buf = Buffer.from(input || []);
  if (buf.length < 44 || readAscii(buf, 0, 4) !== 'RIFF' || readAscii(buf, 8, 4) !== 'WAVE') throw new Error('voice sample must be wav');
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = readAscii(buf, pos, 4);
    const size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (id === 'fmt ') fmt = { start, size };
    if (id === 'data') data = { start, size };
    pos = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('wav missing fmt/data');
  const audioFormat = buf.readUInt16LE(fmt.start);
  const channels = buf.readUInt16LE(fmt.start + 2);
  const sampleRate = buf.readUInt32LE(fmt.start + 4);
  const bits = buf.readUInt16LE(fmt.start + 14);
  if (audioFormat !== 1 || bits !== 16 || channels < 1) throw new Error('only pcm16 wav supported');
  const frames = Math.floor(data.size / (channels * 2));
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let ch = 0; ch < channels; ch++) sum += buf.readInt16LE(data.start + (i * channels + ch) * 2) / 32768;
    samples[i] = sum / channels;
  }
  return { sampleRate, samples };
}

function stats(rows) {
  if (!rows.length) return [0, 0];
  const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
  const variance = rows.reduce((a, b) => a + (b - mean) ** 2, 0) / rows.length;
  return [mean, Math.sqrt(variance)];
}

function pitchFeature(frame, sampleRate) {
  const minLag = Math.max(16, Math.floor(sampleRate / 360));
  const maxLag = Math.min(frame.length - 1, Math.floor(sampleRate / 80));
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag += 2) {
    let sum = 0;
    for (let i = 0; i < frame.length - lag; i++) sum += frame[i] * frame[i + lag];
    if (sum > best) { best = sum; bestLag = lag; }
  }
  return bestLag ? sampleRate / bestLag : 0;
}

function bandEnergy(frame, sampleRate, freq) {
  const w = 2 * Math.PI * freq / sampleRate;
  let re = 0;
  let im = 0;
  for (let i = 0; i < frame.length; i += 2) {
    re += frame[i] * Math.cos(w * i);
    im -= frame[i] * Math.sin(w * i);
  }
  return Math.log1p(Math.sqrt(re * re + im * im) / frame.length);
}

export function normalizeVector(vec) {
  const norm = Math.sqrt(vec.reduce((a, b) => a + b * b, 0)) || 1;
  return vec.map((v) => Math.round((v / norm) * 1e6) / 1e6);
}

export function centroid(vectors = []) {
  const rows = vectors.filter((v) => Array.isArray(v) && v.length);
  if (!rows.length) return [];
  const len = Math.min(...rows.map((v) => v.length));
  const out = Array.from({ length: len }, (_, i) => rows.reduce((sum, v) => sum + Number(v[i] || 0), 0) / rows.length);
  return normalizeVector(out);
}

export function cosine(a = [], b = []) {
  const n = Math.min(a.length, b.length);
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function cleanVoiceVectors(samples = []) {
  return samples.map((row) => Array.isArray(row) ? row : row?.embedding)
    .filter((v) => Array.isArray(v) && v.length);
}

export function scoreVoiceEmbedding(embedding = [], samples = []) {
  const vectors = cleanVoiceVectors(samples);
  const scores = vectors.map((v) => cosine(embedding, v)).filter(Number.isFinite).sort((a, b) => b - a);
  if (!scores.length) return { score: 0, bestScore: 0, topScore: 0, centroidScore: 0, sampleCount: 0 };
  const top = scores.slice(0, Math.min(3, scores.length));
  const topScore = top.reduce((a, b) => a + b, 0) / top.length;
  const centroidScore = cosine(embedding, centroid(vectors));
  return {
    score: Math.max(scores[0], topScore, centroidScore),
    bestScore: scores[0],
    topScore,
    centroidScore,
    sampleCount: scores.length,
  };
}

export function computeVoiceEmbedding(wavBuffer) {
  const { sampleRate, samples } = parsePcm16Wav(wavBuffer);
  const frameSize = Math.max(320, Math.floor(sampleRate * 0.04));
  const hop = Math.max(160, Math.floor(sampleRate * 0.02));
  /** @type {number[]} */
  const rms = [];
  /** @type {number[]} */
  const zcr = [];
  /** @type {number[]} */
  const pitch = [];
  /** @type {number[][]} */
  const bands = [120, 180, 260, 380, 560, 820, 1200, 1800, 2600, 3600].map(() => []);
  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    const frame = samples.subarray(start, start + frameSize);
    let energy = 0; let zero = 0;
    for (let i = 0; i < frame.length; i++) {
      energy += frame[i] * frame[i];
      if (i > 0 && Math.sign(frame[i]) !== Math.sign(frame[i - 1])) zero++;
    }
    const r = Math.sqrt(energy / frame.length);
    if (r < 0.006) continue;
    rms.push(r);
    zcr.push(zero / frame.length);
    pitch.push(pitchFeature(frame, sampleRate) / 400);
    bands.forEach((row, idx) => row.push(bandEnergy(frame, sampleRate, [120, 180, 260, 380, 560, 820, 1200, 1800, 2600, 3600][idx])));
  }
  if (rms.length < 4) throw new Error('voice sample too short or silent');
  return normalizeVector([...stats(rms), ...stats(zcr), ...stats(pitch), ...bands.flatMap(stats)]);
}
