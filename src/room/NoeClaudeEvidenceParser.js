// @ts-check

import { redactSensitiveText } from '../runtime/NoeContextScrubber.js';

function cleanText(value, max = 4000) {
  return redactSensitiveText(String(value ?? '').replace(/\r\n/g, '\n')).slice(0, max);
}

function stripMarkdown(value) {
  return cleanText(value, 1000)
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .trim();
}

function normalizeMode(value) {
  const match = String(value || '').match(/\b(direct-read|truncated|summary-only)\b/i);
  return match ? match[1].toLowerCase() : '';
}

function evidenceHeader(line) {
  return /^\s*(?:#{1,6}\s*)?(?:\d+[.)]\s*)?evidence_read\s*[:：]?\s*$/i.test(line)
    || /^\s*(?:#{1,6}\s*)?(?:\d+[.)]\s*)?evidence_read\s*[:：]/i.test(line);
}

function nextSection(line, sawContent) {
  if (!sawContent) return false;
  const text = line.trim();
  if (!text) return false;
  if (/^-{3,}$/.test(text)) return true;
  if (/^#{1,6}\s*(?:\d+[.)]\s*)?(?!evidence_read\b).+/i.test(text)) return true;
  return /^(?:\d+[.)]\s*)?(?:风险|硬边界|给\s*Codex|challenge_log|memory_update)\b[:：]?/i.test(text);
}

function evidenceBlock(text) {
  const lines = cleanText(text, 80_000).split('\n');
  const start = lines.findIndex(evidenceHeader);
  if (start < 0) return '';
  const out = [];
  let sawContent = false;
  for (const line of lines.slice(start + 1)) {
    if (nextSection(line, sawContent)) break;
    if (line.trim()) sawContent = true;
    out.push(line);
  }
  return out.join('\n');
}

function parseTableLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const cells = trimmed.slice(1, -1).split('|').map(stripMarkdown);
  if (cells.length < 2) return null;
  if (/^-+$/.test(cells.join('').replace(/\s/g, ''))) return null;
  if (/^ref$/i.test(cells[0]) && /^mode$/i.test(cells[1])) return null;
  const mode = normalizeMode(cells[1]);
  const ref = cells[0].trim();
  if (!ref || !mode) return null;
  return { ref: cleanText(ref, 600), mode, raw: stripMarkdown(line) };
}

function parseTextLine(line) {
  const cleaned = stripMarkdown(line.replace(/^[-*\d.\s]+/, ''));
  if (!cleaned || /^\|?\s*-{2,}/.test(cleaned) || /^ref\s*\|/i.test(cleaned)) return null;
  const mode = normalizeMode(cleaned);
  if (!mode) return null;
  const modeIndex = cleaned.toLowerCase().indexOf(mode);
  const beforeMode = cleaned.slice(0, modeIndex);
  const ref = beforeMode
    .replace(/[|/]\s*$/g, '')
    .replace(/[\s([（:：-]+$/g, '')
    .trim();
  if (!ref) return null;
  return { ref: cleanText(ref, 600), mode, raw: cleaned };
}

export function extractClaudeEvidenceRead(resultText) {
  const block = evidenceBlock(resultText);
  return block.split('\n')
    .map((line) => parseTableLine(line) || parseTextLine(line))
    .filter(Boolean);
}
