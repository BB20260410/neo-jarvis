import { describe, it, expect } from 'vitest';
import { extractClaudeEvidenceRead } from '../../src/room/NoeClaudeEvidenceParser.js';

describe('extractClaudeEvidenceRead', () => {
  describe('input handling', () => {
    it('returns empty array for empty string', () => {
      expect(extractClaudeEvidenceRead('')).toEqual([]);
    });

    it('returns empty array for null', () => {
      expect(extractClaudeEvidenceRead(null)).toEqual([]);
    });

    it('returns empty array for undefined', () => {
      expect(extractClaudeEvidenceRead(undefined)).toEqual([]);
    });

    it('returns empty array when no evidence_read section exists', () => {
      expect(extractClaudeEvidenceRead('Some text\nwithout evidence section')).toEqual([]);
    });
  });

  describe('evidence_read header detection', () => {
    it('parses plain evidence_read: header', () => {
      const text = 'evidence_read:\n- src/a.js (direct-read)\n- src/b.js (truncated)';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(2);
      expect(result[0].ref).toBe('src/a.js');
      expect(result[0].mode).toBe('direct-read');
      expect(result[1].ref).toBe('src/b.js');
      expect(result[1].mode).toBe('truncated');
    });

    it('parses markdown ## header form', () => {
      const text = '## evidence_read:\n- a.js (direct-read)';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('a.js');
      expect(result[0].mode).toBe('direct-read');
    });

    it('parses numbered header form', () => {
      const text = '1. evidence_read:\n- a.js (direct-read)';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('a.js');
    });

    it('accepts Chinese colon separator', () => {
      const text = 'evidence_read：\n- a.js (direct-read)';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].mode).toBe('direct-read');
    });
  });

  describe('table format', () => {
    it('parses pipe-delimited row', () => {
      const text = 'evidence_read:\n| src/a.js | direct-read |';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('src/a.js');
      expect(result[0].mode).toBe('direct-read');
    });

    it('skips separator row', () => {
      const text = 'evidence_read:\n| ref | mode |\n| --- | --- |\n| a.js | direct-read |';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('a.js');
    });

    it('skips header row', () => {
      const text = 'evidence_read:\n| ref | mode |\n| a.js | direct-read |';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('a.js');
    });

    it('parses three valid modes', () => {
      const text = 'evidence_read:\n| a | direct-read |\n| b | truncated |\n| c | summary-only |';
      const result = extractClaudeEvidenceRead(text);
      expect(result.map((r) => r.mode)).toEqual(['direct-read', 'truncated', 'summary-only']);
    });

    it('strips markdown formatting in cells', () => {
      const text = 'evidence_read:\n| `src/a.js` | **direct-read** |';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('src/a.js');
      expect(result[0].mode).toBe('direct-read');
    });

    it('skips row with unrecognized mode', () => {
      const text = 'evidence_read:\n| a.js | unknown-mode |';
      expect(extractClaudeEvidenceRead(text)).toEqual([]);
    });
  });

  describe('text format', () => {
    it('parses bullet list with parentheses', () => {
      const text = 'evidence_read:\n- src/foo.js (direct-read)';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('src/foo.js');
      expect(result[0].mode).toBe('direct-read');
    });

    it('parses numbered list without parentheses', () => {
      const text = 'evidence_read:\n1. src/foo.js direct-read';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('src/foo.js');
      expect(result[0].mode).toBe('direct-read');
    });

    it('parses pipe separator without parentheses', () => {
      const text = 'evidence_read:\nsrc/a.js | direct-read';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('src/a.js');
    });

    it('skips lines without a recognized mode', () => {
      const text = 'evidence_read:\n- just a path';
      expect(extractClaudeEvidenceRead(text)).toEqual([]);
    });

    it('skips ref header pseudo line', () => {
      const text = 'evidence_read:\nref | mode\n- a.js (direct-read)';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('a.js');
    });
  });

  describe('section termination', () => {
    it('stops at horizontal rule after content', () => {
      const text = 'evidence_read:\n- a.js (direct-read)\n---\nb.js (truncated)';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('a.js');
    });

    it('stops at next markdown header after content', () => {
      const text = 'evidence_read:\n- a.js (direct-read)\n## Risks\n- b.js (truncated)';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('a.js');
    });

    it('stops at challenge_log header', () => {
      const text = 'evidence_read:\n- a.js (direct-read)\nchallenge_log: notes';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('a.js');
    });

    it('stops at memory_update header', () => {
      const text = 'evidence_read:\n- a.js (direct-read)\nmemory_update: x';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('a.js');
    });

    it('stops at 给 Codex header (mixed-language)', () => {
      const text = 'evidence_read:\n- a.js (direct-read)\n给 Codex：note';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(1);
      expect(result[0].ref).toBe('a.js');
    });
  });

  describe('mode normalization', () => {
    it('lowercases mode names', () => {
      const text = 'evidence_read:\n- a.js (DIRECT-READ)';
      const result = extractClaudeEvidenceRead(text);
      expect(result[0].mode).toBe('direct-read');
    });

    it('matches mixed case modes', () => {
      const text = 'evidence_read:\n- a (Direct-Read)\n- b (Truncated)\n- c (Summary-Only)';
      const result = extractClaudeEvidenceRead(text);
      expect(result.map((r) => r.mode)).toEqual(['direct-read', 'truncated', 'summary-only']);
    });
  });

  describe('markdown cleaning', () => {
    it('strips bold markers around ref', () => {
      const text = 'evidence_read:\n- **src/a.js** (direct-read)';
      const result = extractClaudeEvidenceRead(text);
      expect(result[0].ref).toBe('src/a.js');
    });

    it('replaces br tags with spaces', () => {
      const text = 'evidence_read:\n- src/a.js<br/>(direct-read)';
      const result = extractClaudeEvidenceRead(text);
      expect(result[0].ref).toBe('src/a.js');
    });

    it('handles CRLF line endings', () => {
      const text = 'evidence_read:\r\n- src/a.js (direct-read)\r\n- src/b.js (truncated)';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(2);
      expect(result[0].ref).toBe('src/a.js');
      expect(result[1].ref).toBe('src/b.js');
    });
  });

  describe('mixed input', () => {
    it('parses table and text lines together', () => {
      const text = 'evidence_read:\n| a.js | direct-read |\n- b.js (truncated)';
      const result = extractClaudeEvidenceRead(text);
      expect(result).toHaveLength(2);
      expect(result[0].ref).toBe('a.js');
      expect(result[0].mode).toBe('direct-read');
      expect(result[1].ref).toBe('b.js');
      expect(result[1].mode).toBe('truncated');
    });

    it('preserves input order across numbered entries', () => {
      const text = 'evidence_read:\n1. a.js (direct-read)\n2. b.js (truncated)\n3. c.js (summary-only)';
      const result = extractClaudeEvidenceRead(text);
      expect(result.map((r) => r.ref)).toEqual(['a.js', 'b.js', 'c.js']);
      expect(result.map((r) => r.mode)).toEqual(['direct-read', 'truncated', 'summary-only']);
    });
  });
});
